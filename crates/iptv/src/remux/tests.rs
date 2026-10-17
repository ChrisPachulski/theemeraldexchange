//! iptvRemux.test.ts carried over. ffmpeg is a shell stub (`Fake`) that logs
//! its argv and runs a scripted behaviour, so the argv, watchdogs, relaunch,
//! dead-feed and cap paths run with no real ffmpeg and no network.

use super::*;
use crate::concurrency::{Acquire, Kind};
use crate::config::test_config;
use std::os::unix::fs::PermissionsExt;

/// Runs until SIGTERM, then exits 0 like ffmpeg finalizing its muxer. Each
/// SIGTERM leaves a `term.<pid>` file in the control dir.
pub(crate) const LIVE: &str = r#"trap 'touch "$c/term.$$"; kill $! 2>/dev/null; exit 0' TERM
sleep 20 >/dev/null 2>&1 &
wait
"#;

/// Writes a four-segment playlist, then runs like LIVE.
pub(crate) const SEGS: &str = r#"for i in 0 1 2 3; do printf 'seg%s' "$i" > "seg_0000$i.ts"; done
printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-DISCONTINUITY\n#EXTINF:2.0,\nseg_00000.ts\n#EXTINF:2.0,\nseg_00001.ts\n#EXTINF:2.0,\nseg_00002.ts\n#EXTINF:2.0,\nseg_00003.ts\n' > index.m3u8
"#;

/// Exits 0 a beat after SIGTERM, so a test can watch it drain.
const SLOW_TERM: &str = r#"trap 'kill $! 2>/dev/null; sleep 0.3; exit 0' TERM
sleep 20 >/dev/null 2>&1 &
wait
"#;

const OUTPUT: &str = "echo \"Output #0, hls, to 'index.m3u8':\" >&2\n";

/// A stub ffmpeg in a temp dir. `run` is sourced on a session's first launch,
/// `again` (when set) on its relaunches. `$c` is the control dir.
pub(crate) struct Fake {
    pub dir: tempfile::TempDir,
}

