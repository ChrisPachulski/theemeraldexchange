//! Transcode session lifecycle — a tokio port of `server/services/iptvRemux.ts`.
//!
//! A [`Session`] owns one ffmpeg child (`tokio::process::Command` with
//! `kill_on_drop(true)`), a per-session tmpdir holding `index.m3u8` + segments,
//! and a supervisor task that restarts ffmpeg on unexpected exit with
//! exponential backoff (bounded attempts). The [`SessionManager`] tracks all
//! live sessions, sweeps idle ones every 5s (30s no-heartbeat → SIGTERM, then
//! SIGKILL after 5s), and bills each session against the [`Limiter`].
//!
//! The ffmpeg binary is injectable via `TRANSCODER_FFMPEG_BIN` so tests point
//! at a shell stub that writes a fake playlist and sleeps — exercising the full
//! start → heartbeat → seek (kill+respawn) → stop lifecycle and orphan cleanup
//! WITHOUT a real transcode. That is the honest verifiable boundary of this
//! scaffold; real ffmpeg transcode wiring is the multi-month long pole.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::args::{ArgSpec, HwEncoder, ffmpeg_args_for, sidecar_vtt_args};
use crate::concurrency::{Busy, Caps, Limiter, Permit};
use crate::plan::{SegmentFormat, SidecarSubtitle, TranscodePlan};
use crate::trickplay::AudioRendition;
use media_core::models::AudioTrack;

/// 30s with no heartbeat → reap (mirrors `IDLE_MS` in iptvRemux.ts).
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Idle sweep cadence.
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);
/// Pause the keyframe warmer leaves between full-file demuxes so it never pins
/// the library disk (gentle, Plex-co-tenant-safe).
const WARM_FILE_DELAY: Duration = Duration::from_secs(3);
/// How long the warmer waits before re-scanning the library for new titles after
/// a full pass.
const WARM_RESCAN_INTERVAL: Duration = Duration::from_secs(3600);
/// Poll cadence while the warmer waits for the box to go idle (no live session).
const WARM_IDLE_POLL: Duration = Duration::from_secs(10);
/// Container extensions the warmer pre-probes (keyframes are codec-agnostic, so
/// any of these could back a copy-remux HLS session).
const WARM_EXTS: &[&str] = &["mkv", "mp4", "m4v", "mov", "ts", "webm", "avi"];
/// Grace period between SIGTERM and SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(5);
/// Supervisor restart cap before a session is declared failed.
const MAX_RESTARTS: u32 = 3;
/// A child that ran at least this long before dying is considered to have been
/// HEALTHY: its crash is treated as a fresh incident, not part of a crash-loop,
/// so the restart budget resets (see [`effective_restart_count`]).
const HEALTHY_RUN_RESET: Duration = Duration::from_secs(60);
/// Bound on waiting for a supervisor ack: [`KILL_GRACE`] for the TERM→KILL
/// escalation plus slack for the respawn itself. A closed channel (the
/// supervisor exited because the session was torn down) resolves immediately.
const CTL_ACK_TIMEOUT: Duration = Duration::from_secs(10);

/// Process-wide monotonic sequence appended to session ids. The wall-clock
/// component alone is 1s-granular, so two grants for the same title+user
/// within a second (a double-click) would otherwise mint the SAME id — the
/// second map insert would displace the first Session and orphan its running
/// ffmpeg. The sequence makes every id unique for the process lifetime.
static START_SEQ: AtomicU64 = AtomicU64::new(0);

pub type SessionId = String;

/// Filename of the pre-extracted sidecar WebVTT inside a session dir. Written by
/// the one-shot extraction at start (see [`SessionManager::spawn_sidecar_subtitle`]),
/// served by the same `{segment}` asset route as the segments, and loaded by the
/// player as a `<track>`. Passes [`is_safe_segment_name`] (alnum + `.`).
pub const SIDECAR_SUBTITLE_NAME: &str = "subtitles.vtt";

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A segment/asset name is safe to join onto the session dir iff it is a
/// single, ordinary path component: non-empty, not `.`/`..`, and built only
/// from `[A-Za-z0-9._-]` (no separators, no NUL, no absolute paths). ffmpeg
/// only ever writes `seg_%05d.ts` and `index.m3u8`, so this whitelist is
/// strictly wider than the real surface while still blocking traversal.
fn is_safe_segment_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Options for starting a session.
#[derive(Debug, Clone)]
pub struct StartOpts {
    pub media_kind: String,
    pub media_id: i64,
    pub sub: String,
    pub input_path: String,
    pub plan: TranscodePlan,
    pub start_secs: u64,
    /// Source video codec (e.g. `hevc`, `h264`, `av1`) from the file's probe,
    /// used to gate the full-hardware VAAPI decode path: `-hwaccel_output_format
    /// vaapi` has NO software fallback, so we only enable it for codecs the iGPU
    /// can decode (see [`is_vaapi_hw_decodable`]). `None` → software decode.
    pub source_codec: Option<String>,
    /// Whole-container average bitrate of the SOURCE file (kbps), derived from
    /// size/duration by the grant route. Caps the re-encode bitrate ladder so a
    /// low-bitrate source is never inflated past its own quality (see
    /// [`crate::args`]'s ladder). `None` → ladder applies uncapped.
    pub source_avg_kbps: Option<u32>,
    /// Full source duration in seconds (from the file probe), or `None` when the
    /// probe found none. Lets native (AVPlayer) clients be served a complete VOD
    /// playlist with a finite timeline instead of the growing EVENT playlist
    /// (which AVKit renders as a live stream). See [`crate::vod_manifest`].
    pub duration_secs: Option<i64>,
    /// The VERIFIED principal's sub from the grant request, binding the session
    /// to its creator so stop/seek/heartbeat can enforce owner-or-admin.
    /// `None` only in the Off/log postures where no verified identity exists
    /// (routes skip enforcement accordingly).
    pub owner: Option<String>,
    /// The TEXT subtitle to pre-extract to a sidecar `subtitles.vtt` (from
    /// [`crate::plan::plan_sidecar_subtitle`]), or `None` when the title has no
    /// text subtitle. Drives a one-shot, detached ffmpeg pass at session start,
    /// fully decoupled from the live HLS stream (see
    /// [`SessionManager::spawn_sidecar_subtitle`]); the language/forced flags
    /// are kept on the session so native manifests can advertise the rendition
    /// (see [`SessionManager::native_master`]).
    pub subtitle: Option<SidecarSubtitle>,
    /// Source audio tracks (from the file probe, in probe order) — the metadata
    /// the native master needs to NAME/tag each alternate-audio rendition. The
    /// plan's `extra_audio` carries only indices/ops; the language + title come
    /// from here (see [`SessionManager::spawn_audio_renditions`] and
    /// [`audio_renditions`]). Empty for a single-audio title or the web path.
    pub audio_tracks: Vec<AudioTrack>,
}

/// A point-in-time view of a session for the admin inventory (§4.5 phase 7).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionInfo {
    pub session_id: SessionId,
    pub media_kind: String,
    pub media_id: i64,
    pub sub: String,
    pub started_at: u64,
    pub last_seen: u64,
    pub start_secs: u64,
    pub restarts: u32,
    pub manifest_path: String,
    /// Verified-principal owner; `None` for sessions created without one.
    pub owner: Option<String>,
}

/// Live session state. Not `Clone` — the manager holds it behind the map mutex.
///
/// Note there is NO `Child` here: the supervisor task is the sole owner of the
/// ffmpeg process for the session's whole lifetime. Map-side code reaches the
/// process only through `ctl` (see [`SessionCmd`]); a parked-in-the-map handle
/// was a no-op kill target whenever the supervisor held the real one across
/// `wait()`.
struct Session {
    info_kind: String,
    info_id: i64,
    sub: String,
    dir: PathBuf,
    started_at: u64,
    last_seen: u64,
    start_secs: u64,
    /// First segment number (`-start_number`) of the CURRENT ffmpeg child.
    /// 0 for the initial spawn; each respawn advances it past the furthest
    /// segment already written so numbering stays monotonic for the session's
    /// whole lifetime (see [`SessionManager::respawn`]).
    start_number: u64,
    restarts: u32,
    /// Command channel to the supervisor (kill/respawn the real ffmpeg).
    ctl: mpsc::UnboundedSender<SessionCmd>,
    /// Held for the session's lifetime; dropping it frees the concurrency slot.
    _permit: Permit,
    plan: TranscodePlan,
    input_path: String,
    /// Source video codec, carried for the supervisor respawn so the full-HW
    /// gate is recomputed identically on every spawn.
    source_codec: Option<String>,
    /// Source average bitrate (kbps), carried for respawn arg parity.
    source_avg_kbps: Option<u32>,
    /// Full source duration (secs) for the native VOD-manifest synthesis.
    duration_secs: Option<i64>,
    /// Verified principal sub that created the session (owner-or-admin gate).
    owner: Option<String>,
    /// The sidecar subtitle being extracted for this session, if any — lets
    /// native manifests advertise it as an HLS SUBTITLES rendition.
    subtitle: Option<SidecarSubtitle>,
    /// Source audio tracks (probe order), so the native master can NAME/tag the
    /// alternate-audio renditions the plan's `extra_audio` indices refer to.
    audio_tracks: Vec<AudioTrack>,
}

/// Control messages for a session's supervisor — the SOLE owner of the ffmpeg
/// [`Child`]. `seek()`/`stop()` never hold a process handle; they ask the
/// supervisor, which kills (and for seek, respawns) the child itself, so a kill
/// always reaches the real process.
enum SessionCmd {
    /// Kill the current ffmpeg (if any), clear the session dir, and respawn at
    /// the session's CURRENT `start_secs` (seek updates it before sending).
    /// The ack reports whether the respawn produced a running child.
    Restart { ack: oneshot::Sender<bool> },
    /// Kill the current ffmpeg and exit the supervisor. The ack fires once the
    /// process is confirmed dead, so the caller can safely remove the dir.
    Shutdown { ack: oneshot::Sender<()> },
}

/// Spawn a `Command`, retrying the rare transient ETXTBSY ("text file busy").
///
/// On a loaded, multi-threaded host another thread's `fork()` (every concurrent
/// `Command::spawn`) can momentarily inherit a just-written executable's write
/// fd — `O_CLOEXEC` closes it only at THAT child's `exec`, so an `execve` racing
/// the fork→exec window fails with ETXTBSY. This never fires for the stable,
/// installed ffmpeg in production (it is never freshly written); it removes a
/// flake in the session tests, which write+exec a fresh stub per case. tokio's
/// `Command::spawn` borrows `&mut self`, so the same builder is retried in place.
/// Errno-specific and bounded; the backoff is a NON-blocking `tokio::time::sleep`
/// (never `std::thread::sleep`) so a retry under heavy test concurrency yields to
/// the runtime instead of stalling the worker and starving the timing-sensitive
/// poll tests. Mirrors the same guard in `media-core`'s `ffprobe` spawn.
async fn spawn_retrying_etxtbsy(cmd: &mut Command) -> std::io::Result<Child> {
    let mut attempt = 0u8;
    loop {
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e)
                if attempt < 5
                    && (e.kind() == std::io::ErrorKind::ExecutableFileBusy
                        || e.raw_os_error() == Some(26)) =>
            {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Terminate one ffmpeg child: SIGTERM (lets ffmpeg flush/finalize), then
/// SIGKILL after [`KILL_GRACE`], then reap. tokio's [`Child`] only exposes
/// SIGKILL (`start_kill`), so the polite TERM goes through `libc` with the raw
/// pid; `id()` is `None` once the child has already been reaped, in which case
/// there is nothing left to signal and `wait()` returns the cached status.
async fn kill_child(child: &mut Child, id: &str) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: plain kill(2) on a pid we spawned and have not yet reaped
        // (the supervisor owns the Child); no pointers involved.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    if tokio::time::timeout(KILL_GRACE, child.wait())
        .await
        .is_err()
    {
        tracing::warn!(session = %id, "ffmpeg ignored SIGTERM; escalating to SIGKILL");
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

/// `remove_dir_all` with the failure LOGGED: a silently-failed removal on the
/// bounded /scratch tmpfs is an invisible space leak. `NotFound` is the normal
/// teardown race (another path already cleaned it) and stays quiet.
async fn remove_dir_logged(dir: &PathBuf, id: &str, context: &str) {
    if let Err(e) = tokio::fs::remove_dir_all(dir).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(session = %id, error = %e, "failed to remove session dir ({context})");
    }
}

impl Session {
    fn manifest_path(&self) -> PathBuf {
        self.dir.join("index.m3u8")
    }

    fn info(&self, id: &str) -> SessionInfo {
        SessionInfo {
            session_id: id.to_string(),
            media_kind: self.info_kind.clone(),
            media_id: self.info_id,
            sub: self.sub.clone(),
            started_at: self.started_at,
            last_seen: self.last_seen,
            start_secs: self.start_secs,
            restarts: self.restarts,
            manifest_path: self.manifest_path().to_string_lossy().into_owned(),
            owner: self.owner.clone(),
        }
    }

    /// Alternate-audio renditions to advertise in this session's native master,
    /// or empty when the flag is off, the plan selected no extra tracks, or this
    /// isn't a transcode plan. The PRIMARY (English-preferred) track is the
    /// in-band rendition (`DEFAULT=YES`, no URI — it stays muxed in the video
    /// variant, so the main pipeline is untouched); each EXTRA track becomes a
    /// separate `audio_{n}.m3u8` URI rendition produced by
    /// [`SessionManager::spawn_audio_renditions`]. The two never collide —
    /// [`crate::plan::plan_extra_audio`] excludes the primary index.
    fn alt_audio_renditions(&self) -> Vec<AudioRendition> {
        if !crate::trickplay::alt_audio_enabled() {
            return Vec::new();
        }
        let TranscodePlan::Transcode {
            audio_index,
            extra_audio,
            ..
        } = &self.plan
        else {
            return Vec::new();
        };
        if extra_audio.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(extra_audio.len() + 1);
        out.push(rendition_from(
            self.audio_tracks.get(*audio_index),
            *audio_index,
            true,
            None,
        ));
        for (idx, _op) in extra_audio {
            out.push(rendition_from(
                self.audio_tracks.get(*idx),
                *idx,
                false,
                Some(*idx),
            ));
        }
        out
    }
}

/// Build one [`AudioRendition`] from an optional source [`AudioTrack`]. `NAME`
/// prefers the language tag, then the track title, then a positional fallback —
/// it is required and must never be empty. `uri_index` is `Some` for a
/// separately-segmented rendition (`audio_{n}.m3u8`) and `None` for the in-band
/// primary.
fn rendition_from(
    track: Option<&AudioTrack>,
    position: usize,
    is_default: bool,
    uri_index: Option<usize>,
) -> AudioRendition {
    let language = track
        .and_then(|t| t.language.clone())
        .filter(|l| !l.trim().is_empty());
    let name = language
        .clone()
        .or_else(|| {
            track
                .and_then(|t| t.title.clone())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| format!("Audio {}", position + 1));
    AudioRendition {
        name,
        language,
        is_default,
        uri: uri_index.map(crate::trickplay::audio_playlist_name),
    }
}

/// True for the on-disk assets an alternate-audio rendition pass writes — its
/// media playlist (`audio_{n}.m3u8`) and segments (`audio_{n}_%05d.ts`). The
/// segment route waits briefly on these (like the frontier video segments and
/// the sidecar VTT) so a fetch that races the detached pass' first write retries
/// instead of hard-404ing. Only rendition files start with `audio_`.
pub(crate) fn is_audio_rendition_asset(name: &str) -> bool {
    name.starts_with("audio_") && (name.ends_with(".ts") || name.ends_with(".m3u8"))
}

/// Errors a start can return.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("transcoder busy (cpu_cap={})", .0.cpu_cap)]
    Busy(Busy),
    #[error("failed to prepare session: {0}")]
    Io(String),
    #[error("failed to spawn ffmpeg: {0}")]
    Spawn(String),
    #[error("source path is not within an allowed media root: {0}")]
    Forbidden(String),
}

/// Lexically normalize a path — resolve `.` and `..` components WITHOUT touching
/// the filesystem (so it works for not-yet-existing paths and in tests) and
/// without following symlinks. `..` that would climb above the root is clamped.
/// Used by [`path_within_roots`] so a crafted `source_path` cannot escape the
/// configured media root via `../` before we hand it to ffmpeg.
fn lexically_normalize(p: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out: Vec<Component> = Vec::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                // Can't climb above an absolute root / prefix — ignore.
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                // Relative path with a leading `..` — preserve it (it can never
                // be "within" an absolute root anyway, so it will be rejected).
                _ => out.push(Component::ParentDir),
            },
            c => out.push(c),
        }
    }
    out.iter().map(|c| c.as_os_str()).collect()
}

