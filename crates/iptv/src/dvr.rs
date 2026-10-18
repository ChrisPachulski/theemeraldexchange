//! DVR (dvrRecordings.ts, dvrRecorder.ts, routes/dvr.ts): recordings of an
//! IPTV live channel for a programme window, a 20 s scheduler that starts,
//! stops and misses them, an ffmpeg recorder that copies the channel to
//! `<DVR_DIR>/<id>.ts`, and the /api/dvr routes. A recording holds a provider
//! connection like a live viewer, so it takes a tracker slot (kind live)
//! under the upstream cap and defers while the cap is full. Mounted and
//! scheduled only with DVR_ENABLED.
//!
//! Hono keeps requireAuth, the live section, the rating cap and membership;
//! this service checks the admin principal on schedule/delete and the
//! recording token's kind and id on play.

use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::{DateTime, Utc};
use emerald_contracts::stream_token::StreamKind;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::api::{
    ApiResult, AppState, Claims, Params, bad, db, error, js_date, js_number, json_ok, param,
    require_admin, sub_of,
};
use crate::concurrency::{Acquire, Kind, Tracker};
use crate::config::Config;
use crate::egress::FFMPEG_PROXIED_PROTOCOLS;
use crate::remux::Remux;
use crate::streams::{check_token, encode_uri_component};
use crate::xtream::{Creds, iso};

/// How often the scheduler runs (inside the tracker's 30 s idle sweep, so
/// the heartbeat keeps a multi-hour recording's slot).
pub const TICK_EVERY: Duration = Duration::from_secs(20);
/// SIGTERM, then SIGKILL after this if ffmpeg is still running.
const KILL_GRACE: Duration = Duration::from_secs(5);
/// ffmpeg traps SIGTERM, finishes the file and exits with this code (no
/// signal); measured on ffmpeg 7/8.
const FFMPEG_SIGNALLED_EXIT: i32 = 255;

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Recording {
    pub id: String,
    pub channel_stream_id: i64,
    pub channel_name: String,
    pub title: String,
    pub start_utc: String,
    pub stop_utc: String,
    /// scheduled | recording | completed | failed | missed | cancelled
    pub status: String,
    pub file_path: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct NewRecording {
    /// JS `Number(body.channel_stream_id)`; validated as a positive integer.
    pub channel_stream_id: f64,
    pub channel_name: String,
    pub title: String,
    pub start_utc: String,
    pub stop_utc: String,
}

/// `Date.parse` in ms, NaN when unparseable, so comparisons behave as in JS.
fn ms(s: &str) -> f64 {
    js_date(s).map_or(f64::NAN, |d| d.timestamp_millis() as f64)
}

fn now_ms(now: DateTime<Utc>) -> f64 {
    now.timestamp_millis() as f64
}

/// A stable error code, or None when the recording can be scheduled.
/// `existing` is the (start, stop) of the other recordings on the same channel
/// that still hold a tuner (scheduled or recording). Windows are half-open, so
/// back-to-back recordings are not an overlap.
pub fn validate(
    input: &NewRecording,
    now: DateTime<Utc>,
    existing: &[(String, String)],
) -> Option<&'static str> {
    let id = input.channel_stream_id;
    if !(id.is_finite() && id.fract() == 0.0 && id > 0.0) {
        return Some("invalid_channel");
    }
    if input.channel_name.trim().is_empty() {
        return Some("missing_channel_name");
    }
    if input.title.trim().is_empty() {
        return Some("missing_title");
    }
    let (start, stop) = (ms(&input.start_utc), ms(&input.stop_utc));
    if start.is_nan() || stop.is_nan() {
        return Some("invalid_time");
    }
    if stop <= start {
        return Some("stop_before_start");
    }
    if stop <= now_ms(now) {
        return Some("already_ended");
    }
    // A second recording of one channel would need its own provider
    // connection and write a second copy of the same stream.
    if existing.iter().any(|(s, e)| ms(s) < stop && start < ms(e)) {
        return Some("channel_overlap");
    }
    None
}

#[derive(Debug, Default)]
pub struct Plan {
    /// Open windows that want ffmpeg: due `scheduled` rows, and `recording`
    /// rows (tick skips the ones the recorder is running, so an orphan left
    /// by a restart resumes).
    pub to_start: Vec<Recording>,
    /// `recording` rows whose window closed.
    pub to_stop: Vec<Recording>,
    /// `scheduled` rows whose window passed unstarted.
    pub to_miss: Vec<Recording>,
}

