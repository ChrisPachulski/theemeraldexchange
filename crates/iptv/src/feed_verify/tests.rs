//! iptvFeedVerify.test.ts carried over. Captures are faked: each returns the
//! fixture frames of the synthetic broadcasts (fingerprint::synth), the clock
//! is fixed and sleep advances it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize};

use tokio_util::sync::CancellationToken;

use super::*;
use crate::catalog::tests::pool;
use crate::feed_checks::tests::{chan, check, ms, prog, sql};
use crate::fingerprint::synth::{blend, plain, slice, still};

/// What a faked upstream capture does.
pub(crate) enum Up {
    /// Exits 0 with these frames.
    Frames(Vec<u8>),
    /// Exits 1 with no frames.
    Fails,
    /// Killed by a signal (a viewer preempted it).
    Killed,
    /// No free upstream slot.
    NoSlot,
}

pub(crate) struct FakeIo {
    pub feeds: HashMap<i64, Vec<u8>>,
    pub session: Vec<u8>,
    /// Overrides `feeds` per stream when set.
    pub upstream: Option<Box<dyn Fn(i64) -> Up + Send + Sync>>,
    pub captured: Mutex<Vec<i64>>,
    pub kills: Mutex<Vec<(i64, CancellationToken)>>,
    pub clock: AtomicI64,
    pub sleeps: AtomicUsize,
}

impl FakeIo {
    pub fn new(now: i64, session: Vec<u8>, feeds: HashMap<i64, Vec<u8>>) -> FakeIo {
        FakeIo {
            feeds,
            session,
            upstream: None,
            captured: Mutex::default(),
            kills: Mutex::default(),
            clock: AtomicI64::new(now),
            sleeps: AtomicUsize::new(0),
        }
    }

    pub fn captured(&self) -> Vec<i64> {
        self.captured.lock().unwrap().clone()
    }

    pub fn killed(&self, id: i64) -> bool {
        self.kills
            .lock()
            .unwrap()
            .iter()
            .any(|(i, k)| *i == id && k.is_cancelled())
    }
}

fn task(c: Capture) -> CaptureTask {
    CaptureTask {
        kill: CancellationToken::new(),
        done: tokio::spawn(async move { c }),
    }
}

fn frames(f: Vec<u8>) -> Capture {
    Capture {
        ok: true,
        killed: false,
        frames: f,
    }
}

impl FeedIo for FakeIo {
    fn capture_upstream(&self, stream_id: i64, _seconds: u32) -> Option<CaptureTask> {
        self.captured.lock().unwrap().push(stream_id);
        let up = match &self.upstream {
            Some(f) => f(stream_id),
            None => Up::Frames(self.feeds.get(&stream_id).cloned().unwrap_or_default()),
        };
        let t = task(match up {
            Up::Frames(f) => frames(f),
            Up::Fails => Capture::default(),
            Up::Killed => Capture {
                ok: false,
                killed: true,
                frames: Vec::new(),
            },
            Up::NoSlot => return None,
        });
        self.kills.lock().unwrap().push((stream_id, t.kill.clone()));
        Some(t)
    }

    fn capture_segments(&self, _files: &[String]) -> CaptureTask {
        task(frames(self.session.clone()))
    }

    fn is_dead(&self, _stream_id: i64) -> bool {
        false
    }

    fn now_ms(&self) -> i64 {
        self.clock.load(Ordering::SeqCst)
    }

    async fn sleep(&self, ms: u64) {
        self.sleeps.fetch_add(1, Ordering::SeqCst);
        self.clock.fetch_add(ms as i64, Ordering::SeqCst);
    }
}

pub(crate) fn always<'a>() -> impl Fn() -> BoxFuture<'a, bool> + Send + Sync {
    || Box::pin(std::future::ready(true))
}

const NOW: &str = "2026-10-10T03:08:00.000Z";
const SUBJECT: i64 = 200163566;

struct H {
    pool: SqlitePool,
    io: FakeIo,
    r: LiveSessionRef,
    _d: (tempfile::TempDir, tempfile::TempDir),
}

fn feeds() -> HashMap<i64, Vec<u8>> {
    HashMap::from([
        (5864, slice(&plain(1), 140)),
        (22597, slice(&plain(1), 150)),
        (22599, slice(&plain(2), 140)),
        (200163569, slice(&plain(3), 140)),
    ])
}

