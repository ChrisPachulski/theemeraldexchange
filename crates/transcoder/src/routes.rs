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

use axum::Json;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Router, middleware};
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
/// `AppState`.
async fn principal_layer(State(state): State<AppState>, req: Request, next: Next) -> Response {
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
                Ok(_claims) => next.run(req).await,
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
async fn grant(State(state): State<AppState>, Json(req): Json<GrantRequest>) -> Response {
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

async fn session_manifest(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(path) = state.sessions.manifest_path(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such session" })),
        )
            .into_response();
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
/// relative to the manifest URL (`…/session/{id}/seg_00000.ts`). This is gated
/// by the same internal-principal layer as the manifest, so library-derived
/// bytes are never served unauthenticated.
///
/// The `index.m3u8` route is registered separately and is matched first by
/// axum (static segment wins over the `{segment}` capture), so this handler
/// only ever sees segment names.
async fn session_segment(
    State(state): State<AppState>,
    Path((id, segment)): Path<(String, String)>,
) -> Response {
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
    Path(id): Path<String>,
) -> impl IntoResponse {
    state.sessions.heartbeat(&id).await;
    Json(json!({ "ok": true }))
}

#[derive(Debug, Deserialize)]
pub struct SeekQuery {
    pub to: u64,
}

async fn session_seek(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<SeekQuery>,
) -> Response {
    if state.sessions.seek(&id, q.to).await {
        Json(json!({ "ok": true, "to": q.to })).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such session" })),
        )
            .into_response()
    }
}

async fn session_stop(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    state.sessions.stop(&id).await;
    Json(json!({ "ok": true }))
}

/// Admin inventory (§4.5 phase 7).
async fn list_sessions(State(state): State<AppState>) -> Json<Value> {
    let sessions = state.sessions.list().await;
    let (total, cpu) = state.sessions.limiter().active();
    Json(json!({
        "sessions": sessions,
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