pub fn plan_transitions(now: DateTime<Utc>, rows: Vec<Recording>) -> Plan {
    let now = now_ms(now);
    let mut plan = Plan::default();
    for r in rows {
        let (start, stop) = (ms(&r.start_utc), ms(&r.stop_utc));
        match r.status.as_str() {
            "scheduled" if stop <= now => plan.to_miss.push(r),
            "scheduled" if start <= now => plan.to_start.push(r),
            "recording" if stop <= now => plan.to_stop.push(r),
            "recording" => plan.to_start.push(r),
            _ => {}
        }
    }
    plan
}

// ---- db ---------------------------------------------------------------------------

pub async fn schedule(
    pool: &SqlitePool,
    input: &NewRecording,
    now: DateTime<Utc>,
) -> sqlx::Result<Recording> {
    let id = ulid::Ulid::generate().to_string();
    let now = iso(now);
    sqlx::query(
        "INSERT INTO dvr_recordings
           (id, channel_stream_id, channel_name, title, start_utc, stop_utc, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)",
    )
    .bind(&id)
    .bind(input.channel_stream_id as i64)
    .bind(&input.channel_name)
    .bind(&input.title)
    .bind(&input.start_utc)
    .bind(&input.stop_utc)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    sqlx::query_as("SELECT * FROM dvr_recordings WHERE id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await
}

/// Newest scheduled first.
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Recording>> {
    sqlx::query_as("SELECT * FROM dvr_recordings ORDER BY start_utc DESC")
        .fetch_all(pool)
        .await
}

pub async fn get_recording(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Recording>> {
    sqlx::query_as("SELECT * FROM dvr_recordings WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Cancel a scheduled/recording row, delete a terminal one; None when the id
/// is unknown. The caller stops ffmpeg and removes the file.
pub async fn cancel(
    pool: &SqlitePool,
    id: &str,
    now: DateTime<Utc>,
) -> sqlx::Result<Option<&'static str>> {
    let Some(row) = get_recording(pool, id).await? else {
        return Ok(None);
    };
    if matches!(row.status.as_str(), "scheduled" | "recording") {
        sqlx::query("UPDATE dvr_recordings SET status='cancelled', updated_at=? WHERE id=?")
            .bind(iso(now))
            .bind(id)
            .execute(pool)
            .await?;
        return Ok(Some("cancelled"));
    }
    sqlx::query("DELETE FROM dvr_recordings WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(Some("deleted"))
}

/// Set the status; a given file_path replaces the stored one, error is
/// always overwritten (None clears it).
pub async fn mark_status(
    pool: &SqlitePool,
    id: &str,
    status: &str,
    file_path: Option<&str>,
    error: Option<&str>,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE dvr_recordings
            SET status = ?, file_path = COALESCE(?, file_path), error = ?, updated_at = ?
          WHERE id = ?",
    )
    .bind(status)
    .bind(file_path)
    .bind(error)
    .bind(iso(now))
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

// ---- recorder ---------------------------------------------------------------------

/// What `tick` drives; the ffmpeg one is [`FfmpegRecorder`], tests use a fake.
pub trait Recorder: Send + Sync {
    /// Begin recording: the file being written, `Ok(None)` when deferred (no
    /// free provider connection; the next tick retries while the window is
    /// open), or the error that fails the row.
    fn start(&self, rec: &Recording) -> Result<Option<String>, String>;
    /// Resolves once the recording has really stopped (ffmpeg exited) and its
    /// outcome is written. An unknown id resolves at once.
    fn stop(&self, id: &str) -> impl Future<Output = ()> + Send;
    fn running(&self) -> HashSet<String>;
    /// Keep in-flight recordings' upstream slots alive between ticks.
    fn heartbeat(&self) {}
}

/// One scheduler pass. Stopping awaits the recorder, so `completed` is never
/// written while ffmpeg still holds the file; the recorder's exit handler
/// writes the real outcome and the write here only backstops a row still
/// `recording`. A resumed recording re-captures the rest of its window into
/// a fresh file (the pre-restart partial is not stitched in).
pub async fn tick<R: Recorder>(
    pool: &SqlitePool,
    recorder: &R,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    let rows: Vec<Recording> = sqlx::query_as(
        "SELECT * FROM dvr_recordings WHERE status IN ('scheduled','recording') ORDER BY start_utc DESC",
    )
    .fetch_all(pool)
    .await?;
    let plan = plan_transitions(now, rows);
    let running = recorder.running();

    for r in plan.to_start {
        if running.contains(&r.id) {
            continue;
        }
        match recorder.start(&r) {
            // Deferred: recording yields to live viewers rather than opening
            // an over-cap connection that corrupts them.
            Ok(None) => {}
            // Only while still active: a child that already exited (or a
            // cancel) has written the real outcome.
            Ok(Some(path)) => {
                sqlx::query(
                    "UPDATE dvr_recordings SET status='recording', file_path=?, error=NULL, updated_at=?
                      WHERE id=? AND status IN ('scheduled','recording')",
                )
                .bind(path)
                .bind(iso(now))
                .bind(&r.id)
                .execute(pool)
                .await?;
            }
            Err(e) => mark_status(pool, &r.id, "failed", None, Some(&e), now).await?,
        }
    }
    for r in plan.to_stop {
        recorder.stop(&r.id).await;
        if get_recording(pool, &r.id)
            .await?
            .is_some_and(|row| row.status == "recording")
        {
            mark_status(pool, &r.id, "completed", None, None, now).await?;
        }
    }
    for r in plan.to_miss {
        mark_status(pool, &r.id, "missed", None, None, now).await?;
    }
    recorder.heartbeat();
    Ok(())
}

/// The scheduler: a tick now, then every `every`. Ticks never overlap.
pub fn spawn_scheduler<R: Recorder + 'static>(
    pool: SqlitePool,
    recorder: R,
    every: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut t = tokio::time::interval(every);
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            t.tick().await;
            if let Err(e) = tick(&pool, &recorder, Utc::now()).await {
                tracing::error!(error = %e, "dvr scheduler tick failed");
            }
        }
    })
}

