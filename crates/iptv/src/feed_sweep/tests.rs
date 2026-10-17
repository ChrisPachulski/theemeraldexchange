//! iptvFeedSweep.test.ts carried over (the rememberGuideScope case lives in
//! catalog's tests since S3). Captures are faked; the clock is fixed.

use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::time::Instant;

use super::*;
use crate::catalog::remember_guide_scope;
use crate::catalog::tests::pool;
use crate::config::test_config;
use crate::feed_checks::tests::{chan_in, check, ms, prog, sql};
use crate::feed_checks::{FeedCheck, record_feed_check};
use crate::feed_verify::tests::{FakeIo, Up, always};
use crate::fingerprint::synth::sweep;
use crate::remux::tests::{Fake, LIVE, remux_with};

/// Inside the default sweep window (9-15 UTC).
const NOW: &str = "2026-10-10T10:00:00Z";

async fn seeded() -> (SqlitePool, tempfile::TempDir) {
    let (p, dir) = pool().await;
    for (id, num, name, tvg, cat) in [
        (900, 1, "US: CNN", "cnn.us", 123), // the only CNN stream: nothing to compare
        (200163566, 154, "US: Showtime", "showtime.us", 123),
        (200163567, 204, "US: Showtime 2", "showtime2.us", 123),
        (5864, 5386, "US Showtime East (S)", "showtime.us", 999),
        (22599, 7357, "US Showtime 2 (East) (H)", "showtime2.us", 999),
        (777, 9000, "HBO Zone", "hbozone.us", 999),
        (778, 9001, "HBO Zone HD", "hbozone.us", 999),
    ] {
        chan_in(&p, id, num, name, Some(tvg), None, cat).await;
    }
    for id in ["cnn.us", "showtime.us", "showtime2.us", "hbozone.us"] {
        prog(&p, id, "2026-10-10T04:00:00Z", "2099-01-01T00:00:00Z", id).await;
    }
    // HBO Zone was watched recently: it goes before the guide's channels.
    sql(
        &p,
        "INSERT INTO iptv_watch_history (sub, kind, item_id, position_secs, watched_at) \
         VALUES ('u', 'live', '777', 0, '2026-10-09T20:00:00Z')",
    )
    .await;
    (p, dir)
}

/// Every stream shows one broadcast, so every comparison matches.
fn io() -> FakeIo {
    let mut io = FakeIo::new(ms(NOW), Vec::new(), Default::default());
    io.upstream = Some(Box::new(|_| Up::Frames(sweep())));
    io
}

async fn scope(p: &SqlitePool, cats: &[i64], limit: i64, has_epg: bool) {
    remember_guide_scope(p, cats, Some(limit), has_epg, NOW)
        .await
        .unwrap();
}

async fn matched(p: &SqlitePool, id: i64, listed: &str, at: i64) {
    let c = FeedCheck::new(id, "match", Some(listed), None, None, Some(1.0));
    record_feed_check(p, &c, at).await.unwrap();
}

async fn next(p: &SqlitePool) -> Option<i64> {
    next_sweep_channel(p, ms(NOW)).await.unwrap()
}

#[tokio::test]
async fn sweeps_the_500_the_app_shows_with_or_without_unscheduled_rows() {
    let (p, _d) = seeded().await;
    // An unscheduled channel numbered between CNN and Showtime.
    chan_in(&p, 901, 100, "US: A&E", Some("aetv.us"), None, 123).await;
    matched(&p, 777, "hbozone.us", ms(NOW)).await;
    matched(&p, 900, "cnn.us", ms(NOW)).await;
    // A hasEpg guide's first two rows are CNN and Showtime.
    scope(&p, &[123], 2, true).await;
    assert_eq!(next(&p).await, Some(200163566));
    // Without hasEpg the unscheduled A&E holds the second row instead.
    scope(&p, &[123], 2, false).await;
    assert_eq!(next(&p).await, Some(901));
}

#[tokio::test]
async fn goes_never_checked_or_re_listed_first_then_the_longest_unchecked_skipping_the_fresh() {
    let (p, _d) = seeded().await;
    scope(&p, &[123], 500, true).await;
    let now = ms(NOW);
    let day = 24 * 3_600_000;
    // All never checked: watched first, then guide order.
    assert_eq!(next(&p).await, Some(777));
    matched(&p, 777, "hbozone.us", now).await;
    assert_eq!(next(&p).await, Some(900));
    matched(&p, 900, "cnn.us", now).await;
    // Showtime's match expired; Showtime 2 was never checked, so it goes first.
    matched(&p, 200163566, "showtime.us", now - 8 * day).await;
    assert_eq!(next(&p).await, Some(200163567));
    matched(&p, 200163567, "showtime2.us", now - 9 * day).await;
    // Both expired: the one checked longest ago.
    assert_eq!(next(&p).await, Some(200163567));
    matched(&p, 200163567, "showtime2.us", now).await;
    assert_eq!(next(&p).await, Some(200163566));
    matched(&p, 200163566, "showtime.us", now).await;
    assert_eq!(next(&p).await, None);
    // A fresh verdict for a listing the stream no longer has does not count.
    sql(
        &p,
        "UPDATE channels SET epg_resolved_id = 'showtime2.us' WHERE stream_id = 200163566",
    )
    .await;
    assert_eq!(next(&p).await, Some(200163566));
}

