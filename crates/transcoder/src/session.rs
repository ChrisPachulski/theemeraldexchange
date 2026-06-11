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

use crate::args::{ArgSpec, HwEncoder, ffmpeg_args_for};
use crate::concurrency::{Busy, Caps, Limiter, Permit};
use crate::plan::TranscodePlan;

/// 30s with no heartbeat → reap (mirrors `IDLE_MS` in iptvRemux.ts).
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Idle sweep cadence.
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);
/// Grace period between SIGTERM and SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(5);
/// Supervisor restart cap before a session is declared failed.
const MAX_RESTARTS: u32 = 3;
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
    /// The VERIFIED principal's sub from the grant request, binding the session
    /// to its creator so stop/seek/heartbeat can enforce owner-or-admin.
    /// `None` only in the Off/log postures where no verified identity exists
    /// (routes skip enforcement accordingly).
    pub owner: Option<String>,
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
    /// Verified principal sub that created the session (owner-or-admin gate).
    owner: Option<String>,
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
    if tokio::time::timeout(KILL_GRACE, child.wait()).await.is_err() {
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
fn segment_index(name: &str) -> Option<u64> {
    name.strip_prefix("seg_")?.strip_suffix(".ts")?.parse().ok()
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

/// Approximate furthest-encoded position for a crash respawn: the offset the
/// crashed child was spawned at (`spawn_secs`, its baked `-ss`) plus the
/// segments it wrote (`next_number - prev_number`) times the segment length.
/// Pure so the math is unit-testable without a real crash.
fn crash_resume_secs(spawn_secs: u64, prev_number: u64, next_number: u64) -> u64 {
    spawn_secs
        + next_number.saturating_sub(prev_number) * u64::from(crate::args::HLS_SEGMENT_SECS)
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
        SessionManager {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            limiter,
            ffmpeg_bin,
            tmp_root,
            encoder,
            media_roots: Vec::new(),
            vaapi_hw_decode: false,
        }
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

    /// The hardware encoder this manager launches ffmpeg with (the resolved
    /// family once boot detection has run).
    pub fn encoder(&self) -> HwEncoder {
        self.encoder
    }

    pub fn limiter(&self) -> &Limiter {
        &self.limiter
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
    fn spawn_child(
        &self,
        session_id: &str,
        opts_input: &str,
        plan: &TranscodePlan,
        dir: &PathBuf,
        start_secs: u64,
        source_codec: Option<&str>,
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
        });
        let mut child = Command::new(&self.ffmpeg_bin)
            .args(&args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
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

    /// Start a session. Acquires a concurrency permit (mapping a cap hit to
    /// [`StartError::Busy`] → 503 transcoder_busy), creates the tmpdir, spawns
    /// ffmpeg, and registers the session. Returns the session id.
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

        let child = self.spawn_child(
            &session_id,
            &opts.input_path,
            &opts.plan,
            &dir,
            opts.start_secs,
            opts.source_codec.as_deref(),
            &opts.media_kind,
            0,
        )?;

        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let session = Session {
            info_kind: opts.media_kind,
            info_id: opts.media_id,
            sub: opts.sub,
            dir,
            started_at: now,
            last_seen: now,
            start_secs: opts.start_secs,
            start_number: 0,
            restarts: 0,
            ctl: ctl_tx,
            _permit: permit,
            plan: opts.plan,
            input_path: opts.input_path,
            source_codec: opts.source_codec,
            owner: opts.owner,
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
        let (input, plan, dir, start_secs, source_codec, media_kind, prev_number) = {
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
        match self.spawn_child(
            id,
            &input,
            &plan,
            &dir,
            spawn_secs,
            source_codec.as_deref(),
            &media_kind,
            next_number,
        ) {
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
                                    ChildSlot::Crashed
                                }
                            }
                            cmd = ctl.recv() => match cmd {
                                Some(SessionCmd::Restart { ack }) => {
                                    kill_child(&mut child, &id).await;
                                    match this.respawn(&id, RespawnMode::Seek).await {
                                        Respawn::Ok(new) => {
                                            let _ = ack.send(true);
                                            ChildSlot::Running(new)
                                        }
                                        Respawn::Failed => {
                                            let _ = ack.send(false);
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
                        Some(SessionCmd::Restart { ack }) => match this
                            .respawn(&id, RespawnMode::Seek)
                            .await
                        {
                            Respawn::Ok(new) => {
                                let _ = ack.send(true);
                                ChildSlot::Running(new)
                            }
                            Respawn::Failed => {
                                let _ = ack.send(false);
                                ChildSlot::Crashed
                            }
                            Respawn::Gone => {
                                let _ = ack.send(false);
                                return;
                            }
                        },
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
                            Respawn::Ok(new) => ChildSlot::Running(new),
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
             printf '#EXTM3U\\n#EXT-X-VERSION:3\\n' > \"$last\"\n\
             printf 'seg' > \"$d/seg_00000.ts\"\n\
             if [ \"{mode}\" = crash ]; then exit 1; fi\n\
             sleep 30\n"
        );
        f.write_all(script.as_bytes()).unwrap();
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
            media_kind: "movie".into(),
            media_id: 7,
            sub: "plex:42".into(),
            input_path: input.into(),
            plan: remux_plan(),
            start_secs: 0,
            source_codec: None,
            owner: None,
        }
    }

    async fn wait_for<F>(mut cond: F)
    where
        F: FnMut() -> bool,
    {
        for _ in 0..200 {
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
        for _ in 0..200 {
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
    async fn same_second_grants_get_distinct_sessions_with_no_orphan() {
        // Regression: the id was tx:{kind}:{media_id}:{sub}:{now_secs} — a
        // double-click within one second minted the SAME id, and the second
        // map insert displaced the first Session, orphaning its ffmpeg (the
        // permit dropped but the process kept encoding). The monotonic
        // sequence suffix makes every id unique.
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager_with_stub(&tmp, write_stub(tmp.path(), "run"));
        // Identical opts (same kind/id/sub), started back-to-back in the same
        // wall-clock second.
        let a = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let b = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        assert_ne!(a, b, "same-second grants must mint distinct ids");
        assert_eq!(mgr.len().await, 2, "both sessions must be live");

        // Both encoders are running in their own dirs — nothing orphaned.
        let dir_a = mgr.manifest_path(&a).await.unwrap();
        let dir_b = mgr.manifest_path(&b).await.unwrap();
        assert_ne!(dir_a, dir_b);
        let pid_a = read_stub_pid(dir_a.parent().unwrap()).await;
        let pid_b = read_stub_pid(dir_b.parent().unwrap()).await;
        assert_ne!(pid_a, pid_b);
        assert!(process_alive(pid_a) && process_alive(pid_b));

        // And both are individually stoppable — each kill reaches ITS process.
        mgr.stop(&a).await;
        wait_for(|| !process_alive(pid_a)).await;
        assert!(process_alive(pid_b), "stopping a must not touch b");
        mgr.stop(&b).await;
        wait_for(|| !process_alive(pid_b)).await;
        assert!(mgr.is_empty().await);
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

    #[test]
    fn crash_resume_math() {
        // 2 segments (idx 0,1) written from a fresh start → resume at 2×4s.
        assert_eq!(crash_resume_secs(0, 0, 2), 8);
        // Compounds from the crashed child's own spawn offset + numbering.
        assert_eq!(crash_resume_secs(100, 5, 10), 120);
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
        assert_eq!(
            max_segment_index(&tmp.path().join("nope")).await,
            None
        );
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
        // (spawn offset + segments_written × 4s) and continue numbering.
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_crash_once_stub(tmp.path());
        let mgr = manager_with_stub(&tmp, stub);
        let id = mgr.start(opts("/lib/a.mkv")).await.unwrap();
        let dir = mgr.manifest_path(&id).await.unwrap();
        let dir = dir.parent().unwrap().to_path_buf();

        // The first child wrote seg_00000+seg_00001 then crashed; the healthy
        // respawn records its argv.
        let args = wait_for_args(&dir.join("args.txt"), |_| true).await;
        let ss = args
            .iter()
            .position(|s| s == "-ss")
            .expect("crash respawn must bake a resume -ss");
        assert_eq!(args[ss + 1], "8", "2 segments × 4s past offset 0: {args:?}");
        let sn = args
            .iter()
            .position(|s| s == "-start_number")
            .expect("crash respawn must continue segment numbering");
        assert_eq!(args[sn + 1], "2", "numbering continues after seg_00001");

        // The session reports the resumed position, not the stale offset.
        assert_eq!(mgr.list().await[0].start_secs, 8);
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
        let args = wait_for_args(&dir.join("args.txt"), |a| {
            a.iter().any(|s| s == "120")
        })
        .await;
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
            media_id,
            ..opts(input)
        }
    }

    fn encode_opts_id(input: &str, media_id: i64) -> StartOpts {
        StartOpts {
            media_kind: "movie".into(),
            media_id,
            sub: "plex:42".into(),
            input_path: input.into(),
            plan: TranscodePlan::Transcode {
                video: VideoOp::EncodeH264 {
                    scale_to_height: None,
                    tone_map: false,
                    burn_subtitle_index: None,
                    source_height: None,
                },
                audio: AudioOp::Copy,
                subtitle: SubtitleOp::None,
                reason: "test".into(),
            },
            start_secs: 0,
            source_codec: Some("hevc".into()),
            owner: None,
        }
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
            video: VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
                source_height: None,
            },
            audio: AudioOp::Copy,
            subtitle: SubtitleOp::None,
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
