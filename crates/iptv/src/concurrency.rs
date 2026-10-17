//! Stream concurrency tracker (iptvConcurrency.ts): one in-memory slot per
//! playing stream, capped household-wide, with a kind cap shared by every
//! live upstream connection (raw live, remux, DVR). Lives in this process
//! only, which is why the provider connection cap is counted here and nowhere
//! else.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::time::Instant;

/// Covers the remux's eighty-second window and buffered fetch gaps.
pub const REMUX_IDLE_MS: u64 = 90_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Live,
    Vod,
    Series,
    Catchup,
    Remux,
}

impl Kind {
    fn is_live(self) -> bool {
        matches!(self, Kind::Live | Kind::Remux)
    }
}

/// The session view the sessions widget and the 429 payload carry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: String,
    pub sub: String,
    pub kind: Kind,
    pub resource_id: String,
    pub title: Option<String>,
    pub ip: Option<String>,
    /// Epoch milliseconds.
    pub started_at: u64,
    pub last_seen: u64,
}

pub struct Acquire {
    pub sub: String,
    pub session_id: String,
    pub kind: Kind,
    pub resource_id: String,
    pub ip: Option<String>,
    pub title: Option<String>,
    /// Upstream budget shared by live/remux/DVR reservations; other kinds
    /// count only themselves. VOD/series never consume live slots.
    pub kind_cap: Option<usize>,
    /// Replace this viewer's live reservations, only once admission succeeds.
    pub replace_live: bool,
}

/// A denial: `iptv_concurrency_limit` with the active sessions.
#[derive(Debug)]
pub struct Limit {
    pub limit: usize,
    pub current: usize,
    pub sessions: Vec<Session>,
}

pub struct Tracker {
    cap: usize,
    idle_ms: u64,
    sessions: Mutex<HashMap<String, Session>>,
    /// Epoch ms at `base`: timestamps are base + monotonic elapsed, so a
    /// paused test clock moves them too.
    base_epoch_ms: u64,
    base: Instant,
}

impl Tracker {
    pub fn new(cap: usize, idle_ms: u64) -> Self {
        Tracker {
            cap,
            idle_ms,
            sessions: Mutex::new(HashMap::new()),
            base_epoch_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
            base: Instant::now(),
        }
    }

    fn now(&self) -> u64 {
        self.base_epoch_ms + self.base.elapsed().as_millis() as u64
    }

    fn sweep_locked(&self, sessions: &mut HashMap<String, Session>, now: u64) {
        sessions.retain(|_, s| {
            let idle = if s.kind == Kind::Remux {
                self.idle_ms.max(REMUX_IDLE_MS)
            } else {
                self.idle_ms
            };
            now.saturating_sub(s.last_seen) <= idle
        });
    }

    fn sorted(sessions: &HashMap<String, Session>) -> Vec<Session> {
        let mut v: Vec<Session> = sessions.values().cloned().collect();
        v.sort_by_key(|s| std::cmp::Reverse(s.started_at));
        v
    }

    fn lock(&self) -> (std::sync::MutexGuard<'_, HashMap<String, Session>>, u64) {
        let now = self.now();
        let mut g = self.sessions.lock().unwrap();
        self.sweep_locked(&mut g, now);
        (g, now)
    }

    pub fn sweep(&self) {
        drop(self.lock());
    }

    /// Live sessions, newest first.
    pub fn list(&self) -> Vec<Session> {
        Self::sorted(&self.lock().0)
    }

