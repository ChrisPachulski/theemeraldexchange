//! HTTP surface (axum 0.8). `/health` + `/version` are public; everything
//! under `/api/transcode/*` sits behind the same internal-principal posture
//! media-core uses (§4 Hybrid D). The grant endpoint computes a transcode plan
//! and starts a session, returning a 503 `transcoder_busy` when a concurrency
//! cap is hit (§4.4/§4.5 phase 6).
//!
//! Media metadata (the `MediaFileRow`) is supplied by the caller in the grant
//! body. In the wired deployment media-core's `play_grant` proxies to
//! `POST /api/transcode/grant` (env `TRANSCODER_URL`): the route at
//! `routes.rs:417` flips from "503 transcoder required" to "proxy to the
//! transcoder when online, 503 when not". This crate exposes the surface that
//! turns that seam real.

use std::sync::Arc;

use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router, middleware};
use emerald_contracts::internal_principal::InternalClaims;
use media_core::auth::verify_principal;
use media_core::capability::ClientCaps;
use media_core::config::PrincipalMode;
use media_core::models::MediaFileRow;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::concurrency::Busy;
use crate::plan::{TranscodePlan, plan_transcode};
use crate::session::{SessionManager, StartError, StartOpts};

/// Transcoder app state — the session manager + principal posture.
#[derive(Clone)]
pub struct AppState {
    pub sessions: SessionManager,
    pub principal_mode: PrincipalMode,
    pub internal_principal_secret: Option<Arc<String>>,
}

impl AppState {
    /// Build state from the environment, mirroring media-core's knobs:
    /// `MEDIA_INTERNAL_PRINCIPAL_MODE` / `RECOMMENDER_INTERNAL_PRINCIPAL_MODE`
    /// and `INTERNAL_PRINCIPAL_SECRET`.
    ///
    /// This uses the RAW `TRANSCODER_HW_ENCODER` (no boot detection). Prefer
    /// [`AppState::from_env_with_encoder`] from `main.rs` so the session manager
    /// runs the encoder ffmpeg actually supports — see the doc on
    /// [`SessionManager::from_env`].
    pub fn from_env() -> Result<Self, String> {
        Self::build_from_env(SessionManager::from_env())
    }

    /// Build state with an already-resolved (boot-detected) hardware encoder.
    /// `main.rs` calls `encoders::detect().resolve(...)` first and passes the
    /// result here so the running encoder matches the binary's capabilities.
    pub fn from_env_with_encoder(encoder: crate::args::HwEncoder) -> Result<Self, String> {
        Self::build_from_env(SessionManager::from_env_with_encoder(encoder))
    }

    /// Shared posture parsing for the two `from_env*` constructors.
    fn build_from_env(sessions: SessionManager) -> Result<Self, String> {
        let mode_str = std::env::var("MEDIA_INTERNAL_PRINCIPAL_MODE")
            .or_else(|_| std::env::var("RECOMMENDER_INTERNAL_PRINCIPAL_MODE"))
            .unwrap_or_default();
        let principal_mode = PrincipalMode::parse(&mode_str)?;
        let secret = std::env::var("INTERNAL_PRINCIPAL_SECRET")
            .ok()
            .filter(|s| !s.is_empty())
            .map(Arc::new);
        if principal_mode == PrincipalMode::Enforce && secret.is_none() {
            return Err(
                "principal_mode=enforce requires INTERNAL_PRINCIPAL_SECRET to be set".into(),
            );
        }
        Ok(AppState {
            sessions,
            principal_mode,
            internal_principal_secret: secret,
        })
    }
}

/// Build the router. Public health/version; authed `/api/transcode/*`.
pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/grant", post(grant))
        .route("/session/{id}/index.m3u8", get(session_manifest))
        .route("/session/{id}/{segment}", get(session_segment))
        .route("/session/{id}/heartbeat", post(session_heartbeat))
        .route("/session/{id}/seek", post(session_seek))
        .route("/session/{id}/stop", post(session_stop))
        .route("/sessions", get(list_sessions))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            principal_layer,
        ));

    Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .nest("/api/transcode", api)
        .with_state(state)
}