impl Fake {
    pub fn new(run: &str) -> Fake {
        let dir = tempfile::tempdir().unwrap();
        let c = dir.path().join("ctl");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::create_dir_all(dir.path().join("tmp")).unwrap();
        std::fs::write(c.join("run"), run).unwrap();
        let bin = dir.path().join("ffmpeg");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\n[ \"$1\" = --probe ] && exit 0\nc='{}'\n\
                 for a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"$c/argv.$$\"\n\
                 echo $$ >> \"$c/order\"\n\
                 pwd -P > \"$c/cwd.$$\"\n\
                 if [ -f .launched ] && [ -f \"$c/again\" ]; then . \"$c/again\"; else touch .launched; . \"$c/run\"; fi\n",
                c.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Linux: a thread forking while the stub was open for writing makes
        // exec fail ETXTBSY until that child execs. One clean exec settles it.
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
        Fake { dir }
    }

    pub fn again(&self, snippet: &str) {
        std::fs::write(self.ctl().join("again"), snippet).unwrap();
    }

    fn ctl(&self) -> PathBuf {
        self.dir.path().join("ctl")
    }

    pub fn pids(&self) -> Vec<String> {
        std::fs::read_to_string(self.ctl().join("order"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    /// Every launch's argv, in launch order.
    pub fn argvs(&self) -> Vec<Vec<String>> {
        self.pids()
            .iter()
            .map(|p| {
                std::fs::read_to_string(self.ctl().join(format!("argv.{p}")))
                    .unwrap_or_default()
                    .lines()
                    .map(String::from)
                    .collect()
            })
            .collect()
    }

    pub fn cwd(&self, pid: &str) -> String {
        std::fs::read_to_string(self.ctl().join(format!("cwd.{pid}")))
            .unwrap()
            .trim()
            .into()
    }

    pub fn terms(&self) -> usize {
        std::fs::read_dir(self.ctl())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("term.")
            })
            .count()
    }

    pub fn pairs(&self) -> Vec<(String, String)> {
        vec![
            (
                "IPTV_FFMPEG_BIN".into(),
                self.dir.path().join("ffmpeg").display().to_string(),
            ),
            (
                "IPTV_REMUX_TMP_DIR".into(),
                self.dir.path().join("tmp").display().to_string(),
            ),
        ]
    }
}

/// Polls `cond` every 20 ms; panics after 5 s.
pub(crate) async fn until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub(crate) struct R {
    pub remux: Remux,
    pub tracker: Arc<Tracker>,
    pub dead: Arc<DeadFeeds>,
    pub fake: Fake,
}

/// Creds testuser/secret123, a cap of 10 unless `extra` lowers it.
pub(crate) fn remux_with(fake: Fake, extra: &[(&str, &str)], t: Timings) -> R {
    let pairs = fake.pairs();
    let mut all: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    all.extend([
        ("XTREAM_HOST", "http://127.0.0.1:9"),
        ("XTREAM_USERNAME", "testuser"),
        ("XTREAM_PASSWORD", "secret123"),
        ("IPTV_MAX_UPSTREAM_CONNECTIONS", "10"),
    ]);
    all.extend_from_slice(extra);
    let config = test_config(&all);
    let tracker = Arc::new(Tracker::new(10, 30_000));
    let dead = Arc::new(DeadFeeds::default());
    let egress = Egress::start(&config.xtream_host);
    let remux = Remux::with_timings(&config, tracker.clone(), dead.clone(), egress, t);
    R {
        remux,
        tracker,
        dead,
        fake,
    }
}

fn r(run: &str) -> R {
    remux_with(Fake::new(run), &[], Timings::default())
}

/// Relaunches allowed at once (the floor is 0).
fn proven() -> Timings {
    Timings {
        relaunch_floor: Duration::ZERO,
        ..Timings::default()
    }
}

impl R {
    fn start(&self, stream_id: &str, sub: &str) -> Option<Started> {
        self.remux
            .start(stream_id, sub, "https://x/y.ts", false)
            .unwrap()
    }
    fn ids(&self) -> Vec<String> {
        self.remux
            .list()
            .into_iter()
            .map(|s| s.session_id)
            .collect()
    }
    async fn launched(&self, n: usize) {
        until(&format!("{n} launches"), || {
            self.fake.argvs().iter().filter(|a| !a.is_empty()).count() >= n
        })
        .await;
        // The argv is logged before the scripted behaviour (and its trap) runs.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    async fn gone(&self, id: &str) {
        until("session gone", || !self.remux.is_active(id)).await;
    }
}

fn flag<'a>(argv: &'a [String], name: &str) -> &'a str {
    let i = argv.iter().position(|a| a == name).unwrap();
    &argv[i + 1]
}

#[tokio::test]
async fn starting_polling_and_stopping_each_count_as_viewer_activity() {
    let r = r(LIVE);
    let t0 = r.remux.last_viewer_activity();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let s = r.start("11", "plex:test").unwrap();
    let t1 = r.remux.last_viewer_activity();
    assert!(t1 > t0);
    tokio::time::sleep(Duration::from_millis(5)).await;
    r.remux.heartbeat(&s.session_id);
    let t2 = r.remux.last_viewer_activity();
    assert!(t2 > t1);
    tokio::time::sleep(Duration::from_millis(5)).await;
    r.remux.stop(&s.session_id, "manual");
    assert!(r.remux.last_viewer_activity() > t2);
}