    pub fn size(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn try_acquire(&self, a: Acquire) -> Result<(), Limit> {
        let (mut sessions, now) = self.lock();
        if let Some(s) = sessions.get_mut(&a.session_id) {
            s.last_seen = now;
            return Ok(());
        }
        let replaced: Vec<String> = sessions
            .values()
            .filter(|s| {
                s.sub == a.sub
                    && ((s.kind == a.kind && s.resource_id == a.resource_id)
                        || (a.replace_live && a.kind.is_live() && s.kind.is_live()))
            })
            .map(|s| s.session_id.clone())
            .collect();
        let remaining = || {
            sessions
                .values()
                .filter(|s| !replaced.contains(&s.session_id))
        };
        if let Some(cap) = a.kind_cap {
            let count = remaining()
                .filter(|s| {
                    if a.kind.is_live() {
                        s.kind.is_live()
                    } else {
                        s.kind == a.kind
                    }
                })
                .count();
            if count >= cap {
                return Err(Limit {
                    limit: cap,
                    current: count,
                    sessions: Self::sorted(&sessions),
                });
            }
        }
        let count = remaining().count();
        if count >= self.cap {
            return Err(Limit {
                limit: self.cap,
                current: count,
                sessions: Self::sorted(&sessions),
            });
        }
        for id in &replaced {
            sessions.remove(id);
        }
        sessions.insert(
            a.session_id.clone(),
            Session {
                session_id: a.session_id,
                sub: a.sub,
                kind: a.kind,
                resource_id: a.resource_id,
                title: a.title,
                ip: a.ip,
                started_at: now,
                last_seen: now,
            },
        );
        Ok(())
    }

    pub fn heartbeat(&self, session_id: &str) {
        let now = self.now();
        if let Some(s) = self.sessions.lock().unwrap().get_mut(session_id) {
            s.last_seen = now;
        }
    }

    /// The session for (sub, kind, resourceId), the tuple try_acquire dedupes
    /// on. Byte routes know these, not the opaque grant session id.
    pub fn find(&self, sub: &str, kind: Kind, resource_id: &str) -> Option<Session> {
        self.lock()
            .0
            .values()
            .find(|s| s.sub == sub && s.kind == kind && s.resource_id == resource_id)
            .cloned()
    }

    /// Refresh the matching session; true when one was found. Does not sweep
    /// first, like the TS (a byte route can revive a slot just past idle).
    pub fn heartbeat_by_resource(&self, sub: &str, kind: Kind, resource_id: &str) -> bool {
        let now = self.now();
        let mut sessions = self.sessions.lock().unwrap();
        match sessions
            .values_mut()
            .find(|s| s.sub == sub && s.kind == kind && s.resource_id == resource_id)
        {
            Some(s) => {
                s.last_seen = now;
                true
            }
            None => false,
        }
    }

    pub fn release(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }

    pub fn release_by_resource(&self, sub: &str, kind: Kind, resource_id: &str) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        let id = sessions
            .values()
            .find(|s| s.sub == sub && s.kind == kind && s.resource_id == resource_id)
            .map(|s| s.session_id.clone());
        id.is_some_and(|id| sessions.remove(&id).is_some())
    }

    pub fn has(&self, session_id: &str) -> bool {
        self.lock().0.contains_key(session_id)
    }