/// ffmpeg argv copying a live .ts stream to a file, bounded by `-t`. Every
/// network hop, redirects included, goes through the egress proxy.
pub fn build_record_args(
    upstream: &str,
    file: &str,
    duration_secs: f64,
    proxy: &[String],
) -> Vec<String> {
    let secs = duration_secs.max(1.0).floor() as u64;
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-protocol_whitelist"]
        .map(String::from)
        .into();
    a.push(FFMPEG_PROXIED_PROTOCOLS.into());
    a.extend_from_slice(proxy);
    a.extend(["-i", upstream, "-t"].map(String::from));
    a.push(secs.to_string());
    // -y: a resumed recording re-captures into its existing <id>.ts, which
    // ffmpeg under -nostdin would otherwise refuse (and still exit 0).
    a.extend(["-c", "copy", "-f", "mpegts", "-y", file].map(String::from));
    a
}

/// The Xtream live .ts URL (the raw live proxy's shape).
pub fn live_url(c: &Creds, stream_id: i64) -> String {
    format!(
        "{}/live/{}/{}/{stream_id}.ts",
        c.host,
        encode_uri_component(&c.username),
        encode_uri_component(&c.password)
    )
}

/// The tracker session a recording holds while it dials the provider.
fn record_session_id(id: &str) -> String {
    format!("record:{id}")
}

fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGINT => "SIGINT".into(),
        n => n.to_string(),
    }
}

#[derive(Clone)]
struct Child {
    term: CancellationToken,
    /// Cancelled once the child exited and its outcome is written.
    done: CancellationToken,
}

type Clock = Box<dyn Fn() -> DateTime<Utc> + Send + Sync>;

struct Shared {
    pool: SqlitePool,
    dir: PathBuf,
    ffmpeg: PathBuf,
    creds: Result<Creds, String>,
    cap: usize,
    tracker: Arc<Tracker>,
    remux: Remux,
    now: Clock,
    kill_grace: Duration,
    children: Mutex<HashMap<String, Child>>,
}

/// Spawns one ffmpeg per recording. Cheap to clone; clones share children.
#[derive(Clone)]
pub struct FfmpegRecorder(Arc<Shared>);