#[tokio::test]
async fn the_copy_argv_is_exact_and_runs_in_the_session_dir() {
    let r = r(LIVE);
    let s = r.start("10", "plex:test").unwrap();
    assert!(
        s.session_id.starts_with("remux:10:plex_test:"),
        "{}",
        s.session_id
    );
    assert!(s.manifest_path.ends_with("index.m3u8"));
    r.launched(1).await;
    let proxy = r.remux.0.egress.proxy_args().unwrap()[1].clone();
    let expected: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostats",
        "-nostdin",
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto,httpproxy",
        "-http_proxy",
        &proxy,
        "-fflags",
        "+discardcorrupt+genpts+igndts",
        "-probesize",
        "10M",
        "-analyzeduration",
        "10M",
        "-rw_timeout",
        "15000000",
        "-user_agent",
        "IPTVSmarters",
        "-i",
        "https://x/y.ts",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-b:a",
        "160k",
        "-avoid_negative_ts",
        "make_zero",
        "-max_muxing_queue_size",
        "1024",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_list_size",
        "40",
        "-hls_flags",
        "delete_segments+append_list+omit_endlist",
        "-hls_segment_filename",
        "seg_%05d.ts",
        &s.manifest_path.display().to_string(),
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(r.fake.argvs()[0], expected);
    let pid = r.fake.pids()[0].clone();
    assert_eq!(
        r.fake.cwd(&pid),
        std::fs::canonicalize(&s.dir).unwrap().display().to_string()
    );
}

#[tokio::test]
async fn reencode_uses_libx264_with_the_env_governed_preset_threads_and_height() {
    let r = remux_with(
        Fake::new(LIVE),
        &[
            ("IPTV_REENCODE_PRESET", "ultrafast"),
            ("IPTV_REENCODE_THREADS", "3"),
            ("IPTV_REENCODE_MAX_HEIGHT", "720"),
        ],
        Timings::default(),
    );
    r.remux
        .start("51", "plex:test", "https://x/z.ts", true)
        .unwrap();
    r.launched(1).await;
    let argv = &r.fake.argvs()[0];
    let at = argv.iter().position(|a| a == "-c:v").unwrap();
    assert_eq!(
        argv[at..at + 14],
        [
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "48",
            "-force_key_frames",
            "expr:gte(t,n_forced*2)",
            "-threads",
            "3",
            "-vf",
            "scale=-2:min(720\\,ih)",
        ]
    );
    assert!(!argv.contains(&"copy".to_string()));
}

#[tokio::test]
async fn a_non_h264_input_marks_the_channel_and_kills_the_copy_session() {
    let r = r(&format!(
        "echo '  Stream #0:0[0x100]: Video: hevc (Main), yuv420p(tv), 1920x1080' >&2\n{LIVE}"
    ));
    assert!(!r.remux.needs_reencode("60"));
    let s = r.start("60", "plex:test").unwrap();
    r.gone(&s.session_id).await;
    assert!(r.remux.needs_reencode("60"));
    assert_eq!(r.fake.terms(), 0, "SIGKILL, not SIGTERM");
    assert!(!r.dead.is_dead("60"));
    assert_eq!(r.fake.argvs().len(), 1, "no in-place relaunch");
}

#[tokio::test]
async fn an_h264_input_stays_on_the_copy_path() {
    let r = r(&format!(
        "echo '  Stream #0:0[0x100]: Video: h264 (High), yuv420p, 1920x1080' >&2\n{LIVE}"
    ));
    let s = r.start("61", "plex:test").unwrap();
    r.launched(1).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(r.remux.is_active(&s.session_id));
    assert!(!r.remux.needs_reencode("61"));
}

fn storm_lines(n: u32) -> String {
    let line = "[aist#0:1/aac @ 0x1] timestamp discontinuity (stream id=257): -170333, new offset= -92290242500";
    (0..n).map(|_| format!("echo '{line}' >&2\n")).collect()
}

