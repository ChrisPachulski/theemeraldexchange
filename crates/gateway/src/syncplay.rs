//! SyncPlay: watch-together groups pinned to one library item with one
//! shared transport (paused, position, as-of). Members poll the snapshot
//! (the poll is the liveness heartbeat) and any member may play/pause/seek;
//! every change bumps `version` so pollers diff cheaply.
//!
//! ponytail: in-memory, single process; groups die with the box (fine for a
//! living-room feature). Move to server.db if they ever need to survive a
//! restart.

use std::sync::Mutex;
#[cfg(test)]
use std::sync::atomic::{AtomicI64, Ordering};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::AppState;
use crate::routes::{err, ok};
use crate::stores::positive_int;

/// A member silent this long (tab closed, app killed) is gone; clients poll
/// every few seconds.
const MEMBER_IDLE_MS: i64 = 60_000;
const BODY_LIMIT: usize = 4 * 1024;

struct Member {
    username: String,
    last_seen_ms: i64,
}

struct Group {
    id: String,
    host_sub: String,
    media_kind: &'static str,
    media_id: u64,
    paused: bool,
    /// The playhead when `at_ms` was stamped.
    position_secs: f64,
    at_ms: i64,
    version: u64,
    /// By sub, in join order.
    members: IndexMap<String, Member>,
}

impl Group {
    /// Frozen while paused, wall-clock-advanced while playing.
    fn position(&self, now_ms: i64) -> f64 {
        if self.paused {
            self.position_secs
        } else {
            (self.position_secs + (now_ms - self.at_ms) as f64 / 1000.0).max(0.0)
        }
    }

    fn rehost(&mut self) {
        if let Some(first) = self.members.keys().next() {
            self.host_sub = first.clone();
        }
    }

    fn snapshot(&self, now_ms: i64, with_count: bool) -> Snapshot<'_> {
        Snapshot {
            id: &self.id,
            host_sub: &self.host_sub,
            media_kind: self.media_kind,
            media_id: self.media_id,
            paused: self.paused,
            position_secs: js_round3(self.position(now_ms)),
            version: self.version,
            members: self
                .members
                .iter()
                .map(|(sub, m)| MemberView {
                    sub,
                    username: &m.username,
                })
                .collect(),
            member_count: with_count.then_some(self.members.len()),
        }
    }
}

/// `Math.round(x * 1000) / 1000` as a JS number (30, not 30.0).
fn js_round3(x: f64) -> serde_json::Number {
    let r = (x * 1000.0).round() / 1000.0;
    if r.fract() == 0.0 && r.abs() < 9_007_199_254_740_992.0 {
        (r as i64).into()
    } else {
        serde_json::Number::from_f64(r).unwrap_or_else(|| 0.into())
    }
}

#[derive(Serialize)]
struct MemberView<'a> {
    sub: &'a str,
    username: &'a str,
}

#[derive(Serialize)]
struct Snapshot<'a> {
    id: &'a str,
    host_sub: &'a str,
    media_kind: &'static str,
    media_id: u64,
    paused: bool,
    position_secs: serde_json::Number,
    version: u64,
    members: Vec<MemberView<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    member_count: Option<usize>,
}

#[derive(Default)]
pub struct Syncplay {
    groups: Mutex<IndexMap<String, Group>>,
    /// Test clock (ms); 0, the default, reads the wall clock.
    #[cfg(test)]
    pub(crate) fake_now: AtomicI64,
}

impl Syncplay {
    fn now_ms(&self) -> i64 {
        #[cfg(test)]
        {
            let fake = self.fake_now.load(Ordering::SeqCst);
            if fake != 0 {
                return fake;
            }
        }
        chrono::Utc::now().timestamp_millis()
    }

    /// Lock, prune idle members, and hand the groups to `f` with the clock.
    fn with<R>(&self, f: impl FnOnce(&mut IndexMap<String, Group>, i64) -> R) -> R {
        let now = self.now_ms();
        let mut groups = self.groups.lock().unwrap();
        prune_idle(&mut groups, now);
        f(&mut groups, now)
    }
}

/// Drop idle members (handing hosting over exactly as a leave does, and
/// bumping `version` so pollers notice), then groups left empty.
fn prune_idle(groups: &mut IndexMap<String, Group>, now_ms: i64) {
    groups.retain(|_, g| {
        let idle: Vec<String> = g
            .members
            .iter()
            .filter(|(_, m)| now_ms - m.last_seen_ms > MEMBER_IDLE_MS)
            .map(|(sub, _)| sub.clone())
            .collect();
        for sub in &idle {
            g.members.shift_remove(sub);
            if g.host_sub == *sub {
                g.rehost();
            }
        }
        if !idle.is_empty() && !g.members.is_empty() {
            g.version += 1;
        }
        !g.members.is_empty()
    });
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/syncplay/groups", get(list).post(create))
        .route("/api/syncplay/groups/{id}", get(poll))
        .route("/api/syncplay/groups/{id}/join", post(join))
        .route("/api/syncplay/groups/{id}/leave", post(leave))
        .route("/api/syncplay/groups/{id}/command", post(command))
}

