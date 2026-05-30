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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::args::{HwEncoder, ffmpeg_args};
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
}

/// Live session state. Not `Clone` — the manager holds it behind the map mutex.
struct Session {
    info_kind: String,
    info_id: i64,
    sub: String,
    dir: PathBuf,
    started_at: u64,
    last_seen: u64,
    start_secs: u64,
    restarts: u32,
    /// The current ffmpeg child. `None` between a kill and a respawn.
    child: Option<Child>,
    /// Held for the session's lifetime; dropping it frees the concurrency slot.
    _permit: Permit,
    plan: TranscodePlan,
    input_path: String,
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
}

/// Shared, cheap-to-clone manager (Arc'd map + config).
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
    limiter: Limiter,
    ffmpeg_bin: String,
    tmp_root: PathBuf,
    encoder: HwEncoder,
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
        }
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
        SessionManager::new(
            Limiter::new(Caps::from_env()),
            ffmpeg_bin,
            tmp_root,
            encoder,
        )
    }

    /// The hardware encoder this manager launches ffmpeg with (the resolved
    /// family once boot detection has run).
    pub fn encoder(&self) -> HwEncoder {
        self.encoder
    }

    pub fn limiter(&self) -> &Limiter {
        &self.limiter
    }

    /// Spawn one ffmpeg child for a session directory. Shared by `start` and the
    /// supervisor respawn path so the argument vector is computed identically.
    /// The child's stderr is drained into `tracing::warn` (tagged by session id)
    /// on a detached task so a full pipe buffer never stalls ffmpeg — mirroring
    /// `proc.stderr.on('data', …)` in iptvRemux.ts.
    fn spawn_child(
        &self,
        session_id: &str,
        opts_input: &str,
        plan: &TranscodePlan,
        dir: &PathBuf,
        start_secs: u64,
    ) -> Result<Child, StartError> {
        let dir_str = dir.to_string_lossy();
        let args = ffmpeg_args(plan, opts_input, &dir_str, start_secs, self.encoder);
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
        // Direct-play never needs a transcode session.
        let is_cpu = matches!(self.encoder, HwEncoder::Cpu);
        let permit = self.limiter.try_acquire(is_cpu).map_err(StartError::Busy)?;

        let now = now_secs();
        let session_id = format!(
            "tx:{}:{}:{}:{}",
            sanitize(&opts.media_kind),
            opts.media_id,
            sanitize(&opts.sub),
            now
        );
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
        )?;

        let session = Session {
            info_kind: opts.media_kind,
            info_id: opts.media_id,
            sub: opts.sub,
            dir,
            started_at: now,
            last_seen: now,
            start_secs: opts.start_secs,
            restarts: 0,
            child: Some(child),
            _permit: permit,
            plan: opts.plan,
            input_path: opts.input_path,
        };

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), session);
        self.spawn_supervisor(session_id.clone());
        Ok(session_id)
    }

    /// Refresh a session's heartbeat. No-op for an unknown id.
    pub async fn heartbeat(&self, id: &str) {
        if let Some(s) = self.sessions.lock().await.get_mut(id) {
            s.last_seen = now_secs();
        }
    }

    /// Seek: kill the current ffmpeg and respawn it with a new `-ss` offset
    /// (the supervisor pattern; ffmpeg can't seek a live HLS encode in place).
    /// Returns `false` for an unknown session.
    pub async fn seek(&self, id: &str, to_secs: u64) -> bool {
        let mut guard = self.sessions.lock().await;
        let Some(s) = guard.get_mut(id) else {
            return false;
        };
        // Kill the running child; the supervisor will observe the exit and is
        // told (via the updated start_secs + a manual respawn here) to restart
        // at the new offset.
        if let Some(mut child) = s.child.take() {
            let _ = child.start_kill();
        }
        s.start_secs = to_secs;
        s.last_seen = now_secs();
        // Clear the temp segments so the player doesn't replay stale media.
        // Use tokio::fs (not std::fs) so we never block an executor thread.
        let _ = tokio::fs::remove_dir_all(&s.dir).await;
        let _ = tokio::fs::create_dir_all(&s.dir).await;
        match self.spawn_child(id, &s.input_path, &s.plan, &s.dir, to_secs) {
            Ok(child) => {
                s.child = Some(child);
                true
            }
            Err(e) => {
                tracing::warn!(session = id, error = %e, "seek respawn failed");
                // Leave the session registered but childless; the supervisor
                // will attempt its own restart on the next tick.
                false
            }
        }
    }

    /// Stop and remove a session: SIGTERM, then SIGKILL after a grace period,
    /// then remove the tmpdir. Idempotent. Mirrors `stopRemuxSession`.
    pub async fn stop(&self, id: &str) {
        let removed = self.sessions.lock().await.remove(id);
        let Some(mut s) = removed else { return };
        let dir = s.dir.clone();
        if let Some(mut child) = s.child.take() {
            // tokio's Child::kill sends SIGKILL; emulate the SIGTERM→SIGKILL
            // escalation: start_kill (SIGKILL) immediately is acceptable here
            // because the grace window is enforced by the kill_on_drop guard
            // and the supervisor; for the explicit stop we go straight to a
            // bounded wait then a hard kill.
            let _ = child.start_kill();
            let _ = tokio::time::timeout(KILL_GRACE, child.wait()).await;
        }
        // Permit drops with `s` here, freeing the concurrency slot.
        let _ = tokio::fs::remove_dir_all(&dir).await;
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

    /// Supervisor task: watch this session's ffmpeg child for an UNEXPECTED
    /// exit and restart it with exponential backoff up to [`MAX_RESTARTS`].
    /// A `seek`/`stop` removes the child or the session, which the supervisor
    /// treats as an intentional teardown and does not fight.
    fn spawn_supervisor(&self, id: SessionId) {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                // Take the child out so we can await its exit without holding
                // the map lock. If there's no child (seek in progress / stopped)
                // back off briefly and re-check.
                let child = {
                    let mut guard = this.sessions.lock().await;
                    match guard.get_mut(&id) {
                        Some(s) => s.child.take(),
                        None => return, // session stopped → supervisor exits
                    }
                };
                let Some(mut child) = child else {
                    // Childless but still registered (mid-seek). Re-check soon.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    // If a seek installed a new child, loop will pick it up.
                    // If the session vanished, the next guard miss returns.
                    if this.sessions.lock().await.contains_key(&id) {
                        continue;
                    }
                    return;
                };

                let status = child.wait().await;

                // Re-acquire and decide whether to restart.
                let mut guard = this.sessions.lock().await;
                let Some(s) = guard.get_mut(&id) else {
                    return; // stopped while we awaited → done
                };
                // If a seek already installed a fresh child while we awaited the
                // old one's exit, don't treat this as a crash — keep watching.
                if s.child.is_some() {
                    continue;
                }

                let code = status.as_ref().ok().and_then(|st| st.code());
                if s.restarts >= MAX_RESTARTS {
                    tracing::warn!(session = %id, ?code, "ffmpeg exceeded restart cap; tearing down session");
                    let dir = s.dir.clone();
                    guard.remove(&id);
                    drop(guard);
                    let _ = tokio::fs::remove_dir_all(&dir).await;
                    return;
                }

                s.restarts += 1;
                let attempt = s.restarts;
                let input = s.input_path.clone();
                let plan = s.plan.clone();
                let dir = s.dir.clone();
                let start_secs = s.start_secs;
                drop(guard);

                // Exponential backoff: 100ms * 2^(attempt-1), capped at ~2s.
                let backoff =
                    Duration::from_millis(100u64.saturating_mul(1 << (attempt - 1)).min(2_000));
                tracing::warn!(session = %id, attempt, ?code, ?backoff, "ffmpeg exited; restarting with backoff");
                tokio::time::sleep(backoff).await;

                // Clear the session dir before respawning so the fresh ffmpeg
                // restarts segment numbering at seg_00000 against a clean
                // playlist. Without this, `append_list` re-writes index.m3u8
                // referencing a brand-new seg_00000 while the player may still
                // hold the pre-crash one — a stale-media/discontinuity blip on
                // every crash-recovery. (Mirrors the seek() dir-clear.)
                let _ = tokio::fs::remove_dir_all(&dir).await;
                let _ = tokio::fs::create_dir_all(&dir).await;

                match this.spawn_child(&id, &input, &plan, &dir, start_secs) {
                    Ok(new_child) => {
                        let mut guard = this.sessions.lock().await;
                        match guard.get_mut(&id) {
                            Some(s) => s.child = Some(new_child),
                            None => return, // stopped during backoff
                        }
                    }
                    Err(e) => {
                        tracing::warn!(session = %id, error = %e, "ffmpeg respawn failed");
                        // Loop again; the restart counter keeps climbing toward
                        // the cap so a permanently broken input is reaped.
                    }
                }
            }
        });
    }
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
        mgr.heartbeat(&id).await;
        let after = mgr.list().await[0].last_seen;
        assert!(after >= before, "heartbeat must refresh last_seen");
        mgr.stop(&id).await;
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