/// True when `input` lexically resolves to a location under at least one of
/// `roots`. Both sides are normalized the same way so `..` cannot smuggle the
/// path outside a root. An empty `roots` slice means "no confinement"; callers
/// must check that separately.
fn path_within_roots(input: &str, roots: &[PathBuf]) -> bool {
    let norm = lexically_normalize(std::path::Path::new(input));
    roots
        .iter()
        .any(|r| norm.starts_with(lexically_normalize(r)))
}

/// Codecs the Intel iGPU can decode via VAAPI (`-hwaccel vaapi
/// -hwaccel_output_format vaapi`). Anything outside this set — notably MPEG-4
/// part 2 / DivX, which modern Intel fixed-function decode dropped — has NO
/// software fallback under `-hwaccel_output_format vaapi` and would hard-fail the
/// session, so it must use the software-decode path instead. The list is kept
/// deliberately conservative: an omitted-but-decodable codec merely costs a CPU
/// decode (correct, just slower), whereas a wrongly-included one breaks playback.
fn is_vaapi_hw_decodable(codec: &str) -> bool {
    matches!(
        codec.trim().to_ascii_lowercase().as_str(),
        "hevc" | "h265" | "h264" | "avc" | "avc1" | "av1" | "vp9"
    )
}

/// Why a supervisor respawn is happening — drives the resume position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RespawnMode {
    /// A user seek: the session's `start_secs` was just set to the seek target
    /// and the respawn must honor it exactly.
    Seek,
    /// Crash recovery: the child died mid-encode. Resume at the approximate
    /// FURTHEST-ENCODED position, not the stale grant/seek offset — otherwise
    /// every crash silently rewinds playback to where the session started.
    Crash,
}

/// Parse a segment file name (`seg_%05d.ts`) into its index.
pub(crate) fn segment_index(name: &str) -> Option<u64> {
    // `.ts` for MPEG-TS sessions, `.m4s` for fMP4 (HEVC copy) sessions.
    let stem = name.strip_prefix("seg_")?;
    let stem = stem
        .strip_suffix(".ts")
        .or_else(|| stem.strip_suffix(".m4s"))?;
    stem.parse().ok()
}

/// The highest segment index present in a session dir, or `None` when the dir
/// is unreadable or holds no segments. The HLS sliding window
/// (`delete_segments`) prunes from the OLDEST end, so the max index present is
/// the furthest segment the previous child wrote — even after pruning.
async fn max_segment_index(dir: &PathBuf) -> Option<u64> {
    let mut rd = tokio::fs::read_dir(dir).await.ok()?;
    let mut max: Option<u64> = None;
    while let Ok(Some(entry)) = rd.next_entry().await {
        if let Some(idx) = entry.file_name().to_str().and_then(segment_index) {
            max = Some(max.map_or(idx, |m| m.max(idx)));
        }
    }
    max
}

/// Restart budget carried into the next crash, given how long the child that
/// just died had been running.
///
/// `MAX_RESTARTS` was session-LIFETIME: three transient hiccups spread over a
/// two-hour movie (each followed by a long healthy run) permanently tore the
/// session down on the third, exactly like a tight crash-loop. A child that
/// ran for [`HEALTHY_RUN_RESET`] or longer proves the respawn recipe works, so
/// its crash starts a fresh budget; only consecutive SHORT-lived children
/// (the real crash-loop signature) accumulate toward the cap. Pure so the
/// decision is unit-testable without 60s waits.
///
/// A failed RESPAWN (no child ever ran) must pass `ran_for = 0` — counting
/// time since the last successful spawn would reset the budget on every retry
/// and livelock a permanently-broken respawn.
fn effective_restart_count(prev: u32, ran_for: Duration) -> u32 {
    if ran_for >= HEALTHY_RUN_RESET {
        0
    } else {
        prev
    }
}

/// Approximate furthest-encoded position for a crash respawn: the offset the
/// crashed child was spawned at (`spawn_secs`, its baked `-ss`) plus the
/// segments it wrote (`next_number - prev_number`) times the segment length.
/// Pure so the math is unit-testable without a real crash.
fn crash_resume_secs(spawn_secs: u64, prev_number: u64, next_number: u64) -> u64 {
    spawn_secs + next_number.saturating_sub(prev_number) * u64::from(crate::args::HLS_SEGMENT_SECS)
}

/// Shared, cheap-to-clone manager (Arc'd map + config).
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
    limiter: Limiter,
    ffmpeg_bin: String,
    tmp_root: PathBuf,
    encoder: HwEncoder,
    /// Directories ffmpeg is allowed to read source media from. Empty = no
    /// confinement (dev/tests). Set from `TRANSCODER_MEDIA_ROOT` in prod so an
    /// authorized caller still cannot point ffmpeg at arbitrary container files
    /// (defense-in-depth behind the principal_layer auth gate).
    media_roots: Vec<PathBuf>,
    /// When set, eligible VAAPI re-encodes run the FULL hardware pipeline
    /// (GPU decode → tonemap_vaapi/scale_vaapi → h264_vaapi, no CPU round-trip).
    /// Set by `main.rs` only after a boot probe confirms the iGPU's VAAPI VPP +
    /// encode chain works (see [`crate::encoders::vaapi_full_hw_supported`]); off
    /// by default so the manager falls back to the proven software-decode path.
    vaapi_hw_decode: bool,
    /// Per-identity async gates that serialize same-title `start` calls so a
    /// duplicate / rapid-retry grant coalesces onto one session instead of each
    /// racing for a slot. Keyed by [`SessionManager::coalesce_key`]; entries are
    /// pruned in the idle sweep once no `start` holds a key. Without this, a user
    /// replaying a title whose previous (CPU-capped) session is still draining
    /// 503'd against the single CPU slot — surfaced in the app as "temporarily
    /// unavailable". See [`SessionManager::start`] for the coalesce/supersede
    /// policy.
    start_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Durable directory (under the scratch root) holding per-file keyframe
    /// caches, so a COPY-remux session can synthesize a finite VOD playlist
    /// without a ~17s probe on the manifest path. See [`crate::keyframes`].
    cache_root: PathBuf,
    /// Source paths whose keyframe probe is in flight, so concurrent manifest
    /// polls (AVPlayer re-reads an EVENT playlist every few seconds) and the
    /// warmer never launch a second full-file demux for the same file — which
    /// would be a redundant I/O storm against the library disk.
    warming: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Directories of recently-played titles, newest-first and bounded. The
    /// keyframe warmer drains these BEFORE the alphabetical library scan so the
    /// show you're actively watching (and its sibling episodes) get a finite VOD
    /// scrubber instead of the "live" badge + edge-stall — without that, on a
    /// 20k-episode library the gentle warmer reaches new episodes only after
    /// hours/days, so a first play serves ffmpeg's still-growing EVENT playlist.
    hot_dirs: Arc<Mutex<std::collections::VecDeque<PathBuf>>>,
}

impl SessionManager {
    /// Build a manager. `encoder` is the already-resolved (boot-detected)
    /// hardware encoder family.
    pub fn new(
        limiter: Limiter,
        ffmpeg_bin: String,
        tmp_root: PathBuf,
        encoder: HwEncoder,
    ) -> Self {
        let cache_root = tmp_root.join(crate::keyframes::KFCACHE_DIRNAME);
        SessionManager {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            limiter,
            ffmpeg_bin,
            tmp_root,
            encoder,
            media_roots: Vec::new(),
            vaapi_hw_decode: false,
            start_gates: Arc::new(Mutex::new(HashMap::new())),
            cache_root,
            warming: Arc::new(Mutex::new(std::collections::HashSet::new())),
            hot_dirs: Arc::new(Mutex::new(std::collections::VecDeque::new())),
        }
    }

    /// Record `dir` as a recently-played source directory (newest-first, deduped,
    /// bounded). Consumed by [`run_keyframe_warmer`] to prioritize the show the
    /// user is actually watching.
    async fn note_hot_dir(&self, dir: PathBuf) {
        const MAX_HOT_DIRS: usize = 12;
        let mut hot = self.hot_dirs.lock().await;
        hot.retain(|d| d != &dir);
        hot.push_front(dir);
        hot.truncate(MAX_HOT_DIRS);
    }

    /// Restrict source media to the given root directories. Returns `self` for
    /// chaining off [`SessionManager::new`]. An empty list leaves confinement
    /// off. Paths are compared lexically (see [`path_within_roots`]).
    pub fn with_media_roots(mut self, roots: Vec<PathBuf>) -> Self {
        self.media_roots = roots;
        self
    }

    /// Enable/disable the full-hardware VAAPI pipeline (chainable form, for
    /// tests). In `main.rs` use [`SessionManager::set_vaapi_hw_decode`] after the
    /// boot probe.
    pub fn with_vaapi_hw_decode(mut self, on: bool) -> Self {
        self.vaapi_hw_decode = on;
        self
    }

    /// Enable/disable the full-hardware VAAPI pipeline in place. `main.rs` calls
    /// this once at boot with the result of the VAAPI VPP+encode capability probe
    /// (only meaningful when the resolved encoder is VAAPI).
    pub fn set_vaapi_hw_decode(&mut self, on: bool) {
        self.vaapi_hw_decode = on;
    }

    /// Construct from the environment: `TRANSCODER_FFMPEG_BIN` (default
    /// `ffmpeg`), `TRANSCODER_TMP_DIR` (default `/tmp/eex-transcode`),
    /// concurrency caps, and `TRANSCODER_HW_ENCODER`.
    ///
    /// NOTE: this reads `TRANSCODER_HW_ENCODER` RAW — it does NOT verify the
    /// encoder is actually built into ffmpeg. Callers that have run boot-time
    /// detection (see [`crate::encoders::detect`]) MUST use
    /// [`SessionManager::from_env_with_encoder`] with the resolved encoder so a
    /// misconfigured HW family does not launch every ffmpeg with a `-c:v` the
    /// binary lacks (which would crash-loop the session → 503 to the user).
    pub fn from_env() -> Self {
        SessionManager::from_env_with_encoder(HwEncoder::from_env())
    }

    /// Construct from the environment, but with an already-resolved (boot-time
    /// detected) hardware encoder. This is the constructor `main.rs` uses after
    /// `encoders::detect().resolve(...)`, so the manager launches ffmpeg with an
    /// encoder the binary actually supports (and the CPU concurrency cap keys on
    /// the RESOLVED family, not the configured one).
    pub fn from_env_with_encoder(encoder: HwEncoder) -> Self {
        let ffmpeg_bin = std::env::var("TRANSCODER_FFMPEG_BIN").unwrap_or_else(|_| "ffmpeg".into());
        let tmp_root = std::env::var("TRANSCODER_TMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("eex-transcode"));
        // Optional `:`-separated allow-list of directories ffmpeg may read
        // source media from (§ audit 1-3 defense-in-depth). Unset = no
        // confinement, preserving dev behavior.
        let media_roots = std::env::var("TRANSCODER_MEDIA_ROOT")
            .ok()
            .map(|s| {
                s.split(':')
                    .filter(|p| !p.is_empty())
                    .map(PathBuf::from)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        SessionManager::new(
            Limiter::new(Caps::from_env()),
            ffmpeg_bin,
            tmp_root,
            encoder,
        )
        .with_media_roots(media_roots)
    }

    /// Remove session directories left over from a previous run (crash or
    /// restart). Call ONLY at boot, before any session exists. The VOD scratch
    /// now lives on durable disk (not the old auto-clearing RAM tmpfs), so
    /// orphaned `seg_*.ts`/`index.m3u8` dirs would otherwise accumulate forever
    /// and slowly fill the cache. Best-effort and fully logged; a missing root
    /// (first boot) is not an error.
    pub async fn sweep_scratch_on_boot(&self) {
        let mut rd = match tokio::fs::read_dir(&self.tmp_root).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                tracing::warn!(
                    root = %self.tmp_root.display(),
                    error = %e,
                    "scratch boot-sweep: cannot read scratch root"
                );
                return;
            }
        };
        let mut removed = 0u32;
        while let Ok(Some(entry)) = rd.next_entry().await {
            // The keyframe cache lives under the scratch root but is DURABLE —
            // it is not a session dir and must survive a restart.
            if entry.file_name() == crate::keyframes::KFCACHE_DIRNAME {
                continue;
            }
            if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                let path = entry.path();
                match tokio::fs::remove_dir_all(&path).await {
                    Ok(()) => removed += 1,
                    Err(e) => tracing::warn!(
                        path = %path.display(),
                        error = %e,
                        "scratch boot-sweep: failed to remove stale session dir"
                    ),
                }
            }
        }
        if removed > 0 {
            tracing::info!(
                removed,
                root = %self.tmp_root.display(),
                "scratch boot-sweep: cleared stale session dirs"
            );
        }
    }

    /// The hardware encoder this manager launches ffmpeg with (the resolved
    /// family once boot detection has run).
    pub fn encoder(&self) -> HwEncoder {
        self.encoder
    }

    pub fn limiter(&self) -> &Limiter {
        &self.limiter
    }

    /// The resolved ffmpeg binary path. The grant-time Dolby Vision probe derives
    /// `ffprobe` from it (same install prefix).
    pub fn ffmpeg_bin(&self) -> &str {
        &self.ffmpeg_bin
    }

    /// Does this session run the FULL-hardware VAAPI pipeline (GPU decode →
    /// VPP → encode, no CPU round-trip)? Mirrors `spawn_child`'s `hw_decode`
    /// gate AND `ffmpeg_args_for`'s burn-in restriction, so the concurrency
    /// accounting and the actual ffmpeg invocation can never drift.
    ///
    /// Everything else — including a VAAPI-ENCODE session whose decode/
    /// tone-map/scale run in software (full-HW probe failed, or the source
    /// codec isn't iGPU-decodable, or a subtitle burn forces CPU frames) —
    /// loads the CPU materially and must be charged against the CPU cap. A 4K
    /// HDR software decode+tonemap saturates cores even when the final encode
    /// is on the GPU; charging by encoder family alone let several of those
    /// stack up and starve the box.
    fn uses_full_hw_pipeline(&self, plan: &TranscodePlan, source_codec: Option<&str>) -> bool {
        use crate::plan::VideoOp;
        self.vaapi_hw_decode
            && matches!(self.encoder, HwEncoder::Vaapi)
            && source_codec.is_some_and(is_vaapi_hw_decodable)
            && matches!(
                plan,
                TranscodePlan::Transcode {
                    video: VideoOp::EncodeH264 {
                        burn_subtitle_index: None,
                        ..
                    },
                    ..
                }
            )
    }

