//! dvrRecordings.test.ts, dvrRecorder.test.ts, routes/dvr.test.ts and
//! routes/dvr.grant.test.ts carried over (the cases whose checks live here;
//! the section, rating and membership gates stay Hono's). ffmpeg is a shell
//! stub that logs its argv and runs a scripted behaviour, so nothing dials.

use super::*;
use crate::api::{AppState, router};
use crate::catalog::tests::pool;
use crate::config::test_config;
use axum::http::Method;
use emerald_contracts::internal_principal::{self, InternalClaims};
use std::os::unix::fs::PermissionsExt;
use tower::ServiceExt;

const NOW: &str = "2026-06-17T12:00:00.000Z";
const AFTER_WINDOW: &str = "2026-06-17T13:30:00.000Z";
const PRINCIPAL_SECRET: &str = "pppppppppppppppppppppppppppppppppppppppp";

fn t(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

fn input(channel: f64, start: &str, stop: &str) -> NewRecording {
    NewRecording {
        channel_stream_id: channel,
        channel_name: "BBC One".into(),
        title: "The News at Ten".into(),
        start_utc: start.into(),
        stop_utc: stop.into(),
    }
}

fn valid() -> NewRecording {
    input(42.0, "2026-06-17T13:00:00.000Z", "2026-06-17T13:30:00.000Z")
}

// ---- validate -----------------------------------------------------------------------

#[test]
fn validate_accepts_and_rejects_like_the_ts() {
    let now = t(NOW);
    assert_eq!(validate(&valid(), now, &[]), None);
    for bad_id in [0.0, 1.5, f64::NAN] {
        let i = NewRecording {
            channel_stream_id: bad_id,
            ..valid()
        };
        assert_eq!(validate(&i, now, &[]), Some("invalid_channel"));
    }
    let blank_name = NewRecording {
        channel_name: "  ".into(),
        ..valid()
    };
    assert_eq!(
        validate(&blank_name, now, &[]),
        Some("missing_channel_name")
    );
    let no_title = NewRecording {
        title: String::new(),
        ..valid()
    };
    assert_eq!(validate(&no_title, now, &[]), Some("missing_title"));
    let nope = NewRecording {
        start_utc: "nope".into(),
        ..valid()
    };
    assert_eq!(validate(&nope, now, &[]), Some("invalid_time"));
    let v = valid();
    assert_eq!(
        validate(&input(42.0, &v.stop_utc, &v.start_utc), now, &[]),
        Some("stop_before_start")
    );
    assert_eq!(
        validate(
            &input(42.0, "2026-06-17T10:00:00.000Z", "2026-06-17T11:00:00.000Z"),
            now,
            &[]
        ),
        Some("already_ended")
    );
}

/// The route's SQL scope: same channel, status scheduled or recording.
fn for_channel(rows: &[(i64, &str, &str, &str)], channel: i64) -> Vec<(String, String)> {
    rows.iter()
        .filter(|(c, st, _, _)| *c == channel && matches!(*st, "scheduled" | "recording"))
        .map(|(_, _, a, b)| (a.to_string(), b.to_string()))
        .collect()
}

#[test]
fn validate_refuses_an_overlap_on_the_same_channel_only() {
    let now = t(NOW);
    // valid() is 13:00-13:30 on channel 42.
    let straddling = (
        42,
        "scheduled",
        "2026-06-17T13:15:00.000Z",
        "2026-06-17T14:00:00.000Z",
    );
    let overlaps = [
        straddling,
        (
            42,
            "scheduled",
            "2026-06-17T12:45:00.000Z",
            "2026-06-17T13:05:00.000Z",
        ),
        (
            42,
            "scheduled",
            "2026-06-17T12:00:00.000Z",
            "2026-06-17T15:00:00.000Z",
        ),
        (
            42,
            "scheduled",
            "2026-06-17T13:10:00.000Z",
            "2026-06-17T13:20:00.000Z",
        ),
        (42, "recording", straddling.2, straddling.3),
    ];
    for row in overlaps {
        assert_eq!(
            validate(&valid(), now, &for_channel(&[row], 42)),
            Some("channel_overlap"),
            "{row:?}"
        );
    }
    // Half-open: ends as we start, starts as we end.
    let back_to_back = [
        (
            42,
            "scheduled",
            "2026-06-17T12:30:00.000Z",
            "2026-06-17T13:00:00.000Z",
        ),
        (
            42,
            "scheduled",
            "2026-06-17T13:30:00.000Z",
            "2026-06-17T14:00:00.000Z",
        ),
    ];
    assert_eq!(
        validate(&valid(), now, &for_channel(&back_to_back, 42)),
        None
    );
    let other_channel = [(99, "scheduled", straddling.2, straddling.3)];
    assert_eq!(
        validate(&valid(), now, &for_channel(&other_channel, 42)),
        None
    );
    let terminal: Vec<_> = ["completed", "cancelled", "failed", "missed"]
        .map(|st| (42, st, straddling.2, straddling.3))
        .into();
    assert_eq!(validate(&valid(), now, &for_channel(&terminal, 42)), None);
}

// ---- plan_transitions ---------------------------------------------------------------

fn row(id: &str, status: &str, start: &str, stop: &str) -> Recording {
    Recording {
        id: id.into(),
        channel_stream_id: 42,
        channel_name: "c".into(),
        title: "t".into(),
        start_utc: start.into(),
        stop_utc: stop.into(),
        status: status.into(),
        file_path: None,
        error: None,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn ids(v: &[Recording]) -> Vec<&str> {
    v.iter().map(|r| r.id.as_str()).collect()
}

#[test]
fn plan_starts_stops_misses_and_ignores_terminal_rows() {
    let now = t(NOW);
    let (s, e) = ("2026-06-17T11:00:00.000Z", "2026-06-17T13:00:00.000Z");
    let p = plan_transitions(now, vec![row("a", "scheduled", s, e)]);
    assert_eq!(
        (ids(&p.to_start), p.to_stop.len(), p.to_miss.len()),
        (vec!["a"], 0, 0)
    );
    let p = plan_transitions(
        now,
        vec![row(
            "b",
            "scheduled",
            "2026-06-17T14:00:00.000Z",
            "2026-06-17T15:00:00.000Z",
        )],
    );
    assert!(p.to_start.is_empty() && p.to_miss.is_empty());
    let p = plan_transitions(
        now,
        vec![row(
            "c",
            "recording",
            "2026-06-17T10:00:00.000Z",
            "2026-06-17T11:30:00.000Z",
        )],
    );
    assert_eq!(ids(&p.to_stop), vec!["c"]);
    let p = plan_transitions(
        now,
        vec![row(
            "d",
            "scheduled",
            "2026-06-17T09:00:00.000Z",
            "2026-06-17T10:00:00.000Z",
        )],
    );
    assert_eq!(ids(&p.to_miss), vec!["d"]);
    assert!(p.to_start.is_empty());
    let p = plan_transitions(
        now,
        vec![row("e", "completed", s, e), row("f", "cancelled", s, e)],
    );
    assert!(p.to_start.is_empty() && p.to_stop.is_empty() && p.to_miss.is_empty());
    // An open 'recording' row (orphaned by a restart) goes back to start.
    let p = plan_transitions(now, vec![row("g", "recording", s, e)]);
    assert_eq!(ids(&p.to_start), vec!["g"]);
}

// ---- CRUD ----------------------------------------------------------------------------

#[tokio::test]
async fn crud_round_trips_cancels_and_deletes() {
    let (pool, _d) = pool().await;
    let now = t(NOW);
    let rec = schedule(&pool, &valid(), now).await.unwrap();
    assert_eq!(rec.status, "scheduled");
    assert_eq!(rec.channel_stream_id, 42);
    assert_eq!(rec.file_path, None);
    assert_eq!(rec.created_at, NOW);
    assert_eq!(ids(&list(&pool).await.unwrap()), vec![rec.id.as_str()]);
    assert_eq!(
        get_recording(&pool, &rec.id).await.unwrap().unwrap().title,
        "The News at Ten"
    );
    assert!(get_recording(&pool, "missing").await.unwrap().is_none());

    assert_eq!(
        cancel(&pool, &rec.id, now).await.unwrap(),
        Some("cancelled")
    );
    let got = get_recording(&pool, &rec.id).await.unwrap().unwrap();
    assert_eq!(got.status, "cancelled");

    let done = schedule(&pool, &valid(), now).await.unwrap();
    mark_status(&pool, &done.id, "completed", Some("/rec/x.ts"), None, now)
        .await
        .unwrap();
    let got = get_recording(&pool, &done.id).await.unwrap().unwrap();
    assert_eq!(got.file_path.as_deref(), Some("/rec/x.ts"));
    assert_eq!(cancel(&pool, &done.id, now).await.unwrap(), Some("deleted"));
    assert!(get_recording(&pool, &done.id).await.unwrap().is_none());
    assert_eq!(cancel(&pool, "nope", now).await.unwrap(), None);
}

// ---- build_record_args / live_url ---------------------------------------------------

fn proxy() -> Vec<String> {
    vec!["-http_proxy".into(), "http://127.0.0.1:9".into()]
}

fn after<'a>(a: &'a [String], flag: &str) -> &'a str {
    &a[a.iter().position(|x| x == flag).unwrap() + 1]
}

#[test]
fn record_args_copy_to_mpegts_bounded_overwriting_and_proxied() {
    let a = build_record_args("https://x/live/u/p/42.ts", "/rec/r.ts", 1800.7, &proxy());
    assert_eq!(after(&a, "-i"), "https://x/live/u/p/42.ts");
    assert_eq!(after(&a, "-c"), "copy");
    assert_eq!(after(&a, "-f"), "mpegts");
    assert_eq!(after(&a, "-t"), "1800");
    // A resumed recording reuses <id>.ts: overwrite it.
    assert_eq!(&a[a.len() - 2..], ["-y", "/rec/r.ts"]);
    let a = build_record_args("u", "f", 0.0, &proxy());
    assert_eq!(after(&a, "-t"), "1");
    let wl = after(&a, "-protocol_whitelist");
    assert!(!wl.contains("file") && !wl.contains("pipe"));
    assert_eq!(after(&a, "-http_proxy"), "http://127.0.0.1:9");
    let pos = |f: &str| a.iter().position(|x| x == f).unwrap();
    assert!(pos("-http_proxy") < pos("-i"));
}

#[test]
fn live_url_is_the_xtream_live_ts_url() {
    let c = Creds {
        host: "https://prov.example".into(),
        username: "u".into(),
        password: "p".into(),
    };
    assert_eq!(live_url(&c, 42), "https://prov.example/live/u/p/42.ts");
}

// ---- tick (fake recorder) -----------------------------------------------------------

#[derive(Clone, Default)]
struct FakeRecorder {
    started: Arc<Mutex<Vec<String>>>,
    stopped: Arc<Mutex<Vec<String>>>,
    run: Arc<Mutex<HashSet<String>>>,
    throw_on_start: bool,
}

impl FakeRecorder {
    fn started(&self) -> Vec<String> {
        self.started.lock().unwrap().clone()
    }
    fn stopped(&self) -> Vec<String> {
        self.stopped.lock().unwrap().clone()
    }
}

impl Recorder for FakeRecorder {
    fn start(&self, rec: &Recording) -> Result<Option<String>, String> {
        if self.throw_on_start {
            return Err("spawn_failed".into());
        }
        self.started.lock().unwrap().push(rec.id.clone());
        self.run.lock().unwrap().insert(rec.id.clone());
        Ok(Some(format!("/rec/{}.ts", rec.id)))
    }
    fn stop(&self, id: &str) -> impl Future<Output = ()> + Send {
        self.stopped.lock().unwrap().push(id.into());
        self.run.lock().unwrap().remove(id);
        async {}
    }
    fn running(&self) -> HashSet<String> {
        self.run.lock().unwrap().clone()
    }
}

async fn sched(pool: &SqlitePool, channel: i64, start: &str, stop: &str) -> Recording {
    schedule(pool, &input(channel as f64, start, stop), t(NOW))
        .await
        .unwrap()
}

async fn status(pool: &SqlitePool, id: &str) -> Recording {
    get_recording(pool, id).await.unwrap().unwrap()
}

const S11: &str = "2026-06-17T11:00:00.000Z";
const S13: &str = "2026-06-17T13:00:00.000Z";

#[tokio::test]
async fn tick_starts_due_stops_finished_marks_missed() {
    let (pool, _d) = pool().await;
    let a = sched(&pool, 1, S11, S13).await;
    let b = sched(
        &pool,
        1,
        "2026-06-17T10:00:00.000Z",
        "2026-06-17T11:30:00.000Z",
    )
    .await;
    mark_status(&pool, &b.id, "recording", None, None, t(NOW))
        .await
        .unwrap();
    let c = sched(
        &pool,
        1,
        "2026-06-17T09:00:00.000Z",
        "2026-06-17T10:00:00.000Z",
    )
    .await;
    let rec = FakeRecorder::default();
    tick(&pool, &rec, t(NOW)).await.unwrap();
    assert_eq!(rec.started(), vec![a.id.clone()]);
    let got = status(&pool, &a.id).await;
    assert_eq!(got.status, "recording");
    assert_eq!(got.file_path, Some(format!("/rec/{}.ts", a.id)));
    assert_eq!(rec.stopped(), vec![b.id.clone()]);
    assert_eq!(status(&pool, &b.id).await.status, "completed");
    assert_eq!(status(&pool, &c.id).await.status, "missed");
}

#[tokio::test]
async fn tick_does_not_restart_an_in_flight_recording() {
    let (pool, _d) = pool().await;
    let a = sched(&pool, 1, S11, S13).await;
    mark_status(&pool, &a.id, "recording", Some("/rec/a.ts"), None, t(NOW))
        .await
        .unwrap();
    let rec = FakeRecorder::default();
    rec.run.lock().unwrap().insert(a.id.clone());
    tick(&pool, &rec, t(NOW)).await.unwrap();
    assert!(rec.started().is_empty());
}

#[tokio::test]
async fn tick_resumes_an_orphan_then_completes_it_when_the_window_closes() {
    let (pool, _d) = pool().await;
    let a = sched(&pool, 1, S11, S13).await;
    mark_status(&pool, &a.id, "recording", Some("/rec/a.ts"), None, t(NOW))
        .await
        .unwrap();
    // A fresh recorder (running() empty) is what a restart leaves.
    let rec = FakeRecorder::default();
    tick(&pool, &rec, t(NOW)).await.unwrap();
    assert_eq!(rec.started(), vec![a.id.clone()]);
    assert_eq!(status(&pool, &a.id).await.status, "recording");
    tick(&pool, &rec, t(AFTER_WINDOW)).await.unwrap();
    assert_eq!(rec.stopped(), vec![a.id.clone()]);
    assert_eq!(status(&pool, &a.id).await.status, "completed");
}

#[tokio::test]
async fn tick_fails_a_recording_whose_start_errors() {
    let (pool, _d) = pool().await;
    let a = sched(&pool, 1, S11, S13).await;
    let rec = FakeRecorder {
        throw_on_start: true,
        ..Default::default()
    };
    tick(&pool, &rec, t(NOW)).await.unwrap();
    let got = status(&pool, &a.id).await;
    assert_eq!(got.status, "failed");
    assert!(got.error.unwrap().contains("spawn_failed"));
}

#[tokio::test]
async fn scheduler_ticks_now_and_on_the_interval_until_aborted() {
    let (pool, _d) = pool().await;
    let open = sched(
        &pool,
        1,
        "2000-01-01T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
    )
    .await;
    let rec = FakeRecorder::default();
    let job = spawn_scheduler(pool.clone(), rec.clone(), Duration::from_millis(30));
    // The first tick starts it; later ticks see it running and leave it.
    wait_for(|| !rec.started().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(rec.started(), vec![open.id.clone()]);
    job.abort();
    assert!(job.await.unwrap_err().is_cancelled());
}

async fn wait_for(mut f: impl FnMut() -> bool) {
    for _ in 0..250 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not met in 5 s");
}

// ---- FfmpegRecorder (shell stub) ---------------------------------------------------

// Long-running snippets touch `$c/ready` once their traps are set, so a test
// never signals a shell that has not installed them yet (Rig::ready).

/// Runs until signalled; dies of SIGTERM.
const UNTIL_TERM: &str = "touch \"$c/ready\"\nexec sleep 30\n";
/// Like real ffmpeg: traps SIGTERM, exits 255 (no signal).
const TRAP_255: &str =
    "trap 'kill $! 2>/dev/null; exit 255' TERM\ntouch \"$c/ready\"\nsleep 30 &\nwait\n";
/// Exits 0 a beat after SIGTERM (ffmpeg flushing the file).
const SLOW_TERM: &str =
    "trap 'kill $! 2>/dev/null; sleep 0.3; exit 0' TERM\ntouch \"$c/ready\"\nsleep 30 &\nwait\n";

struct Stub {
    dir: tempfile::TempDir,
}

impl Stub {
    /// `run` is sourced with `$out` set to the output file (the last arg).
    fn new(run: &str) -> Stub {
        let dir = tempfile::tempdir().unwrap();
        let ctl = dir.path().join("ctl");
        std::fs::create_dir_all(&ctl).unwrap();
        std::fs::write(ctl.join("run"), run).unwrap();
        let bin = dir.path().join("ffmpeg");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\n[ \"$1\" = --probe ] && exit 0\nc='{}'\n\
                 for a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"$c/argv\"\n\
                 echo $$ > \"$c/pid\"\neval \"out=\\${{$#}}\"\n. \"$c/run\"\n",
                ctl.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Linux: a fork while the stub was open for writing makes exec fail
        // ETXTBSY until that child execs. One clean exec settles it.
        for _ in 0..100 {
            match std::process::Command::new(&bin).arg("--probe").status() {
                Err(e) if e.raw_os_error() == Some(26) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                r => {
                    assert!(r.unwrap().success());
                    break;
                }
            }
        }
        Stub { dir }
    }

    fn bin(&self) -> String {
        self.dir
            .path()
            .join("ffmpeg")
            .to_string_lossy()
            .into_owned()
    }

    fn rec_dir(&self) -> String {
        self.dir.path().join("rec").to_string_lossy().into_owned()
    }

    fn argv(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.path().join("ctl/argv"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    fn pid(&self) -> i32 {
        std::fs::read_to_string(self.dir.path().join("ctl/pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
}

struct Rig {
    pool: SqlitePool,
    state: AppState,
    rec: FfmpegRecorder,
    stub: Stub,
    _db: tempfile::TempDir,
}

/// A recorder on the stub at a fixed clock (`AppState` supplies the tracker,
/// remux and egress proxy, as in prod).
async fn rig(run: &str, now: &'static str, extra: &[(&str, &str)]) -> Rig {
    let stub = Stub::new(run);
    let (pool, db_dir) = pool().await;
    let (bin, dir) = (stub.bin(), stub.rec_dir());
    let mut pairs = vec![
        ("DVR_ENABLED", "1"),
        ("DVR_DIR", dir.as_str()),
        ("IPTV_FFMPEG_BIN", bin.as_str()),
        ("XTREAM_HOST", "https://prov.example"),
        ("XTREAM_USERNAME", "u"),
        ("XTREAM_PASSWORD", "p"),
    ];
    pairs.extend_from_slice(extra);
    let config = Arc::new(test_config(&pairs));
    let state = AppState::new(pool.clone(), config.clone());
    let rec = FfmpegRecorder::with_clock(
        pool.clone(),
        &config,
        state.streams.tracker.clone(),
        state.streams.live.remux.clone(),
        Box::new(move || t(now)),
        Duration::from_secs(1),
    );
    Rig {
        pool,
        state,
        rec,
        stub,
        _db: db_dir,
    }
}

impl Rig {
    /// A due recording (11:00-13:00 on channel 7), started through tick.
    async fn started(&self) -> Recording {
        let r = sched(&self.pool, 7, S11, S13).await;
        tick(&self.pool, &self.rec, t(NOW)).await.unwrap();
        status(&self.pool, &r.id).await
    }

    async fn ready(&self) {
        let f = self.stub.dir.path().join("ctl/ready");
        wait_for(|| f.exists()).await;
    }

    async fn exited(&self, id: &str) -> Recording {
        wait_for(|| !self.rec.running().contains(id)).await;
        status(&self.pool, id).await
    }

    fn slot_held(&self, id: &str) -> bool {
        self.state.streams.tracker.has(&record_session_id(id))
    }
}

fn kill(pid: i32, sig: i32) {
    // SAFETY: signalling the stub process this test spawned.
    unsafe {
        libc::kill(pid, sig);
    }
}

#[tokio::test]
async fn recorder_spawns_ffmpeg_on_the_live_url_and_returns_the_file() {
    let r = rig(UNTIL_TERM, NOW, &[]).await;
    let row = r.started().await;
    assert_eq!(row.status, "recording");
    let file = r.rec.file_path_for(&row.id).to_string_lossy().into_owned();
    assert_eq!(row.file_path.as_deref(), Some(file.as_str()));
    assert!(r.rec.running().contains(&row.id));
    wait_for(|| !r.stub.argv().is_empty()).await;
    let argv = r.stub.argv();
    assert!(argv.contains(&"https://prov.example/live/u/p/7.ts".to_string()));
    // 13:00 - 12:00 on the recorder's clock.
    assert_eq!(after(&argv, "-t"), "3600");
    assert!(after(&argv, "-http_proxy").starts_with("http://127.0.0.1:"));
    r.rec.stop(&row.id).await;
}

#[tokio::test]
async fn recorder_completes_on_a_clean_exit() {
    let r = rig("exit 0\n", NOW, &[]).await;
    let row = r.started().await;
    assert_eq!(r.exited(&row.id).await.status, "completed");
}

#[tokio::test]
async fn recorder_fails_a_non_zero_exit() {
    let r = rig("exit 1\n", NOW, &[]).await;
    let row = r.started().await;
    let got = r.exited(&row.id).await;
    assert_eq!(got.status, "failed");
    assert_eq!(got.error.as_deref(), Some("ffmpeg exited code=1 signal="));
}

#[tokio::test]
async fn a_sigterm_inside_the_window_leaves_it_recording_to_resume() {
    // Killed by a SIGTERM from outside (the TS case).
    let r = rig(UNTIL_TERM, NOW, &[]).await;
    let row = r.started().await;
    r.ready().await;
    kill(r.stub.pid(), libc::SIGTERM);
    assert_eq!(r.exited(&row.id).await.status, "recording");
    // Real ffmpeg traps our SIGTERM (shutdown) and exits 255: same verdict.
    let r = rig(TRAP_255, NOW, &[]).await;
    let row = r.started().await;
    r.ready().await;
    r.rec.stop_all(Duration::from_secs(5)).await;
    assert!(!r.rec.running().contains(&row.id));
    assert_eq!(status(&r.pool, &row.id).await.status, "recording");
    // ...and the next tick resumes it.
    tick(&r.pool, &r.rec, t(NOW)).await.unwrap();
    assert!(r.rec.running().contains(&row.id));
    r.rec.stop(&row.id).await;
}

#[tokio::test]
async fn a_sigterm_after_the_window_completes() {
    for run in [UNTIL_TERM, TRAP_255] {
        let r = rig(run, AFTER_WINDOW, &[]).await;
        let row = sched(&r.pool, 7, S11, S13).await;
        // Started mid-window, stopped by a tick past stop_utc.
        tick(&r.pool, &r.rec, t(NOW)).await.unwrap();
        r.ready().await;
        tick(&r.pool, &r.rec, t(AFTER_WINDOW)).await.unwrap();
        let got = status(&r.pool, &row.id).await;
        assert_eq!(got.status, "completed", "{run}");
        assert!(!r.rec.running().contains(&row.id));
    }
}

#[tokio::test]
async fn an_exit_after_a_cancel_keeps_cancelled_and_removes_the_partial() {
    let r = rig(": > \"$out\"\nexec sleep 30\n", NOW, &[]).await;
    let row = r.started().await;
    let file = r.rec.file_path_for(&row.id);
    wait_for(|| file.exists()).await;
    mark_status(&r.pool, &row.id, "cancelled", None, None, t(NOW))
        .await
        .unwrap();
    r.rec.stop(&row.id).await;
    assert_eq!(status(&r.pool, &row.id).await.status, "cancelled");
    assert!(!file.exists());
    // Not double-handled on a failing exit either.
    let r = rig("exit 1\n", NOW, &[]).await;
    let row = sched(&r.pool, 7, S11, S13).await;
    mark_status(&r.pool, &row.id, "cancelled", None, None, t(NOW))
        .await
        .unwrap();
    assert!(r.rec.start(&row).unwrap().is_some());
    assert_eq!(r.exited(&row.id).await.status, "cancelled");
}

#[tokio::test]
async fn stderr_with_creds_is_scrubbed_without_disturbing_the_recording() {
    let r = rig(
        "echo 'error opening https://prov.example/live/u/p/7.ts' >&2\nexit 0\n",
        NOW,
        &[],
    )
    .await;
    let row = r.started().await;
    assert_eq!(r.exited(&row.id).await.status, "completed");
}

#[tokio::test]
async fn a_spawn_error_fails_the_row_and_releases_the_slot() {
    let (pool, _d) = pool().await;
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("no-ffmpeg").to_string_lossy().into_owned();
    let rec_dir = dir.path().join("rec").to_string_lossy().into_owned();
    let state = AppState::new(
        pool.clone(),
        Arc::new(test_config(&[
            ("DVR_ENABLED", "1"),
            ("DVR_DIR", rec_dir.as_str()),
            ("IPTV_FFMPEG_BIN", missing.as_str()),
            ("XTREAM_HOST", "https://prov.example"),
            // Not one letter: the scrubber would redact it inside the message.
            ("XTREAM_USERNAME", "user1"),
            ("XTREAM_PASSWORD", "pass1"),
        ])),
    );
    let rec = state.dvr.clone().unwrap();
    let row = sched(
        &pool,
        9,
        "2000-01-01T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
    )
    .await;
    tick(&pool, &rec, Utc::now()).await.unwrap();
    let got = status(&pool, &row.id).await;
    assert_eq!(got.status, "failed");
    assert!(got.error.unwrap().contains("No such file"), "ENOENT");
    assert!(!rec.running().contains(&row.id));
    assert!(!state.streams.tracker.has(&record_session_id(&row.id)));
}

#[tokio::test]
async fn stop_resolves_only_once_ffmpeg_has_exited() {
    let r = rig(SLOW_TERM, NOW, &[]).await;
    let row = r.started().await;
    r.ready().await;
    let stopping = tokio::spawn({
        let rec = r.rec.clone();
        let id = row.id.clone();
        async move { rec.stop(&id).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!stopping.is_finished(), "ffmpeg is still flushing");
    stopping.await.unwrap();
    assert!(!r.rec.running().contains(&row.id));
    // Unknown and already-exited ids resolve at once.
    tokio::time::timeout(Duration::from_millis(50), r.rec.stop("unknown"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_millis(50), r.rec.stop(&row.id))
        .await
        .unwrap();
}

#[tokio::test]
async fn sigkill_backstop_fires_only_while_ffmpeg_still_runs() {
    // Ignores SIGTERM: killed after the (test) 1 s grace.
    let r = rig(
        "trap '' TERM\ntouch \"$c/ready\"\nexec sleep 30\n",
        AFTER_WINDOW,
        &[],
    )
    .await;
    let row = r.started().await;
    r.ready().await;
    tokio::time::timeout(Duration::from_secs(3), r.rec.stop(&row.id))
        .await
        .unwrap();
    let got = status(&r.pool, &row.id).await;
    assert_eq!(got.status, "failed");
    assert_eq!(
        got.error.as_deref(),
        Some("ffmpeg exited code=null signal=SIGKILL")
    );
    // Obeys SIGTERM: never escalated.
    let r = rig(UNTIL_TERM, AFTER_WINDOW, &[]).await;
    let row = r.started().await;
    r.ready().await;
    r.rec.stop(&row.id).await;
    let got = status(&r.pool, &row.id).await;
    assert_eq!(got.status, "completed");
    assert_eq!(got.error, None);
}

#[tokio::test]
async fn tick_waits_for_the_real_exit_before_completing() {
    let r = rig(SLOW_TERM, AFTER_WINDOW, &[]).await;
    let row = r.started().await;
    r.ready().await;
    let ticking = tokio::spawn({
        let (pool, rec) = (r.pool.clone(), r.rec.clone());
        async move { tick(&pool, &rec, t(AFTER_WINDOW)).await.unwrap() }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Signalled but still writing: not completed yet.
    assert_eq!(status(&r.pool, &row.id).await.status, "recording");
    ticking.await.unwrap();
    assert_eq!(status(&r.pool, &row.id).await.status, "completed");
    assert!(!r.rec.running().contains(&row.id));
}

#[tokio::test]
async fn a_stopped_recording_that_exits_non_zero_stays_failed() {
    let r = rig(
        "trap 'kill $! 2>/dev/null; exit 1' TERM\ntouch \"$c/ready\"\nsleep 30 &\nwait\n",
        AFTER_WINDOW,
        &[],
    )
    .await;
    let row = r.started().await;
    r.ready().await;
    tick(&r.pool, &r.rec, t(AFTER_WINDOW)).await.unwrap();
    let got = status(&r.pool, &row.id).await;
    assert_eq!(got.status, "failed");
    assert!(got.error.unwrap().contains("code=1"));
}

// ---- upstream accounting ------------------------------------------------------------

#[tokio::test]
async fn defers_while_a_viewer_holds_the_one_upstream_then_records() {
    let r = rig(UNTIL_TERM, NOW, &[("IPTV_MAX_UPSTREAM_CONNECTIONS", "1")]).await;
    let row = sched(&r.pool, 9, S11, S13).await;
    let tracker = &r.state.streams.tracker;
    tracker
        .try_acquire(Acquire {
            sub: "plex:viewer".into(),
            session_id: "live:1:plex:viewer:1".into(),
            kind: Kind::Remux,
            resource_id: "1".into(),
            ip: None,
            title: None,
            kind_cap: None,
            replace_live: false,
        })
        .unwrap();
    tick(&r.pool, &r.rec, t(NOW)).await.unwrap();
    assert!(r.rec.running().is_empty(), "no ffmpeg over the cap");
    assert_eq!(status(&r.pool, &row.id).await.status, "scheduled");

    tracker.release("live:1:plex:viewer:1");
    tick(&r.pool, &r.rec, t(NOW)).await.unwrap();
    assert!(r.rec.running().contains(&row.id));
    assert_eq!(status(&r.pool, &row.id).await.status, "recording");
    let slot = tracker
        .list()
        .into_iter()
        .find(|s| s.session_id == record_session_id(&row.id))
        .unwrap();
    assert_eq!((slot.kind, slot.resource_id.as_str()), (Kind::Live, "9"));
    assert_eq!(slot.sub, format!("dvr:{}", row.id));
    r.rec.stop(&row.id).await;
}

#[tokio::test]
async fn defers_when_the_tracker_is_full_of_vod_sessions() {
    let r = rig(UNTIL_TERM, NOW, &[("IPTV_MAX_UPSTREAM_CONNECTIONS", "1")]).await;
    let row = sched(&r.pool, 9, S11, S13).await;
    let tracker = &r.state.streams.tracker;
    // VOD opens no provider connection, so only tryAcquire stands in the way.
    for i in 0..r.state.config.iptv_max_concurrent_streams {
        tracker
            .try_acquire(Acquire {
                sub: format!("plex:vod{i}"),
                session_id: format!("vod:{i}"),
                kind: Kind::Vod,
                resource_id: format!("v{i}"),
                ip: None,
                title: None,
                kind_cap: None,
                replace_live: false,
            })
            .unwrap();
    }
    tick(&r.pool, &r.rec, t(NOW)).await.unwrap();
    assert!(r.rec.running().is_empty());
    assert_eq!(status(&r.pool, &row.id).await.status, "scheduled");
    assert!(!r.slot_held(&row.id), "no phantom slot");

    tracker.release("vod:0");
    tick(&r.pool, &r.rec, t(NOW)).await.unwrap();
    assert_eq!(status(&r.pool, &row.id).await.status, "recording");
    r.rec.stop(&row.id).await;
}

#[tokio::test]
async fn the_slot_is_released_when_ffmpeg_exits_and_heartbeats_while_it_runs() {
    let r = rig("exit 0\n", NOW, &[]).await;
    let row = sched(&r.pool, 9, S11, S13).await;
    assert!(r.rec.start(&row).unwrap().is_some());
    r.exited(&row.id).await;
    assert!(!r.slot_held(&row.id));

    let r = rig(UNTIL_TERM, NOW, &[]).await;
    let row = r.started().await;
    assert!(r.slot_held(&row.id));
    r.rec.heartbeat();
    r.rec.stop(&row.id).await;
    assert!(!r.slot_held(&row.id));
}

// ---- routes -------------------------------------------------------------------------

struct App {
    app: Router,
    pool: SqlitePool,
    state: AppState,
    dir: tempfile::TempDir,
    stub: Stub,
}

struct Res {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
    fn header(&self, k: &str) -> &str {
        self.headers.get(k).unwrap().to_str().unwrap()
    }
}

fn bearer(sub: &str, role: &str) -> String {
    let now = Utc::now().timestamp();
    let claims = InternalClaims {
        iss: "eex".into(),
        sub: sub.into(),
        role: role.into(),
        auth_mode: "plex".into(),
        server_id: "srv".into(),
        device_id: None,
        req_id: "r1".into(),
        iat: now,
        exp: now + 60,
    };
    format!(
        "Bearer {}",
        internal_principal::encrypt_with_secret(PRINCIPAL_SECRET.as_bytes(), &claims)
    )
}

async fn app_with(mode: &str, dvr: &str) -> App {
    let stub = Stub::new(": > \"$out\"\nexec sleep 30\n");
    let (pool, dir) = pool().await;
    let (bin, rec_dir) = (stub.bin(), stub.rec_dir());
    let config = test_config(&[
        ("MEDIA_INTERNAL_PRINCIPAL_MODE", mode),
        ("INTERNAL_PRINCIPAL_SECRET", PRINCIPAL_SECRET),
        ("DVR_ENABLED", dvr),
        ("DVR_DIR", rec_dir.as_str()),
        ("IPTV_FFMPEG_BIN", bin.as_str()),
        ("XTREAM_HOST", "https://prov.example"),
        ("XTREAM_USERNAME", "u"),
        ("XTREAM_PASSWORD", "p"),
    ]);
    let state = AppState::new(pool.clone(), Arc::new(config));
    App {
        app: router(state.clone()),
        pool,
        state,
        dir,
        stub,
    }
}

async fn app() -> App {
    app_with("enforce", "1").await
}

const FUTURE_START: &str = "2099-01-01T10:00:00.000Z";
const FUTURE_STOP: &str = "2099-01-01T11:00:00.000Z";

fn body(channel: i64, start: &str, stop: &str) -> String {
    json!({
        "channel_stream_id": channel,
        "channel_name": "BBC One",
        "title": "News",
        "start_utc": start,
        "stop_utc": stop,
    })
    .to_string()
}

fn valid_body() -> String {
    body(42, FUTURE_START, FUTURE_STOP)
}

impl App {
    async fn call(
        &self,
        method: Method,
        uri: &str,
        who: Option<(&str, &str)>,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Res {
        let mut req = axum::http::Request::builder().method(method).uri(uri);
        if let Some((sub, role)) = who {
            req = req.header(header::AUTHORIZATION, bearer(sub, role));
        }
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = self
            .app
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        Res {
            status: res.status(),
            headers: res.headers().clone(),
            body: axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap(),
        }
    }

    /// As the admin `plex:42`.
    async fn admin(&self, method: Method, uri: &str, body: &str) -> Res {
        self.call(method, uri, Some(("plex:42", "admin")), &[], body)
            .await
    }

    async fn post(&self, body: &str) -> Res {
        self.admin(Method::POST, "/api/dvr/recordings", body).await
    }

    async fn get(&self, uri: &str) -> Res {
        self.call(Method::GET, uri, Some(("plex:42", "user")), &[], "")
            .await
    }

    async fn play(&self, id: &str, range: Option<&str>) -> Res {
        let headers: Vec<(&str, &str)> = range.map(|r| ("range", r)).into_iter().collect();
        self.call(
            Method::GET,
            &format!("/api/dvr/recordings/{id}/play"),
            Some(("plex:42", "user")),
            &headers,
            "",
        )
        .await
    }

    /// A completed recording over a real file of `bytes` bytes.
    async fn completed(&self, bytes: usize) -> (String, PathBuf) {
        let file = self
            .dir
            .path()
            .join(format!("{}.ts", ulid::Ulid::generate()));
        std::fs::write(&file, vec![1u8; bytes]).unwrap();
        let r = schedule(
            &self.pool,
            &input(42.0, FUTURE_START, FUTURE_STOP),
            Utc::now(),
        )
        .await
        .unwrap();
        mark_status(
            &self.pool,
            &r.id,
            "completed",
            Some(file.to_str().unwrap()),
            None,
            Utc::now(),
        )
        .await
        .unwrap();
        (r.id, file)
    }
}

#[tokio::test]
async fn dvr_routes_exist_only_with_dvr_enabled() {
    let a = app_with("enforce", "0").await;
    assert!(a.state.dvr.is_none());
    assert_eq!(
        a.get("/api/dvr/recordings").await.status,
        StatusCode::NOT_FOUND
    );
    let a = app().await;
    assert_eq!(a.get("/api/dvr/recordings").await.status, StatusCode::OK);
    // Behind the principal layer like every /api route.
    let res = a
        .call(Method::GET, "/api/dvr/recordings", None, &[], "")
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn post_schedules_validates_and_refuses_bad_json() {
    let a = app().await;
    let res = a.post(&valid_body()).await;
    assert_eq!(res.status, StatusCode::CREATED);
    assert_eq!(res.json()["recording"]["status"], "scheduled");
    assert_eq!(res.json()["recording"]["title"], "News");

    let res = a
        .post(&body(
            42,
            "2000-01-01T00:00:00.000Z",
            "2000-01-01T01:00:00.000Z",
        ))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.json()["error"], "already_ended");

    let res = a.post("{not json").await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.json()["error"], "invalid_json");

    // Not an admin.
    let res = a
        .call(
            Method::POST,
            "/api/dvr/recordings",
            Some(("plex:7", "user")),
            &[],
            &valid_body(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn post_refuses_an_overlap_on_the_same_channel_but_not_back_to_back() {
    let a = app().await;
    assert_eq!(a.post(&valid_body()).await.status, StatusCode::CREATED);
    let clash = a
        .post(&body(
            42,
            "2099-01-01T10:30:00.000Z",
            "2099-01-01T12:00:00.000Z",
        ))
        .await;
    assert_eq!(clash.status, StatusCode::BAD_REQUEST);
    assert_eq!(clash.json()["error"], "channel_overlap");
    let next_up = a
        .post(&body(42, FUTURE_STOP, "2099-01-01T12:00:00.000Z"))
        .await;
    assert_eq!(next_up.status, StatusCode::CREATED);
    let other_channel = a.post(&body(99, FUTURE_START, FUTURE_STOP)).await;
    assert_eq!(other_channel.status, StatusCode::CREATED);
}

#[tokio::test]
async fn post_may_overlap_a_cancelled_or_completed_recording() {
    let a = app().await;
    let first = a.post(&valid_body()).await.json();
    let id = first["recording"]["id"].as_str().unwrap();
    a.admin(Method::DELETE, &format!("/api/dvr/recordings/{id}"), "")
        .await;
    let done = schedule(&a.pool, &input(42.0, FUTURE_START, FUTURE_STOP), Utc::now())
        .await
        .unwrap();
    mark_status(&a.pool, &done.id, "completed", None, None, Utc::now())
        .await
        .unwrap();
    assert_eq!(a.post(&valid_body()).await.status, StatusCode::CREATED);
}

#[tokio::test]
async fn get_lists_and_fetches_one_or_404s() {
    let a = app().await;
    let created = a.post(&valid_body()).await.json();
    let list = a.get("/api/dvr/recordings").await;
    assert_eq!(list.json()["recordings"].as_array().unwrap().len(), 1);
    let id = created["recording"]["id"].as_str().unwrap();
    let one = a.get(&format!("/api/dvr/recordings/{id}")).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.json()["recording"]["id"], id);
    let missing = a.get("/api/dvr/recordings/nope").await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.json()["error"], "not_found");
}

#[tokio::test]
async fn delete_cancels_scheduled_and_404s_unknown() {
    let a = app().await;
    let created = a.post(&valid_body()).await.json();
    let id = created["recording"]["id"].as_str().unwrap();
    let del = a
        .admin(Method::DELETE, &format!("/api/dvr/recordings/{id}"), "")
        .await;
    assert_eq!(del.json()["status"], "cancelled");
    let gone = a
        .admin(Method::DELETE, "/api/dvr/recordings/nope", "")
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_of_an_in_flight_recording_stops_ffmpeg_and_removes_the_partial() {
    let a = app().await;
    let rec = a.state.dvr.clone().unwrap();
    let row = schedule(
        &a.pool,
        &input(42.0, "2000-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"),
        Utc::now(),
    )
    .await
    .unwrap();
    tick(&a.pool, &rec, Utc::now()).await.unwrap();
    assert_eq!(status(&a.pool, &row.id).await.status, "recording");
    let file = rec.file_path_for(&row.id);
    wait_for(|| file.exists()).await;
    assert!(!a.stub.argv().is_empty());

    let del = a
        .admin(
            Method::DELETE,
            &format!("/api/dvr/recordings/{}", row.id),
            "",
        )
        .await;
    assert_eq!(del.json()["status"], "cancelled");
    wait_for(|| !rec.running().contains(&row.id)).await;
    assert!(!file.exists());
    assert!(!a.state.streams.tracker.has(&record_session_id(&row.id)));
}

#[tokio::test]
async fn delete_of_a_completed_recording_removes_the_file() {
    let a = app().await;
    let (id, file) = a.completed(1000).await;
    let del = a
        .admin(Method::DELETE, &format!("/api/dvr/recordings/{id}"), "")
        .await;
    assert_eq!(del.json()["status"], "deleted");
    assert!(!file.exists());
}

#[tokio::test]
async fn delete_and_post_429_past_the_mutate_bucket() {
    let a = app().await;
    let cap = a.state.config.arr_mutate_rate_capacity as usize;
    let mut statuses = Vec::new();
    for _ in 0..=cap {
        statuses.push(
            a.admin(Method::DELETE, "/api/dvr/recordings/nope", "")
                .await
                .status,
        );
    }
    assert!(
        statuses[..cap]
            .iter()
            .all(|s| *s != StatusCode::TOO_MANY_REQUESTS)
    );
    assert_eq!(statuses[cap], StatusCode::TOO_MANY_REQUESTS);

    let a = app().await;
    let mut last = None;
    for i in 0..=cap {
        // Distinct channels so the overlap gate never answers first.
        let res = a
            .post(&body(1000 + i as i64, FUTURE_START, FUTURE_STOP))
            .await;
        if i < cap {
            assert_ne!(res.status, StatusCode::TOO_MANY_REQUESTS);
        }
        last = Some(res);
    }
    let last = last.unwrap();
    assert_eq!(last.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(last.json()["error"], "rate_limited");
    assert!(last.headers.contains_key(header::RETRY_AFTER));
    // The limiter refused before the handler: nothing extra was scheduled.
    let listed = a.get("/api/dvr/recordings").await.json();
    assert_eq!(listed["recordings"].as_array().unwrap().len(), cap);
}

#[tokio::test]
async fn play_404s_until_completed_and_when_the_file_is_missing() {
    let a = app().await;
    let r = schedule(&a.pool, &input(42.0, FUTURE_START, FUTURE_STOP), Utc::now())
        .await
        .unwrap();
    let res = a.play(&r.id, None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.json()["error"], "not_ready");
    let gone = a.dir.path().join("gone.ts");
    mark_status(
        &a.pool,
        &r.id,
        "completed",
        Some(gone.to_str().unwrap()),
        None,
        Utc::now(),
    )
    .await
    .unwrap();
    let res = a.play(&r.id, None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.json()["error"], "file_missing");
}

#[tokio::test]
async fn play_serves_full_ranged_and_unsatisfiable() {
    let a = app().await;
    let (id, _) = a.completed(1000).await;
    let full = a.play(&id, None).await;
    assert_eq!(full.status, StatusCode::OK);
    assert_eq!(full.header("content-length"), "1000");
    assert_eq!(full.header("accept-ranges"), "bytes");
    assert_eq!(full.header("content-type"), "video/mp2t");
    assert_eq!(full.body.len(), 1000);

    let ranged = a.play(&id, Some("bytes=0-99")).await;
    assert_eq!(ranged.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(ranged.header("content-range"), "bytes 0-99/1000");
    assert_eq!(ranged.header("content-length"), "100");
    assert_eq!(ranged.body.len(), 100);

    let bad = a.play(&id, Some("bytes=5000-6000")).await;
    assert_eq!(bad.status, StatusCode::RANGE_NOT_SATISFIABLE);
}

#[tokio::test]
async fn play_honours_suffix_open_ended_and_past_eof_ranges() {
    let a = app().await;
    let file = a.dir.path().join("ranges.ts");
    // Distinct bytes, so the served slice can be checked, not just its length.
    std::fs::write(
        &file,
        (0..1000u32).map(|i| (i % 251) as u8).collect::<Vec<_>>(),
    )
    .unwrap();
    let r = schedule(&a.pool, &input(42.0, FUTURE_START, FUTURE_STOP), Utc::now())
        .await
        .unwrap();
    mark_status(
        &a.pool,
        &r.id,
        "completed",
        Some(file.to_str().unwrap()),
        None,
        Utc::now(),
    )
    .await
    .unwrap();
    let expect = |res: &Res, status: StatusCode, range: &str| {
        assert_eq!(res.status, status);
        assert_eq!(res.header("content-range"), range);
    };
    let suffix = a.play(&r.id, Some("bytes=-100")).await;
    expect(&suffix, StatusCode::PARTIAL_CONTENT, "bytes 900-999/1000");
    assert_eq!(suffix.header("content-length"), "100");
    let want: Vec<u8> = (900..1000u32).map(|i| (i % 251) as u8).collect();
    assert_eq!(suffix.body.as_ref(), want.as_slice());

    let big = a.play(&r.id, Some("bytes=-5000")).await;
    expect(&big, StatusCode::PARTIAL_CONTENT, "bytes 0-999/1000");
    let zero = a.play(&r.id, Some("bytes=-0")).await;
    expect(&zero, StatusCode::RANGE_NOT_SATISFIABLE, "bytes */1000");
    let past_eof = a.play(&r.id, Some("bytes=900-999999")).await;
    expect(&past_eof, StatusCode::PARTIAL_CONTENT, "bytes 900-999/1000");
    assert_eq!(past_eof.header("content-length"), "100");
    let open = a.play(&r.id, Some("bytes=900-")).await;
    expect(&open, StatusCode::PARTIAL_CONTENT, "bytes 900-999/1000");
    let at_eof = a.play(&r.id, Some("bytes=1000-")).await;
    expect(&at_eof, StatusCode::RANGE_NOT_SATISFIABLE, "bytes */1000");
    for bogus in ["bytes=-", "bytes=abc-def", "chunks=0-9"] {
        let res = a.play(&r.id, Some(bogus)).await;
        assert_eq!(res.status, StatusCode::OK, "{bogus}");
        assert_eq!(res.header("content-length"), "1000");
    }
}

// ---- grant + token play -------------------------------------------------------------

fn mint(kind: StreamKind, rid: &str) -> String {
    crate::playlist::sign(&"s".repeat(40), kind, rid, "plex:42", 60, None)
}

#[tokio::test]
async fn grant_mints_a_recording_token_bound_to_the_id_and_caller() {
    let a = app().await;
    let (id, _) = a.completed(1000).await;
    let res = a
        .call(
            Method::POST,
            &format!("/api/dvr/recordings/{id}/grant"),
            Some(("plex:42", "user")),
            &[],
            "",
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let b = res.json();
    assert_eq!(b["delivery"], "progressive");
    assert_eq!(b["mime"], "video/mp2t");
    let url = b["url"].as_str().unwrap();
    let prefix = format!("/api/dvr/recordings/{id}/play?t=");
    assert!(url.starts_with(&prefix), "{url}");
    let c = crate::playlist::verify(&"s".repeat(40), &url[prefix.len()..]).unwrap();
    assert_eq!(c.k, StreamKind::Recording);
    assert_eq!(c.rid, id);
    assert_eq!(c.sub, "plex:42");
    // The on-demand TTL, not the 300 s live one.
    assert_eq!(
        c.exp - c.iat,
        a.state.config.iptv_ondemand_token_ttl_secs as i64
    );
    assert!(c.exp - c.iat > 300);
}

#[tokio::test]
async fn grant_404s_missing_or_not_completed() {
    let a = app().await;
    let grant = |id: String| {
        let a = &a;
        async move {
            a.call(
                Method::POST,
                &format!("/api/dvr/recordings/{id}/grant"),
                Some(("plex:42", "user")),
                &[],
                "",
            )
            .await
        }
    };
    let missing = grant("nope".into()).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    let r = schedule(&a.pool, &input(42.0, FUTURE_START, FUTURE_STOP), Utc::now())
        .await
        .unwrap();
    let not_ready = grant(r.id).await;
    assert_eq!(not_ready.status, StatusCode::NOT_FOUND);
    assert_eq!(not_ready.json()["error"], "not_ready");
}

#[tokio::test]
async fn play_takes_a_recording_token_without_a_principal_and_401s_without_either() {
    // Off posture: nothing forwards a principal, as for a cookieless client.
    let a = app_with("off", "1").await;
    let (id, _) = a.completed(1000).await;
    let uri = format!("/api/dvr/recordings/{id}/play");
    let none = a.call(Method::GET, &uri, None, &[], "").await;
    assert_eq!(none.status, StatusCode::UNAUTHORIZED);

    let tok = mint(StreamKind::Recording, &id);
    let full = a
        .call(Method::GET, &format!("{uri}?t={tok}"), None, &[], "")
        .await;
    assert_eq!(full.status, StatusCode::OK);
    assert_eq!(full.header("content-length"), "1000");
    assert_eq!(full.header("accept-ranges"), "bytes");
    let ranged = a
        .call(
            Method::GET,
            &format!("{uri}?t={tok}"),
            None,
            &[("range", "bytes=0-99")],
            "",
        )
        .await;
    assert_eq!(ranged.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(ranged.header("content-range"), "bytes 0-99/1000");
    assert_eq!(ranged.header("content-length"), "100");
}

#[tokio::test]
async fn play_rejects_a_token_for_another_recording_or_kind_and_a_malformed_one() {
    let a = app_with("off", "1").await;
    let (id, _) = a.completed(1000).await;
    let play = |t: String| {
        let a = &a;
        let uri = format!("/api/dvr/recordings/{id}/play?t={t}");
        async move { a.call(Method::GET, &uri, None, &[], "").await }
    };
    let other = play(mint(StreamKind::Recording, "some-other-id")).await;
    assert_eq!(other.status, StatusCode::UNAUTHORIZED);
    assert_eq!(other.json()["error"], "token_mismatch");
    let vod = play(mint(StreamKind::Vod, &id)).await;
    assert_eq!(vod.status, StatusCode::UNAUTHORIZED);
    assert_eq!(vod.json()["error"], "token_mismatch");
    let junk = play("not-a-real-token".into()).await;
    assert_eq!(junk.status, StatusCode::UNAUTHORIZED);
    assert_eq!(junk.json()["error"], "invalid_token");
}