    /// Live-kind (raw .ts and DVR) sessions: each holds one provider socket.
    pub fn live_count(&self) -> usize {
        self.lock()
            .0
            .values()
            .filter(|s| s.kind == Kind::Live)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::advance;

    fn base(sub: &str, id: &str) -> Acquire {
        Acquire {
            sub: sub.into(),
            session_id: id.into(),
            kind: Kind::Live,
            resource_id: "1".into(),
            ip: None,
            title: None,
            kind_cap: None,
            replace_live: false,
        }
    }
    fn with(a: Acquire, kind: Kind, rid: &str, kind_cap: Option<usize>) -> Acquire {
        Acquire {
            kind,
            resource_id: rid.into(),
            kind_cap,
            ..a
        }
    }
    fn ids(t: &Tracker) -> Vec<String> {
        let mut v: Vec<String> = t.list().into_iter().map(|s| s.session_id).collect();
        v.sort();
        v
    }
    async fn wait(ms: u64) {
        advance(Duration::from_millis(ms)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn grants_up_to_the_cap_then_429s_with_the_sessions() {
        let t = Tracker::new(2, 30_000);
        assert!(t.try_acquire(base("u1", "s1")).is_ok());
        assert!(t.try_acquire(base("u2", "s2")).is_ok());
        let err = t.try_acquire(base("u3", "s3")).unwrap_err();
        let mut got: Vec<_> = err.sessions.iter().map(|s| s.session_id.clone()).collect();
        got.sort();
        assert_eq!(got, ["s1", "s2"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_regrant_of_the_same_resource_replaces_rather_than_double_books() {
        let t = Tracker::new(2, 30_000);
        assert!(t.try_acquire(base("u1", "s1")).is_ok());
        assert!(t.try_acquire(base("u1", "s2")).is_ok());
        assert_eq!(t.size(), 1);
        assert_eq!(ids(&t), ["s2"]);
    }

    #[tokio::test(start_paused = true)]
    async fn different_channels_for_one_user_are_not_deduped() {
        let t = Tracker::new(2, 30_000);
        assert!(t.try_acquire(base("u1", "s1")).is_ok());
        assert!(
            t.try_acquire(with(base("u1", "s2"), Kind::Live, "2", None))
                .is_ok()
        );
        assert_eq!(t.size(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn an_atomic_live_switch_uses_its_own_credit_and_keeps_the_other_viewer() {
        let t = Tracker::new(2, 30_000);
        t.try_acquire(with(base("u1", "old"), Kind::Remux, "10", None))
            .unwrap();
        t.try_acquire(with(base("u2", "other"), Kind::Remux, "11", None))
            .unwrap();
        let next = Acquire {
            replace_live: true,
            ..with(base("u1", "next"), Kind::Remux, "12", Some(2))
        };
        assert!(t.try_acquire(next).is_ok());
        assert_eq!(ids(&t), ["next", "other"]);
    }

    #[tokio::test(start_paused = true)]
    async fn dvr_and_raw_live_consume_the_same_upstream_budget_as_remux() {
        let t = Tracker::new(4, 30_000);
        t.try_acquire(with(base("dvr:1", "recording"), Kind::Live, "10", None))
            .unwrap();
        t.try_acquire(with(base("u1", "viewer"), Kind::Remux, "11", Some(2)))
            .unwrap();
        assert!(
            t.try_acquire(with(base("u2", "surplus"), Kind::Remux, "12", Some(2)))
                .is_err()
        );
        assert_eq!(ids(&t), ["recording", "viewer"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_denied_replacement_keeps_its_old_reservation() {
        let t = Tracker::new(4, 30_000);
        t.try_acquire(with(base("u1", "old"), Kind::Remux, "10", None))
            .unwrap();
        t.try_acquire(with(base("u2", "other"), Kind::Remux, "11", None))
            .unwrap();
        assert!(
            t.try_acquire(with(base("u1", "new"), Kind::Remux, "10", Some(1)))
                .is_err()
        );
        assert_eq!(ids(&t), ["old", "other"]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_kind_cap_429s_the_surplus_remux_while_the_global_cap_has_room() {
        let t = Tracker::new(4, 30_000);
        let remux = |sub: &str, id: &str, rid: &str| with(base(sub, id), Kind::Remux, rid, Some(2));
        assert!(t.try_acquire(remux("u1", "s1", "10")).is_ok());
        assert!(t.try_acquire(remux("u2", "s2", "11")).is_ok());
        let err = t.try_acquire(remux("u3", "s3", "12")).unwrap_err();
        assert_eq!((err.limit, err.current), (2, 2));
        assert_eq!(t.size(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn the_kind_cap_is_scoped_vod_does_not_consume_remux() {
        let t = Tracker::new(4, 30_000);
        assert!(
            t.try_acquire(with(base("u1", "v1"), Kind::Vod, "20", None))
                .is_ok()
        );
        assert!(
            t.try_acquire(with(base("u2", "v2"), Kind::Vod, "21", None))
                .is_ok()
        );
        assert!(
            t.try_acquire(with(base("u3", "r1"), Kind::Remux, "30", Some(2)))
                .is_ok()
        );
        assert!(
            t.try_acquire(with(base("u4", "r2"), Kind::Remux, "31", Some(2)))
                .is_ok()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_remux_regrant_supersedes_instead_of_tripping_the_kind_cap() {
        let t = Tracker::new(4, 30_000);
        let remux = |id: &str| with(base("u1", id), Kind::Remux, "10", Some(1));
        assert!(t.try_acquire(remux("s1")).is_ok());
        assert!(t.try_acquire(remux("s2")).is_ok());
        assert_eq!(t.size(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn releases_on_heartbeat_timeout() {
        let t = Tracker::new(1, 100);
        t.try_acquire(base("u1", "s1")).unwrap();
        assert!(t.try_acquire(base("u2", "s2")).is_err());
        wait(150).await;
        t.sweep();
        assert!(t.try_acquire(base("u2", "s2")).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_remux_reservation_survives_an_eighty_second_fetch_gap() {
        let t = Tracker::new(1, 30_000);
        t.try_acquire(with(base("u1", "watch"), Kind::Remux, "1", None))
            .unwrap();
        wait(80_000).await;
        t.sweep();
        assert_eq!(ids(&t), ["watch"]);
        assert!(
            t.try_acquire(with(base("u2", "other"), Kind::Remux, "1", None))
                .is_err()
        );
        wait(11_000).await;
        t.sweep();
        assert_eq!(t.size(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_resets_the_idle_timer() {
        let t = Tracker::new(1, 100);
        t.try_acquire(base("u1", "s1")).unwrap();
        wait(80).await;
        t.heartbeat("s1");
        wait(80).await;
        t.sweep();
        assert!(t.try_acquire(base("u2", "s2")).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn list_is_newest_first_with_metadata() {
        let t = Tracker::new(5, 30_000);
        t.try_acquire(Acquire {
            title: Some("TNT".into()),
            ..with(base("u1", "s1"), Kind::Live, "100", None)
        })
        .unwrap();
        wait(50).await;
        t.try_acquire(Acquire {
            title: Some("Inception".into()),
            ip: Some("10.0.0.5".into()),
            ..with(base("u2", "s2"), Kind::Vod, "200", None)
        })
        .unwrap();
        let list = t.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].session_id, "s2");
        assert_eq!(list[0].kind, Kind::Vod);
        assert_eq!(list[0].ip.as_deref(), Some("10.0.0.5"));
        assert_eq!(list[0].title.as_deref(), Some("Inception"));
        assert_eq!(list[1].session_id, "s1");
        assert_eq!(list[0].started_at - list[1].started_at, 50);
    }

    #[tokio::test(start_paused = true)]
    async fn release_frees_a_slot_immediately() {
        let t = Tracker::new(1, 30_000);
        t.try_acquire(base("u1", "s1")).unwrap();
        assert!(t.try_acquire(base("u2", "s2")).is_err());
        t.release("s1");
        assert!(t.try_acquire(base("u2", "s2")).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_live_stream_held_past_idle_with_byte_heartbeats_keeps_its_slot() {
        let t = Tracker::new(1, 30_000);
        t.try_acquire(base("u1", "s1")).unwrap();
        for _ in 0..9 {
            wait(10_000).await;
            t.heartbeat("s1");
            t.sweep();
            assert_eq!(t.size(), 1);
        }
        assert!(t.try_acquire(base("u2", "s2")).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_by_resource_refreshes_only_the_matching_session() {
        let t = Tracker::new(1, 100);
        t.try_acquire(base("u1", "s1")).unwrap();
        wait(80).await;
        assert!(t.heartbeat_by_resource("u1", Kind::Live, "1"));
        wait(80).await;
        t.sweep();
        assert_eq!(t.size(), 1);
        assert!(!t.heartbeat_by_resource("u1", Kind::Live, "999"));
        assert!(!t.heartbeat_by_resource("u2", Kind::Live, "1"));
        assert!(!t.heartbeat_by_resource("u1", Kind::Vod, "1"));
    }

    #[tokio::test(start_paused = true)]
    async fn release_by_resource_frees_only_the_matching_slot() {
        let t = Tracker::new(1, 30_000);
        t.try_acquire(base("u1", "s1")).unwrap();
        assert!(t.try_acquire(base("u2", "s2")).is_err());
        assert!(!t.release_by_resource("u1", Kind::Live, "999"));
        assert_eq!(t.size(), 1);
        assert!(t.release_by_resource("u1", Kind::Live, "1"));
        assert_eq!(t.size(), 0);
        assert!(t.try_acquire(base("u2", "s2")).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn resource_keyed_methods_discriminate_on_sub_kind_and_resource() {
        let t = Tracker::new(5, 30_000);
        t.try_acquire(with(base("u1", "s1"), Kind::Live, "1", None))
            .unwrap();
        t.try_acquire(with(base("u1", "s2"), Kind::Vod, "1", None))
            .unwrap();
        assert_eq!(t.size(), 2);
        assert!(t.release_by_resource("u1", Kind::Live, "1"));
        assert_eq!(t.size(), 1);
        assert_eq!(t.list()[0].kind, Kind::Vod);
        assert!(t.heartbeat_by_resource("u1", Kind::Vod, "1"));
    }
}