impl FfmpegRecorder {
    pub fn new(pool: SqlitePool, config: &Config, tracker: Arc<Tracker>, remux: Remux) -> Self {
        Self::with_clock(pool, config, tracker, remux, Box::new(Utc::now), KILL_GRACE)
    }

    pub(crate) fn with_clock(
        pool: SqlitePool,
        config: &Config,
        tracker: Arc<Tracker>,
        remux: Remux,
        now: Clock,
        kill_grace: Duration,
    ) -> Self {
        FfmpegRecorder(Arc::new(Shared {
            pool,
            dir: PathBuf::from(&config.dvr_dir),
            ffmpeg: PathBuf::from(&config.iptv_ffmpeg_bin),
            creds: Creds::from_config(config),
            cap: config.iptv_max_upstream_connections as usize,
            tracker,
            remux,
            now,
            kill_grace,
            children: Mutex::default(),
        }))
    }

    pub fn file_path_for(&self, id: &str) -> PathBuf {
        self.0.dir.join(format!("{id}.ts"))
    }

    /// Provider connections in use: tracker live/remux reservations or the
    /// remux's own count, whichever is higher.
    fn upstream_in_use(&self) -> usize {
        let reserved = self
            .0
            .tracker
            .list()
            .iter()
            .filter(|s| matches!(s.kind, Kind::Live | Kind::Remux))
            .count();
        reserved.max(self.0.remux.live_upstream_count())
    }

    /// SIGTERM every recording and wait (bounded) for their exits. A window
    /// still open stays `recording`, so the next boot resumes it.
    pub async fn stop_all(&self, grace: Duration) {
        let all: Vec<Child> = self.0.children.lock().unwrap().values().cloned().collect();
        for c in &all {
            c.term.cancel();
        }
        let deadline = tokio::time::Instant::now() + grace;
        for c in all {
            let _ = tokio::time::timeout_at(deadline, c.done.cancelled()).await;
        }
    }