#[tokio::test]
async fn a_storm_on_a_proven_dial_relaunches_in_place_with_discont_start() {
    let fake = Fake::new(&format!("{OUTPUT}{}{LIVE}", storm_lines(TS_STORM_LINES)));
    fake.again(LIVE);
    let r = remux_with(fake, &[], proven());
    let s = r.start("61", "plex:test").unwrap();
    r.launched(2).await;
    let argvs = r.fake.argvs();
    assert_eq!(
        flag(&argvs[0], "-hls_flags"),
        "delete_segments+append_list+omit_endlist"
    );
    assert_eq!(
        flag(&argvs[1], "-hls_flags"),
        "delete_segments+append_list+omit_endlist+discont_start"
    );
    assert_eq!(
        argvs[1].last().unwrap(),
        &s.manifest_path.display().to_string()
    );
    let pids = r.fake.pids();
    assert_eq!(r.fake.cwd(&pids[0]), r.fake.cwd(&pids[1]));
    // Our kill, not a provider EOF: no strike, same session, dir kept.
    assert!(!r.dead.is_dead("61"));
    assert_eq!(r.ids(), vec![s.session_id.clone()]);
    assert!(s.dir.exists());
    // The relaunched child is the session's child now: a stop reaches it.
    r.remux.stop(&s.session_id, "manual");
    until("the relaunched child got SIGTERM", || r.fake.terms() == 1).await;
}

#[tokio::test]
async fn a_storm_on_a_young_dial_ends_the_session() {
    let r = r(&format!("{}{LIVE}", storm_lines(TS_STORM_LINES)));
    let s = r.start("62", "plex:test").unwrap();
    r.gone(&s.session_id).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(r.fake.argvs().len(), 1);
    until("dir removed", || !s.dir.exists()).await;
}

#[tokio::test]
async fn one_jump_over_an_hour_relaunches_in_place() {
    let fake = Fake::new(&format!(
        "{OUTPUT}echo '[vist#0:0/h264 @ 0x1] timestamp discontinuity (stream id=256): 300000000, new offset= -300000000' >&2\n\
         echo '[vist#0:0/h264 @ 0x1] timestamp discontinuity (stream id=256): -551098765432, new offset= 551098765432' >&2\n{LIVE}"
    ));
    fake.again(LIVE);
    let r = remux_with(fake, &[], proven());
    let s = r.start("63", "plex:test").unwrap();
    r.launched(2).await;
    assert!(!r.dead.is_dead("63"));
    assert_eq!(r.ids(), vec![s.session_id]);
    assert_eq!(
        flag(&r.fake.argvs()[1], "-hls_flags"),
        "delete_segments+append_list+omit_endlist+discont_start"
    );
}

#[tokio::test]
async fn a_muxer_that_stops_cutting_segments_is_relaunched_in_place() {
    let segs: String = (1..=3)
        .map(|i| {
            format!("echo \"[hls @ 0x1] Opening 'seg_0000{i}.ts' for writing\" >&2\nsleep 0.1\n")
        })
        .collect();
    let fake = Fake::new(&format!("{OUTPUT}{segs}{LIVE}"));
    fake.again(LIVE);
    let t = Timings {
        stall: Duration::from_millis(400),
        ..proven()
    };
    let r = remux_with(fake, &[], t);
    let s = r.start("64", "plex:test").unwrap();
    r.launched(2).await;
    assert_eq!(r.ids(), vec![s.session_id.clone()]);
    // The relaunch cut no segment, so its watchdog never armed: no third launch.
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(r.fake.argvs().len(), 2);
}

#[test]
fn the_probe_counts_a_storm_inside_its_window_and_one_jump_over_an_hour() {
    let now = Instant::now();
    let w = Duration::from_secs(10);
    let line = "x timestamp discontinuity (stream id=257): -170333, new offset= -1";
    let mut p = Probe::new(false, w);
    for _ in 0..TS_STORM_LINES - 1 {
        assert_eq!(p.line(line, now), Verdict::Log { arm_stall: false });
    }
    // The window lapsed: the count restarts instead of tripping.
    let later = now + w + Duration::from_millis(1);
    for _ in 0..TS_STORM_LINES - 1 {
        assert_eq!(p.line(line, later), Verdict::Log { arm_stall: false });
    }
    assert!(
        matches!(p.line(line, later), Verdict::Kill(r) if r.starts_with("timestamp-discontinuity storm"))
    );

    let mut p = Probe::new(false, w);
    let jump = |us: &str| format!("x timestamp discontinuity (stream id=256): {us}, new offset= 1");
    assert_eq!(
        p.line(&jump("3600000000"), now),
        Verdict::Log { arm_stall: false }
    );
    assert!(
        matches!(p.line(&jump("-3600000001"), now), Verdict::Kill(r) if r.contains("over an hour"))
    );
}

