//! Live remux for AVPlayer (iptvRemux.ts): one ffmpeg per viewer/channel turns
//! the provider's MPEG-TS into a 2 s sliding-window HLS playlist in a temp dir.
//! This is the single place a remux opens a provider connection, so the
//! upstream cap is enforced here: sessions, plus SIGTERMed children that still
//! hold their socket (draining), plus the tracker's raw live and DVR slots.
//!
//! Each child has one supervisor task that reads its stderr (codec probe,
//! timestamp storm and single-jump detectors, segment-stall watchdog), signals
//! it, and on exit tags dead feeds, relaunches in place or cleans up.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use regex::Regex;
use reqwest::Url;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::time::{Instant, sleep_until};

use crate::concurrency::{REMUX_IDLE_MS, Tracker};
use crate::config::Config;
use crate::egress::{Egress, FFMPEG_PROXIED_PROTOCOLS};
use crate::streams::{DEAD_FEED_CLEAN_EOF, DeadFeeds, UPSTREAM_USER_AGENT, encode_uri_component};

/// A channel seen serving non-H.264 video is re-encoded this long.
const REENCODE_MEMORY: Duration = Duration::from_secs(6 * 3600);
/// Discontinuity lines inside the storm window that mean the remux writes garbage.
pub const TS_STORM_LINES: u32 = 30;
/// One discontinuity bigger than this (microseconds, 1 h) freezes segment output.
pub const TS_JUMP_RELAUNCH_US: f64 = 3_600_000_000.0;

static VIDEO_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Stream #\d+:\d+.*: Video: (\w+)").unwrap());
static SEG_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Opening '[^']*seg_\d+\.ts' for writing").unwrap());
static JUMP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"timestamp discontinuity \(stream id=\d+\): (-?\d+)").unwrap());
static PATH_CREDS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(https?://[^/\s]+/[^/\s]+/)([^/\s]+)/([^/\s]+)/").unwrap());
static USER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([?&])username=[^&\s]*").unwrap());
static PASS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([?&])password=[^&\s]*").unwrap());

/// Watchdog and lifetime constants. Tests shorten them; prod uses `default()`.
#[derive(Clone, Copy)]
pub(crate) struct Timings {
    /// No new segment for this long after the first one is a wedged muxer.
    /// Provider burst gaps reach about 7.5 s.
    pub stall: Duration,
    /// A dial younger than this that faults is not relaunched; the session ends.
    pub relaunch_floor: Duration,
    pub storm_window: Duration,
    /// A clean EOF sooner than this is a dead-channel placeholder.
    pub dead_lifetime: Duration,
    /// SIGTERM, then SIGKILL after this.
    pub kill_grace: Duration,
    /// Past the 80 s window plus AVPlayer's buffered fetch gaps.
    pub idle: Duration,
    pub sweep_every: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            stall: Duration::from_secs(12),
            relaunch_floor: Duration::from_secs(20),
            storm_window: Duration::from_secs(10),
            dead_lifetime: DEAD_FEED_CLEAN_EOF,
            kill_grace: Duration::from_secs(5),
            idle: Duration::from_millis(REMUX_IDLE_MS),
            sweep_every: Duration::from_secs(5),
        }
    }
}

/// Redact the Xtream creds (literal and percent-encoded), path-style
/// `/live/<user>/<pass>/` segments and query-style creds from a log line.
pub fn scrub(line: &str, user: &str, pass: &str) -> String {
    let mut out = line.to_string();
    for v in [user, pass] {
        if v.is_empty() {
            continue;
        }
        out = out.replace(v, "REDACTED");
        let enc = encode_uri_component(v);
        if enc != v {
            out = out.replace(&enc, "REDACTED");
        }
    }
    let out = PATH_CREDS_RE.replace_all(&out, "${1}REDACTED/REDACTED/");
    let out = USER_RE.replace_all(&out, "${1}username=REDACTED");
    PASS_RE
        .replace_all(&out, "${1}password=REDACTED")
        .into_owned()
}