    async fn supervise(self, id: String, mut child: tokio::process::Child, ctl: Child) {
        let sh = &self.0;
        if let Some(stderr) = child.stderr.take() {
            let (remux, id) = (sh.remux.clone(), id.clone());
            tokio::spawn(async move {
                let mut r = BufReader::new(stderr);
                let mut raw = Vec::new();
                while r.read_until(b'\n', &mut raw).await.is_ok_and(|n| n > 0) {
                    // ffmpeg echoes the input URL (with creds) on error.
                    let line = remux.scrub(String::from_utf8_lossy(&raw).trim());
                    let lower = line.to_lowercase();
                    if ["error", "failed", "invalid"]
                        .iter()
                        .any(|w| lower.contains(w))
                    {
                        tracing::warn!(recording_id = id, line, "dvr ffmpeg stderr");
                    }
                    raw.clear();
                }
            });
        }
        let pid = child.id();
        let mut termed = false;
        let status = tokio::select! {
            s = child.wait() => s,
            _ = ctl.term.cancelled() => {
                termed = true;
                #[cfg(unix)]
                if let Some(pid) = pid {
                    // SAFETY: kill(2) on our own child, not yet reaped (wait()
                    // has not returned); no pointers involved.
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
                #[cfg(not(unix))]
                let _ = (pid, child.start_kill());
                match tokio::time::timeout(sh.kill_grace, child.wait()).await {
                    Ok(s) => s,
                    // Still running past the grace: SIGKILL.
                    Err(_) => {
                        let _ = child.start_kill();
                        child.wait().await
                    }
                }
            }
        };
        let (code, signal) = match &status {
            Ok(st) => (st.code(), exit_signal(st)),
            Err(_) => (None, None),
        };
        // Free the slot as soon as ffmpeg let go of the provider socket.
        sh.tracker.release(&record_session_id(&id));
        if let Err(e) = self.finalize(&id, code, signal, termed).await {
            tracing::warn!(recording_id = id, error = %e, "dvr finalize failed");
        }
        // Only now: until the outcome is written, running() keeps tick from
        // re-spawning this row.
        sh.children.lock().unwrap().remove(&id);
        ctl.done.cancel();
    }

    async fn finalize(
        &self,
        id: &str,
        code: Option<i32>,
        signal: Option<i32>,
        termed: bool,
    ) -> sqlx::Result<()> {
        let sh = &self.0;
        let Some(row) = get_recording(&sh.pool, id).await? else {
            return Ok(());
        };
        // A DELETE flipped it to cancelled and stopped us: the partial is
        // junk, removed now that ffmpeg released the descriptor.
        if row.status == "cancelled" {
            let _ = tokio::fs::remove_file(self.file_path_for(id)).await;
            return Ok(());
        }
        // 'scheduled': the child exited before tick marked it recording.
        if !matches!(row.status.as_str(), "recording" | "scheduled") {
            return Ok(());
        }
        let now = (sh.now)();
        // Exited because of a SIGTERM: killed by it, or (real ffmpeg) trapped
        // our SIGTERM and exited 255.
        let sigtermed = signal == Some(libc::SIGTERM)
            || (termed && signal.is_none() && code == Some(FFMPEG_SIGNALLED_EXIT));
        // A SIGTERM inside the window is an interruption (shutdown, deploy),
        // not a finished recording: leave the row for the next tick to resume.
        if sigtermed && ms(&row.stop_utc) > now_ms(now) {
            return Ok(());
        }
        if sigtermed || code == Some(0) {
            mark_status(&sh.pool, id, "completed", None, None, now).await
        } else {
            let code = code.map_or_else(|| "null".into(), |c| c.to_string());
            let signal = signal.map(signal_name).unwrap_or_default();
            let error = format!("ffmpeg exited code={code} signal={signal}");
            mark_status(&sh.pool, id, "failed", None, Some(&error), now).await
        }
    }
}

impl Recorder for FfmpegRecorder {
    fn start(&self, rec: &Recording) -> Result<Option<String>, String> {
        let sh = &self.0;
        if sh.cap > 0 && self.upstream_in_use() >= sh.cap {
            // A feed check's capture never delays a recording past the next tick.
            sh.remux.preempt_aux("dvr");
            tracing::warn!(
                recording_id = rec.id,
                in_use = self.upstream_in_use(),
                cap = sh.cap,
                "upstream busy; deferring recording"
            );
            return Ok(None);
        }
        let Some(proxy) = sh.remux.proxy_args() else {
            return Ok(None);
        };
        let creds = sh.creds.clone()?;
        // Reserve before dialing; a synthetic sub never dedupes against a real
        // viewer. A refusal (the tracker's own cap) defers like a busy upstream.
        let session = record_session_id(&rec.id);
        if let Err(l) = sh.tracker.try_acquire(Acquire {
            sub: format!("dvr:{}", rec.id),
            session_id: session.clone(),
            kind: Kind::Live,
            resource_id: rec.channel_stream_id.to_string(),
            ip: None,
            title: Some(rec.channel_name.clone()),
            kind_cap: None,
            replace_live: false,
        }) {
            tracing::warn!(
                recording_id = rec.id,
                limit = l.limit,
                current = l.current,
                "concurrency slot denied; deferring recording"
            );
            return Ok(None);
        }
        let fail = |e: String| {
            sh.tracker.release(&session);
            Err(e)
        };
        if let Err(e) = std::fs::create_dir_all(&sh.dir) {
            return fail(format!("dvr dir: {e}"));
        }
        let path = self.file_path_for(&rec.id).to_string_lossy().into_owned();
        let secs = (ms(&rec.stop_utc) - now_ms((sh.now)())) / 1000.0;
        let args = build_record_args(
            &live_url(&creds, rec.channel_stream_id),
            &path,
            secs,
            &proxy,
        );
        let child = Command::new(&sh.ffmpeg)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let child = match child {
            Ok(c) => c,
            Err(e) => {
                let detail = sh.remux.scrub(&e.to_string());
                tracing::warn!(recording_id = rec.id, detail, "dvr ffmpeg spawn error");
                return fail(format!("ffmpeg spawn error: {detail}"));
            }
        };
        let ctl = Child {
            term: CancellationToken::new(),
            done: CancellationToken::new(),
        };
        sh.children
            .lock()
            .unwrap()
            .insert(rec.id.clone(), ctl.clone());
        tokio::spawn(self.clone().supervise(rec.id.clone(), child, ctl));
        Ok(Some(path))
    }