/// Internal-principal gate. Off → skip; Log → warn+allow; Enforce → reject.
/// Self-contained (no DB) so the transcoder doesn't depend on media-core's
/// `AppState`. Verified claims are inserted into request extensions (mirroring
/// media-core's layer) so handlers can bind sessions to — and authorize
/// per-session operations against — the acting principal.
async fn principal_layer(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    if state.principal_mode == PrincipalMode::Off {
        return next.run(req).await;
    }

    let token = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(str::to_string);

    let unauthorized =
        |msg: &str| (StatusCode::UNAUTHORIZED, Json(json!({ "error": msg }))).into_response();

    match (token, state.internal_principal_secret.as_deref()) {
        (Some(tok), Some(sec)) => {
            let now = chrono_now();
            match verify_principal(sec, &tok, now) {
                Ok(claims) => {
                    req.extensions_mut().insert(claims);
                    next.run(req).await
                }
                Err(e) => {
                    if state.principal_mode == PrincipalMode::Enforce {
                        unauthorized(&format!("internal-principal verify failed: {e}"))
                    } else {
                        tracing::warn!("internal-principal verify failed (log mode): {e}");
                        next.run(req).await
                    }
                }
            }
        }
        _ => {
            if state.principal_mode == PrincipalMode::Enforce {
                unauthorized("internal-principal required")
            } else {
                tracing::warn!("internal-principal missing or secret unset (log mode)");
                next.run(req).await
            }
        }
    }
}

/// Owner-or-admin authorization for per-session operations (stop/seek/
/// heartbeat), mirroring the IPTV precedent in `server/routes/iptv.ts`. No
/// verified principal (Off mode, or log mode with a missing/bad token) means
/// there is no identity to enforce against — the principal layer already chose
/// to admit the request. With a verified principal, admins may touch any
/// session; everyone else only sessions owned by their own sub. A session with
/// no recorded owner is admin-only to a verified caller (fail closed).
fn session_authorized(claims: &Option<InternalClaims>, owner: Option<&str>) -> bool {
    match claims {
        None => true,
        Some(c) => c.role == "admin" || (owner.is_some() && owner == Some(c.sub.as_str())),
    }
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response()
}

fn session_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "no such session" })),
    )
        .into_response()
}

/// `chrono`-free unix timestamp (media-core uses chrono; we avoid the dep).
fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let (total, cpu) = state.sessions.limiter().active();
    let caps = state.sessions.limiter().caps();
    Json(json!({
        "ok": true,
        "service": "transcoder",
        "active": total,
        "active_cpu": cpu,
        "max_total": caps.max_total,
        "max_cpu": caps.max_cpu,
    }))
}