/// Only http(s) reaches ffmpeg's `-i`; pairs with `-protocol_whitelist`.
fn assert_http(upstream: &str) -> Result<(), String> {
    let u =
        Url::parse(upstream).map_err(|_| "remux upstream URL is not a valid URL".to_string())?;
    match u.scheme() {
        "http" | "https" => Ok(()),
        s => Err(format!("remux upstream protocol not allowed: {s}:")),
    }
}

fn safe_id_part(v: &str) -> String {
    v.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_.-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// What one stderr line asks the supervisor to do.
#[derive(Debug, PartialEq)]
pub(crate) enum Verdict {
    /// Log it; `arm_stall` when ffmpeg opened a new segment.
    Log { arm_stall: bool },
    /// A copy session's input is not H.264: remember the channel, kill.
    Reencode(String),
    /// A storm or a single huge jump: kill (relaunch in place when proven).
    Kill(String),
}

/// The stderr reader's state for one ffmpeg launch.
pub(crate) struct Probe {
    reencode: bool,
    storm_window: Duration,
    pub saw_output: bool,
    codec_decided: bool,
    storm_count: u32,
    storm_start: Option<Instant>,
}

impl Probe {
    pub fn new(reencode: bool, storm_window: Duration) -> Self {
        Probe {
            reencode,
            storm_window,
            saw_output: false,
            codec_decided: false,
            storm_count: 0,
            storm_start: None,
        }
    }

    pub fn line(&mut self, line: &str, now: Instant) -> Verdict {
        // The Output dump has a "Video:" line too; only the INPUT codec counts.
        if line.starts_with("Output #") {
            self.saw_output = true;
        }
        if !self.codec_decided
            && !self.saw_output
            && !self.reencode
            && let Some(c) = VIDEO_RE.captures(line)
        {
            self.codec_decided = true;
            let codec = c[1].to_lowercase();
            if codec != "h264" && codec != "avc" {
                return Verdict::Reencode(codec);
            }
        }
        let arm_stall = SEG_OPEN_RE.is_match(line);
        if line.contains("timestamp discontinuity") {
            let jump: f64 = JUMP_RE
                .captures(line)
                .and_then(|c| c[1].parse().ok())
                .unwrap_or(0.0);
            if jump.abs() > TS_JUMP_RELAUNCH_US {
                return Verdict::Kill(format!(
                    "single timestamp jump over an hour (jumpHours={:.2})",
                    jump / 3.6e9
                ));
            }
            if self
                .storm_start
                .is_none_or(|s| now.duration_since(s) > self.storm_window)
            {
                self.storm_start = Some(now);
                self.storm_count = 0;
            }
            self.storm_count += 1;
            if self.storm_count >= TS_STORM_LINES {
                return Verdict::Kill(format!(
                    "timestamp-discontinuity storm (lines={})",
                    self.storm_count
                ));
            }
        }
        Verdict::Log { arm_stall }
    }
}

enum Sig {
    /// SIGTERM now, SIGKILL after the grace.
    Term,
}

struct Session {
    stream_id: String,
    sub: String,
    started_at: Instant,
    last_seen: Instant,
    child: u64,
    ctl: UnboundedSender<Sig>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    /// Children we signalled that have not exited: each still holds its
    /// provider socket, so the cap counts it until its exit.
    draining: HashSet<u64>,
}

/// A started session: where its playlist lands.
#[derive(Clone, Debug)]
pub struct Started {
    pub session_id: String,
    pub dir: PathBuf,
    pub manifest_path: PathBuf,
}

/// A session as listed (the stale-entry checks and tests read these).
#[derive(Clone, Debug)]
pub struct Listed {
    pub session_id: String,
    pub stream_id: String,
    pub sub: String,
    pub started_at: Instant,
    pub last_seen: Instant,
}

struct Shared {
    ffmpeg: PathBuf,
    tmp_dir: PathBuf,
    cap: usize,
    preset: String,
    threads: u64,
    max_height: u64,
    user: String,
    pass: String,
    egress: Egress,
    tracker: Arc<Tracker>,
    dead: Arc<DeadFeeds>,
    t: Timings,
    inner: Mutex<Inner>,
    reencode: Mutex<HashMap<String, Instant>>,
    activity: Mutex<Instant>,
    ids: AtomicU64,
}

/// The remux registry. Cheap to clone; every clone is the same registry.
#[derive(Clone)]
pub struct Remux(Arc<Shared>);

/// What one launch needs; kept by its supervisor for an in-place relaunch.
struct Plan {
    session_id: String,
    stream_id: String,
    dir: PathBuf,
    manifest_path: PathBuf,
    upstream: String,
    reencode: bool,
    proxy: [String; 2],
}

impl Remux {
    pub fn new(
        config: &Config,
        tracker: Arc<Tracker>,
        dead: Arc<DeadFeeds>,
        egress: Egress,
    ) -> Self {
        Self::with_timings(config, tracker, dead, egress, Timings::default())
    }

    pub(crate) fn with_timings(
        config: &Config,
        tracker: Arc<Tracker>,
        dead: Arc<DeadFeeds>,
        egress: Egress,
        t: Timings,
    ) -> Self {
        let shared = Arc::new(Shared {
            ffmpeg: PathBuf::from(&config.iptv_ffmpeg_bin),
            tmp_dir: PathBuf::from(&config.iptv_remux_tmp_dir),
            cap: config.iptv_max_upstream_connections as usize,
            preset: config.iptv_reencode_preset.clone(),
            threads: config.iptv_reencode_threads,
            max_height: config.iptv_reencode_max_height,
            user: config.xtream_username.clone(),
            pass: config.xtream_password.clone(),
            egress,
            tracker,
            dead,
            t,
            inner: Mutex::default(),
            reencode: Mutex::default(),
            // A restart can land mid-evening: boot counts as viewer activity.
            activity: Mutex::new(Instant::now()),
            ids: AtomicU64::new(0),
        });
        // The idle reap is the backstop for an app close that skipped the
        // session DELETE; channel switches are freed at grant time.
        let weak: Weak<Shared> = Arc::downgrade(&shared);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(t.sweep_every);
            tick.tick().await;
            loop {
                tick.tick().await;
                let Some(sh) = weak.upgrade() else { return };
                Remux(sh).sweep_idle();
            }
        });
        Remux(shared)
    }

    pub fn scrub(&self, line: &str) -> String {
        scrub(line, &self.0.user, &self.0.pass)
    }

    /// Provider connections right now: sessions, draining children and the
    /// tracker's raw live / DVR slots. This is what the cap bounds.
    pub fn live_upstream_count(&self) -> usize {
        let inner = self.0.inner.lock().unwrap();
        self.count(&inner)
    }

    fn count(&self, inner: &Inner) -> usize {
        inner.sessions.len() + inner.draining.len() + self.0.tracker.live_count()
    }

    pub fn note_activity(&self) {
        let mut a = self.0.activity.lock().unwrap();
        *a = (*a).max(Instant::now());
    }

    /// When a viewer last needed the provider (the idle feed-check sweep's quiet period).
    pub fn last_viewer_activity(&self) -> Instant {
        *self.0.activity.lock().unwrap()
    }

    /// True while this channel was recently seen serving non-H.264 video.
    pub fn needs_reencode(&self, stream_id: &str) -> bool {
        let mut m = self.0.reencode.lock().unwrap();
        match m.get(stream_id) {
            Some(exp) if *exp > Instant::now() => true,
            Some(_) => {
                m.remove(stream_id);
                false
            }
            None => false,
        }
    }

    pub fn is_dead(&self, stream_id: &str) -> bool {
        self.0.dead.is_dead(stream_id)
    }

    pub fn list(&self) -> Vec<Listed> {
        let inner = self.0.inner.lock().unwrap();
        let mut v: Vec<Listed> = inner
            .sessions
            .iter()
            .map(|(id, s)| Listed {
                session_id: id.clone(),
                stream_id: s.stream_id.clone(),
                sub: s.sub.clone(),
                started_at: s.started_at,
                last_seen: s.last_seen,
            })
            .collect();
        v.sort_by_key(|s| s.started_at);
        v
    }

    pub fn is_active(&self, session_id: &str) -> bool {
        self.0
            .inner
            .lock()
            .unwrap()
            .sessions
            .contains_key(session_id)
    }

    pub fn heartbeat(&self, session_id: &str) {
        let now = Instant::now();
        if let Some(s) = self.0.inner.lock().unwrap().sessions.get_mut(session_id) {
            s.last_seen = now;
        } else {
            return;
        }
        self.note_activity();
    }

    pub fn stop(&self, session_id: &str, reason: &str) {
        let mut inner = self.0.inner.lock().unwrap();
        self.stop_locked(&mut inner, session_id, reason);
    }

    /// Drop the session and SIGTERM its child, which stays counted (draining)
    /// until it exits. The dir is removed on exit, not here: ffmpeg is still
    /// writing for a beat and a vanished dir makes it abort mid-segment.
    fn stop_locked(&self, inner: &mut Inner, session_id: &str, reason: &str) {
        let Some(s) = inner.sessions.remove(session_id) else {
            return;
        };
        inner.draining.insert(s.child);
        let now = Instant::now();
        tracing::info!(
            session_id,
            reason,
            age_ms = now.duration_since(s.started_at).as_millis() as u64,
            since_seen_ms = now.duration_since(s.last_seen).as_millis() as u64,
            "remux session stopped"
        );
        let _ = s.ctl.send(Sig::Term);
        self.note_activity();
    }

    fn sweep_idle(&self) {
        let now = Instant::now();
        let mut inner = self.0.inner.lock().unwrap();
        let idle: Vec<String> = inner
            .sessions
            .iter()
            .filter(|(_, s)| now.duration_since(s.last_seen) > self.0.t.idle)
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            self.stop_locked(&mut inner, &id, "idle-sweep");
        }
    }

    /// SIGTERM every session, then wait (bounded) until every signalled child
    /// has exited, so shutdown does not race an ffmpeg still writing.
    pub async fn drain(&self, grace: Duration) {
        {
            let mut inner = self.0.inner.lock().unwrap();
            let ids: Vec<String> = inner.sessions.keys().cloned().collect();
            for id in ids {
                self.stop_locked(&mut inner, &id, "drain");
            }
        }
        let deadline = Instant::now() + grace;
        while !self.0.inner.lock().unwrap().draining.is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Start a remux of `upstream` for (stream_id, sub). `Ok(None)` when the
    /// upstream cap leaves no slot (an idle session may have been evicted; the
    /// next poll dials once its child exits) or the egress proxy is down.
    /// Never dials in the same tick as an eviction: the evicted child still
    /// holds its socket, and cap+1 is the burst the provider punishes.
    pub fn start(
        &self,
        stream_id: &str,
        sub: &str,
        upstream: &str,
        reencode: bool,
    ) -> Result<Option<Started>, String> {
        assert_http(upstream)?;
        self.note_activity();
        let sh = &self.0;
        let mut inner = sh.inner.lock().unwrap();
        if sh.cap > 0 && self.count(&inner) >= sh.cap {
            // ponytail: feed-check captures (aux slots) are preempted here once S6 adds them.
            // Reclaim only a session past the idle deadline (a buffered player
            // is silent for most of the window), and only when nothing is
            // already draining toward a free slot, so retries do not cascade.
            if inner.draining.is_empty() {
                let now = Instant::now();
                let lru = inner
                    .sessions
                    .iter()
                    .min_by_key(|(_, s)| s.last_seen)
                    .map(|(id, s)| (id.clone(), now.duration_since(s.last_seen)));
                if let Some((id, idle)) = lru
                    && idle > sh.t.idle
                {
                    tracing::warn!(
                        cap = sh.cap,
                        evicted_session_id = id,
                        idle_ms = idle.as_millis() as u64,
                        "upstream cap reached; reclaiming idle session, waiting for its provider connection to close"
                    );
                    self.stop_locked(&mut inner, &id, "upstream-cap");
                }
            }
            return Ok(None);
        }
        // Not listening reads like a busy upstream.
        let Some(proxy) = sh.egress.proxy_args() else {
            return Ok(None);
        };
        let ms = chrono::Utc::now().timestamp_millis();
        let session_id = format!("remux:{stream_id}:{}:{ms}", safe_id_part(sub));
        let dir = sh.tmp_dir.join(session_id.replace([':', '/'], "_"));
        std::fs::create_dir_all(&dir).map_err(|e| format!("remux dir: {e}"))?;
        let plan = Plan {
            session_id: session_id.clone(),
            stream_id: stream_id.into(),
            manifest_path: dir.join("index.m3u8"),
            dir: dir.clone(),
            upstream: upstream.into(),
            reencode,
            proxy,
        };
        let started = Started {
            session_id: session_id.clone(),
            dir: dir.clone(),
            manifest_path: plan.manifest_path.clone(),
        };
        match self.spawn(&plan, false) {
            Ok((child, id)) => {
                let (tx, rx) = unbounded_channel();
                let now = Instant::now();
                inner.sessions.insert(
                    session_id,
                    Session {
                        stream_id: stream_id.into(),
                        sub: sub.into(),
                        started_at: now,
                        last_seen: now,
                        child: id,
                        ctl: tx,
                    },
                );
                drop(inner);
                tokio::spawn(supervise(self.clone(), plan, child, id, rx));
            }
            Err(e) => {
                // Like the TS 'error' event: the session never registers, so
                // the next poll sees it gone (a fast failure).
                tracing::warn!(
                    session_id,
                    message = self.scrub(&e.to_string()),
                    "ffmpeg error"
                );
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
        Ok(Some(started))
    }

    fn args(&self, p: &Plan, resume: bool) -> Vec<String> {
        let sh = &self.0;
        let s = |v: &str| v.to_string();
        let mut a = vec![
            s("-hide_banner"),
            // info + -nostats: ffmpeg prints the input codec the probe reads.
            s("-loglevel"),
            s("info"),
            s("-nostats"),
            s("-nostdin"),
            s("-protocol_whitelist"),
            format!("file,{FFMPEG_PROXIED_PROTOCOLS}"),
        ];
        a.extend(p.proxy.iter().cloned());
        a.extend(
            [
                // +igndts drops the provider's broken input DTS.
                "-fflags",
                "+discardcorrupt+genpts+igndts",
                // Ceilings for late-declaring HEVC channels, not fixed waits.
                "-probesize",
                "10M",
                "-analyzeduration",
                "10M",
                // Per-read timeout: a half-open socket exits instead of wedging.
                "-rw_timeout",
                "15000000",
                "-user_agent",
                UPSTREAM_USER_AGENT,
                "-i",
            ]
            .map(s),
        );
        a.push(p.upstream.clone());
        if p.reencode {
            a.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    &sh.preset,
                    "-pix_fmt",
                    "yuv420p",
                    "-g",
                    "48",
                    "-force_key_frames",
                    "expr:gte(t,n_forced*2)",
                    "-threads",
                ]
                .map(s),
            );
            a.push(sh.threads.to_string());
            a.push(s("-vf"));
            // Downscale only; the comma is escaped for the filtergraph parser.
            a.push(format!("scale=-2:min({}\\,ih)", sh.max_height));
        } else {
            a.extend(["-c:v", "copy"].map(s));
        }
        a.extend(
            [
                // HE-AAC's SBR delay puts AVPlayer audio behind video: AAC-LC.
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
                // About an 80 s window for the provider's irregular keyframes.
                "-hls_list_size",
                "40",
                "-hls_flags",
            ]
            .map(s),
        );
        // discont_start on a relaunch marks the timestamp reset as a seam.
        a.push(s(if resume {
            "delete_segments+append_list+omit_endlist+discont_start"
        } else {
            "delete_segments+append_list+omit_endlist"
        }));
        a.extend(["-hls_segment_filename", "seg_%05d.ts"].map(s));
        a.push(p.manifest_path.to_string_lossy().into_owned());
        a
    }

    fn spawn(&self, p: &Plan, resume: bool) -> std::io::Result<(Child, u64)> {
        let child = Command::new(&self.0.ffmpeg)
            .args(self.args(p, resume))
            .current_dir(&p.dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        Ok((child, self.0.ids.fetch_add(1, Ordering::SeqCst)))
    }

    #[cfg(test)]
    pub(crate) fn draining_count(&self) -> usize {
        self.0.inner.lock().unwrap().draining.len()
    }

    /// Test seam: pretend the session was last polled `by` ago.
    #[cfg(test)]
    pub(crate) fn backdate(&self, session_id: &str, by: Duration) {
        if let Some(s) = self.0.inner.lock().unwrap().sessions.get_mut(session_id) {
            s.last_seen -= by;
        }
    }
}

fn remove_dir(dir: &Path) {
    // Best effort; a stale dir is swept by the next session's exit at worst.
    let _ = std::fs::remove_dir_all(dir);
}

/// One session's children, in order: read stderr, run the watchdogs, take
/// signals, and on exit tag a dead feed, relaunch in place or clean up.
async fn supervise(
    remux: Remux,
    plan: Plan,
    mut child: Child,
    mut child_id: u64,
    mut rx: UnboundedReceiver<Sig>,
) {
    let sh = remux.0.clone();
    let t = sh.t;
    let mut rx_open = true;
    loop {
        let spawned = Instant::now();
        let pid = child.id();
        let mut lines = BufReader::new(child.stderr.take().expect("stderr piped")).split(b'\n');
        let mut probe = Probe::new(plan.reencode, t.storm_window);
        let mut stall: Option<Instant> = None;
        let mut term_kill: Option<Instant> = None;
        let mut stderr_open = true;
        let mut killed = false;
        let mut relaunch = false;
        let status = loop {
            tokio::select! {
                st = child.wait() => break st,
                seg = lines.next_segment(), if stderr_open => {
                    let Ok(Some(raw)) = seg else {
                        stderr_open = false;
                        continue;
                    };
                    if killed {
                        continue;
                    }
                    let text = remux.scrub(&String::from_utf8_lossy(&raw));
                    let line = text.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match probe.line(line, Instant::now()) {
                        Verdict::Reencode(codec) => {
                            sh.reencode
                                .lock()
                                .unwrap()
                                .insert(plan.stream_id.clone(), Instant::now() + REENCODE_MEMORY);
                            tracing::warn!(session_id = plan.session_id, codec, "input video is not H.264; re-encoding");
                            killed = true;
                            stall = None;
                            let _ = child.start_kill();
                        }
                        Verdict::Kill(reason) => {
                            relaunch = kill(&plan, &mut child, &reason, probe.saw_output, spawned, t);
                            killed = true;
                            stall = None;
                        }
                        Verdict::Log { arm_stall } => {
                            if arm_stall {
                                stall = Some(Instant::now() + t.stall);
                            }
                            tracing::warn!(session_id = plan.session_id, "{line}");
                        }
                    }
                }
                _ = sleep_until(stall.unwrap_or_else(Instant::now)), if stall.is_some() => {
                    let reason = format!("no new segment (stallMs={})", t.stall.as_millis());
                    relaunch = kill(&plan, &mut child, &reason, probe.saw_output, spawned, t);
                    killed = true;
                    stall = None;
                }
                _ = sleep_until(term_kill.unwrap_or_else(Instant::now)), if term_kill.is_some() => {
                    term_kill = None;
                    let _ = child.start_kill();
                }
                sig = rx.recv(), if rx_open => match sig {
                    Some(Sig::Term) => {
                        #[cfg(unix)]
                        if let Some(pid) = pid {
                            // SAFETY: kill(2) on our own child, not yet reaped
                            // (wait() has not returned); no pointers involved.
                            unsafe {
                                libc::kill(pid as i32, libc::SIGTERM);
                            }
                        }
                        #[cfg(not(unix))]
                        let _ = child.start_kill();
                        term_kill.get_or_insert(Instant::now() + t.kill_grace);
                    }
                    None => rx_open = false,
                },
            }
        };
        let lived = spawned.elapsed();
        let (code, signal) = match &status {
            Ok(st) => (st.code(), exit_signal(st)),
            Err(_) => (None, None),
        };
        let next = {
            let mut inner = sh.inner.lock().unwrap();
            // ffmpeg traps SIGTERM and exits (0, none), the same shape as a
            // provider EOF; draining holds exactly the children we signalled.
            let torn_down = inner.draining.remove(&child_id);
            if code == Some(0) && signal.is_none() && !torn_down && lived < t.dead_lifetime {
                sh.dead.strike(&plan.stream_id);
                tracing::warn!(
                    session_id = plan.session_id,
                    stream_id = plan.stream_id,
                    lived_ms = lived.as_millis() as u64,
                    "clean EOF; tagging stream as a dead feed (fail over to a sibling)"
                );
            }
            tracing::info!(
                session_id = plan.session_id,
                code,
                signal,
                lived_ms = lived.as_millis() as u64,
                "ffmpeg exited"
            );
            let live = inner
                .sessions
                .get(&plan.session_id)
                .is_some_and(|s| s.child == child_id);
            if relaunch && live {
                // Same dir and manifest: append_list continues the playlist.
                match remux.spawn(&plan, true) {
                    Ok((c, id)) => {
                        if let Some(s) = inner.sessions.get_mut(&plan.session_id) {
                            s.child = id;
                        }
                        Some((c, id))
                    }
                    Err(e) => {
                        tracing::warn!(
                            session_id = plan.session_id,
                            message = remux.scrub(&e.to_string()),
                            "ffmpeg error"
                        );
                        inner.sessions.remove(&plan.session_id);
                        None
                    }
                }
            } else {
                if live {
                    inner.sessions.remove(&plan.session_id);
                }
                None
            }
        };
        match next {
            Some((c, id)) => {
                child = c;
                child_id = id;
            }
            None => {
                remove_dir(&plan.dir);
                return;
            }
        }
    }
}

/// SIGKILL a faulted launch. True when it proved itself (output, past the
/// floor) and is relaunched in place; a young dial that faults means the fresh
/// connection is bad, so the session ends and the reconnect throttle applies.
fn kill(
    plan: &Plan,
    child: &mut Child,
    reason: &str,
    saw_output: bool,
    spawned: Instant,
    t: Timings,
) -> bool {
    let relaunch = saw_output && spawned.elapsed() >= t.relaunch_floor;
    tracing::warn!(
        session_id = plan.session_id,
        stream_id = plan.stream_id,
        lived_ms = spawned.elapsed().as_millis() as u64,
        "{reason}; {}",
        if relaunch {
            "relaunching ffmpeg in place to re-base timestamps"
        } else {
            "ending the session"
        }
    );
    let _ = child.start_kill();
    relaunch
}

#[cfg(unix)]
fn exit_signal(st: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    st.signal()
}

#[cfg(not(unix))]
fn exit_signal(_: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(test)]
pub(crate) mod tests;