    fn stop(&self, id: &str) -> impl Future<Output = ()> + Send {
        let ctl = self.0.children.lock().unwrap().get(id).cloned();
        async move {
            if let Some(c) = ctl {
                c.term.cancel();
                c.done.cancelled().await;
            }
        }
    }

    fn running(&self) -> HashSet<String> {
        self.0.children.lock().unwrap().keys().cloned().collect()
    }

    fn heartbeat(&self) {
        for id in self.0.children.lock().unwrap().keys() {
            self.0.tracker.heartbeat(&record_session_id(id));
        }
    }
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

// ---- routes -----------------------------------------------------------------------

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/dvr/recordings", get(list_route).post(schedule_route))
        .route(
            "/api/dvr/recordings/{id}",
            get(get_route).delete(delete_route),
        )
        .route("/api/dvr/recordings/{id}/grant", post(grant_route))
        .route("/api/dvr/recordings/{id}/play", get(play_route))
}

/// JS `String(v ?? '')` for the forms clients send.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Schedule a recording (admin; claims a provider connection and disk).
async fn schedule_route(State(s): State<AppState>, claims: Claims, body: Bytes) -> ApiResult {
    require_admin(&s, &claims)?;
    if let Err(r) = s.dvr_limit.check(&crate::api::limit_key(&claims)) {
        return Ok(r);
    }
    let body: Value = serde_json::from_slice(&body).map_err(|_| bad("invalid_json"))?;
    let input = NewRecording {
        channel_stream_id: body.get("channel_stream_id").map_or(f64::NAN, js_number),
        channel_name: js_string(body.get("channel_name")),
        title: js_string(body.get("title")),
        start_utc: js_string(body.get("start_utc")),
        stop_utc: js_string(body.get("stop_utc")),
    };
    // Terminal rows are free to record over.
    let existing: Vec<(String, String)> = if input.channel_stream_id.fract() == 0.0 {
        sqlx::query_as(
            "SELECT start_utc, stop_utc FROM dvr_recordings
              WHERE channel_stream_id = ? AND status IN ('scheduled','recording')",
        )
        .bind(input.channel_stream_id as i64)
        .fetch_all(&s.pool)
        .await
        .map_err(db)?
    } else {
        Vec::new()
    };
    let now = Utc::now();
    if let Some(code) = validate(&input, now, &existing) {
        return Err(bad(code));
    }
    let recording = schedule(&s.pool, &input, now).await.map_err(db)?;
    Ok((
        StatusCode::CREATED,
        axum::Json(json!({ "recording": recording })),
    )
        .into_response())
}

async fn list_route(State(s): State<AppState>) -> ApiResult {
    Ok(json_ok(
        &json!({ "recordings": list(&s.pool).await.map_err(db)? }),
    ))
}

async fn get_route(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let recording = get_recording(&s.pool, &id)
        .await
        .map_err(db)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "not_found"))?;
    Ok(json_ok(&json!({ "recording": recording })))
}

/// Cancel a scheduled/in-flight recording or delete a terminal one, and
/// reclaim what the row alone does not: an in-flight cancel stops ffmpeg (its
/// exit removes the partial), a terminal delete removes the finished file.
async fn delete_route(
    State(s): State<AppState>,
    claims: Claims,
    Path(id): Path<String>,
) -> ApiResult {
    require_admin(&s, &claims)?;
    if let Err(r) = s.dvr_limit.check(&crate::api::limit_key(&claims)) {
        return Ok(r);
    }
    let not_found = || error(StatusCode::NOT_FOUND, "not_found");
    let rec = get_recording(&s.pool, &id)
        .await
        .map_err(db)?
        .ok_or_else(not_found)?;
    let outcome = cancel(&s.pool, &id, Utc::now())
        .await
        .map_err(db)?
        .ok_or_else(not_found)?;
    if rec.status == "recording" {
        if let Some(d) = s.dvr.clone() {
            tokio::spawn(async move { d.stop(&id).await });
        }
    } else if outcome == "deleted"
        && let Some(path) = rec.file_path
    {
        // Best-effort: a stranded file is a leak, not a delete failure.
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(json_ok(&json!({ "status": outcome })))
}

/// A playback grant for a completed recording: a `recording` token bound to
/// this id and the caller, with the on-demand TTL (re-presented on every
/// range GET, so it must outlive the playback).
async fn grant_route(
    State(s): State<AppState>,
    claims: Claims,
    Path(id): Path<String>,
) -> ApiResult {
    let sub = sub_of(&claims)?;
    let rec = get_recording(&s.pool, &id)
        .await
        .map_err(db)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "not_found"))?;
    if rec.status != "completed" || rec.file_path.is_none() {
        return Err(error(StatusCode::NOT_FOUND, "not_ready"));
    }
    let t = crate::playlist::sign(
        &s.config.stream_token_secret,
        StreamKind::Recording,
        &id,
        &sub,
        s.config.iptv_ondemand_token_ttl_secs as i64,
        None,
    );
    Ok(json_ok(&json!({
        "url": format!("/api/dvr/recordings/{id}/play?t={t}"),
        "delivery": "progressive",
        "mime": "video/mp2t",
    })))
}