#[test]
fn the_probe_reads_only_the_input_codec_of_a_copy_session() {
    let now = Instant::now();
    let hevc = "  Stream #0:0[0x100]: Video: hevc (Main), yuv420p";
    let mut p = Probe::new(false, Duration::from_secs(10));
    assert_eq!(
        p.line("Output #0, hls, to 'x':", now),
        Verdict::Log { arm_stall: false }
    );
    assert_eq!(p.line(hevc, now), Verdict::Log { arm_stall: false });
    let mut p = Probe::new(true, Duration::from_secs(10));
    assert_eq!(p.line(hevc, now), Verdict::Log { arm_stall: false });
    let mut p = Probe::new(false, Duration::from_secs(10));
    assert_eq!(p.line(hevc, now), Verdict::Reencode("hevc".into()));
    let mut p = Probe::new(false, Duration::from_secs(10));
    assert_eq!(
        p.line("Stream #0:0: Video: AVC", now),
        Verdict::Log { arm_stall: false }
    );
    assert_eq!(
        p.line(hevc, now),
        Verdict::Log { arm_stall: false },
        "decided once"
    );
    assert_eq!(
        p.line("[hls @ 0x1] Opening '/tmp/a/seg_00012.ts' for writing", now),
        Verdict::Log { arm_stall: true }
    );
}

#[tokio::test]
async fn heartbeat_extends_and_stop_removes() {
    let r = r(LIVE);
    let s = r.start("10", "plex:test").unwrap();
    let before = r.remux.list()[0].last_seen;
    tokio::time::sleep(Duration::from_millis(5)).await;
    r.remux.heartbeat(&s.session_id);
    assert!(r.remux.list()[0].last_seen > before);
    r.remux.stop(&s.session_id, "manual");
    assert!(r.ids().is_empty());
}

#[tokio::test]
async fn an_exit_removes_the_session_and_its_dir() {
    let r = r("exit 3\n");
    let s = r.start("11", "plex:test").unwrap();
    r.gone(&s.session_id).await;
    until("dir removed", || !s.dir.exists()).await;
}

#[tokio::test]
async fn a_feed_is_tagged_dead_on_the_second_fast_clean_eof_not_the_first() {
    let r = r("exit 0\n");
    let a = r.start("70", "plex:test").unwrap();
    r.gone(&a.session_id).await;
    assert!(
        !r.dead.is_dead("70"),
        "one fast clean EOF may be a provider kick"
    );
    let b = r.start("70", "plex:test").unwrap();
    r.gone(&b.session_id).await;
    until("tagged dead", || r.dead.is_dead("70")).await;
}

#[tokio::test]
async fn corrupt_exits_and_our_own_kills_are_not_dead_feeds() {
    for (script, id) in [("exit 255\n", "71"), ("kill -KILL $$\n", "72")] {
        let r = r(script);
        for _ in 0..2 {
            let s = r.start(id, "plex:test").unwrap();
            r.gone(&s.session_id).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!r.dead.is_dead(id), "{script}");
    }
}

#[tokio::test]
async fn a_graceful_exit_0_from_our_own_sigterm_is_never_a_strike() {
    let r = r(LIVE);
    for i in 1..=2 {
        let s = r.start("75", "plex:test").unwrap();
        r.launched(i).await;
        let terms = r.fake.terms();
        r.remux.stop(&s.session_id, "forget");
        until("exited", || {
            r.fake.terms() > terms && r.remux.draining_count() == 0
        })
        .await;
    }
    assert!(!r.dead.is_dead("75"));
}