#[tokio::test]
async fn checks_due_channels_back_to_back_while_idle_confirming_matched_streams_on_the_way() {
    let (p, _d) = seeded().await;
    scope(&p, &[123], 500, true).await;
    let io = io();
    let ran = run_sweep(&p, &Scheduler::default(), &io, &always(), MAX_CHECKS, 0)
        .await
        .unwrap();
    // 777 confirms 778 too; 200163566 confirms 5864; 200163567 confirms 22599.
    assert_eq!(ran, 4);
    assert_eq!(io.captured(), [777, 778, 200163566, 5864, 200163567, 22599]);
    for id in [777, 778, 200163566, 5864, 200163567, 22599] {
        assert_eq!(check(&p, id).await.unwrap().verdict, "match", "{id}");
    }
    // CNN has no second stream: recorded without a connection, and no gap after it.
    let cnn = check(&p, 900).await.unwrap();
    assert_eq!(
        (cnn.verdict.as_str(), cnn.reason.as_deref()),
        ("inconclusive", Some(NO_SIBLING_REASON))
    );
    assert_eq!(io.sleeps.load(Ordering::SeqCst), 3);
    assert_eq!(next(&p).await, None);
}

#[tokio::test]
async fn stops_when_a_viewer_appears_and_honours_its_check_budget() {
    let (p, _d) = seeded().await;
    scope(&p, &[123], 500, true).await;
    // Idle for the first check (one look before it, one inside it), then a viewer.
    let calls = AtomicUsize::new(0);
    let idle = || -> crate::feed_verify::BoxFuture<'_, bool> {
        Box::pin(std::future::ready(calls.fetch_add(1, Ordering::SeqCst) < 2))
    };
    assert_eq!(
        run_sweep(&p, &Scheduler::default(), &io(), &idle, MAX_CHECKS, 0)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        run_sweep(&p, &Scheduler::default(), &io(), &always(), 1, 0)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn stays_out_of_the_way_of_an_on_tune_check() {
    let (p, _d) = seeded().await;
    scope(&p, &[123], 500, true).await;
    let sched = Scheduler::default();
    let io = io();
    let ran = sched
        .run_exclusive(run_sweep(&p, &sched, &io, &always(), MAX_CHECKS, 0))
        .await
        .unwrap();
    assert_eq!(ran.unwrap(), 0);
    assert_eq!(io.captured(), Vec::<i64>::new());
}

fn quiet_remux() -> crate::remux::tests::R {
    let r = remux_with(Fake::new(LIVE), &[], Default::default());
    r.remux.set_activity(
        Instant::now()
            .checked_sub(Duration::from_secs(3600))
            .unwrap(),
    );
    r
}

#[tokio::test]
async fn keeps_clear_of_a_recording_about_to_start() {
    let (p, _d) = seeded().await;
    let r = quiet_remux();
    let now = ms(NOW);
    assert!(sweep_idle(&p, &r.remux, "9-15", now).await);
    sqlx::query(
        "INSERT INTO dvr_recordings (id, channel_stream_id, channel_name, title, start_utc, stop_utc, status, created_at, updated_at) \
         VALUES ('r1', 200163566, 'US: Showtime', 'Heat', ?, ?, 'scheduled', ?, ?)",
    )
    .bind(iso_ms(now + 60_000))
    .bind(iso_ms(now + 3_600_000))
    .bind(iso_ms(now))
    .bind(iso_ms(now))
    .execute(&p)
    .await
    .unwrap();
    assert!(!sweep_idle(&p, &r.remux, "9-15", now).await);
}

#[tokio::test]
async fn waits_out_a_quiet_period_after_any_viewer() {
    let (p, _d) = seeded().await;
    let r = quiet_remux();
    let ago = |d: Duration| Instant::now().checked_sub(d).unwrap();
    r.remux.set_activity(ago(Duration::from_secs(10 * 60)));
    assert!(!sweep_idle(&p, &r.remux, "9-15", ms(NOW)).await);
    r.remux.set_activity(ago(VIEWER_QUIET));
    assert!(sweep_idle(&p, &r.remux, "9-15", ms(NOW)).await);
    // A viewer streaming right now is activity, and a live upstream.
    let _s = r
        .remux
        .start("40", "plex:a", "https://x/a.ts", false)
        .unwrap()
        .unwrap();
    assert!(!sweep_idle(&p, &r.remux, "9-15", ms(NOW)).await);
}

#[tokio::test]
async fn runs_only_in_the_overnight_window_which_may_wrap_midnight() {
    let at = |hhmm: &str| ms(&format!("2026-10-10T{hhmm}:00Z"));
    assert!(!sweep_window_open(at("08:59"), "9-15"));
    assert!(sweep_window_open(at("09:00"), "9-15"));
    assert!(sweep_window_open(at("14:59"), "9-15"));
    assert!(!sweep_window_open(at("15:00"), "9-15"));
    assert!(sweep_window_open(at("23:00"), "22-4"));
    assert!(sweep_window_open(at("03:00"), "22-4"));
    assert!(!sweep_window_open(at("12:00"), "22-4"));
    assert!(!sweep_window_open(at("12:00"), "always"));
    assert!(!sweep_window_open(at("12:00"), "9-9"));
    // The 2026-10-10 game: 4 PM Eastern is outside the window.
    let (p, _d) = seeded().await;
    assert!(!sweep_idle(&p, &quiet_remux().remux, "9-15", at("20:11")).await);
}

#[test]
fn does_nothing_when_feed_checks_are_turned_off() {
    let creds = [
        ("XTREAM_HOST", "http://127.0.0.1:9"),
        ("XTREAM_USERNAME", "u"),
        ("XTREAM_PASSWORD", "p"),
    ];
    assert!(enabled(&test_config(&creds)));
    let mut off = creds.to_vec();
    off.push(("IPTV_FEED_CHECK", "0"));
    assert!(!enabled(&test_config(&off)));
    assert!(!enabled(&test_config(&[])));
}