/// Range-serve a completed recording. A `?t=` token must be a recording token
/// for this id (membership is Hono's check); tokenless needs a principal.
async fn play_route(
    State(s): State<AppState>,
    claims: Claims,
    Path(id): Path<String>,
    Query(q): Params,
    headers: HeaderMap,
) -> Response {
    match param(&q, "t").filter(|t| !t.is_empty()) {
        Some(t) => {
            if let Err(r) = check_token(&s, &claims, t, StreamKind::Recording, Some(&id)) {
                return r;
            }
        }
        None => {
            if let Err(e) = sub_of(&claims) {
                return e.into_response();
            }
        }
    }
    let rec = match get_recording(&s.pool, &id).await {
        Ok(r) => r,
        Err(e) => return db(e).into_response(),
    };
    let Some(path) = rec
        .filter(|r| r.status == "completed")
        .and_then(|r| r.file_path)
    else {
        return error(StatusCode::NOT_FOUND, "not_ready").into_response();
    };
    let range = headers.get(header::RANGE).and_then(|h| h.to_str().ok());
    serve_file(&path, range).await
}

/// The play route's byte-range rule (shared with the trailer route): None
/// serves the whole file, Err is a 416.
fn parse_range(h: Option<&str>, size: u64) -> Option<Result<(u64, u64), ()>> {
    let (a, b) = h?.trim().strip_prefix("bytes=")?.split_once('-')?;
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    // `bytes=-` and anything else malformed: ignore the header (RFC 9110 14.2).
    if !digits(a) || !digits(b) || (a.is_empty() && b.is_empty()) {
        return None;
    }
    let n = |s: &str| i128::from(s.parse::<u64>().unwrap_or(u64::MAX));
    let size = i128::from(size);
    let (start, end) = if a.is_empty() {
        // Suffix: the LAST n bytes; larger than the file means all of it.
        ((size - n(b)).max(0), size - 1)
    } else {
        // A last-byte-pos past EOF means "to the end".
        let end = if b.is_empty() {
            size - 1
        } else {
            n(b).min(size - 1)
        };
        (n(a), end)
    };
    if start > end || start >= size {
        return Some(Err(()));
    }
    Some(Ok((start as u64, end as u64)))
}

async fn serve_file(path: &str, range: Option<&str>) -> Response {
    let missing = || error(StatusCode::NOT_FOUND, "file_missing").into_response();
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return missing();
    };
    let Ok(size) = file.metadata().await.map(|m| m.len()) else {
        return missing();
    };
    let base = [
        (header::CONTENT_TYPE, "video/mp2t".to_string()),
        (header::ACCEPT_RANGES, "bytes".to_string()),
    ];
    match parse_range(range, size) {
        None => (
            StatusCode::OK,
            base,
            [(header::CONTENT_LENGTH, size.to_string())],
            Body::from_stream(tokio_util::io::ReaderStream::new(file)),
        )
            .into_response(),
        Some(Err(())) => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            base,
            [(header::CONTENT_RANGE, format!("bytes */{size}"))],
        )
            .into_response(),
        Some(Ok((start, end))) => {
            if file.seek(SeekFrom::Start(start)).await.is_err() {
                return missing();
            }
            let len = end - start + 1;
            (
                StatusCode::PARTIAL_CONTENT,
                base,
                [
                    (header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")),
                    (header::CONTENT_LENGTH, len.to_string()),
                ],
                Body::from_stream(tokio_util::io::ReaderStream::new(file.take(len))),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests;