async fn harness(session: Vec<u8>, feeds: HashMap<i64, Vec<u8>>) -> H {
    let (pool, db_dir) = pool().await;
    for (id, num, name, tvg) in [
        (SUBJECT, 154, "US: Showtime", "showtime.us"),
        (5864, 5386, "US Showtime East (S)", "showtime.us"),
        (22597, 7280, "US Showtime (East) (H)", "showtime.us"),
        (22599, 7357, "US Showtime 2 (East) (H)", "showtime2.us"),
        (200163569, 225, "US: Showtime Extreme", "showtimeextreme.us"),
    ] {
        chan(&pool, id, num, name, Some(tvg), None).await;
    }
    for (id, title) in [
        ("showtime.us", "My Cousin Vinny"),
        ("showtime2.us", "Blade Runner 2049"),
        ("showtimeextreme.us", "Heat"),
    ] {
        prog(
            &pool,
            id,
            "2026-01-01T00:00:00Z",
            "2099-01-01T00:00:00Z",
            title,
        )
        .await;
    }
    let session_dir = tempfile::tempdir().unwrap();
    for i in 1..=5 {
        std::fs::write(session_dir.path().join(format!("seg_0000{i}.ts")), "").unwrap();
    }
    let now = ms(NOW);
    let r = LiveSessionRef {
        tuned: SUBJECT,
        dialed: SUBJECT,
        session_id: "sess-1".into(),
        dir: session_dir.path().into(),
        started_at_ms: now - 60_000,
    };
    H {
        pool,
        io: FakeIo::new(now, session, feeds),
        r,
        _d: (db_dir, session_dir),
    }
}

impl H {
    async fn live(&self) -> LiveCheck {
        self.live_ref(&self.r.clone()).await
    }
    async fn live_ref(&self, r: &LiveSessionRef) -> LiveCheck {
        check_live_session(&self.io, &self.pool, r, &|| true)
            .await
            .unwrap()
    }
    async fn standalone(&self, id: i64) -> Outcome {
        check_feed_standalone(&self.io, &self.pool, id, &always())
            .await
            .unwrap()
    }
    async fn verdict(&self, id: i64) -> Option<String> {
        check(&self.pool, id).await.map(|c| c.verdict)
    }
}

fn carries(o: &Outcome) -> (&str, Option<i64>, bool) {
    match o {
        Outcome::Carries {
            epg_id,
            matched_stream_id,
            cached,
            ..
        } => (epg_id, *matched_stream_id, *cached),
        other => panic!("expected carries, got {other:?}"),
    }
}

fn reason(o: &Outcome) -> &str {
    match o {
        Outcome::Unknown { reason, .. } | Outcome::Aborted { reason } => reason,
        other => panic!("expected no verdict, got {other:?}"),
    }
}

#[tokio::test]
async fn catches_a_stream_carrying_another_channel_and_names_the_stream_to_switch_to() {
    let h = harness(plain(2), feeds()).await;
    let c = h.live().await;
    assert_eq!(carries(&c.outcome), ("showtime2.us", Some(22599), false));
    assert_eq!(c.intended_epg.as_deref(), Some("showtime.us"));
    assert_eq!(c.switch_to, Some(5864));
    // Sibling first (no match), then Showtime 2 (match), and it stops there.
    assert_eq!(h.io.captured(), [5864, 22599]);
    let rec = check(&h.pool, SUBJECT).await.unwrap();
    assert_eq!(
        (
            rec.verdict.as_str(),
            rec.listed_epg_id.as_deref(),
            rec.actual_epg_id.as_deref(),
            rec.matched_stream_id
        ),
        (
            "mislabeled",
            Some("showtime.us"),
            Some("showtime2.us"),
            Some(22599)
        )
    );
}

#[tokio::test]
async fn catches_a_stream_carrying_the_west_feed_and_switches_to_east() {
    let west = plain(4);
    let mut f = feeds();
    f.insert(5866, slice(&west, 140));
    let h = harness(west, f).await;
    chan(
        &h.pool,
        5866,
        5388,
        "US Showtime West (S)",
        Some("showtimewest.us"),
        None,
    )
    .await;
    prog(
        &h.pool,
        "showtimewest.us",
        "2026-01-01T00:00:00Z",
        "2099-01-01T00:00:00Z",
        "V for Vendetta",
    )
    .await;
    let c = h.live().await;
    assert_eq!(carries(&c.outcome), ("showtimewest.us", Some(5866), false));
    assert_eq!(c.switch_to, Some(5864));
    assert_eq!(h.io.captured(), [5864, 5866]);
}