#[tokio::test]
async fn a_clean_exit_after_a_long_healthy_run_is_not_a_dead_feed() {
    let t = Timings {
        dead_lifetime: Duration::ZERO,
        ..Timings::default()
    };
    let r = remux_with(Fake::new("exit 0\n"), &[], t);
    for _ in 0..2 {
        let s = r.start("73", "plex:test").unwrap();
        r.gone(&s.session_id).await;
    }
    assert!(!r.dead.is_dead("73"));
}

#[tokio::test(start_paused = true)]
async fn every_sibling_of_an_all_dead_channel_is_remembered_across_a_four_feed_walk() {
    // Each feed plays a ~30 s slate then EOFs cleanly; two passes (strike,
    // then tag) take ~240 s. When the last one is tagged, the first must
    // still be remembered or the offline answer never fires.
    let dead = DeadFeeds::default();
    let siblings = ["201", "202", "203", "204"];
    for _ in 0..2 {
        for sid in siblings {
            tokio::time::advance(Duration::from_secs(30)).await;
            dead.strike(sid);
        }
    }
    for sid in siblings {
        assert!(dead.is_dead(sid), "{sid}");
    }
}

#[tokio::test]
async fn drain_waits_for_every_child_to_exit_after_releasing_its_entry() {
    let r = r(SLOW_TERM);
    r.start("20", "plex:a").unwrap();
    r.start("21", "plex:b").unwrap();
    r.launched(2).await;
    let t0 = Instant::now();
    r.remux.drain(Duration::from_secs(2)).await;
    assert!(r.ids().is_empty());
    assert_eq!(r.remux.draining_count(), 0);
    assert!(
        t0.elapsed() >= Duration::from_millis(250),
        "returned before the children exited"
    );
}

#[tokio::test]
async fn drain_also_waits_for_children_stopped_before_it_began() {
    let r = r(SLOW_TERM);
    let s = r.start("23", "plex:a").unwrap();
    r.launched(1).await;
    r.remux.stop(&s.session_id, "manual");
    assert_eq!(r.remux.draining_count(), 1);
    r.remux.drain(Duration::from_secs(2)).await;
    assert_eq!(r.remux.draining_count(), 0);
}

#[tokio::test]
async fn drain_is_a_no_op_with_no_sessions() {
    let r = r(LIVE);
    let t0 = Instant::now();
    r.remux.drain(Duration::from_secs(2)).await;
    assert!(t0.elapsed() < Duration::from_millis(100));
}

#[tokio::test]
async fn at_capacity_a_new_viewer_is_refused_and_buffered_streams_are_kept() {
    let r = remux_with(
        Fake::new(LIVE),
        &[("IPTV_MAX_UPSTREAM_CONNECTIONS", "2")],
        Timings::default(),
    );
    let a = r.start("24", "plex:a").unwrap();
    let b = r.start("25", "plex:b").unwrap();
    r.launched(2).await;
    // Silent 80 s: a buffered player, not an abandoned one.
    r.remux.backdate(&a.session_id, Duration::from_secs(80));
    assert!(r.start("26", "plex:c").is_none());
    let mut ids = r.ids();
    ids.sort();
    let mut want = vec![a.session_id, b.session_id];
    want.sort();
    assert_eq!(ids, want);
    assert_eq!(r.remux.draining_count(), 0);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(r.fake.argvs().len(), 2);
    assert_eq!(r.fake.terms(), 0);
}