fn not_found() -> Response {
    err(StatusCode::NOT_FOUND, "not_found")
}

/// Every member sees every group, its item and full roster: joining is open
/// to any member, so hiding the roster one request ahead of it would only
/// pretend to a confidentiality the router cannot keep.
async fn list(State(st): State<AppState>, _auth: auth::RequireAuth) -> Response {
    #[derive(Serialize)]
    struct Items<'a> {
        items: Vec<Snapshot<'a>>,
    }
    st.syncplay.with(|groups, now| {
        let items = groups.values().map(|g| g.snapshot(now, true)).collect();
        Json(Items { items }).into_response()
    })
}

async fn create(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    body: Body,
) -> Response {
    let body = match auth::json_body(body, BODY_LIMIT).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let media_kind = match body.get("media_kind").and_then(Value::as_str) {
        Some("movie") => "movie",
        Some("episode") => "episode",
        _ => return err(StatusCode::BAD_REQUEST, "invalid_media_kind"),
    };
    let Some(media_id) = body.get("media_id").and_then(positive_int) else {
        return err(StatusCode::BAD_REQUEST, "invalid_media_id");
    };
    let s = &p.session;
    st.syncplay.with(|groups, now| {
        let id = uuid::Uuid::new_v4().to_string();
        let members = IndexMap::from([(
            s.sub.clone(),
            Member {
                username: s.username.clone(),
                last_seen_ms: now,
            },
        )]);
        let group = Group {
            id: id.clone(),
            host_sub: s.sub.clone(),
            media_kind,
            media_id,
            paused: true,
            position_secs: 0.0,
            at_ms: now,
            version: 1,
            members,
        };
        let res = Json(group.snapshot(now, false)).into_response();
        groups.insert(id, group);
        res
    })
}

async fn join(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    Path(id): Path<String>,
) -> Response {
    let s = &p.session;
    st.syncplay.with(|groups, now| {
        let Some(g) = groups.get_mut(&id) else {
            return not_found();
        };
        g.members.insert(
            s.sub.clone(),
            Member {
                username: s.username.clone(),
                last_seen_ms: now,
            },
        );
        g.version += 1;
        Json(g.snapshot(now, false)).into_response()
    })
}

async fn leave(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    Path(id): Path<String>,
) -> Response {
    let sub = &p.session.sub;
    st.syncplay.with(|groups, _| {
        let Some(g) = groups.get_mut(&id) else {
            return not_found();
        };
        g.members.shift_remove(sub);
        if g.members.is_empty() {
            groups.shift_remove(&id);
        } else {
            if g.host_sub == *sub {
                g.rehost();
            }
            g.version += 1;
        }
        ok()
    })
}

/// The poll: the shared transport state, and the caller marked alive.
async fn poll(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    Path(id): Path<String>,
) -> Response {
    let sub = &p.session.sub;
    st.syncplay.with(|groups, now| {
        let Some(g) = groups.get_mut(&id) else {
            return not_found();
        };
        let Some(m) = g.members.get_mut(sub) else {
            return err(StatusCode::FORBIDDEN, "not_member");
        };
        m.last_seen_ms = now;
        Json(g.snapshot(now, false)).into_response()
    })
}

/// The body is read BEFORE the group is resolved: across that await the
/// group can be left, pruned or deleted, and the clock must be the one at
/// apply time, or the playhead jumps by the read's duration.
async fn command(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    Path(id): Path<String>,
    body: Body,
) -> Response {
    let body = match auth::json_body(body, BODY_LIMIT).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let kind = match body.get("type").and_then(Value::as_str) {
        Some(t @ ("play" | "pause" | "seek")) => t,
        _ => return err(StatusCode::BAD_REQUEST, "invalid_type"),
    };
    // play/pause may carry the commander's playhead; seek must.
    let position = match body.get("position_secs") {
        Some(v) => match v.as_f64() {
            Some(n) if n.is_finite() => Some(n),
            _ => return err(StatusCode::BAD_REQUEST, "invalid_position"),
        },
        None if kind == "seek" => return err(StatusCode::BAD_REQUEST, "invalid_position"),
        None => None,
    };
    let sub = &p.session.sub;
    st.syncplay.with(|groups, now| {
        let Some(g) = groups.get_mut(&id) else {
            return not_found();
        };
        let Some(m) = g.members.get_mut(sub) else {
            return err(StatusCode::FORBIDDEN, "not_member");
        };
        m.last_seen_ms = now;
        g.position_secs = position.unwrap_or_else(|| g.position(now)).max(0.0);
        g.at_ms = now;
        match kind {
            "play" => g.paused = false,
            "pause" => g.paused = true,
            _ => {} // seek keeps the transport state
        }
        g.version += 1;
        Json(g.snapshot(now, false)).into_response()
    })
}

#[cfg(test)]
mod tests;