/// 2026-10-25 "US: Showtime Women": the guide listed East, the stream carried
/// West, and no West stream had a listing (the provider files the West name
/// under the East id). The unlisted West stream stands for the West twin.
#[tokio::test]
async fn catches_the_west_feed_when_no_west_stream_has_a_listing() {
    let west = plain(4);
    let mut f = feeds();
    f.insert(22598, slice(&west, 140));
    let h = harness(west, f).await;
    chan(&h.pool, 22598, 7281, "US Showtime (West) (H)", None, None).await;
    prog(
        &h.pool,
        "showtimewest.us",
        "2026-01-01T00:00:00Z",
        "2099-01-01T00:00:00Z",
        "V for Vendetta",
    )
    .await;
    let c = h.live().await;
    assert_eq!(carries(&c.outcome), ("showtimewest.us", Some(22598), false));
    assert_eq!(c.switch_to, Some(5864));
    assert_eq!(h.io.captured(), [5864, 22598]);
    let rec = check(&h.pool, SUBJECT).await.unwrap();
    assert_eq!(
        (rec.verdict.as_str(), rec.actual_epg_id.as_deref()),
        ("mislabeled", Some("showtimewest.us"))
    );
    // The West stream has no listing to confirm.
    assert_eq!(h.verdict(22598).await, None);
}

/// 2026-10-25 at 22:08Z the first-ranked East stream showed the provider's
/// "Channel temporarily unavailable" card. A slate is no evidence either way:
/// skip it, use the next East stream, and switch the viewer to the East
/// stream seen to differ, never to the slate.
#[tokio::test]
async fn skips_slates_and_switches_to_the_east_stream_seen_to_differ() {
    let west = plain(4);
    let mut f = feeds();
    f.insert(5864, still(9));
    f.insert(400124927, still(9));
    f.insert(22598, slice(&west, 140));
    let h = harness(west, f).await;
    chan(&h.pool, 400124927, 1490, "US: SHOWTIME WEST", None, None).await;
    chan(&h.pool, 22598, 7281, "US Showtime (West) (H)", None, None).await;
    prog(
        &h.pool,
        "showtimewest.us",
        "2026-01-01T00:00:00Z",
        "2099-01-01T00:00:00Z",
        "V for Vendetta",
    )
    .await;
    let c = h.live().await;
    assert_eq!(carries(&c.outcome), ("showtimewest.us", Some(22598), false));
    assert_eq!(c.switch_to, Some(22597));
    assert_eq!(h.io.captured(), [5864, 22597, 400124927, 22598]);
}

/// Two slates of one template line up perfectly; that is no match.
#[tokio::test]
async fn never_matches_a_slate_against_a_slate() {
    let mut f = feeds();
    f.insert(5864, still(9));
    let h = harness(still(9), f).await;
    let c = h.live().await;
    assert_eq!(reason(&c.outcome), "subject shows a still picture");
    assert_eq!(c.switch_to, None);
    assert_eq!(h.verdict(SUBJECT).await.as_deref(), Some("inconclusive"));
}

/// A day-old match is checked again on tune: the provider may have re-pointed
/// the stream since.
#[tokio::test]
async fn re_checks_on_tune_once_a_match_is_a_day_old() {
    let h = harness(plain(2), feeds()).await;
    let old = FeedCheck::new(
        SUBJECT,
        "match",
        Some("showtime.us"),
        None,
        Some(5864),
        Some(0.98),
    );
    record_feed_check(&h.pool, &old, h.io.now_ms() - 23 * 3_600_000)
        .await
        .unwrap();
    assert_eq!(
        carries(&h.live().await.outcome),
        ("showtime.us", Some(5864), true)
    );
    assert_eq!(h.io.captured(), Vec::<i64>::new());

    record_feed_check(&h.pool, &old, h.io.now_ms() - 25 * 3_600_000)
        .await
        .unwrap();
    let c = h.live().await;
    assert_eq!(carries(&c.outcome), ("showtime2.us", Some(22599), false));
    assert_eq!(c.switch_to, Some(5864));
}

#[tokio::test]
async fn confirms_a_healthy_stream_with_one_comparison_and_no_switch() {
    let h = harness(plain(1), feeds()).await;
    let c = h.live().await;
    assert_eq!(carries(&c.outcome).0, "showtime.us");
    assert_eq!(c.switch_to, None);
    assert_eq!(h.io.captured(), [5864]);
    assert_eq!(h.verdict(SUBJECT).await.as_deref(), Some("match"));
}