#[tokio::test]
async fn a_dvr_reservation_plus_a_draining_remux_leave_no_slot() {
    let r = remux_with(
        Fake::new(SLOW_TERM),
        &[("IPTV_MAX_UPSTREAM_CONNECTIONS", "2")],
        Timings::default(),
    );
    r.tracker
        .try_acquire(Acquire {
            sub: "dvr:1".into(),
            session_id: "recording".into(),
            kind: Kind::Live,
            resource_id: "27".into(),
            ip: None,
            title: None,
            kind_cap: None,
            replace_live: false,
        })
        .unwrap();
    let old = r.start("28", "plex:a").unwrap();
    r.launched(1).await;
    r.remux.stop(&old.session_id, "manual");
    assert!(r.start("29", "plex:a").is_none());
    assert_eq!(r.fake.argvs().len(), 1);
    until("the old child exited", || r.remux.draining_count() == 0).await;
    assert!(r.start("29", "plex:a").is_some());
}

#[tokio::test]
async fn at_capacity_only_an_idle_session_is_reclaimed_and_the_dial_waits_for_its_exit() {
    let r = remux_with(
        Fake::new(SLOW_TERM),
        &[("IPTV_MAX_UPSTREAM_CONNECTIONS", "2")],
        Timings::default(),
    );
    let a = r.start("40", "plex:a").unwrap();
    let b = r.start("41", "plex:b").unwrap();
    r.launched(2).await;
    r.remux.backdate(&a.session_id, Duration::from_secs(95));
    // Evicts a, but a still holds its socket: deferred, never cap+1.
    assert!(r.start("42", "plex:c").is_none());
    assert!(!r.remux.is_active(&a.session_id));
    assert_eq!(r.remux.draining_count(), 1);
    assert_eq!(r.remux.live_upstream_count(), 2);
    assert_eq!(r.fake.argvs().len(), 2);
    // A retry while a drains evicts nothing more.
    assert!(r.start("42", "plex:c").is_none());
    assert!(r.remux.is_active(&b.session_id));
    until("a exited", || r.remux.draining_count() == 0).await;
    let c = r.start("42", "plex:c").unwrap();
    r.launched(3).await;
    let ids = r.ids();
    assert!(ids.contains(&b.session_id) && ids.contains(&c.session_id));
    assert_eq!(r.remux.live_upstream_count(), 2);
}

#[tokio::test]
async fn the_idle_reap_stops_a_session_nobody_polls() {
    let t = Timings {
        sweep_every: Duration::from_millis(50),
        ..Timings::default()
    };
    let r = remux_with(Fake::new(LIVE), &[], t);
    let s = r.start("12", "plex:a").unwrap();
    r.launched(1).await;
    r.remux.backdate(&s.session_id, Duration::from_secs(80));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        r.remux.is_active(&s.session_id),
        "80 s of buffered silence is kept"
    );
    r.remux.backdate(&s.session_id, Duration::from_secs(11));
    r.gone(&s.session_id).await;
    until("SIGTERM", || r.fake.terms() == 1).await;
}

#[tokio::test]
async fn a_failed_spawn_registers_nothing_and_cleans_up() {
    let fake = Fake::new(LIVE);
    let mut pairs = fake.pairs();
    pairs[0].1 = fake.dir.path().join("missing-ffmpeg").display().to_string();
    let all: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let config = test_config(&all);
    let tracker = Arc::new(Tracker::new(10, 30_000));
    let remux = Remux::new(&config, tracker, Arc::default(), Egress::start(""));
    let s = remux
        .start("31", "plex:test", "https://x/y.ts", false)
        .unwrap()
        .unwrap();
    assert!(!remux.is_active(&s.session_id));
    assert!(!s.dir.exists());
}

#[tokio::test]
async fn non_http_and_malformed_upstreams_are_refused_before_any_spawn() {
    let r = r(LIVE);
    let e = r
        .remux
        .start("32", "p", "file:///etc/passwd", false)
        .unwrap_err();
    assert!(e.contains("protocol not allowed"), "{e}");
    let e = r.remux.start("33", "p", "not a url", false).unwrap_err();
    assert!(e.contains("not a valid URL"), "{e}");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(r.fake.pids().is_empty());
    assert!(r.ids().is_empty());
}