    /// Spawn one ffmpeg child for a session directory. Shared by `start` and the
    /// supervisor respawn path so the argument vector is computed identically.
    /// The child's stderr is drained into `tracing::warn` (tagged by session id)
    /// on a detached task so a full pipe buffer never stalls ffmpeg — mirroring
    /// `proc.stderr.on('data', …)` in iptvRemux.ts.
    #[allow(clippy::too_many_arguments)]
    async fn spawn_child(
        &self,
        session_id: &str,
        opts_input: &str,
        plan: &TranscodePlan,
        dir: &PathBuf,
        start_secs: u64,
        source_codec: Option<&str>,
        source_avg_kbps: Option<u32>,
        media_kind: &str,
        start_number: u64,
    ) -> Result<Child, StartError> {
        let dir_str = dir.to_string_lossy();
        // Full-hardware VAAPI decode is gated on: the resolved encoder being
        // VAAPI, the boot probe having confirmed the VPP+encode chain
        // (`vaapi_hw_decode`), the SOURCE codec being one the iGPU can decode
        // — `-hwaccel_output_format vaapi` hard-fails with no software fallback
        // on an undecodable codec (e.g. MPEG-4/DivX) — and the plan being a
        // video re-encode without subtitle burn-in. The shared helper is also
        // what the CPU-cap accounting keys on, so they cannot drift.
        let hw_decode = self.uses_full_hw_pipeline(plan, source_codec);
        let args = ffmpeg_args_for(&ArgSpec {
            plan,
            input: opts_input,
            session_dir: &dir_str,
            start_secs,
            encoder: self.encoder,
            hw_decode,
            media_kind,
            start_number,
            source_avg_kbps,
        });
        let mut cmd = Command::new(&self.ffmpeg_bin);
        cmd.args(&args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = spawn_retrying_etxtbsy(&mut cmd)
            .await
            .map_err(|e| StartError::Spawn(e.to_string()))?;

        if let Some(stderr) = child.stderr.take() {
            let id = session_id.to_string();
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        tracing::warn!(session = %id, "ffmpeg: {trimmed}");
                    }
                }
            });
        }
        Ok(child)
    }

    /// Spawn the detached, best-effort one-shot subtitle extraction for a
    /// session, writing `<dir>/subtitles.vtt`. Fire-and-forget: the handle is
    /// moved onto a task that drains stderr and reaps the child (so it never
    /// lingers as a zombie), and any failure is LOGGED, never surfaced — the
    /// live transcode is wholly independent of the sidecar. Unlike the live HLS
    /// child this is a short pass (no `-re`, no HLS), so it does not go through
    /// the supervisor and is not restarted: a failed extraction simply leaves
    /// the title playing without selectable subs.
    async fn spawn_sidecar_subtitle(
        &self,
        session_id: &str,
        input: &str,
        dir: &std::path::Path,
        source_index: i64,
    ) {
        // Extract to a `.partial` sibling and atomically rename to the final
        // name only on a clean exit. A subtitle-only `-map` still demuxes the
        // WHOLE container to collect every cue, so on a large remux this pass
        // takes tens of seconds (≈54s on a UHD BluRay) — far longer than the
        // "near-instant" the name implies. Without the rename the asset route
        // would stream the still-growing (often 0-byte) file as a 200, the
        // player's one-shot <track> would load it empty, and — because segments
        // and this asset carry an `immutable` cache header — never recover. With
        // the rename, `subtitles.vtt` simply 404s until the cues are complete,
        // which the player retries through. (Per-session token ⇒ a prior
        // session's empty cache entry can never alias a new session's URL.)
        let out_path = dir.join(SIDECAR_SUBTITLE_NAME);
        let partial_path = dir.join(format!("{SIDECAR_SUBTITLE_NAME}.partial"));
        let args = sidecar_vtt_args(input, source_index, &partial_path.to_string_lossy());
        let mut cmd = Command::new(&self.ffmpeg_bin);
        cmd.args(&args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = match spawn_retrying_etxtbsy(&mut cmd).await {
            Ok(child) => child,
            Err(e) => {
                tracing::warn!(session = %session_id, error = %e, "failed to spawn sidecar subtitle extraction");
                return;
            }
        };
        let id = session_id.to_string();
        let stderr = child.stderr.take();
        tokio::spawn(async move {
            if let Some(stderr) = stderr {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        tracing::warn!(session = %id, "sidecar ffmpeg: {trimmed}");
                    }
                }
            }
            // Reap the one-shot child so it cannot linger as a zombie.
            match child.wait().await {
                Ok(status) if status.success() => {
                    // Atomic publish: the complete .vtt becomes visible to the
                    // asset route in a single rename. A failed rename leaves the
                    // `.partial` behind (never served — clients only ask for the
                    // final name), so the worst case is "no subtitles", never a
                    // truncated track.
                    match tokio::fs::rename(&partial_path, &out_path).await {
                        Ok(()) => tracing::debug!(session = %id, "sidecar subtitle extracted"),
                        Err(e) => tracing::warn!(
                            session = %id, error = %e,
                            "sidecar subtitle extracted but could not be published"
                        ),
                    }
                }
                Ok(status) => {
                    tracing::warn!(session = %id, %status, "sidecar subtitle extraction exited non-zero")
                }
                Err(e) => {
                    tracing::warn!(session = %id, error = %e, "sidecar subtitle extraction could not be awaited")
                }
            }
        });
    }

    /// Identity key for grant coalescing: a new grant matching a live session's
    /// (owner, media kind/id, sub, source path) is the same logical playback —
    /// the same title the same principal is already streaming — regardless of
    /// resume offset. The offset decides reuse-vs-supersede inside [`start`].
    ///
    /// [`start`]: SessionManager::start
    fn coalesce_key(opts: &StartOpts) -> String {
        // \u{1} (SOH) cannot appear in a filesystem path or these id fields, so
        // it is an unambiguous, collision-free field separator.
        format!(
            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
            opts.owner.as_deref().unwrap_or(""),
            opts.media_kind,
            opts.media_id,
            opts.sub,
            opts.input_path,
        )
    }

    /// Find a live session for the same coalesce identity as `opts`. Returns its
    /// id and whether it sits at the SAME resume offset (`true` → a duplicate to
    /// reuse; `false` → a stale session at a different offset, to supersede).
    /// Only heartbeat-fresh sessions (within the idle window) qualify, so we
    /// never hand back one the sweeper is about to reap.
    async fn find_owner_title_session(&self, opts: &StartOpts) -> Option<(SessionId, bool)> {
        let now = now_secs();
        let sessions = self.sessions.lock().await;
        sessions.iter().find_map(|(id, s)| {
            let same_title = s.info_kind == opts.media_kind
                && s.info_id == opts.media_id
                && s.sub == opts.sub
                && s.owner.as_deref() == opts.owner.as_deref()
                && s.input_path == opts.input_path
                && now.saturating_sub(s.last_seen) <= IDLE_TIMEOUT.as_secs();
            same_title.then(|| (id.clone(), s.start_secs == opts.start_secs))
        })
    }

    /// Start a session. Acquires a concurrency permit (mapping a cap hit to
    /// [`StartError::Busy`] → 503 transcoder_busy), creates the tmpdir, spawns
    /// ffmpeg, and registers the session. Returns the session id.
    ///
    /// Duplicate / rapid-retry grants are COALESCED: a per-identity gate
    /// serializes same-title starts, and inside it a grant that matches a live
    /// session at the same resume offset reuses that session (no second slot),
    /// while one at a DIFFERENT offset supersedes the stale session (stops it so
    /// its slot frees) before starting fresh. This is what turns a re-tap of a
    /// still-draining CPU-capped title from a 503 into instant playback.
    pub async fn start(&self, opts: StartOpts) -> Result<SessionId, StartError> {
        // Defense-in-depth path confinement (§ audit 1-3). When media roots are
        // configured, the source path MUST lexically resolve (incl. `..`) under
        // one of them. principal_layer already gates WHO may call grant; this
        // bounds WHAT ffmpeg may be pointed at even for an authorized caller, so
        // a crafted source_path cannot read arbitrary container files. Checked
        // before acquiring a permit so a rejected request consumes no slot.
        if !self.media_roots.is_empty() && !path_within_roots(&opts.input_path, &self.media_roots) {
            return Err(StartError::Forbidden(opts.input_path.clone()));
        }

        // Remember this title's directory so the keyframe warmer prioritizes it
        // (and its sibling episodes — a season folder) over the rest of the
        // library. Makes the NEXT episode of what you're watching a VOD scrubber
        // instead of a "live"/stalling EVENT playlist.
        if let Some(parent) = std::path::Path::new(&opts.input_path).parent() {
            self.note_hot_dir(parent.to_path_buf()).await;
        }

        // Grant coalescing / supersede (CPU-cap relief). Acquire the per-identity
        // gate FIRST so two SIMULTANEOUS grants for the same title can't both
        // race past the cap: the second blocks here until the first has
        // registered its session, then coalesces onto it below.
        let gate = {
            let mut gates = self.start_gates.lock().await;
            gates
                .entry(Self::coalesce_key(&opts))
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _gate = gate.lock().await;

        match self.find_owner_title_session(&opts).await {
            // Same title, same offset → duplicate/retry: reuse the live session.
            // The client gets the same manifest and we burn no second (scarce,
            // CPU-capped) slot — the fix for the "temporarily unavailable" 503 a
            // re-tap of a still-draining title produced.
            Some((existing, true)) => {
                tracing::info!(
                    session = %existing,
                    media_kind = %opts.media_kind,
                    media_id = opts.media_id,
                    "coalescing duplicate grant onto live session (no new slot)"
                );
                return Ok(existing);
            }
            // Same title, DIFFERENT offset → the prior session is stale (the user
            // re-opened at a new resume point; its abandoned client otherwise
            // lingers until the 30s idle reap). Stop it so its slot frees for the
            // fresh start instead of the new grant 503ing against the single CPU
            // slot the dead session still pins.
            Some((stale, false)) => {
                tracing::info!(
                    session = %stale,
                    media_kind = %opts.media_kind,
                    media_id = opts.media_id,
                    "superseding stale same-title session at a new resume offset"
                );
                self.stop(&stale).await;
            }
            None => {}
        }

        // Charge the stricter CPU cap for every session that does REAL work on
        // the CPU. Two rules, both load-based (not encoder-family-based):
        //
        // * A copy-remux (most local titles — they transcode only because the
        //   container/audio isn't browser-safe) uses ~no CPU regardless of
        //   encoder, so it counts against the global cap alone. Without this,
        //   a box with no HW encoder throttled the household to ONE stream and
        //   a second title 503'd.
        // * A video re-encode charges the CPU cap UNLESS it runs the full-HW
        //   VAAPI pipeline (GPU decode + VPP + encode). Keying on the encoder
        //   family alone under-counted: a VAAPI-encode session whose
        //   decode/tone-map/scale run in software (probe failed, source codec
        //   not iGPU-decodable, subtitle burn) still hammers the CPU — a 4K
        //   HDR software decode+tonemap saturates cores even though `-c:v` is
        //   h264_vaapi.
        let cpu_charge = opts.plan.reencodes_video()
            && !self.uses_full_hw_pipeline(&opts.plan, opts.source_codec.as_deref());
        let permit = self
            .limiter
            .try_acquire(cpu_charge)
            .map_err(StartError::Busy)?;

        let now = now_secs();
        let session_id = format!(
            "tx:{}:{}:{}:{}-{}",
            sanitize(&opts.media_kind),
            opts.media_id,
            sanitize(&opts.sub),
            now,
            START_SEQ.fetch_add(1, Ordering::Relaxed),
        );
        // Defensive same-key handling: the sequence suffix makes a collision
        // unreachable, but if one ever appears anyway, fully stop (kill + reap
        // + dir removal) the previous session BEFORE creating the dir — two
        // encoders must never share a session dir.
        if self.sessions.lock().await.contains_key(&session_id) {
            tracing::warn!(session = %session_id, "session id collision; stopping previous session");
            self.stop(&session_id).await;
        }
        let dir = self.tmp_root.join(sanitize(&session_id));
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| StartError::Io(e.to_string()))?;

        // Kick the one-shot sidecar subtitle extraction (best-effort, detached):
        // a SEPARATE short ffmpeg pass writes a complete subtitles.vtt beside the
        // segments without -re/HLS, so it never delays the live stream's first
        // segment (the stall that killed inline extraction). A failure just means
        // the title plays without selectable subs — start never blocks on it.
        if let Some(idx) = opts.subtitle.as_ref().map(|s| s.source_index) {
            self.spawn_sidecar_subtitle(&session_id, &opts.input_path, &dir, idx)
                .await;
        }

        // Trick-play thumbnails (TRANSCODER_TRICKPLAY, default ON since S5):
        // a detached one-shot samples the source into tiny all-keyframe segments
        // for AVPlayer's scrubbing preview. Re-encode only — the synthesized VOD
        // media playlist + uniform keyframe grid is what makes the master's
        // rendition coherent (a copy-remux session has no encoder to add one
        // cheaply). See [`crate::trickplay`].
        if crate::trickplay::enabled() && opts.plan.reencodes_video() {
            self.spawn_trickplay_thumbs(&session_id, &opts.input_path, &dir);
        }

        // Alternate-audio renditions (experimental; TRANSCODER_ALT_AUDIO, default
        // OFF): for each EXTRA audio track the plan selected, a detached one-shot
        // segments that track into its own `audio_{n}.m3u8` rendition beside the
        // segments — the URI the native master advertises. The primary stays
        // muxed in-band, so the main stream is untouched; a failed pass just
        // drops that one language from the picker. Native + multi-track only
        // (empty `extra_audio` otherwise). See [`crate::trickplay`].
        if crate::trickplay::alt_audio_enabled()
            && let TranscodePlan::Transcode { extra_audio, .. } = &opts.plan
        {
            self.spawn_audio_renditions(&session_id, &opts.input_path, &dir, extra_audio);
        }

        // Native full-timeline VOD alignment: a session writes its first segment at
        // the ABSOLUTE grid index so the synthesized [0,total] manifest references
        // on-disk files one-for-one and AVPlayer's scrubber shows true position /
        // full duration. `#EXT-X-START` (in the manifest) carries the resume point.
        //
        // RE-ENCODE: `-force_key_frames` puts cuts on a clean grid, so quantize the
        // seek DOWN to the segment grid and number it `⌊start/seg⌋`; playback is at
        // most one segment early — imperceptible.
        //
        // COPY-remux: segments are cut at the source's RAGGED keyframes. The same
        // `vod_manifest::copy_resume_base` the manifest uses maps the offset to
        // (start_idx, base) on the full-title cut grid; we spawn `-ss base` +
        // `-start_number start_idx` so the suffix segments land at their absolute
        // slots. Requires a keyframe-cache HIT and a known duration (the manifest
        // path needs both too); on a MISS / unknown duration we fall back to raw
        // `-ss` + start_number 0, exactly matching the manifest's MISS→on-disk
        // (EVENT) fallback, so the two stay consistent — the next play after the
        // cache warms gets the full-timeline scrubber.
        let seg = u64::from(crate::args::HLS_SEGMENT_SECS);
        let (eff_start, eff_start_number) = if opts.start_secs == 0 {
            (0, 0)
        } else if opts.plan.reencodes_video() {
            let n = opts.start_secs / seg;
            (n * seg, n)
        } else {
            // COPY-remux resume: align to the full-title keyframe grid iff we can
            // (cache hit + known duration). Mirrors `vod_manifest`'s copy branch.
            let duration = opts.duration_secs.filter(|d| *d > 0).map(|d| d as f64);
            match duration {
                Some(total) => match crate::keyframes::load(
                    &self.cache_root,
                    std::path::Path::new(&opts.input_path),
                )
                .await
                {
                    Some(kf) if !kf.is_empty() => {
                        let (start_idx, base) =
                            crate::vod_manifest::copy_resume_base(&kf, total, opts.start_secs);
                        // `-ss eff` + `-start_number start_idx`. session.start_secs is
                        // set to `eff` below, and the manifest re-derives (start_idx,
                        // base) from it via the SAME helper, so the two must agree.
                        // `base` is a fractional keyframe PTS; storing it truncated
                        // (`base as u64`) would re-derive a SMALLER index (the helper
                        // picks the largest bound <= start_secs), so use CEIL — it
                        // sits in [base, next_bound) and round-trips to the same
                        // start_idx. ffmpeg's `-ss` before `-i` snaps to the keyframe
                        // at/before `eff`, i.e. `base`, so the on-disk suffix still
                        // starts exactly at `base`.
                        let eff = base.ceil() as u64;
                        (eff, start_idx)
                    }
                    _ => (opts.start_secs, 0),
                },
                None => (opts.start_secs, 0),
            }
        };

        let child = self
            .spawn_child(
                &session_id,
                &opts.input_path,
                &opts.plan,
                &dir,
                eff_start,
                opts.source_codec.as_deref(),
                opts.source_avg_kbps,
                &opts.media_kind,
                eff_start_number,
            )
            .await?;

        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let session = Session {
            info_kind: opts.media_kind,
            info_id: opts.media_id,
            sub: opts.sub,
            dir,
            started_at: now,
            last_seen: now,
            start_secs: eff_start,
            start_number: eff_start_number,
            restarts: 0,
            ctl: ctl_tx,
            _permit: permit,
            plan: opts.plan,
            input_path: opts.input_path,
            source_codec: opts.source_codec,
            source_avg_kbps: opts.source_avg_kbps,
            duration_secs: opts.duration_secs,
            owner: opts.owner,
            subtitle: opts.subtitle,
            audio_tracks: opts.audio_tracks,
        };

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), session);
        self.spawn_supervisor(session_id.clone(), child, ctl_rx);
        Ok(session_id)
    }

    /// Refresh a session's heartbeat. Returns `false` for an unknown id so the
    /// route can answer 404 — a client whose session was reaped must be able
    /// to detect the death instead of heart-beating a ghost forever.
    pub async fn heartbeat(&self, id: &str) -> bool {
        match self.sessions.lock().await.get_mut(id) {
            Some(s) => {
                s.last_seen = now_secs();
                true
            }
            None => false,
        }
    }

    /// The owner (verified principal sub) of a session. Outer `None` = no such
    /// session; `Some(None)` = the session exists but was created without a
    /// verified principal (Off/log posture).
    pub async fn session_owner(&self, id: &str) -> Option<Option<String>> {
        self.sessions.lock().await.get(id).map(|s| s.owner.clone())
    }

    /// Seek: ask the supervisor to kill the current ffmpeg and respawn it with
    /// a new `-ss` offset (ffmpeg can't seek a live HLS encode in place). The
    /// supervisor — the sole owner of the Child — performs the kill, the dir
    /// clear, and the respawn, so the old process is provably dead before the
    /// new one writes into the dir (the old map-side `child.take()` found
    /// `None` in steady state and left the first ffmpeg racing the second).
    /// Returns `false` for an unknown session or a failed respawn.
    pub async fn seek(&self, id: &str, to_secs: u64) -> bool {
        let ctl = {
            let mut guard = self.sessions.lock().await;
            let Some(s) = guard.get_mut(id) else {
                return false;
            };
            s.start_secs = to_secs;
            s.last_seen = now_secs();
            s.ctl.clone()
        };
        // Send + await OUTSIDE the map lock: the supervisor takes the lock to
        // snapshot respawn params, so holding it here would deadlock.
        let (ack_tx, ack_rx) = oneshot::channel();
        if ctl.send(SessionCmd::Restart { ack: ack_tx }).is_err() {
            return false; // supervisor already exited (session torn down)
        }
        matches!(
            tokio::time::timeout(CTL_ACK_TIMEOUT, ack_rx).await,
            Ok(Ok(true))
        )
    }

    /// Stop and remove a session: SIGTERM, then SIGKILL after a grace period,
    /// then remove the tmpdir. Idempotent. Mirrors `stopRemuxSession`.
    pub async fn stop(&self, id: &str) {
        let removed = self.sessions.lock().await.remove(id);
        let Some(s) = removed else { return };
        // Ask the supervisor (sole Child owner) to kill the real ffmpeg and
        // confirm it is dead BEFORE removing the dir — removing first would let
        // a still-running encoder recreate segments (or pin tmpfs space via its
        // open fds). A send/recv failure means the supervisor already exited,
        // i.e. the process is already reaped.
        let (ack_tx, ack_rx) = oneshot::channel();
        if s.ctl.send(SessionCmd::Shutdown { ack: ack_tx }).is_ok() {
            let _ = tokio::time::timeout(CTL_ACK_TIMEOUT, ack_rx).await;
        }
        remove_dir_logged(&s.dir, id, "stop").await;
        // Permit drops with `s` here, freeing the concurrency slot.
    }

    /// Inventory of live sessions (§4.5 phase 7).
    pub async fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .await
            .iter()
            .map(|(id, s)| s.info(id))
            .collect()
    }

    /// Path to a session's playlist, if it exists in the map.
    pub async fn manifest_path(&self, id: &str) -> Option<PathBuf> {
        self.sessions
            .lock()
            .await
            .get(id)
            .map(|s| s.manifest_path())
    }

    /// Build a complete VOD playlist for `id`, for serving to native (AVPlayer)
    /// clients instead of the growing on-disk EVENT playlist (which AVKit renders
    /// as a live stream). `None` when the session is unknown, has no known
    /// duration, OR is a COPY-remux — callers then fall back to the on-disk
    /// playlist.
    ///
    /// Synthesis assumes uniform `HLS_SEGMENT_SECS` segments. That holds ONLY
    /// when the video is RE-ENCODED: `-force_key_frames` then pins a keyframe
    /// (and thus a segment cut) to every boundary, so the on-disk segments line
    /// up one-for-one with the synthesized list. A COPY-remux — HEVC→fMP4 or
    /// H264→TS — has nothing to force: ffmpeg cuts at the SOURCE's own
    /// keyframes, yielding ragged, variable-length segments whose count and
    /// durations can't be predicted up front (a 43-min HEVC copy produces ~587
    /// uneven segments, not the `ceil(dur/2)`=1304 uniform ones synthesis would
    /// claim). A synthesized manifest then disagrees with the real files on BOTH
    /// count and per-segment `EXTINF`, and AVPlayer aborts with
    /// `CoreMediaErrorDomain -4`. For copy sessions we therefore return `None`:
    /// the caller serves ffmpeg's REAL on-disk playlist, which always matches
    /// the segments and gains `#EXT-X-ENDLIST` (LIVE badge → finite scrubber)
    /// once the faster-than-realtime remux completes.
    pub async fn vod_manifest(&self, id: &str) -> Option<String> {
        // Snapshot what synthesis needs, then drop the map lock — the copy path
        // touches the keyframe cache (disk IO) and must not hold it across that.
        let (reencodes, fmp4, duration_opt, start_secs, input_path) = {
            let guard = self.sessions.lock().await;
            let s = guard.get(id)?;
            let fmp4 = matches!(
                &s.plan,
                TranscodePlan::Transcode {
                    segment_format: SegmentFormat::Fmp4,
                    ..
                }
            );
            (
                s.plan.reencodes_video(),
                fmp4,
                s.duration_secs.filter(|d| *d > 0),
                s.start_secs,
                s.input_path.clone(),
            )
        };
        let duration = duration_opt? as f64;

        if reencodes {
            // RE-ENCODE: `-force_key_frames` makes segments uniform, so the list
            // is derivable from the duration alone.
            return crate::vod_manifest::synthesize(duration, start_secs, fmp4);
        }

        // COPY-remux: segments are cut at the SOURCE's own (irregular) keyframes,
        // so the finite VOD list can only come from the keyframe map. On a cache
        // HIT, synthesize a real scrubber; on a MISS, return None (caller serves
        // the on-disk EVENT playlist) and warm the cache in the background so the
        // next play is a scrubber from 0:00 instead of "live". The hot path NEVER
        // blocks — first-play scrubbing is handled ahead of time by the browse
        // prewarm (media-core fires `POST /api/transcode/warm` for the continue
        // episode on detail open), using the seconds the user spends on the detail
        // page so the cache is hot by the time Play is pressed.
        match crate::keyframes::load(&self.cache_root, std::path::Path::new(&input_path)).await {
            Some(kf) => crate::vod_manifest::synthesize_copy(&kf, duration, start_secs, fmp4),
            None => {
                self.spawn_keyframe_warm(input_path);
                None
            }
        }
    }

    /// Build the trick-play MASTER playlist for `id` (native + re-encode only),
    /// or `None` when the session is unknown, is a COPY-remux, or has no known
    /// duration — the caller then serves the plain (synthesized) media playlist.
    ///
    /// Gated identically to [`vod_manifest`](Self::vod_manifest)'s re-encode
    /// branch: only a RE-ENCODE session gets uniform, keyframe-aligned segments
    /// and a thumbnail rendition (the sampling pass in
    /// [`spawn_trickplay_thumbs`](Self::spawn_trickplay_thumbs) runs on the same
    /// gate). The env flag itself is checked in the route so this stays a pure
    /// data transform. `RESOLUTION` is omitted rather than fabricated (the source
    /// aspect isn't carried here); the variant plays fine without it.
    pub async fn trickplay_master(&self, id: &str) -> Option<String> {
        let (bandwidth_bps, subtitle, audio) = {
            let guard = self.sessions.lock().await;
            let s = guard.get(id)?;
            if !s.plan.reencodes_video() || s.duration_secs.filter(|d| *d > 0).is_none() {
                return None;
            }
            // Advertise the source's average bitrate as the variant BANDWIDTH (a
            // required attribute); fall back to a sane default when the grant
            // didn't carry one.
            let bandwidth_bps = s
                .source_avg_kbps
                .map(|kbps| kbps.saturating_mul(1000))
                .unwrap_or(6_000_000);
            (bandwidth_bps, s.subtitle.clone(), s.alt_audio_renditions())
        };
        // The I-frame rendition is real here (re-encode ⇒ the thumbnail pass runs
        // on the same gate). Alternate audio joins it when the flag is on.
        Some(crate::trickplay::master(
            bandwidth_bps,
            None,
            true,
            subtitle.as_ref(),
            &audio,
        ))
    }

    /// Build the MASTER playlist for a NATIVE session that needs one for a
    /// subtitle and/or an alternate-audio group but is NOT served by
    /// [`trickplay_master`](Self::trickplay_master) (i.e. a copy-remux, or a
    /// re-encode with trick-play disabled). Returns `None` when the session has
    /// neither a sidecar subtitle nor any advertised audio rendition, or when the
    /// finite VOD `media.m3u8` won't resolve (copy-remux without a keyframe
    /// cache) — the caller then falls through to the plain media playlist.
    /// Served to NATIVE clients only; web keeps the EVENT playlist + `<track>`.
    pub async fn native_master(&self, id: &str) -> Option<String> {
        let (subtitle, audio, bandwidth_bps) = {
            let guard = self.sessions.lock().await;
            let s = guard.get(id)?;
            let subtitle = s.subtitle.clone();
            let audio = s.alt_audio_renditions();
            // No rendition group to advertise ⇒ no master; fall through to the
            // plain media playlist (unchanged serving path).
            if subtitle.is_none() && audio.is_empty() {
                return None;
            }
            let bandwidth_bps = s
                .source_avg_kbps
                .map(|kbps| kbps.saturating_mul(1000))
                .unwrap_or(6_000_000);
            (subtitle, audio, bandwidth_bps)
        };
        // The master's variant points at media.m3u8, which serves vod_manifest —
        // only advertise the master when that will actually resolve. No I-frame
        // rendition: this path has no thumbnail pass (copy-remux / trick-play off).
        self.vod_manifest(id).await?;
        Some(crate::trickplay::master(
            bandwidth_bps,
            None,
            false,
            subtitle.as_ref(),
            &audio,
        ))
    }

    /// Build the subtitle MEDIA playlist (`subs.m3u8`) for `id`, or `None` when
    /// the session is unknown, has no sidecar subtitle, or no known duration.
    pub async fn subs_playlist(&self, id: &str) -> Option<String> {
        let duration = {
            let guard = self.sessions.lock().await;
            let s = guard.get(id)?;
            s.subtitle.as_ref()?;
            s.duration_secs.filter(|d| *d > 0)? as f64
        };
        crate::subs_manifest::subs_playlist(duration)
    }

    /// Build the trick-play I-FRAMES-ONLY playlist for `id` (native + re-encode
    /// only), or `None` on the same gate as [`trickplay_master`](Self::trickplay_master).
    /// Pure function of the known duration — the thumbnail segments it lists are
    /// produced asynchronously by the sampling pass and 404 gracefully until
    /// written (see [`crate::trickplay::iframe_playlist`]).
    pub async fn trickplay_iframe(&self, id: &str) -> Option<String> {
        let duration = {
            let guard = self.sessions.lock().await;
            let s = guard.get(id)?;
            if !s.plan.reencodes_video() {
                return None;
            }
            s.duration_secs.filter(|d| *d > 0)? as f64
        };
        crate::trickplay::iframe_playlist(duration)
    }

    /// Kick the detached, one-shot THUMBNAIL sampling pass for a re-encode
    /// session (best-effort; mirrors [`spawn_sidecar_subtitle`](Self::spawn_sidecar_subtitle)).
    /// A SEPARATE short ffmpeg process samples the source into tiny all-keyframe
    /// `thumb_%05d.ts` segments beside the main stream, with no `-re`/main-HLS
    /// coupling, so it never delays the live stream's first segment. A failure
    /// just means the title plays without scrubbing thumbnails — `start` never
    /// blocks on it. Only spawned when `TRANSCODER_TRICKPLAY` is enabled.
    fn spawn_trickplay_thumbs(&self, session_id: &str, input: &str, dir: &std::path::Path) {
        let args = crate::trickplay::thumb_args(
            input,
            &dir.to_string_lossy(),
            crate::trickplay::TRICKPLAY_INTERVAL_SECS,
            crate::trickplay::THUMB_WIDTH,
        );
        let mut cmd = Command::new(&self.ffmpeg_bin);
        cmd.args(&args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let id = session_id.to_string();
        tokio::spawn(async move {
            let mut child = match spawn_retrying_etxtbsy(&mut cmd).await {
                Ok(child) => child,
                Err(e) => {
                    tracing::warn!(session = %id, error = %e, "failed to spawn trickplay thumbnail pass");
                    return;
                }
            };
            let stderr = child.stderr.take();
            if let Some(stderr) = stderr {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        tracing::warn!(session = %id, "trickplay ffmpeg: {trimmed}");
                    }
                }
            }
            match child.wait().await {
                Ok(status) if status.success() => {
                    tracing::debug!(session = %id, "trickplay thumbnails complete")
                }
                Ok(status) => {
                    tracing::warn!(session = %id, %status, "trickplay thumbnail pass exited non-zero")
                }
                Err(e) => {
                    tracing::warn!(session = %id, error = %e, "trickplay thumbnail pass could not be awaited")
                }
            }
        });
    }

    /// Kick a detached, one-shot ffmpeg pass per EXTRA audio track (best-effort;
    /// mirrors [`spawn_trickplay_thumbs`](Self::spawn_trickplay_thumbs)). Each
    /// pass segments its one track into its own `audio_{n}.m3u8` rendition beside
    /// the main stream — no `-re`/main-HLS coupling, so it never delays the live
    /// stream's first segment. A failed pass just drops that language from the
    /// picker; `start` never blocks on it. Only called when `TRANSCODER_ALT_AUDIO`
    /// is enabled and the plan selected extra tracks.
    fn spawn_audio_renditions(
        &self,
        session_id: &str,
        input: &str,
        dir: &std::path::Path,
        extra_audio: &[(usize, crate::plan::AudioOp)],
    ) {
        for (audio_index, op) in extra_audio {
            let args = crate::trickplay::audio_rendition_args(
                input,
                &dir.to_string_lossy(),
                *audio_index,
                op,
            );
            let mut cmd = Command::new(&self.ffmpeg_bin);
            cmd.args(&args)
                .current_dir(dir)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            let id = session_id.to_string();
            let index = *audio_index;
            tokio::spawn(async move {
                let mut child = match spawn_retrying_etxtbsy(&mut cmd).await {
                    Ok(child) => child,
                    Err(e) => {
                        tracing::warn!(session = %id, index, error = %e, "failed to spawn audio rendition pass");
                        return;
                    }
                };
                let stderr = child.stderr.take();
                if let Some(stderr) = stderr {
                    use tokio::io::{AsyncBufReadExt, BufReader};
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            tracing::warn!(session = %id, index, "audio rendition ffmpeg: {trimmed}");
                        }
                    }
                }
                match child.wait().await {
                    Ok(status) if status.success() => {
                        tracing::debug!(session = %id, index, "audio rendition complete")
                    }
                    Ok(status) => {
                        tracing::warn!(session = %id, index, %status, "audio rendition pass exited non-zero")
                    }
                    Err(e) => {
                        tracing::warn!(session = %id, index, error = %e, "audio rendition pass could not be awaited")
                    }
                }
            });
        }
    }

    /// Probe + cache `path`'s keyframes in the background, deduped against any
    /// in-flight probe for the same file. Used on a copy-session manifest miss
    /// and by the boot warmer. Returns immediately; the cache is populated for a
    /// later play.
    pub fn spawn_keyframe_warm(&self, path: String) {
        let cache_root = self.cache_root.clone();
        let ffmpeg_bin = self.ffmpeg_bin.clone();
        let warming = self.warming.clone();
        tokio::spawn(async move {
            // Claim the path; bail if another probe already owns it.
            if !warming.lock().await.insert(path.clone()) {
                return;
            }
            let _ = crate::keyframes::ensure(&cache_root, &ffmpeg_bin, std::path::Path::new(&path))
                .await;
            warming.lock().await.remove(&path);
        });
    }

    /// Proactively populate the keyframe cache for the whole confined library so
    /// even a FIRST play of a copy-remux movie gets a finite VOD scrubber instead
    /// of the "live" badge. Deliberately gentle so it can never brown-out a
    /// co-tenant (Plex): it probes ONE file at a time, ONLY while no session is
    /// active (so it never competes with live playback for the library disk), and
    /// pauses between files. A full first pass over a large library takes hours
    /// but each file is cached once on durable scratch; thereafter copy movies
    /// are VOD from 0:00. Re-scans hourly to catch newly-added titles. Detached;
    /// runs for the process lifetime. No-op when no media roots are confined
    /// (dev/tests).
    pub async fn run_keyframe_warmer(&self) {
        if self.media_roots.is_empty() {
            return;
        }
        loop {
            let mut files = self.collect_video_files().await;
            // Prioritize the directories of recently-played titles so the show
            // you're actively bingeing warms first, ahead of a large library's
            // alphabetical tail. Pure reordering — the gentle one-at-a-time,
            // idle-gated throttling below is unchanged (Plex-safe).
            {
                let hot = self.hot_dirs.lock().await;
                if !hot.is_empty() {
                    files.sort_by_key(|p| {
                        let parent = std::path::Path::new(p)
                            .parent()
                            .map(std::path::Path::to_path_buf);
                        parent
                            .and_then(|pp| hot.iter().position(|h| *h == pp))
                            .map_or(usize::MAX, |idx| idx)
                    });
                }
            }
            let total = files.len();
            let mut warmed = 0u32;
            for path in files {
                let p = std::path::Path::new(&path);
                // Cheap skip for already-cached files (a stat + small read).
                if crate::keyframes::load(&self.cache_root, p).await.is_some() {
                    continue;
                }
                // Yield the disk entirely to live playback: wait until idle.
                while !self.is_empty().await {
                    tokio::time::sleep(WARM_IDLE_POLL).await;
                }
                if crate::keyframes::ensure(&self.cache_root, &self.ffmpeg_bin, p)
                    .await
                    .is_some()
                {
                    warmed += 1;
                }
                tokio::time::sleep(WARM_FILE_DELAY).await;
            }
            if warmed > 0 {
                tracing::info!(warmed, total, "keyframe warmer: pass complete");
            }
            tokio::time::sleep(WARM_RESCAN_INTERVAL).await;
        }
    }

    /// Spawn [`run_keyframe_warmer`] as a detached background task. Returns the
    /// handle (tests may abort it).
    pub fn spawn_keyframe_warmer(&self) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move { this.run_keyframe_warmer().await })
    }

    /// Recursively list video files under the confined media roots (by extension;
    /// keyframes are codec-agnostic). Best-effort: unreadable dirs are skipped.
    async fn collect_video_files(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack: Vec<PathBuf> = self.media_roots.clone();
        while let Some(dir) = stack.pop() {
            let mut rd = match tokio::fs::read_dir(&dir).await {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = rd.next_entry().await {
                let Ok(ft) = entry.file_type().await else {
                    continue;
                };
                let path = entry.path();
                if ft.is_dir() {
                    stack.push(path);
                } else if ft.is_file()
                    && path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| WARM_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                        .unwrap_or(false)
                {
                    out.push(path.to_string_lossy().into_owned());
                }
            }
        }
        out
    }

    /// True when a segment file for `id` exists on disk right now. Used by the
    /// native wait-for-segment path to poll for the encoder frontier without
    /// holding the sessions lock across the wait.
    pub async fn segment_exists(&self, id: &str, name: &str) -> bool {
        match self.asset_path(id, name).await {
            Some(path) => tokio::fs::try_exists(&path).await.unwrap_or(false),
            None => false,
        }
    }

    /// Resolve a named asset (an HLS segment or the playlist) inside a session's
    /// dir, defending against path traversal. The HLS manifest references
    /// segments by bare filename (`seg_%05d.ts`), so the player requests them
    /// relative to the manifest URL; this maps that name back to a file on disk.
    ///
    /// Returns `None` for an unknown session OR for any `name` that is not a
    /// single, safe path component (no `/`, `\`, `.` / `..`, or NUL) — so a
    /// crafted segment name can never escape the session dir to read library
    /// bytes the caller was not granted.
    pub async fn asset_path(&self, id: &str, name: &str) -> Option<PathBuf> {
        if !is_safe_segment_name(name) {
            return None;
        }
        let dir = self.sessions.lock().await.get(id).map(|s| s.dir.clone())?;
        Some(dir.join(name))
    }

    /// Number of live sessions.
    pub async fn len(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// True when no sessions are live.
    pub async fn is_empty(&self) -> bool {
        self.len().await == 0
    }

    /// Run one idle sweep: reap any session whose last heartbeat is older than
    /// [`IDLE_TIMEOUT`]. Returns the ids reaped (for tests/telemetry).
    pub async fn sweep_idle(&self) -> Vec<SessionId> {
        let now = now_secs();
        let stale: Vec<SessionId> = {
            let guard = self.sessions.lock().await;
            guard
                .iter()
                .filter(|(_, s)| now.saturating_sub(s.last_seen) > IDLE_TIMEOUT.as_secs())
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in &stale {
            tracing::info!(session = %id, "reaping idle transcode session");
            self.stop(id).await;
        }
        // Prune coalesce gates no `start` is currently holding (strong_count==1
        // means only the map's own Arc remains). Bounds the gate map — which
        // otherwise accrues one entry per distinct title/owner over the process
        // lifetime — without ever dropping a gate an in-flight start depends on.
        self.start_gates
            .lock()
            .await
            .retain(|_, g| Arc::strong_count(g) > 1);
        stale
    }

    /// Spawn the periodic idle-sweep task (5s cadence). Detached; returns the
    /// handle for tests.
    pub fn spawn_sweeper(&self) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await; // consume the immediate first tick
            loop {
                ticker.tick().await;
                this.sweep_idle().await;
            }
        })
    }

    /// Kill the current ffmpeg (if any) and respawn a fresh one for `id`.
    /// Used by the supervisor for both crash recovery and seek restarts; it is
    /// the ONLY respawn path, keeping the supervisor the sole Child owner.
    ///
    /// The resume position depends on `mode`:
    /// * [`RespawnMode::Seek`] — the session's `start_secs` was just set to
    ///   the seek target by `seek()`; honor it exactly.
    /// * [`RespawnMode::Crash`] — resume at the approximate FURTHEST-ENCODED
    ///   position (`spawn offset + segments_written × segment length`, derived
    ///   from the highest segment index in the session dir). Respawning at the
    ///   stale grant/seek offset silently rewound playback to the session's
    ///   start on every crash.
    ///
    /// Either way segment numbering continues from the furthest segment
    /// (`-start_number`), so numbering is MONOTONIC across respawns and a
    /// stale cached playlist can never alias an old segment name onto new
    /// media. The new spawn params are persisted to the session BEFORE the
    /// spawn so a further crash compounds from them and `SessionInfo` reports
    /// the real position.
    ///
    /// The session map is re-checked immediately before the dir is cleared AND
    /// again after the spawn, so a `stop()` racing this never has its removed
    /// dir recreated behind it (a leak on the bounded /scratch tmpfs) and never
    /// leaves an unsupervised encoder.
    async fn respawn(&self, id: &str, mode: RespawnMode) -> Respawn {
        let (input, plan, dir, start_secs, source_codec, source_avg_kbps, media_kind, prev_number) = {
            let guard = self.sessions.lock().await;
            let Some(s) = guard.get(id) else {
                return Respawn::Gone;
            };
            (
                s.input_path.clone(),
                s.plan.clone(),
                s.dir.clone(),
                s.start_secs,
                s.source_codec.clone(),
                s.source_avg_kbps,
                s.info_kind.clone(),
                s.start_number,
            )
        };
        // Derive the furthest-written segment BEFORE clearing the dir.
        let next_number = max_segment_index(&dir)
            .await
            .map_or(prev_number, |m| m.saturating_add(1).max(prev_number));
        let spawn_secs = match mode {
            RespawnMode::Seek => start_secs,
            RespawnMode::Crash => crash_resume_secs(start_secs, prev_number, next_number),
        };
        {
            let mut guard = self.sessions.lock().await;
            let Some(s) = guard.get_mut(id) else {
                return Respawn::Gone;
            };
            s.start_secs = spawn_secs;
            s.start_number = next_number;
        }
        // Clear the dir so the fresh ffmpeg writes against a clean playlist.
        // Without this, `append_list` re-writes index.m3u8 referencing new
        // segments while the player may still hold the old list — stale media
        // on every restart. (Numbering continuity is preserved by
        // `-start_number` above, not by keeping old files around.)
        remove_dir_logged(&dir, id, "pre-respawn clear").await;
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            tracing::warn!(session = %id, error = %e, "failed to recreate session dir for respawn");
            return Respawn::Failed;
        }
        match self
            .spawn_child(
                id,
                &input,
                &plan,
                &dir,
                spawn_secs,
                source_codec.as_deref(),
                source_avg_kbps,
                &media_kind,
                next_number,
            )
            .await
        {
            Ok(mut child) => {
                // A stop() may have removed the session while we spawned; kill
                // the fresh child and clean the recreated dir rather than
                // leaving either behind.
                if !self.sessions.lock().await.contains_key(id) {
                    kill_child(&mut child, id).await;
                    remove_dir_logged(&dir, id, "respawn raced stop").await;
                    return Respawn::Gone;
                }
                Respawn::Ok(child)
            }
            Err(e) => {
                tracing::warn!(session = %id, error = %e, "ffmpeg respawn failed");
                Respawn::Failed
            }
        }
    }

    /// Supervisor task: the SOLE owner of this session's ffmpeg child. It
    /// watches for an UNEXPECTED exit and restarts with exponential backoff up
    /// to [`MAX_RESTARTS`], and services [`SessionCmd`]s from `seek()`/`stop()`
    /// — which never touch a process directly — killing/respawning the child
    /// itself so a kill always reaches the real process.
    fn spawn_supervisor(
        &self,
        id: SessionId,
        child: Child,
        mut ctl: mpsc::UnboundedReceiver<SessionCmd>,
    ) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut slot = ChildSlot::Running(child);
            // When the CURRENT child was spawned, and how long the child that
            // most recently CRASHED had run. A long-enough run resets the
            // restart budget (see effective_restart_count); failed respawns
            // record ZERO so a permanently-broken respawn can never reset its
            // own budget into a retry livelock.
            let mut spawned_at = std::time::Instant::now();
            let mut last_run = Duration::ZERO;
            loop {
                slot = match slot {
                    ChildSlot::Running(mut child) => {
                        tokio::select! {
                            status = child.wait() => {
                                // A CLEAN exit (status 0) means ffmpeg reached
                                // EOF — the transcode is COMPLETE, not crashed.
                                // Restarting would re-run the whole title from
                                // seg_00000 and yank the segments the player is
                                // still draining; park instead and let the idle
                                // reaper (or a later seek) collect the session.
                                if matches!(status.as_ref(), Ok(st) if st.success()) {
                                    tracing::info!(
                                        session = %id,
                                        "ffmpeg completed (clean exit); keeping segments for drain"
                                    );
                                    ChildSlot::Completed
                                } else {
                                    let code = status.as_ref().ok().and_then(|st| st.code());
                                    tracing::warn!(session = %id, ?code, "ffmpeg exited unexpectedly");
                                    last_run = spawned_at.elapsed();
                                    ChildSlot::Crashed
                                }
                            }
                            cmd = ctl.recv() => match cmd {
                                Some(SessionCmd::Restart { ack }) => {
                                    kill_child(&mut child, &id).await;
                                    match this.respawn(&id, RespawnMode::Seek).await {
                                        Respawn::Ok(new) => {
                                            let _ = ack.send(true);
                                            spawned_at = std::time::Instant::now();
                                            ChildSlot::Running(new)
                                        }
                                        Respawn::Failed => {
                                            let _ = ack.send(false);
                                            last_run = Duration::ZERO;
                                            ChildSlot::Crashed
                                        }
                                        Respawn::Gone => {
                                            let _ = ack.send(false);
                                            return;
                                        }
                                    }
                                }
                                Some(SessionCmd::Shutdown { ack }) => {
                                    kill_child(&mut child, &id).await;
                                    let _ = ack.send(());
                                    return;
                                }
                                // Session dropped without a Shutdown (defensive
                                // — stop() always sends one): don't orphan the
                                // encoder.
                                None => {
                                    kill_child(&mut child, &id).await;
                                    return;
                                }
                            }
                        }
                    }

                    // Transcode finished; nothing to watch. Only a command can
                    // change anything: a seek revives the session, a stop (or
                    // the session being dropped) ends it.
                    ChildSlot::Completed => match ctl.recv().await {
                        Some(SessionCmd::Restart { ack }) => {
                            match this.respawn(&id, RespawnMode::Seek).await {
                                Respawn::Ok(new) => {
                                    let _ = ack.send(true);
                                    spawned_at = std::time::Instant::now();
                                    ChildSlot::Running(new)
                                }
                                Respawn::Failed => {
                                    let _ = ack.send(false);
                                    last_run = Duration::ZERO;
                                    ChildSlot::Crashed
                                }
                                Respawn::Gone => {
                                    let _ = ack.send(false);
                                    return;
                                }
                            }
                        }
                        Some(SessionCmd::Shutdown { ack }) => {
                            let _ = ack.send(());
                            return;
                        }
                        None => return,
                    },

                    // Crashed (or a respawn failed): retry with backoff under
                    // the restart cap, or tear the session down at the cap — a
                    // childless session must never sit idle holding its Permit.
                    ChildSlot::Crashed => {
                        let attempt = {
                            let mut guard = this.sessions.lock().await;
                            let Some(s) = guard.get_mut(&id) else { return };
                            // A sustained healthy run before this crash resets
                            // the budget: only consecutive short-lived children
                            // (a real crash-loop) accumulate toward the cap.
                            let reset = effective_restart_count(s.restarts, last_run);
                            if reset != s.restarts {
                                tracing::info!(
                                    session = %id,
                                    ran_secs = last_run.as_secs(),
                                    "child ran healthily before crashing; resetting restart budget"
                                );
                                s.restarts = reset;
                            }
                            if s.restarts >= MAX_RESTARTS {
                                tracing::warn!(
                                    session = %id,
                                    "ffmpeg exceeded restart cap; tearing down session"
                                );
                                let dir = s.dir.clone();
                                guard.remove(&id);
                                drop(guard);
                                remove_dir_logged(&dir, &id, "restart-cap teardown").await;
                                return;
                            }
                            s.restarts += 1;
                            s.restarts
                        };
                        // Consume the run measurement: a failed RESPAWN below
                        // re-enters this branch and must not reuse it.
                        last_run = Duration::ZERO;
                        // Exponential backoff: 100ms * 2^(attempt-1), capped at
                        // ~2s — but stay responsive to commands while waiting.
                        let backoff = Duration::from_millis(
                            100u64.saturating_mul(1 << (attempt - 1)).min(2_000),
                        );
                        tracing::warn!(session = %id, attempt, ?backoff, "restarting ffmpeg with backoff");
                        let mut pending_ack: Option<oneshot::Sender<bool>> = None;
                        tokio::select! {
                            _ = tokio::time::sleep(backoff) => {}
                            cmd = ctl.recv() => match cmd {
                                // A seek during backoff: respawn immediately
                                // (below) and ack with the outcome.
                                Some(SessionCmd::Restart { ack }) => pending_ack = Some(ack),
                                Some(SessionCmd::Shutdown { ack }) => {
                                    let _ = ack.send(());
                                    return;
                                }
                                None => return,
                            }
                        }
                        // A seek that landed during the backoff already updated
                        // start_secs to its target — honor it. A plain crash
                        // recovery resumes at the furthest-encoded position.
                        let mode = if pending_ack.is_some() {
                            RespawnMode::Seek
                        } else {
                            RespawnMode::Crash
                        };
                        let outcome = this.respawn(&id, mode).await;
                        if let Some(ack) = pending_ack {
                            let _ = ack.send(matches!(outcome, Respawn::Ok(_)));
                        }
                        match outcome {
                            Respawn::Ok(new) => {
                                spawned_at = std::time::Instant::now();
                                ChildSlot::Running(new)
                            }
                            Respawn::Failed => ChildSlot::Crashed,
                            Respawn::Gone => return,
                        }
                    }
                };
            }
        });
    }
}