#[tokio::test]
async fn stops_at_an_ambiguous_picture_instead_of_guessing() {
    let h = harness(blend(&plain(1), &plain(2)), feeds()).await;
    let c = h.live().await;
    assert!(matches!(c.outcome, Outcome::Unknown { .. }));
    assert_eq!(c.switch_to, None);
    assert_eq!(h.io.captured(), [5864]);
    assert_eq!(h.verdict(SUBJECT).await.as_deref(), Some("inconclusive"));
}

#[tokio::test]
async fn does_not_call_a_stream_mislabeled_when_the_related_channel_lists_the_same_programme() {
    let h = harness(plain(2), feeds()).await;
    // A live event both channels carry at once: a picture match proves nothing.
    sql(&h.pool, "UPDATE epg_programs SET title = 'Boxing Live' WHERE channel_id IN ('showtime.us', 'showtime2.us')").await;
    let c = h.live().await;
    assert_eq!(h.io.captured(), [5864, 22599]);
    assert!(reason(&c.outcome).contains("simulcast"));
    assert_eq!(c.switch_to, None);
    assert_eq!(h.verdict(SUBJECT).await.as_deref(), Some("inconclusive"));
}

#[tokio::test]
async fn does_not_call_a_stream_mislabeled_on_a_related_channel_match_alone() {
    let h = harness(plain(2), feeds()).await;
    // No other Showtime stream left: Showtime 2 matching could mean either
    // stream is the mislabeled one.
    sql(
        &h.pool,
        "DELETE FROM channels WHERE stream_id IN (5864, 22597)",
    )
    .await;
    let c = h.live().await;
    assert!(matches!(c.outcome, Outcome::Unknown { .. }));
    assert_eq!(c.switch_to, None);
    // Nothing could settle it, so no connection is opened at all.
    assert_eq!(h.io.captured(), Vec::<i64>::new());
    assert_eq!(h.verdict(SUBJECT).await.as_deref(), Some("inconclusive"));
}

#[tokio::test]
async fn confirms_the_matched_stream_too_so_it_needs_no_check_of_its_own() {
    let h = harness(plain(1), feeds()).await;
    h.live().await;
    let rec = check(&h.pool, 5864).await.unwrap();
    assert_eq!(
        (
            rec.verdict.as_str(),
            rec.listed_epg_id.as_deref(),
            rec.matched_stream_id
        ),
        ("match", Some("showtime.us"), Some(SUBJECT))
    );
}

#[tokio::test]
async fn does_not_confirm_a_matched_stream_whose_listing_came_from_name_matching() {
    let h = harness(plain(1), feeds()).await;
    // Like 600001276 "USA  LIFETIME MOVIES": no provider tag, listed by name.
    sql(&h.pool, "UPDATE channels SET epg_channel_id = NULL, epg_resolved_id = 'showtime.us' WHERE stream_id = 5864").await;
    let c = h.live().await;
    assert_eq!(carries(&c.outcome), ("showtime.us", Some(5864), false));
    assert_eq!(check(&h.pool, 5864).await, None);
}

#[tokio::test]
async fn records_nothing_about_a_failover_stream_filed_under_another_id() {
    let travel = plain(5);
    let h = harness(
        travel.clone(),
        HashMap::from([(22720, slice(&travel, 140))]),
    )
    .await;
    // 21099 was a dead feed; its name sibling 200163514 (travel.us) was dialed.
    chan(
        &h.pool,
        21099,
        8272,
        "US Travel Channel (East) (F)",
        Some("travelchannel.us"),
        Some("travelchannel.us"),
    )
    .await;
    chan(
        &h.pool,
        22720,
        7286,
        "US Travel Channel (East) (H)",
        Some("travelchannel.us"),
        Some("travelchannel.us"),
    )
    .await;
    chan(
        &h.pool,
        200163514,
        191,
        "US: Travel Channel",
        Some("travel.us"),
        Some("travel.us"),
    )
    .await;
    let r = LiveSessionRef {
        tuned: 21099,
        dialed: 200163514,
        ..h.r.clone()
    };
    let c = h.live_ref(&r).await;
    // The viewer got the channel they picked...
    assert_eq!(h.io.captured(), [22720]);
    assert_eq!(carries(&c.outcome).0, "travelchannel.us");
    assert_eq!(c.switch_to, None);
    // ...which says nothing about travel.us: no 'mislabeled' on 200163514.
    assert_eq!(check(&h.pool, 200163514).await, None);
    assert_eq!(check(&h.pool, 22720).await, None);
}