#[test]
fn scrub_redacts_path_and_query_creds_and_leaves_clean_lines() {
    let s = |l: &str| scrub(l, "testuser", "secret123");
    let out = s("https://iptv.example.com/live/testuser/secret123/1234.ts: Connection refused");
    assert!(!out.contains("secret123") && !out.contains("testuser"));
    assert!(out.contains("REDACTED") && out.contains("iptv.example.com"));
    assert!(out.contains("1234.ts") && out.contains("Connection refused"));

    let out = s(
        "GET https://iptv.example.com/player_api.php?username=testuser&password=secret123&action=get_live_streams failed",
    );
    assert!(!out.contains("secret123") && !out.contains("testuser"));
    assert!(out.contains("username=REDACTED") && out.contains("password=REDACTED"));
    assert!(out.contains("action=get_live_streams"));

    let clean = "[rtsp @ 0x7f] Retrying with TCP";
    assert_eq!(s(clean), clean);

    let out = s("https://other.host.com/live/someuser/somepass/99.ts: Timeout");
    assert!(out.contains("/REDACTED/REDACTED/"));
    assert!(!out.contains("someuser") && !out.contains("somepass"));

    // The percent-encoded form ffmpeg echoes for reserved characters.
    let out = scrub("http://h/x?a=p%40ss%2Fw", "u", "p@ss/w");
    assert!(!out.contains("p%40ss%2Fw"), "{out}");
}

#[cfg(feature = "requires-ffmpeg")]
mod real_ffmpeg {
    //! One remux through the real ffmpeg on PATH, dialing a loopback fake
    //! provider through the egress proxy. Gated: `--features requires-ffmpeg`.
    use super::*;

    #[tokio::test]
    async fn a_real_ffmpeg_remux_writes_a_playable_starting_window() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.ts");
        let made = tokio::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=25",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-t",
                "12",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-g",
                "25",
                "-c:a",
                "aac",
                "-f",
                "mpegts",
            ])
            .arg(&src)
            .status()
            .await
            .expect("ffmpeg on PATH");
        assert!(made.success());
        let bytes = std::fs::read(&src).unwrap();
        // Paced like a live feed: the whole 12 s file over ~3 s.
        let app = axum::Router::new().fallback(move || {
            let bytes = bytes.clone();
            async move {
                let chunks: Vec<Vec<u8>> = bytes.chunks(64 * 1024).map(<[u8]>::to_vec).collect();
                let pace = Duration::from_millis(3000 / chunks.len().max(1) as u64);
                axum::body::Body::from_stream(futures_util::stream::unfold(
                    chunks.into_iter(),
                    move |mut it| async move {
                        let c = it.next()?;
                        tokio::time::sleep(pace).await;
                        Some((Ok::<_, std::io::Error>(c), it))
                    },
                ))
            }
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let tmp = dir.path().join("tmp");
        let config = test_config(&[
            ("XTREAM_HOST", provider.as_str()),
            ("XTREAM_USERNAME", "u"),
            ("XTREAM_PASSWORD", "p"),
            ("IPTV_REMUX_TMP_DIR", tmp.to_str().unwrap()),
        ]);
        let remux = Remux::new(
            &config,
            Arc::new(Tracker::new(4, 30_000)),
            Arc::default(),
            Egress::start(&provider),
        );
        let s = remux
            .start(
                "1",
                "plex:real",
                &format!("{provider}/live/u/p/1.ts"),
                false,
            )
            .unwrap()
            .unwrap();
        until("a four-segment window", || {
            crate::remux_map::manifest_ready(&s.manifest_path, 4)
        })
        .await;
        let text = std::fs::read_to_string(&s.manifest_path).unwrap();
        assert!(text.contains("#EXT-X-MEDIA-SEQUENCE:0"), "{text}");
        assert!(s.dir.join("seg_00000.ts").metadata().unwrap().len() > 0);
        assert!(
            !remux.needs_reencode("1"),
            "h264 input stays on the copy path"
        );
    }
}