/// Supervisor-local child state. The `Child` lives HERE (on the supervisor's
/// stack), never in the session map — single ownership is what makes every
/// kill reach the real process.
enum ChildSlot {
    Running(Child),
    /// Clean EOF: segments kept for the player to drain; revivable by seek.
    Completed,
    /// Unexpected exit or failed respawn: retried under [`MAX_RESTARTS`].
    Crashed,
}

/// Outcome of [`SessionManager::respawn`].
enum Respawn {
    Ok(Child),
    /// Spawn failed; the session still exists (the restart cap will bound retries).
    Failed,
    /// The session was removed while respawning; nothing left to supervise.
    Gone,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{AudioOp, SubtitleOp, VideoOp};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn remux_plan() -> TranscodePlan {
        TranscodePlan::Transcode {
            video: VideoOp::Copy,
            audio: AudioOp::Copy,
            subtitle: SubtitleOp::None,
            segment_format: crate::plan::SegmentFormat::MpegTs,
            audio_index: 0,
            extra_audio: Vec::new(),
            reason: "test".into(),
        }
    }

    /// Write a shell stub that imitates ffmpeg: it writes a fake index.m3u8 +
    /// one segment into the session dir (last arg ending in index.m3u8), then
    /// sleeps so the supervisor sees a long-lived child. `mode` controls
    /// behavior: "run" sleeps forever, "crash_once"/"crash" exit non-zero.
    fn write_stub(dir: &std::path::Path, mode: &str) -> PathBuf {
        let path = dir.join("ffmpeg_stub.sh");
        let mut f = std::fs::File::create(&path).unwrap();
        // The stub finds the index.m3u8 path among its args (the final arg)
        // and writes a fake playlist + segment beside it.
        let script = format!(
            "#!/bin/sh\n\
             for a in \"$@\"; do last=\"$a\"; done\n\
             d=$(dirname \"$last\")\n\
             mkdir -p \"$d\"\n\
             printf '%s' \"$$\" > \"$d/pid.txt\"\n\
             printf '%s\\n' \"$@\" > \"$d/args.txt\"\n\
             case \"$last\" in *subtitles.vtt.partial)\n\
               printf 'WEBVTT\\n' > \"$last\"; exit 0;; esac\n\
             printf '#EXTM3U\\n#EXT-X-VERSION:3\\n' > \"$last\"\n\
             printf 'seg' > \"$d/seg_00000.ts\"\n\
             if [ \"{mode}\" = crash ]; then exit 1; fi\n\
             sleep 30\n"
        );
        f.write_all(script.as_bytes()).unwrap();
        // Close the fd before chmod/exec to avoid an ETXTBSY race on exec.
        f.sync_all().unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    fn manager_with_stub(tmp: &tempfile::TempDir, stub: PathBuf) -> SessionManager {
        SessionManager::new(
            Limiter::new(Caps {
                max_total: 4,
                max_cpu: 4,
            }),
            stub.to_string_lossy().into_owned(),
            tmp.path().join("sessions"),
            HwEncoder::VideoToolbox, // non-CPU so we don't trip the cpu cap
        )
    }

    fn opts(input: &str) -> StartOpts {
        StartOpts {
            source_avg_kbps: None,
            media_kind: "movie".into(),
            media_id: 7,
            sub: "plex:42".into(),
            input_path: input.into(),
            plan: remux_plan(),
            start_secs: 0,
            source_codec: None,
            duration_secs: None,
            owner: None,
            subtitle: None,
            audio_tracks: Vec::new(),
        }
    }

    #[tokio::test]
    async fn hot_dirs_are_newest_first_deduped_and_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));

        mgr.note_hot_dir(PathBuf::from("/media/A")).await;
        mgr.note_hot_dir(PathBuf::from("/media/B")).await;
        assert_eq!(
            mgr.hot_dirs.lock().await.front().unwrap(),
            &PathBuf::from("/media/B"),
            "most-recent dir is warmed first"
        );

        // Re-playing A promotes it to the front WITHOUT a duplicate entry.
        mgr.note_hot_dir(PathBuf::from("/media/A")).await;
        {
            let hot = mgr.hot_dirs.lock().await;
            assert_eq!(hot.front().unwrap(), &PathBuf::from("/media/A"));
            assert_eq!(
                hot.iter()
                    .filter(|d| *d == &PathBuf::from("/media/A"))
                    .count(),
                1
            );
            assert_eq!(hot.len(), 2);
        }

        // Bounded so an unbounded play history can't grow the queue without limit.
        for i in 0..20 {
            mgr.note_hot_dir(PathBuf::from(format!("/media/s{i}")))
                .await;
        }
        let hot = mgr.hot_dirs.lock().await;
        assert_eq!(hot.len(), 12);
        assert_eq!(hot.front().unwrap(), &PathBuf::from("/media/s19"));
    }

    // ponytail: 1000x10ms (10s) ceiling, not the prior 200x10ms (2s) — real
    // subprocess scheduling under `cargo test`'s full-suite parallelism can
    // exceed 2s and flake these polls even though the code under test is
    // correct; widen if a loaded CI box still flakes.
    async fn wait_for<F>(mut cond: F)
    where
        F: FnMut() -> bool,
    {
        for _ in 0..1000 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not met within timeout");
    }

    /// Read the pid the stub wrote into the session dir (polling — the stub
    /// writes it asynchronously after spawn).
    async fn read_stub_pid(dir: &std::path::Path) -> i32 {
        let path = dir.join("pid.txt");
        for _ in 0..1000 {
            if let Ok(s) = std::fs::read_to_string(&path)
                && let Ok(pid) = s.trim().parse::<i32>()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("stub never wrote pid.txt");
    }

    /// True while `pid` is signalable. tokio reaps a killed child inside the
    /// supervisor's `wait()`, so a dead stub disappears (ESRCH) promptly.
    fn process_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[tokio::test]
    async fn start_writes_manifest_and_registers_session() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_stub(tmp.path(), "run");
        let mgr = manager_with_stub(&tmp, stub);

        let id = mgr.start(opts("/lib/movie.mkv")).await.unwrap();
        assert_eq!(mgr.len().await, 1);

        let manifest = mgr.manifest_path(&id).await.unwrap();
        // The stub writes the playlist asynchronously; poll for it.
        wait_for(|| manifest.exists()).await;
        let body = std::fs::read_to_string(&manifest).unwrap();
        assert!(body.contains("#EXTM3U"), "fake playlist written");

        mgr.stop(&id).await;
        assert!(mgr.is_empty().await);
        // Tmpdir is cleaned on stop.
        assert!(!manifest.exists());
    }

    #[tokio::test]
    async fn start_extracts_sidecar_subtitle_when_index_present() {
        // With a selected subtitle index, start kicks the detached one-shot
        // extraction; the stub (invoked with subtitles.vtt as its last/output
        // arg) writes that file into the session dir. It is served by the same
        // asset route as the segments (subtitles.vtt passes the safe-name gate).
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));

        let mut o = opts("/lib/movie.mkv");
        o.subtitle = Some(SidecarSubtitle {
            source_index: 2,
            language: None,
            forced: false,
        });
        let id = mgr.start(o).await.unwrap();

        let vtt = mgr.asset_path(&id, SIDECAR_SUBTITLE_NAME).await.unwrap();
        wait_for(|| vtt.exists()).await;

        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn start_without_subtitle_index_writes_no_sidecar() {
        // No selected subtitle → no extraction is spawned, so subtitles.vtt is
        // never created even though the main session is fully up.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));

        let id = mgr.start(opts("/lib/movie.mkv")).await.unwrap();
        let vtt = mgr.asset_path(&id, SIDECAR_SUBTITLE_NAME).await.unwrap();

        // Once the main manifest is up the session is fully started; the sidecar
        // must NOT exist (nothing was asked to extract).
        let manifest = mgr.manifest_path(&id).await.unwrap();
        wait_for(|| manifest.exists()).await;
        assert!(!vtt.exists(), "no sidecar without a selected subtitle");

        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn start_confines_source_path_to_media_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let media = tmp.path().join("media");
        std::fs::create_dir_all(&media).unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"))
            .with_media_roots(vec![media.clone()]);

        // A path under the configured root is allowed.
        let inside = media.join("movie.mkv");
        let id = mgr
            .start(opts(inside.to_str().unwrap()))
            .await
            .expect("path under media root must be allowed");
        mgr.stop(&id).await;

        // An absolute path outside the root is rejected (would read e.g.
        // /etc/passwd or a Plex token file on the container).
        let err = mgr
            .start(opts("/etc/passwd"))
            .await
            .expect_err("path outside media root must be Forbidden");
        assert!(matches!(err, StartError::Forbidden(_)), "got {err:?}");

        // A `../` traversal that escapes the root is rejected too.
        let escape = media.join("../../etc/passwd");
        let err = mgr
            .start(opts(escape.to_str().unwrap()))
            .await
            .expect_err("../ traversal must be Forbidden");
        assert!(matches!(err, StartError::Forbidden(_)), "got {err:?}");

        assert!(mgr.is_empty().await, "no rejected start may leak a session");
    }

    #[tokio::test]
    async fn start_without_media_roots_allows_any_path() {
        // Confinement is opt-in: with no roots configured the manager preserves
        // the prior behavior (dev / tests pass arbitrary paths).
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr
            .start(opts("/anywhere/at/all.mkv"))
            .await
            .expect("no roots configured => no confinement");
        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn heartbeat_refreshes_last_seen() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();

        let before = mgr.list().await[0].last_seen;
        // Force a stale last_seen, then heartbeat and confirm it advances past it.
        {
            let mut g = mgr.sessions.lock().await;
            g.get_mut(&id).unwrap().last_seen = before.saturating_sub(100);
        }
        assert!(mgr.heartbeat(&id).await, "live session heartbeat succeeds");
        let after = mgr.list().await[0].last_seen;
        assert!(after >= before, "heartbeat must refresh last_seen");
        mgr.stop(&id).await;
        // A reaped/unknown session reports the death instead of pretending ok.
        assert!(!mgr.heartbeat(&id).await, "dead session heartbeat is false");
    }

    #[tokio::test]
    async fn seek_respawns_with_new_offset() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        // Wait until the first child has written its playlist.
        let manifest = mgr.manifest_path(&id).await.unwrap();
        wait_for(|| manifest.exists()).await;

        assert!(mgr.seek(&id, 120).await, "seek must succeed");
        let info = &mgr.list().await[0];
        assert_eq!(info.start_secs, 120, "seek updates the offset");
        // Session is still alive (respawned), not torn down.
        assert_eq!(mgr.len().await, 1);
        // The respawned child rewrites the cleared playlist.
        wait_for(|| manifest.exists()).await;
        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn seek_terminates_previous_ffmpeg() {
        // Regression: seek used to take the Child out of the session map, but
        // the supervisor held the real handle across wait() — so the "kill"
        // found None and the OLD ffmpeg kept writing absolute-path segments
        // into the freshly-cleared dir alongside the new one. The supervisor
        // must kill the real process before the respawn touches the dir.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let dir = mgr.manifest_path(&id).await.unwrap();
        let dir = dir.parent().unwrap().to_path_buf();

        let old_pid = read_stub_pid(&dir).await;
        assert!(process_alive(old_pid), "first ffmpeg must be running");

        assert!(mgr.seek(&id, 90).await, "seek must succeed");
        // The first ffmpeg is dead by the time seek returns (kill + reap happen
        // before the respawn's ack); poll defensively for slow reaping.
        wait_for(|| !process_alive(old_pid)).await;

        // Exactly one fresh ffmpeg is running in the cleared dir.
        let new_pid = read_stub_pid(&dir).await;
        assert_ne!(new_pid, old_pid, "respawn must be a different process");
        assert!(process_alive(new_pid), "respawned ffmpeg must be running");
        assert_eq!(mgr.list().await[0].start_secs, 90);

        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn stop_terminates_ffmpeg_and_removes_dir() {
        // Regression: stop() had the same take-from-the-map no-op kill, leaving
        // the encoder running (GPU/CPU + tmpfs writes) with the session gone.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let dir = mgr.manifest_path(&id).await.unwrap();
        let dir = dir.parent().unwrap().to_path_buf();
        let pid = read_stub_pid(&dir).await;
        assert!(process_alive(pid));

        mgr.stop(&id).await;
        wait_for(|| !process_alive(pid)).await;
        assert!(!dir.exists(), "session dir must be removed after the kill");
        assert!(mgr.is_empty().await);
    }

    #[tokio::test]
    async fn failed_respawn_tears_down_session_at_restart_cap() {
        // Regression: a childless session (failed seek respawn) used to spin at
        // 50ms forever, holding its concurrency Permit. The supervisor must
        // keep retrying under the restart cap and tear the session down at it.
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_stub(tmp.path(), "run");
        let mgr = manager_with_stub(&tmp, stub.clone());
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let manifest = mgr.manifest_path(&id).await.unwrap();
        wait_for(|| manifest.exists()).await;

        // Make every respawn fail: the ffmpeg binary vanishes.
        std::fs::remove_file(&stub).unwrap();
        assert!(
            !mgr.seek(&id, 60).await,
            "seek must report the failed respawn"
        );
        // Cap'd retries (100+200+400ms backoff) then teardown — not an
        // immortal childless session. Poll generously.
        for _ in 0..400 {
            if mgr.is_empty().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            mgr.is_empty().await,
            "childless session must be torn down at the restart cap"
        );
    }

    #[tokio::test]
    async fn stop_during_crash_backoff_leaves_no_dir() {
        // Regression: the crash-restart path used to clear + recreate the
        // session dir BEFORE re-checking the map, so a stop() landing during
        // the backoff had its dir resurrected behind it — a leak on the
        // bounded /scratch tmpfs. The respawn now re-checks the map around the
        // dir work and cleans up when it lost the race.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "crash"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let dir = mgr.manifest_path(&id).await.unwrap();
        let dir = dir.parent().unwrap().to_path_buf();

        // Stop while the crashing child's supervisor is somewhere in its
        // crash → backoff → respawn cycle.
        mgr.stop(&id).await;
        assert!(mgr.is_empty().await);

        // Give any in-flight respawn time to finish losing the race, then the
        // dir must be gone (and stay gone).
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        assert!(!dir.exists(), "stopped session's dir must not be recreated");
    }

    #[tokio::test]
    async fn duplicate_grant_coalesces_onto_one_session_no_orphan() {
        // Two IDENTICAL grants (same kind/id/sub/path/offset) back-to-back —
        // e.g. a double-tap, or the app re-requesting a title whose previous
        // session is still draining. They must COALESCE onto a single live
        // session: the second returns the first's id, spawns no second ffmpeg,
        // and burns no second concurrency slot. (Previously they minted two
        // distinct sessions; with DV on the single CPU slot that 503'd the
        // user's own re-tap as "temporarily unavailable".)
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let a = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let b = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        assert_eq!(a, b, "identical grants must coalesce to the same session");
        assert_eq!(mgr.len().await, 1, "no second session is created");

        // One encoder, one slot — nothing orphaned.
        let dir_a = mgr.manifest_path(&a).await.unwrap();
        let pid_a = read_stub_pid(dir_a.parent().unwrap()).await;
        assert!(process_alive(pid_a));
        assert_eq!(mgr.limiter().active().0, 1, "exactly one slot held");

        mgr.stop(&a).await;
        wait_for(|| !process_alive(pid_a)).await;
        assert!(mgr.is_empty().await);
        assert_eq!(mgr.limiter().active(), (0, 0), "the single slot is freed");
    }

    #[tokio::test]
    async fn distinct_titles_in_same_second_get_distinct_sessions_no_orphan() {
        // The orphan-prevention property still holds for genuinely DIFFERENT
        // titles started in the same wall-clock second: the monotonic sequence
        // suffix makes their ids unique, so neither map insert displaces the
        // other (which would orphan a still-encoding ffmpeg).
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let a = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let b = mgr.start(opts("/lib/b.mkv")).await.unwrap();
        assert_ne!(a, b, "distinct titles must mint distinct ids");
        assert_eq!(mgr.len().await, 2, "both sessions must be live");

        let dir_a = mgr.manifest_path(&a).await.unwrap();
        let dir_b = mgr.manifest_path(&b).await.unwrap();
        assert_ne!(dir_a, dir_b);
        let pid_a = read_stub_pid(dir_a.parent().unwrap()).await;
        let pid_b = read_stub_pid(dir_b.parent().unwrap()).await;
        assert_ne!(pid_a, pid_b);
        assert!(process_alive(pid_a) && process_alive(pid_b));

        mgr.stop(&a).await;
        wait_for(|| !process_alive(pid_a)).await;
        assert!(process_alive(pid_b), "stopping a must not touch b");
        mgr.stop(&b).await;
        wait_for(|| !process_alive(pid_b)).await;
        assert!(mgr.is_empty().await);
    }

    #[tokio::test]
    async fn regrant_at_new_offset_supersedes_stale_session_freeing_the_slot() {
        // A re-open of the SAME title at a DIFFERENT resume offset (the user
        // backed out mid-watch, then resumed) must SUPERSEDE the stale session:
        // stop it (freeing its slot) and start fresh at the new offset — never
        // 503 against a single CPU slot the abandoned session still pins. Use
        // max_cpu=1 with a CPU re-encode so a leaked slot would force Busy.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(
            Limiter::new(Caps {
                max_total: 4,
                max_cpu: 1,
            }),
            write_stub(tmp.path(), "run").to_string_lossy().into_owned(),
            tmp.path().join("s"),
            HwEncoder::Cpu,
        );
        let first = mgr.start(encode_opts_id("/lib/a.mkv", 7)).await.unwrap();
        let resumed = StartOpts {
            start_secs: 120,
            ..encode_opts_id("/lib/a.mkv", 7)
        };
        let second = mgr
            .start(resumed)
            .await
            .expect("resume at a new offset must supersede, not 503");
        assert_ne!(first, second, "supersede starts a fresh session");
        assert_eq!(mgr.len().await, 1, "the stale session was stopped");
        assert_eq!(
            mgr.limiter().active(),
            (1, 1),
            "exactly one CPU slot held after supersede"
        );
        mgr.stop(&second).await;
    }

    #[test]
    fn segment_index_parses_only_segment_names() {
        assert_eq!(segment_index("seg_00000.ts"), Some(0));
        assert_eq!(segment_index("seg_00042.ts"), Some(42));
        assert_eq!(segment_index("seg_123456.ts"), Some(123456));
        assert_eq!(segment_index("index.m3u8"), None);
        assert_eq!(segment_index("args.txt"), None);
        assert_eq!(segment_index("seg_.ts"), None);
        assert_eq!(segment_index("seg_abc.ts"), None);
    }

    fn audio_track(lang: Option<&str>, title: Option<&str>) -> AudioTrack {
        AudioTrack {
            index: 1,
            codec: Some("aac".into()),
            channels: Some(2),
            language: lang.map(str::to_string),
            title: title.map(str::to_string),
        }
    }

    #[test]
    fn rendition_name_prefers_language_then_title_then_position() {
        // Language wins, and doubles as the display NAME (like the subs tag).
        let r = rendition_from(
            Some(&audio_track(Some("spa"), Some("Commentary"))),
            1,
            false,
            Some(1),
        );
        assert_eq!(r.name, "spa");
        assert_eq!(r.language.as_deref(), Some("spa"));
        assert_eq!(r.uri.as_deref(), Some("audio_1.m3u8"));
        assert!(!r.is_default);

        // No language ⇒ fall back to the track title; LANGUAGE is then omitted.
        let r = rendition_from(
            Some(&audio_track(None, Some("Director"))),
            2,
            false,
            Some(2),
        );
        assert_eq!(r.name, "Director");
        assert!(r.language.is_none());
        assert_eq!(r.uri.as_deref(), Some("audio_2.m3u8"));

        // Neither ⇒ a positional NAME (never empty — NAME is required).
        let r = rendition_from(Some(&audio_track(None, None)), 3, false, Some(3));
        assert_eq!(r.name, "Audio 4");

        // The in-band primary: DEFAULT, no URI, no track metadata.
        let r = rendition_from(None, 0, true, None);
        assert_eq!(r.name, "Audio 1");
        assert!(r.is_default);
        assert!(r.uri.is_none());
    }

    #[test]
    fn blank_language_falls_through_to_title() {
        // A whitespace-only tag must not become an empty NAME/LANGUAGE.
        let r = rendition_from(
            Some(&audio_track(Some("  "), Some("Extra"))),
            1,
            false,
            Some(1),
        );
        assert_eq!(r.name, "Extra");
        assert!(r.language.is_none());
    }

    #[test]
    fn audio_rendition_assets_are_recognized() {
        assert!(is_audio_rendition_asset("audio_1.m3u8"));
        assert!(is_audio_rendition_asset("audio_2_00000.ts"));
        // Not a rendition asset: the video variant, subs, iframe, arbitrary names.
        assert!(!is_audio_rendition_asset("media.m3u8"));
        assert!(!is_audio_rendition_asset("seg_00000.ts"));
        assert!(!is_audio_rendition_asset("subs.m3u8"));
        assert!(!is_audio_rendition_asset("audio_1.txt"));
    }

    #[test]
    fn restart_budget_resets_after_sustained_healthy_run() {
        // Regression: MAX_RESTARTS was session-lifetime — three transient
        // hiccups spread across a two-hour movie tore the session down exactly
        // like a tight crash-loop. A child that ran >= HEALTHY_RUN_RESET
        // resets the budget; short-lived children keep accumulating.
        let healthy = HEALTHY_RUN_RESET;
        let almost = HEALTHY_RUN_RESET - Duration::from_secs(1);
        // At the cap, but the dead child ran healthily → budget resets to 0.
        assert_eq!(effective_restart_count(MAX_RESTARTS, healthy), 0);
        assert_eq!(
            effective_restart_count(MAX_RESTARTS, healthy + Duration::from_secs(3600)),
            0
        );
        // A short-lived child keeps the accumulated count (crash-loop).
        assert_eq!(effective_restart_count(2, almost), 2);
        assert_eq!(
            effective_restart_count(MAX_RESTARTS, Duration::ZERO),
            MAX_RESTARTS
        );
        // A failed respawn reports ZERO run time and must never reset —
        // otherwise a permanently-broken respawn retries forever.
        assert_eq!(effective_restart_count(1, Duration::ZERO), 1);
        // Fresh sessions are unaffected.
        assert_eq!(effective_restart_count(0, almost), 0);
    }

    #[test]
    fn crash_resume_math() {
        // Derive from the segment-length constant so a perf bump to
        // HLS_SEGMENT_SECS can't silently rot these literals (it did once).
        let secs = u64::from(crate::args::HLS_SEGMENT_SECS);
        // 2 segments (idx 0,1) written from a fresh start → resume at 2×seglen.
        assert_eq!(crash_resume_secs(0, 0, 2), 2 * secs);
        // Compounds from the crashed child's own spawn offset + numbering.
        assert_eq!(crash_resume_secs(100, 5, 10), 100 + 5 * secs);
        // No segments written → stay at the spawn offset.
        assert_eq!(crash_resume_secs(50, 3, 3), 50);
        // Defensive: never rewind even on an impossible numbering regression.
        assert_eq!(crash_resume_secs(50, 3, 2), 50);
    }

    #[tokio::test]
    async fn max_segment_index_finds_furthest_segment() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        assert_eq!(max_segment_index(&dir).await, None, "no segments yet");
        for name in ["seg_00003.ts", "seg_00007.ts", "index.m3u8", "args.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert_eq!(max_segment_index(&dir).await, Some(7));
        // Unreadable/missing dir → None, not a panic.
        assert_eq!(max_segment_index(&tmp.path().join("nope")).await, None);
    }

    /// A stub that CRASHES on its first invocation after writing two segments
    /// (simulating an encode that died ~8s in), then behaves like a healthy
    /// long-running ffmpeg on every later invocation, recording its argv.
    fn write_crash_once_stub(dir: &std::path::Path) -> PathBuf {
        let path = dir.join("ffmpeg_crash_once.sh");
        let flag = dir.join("crashed.flag");
        let mut f = std::fs::File::create(&path).unwrap();
        let script = format!(
            "#!/bin/sh\n\
             for a in \"$@\"; do last=\"$a\"; done\n\
             d=$(dirname \"$last\")\n\
             mkdir -p \"$d\"\n\
             if [ ! -f \"{flag}\" ]; then\n\
               : > \"{flag}\"\n\
               printf 'seg' > \"$d/seg_00000.ts\"\n\
               printf 'seg' > \"$d/seg_00001.ts\"\n\
               exit 1\n\
             fi\n\
             printf '%s\\n' \"$@\" > \"$d/args.txt\"\n\
             printf '#EXTM3U\\n' > \"$last\"\n\
             sleep 30\n",
            flag = flag.display()
        );
        f.write_all(script.as_bytes()).unwrap();
        // Close the fd before chmod/exec to avoid an ETXTBSY race on exec.
        f.sync_all().unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    /// Poll the respawned child's recorded argv until `pred` matches.
    async fn wait_for_args<F>(path: &std::path::Path, mut pred: F) -> Vec<String>
    where
        F: FnMut(&[String]) -> bool,
    {
        for _ in 0..200 {
            if let Ok(text) = std::fs::read_to_string(path) {
                let args: Vec<String> = text.lines().map(str::to_string).collect();
                if pred(&args) {
                    return args;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("expected argv never appeared at {}", path.display());
    }

    #[tokio::test]
    async fn crash_respawn_resumes_at_furthest_position_with_monotonic_numbering() {
        // Regression: a crash respawn re-used the stale grant/seek offset and
        // reset segment numbering to 0 — playback silently rewound to the
        // session start and new seg_00000.ts aliased the old one. The
        // supervisor must resume at ~the furthest-encoded position
        // (spawn offset + segments_written × seglen) and continue numbering.
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_crash_once_stub(tmp.path());
        let mgr = manager_with_stub(&tmp, stub);
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let dir = mgr.manifest_path(&id).await.unwrap();
        let dir = dir.parent().unwrap().to_path_buf();

        // The first child wrote seg_00000+seg_00001 then crashed; the healthy
        // respawn records its argv. Wait for a COMPLETE argv (both markers
        // present) — `> args.txt` truncates before the shell flushes content,
        // so a bare `|_| true` could read an empty/partial file and flake.
        let args = wait_for_args(&dir.join("args.txt"), |a| {
            a.iter().any(|s| s == "-ss") && a.iter().any(|s| s == "-start_number")
        })
        .await;
        let ss = args
            .iter()
            .position(|s| s == "-ss")
            .expect("crash respawn must bake a resume -ss");
        // 2 segments past offset 0, derived from the segment-length constant.
        let resume_secs = 2 * u64::from(crate::args::HLS_SEGMENT_SECS);
        assert_eq!(
            args[ss + 1],
            resume_secs.to_string(),
            "2 segments × seglen past offset 0: {args:?}"
        );
        let sn = args
            .iter()
            .position(|s| s == "-start_number")
            .expect("crash respawn must continue segment numbering");
        assert_eq!(args[sn + 1], "2", "numbering continues after seg_00001");

        // The session reports the resumed position, not the stale offset.
        assert_eq!(mgr.list().await[0].start_secs, resume_secs);
        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn seek_respawn_honors_target_but_keeps_numbering_monotonic() {
        // A seek must land exactly on its target (NOT the crash-resume
        // estimate), while segment numbering still advances past everything
        // already written so stale playlist entries can't alias new media.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let manifest = mgr.manifest_path(&id).await.unwrap();
        wait_for(|| manifest.exists()).await;
        let dir = manifest.parent().unwrap().to_path_buf();

        assert!(mgr.seek(&id, 120).await, "seek must succeed");
        let args = wait_for_args(&dir.join("args.txt"), |a| a.iter().any(|s| s == "120")).await;
        let ss = args.iter().position(|s| s == "-ss").expect("-ss");
        assert_eq!(args[ss + 1], "120", "seek target honored exactly");
        let sn = args
            .iter()
            .position(|s| s == "-start_number")
            .expect("seek respawn must keep numbering monotonic");
        assert_eq!(args[sn + 1], "1", "first child wrote seg_00000: {args:?}");
        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn idle_sweep_reaps_stale_session() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();

        // Backdate last_seen well past the 30s idle window.
        {
            let mut g = mgr.sessions.lock().await;
            g.get_mut(&id).unwrap().last_seen = now_secs().saturating_sub(120);
        }
        let reaped = mgr.sweep_idle().await;
        assert_eq!(reaped, vec![id]);
        assert!(mgr.is_empty().await, "stale session must be reaped");
    }

    #[tokio::test]
    async fn fresh_session_is_not_reaped() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let reaped = mgr.sweep_idle().await;
        assert!(
            reaped.is_empty(),
            "a just-started session must survive the sweep"
        );
        assert_eq!(mgr.len().await, 1);
        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn busy_when_global_cap_exhausted() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(
            Limiter::new(Caps {
                max_total: 1,
                max_cpu: 1,
            }),
            write_stub(tmp.path(), "run").to_string_lossy().into_owned(),
            tmp.path().join("s"),
            HwEncoder::VideoToolbox,
        );
        let _id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let err = mgr.start(opts("/lib/b.mkv")).await.unwrap_err();
        assert!(
            matches!(err, StartError::Busy(_)),
            "second start past cap must be Busy"
        );
    }

    fn remux_opts_id(input: &str, media_id: i64) -> StartOpts {
        StartOpts {
            source_avg_kbps: None,
            media_id,
            ..opts(input)
        }
    }

    fn encode_opts_id(input: &str, media_id: i64) -> StartOpts {
        StartOpts {
            source_avg_kbps: None,
            media_kind: "movie".into(),
            media_id,
            sub: "plex:42".into(),
            input_path: input.into(),
            plan: TranscodePlan::Transcode {
                segment_format: crate::plan::SegmentFormat::MpegTs,
                video: VideoOp::EncodeH264 {
                    scale_to_height: None,
                    tone_map: false,
                    burn_subtitle_index: None,
                    source_height: None,
                },
                audio: AudioOp::Copy,
                subtitle: SubtitleOp::None,
                audio_index: 0,
                extra_audio: Vec::new(),
                reason: "test".into(),
            },
            start_secs: 0,
            source_codec: Some("hevc".into()),
            duration_secs: None,
            owner: None,
            subtitle: None,
            audio_tracks: Vec::new(),
        }
    }

    #[tokio::test]
    async fn vod_manifest_synthesized_only_for_reencode_not_copy() {
        // Regression: Arcane S1E1 (HEVC Main 10 mkv) failed on AVPlayer with
        // CoreMediaErrorDomain -4 because the HEVC-copy fMP4 path got a
        // synthesized UNIFORM manifest (ceil(dur/2) equal-length segments) while
        // ffmpeg actually cut at source keyframes into far fewer, ragged
        // segments. A copy session may ONLY synthesize from the real keyframe
        // map; with NO cached keyframes (as here — the inputs don't exist) it
        // must fall back to the on-disk playlist (vod_manifest → None). The
        // cache-HIT path is covered by `copy_vod_synthesized_when_keyframes_cached`.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(
            Limiter::new(Caps {
                max_total: 4,
                max_cpu: 4,
            }),
            write_stub(tmp.path(), "run").to_string_lossy().into_owned(),
            tmp.path().join("s"),
            HwEncoder::Cpu,
        );

        // H264 copy → TS remux: variable segments → no synthesis.
        let copy_ts = mgr
            .start(StartOpts {
                duration_secs: Some(600),
                ..remux_opts_id("/lib/copy_ts.mkv", 1)
            })
            .await
            .unwrap();
        assert!(
            mgr.vod_manifest(&copy_ts).await.is_none(),
            "copy-to-TS remux must serve the real playlist, not a synthesized uniform one"
        );

        // HEVC copy → fMP4: the Arcane case. Variable segments → no synthesis.
        let hevc_fmp4 = mgr
            .start(StartOpts {
                duration_secs: Some(600),
                plan: TranscodePlan::Transcode {
                    video: VideoOp::Copy,
                    audio: AudioOp::Copy,
                    subtitle: SubtitleOp::None,
                    segment_format: crate::plan::SegmentFormat::Fmp4,
                    audio_index: 0,
                    extra_audio: Vec::new(),
                    reason: "hevc copy".into(),
                },
                ..remux_opts_id("/lib/arcane.mkv", 2)
            })
            .await
            .unwrap();
        assert!(
            mgr.vod_manifest(&hevc_fmp4).await.is_none(),
            "HEVC-copy fMP4 must serve the real playlist (Arcane -4 regression)"
        );

        // Re-encode → forced keyframes → uniform segments → synthesis is correct.
        let encode = mgr
            .start(StartOpts {
                duration_secs: Some(600),
                ..encode_opts_id("/lib/encode.mkv", 3)
            })
            .await
            .unwrap();
        let m = mgr
            .vod_manifest(&encode)
            .await
            .expect("a re-encode synthesizes a finite VOD playlist");
        assert!(m.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(m.trim_end().ends_with("#EXT-X-ENDLIST"));
    }

    #[tokio::test]
    async fn copy_vod_synthesized_when_keyframes_cached() {
        // With a warm keyframe cache, an HEVC-copy fMP4 session DOES synthesize a
        // finite VOD playlist from the source keyframes — a real scrubber, never
        // "live". (Cold cache → None is covered above.)
        let tmp = tempfile::tempdir().unwrap();
        let tmp_root = tmp.path().join("s");
        let mgr = SessionManager::new(
            Limiter::new(Caps {
                max_total: 4,
                max_cpu: 4,
            }),
            write_stub(tmp.path(), "run").to_string_lossy().into_owned(),
            tmp_root.clone(),
            HwEncoder::Cpu,
        );

        // A real source file so the cache's (mtime,size) identity check passes.
        let src = tmp.path().join("movie.mkv");
        std::fs::write(&src, b"not really a video, just an identity anchor").unwrap();
        let src_str = src.to_string_lossy().into_owned();
        crate::keyframes::seed_for_test(
            &tmp_root.join(crate::keyframes::KFCACHE_DIRNAME),
            &src,
            // A few ragged keyframes spanning [0, 30) (cf. the Goofy golden data).
            vec![0.0, 1.084, 11.511, 13.347, 23.774, 25.943],
        )
        .await;

        let sid = mgr
            .start(StartOpts {
                duration_secs: Some(30),
                plan: TranscodePlan::Transcode {
                    video: VideoOp::Copy,
                    audio: AudioOp::Copy,
                    subtitle: SubtitleOp::None,
                    segment_format: crate::plan::SegmentFormat::Fmp4,
                    audio_index: 0,
                    extra_audio: Vec::new(),
                    reason: "hevc copy".into(),
                },
                ..remux_opts_id(&src_str, 7)
            })
            .await
            .unwrap();

        let m = mgr
            .vod_manifest(&sid)
            .await
            .expect("cached keyframes → a synthesized VOD playlist");
        assert!(m.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(m.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert!(!m.contains("EVENT"));
        assert!(m.contains("seg_00000.m4s\n"), "fMP4 copy segments: {m}");
        // First segment runs to the first keyframe past the 2s grid (11.511s),
        // proving the ragged copy algorithm (not uniform 2s) drove synthesis.
        assert!(m.contains("#EXTINF:11.511000,\n"), "{m}");
    }

    #[test]
    fn vaapi_hw_decodable_allowlist() {
        for c in [
            "hevc", "H265", "h264", "AVC", "avc1", "av1", "vp9", " hevc ",
        ] {
            assert!(is_vaapi_hw_decodable(c), "{c} must be HW-decodable");
        }
        // MPEG-4 part 2 / DivX has no Intel HW decode → must fall back to SW.
        for c in [
            "mpeg4",
            "msmpeg4v3",
            "mpeg2video",
            "vc1",
            "mjpeg",
            "theora",
            "",
        ] {
            assert!(!is_vaapi_hw_decodable(c), "{c} must NOT be HW-decodable");
        }
    }

    #[tokio::test]
    async fn remux_does_not_charge_cpu_cap_on_cpu_encoder() {
        // No HW encoder → every session resolves to the CPU encoder. A
        // copy-remux must NOT charge the strict cpu cap, so two remuxes run
        // concurrently under max_cpu=1 (they only count against the roomy global
        // cap). Regression for the household "second title 503s" failure.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(
            Limiter::new(Caps {
                max_total: 4,
                max_cpu: 1,
            }),
            write_stub(tmp.path(), "run").to_string_lossy().into_owned(),
            tmp.path().join("s"),
            HwEncoder::Cpu,
        );
        let _a = mgr.start(remux_opts_id("/lib/a.mkv", 7)).await.unwrap();
        let _b = mgr
            .start(remux_opts_id("/lib/b.mkv", 8))
            .await
            .expect("a second copy-remux must start despite cpu cap 1");
        assert_eq!(mgr.len().await, 2);
    }

    #[tokio::test]
    async fn video_reencode_charges_cpu_cap_on_cpu_encoder() {
        // A real libx264 VIDEO re-encode DOES load the CPU, so it charges the
        // cpu cap — a second concurrent encode under max_cpu=1 is refused even
        // though the global cap (4) has room.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(
            Limiter::new(Caps {
                max_total: 4,
                max_cpu: 1,
            }),
            write_stub(tmp.path(), "run").to_string_lossy().into_owned(),
            tmp.path().join("s"),
            HwEncoder::Cpu,
        );
        let _a = mgr.start(encode_opts_id("/lib/a.mkv", 7)).await.unwrap();
        let err = mgr
            .start(encode_opts_id("/lib/b.mkv", 8))
            .await
            .unwrap_err();
        assert!(
            matches!(err, StartError::Busy(_)),
            "second CPU re-encode past the cpu cap must be Busy"
        );
    }

    /// Manager with a chosen encoder + caps {total 4, cpu 1} for the CPU-cap
    /// accounting matrix.
    fn cap_matrix_manager(
        tmp: &tempfile::TempDir,
        encoder: HwEncoder,
        vaapi_hw_decode: bool,
    ) -> SessionManager {
        SessionManager::new(
            Limiter::new(Caps {
                max_total: 4,
                max_cpu: 1,
            }),
            write_stub(tmp.path(), "run").to_string_lossy().into_owned(),
            tmp.path().join("s"),
            encoder,
        )
        .with_vaapi_hw_decode(vaapi_hw_decode)
    }

    #[tokio::test]
    async fn full_hw_vaapi_reencode_does_not_charge_cpu_cap() {
        // VAAPI with the full-HW pipeline confirmed + an iGPU-decodable source:
        // decode, VPP and encode all run on the GPU, so two concurrent
        // re-encodes must fit under max_cpu=1.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = cap_matrix_manager(&tmp, HwEncoder::Vaapi, true);
        let _a = mgr.start(encode_opts_id("/lib/a.mkv", 7)).await.unwrap();
        let _b = mgr
            .start(encode_opts_id("/lib/b.mkv", 8))
            .await
            .expect("full-HW re-encodes must not charge the cpu cap");
        assert_eq!(mgr.limiter().active(), (2, 0));
    }

    #[tokio::test]
    async fn vaapi_encode_with_software_decode_charges_cpu_cap() {
        // Same VAAPI encoder, but the SOURCE codec (mpeg4) has no iGPU decode:
        // the session software-decodes (and would software-tonemap/scale), so
        // it must be charged as CPU work even though -c:v is h264_vaapi.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = cap_matrix_manager(&tmp, HwEncoder::Vaapi, true);
        let sw_opts = |path: &str, id: i64| StartOpts {
            source_codec: Some("mpeg4".into()),
            ..encode_opts_id(path, id)
        };
        let _a = mgr.start(sw_opts("/lib/a.avi", 7)).await.unwrap();
        assert_eq!(mgr.limiter().active(), (1, 1), "sw-decode charges cpu");
        let err = mgr.start(sw_opts("/lib/b.avi", 8)).await.unwrap_err();
        assert!(
            matches!(err, StartError::Busy(Busy { cpu_cap: true })),
            "second software-decode re-encode must hit the cpu cap, got {err:?}"
        );
    }

    #[tokio::test]
    async fn vaapi_without_full_hw_probe_charges_cpu_cap() {
        // Full-HW probe failed (vaapi_hw_decode=false): every VAAPI re-encode
        // runs the software-decode path and must charge the CPU cap.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = cap_matrix_manager(&tmp, HwEncoder::Vaapi, false);
        let _a = mgr.start(encode_opts_id("/lib/a.mkv", 7)).await.unwrap();
        assert_eq!(mgr.limiter().active(), (1, 1));
        let err = mgr
            .start(encode_opts_id("/lib/b.mkv", 8))
            .await
            .unwrap_err();
        assert!(matches!(err, StartError::Busy(Busy { cpu_cap: true })));
    }

    #[tokio::test]
    async fn non_vaapi_hw_encoder_reencode_charges_cpu_cap() {
        // VideoToolbox/NVENC/QSV all software-decode and CPU-filter in this
        // pipeline; only the final encode is offloaded. They charge the cap.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = cap_matrix_manager(&tmp, HwEncoder::VideoToolbox, false);
        let _a = mgr.start(encode_opts_id("/lib/a.mkv", 7)).await.unwrap();
        let err = mgr
            .start(encode_opts_id("/lib/b.mkv", 8))
            .await
            .unwrap_err();
        assert!(matches!(err, StartError::Busy(Busy { cpu_cap: true })));
    }

    #[tokio::test]
    async fn remux_never_charges_cpu_cap_regardless_of_pipeline() {
        // A copy-remux does no encode work anywhere; it must stay off the CPU
        // cap on every encoder/pipeline combination.
        for (encoder, full_hw) in [
            (HwEncoder::Cpu, false),
            (HwEncoder::Vaapi, true),
            (HwEncoder::Vaapi, false),
            (HwEncoder::VideoToolbox, false),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let mgr = cap_matrix_manager(&tmp, encoder, full_hw);
            let _a = mgr.start(remux_opts_id("/lib/a.mkv", 7)).await.unwrap();
            let _b = mgr
                .start(remux_opts_id("/lib/b.mkv", 8))
                .await
                .unwrap_or_else(|e| panic!("remux must not charge cpu ({encoder:?}): {e:?}"));
            assert_eq!(mgr.limiter().active(), (2, 0), "{encoder:?}");
        }
    }

    #[tokio::test]
    async fn stop_is_idempotent_and_frees_slot() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(
            Limiter::new(Caps {
                max_total: 1,
                max_cpu: 1,
            }),
            write_stub(tmp.path(), "run").to_string_lossy().into_owned(),
            tmp.path().join("s"),
            HwEncoder::VideoToolbox,
        );
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        mgr.stop(&id).await;
        mgr.stop(&id).await; // second stop is a no-op
        // The slot is free again: a new session can start.
        let id2 = mgr.start(opts("/lib/c.mkv")).await.unwrap();
        assert_eq!(mgr.len().await, 1);
        mgr.stop(&id2).await;
    }

    #[test]
    fn safe_segment_name_whitelist() {
        assert!(is_safe_segment_name("seg_00000.ts"));
        assert!(is_safe_segment_name("index.m3u8"));
        assert!(!is_safe_segment_name(""));
        assert!(!is_safe_segment_name("."));
        assert!(!is_safe_segment_name(".."));
        assert!(!is_safe_segment_name("../secret"));
        assert!(!is_safe_segment_name("a/b"));
        assert!(!is_safe_segment_name("a\\b"));
        assert!(!is_safe_segment_name("/etc/passwd"));
    }

    #[tokio::test]
    async fn asset_path_resolves_segment_and_blocks_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();

        // A safe segment name resolves inside the session dir.
        let seg = mgr.asset_path(&id, "seg_00000.ts").await.unwrap();
        assert!(seg.ends_with("seg_00000.ts"));
        let dir = mgr.manifest_path(&id).await.unwrap();
        let dir = dir.parent().unwrap();
        assert!(
            seg.starts_with(dir),
            "segment must live under the session dir"
        );

        // Traversal attempts are rejected.
        assert!(mgr.asset_path(&id, "../../etc/passwd").await.is_none());
        assert!(mgr.asset_path(&id, "a/b.ts").await.is_none());
        // Unknown session → None even for a safe name.
        assert!(mgr.asset_path("tx:nope", "seg_00000.ts").await.is_none());

        mgr.stop(&id).await;
    }

    #[tokio::test]
    async fn manager_uses_resolved_encoder_for_ffmpeg_args() {
        // A manager built with a forced encoder must launch ffmpeg with THAT
        // encoder's -c:v, not whatever TRANSCODER_HW_ENCODER says. We assert on
        // the arg vector the manager would build for an encode plan.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(
            Limiter::new(Caps {
                max_total: 4,
                max_cpu: 4,
            }),
            "ffmpeg".into(),
            tmp.path().join("s"),
            HwEncoder::Cpu,
        );
        assert_eq!(mgr.encoder(), HwEncoder::Cpu);
        let plan = TranscodePlan::Transcode {
            segment_format: crate::plan::SegmentFormat::MpegTs,
            video: VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
                source_height: None,
            },
            audio: AudioOp::Copy,
            subtitle: SubtitleOp::None,
            audio_index: 0,
            extra_audio: Vec::new(),
            reason: "test".into(),
        };
        let args = crate::args::ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, mgr.encoder());
        let j = args.join(" ");
        assert!(
            j.contains("-c:v libx264"),
            "resolved CPU encoder must drive ffmpeg: {j}"
        );

        // is_cpu cap keying reflects the resolved encoder.
        assert!(mgr.encoder().is_cpu());
    }

    #[tokio::test]
    async fn supervisor_tears_down_after_restart_cap_on_crashing_ffmpeg() {
        let tmp = tempfile::tempdir().unwrap();
        // A stub that always exits 1: the supervisor restarts up to the cap,
        // then reaps the session.
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "crash"));
        let _id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        // After MAX_RESTARTS quick backoffs (~100+200+400ms) the supervisor
        // removes the session. Poll generously.
        for _ in 0..400 {
            if mgr.is_empty().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            mgr.is_empty().await,
            "crashing ffmpeg must be reaped after the restart cap"
        );
    }
}