#[tokio::test]
async fn re_checks_when_the_fresh_verdict_was_for_a_listing_the_stream_no_longer_has() {
    let h = harness(plain(1), feeds()).await;
    let c = FeedCheck::new(
        SUBJECT,
        "match",
        Some("showtimeshowcase.us"),
        None,
        Some(5864),
        Some(0.97),
    );
    record_feed_check(&h.pool, &c, h.io.now_ms()).await.unwrap();
    let c = h.live().await;
    assert_eq!(h.io.captured(), [5864]);
    assert_eq!(carries(&c.outcome), ("showtime.us", Some(5864), false));
    assert_eq!(
        check(&h.pool, SUBJECT)
            .await
            .unwrap()
            .listed_epg_id
            .as_deref(),
        Some("showtime.us")
    );
}

#[tokio::test]
async fn moves_past_a_candidate_whose_own_capture_fails() {
    let mut h = harness(plain(2), feeds()).await;
    let f = feeds();
    h.io.upstream = Some(Box::new(move |id| {
        if id == 5864 {
            Up::Fails
        } else {
            Up::Frames(f.get(&id).cloned().unwrap_or_default())
        }
    }));
    let c = h.live().await;
    // 5864 failed, so the other Showtime stream goes next (it differs), then
    // Showtime 2 matches.
    assert_eq!(h.io.captured(), [5864, 22597, 22599]);
    assert_eq!(carries(&c.outcome).0, "showtime2.us");
    assert_eq!(h.verdict(SUBJECT).await.as_deref(), Some("mislabeled"));
}

#[tokio::test]
async fn a_related_channel_match_after_the_only_sibling_failed_settles_nothing() {
    let mut h = harness(plain(2), feeds()).await;
    sql(&h.pool, "DELETE FROM channels WHERE stream_id = 22597").await;
    let f = feeds();
    h.io.upstream = Some(Box::new(move |id| {
        if id == 5864 {
            Up::Fails
        } else {
            Up::Frames(f.get(&id).cloned().unwrap_or_default())
        }
    }));
    let c = h.live().await;
    assert_eq!(h.io.captured(), [5864, 22599]);
    assert_eq!(
        reason(&c.outcome),
        "matches a related channel with no listed stream to compare"
    );
    assert_eq!(c.switch_to, None);
}

#[tokio::test]
async fn records_nothing_when_a_viewer_preempts_the_capture() {
    let mut h = harness(plain(2), feeds()).await;
    h.io.upstream = Some(Box::new(|_| Up::Killed));
    let c = h.live().await;
    assert!(matches!(c.outcome, Outcome::Aborted { .. }));
    assert_eq!(check(&h.pool, SUBJECT).await, None);
}

#[tokio::test]
async fn records_nothing_when_no_upstream_slot_is_free() {
    let mut h = harness(plain(2), feeds()).await;
    h.io.upstream = Some(Box::new(|_| Up::NoSlot));
    let c = h.live().await;
    assert_eq!(c.outcome, aborted("no free upstream slot"));
    assert_eq!(check(&h.pool, SUBJECT).await, None);
}

#[tokio::test]
async fn uses_a_fresh_verdict_without_capturing_anything() {
    let h = harness(plain(2), feeds()).await;
    let c = FeedCheck::new(
        SUBJECT,
        "mislabeled",
        Some("showtime.us"),
        Some("showtime2.us"),
        Some(22599),
        Some(0.97),
    );
    record_feed_check(&h.pool, &c, h.io.now_ms()).await.unwrap();
    let c = h.live().await;
    // The guide now lists Showtime 2 on this stream, so tuning it means Showtime 2.
    assert_eq!(c.intended_epg.as_deref(), Some("showtime2.us"));
    assert_eq!(carries(&c.outcome), ("showtime2.us", Some(22599), true));
    assert_eq!(c.switch_to, None);
    assert_eq!(h.io.captured(), Vec::<i64>::new());
}