async fn version() -> impl IntoResponse {
    Json(json!({
        "service": "transcoder",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// The subset of a media-core `MediaFileRow` the planner needs, in a
/// deserializable form. `MediaFileRow` is `Serialize`-only in media-core (it is
/// a DB row, never deserialized there), so the wire body carries this DTO and
/// we rebuild a `MediaFileRow` from it. Field names match media-core's JSON.
#[derive(Debug, Default, Deserialize)]
pub struct GrantFile {
    pub path: String,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub duration_secs: Option<i64>,
    #[serde(default)]
    pub video_codec: Option<String>,
    #[serde(default)]
    pub video_height: Option<i64>,
    #[serde(default)]
    pub video_profile: Option<String>,
    #[serde(default)]
    pub hdr_format: Option<String>,
    /// Audio/subtitle tracks as JSON arrays, exactly as media-core stores them.
    #[serde(default = "empty_json_array")]
    pub audio_tracks_json: String,
    #[serde(default = "empty_json_array")]
    pub subtitle_tracks_json: String,
}

fn empty_json_array() -> String {
    "[]".to_string()
}

impl GrantFile {
    fn into_row(self) -> MediaFileRow {
        MediaFileRow {
            id: 0,
            path: self.path,
            size_bytes: 0,
            mtime: String::new(),
            container: self.container,
            duration_secs: self.duration_secs,
            video_codec: self.video_codec,
            video_height: self.video_height,
            video_profile: self.video_profile,
            hdr_format: self.hdr_format,
            audio_tracks_json: self.audio_tracks_json,
            subtitle_tracks_json: self.subtitle_tracks_json,
            scanned_at: String::new(),
        }
    }
}

/// Grant body: the file's probe metadata (from media-core) + the client's caps.
#[derive(Debug, Deserialize)]
pub struct GrantRequest {
    pub file: GrantFile,
    #[serde(default)]
    pub caps: ClientCaps,
    pub media_kind: String,
    pub media_id: i64,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub start_secs: u64,
}

/// `POST /api/transcode/grant` — plan + start. Direct-play files return a plan
/// with no session (the caller streams directly from media-core); transcode
/// files start a session and return its `index.m3u8` URL. A cap hit yields
/// `503 transcoder_busy`.
async fn grant(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Json(req): Json<GrantRequest>,
) -> Response {
    // Bind the session to the VERIFIED principal (not the body's free-text
    // `sub`), so per-session ops can enforce owner-or-admin.
    let owner = claims.as_ref().map(|Extension(c)| c.sub.clone());
    let GrantRequest {
        file,
        caps,
        media_kind,
        media_id,
        sub,
        start_secs,
    } = req;
    let input_path = file.path.clone();
    let row = file.into_row();

    // A file with NO video stream (audio-only, or a probe that found none —
    // either way `video_codec` is empty) can never satisfy the mandatory
    // `-map 0:v:0` in the ffmpeg invocation: ffmpeg exits immediately with
    // "Stream map '0:v:0' matches no streams", the supervisor burns its whole
    // restart budget on the guaranteed-fatal respawn loop, and the caller sees
    // an opaque late 503. Reject it up front with a typed, client-readable
    // error instead — nothing downstream can ever make such a grant playable.
    if row.video_codec.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": "no_video_stream" })),
        )
            .into_response();
    }

    // Source codec gates the full-hardware VAAPI decode path (see
    // SessionManager::spawn_child); carry it through to StartOpts.
    let source_codec = row.video_codec.clone();
    let plan = plan_transcode(&row, &caps);

    if let TranscodePlan::DirectPlay { reason } = &plan {
        return Json(json!({
            "directPlay": true,
            "transcode": false,
            "reason": reason,
        }))
        .into_response();
    }

    let opts = StartOpts {
        media_kind,
        media_id,
        sub,
        input_path,
        plan: plan.clone(),
        start_secs,
        source_codec,
        owner,
    };

    match state.sessions.start(opts).await {
        Ok(session_id) => Json(json!({
            "directPlay": false,
            "transcode": true,
            "sessionId": session_id,
            "plan": plan,
            "manifestUrl": format!("/api/transcode/session/{session_id}/index.m3u8"),
            "heartbeatUrl": format!("/api/transcode/session/{session_id}/heartbeat"),
        }))
        .into_response(),
        Err(StartError::Busy(Busy { cpu_cap })) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "transcoder_busy",
                "cpuCap": cpu_cap,
            })),
        )
            .into_response(),
        // Source path outside the configured media root(s) — refuse without
        // echoing the attempted path back to the caller (§ audit 1-3).
        Err(StartError::Forbidden(_)) => (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "source_path_forbidden" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET …/session/{id}/index.m3u8` — the session's live playlist. Owner-bound
/// exactly like stop/seek/heartbeat: the manifest (and the segments it lists)
/// is the actual library-derived MEDIA, so it must not be readable by any
/// authenticated principal who merely knows/guesses a session id. The deployed
/// path is unaffected: the backend proxy mints the internal principal from the
/// stream token's sub on every forwarded request, so the player always arrives
/// as the session's owner. Fail-closed: an ownerless session under a verified
/// principal is admin-only (same posture as `session_authorized`).
async fn session_manifest(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<String>,
) -> Response {
    let claims = claims.map(|Extension(c)| c);
    let Some(owner) = state.sessions.session_owner(&id).await else {
        return session_not_found();
    };
    if !session_authorized(&claims, owner.as_deref()) {
        return forbidden();
    }
    let Some(path) = state.sessions.manifest_path(&id).await else {
        return session_not_found(); // reaped between the owner check and here
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/vnd.apple.mpegurl",
            )],
            bytes,
        )
            .into_response(),
        // The session exists but ffmpeg hasn't written the first playlist yet.
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "manifest not ready" })),
        )
            .into_response(),
    }
}

/// Serve one HLS asset (a `.ts` segment) from a session's dir. The HLS
/// playlist references segments by bare filename, so the player fetches them
/// relative to the manifest URL (`…/session/{id}/seg_00000.ts`). Gated by the
/// internal-principal layer AND owner-bound like the manifest above — segments
/// are the library-derived bytes themselves, the most valuable thing on this
/// surface, so they get the same owner-or-admin posture as stop/seek/heartbeat.
///
/// The `index.m3u8` route is registered separately and is matched first by
/// axum (static segment wins over the `{segment}` capture), so this handler
/// only ever sees segment names.
async fn session_segment(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path((id, segment)): Path<(String, String)>,
) -> Response {
    let claims = claims.map(|Extension(c)| c);
    let Some(owner) = state.sessions.session_owner(&id).await else {
        return session_not_found();
    };
    if !session_authorized(&claims, owner.as_deref()) {
        return forbidden();
    }
    // `asset_path` rejects unknown sessions and any traversal-unsafe name.
    let Some(path) = state.sessions.asset_path(&id, &segment).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such session or segment" })),
        )
            .into_response();
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "video/mp2t")],
            bytes,
        )
            .into_response(),
        // The session exists but ffmpeg has not written (or has rotated out)
        // this segment yet. delete_segments means old segments vanish; the
        // player should only ask for segments the live playlist still lists.
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "segment not available" })),
        )
            .into_response(),
    }
}

async fn session_heartbeat(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<String>,
) -> Response {
    let claims = claims.map(|Extension(c)| c);
    // 404 for an unknown/reaped session so the client can detect the session
    // died (idle-reaped, crashed past the restart cap) instead of receiving an
    // eternal 200 for a ghost. The SPA treats heartbeat as fire-and-forget, so
    // this is non-breaking for it today.
    let Some(owner) = state.sessions.session_owner(&id).await else {
        return session_not_found();
    };
    if !session_authorized(&claims, owner.as_deref()) {
        return forbidden();
    }
    if state.sessions.heartbeat(&id).await {
        Json(json!({ "ok": true })).into_response()
    } else {
        session_not_found() // reaped between the owner check and the beat
    }
}

#[derive(Debug, Deserialize)]
pub struct SeekQuery {
    pub to: u64,
}

async fn session_seek(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<String>,
    Query(q): Query<SeekQuery>,
) -> Response {
    let claims = claims.map(|Extension(c)| c);
    let Some(owner) = state.sessions.session_owner(&id).await else {
        return session_not_found();
    };
    if !session_authorized(&claims, owner.as_deref()) {
        return forbidden();
    }
    if state.sessions.seek(&id, q.to).await {
        Json(json!({ "ok": true, "to": q.to })).into_response()
    } else if state.sessions.session_owner(&id).await.is_some() {
        // Still registered but the respawn failed — the supervisor retries
        // under its restart cap; surface a retryable error, not a 404.
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "seek_respawn_failed" })),
        )
            .into_response()
    } else {
        session_not_found() // torn down while we seeked
    }
}

async fn session_stop(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<String>,
) -> Response {
    let claims = claims.map(|Extension(c)| c);
    // Unknown id stays 200 ok (stop is idempotent); a live session requires
    // owner-or-admin.
    if let Some(owner) = state.sessions.session_owner(&id).await {
        if !session_authorized(&claims, owner.as_deref()) {
            return forbidden();
        }
        state.sessions.stop(&id).await;
    }
    Json(json!({ "ok": true })).into_response()
}

/// The owner-facing projection of a [`crate::session::SessionInfo`]: just
/// enough for a client to render "what am I playing and where" — id, kind,
/// media id, and position. Everything else is REDACTED for non-admins:
/// `manifest_path` is a server-container filesystem path (internal layout /
/// scratch-mount disclosure), and `sub`/`owner`/`restarts` are operator
/// telemetry, not player state. Admins keep the full struct.
#[derive(serde::Serialize)]
struct OwnerSessionView {
    session_id: String,
    media_kind: String,
    media_id: i64,
    /// The session's current play offset in seconds (the `-ss` of the live
    /// ffmpeg child — grant/seek/crash-resume position).
    position_secs: u64,
}

/// Session inventory (§4.5 phase 7). Admins (and the unverified Off/log
/// postures) see everything; any other verified principal sees only their own
/// sessions — and only a SANITIZED view of those: the full `SessionInfo`
/// carries server filesystem paths that must not leave the admin surface.
async fn list_sessions(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
) -> Json<Value> {
    let claims = claims.map(|Extension(c)| c);
    let sessions = state.sessions.list().await;
    let (total, cpu) = state.sessions.limiter().active();
    let sessions_json = match &claims {
        Some(c) if c.role != "admin" => {
            let own: Vec<OwnerSessionView> = sessions
                .into_iter()
                .filter(|s| s.owner.as_deref() == Some(c.sub.as_str()))
                .map(|s| OwnerSessionView {
                    session_id: s.session_id,
                    media_kind: s.media_kind,
                    media_id: s.media_id,
                    position_secs: s.start_secs,
                })
                .collect();
            json!(own)
        }
        // Admins — and the Off/log postures with no verified identity, which
        // are operator-internal deployments by definition — keep full detail.
        _ => json!(sessions),
    };
    Json(json!({
        "sessions": sessions_json,
        "active": total,
        "active_cpu": cpu,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::HwEncoder;
    use crate::concurrency::{Caps, Limiter};
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use media_core::models::MediaFileRow;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use tower::ServiceExt;

    fn write_stub(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("ffmpeg_stub.sh");
        let mut f = std::fs::File::create(&path).unwrap();
        let script = "#!/bin/sh\n\
             for a in \"$@\"; do last=\"$a\"; done\n\
             d=$(dirname \"$last\")\n\
             mkdir -p \"$d\"\n\
             printf '#EXTM3U\\n' > \"$last\"\n\
             printf 'seg' > \"$d/seg_00000.ts\"\n\
             sleep 30\n";
        f.write_all(script.as_bytes()).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    fn state_with(tmp: &tempfile::TempDir, caps: Caps, mode: PrincipalMode) -> AppState {
        let stub = write_stub(tmp.path());
        let mgr = SessionManager::new(
            Limiter::new(caps),
            stub.to_string_lossy().into_owned(),
            tmp.path().join("sessions"),
            HwEncoder::VideoToolbox,
        );
        AppState {
            sessions: mgr,
            principal_mode: mode,
            internal_principal_secret: None,
        }
    }

    fn h264_file() -> MediaFileRow {
        MediaFileRow {
            id: 1,
            path: "/lib/m.mkv".into(),
            size_bytes: 1,
            mtime: "0".into(),
            container: Some("mkv".into()),
            duration_secs: Some(100),
            video_codec: Some("hevc".into()),
            video_height: Some(1080),
            video_profile: Some("main".into()),
            hdr_format: None,
            audio_tracks_json: "[{\"index\":1,\"codec\":\"aac\"}]".into(),
            subtitle_tracks_json: "[]".into(),
            scanned_at: "0".into(),
        }
    }

    fn grant_body(file: &MediaFileRow) -> String {
        json!({
            "file": file,
            "caps": { "containers": ["mp4"], "video_codecs": ["h264"], "max_height": 1080, "hdr": false },
            "media_kind": "movie",
            "media_id": 7,
            "sub": "plex:42",
            "start_secs": 0
        })
        .to_string()
    }

    #[tokio::test]
    async fn health_reports_caps() {
        let tmp = tempfile::tempdir().unwrap();
        let app = router(state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 1,
            },
            PrincipalMode::Off,
        ));
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["service"], "transcoder");
        assert_eq!(v["max_total"], 4);
        assert_eq!(v["max_cpu"], 1);
    }

    #[tokio::test]
    async fn grant_direct_play_returns_no_session() {
        let tmp = tempfile::tempdir().unwrap();
        let app = router(state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Off,
        ));
        // A file that direct-plays: h264/aac/mp4/1080p SDR to an h264 client.
        let mut file = h264_file();
        file.container = Some("mp4".into());
        file.video_codec = Some("h264".into());
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/transcode/grant")
                    .header("content-type", "application/json")
                    .body(Body::from(grant_body(&file)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["directPlay"], true);
        assert_eq!(v["transcode"], false);
    }

    #[tokio::test]
    async fn grant_transcode_starts_session() {
        let tmp = tempfile::tempdir().unwrap();
        let app = router(state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Off,
        ));
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/transcode/grant")
                    .header("content-type", "application/json")
                    .body(Body::from(grant_body(&h264_file())))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["transcode"], true);
        assert!(v["sessionId"].as_str().unwrap().starts_with("tx:"));
        assert!(v["manifestUrl"].as_str().unwrap().ends_with("/index.m3u8"));
    }

    #[tokio::test]
    async fn grant_without_video_stream_is_rejected_with_typed_error() {
        // Regression: a grant for a file with no video stream (video_codec
        // empty/absent) spawned ffmpeg with the mandatory `-map 0:v:0`, which
        // matches no streams — a guaranteed crash-loop to the restart cap and
        // an opaque late failure. It must be rejected up front, with no
        // session started or slot consumed.
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Off,
        );
        for codec in [None, Some(""), Some("  ")] {
            let mut file = h264_file();
            file.video_codec = codec.map(str::to_string);
            let resp = router(state.clone())
                .oneshot(
                    HttpRequest::builder()
                        .method("POST")
                        .uri("/api/transcode/grant")
                        .header("content-type", "application/json")
                        .body(Body::from(grant_body(&file)))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "codec {codec:?}"
            );
            let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
                .await
                .unwrap();
            let v: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(v["error"], "no_video_stream", "codec {codec:?}");
        }
        assert!(
            state.sessions.is_empty().await,
            "rejected grant must not start a session"
        );
        assert_eq!(
            state.sessions.limiter().active(),
            (0, 0),
            "rejected grant must not consume a slot"
        );
    }

    #[tokio::test]
    async fn grant_returns_503_transcoder_busy_at_cap() {
        let tmp = tempfile::tempdir().unwrap();
        // 1 total slot: the first transcode grant consumes it; the second 503s.
        let state = state_with(
            &tmp,
            Caps {
                max_total: 1,
                max_cpu: 1,
            },
            PrincipalMode::Off,
        );
        // Pre-fill the single slot via the manager directly.
        let app = router(state.clone());
        let first = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/transcode/grant")
                    .header("content-type", "application/json")
                    .body(Body::from(grant_body(&h264_file())))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        // Re-build a router over the SAME state (oneshot consumes the router).
        let app2 = router(state.clone());
        let second = app2
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/transcode/grant")
                    .header("content-type", "application/json")
                    .body(Body::from(grant_body(&h264_file())))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(second.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"], "transcoder_busy");
    }

    #[tokio::test]
    async fn segment_route_serves_ts_bytes() {
        // The stub writes seg_00000.ts beside the playlist. After a grant,
        // GET …/session/{id}/seg_00000.ts must return the segment bytes with a
        // video/mp2t content type — proving the manifest's segments are
        // reachable (the end-to-end playback gap).
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Off,
        );
        let app = router(state.clone());
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/transcode/grant")
                    .header("content-type", "application/json")
                    .body(Body::from(grant_body(&h264_file())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let session_id = v["sessionId"].as_str().unwrap().to_string();

        // The stub writes seg_00000.ts; poll until present, then fetch it.
        let seg = state
            .sessions
            .asset_path(&session_id, "seg_00000.ts")
            .await
            .unwrap();
        for _ in 0..200 {
            if seg.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let app2 = router(state.clone());
        let resp = app2
            .oneshot(
                HttpRequest::builder()
                    .uri(format!("/api/transcode/session/{session_id}/seg_00000.ts"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "video/mp2t"
        );
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], b"seg", "segment bytes served verbatim");

        // index.m3u8 still routes to the manifest handler (static wins over
        // the {segment} capture), returning the HLS content type.
        let app3 = router(state.clone());
        let resp = app3
            .oneshot(
                HttpRequest::builder()
                    .uri(format!("/api/transcode/session/{session_id}/index.m3u8"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "application/vnd.apple.mpegurl"
        );

        state.sessions.stop(&session_id).await;
    }

    #[tokio::test]
    async fn segment_route_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Off,
        );
        let app = router(state.clone());
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/transcode/grant")
                    .header("content-type", "application/json")
                    .body(Body::from(grant_body(&h264_file())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let session_id = v["sessionId"].as_str().unwrap().to_string();

        // A %2e%2e%2f-decoded traversal name must 404, never escape the dir.
        let app2 = router(state.clone());
        let resp = app2
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/transcode/session/{session_id}/..%2f..%2fetc%2fpasswd"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        state.sessions.stop(&session_id).await;
    }

    #[tokio::test]
    async fn heartbeat_is_200_for_live_session_404_for_dead() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Off,
        );
        let app = router(state.clone());
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/transcode/grant")
                    .header("content-type", "application/json")
                    .body(Body::from(grant_body(&h264_file())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let session_id = v["sessionId"].as_str().unwrap().to_string();

        let heartbeat = |sid: String| {
            let state = state.clone();
            async move {
                router(state)
                    .oneshot(
                        HttpRequest::builder()
                            .method("POST")
                            .uri(format!("/api/transcode/session/{sid}/heartbeat"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap()
            }
        };

        let live = heartbeat(session_id.clone()).await;
        assert_eq!(live.status(), StatusCode::OK);

        // Once the session is gone, heartbeat must say so — a 200 here left
        // the client heart-beating a reaped session forever.
        state.sessions.stop(&session_id).await;
        let dead = heartbeat(session_id).await;
        assert_eq!(dead.status(), StatusCode::NOT_FOUND);
    }

    /// Mint a verifiable internal-principal Bearer for `sub`/`role` — the same
    /// shape media-core's `mint_transcoder_principal` produces.
    fn mint(secret: &str, sub: &str, role: &str) -> String {
        let now = chrono_now();
        let claims = InternalClaims {
            iss: "eex".into(),
            sub: sub.into(),
            role: role.into(),
            auth_mode: "plex".into(),
            server_id: "srv".into(),
            device_id: None,
            req_id: "req-test".into(),
            iat: now,
            exp: now + 60,
        };
        emerald_contracts::internal_principal::encrypt_with_secret(secret.as_bytes(), &claims)
    }

    const TEST_SECRET: &str = "a-secret";

    fn enforce_state(tmp: &tempfile::TempDir) -> AppState {
        let mut state = state_with(
            tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Enforce,
        );
        state.internal_principal_secret = Some(Arc::new(TEST_SECRET.into()));
        state
    }

    async fn authed(state: &AppState, method: &str, uri: &str, bearer: &str) -> Response {
        let mut builder = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {bearer}"));
        let body = if method == "POST" && uri.ends_with("/grant") {
            builder = builder.header("content-type", "application/json");
            Body::from(grant_body(&h264_file()))
        } else {
            Body::empty()
        };
        router(state.clone())
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn session_ops_enforce_owner_or_admin() {
        // Sessions are bound to the VERIFIED principal at grant time; stop/
        // seek/heartbeat from a different non-admin sub must 403, the owner and
        // an admin must succeed. (Regression: the layer used to discard the
        // verified claims, so any authenticated caller could stop anyone's
        // playback by id.)
        let tmp = tempfile::tempdir().unwrap();
        let state = enforce_state(&tmp);
        let owner_tok = mint(TEST_SECRET, "plex:42", "user");
        let intruder_tok = mint(TEST_SECRET, "plex:99", "user");
        let admin_tok = mint(TEST_SECRET, "plex:1", "admin");

        let resp = authed(&state, "POST", "/api/transcode/grant", &owner_tok).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let sid = v["sessionId"].as_str().unwrap().to_string();

        // A different (non-admin) sub is locked out of every session op.
        for (method, uri) in [
            ("POST", format!("/api/transcode/session/{sid}/heartbeat")),
            ("POST", format!("/api/transcode/session/{sid}/seek?to=30")),
            ("POST", format!("/api/transcode/session/{sid}/stop")),
        ] {
            let resp = authed(&state, method, &uri, &intruder_tok).await;
            assert_eq!(resp.status(), StatusCode::FORBIDDEN, "{uri}");
        }
        assert_eq!(state.sessions.len().await, 1, "intruder stop must be a no-op");

        // The owner can heartbeat and seek their own session.
        let resp = authed(
            &state,
            "POST",
            &format!("/api/transcode/session/{sid}/heartbeat"),
            &owner_tok,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let resp = authed(
            &state,
            "POST",
            &format!("/api/transcode/session/{sid}/seek?to=30"),
            &owner_tok,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // An admin may stop anyone's session.
        let resp = authed(
            &state,
            "POST",
            &format!("/api/transcode/session/{sid}/stop"),
            &admin_tok,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(state.sessions.is_empty().await);
    }

    #[tokio::test]
    async fn manifest_and_segment_reads_enforce_owner_or_admin() {
        // Regression: stop/seek/heartbeat were owner-bound but the manifest
        // and segment GETs were not — any authenticated principal who knew a
        // session id could read someone else's library-derived media bytes.
        // Same fail-closed posture as the other session ops: wrong sub 403,
        // owner 200, admin 200.
        let tmp = tempfile::tempdir().unwrap();
        let state = enforce_state(&tmp);
        let owner_tok = mint(TEST_SECRET, "plex:42", "user");
        let intruder_tok = mint(TEST_SECRET, "plex:99", "user");
        let admin_tok = mint(TEST_SECRET, "plex:1", "admin");

        let resp = authed(&state, "POST", "/api/transcode/grant", &owner_tok).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let sid = v["sessionId"].as_str().unwrap().to_string();

        // Wait for the stub to have written the playlist + first segment.
        let seg = state
            .sessions
            .asset_path(&sid, "seg_00000.ts")
            .await
            .unwrap();
        for _ in 0..200 {
            if seg.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let manifest_uri = format!("/api/transcode/session/{sid}/index.m3u8");
        let segment_uri = format!("/api/transcode/session/{sid}/seg_00000.ts");

        // A different (non-admin) sub must not read the media.
        for uri in [&manifest_uri, &segment_uri] {
            let resp = authed(&state, "GET", uri, &intruder_tok).await;
            assert_eq!(resp.status(), StatusCode::FORBIDDEN, "{uri}");
        }
        // The owner streams their own session.
        for uri in [&manifest_uri, &segment_uri] {
            let resp = authed(&state, "GET", uri, &owner_tok).await;
            assert_eq!(resp.status(), StatusCode::OK, "{uri}");
        }
        // Admins may read any session.
        for uri in [&manifest_uri, &segment_uri] {
            let resp = authed(&state, "GET", uri, &admin_tok).await;
            assert_eq!(resp.status(), StatusCode::OK, "{uri}");
        }

        state.sessions.stop(&sid).await;
    }

    #[tokio::test]
    async fn session_list_is_scoped_to_owner_for_non_admins() {
        let tmp = tempfile::tempdir().unwrap();
        let state = enforce_state(&tmp);
        let owner_tok = mint(TEST_SECRET, "plex:42", "user");
        let other_tok = mint(TEST_SECRET, "plex:99", "user");
        let admin_tok = mint(TEST_SECRET, "plex:1", "admin");

        let resp = authed(&state, "POST", "/api/transcode/grant", &owner_tok).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let count = |tok: String| {
            let state = state.clone();
            async move {
                let resp = authed(&state, "GET", "/api/transcode/sessions", &tok).await;
                assert_eq!(resp.status(), StatusCode::OK);
                let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
                    .await
                    .unwrap();
                let v: Value = serde_json::from_slice(&body).unwrap();
                v["sessions"].as_array().unwrap().len()
            }
        };

        assert_eq!(count(owner_tok).await, 1, "owner sees their session");
        assert_eq!(count(other_tok).await, 0, "stranger sees nothing");
        assert_eq!(count(admin_tok).await, 1, "admin sees everything");
    }

    #[tokio::test]
    async fn session_list_redacts_server_paths_for_non_admin_owners() {
        // Regression: the owner-scoped inventory serialized the full
        // SessionInfo, leaking the server-container filesystem path
        // (manifest_path) and operator telemetry to any authenticated user.
        // Owners get id/kind/media_id/position only; admins keep full detail.
        let tmp = tempfile::tempdir().unwrap();
        let state = enforce_state(&tmp);
        let owner_tok = mint(TEST_SECRET, "plex:42", "user");
        let admin_tok = mint(TEST_SECRET, "plex:1", "admin");

        let resp = authed(&state, "POST", "/api/transcode/grant", &owner_tok).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let list = |tok: String| {
            let state = state.clone();
            async move {
                let resp = authed(&state, "GET", "/api/transcode/sessions", &tok).await;
                assert_eq!(resp.status(), StatusCode::OK);
                let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
                    .await
                    .unwrap();
                let v: Value = serde_json::from_slice(&body).unwrap();
                v["sessions"].as_array().unwrap().clone()
            }
        };

        let own = list(owner_tok).await;
        assert_eq!(own.len(), 1);
        let entry = own[0].as_object().unwrap();
        // The sanitized projection: exactly these fields, nothing else.
        for key in ["session_id", "media_kind", "media_id", "position_secs"] {
            assert!(entry.contains_key(key), "owner view must keep {key}");
        }
        for key in ["manifest_path", "sub", "owner", "restarts"] {
            assert!(
                !entry.contains_key(key),
                "owner view must NOT leak {key}: {entry:?}"
            );
        }
        assert_eq!(entry["media_kind"], "movie");
        assert_eq!(entry["media_id"], 7);

        // Admins keep the full operational detail, paths included.
        let admin = list(admin_tok).await;
        let entry = admin[0].as_object().unwrap();
        assert!(entry.contains_key("manifest_path"), "{entry:?}");
        assert!(entry.contains_key("owner"), "{entry:?}");
    }

    #[tokio::test]
    async fn enforce_mode_rejects_missing_principal() {
        let tmp = tempfile::tempdir().unwrap();
        let mut state = state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Enforce,
        );
        state.internal_principal_secret = Some(Arc::new("a-secret".into()));
        let app = router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/transcode/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn sessions_inventory_lists_active() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with(
            &tmp,
            Caps {
                max_total: 4,
                max_cpu: 4,
            },
            PrincipalMode::Off,
        );
        // Start one via grant.
        let app = router(state.clone());
        let _ = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/transcode/grant")
                    .header("content-type", "application/json")
                    .body(Body::from(grant_body(&h264_file())))
                    .unwrap(),
            )
            .await
            .unwrap();

        let app2 = router(state.clone());
        let resp = app2
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/transcode/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["active"], 1);
        assert_eq!(v["sessions"].as_array().unwrap().len(), 1);
    }
}