#[tokio::test]
async fn waits_out_the_warmup_before_dialing_and_gives_up_when_the_session_ends() {
    let h = harness(plain(1), feeds()).await;
    let fresh = LiveSessionRef {
        started_at_ms: h.io.now_ms(),
        ..h.r.clone()
    };
    let c = check_live_session(&h.io, &h.pool, &fresh, &|| true)
        .await
        .unwrap();
    // Ten one-second waits on the fake clock, then the one comparison.
    assert_eq!(carries(&c.outcome).0, "showtime.us");
    assert!(h.io.sleeps.load(Ordering::SeqCst) >= 10);
    let h = harness(plain(1), feeds()).await;
    let fresh = LiveSessionRef {
        started_at_ms: h.io.now_ms(),
        ..h.r.clone()
    };
    let c = check_live_session(&h.io, &h.pool, &fresh, &|| false)
        .await
        .unwrap();
    assert_eq!(c.outcome, aborted("session ended"));
    assert_eq!(h.io.captured(), Vec::<i64>::new());
}

#[tokio::test]
async fn schedule_switches_the_viewer_once_per_session() {
    let h = harness(plain(2), feeds()).await;
    let io = Arc::new(h.io);
    let sched = Arc::new(Scheduler::default());
    let calls = Arc::new(Mutex::new(Vec::new()));
    for _ in 0..2 {
        let c = calls.clone();
        sched.schedule_live(
            io.clone(),
            h.pool.clone(),
            h.r.clone(),
            Arc::new(|| true),
            move |to| c.lock().unwrap().push(to),
        );
        crate::remux::tests::until("switch", || !calls.lock().unwrap().is_empty()).await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(*calls.lock().unwrap(), [5864]);
}

#[tokio::test]
async fn schedule_does_not_switch_a_viewer_who_already_left() {
    let h = harness(plain(2), feeds()).await;
    let sched = Arc::new(Scheduler::default());
    let active = Arc::new(AtomicBool::new(true));
    let calls = Arc::new(AtomicUsize::new(0));
    let (a, c) = (active.clone(), calls.clone());
    sched.schedule_live(
        Arc::new(h.io),
        h.pool.clone(),
        h.r.clone(),
        Arc::new(move || a.load(Ordering::SeqCst)),
        move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        },
    );
    active.store(false, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!sched.running.load(Ordering::SeqCst));
}

#[tokio::test]
async fn run_exclusive_refuses_while_a_check_runs() {
    let sched = Scheduler::default();
    let inner = sched
        .run_exclusive(async { sched.run_exclusive(async { 1 }).await })
        .await;
    assert_eq!(inner, Some(None));
    assert_eq!(sched.run_exclusive(async { 2 }).await, Some(2));
}

#[tokio::test]
async fn standalone_records_the_subject_inconclusive_when_its_own_capture_fails() {
    let mut h = harness(plain(2), feeds()).await;
    let f = feeds();
    h.io.upstream = Some(Box::new(move |id| {
        if id == SUBJECT {
            Up::Fails
        } else {
            Up::Frames(f.get(&id).cloned().unwrap_or_default())
        }
    }));
    let o = h.standalone(SUBJECT).await;
    assert!(matches!(o, Outcome::Unknown { .. }));
    let rec = check(&h.pool, SUBJECT).await.unwrap();
    assert_eq!(
        (rec.verdict.as_str(), rec.score, rec.reason.as_deref()),
        ("inconclusive", None, Some("subject capture failed"))
    );
}

#[tokio::test]
async fn standalone_calls_a_match_on_an_id_with_the_same_schedule_a_match_not_mislabeled() {
    let travel = plain(5);
    let h = harness(
        travel.clone(),
        HashMap::from([
            (200163514, slice(&travel, 130)),
            (400124999, slice(&plain(3), 140)),
            (22720, slice(&travel, 140)),
        ]),
    )
    .await;
    chan(
        &h.pool,
        200163514,
        191,
        "US: Travel Channel",
        Some("travel.us"),
        Some("travel.us"),
    )
    .await;
    chan(
        &h.pool,
        400124999,
        900,
        "US: TRAVEL CHANNEL",
        Some("travel.us"),
        Some("travel.us"),
    )
    .await;
    chan(
        &h.pool,
        22720,
        7286,
        "US Travel Channel (East) (H)",
        Some("travelchannel.us"),
        Some("travelchannel.us"),
    )
    .await;
    // One schedule under two ids, except the slot airing now was revised on one.
    let hour = h.io.now_ms() / 3_600_000 * 3_600_000;
    for hh in -13i64..=13 {
        for id in ["travel.us", "travelchannel.us"] {
            let title = if hh == 0 && id == "travel.us" {
                "Under Eye Bags? SOLUTION!".to_string()
            } else {
                format!("Ghost Adventures {}", (hh + 13) % 5)
            };
            let (start, stop) = (hour + hh * 3_600_000, hour + (hh + 1) * 3_600_000);
            prog(
                &h.pool,
                id,
                &crate::feed_checks::iso_ms(start),
                &crate::feed_checks::iso_ms(stop),
                &title,
            )
            .await;
        }
    }
    let o = h.standalone(200163514).await;
    // The other travel.us stream differs, then travelchannel.us matches.
    assert_eq!(h.io.captured(), [200163514, 400124999, 200163514, 22720]);
    assert_eq!(carries(&o).0, "travelchannel.us");
    let rec = check(&h.pool, 200163514).await.unwrap();
    assert_eq!(
        (
            rec.verdict.as_str(),
            rec.listed_epg_id.as_deref(),
            rec.actual_epg_id
        ),
        ("match", Some("travel.us"), None)
    );
}

/// Review of the vouched-sibling rule: with Showtime 2's stream name-resolved
/// (not vouched) or gone, a re-check found nothing to compare and recorded
/// inconclusive over the mislabel, putting the guide back on the wrong listing.
#[tokio::test]
async fn standalone_keeps_a_mislabel_when_the_carried_channels_stream_is_name_resolved_or_gone() {
    for q in [
        "UPDATE channels SET epg_channel_id = NULL, epg_resolved_id = 'showtime2.us' WHERE stream_id = 22599",
        "DELETE FROM channels WHERE stream_id = 22599",
    ] {
        let mut f = feeds();
        f.insert(SUBJECT, slice(&plain(2), 130));
        let h = harness(plain(2), f).await;
        sql(&h.pool, q).await;
        let c = FeedCheck::new(
            SUBJECT,
            "mislabeled",
            Some("showtime.us"),
            Some("showtime2.us"),
            Some(22599),
            Some(0.97),
        );
        record_feed_check(&h.pool, &c, h.io.now_ms() - 2 * 24 * 3_600_000)
            .await
            .unwrap();
        assert_eq!(
            effective_epg_id(&h.pool, SUBJECT).await.unwrap().as_deref(),
            Some("showtime2.us")
        );
        let o = h.standalone(SUBJECT).await;
        assert_eq!(reason(&o), NO_SIBLING_REASON, "{q}");
        assert_eq!(h.io.captured(), Vec::<i64>::new());
        let rec = check(&h.pool, SUBJECT).await.unwrap();
        assert_eq!(
            (
                rec.verdict.as_str(),
                rec.actual_epg_id.as_deref(),
                rec.matched_stream_id,
                rec.score
            ),
            ("mislabeled", Some("showtime2.us"), Some(22599), Some(0.97)),
            "{q}"
        );
        assert_eq!(
            effective_epg_id(&h.pool, SUBJECT).await.unwrap().as_deref(),
            Some("showtime2.us")
        );
        // Restamped, so the sweep does not pick it again straight away.
        assert!(feed_check_is_fresh(
            &rec,
            Some("showtime.us"),
            h.io.now_ms()
        ));
    }
}

#[tokio::test]
async fn standalone_gives_up_its_first_slot_when_no_second_one_is_free() {
    let mut h = harness(plain(2), feeds()).await;
    h.io.upstream = Some(Box::new(|id| {
        if id == SUBJECT {
            Up::Killed
        } else {
            Up::NoSlot
        }
    }));
    let o = h.standalone(SUBJECT).await;
    assert_eq!(o, aborted("no second free upstream slot"));
    assert!(h.io.killed(SUBJECT));
    assert_eq!(check(&h.pool, SUBJECT).await, None);
}

#[tokio::test]
async fn standalone_captures_subject_and_candidate_side_by_side() {
    let mut f = feeds();
    f.insert(SUBJECT, slice(&plain(2), 130));
    let h = harness(plain(2), f).await;
    let o = h.standalone(SUBJECT).await;
    assert_eq!(carries(&o).0, "showtime2.us");
    assert_eq!(h.io.captured(), [SUBJECT, 5864, SUBJECT, 22599]);
    assert_eq!(h.verdict(SUBJECT).await.as_deref(), Some("mislabeled"));
}
