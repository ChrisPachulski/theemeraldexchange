//! HTTP surface. `/health` + `/version` are public; everything under
//! `/api/media/*` sits behind the internal-principal layer.

use axum::Json;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Extension, Router, middleware};
use emerald_contracts::internal_principal::InternalClaims;
use serde::Deserialize;
use serde_json::{Value, json};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::auth::principal_layer;
use crate::capability::{self, ClientCaps};
use crate::config::PrincipalMode;
use crate::error::{AppError, AppResult};
use crate::models::{EpisodeRow, MediaFileRow, MovieRow, ShowRow, WatchStateRow};
use crate::scanner;
use crate::{AppState, SCHEMA_VERSION};

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/movies", get(list_movies))
        .route("/movies/{id}", get(get_movie))
        .route("/shows", get(list_shows))
        .route("/shows/{id}", get(get_show))
        .route("/shows/{id}/episodes", get(list_episodes))
        .route("/episodes", get(list_episodes_all))
        .route("/episodes/{id}", get(get_episode))
        .route("/play/{kind}/{id}/grant", post(play_grant))
        .route("/stream/{kind}/{id}", get(stream_file))
        .route("/watch", get(get_watch).post(post_watch))
        .route("/scan", post(trigger_scan))
        .route("/scan/status", get(scan_status))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            principal_layer,
        ));

    Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .nest("/api/media", api)
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db.pool)
        .await
        .is_ok();
    let schema = state.db.schema_version().await.unwrap_or(-1);
    Json(json!({
        "ok": db_ok,
        "service": "media-core",
        "schema": schema,
    }))
}

async fn version(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "service": "media-core",
        "schema": SCHEMA_VERSION,
        "server_id": state.config.server_id,
        "library_roots": state.config.library_roots.len(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub q: Option<String>,
    pub genre: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Normalize the pagination knobs: limit defaults to 50 and clamps to
/// `1..=200`; offset defaults to 0 and never goes negative.
fn paginate(limit: Option<i64>, offset: Option<i64>) -> (i64, i64) {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let offset = offset.unwrap_or(0).max(0);
    (limit, offset)
}

// ── Library read APIs ───────────────────────────────────────────────────

async fn list_movies(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    let (rows, total) = match &q.q {
        Some(term) if !term.is_empty() => {
            let rows = sqlx::query_as::<_, MovieRow>(
                "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id, overview, poster_path \
                 FROM movies WHERE title LIKE '%' || ? || '%' \
                 ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(term)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM movies WHERE title LIKE '%' || ? || '%'")
                    .bind(term)
                    .fetch_one(&state.db.pool)
                    .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, MovieRow>(
                "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id, overview, poster_path \
                 FROM movies ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM movies")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

async fn get_movie(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, MovieRow>(
        "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id, overview, poster_path \
         FROM movies WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

async fn list_shows(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    let (rows, total) = match &q.q {
        Some(term) if !term.is_empty() => {
            let rows = sqlx::query_as::<_, ShowRow>(
                "SELECT id, tmdb_id, tvdb_id, title, year, added_at, imdb_id, overview, poster_path \
                 FROM shows WHERE title LIKE '%' || ? || '%' \
                 ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(term)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM shows WHERE title LIKE '%' || ? || '%'")
                    .bind(term)
                    .fetch_one(&state.db.pool)
                    .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, ShowRow>(
                "SELECT id, tmdb_id, tvdb_id, title, year, added_at, imdb_id, overview, poster_path \
                 FROM shows ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shows")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

async fn get_show(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, ShowRow>(
        "SELECT id, tmdb_id, tvdb_id, title, year, added_at, imdb_id, overview, poster_path \
         FROM shows WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

async fn list_episodes(
    State(state): State<AppState>,
    Path(show_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, EpisodeRow>(
        "SELECT id, show_id, season, episode, title, air_date, file_id \
         FROM episodes WHERE show_id = ? ORDER BY season, episode",
    )
    .bind(show_id)
    .fetch_all(&state.db.pool)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

/// Flat, paginated episodes feed (mirrors `list_movies`): returns
/// `{items, total}` with optional `?q=` title filter and `?limit`/`?offset`.
/// Fixes the empty-body `GET /api/media/episodes` (no collection route).
async fn list_episodes_all(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    let (rows, total) = match &q.q {
        Some(term) if !term.is_empty() => {
            let rows = sqlx::query_as::<_, EpisodeRow>(
                "SELECT id, show_id, season, episode, title, air_date, file_id \
                 FROM episodes WHERE title LIKE '%' || ? || '%' \
                 ORDER BY show_id, season, episode LIMIT ? OFFSET ?",
            )
            .bind(term)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM episodes WHERE title LIKE '%' || ? || '%'",
            )
            .bind(term)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, EpisodeRow>(
                "SELECT id, show_id, season, episode, title, air_date, file_id \
                 FROM episodes ORDER BY show_id, season, episode LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM episodes")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

async fn get_episode(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, EpisodeRow>(
        "SELECT id, show_id, season, episode, title, air_date, file_id \
         FROM episodes WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

// ── Playback ────────────────────────────────────────────────────────────

/// Resolve the backing `media_files` row for a `(kind, id)` pair. `movie`
/// and `episode` both carry a `file_id` foreign key into `media_files`.
async fn resolve_media_file(state: &AppState, kind: &str, id: i64) -> AppResult<MediaFileRow> {
    let file_id: i64 = match kind {
        "movie" => sqlx::query_scalar("SELECT file_id FROM movies WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        "episode" => sqlx::query_scalar("SELECT file_id FROM episodes WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        _ => return Err(AppError::BadRequest(format!("unknown media kind: {kind}"))),
    };

    sqlx::query_as::<_, MediaFileRow>(
        "SELECT id, path, size_bytes, mtime, container, duration_secs, video_codec, \
         video_height, video_profile, hdr_format, audio_tracks_json, subtitle_tracks_json, \
         scanned_at FROM media_files WHERE id = ?",
    )
    .bind(file_id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)
}

async fn play_grant(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<ClientCaps>>,
) -> AppResult<Json<Value>> {
    let file = resolve_media_file(&state, &kind, id).await?;
    let caps = body.map(|Json(c)| c).unwrap_or_default();
    let decision = capability::decide(&file, &caps);

    Ok(Json(json!({
        "directPlay": decision.direct_play,
        "transcoderRequired": !decision.direct_play,
        "reason": decision.reason,
        "file": {
            "container": file.container,
            "duration_secs": file.duration_secs,
            "video_codec": file.video_codec,
            "video_height": file.video_height,
            "hdr_format": file.hdr_format,
            "audio_tracks": file.audio_tracks(),
            "subtitle_tracks": file.subtitle_tracks(),
        },
        "streamUrl": format!("/api/media/stream/{kind}/{id}"),
    })))
}

/// Defense-in-depth: a streamed path must resolve inside one of the configured
/// library roots. The path is DB-sourced (not raw user input), but a buggy or
/// poisoned scan could persist a path containing `..` or a symlink escaping the
/// library; we must never serve such a file. Canonicalizes both sides so `..`
/// and symlinks are resolved before the prefix check. With no roots configured
/// (dev/tests), containment is skipped.
fn path_within_roots(path: &std::path::Path, roots: &[crate::config::LibraryRoot]) -> bool {
    if roots.is_empty() {
        return true;
    }
    let Ok(canon) = std::fs::canonicalize(path) else {
        return false;
    };
    roots.iter().any(|r| {
        std::fs::canonicalize(&r.path)
            .map(|root| canon.starts_with(&root))
            .unwrap_or(false)
    })
}

/// Optional client capabilities advertised on the stream request as query
/// params, so a GET can carry the same direct-play contract that `play_grant`
/// computes from a JSON body. All fields are optional; absent caps mean "no
/// constraints advertised" and the file streams directly (back-compat).
#[derive(Debug, Deserialize, Default)]
struct StreamCapsQuery {
    containers: Option<String>,
    video_codecs: Option<String>,
    max_height: Option<i64>,
    #[serde(default)]
    hdr: bool,
}

impl StreamCapsQuery {
    /// True when the client advertised any capability constraint at all.
    fn advertised(&self) -> bool {
        self.containers.is_some()
            || self.video_codecs.is_some()
            || self.max_height.is_some()
            || self.hdr
    }

    fn to_caps(&self) -> ClientCaps {
        let split = |s: &Option<String>| {
            s.as_deref()
                .map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        ClientCaps {
            containers: split(&self.containers),
            video_codecs: split(&self.video_codecs),
            max_height: self.max_height,
            hdr: self.hdr,
            max_bitrate: None,
        }
    }
}

async fn stream_file(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    Query(caps_q): Query<StreamCapsQuery>,
    req: Request,
) -> Result<axum::response::Response, AppError> {
    let file = resolve_media_file(&state, &kind, id).await?;

    // Containment: never serve a file outside the configured library roots.
    if !path_within_roots(
        std::path::Path::new(&file.path),
        &state.config.library_roots,
    ) {
        tracing::warn!(path = %file.path, "refusing to stream file outside library roots");
        return Err(AppError::NotFound);
    }

    // Honor the direct-play contract (§3.5): if the client advertised caps and
    // the file can't direct-play, this M3-only deployment has no transcoder, so
    // return 503 rather than shipping bytes the client can't decode.
    if caps_q.advertised() {
        let decision = capability::decide(&file, &caps_q.to_caps());
        if !decision.direct_play {
            tracing::info!(path = %file.path, reason = %decision.reason, "transcode required; refusing direct stream");
            return Err(AppError::TranscoderRequired);
        }
    }

    let service = ServeFile::new(&file.path);
    let resp = service
        .oneshot(req)
        .await
        .map_err(|e| AppError::Internal(format!("stream serve failed: {e}")))?;
    Ok(resp.into_response())
}

// ── Watch state ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WatchQuery {
    pub sub: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WatchUpsert {
    pub media_kind: String,
    pub media_id: i64,
    pub position_secs: i64,
    #[serde(default)]
    pub duration_secs: Option<i64>,
    #[serde(default)]
    pub completed: bool,
}

/// Resolve the acting `sub`. A verified internal principal is always
/// authoritative. The client-supplied `?sub=` fallback is honored **only** in
/// `Off` mode (local/dev, no auth boundary). In `log`/`enforce` mode, trusting
/// `?sub=` would be an IDOR: an authenticated caller — or, in `log` mode, one
/// whose token simply failed to verify — could read or overwrite any other
/// user's watch state by naming their `sub`. So outside `Off` mode the only
/// accepted identity is the verified principal.
fn acting_sub(
    claims: &Option<InternalClaims>,
    query_sub: Option<String>,
    mode: &PrincipalMode,
) -> AppResult<String> {
    if let Some(c) = claims {
        return Ok(c.sub.clone());
    }
    if *mode != PrincipalMode::Off {
        return Err(AppError::Unauthorized(
            "internal-principal required to resolve acting user".into(),
        ));
    }
    match query_sub.filter(|s| !s.is_empty()) {
        Some(s) => Ok(s),
        None => Err(AppError::BadRequest("sub required".into())),
    }
}

async fn get_watch(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    let rows = sqlx::query_as::<_, WatchStateRow>(
        "SELECT sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed \
         FROM media_watch_state WHERE sub = ? ORDER BY watched_at DESC",
    )
    .bind(&sub)
    .fetch_all(&state.db.pool)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

async fn post_watch(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<WatchUpsert>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    let watched_at = chrono::Utc::now().to_rfc3339();
    let completed = i64::from(body.completed);

    sqlx::query(
        "INSERT INTO media_watch_state \
         (sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(sub, media_kind, media_id) DO UPDATE SET \
         position_secs = excluded.position_secs, \
         duration_secs = excluded.duration_secs, \
         watched_at = excluded.watched_at, \
         completed = excluded.completed",
    )
    .bind(&sub)
    .bind(&body.media_kind)
    .bind(body.media_id)
    .bind(body.position_secs)
    .bind(body.duration_secs)
    .bind(&watched_at)
    .bind(completed)
    .execute(&state.db.pool)
    .await?;

    Ok(Json(json!({ "ok": true, "watched_at": watched_at })))
}

// ── Scan trigger ────────────────────────────────────────────────────────

/// Upsert one `scan_state` (key, value, ts) row. Best-effort: logs on failure
/// so the background task never panics on a transient DB error.
async fn set_scan_state(db: &crate::db::Db, key: &str, value: &str) {
    let ts = chrono::Utc::now().to_rfc3339();
    if let Err(e) = sqlx::query(
        "INSERT INTO scan_state (key, value, ts) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
    )
    .bind(key)
    .bind(value)
    .bind(&ts)
    .execute(&db.pool)
    .await
    {
        tracing::warn!("failed to persist scan_state {key}: {e}");
    }
}

async fn get_scan_state(db: &crate::db::Db, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM scan_state WHERE key = ?")
        .bind(key)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten()
}

/// Authorize a scan trigger. A full library rescan is an expensive, DoS-prone
/// operation, so outside `Off` mode (local/dev, no auth boundary) it is gated to
/// admins: the caller must present a verified internal principal whose
/// `role == "admin"`. This mirrors the Hono proxy's `requireAdmin` gate over
/// `/scan` (403 `admin role required`). In `Off` mode there is no principal and
/// no boundary, so the gate is skipped. Returns the rejection response on deny.
fn authorize_scan(
    claims: &Option<InternalClaims>,
    mode: &PrincipalMode,
) -> Result<(), (StatusCode, Json<Value>)> {
    if *mode == PrincipalMode::Off {
        return Ok(());
    }
    let is_admin = claims.as_ref().map(|c| c.role == "admin").unwrap_or(false);
    if is_admin {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "admin role required" })),
        ))
    }
}

/// Kick off a background scan and return `202` immediately. A second request
/// while a scan is in flight returns `409`. Progress + the final report land
/// in the `scan_state` table, readable via `GET /scan/status`.
///
/// Authorization: outside `Off` mode the caller must be a verified admin
/// principal (see [`authorize_scan`]); a non-admin gets `403`.
async fn trigger_scan(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
) -> AppResult<impl IntoResponse> {
    use std::sync::atomic::Ordering;

    let claims = claims.map(|Extension(c)| c);
    if let Err(rejection) = authorize_scan(&claims, &state.config.principal_mode) {
        return Ok(rejection);
    }

    // Atomically claim the scan slot; bail with 409 if already running.
    if state
        .scanning
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok((
            StatusCode::CONFLICT,
            Json(
                json!({ "status": "running", "job_id": get_scan_state(&state.db, "job_id").await }),
            ),
        ));
    }

    let job_id = chrono::Utc::now().timestamp_millis().to_string();
    let started_at = chrono::Utc::now().to_rfc3339();
    set_scan_state(&state.db, "state", "running").await;
    set_scan_state(&state.db, "job_id", &job_id).await;
    set_scan_state(&state.db, "started_at", &started_at).await;
    set_scan_state(&state.db, "finished_at", "").await;

    let bg = state.clone();
    tokio::spawn(async move {
        let result = scanner::scan_once(&bg.db, &bg.config.library_roots, &bg.tmdb).await;
        match result {
            Ok(report) => {
                let json = serde_json::to_string(&report).unwrap_or_else(|_| "{}".into());
                set_scan_state(&bg.db, "last_report", &json).await;
            }
            Err(e) => {
                tracing::warn!("background scan failed: {e}");
                set_scan_state(
                    &bg.db,
                    "last_report",
                    &json!({ "error": e.to_string() }).to_string(),
                )
                .await;
            }
        }
        set_scan_state(&bg.db, "finished_at", &chrono::Utc::now().to_rfc3339()).await;
        set_scan_state(&bg.db, "state", "idle").await;
        bg.scanning.store(false, Ordering::SeqCst);
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "status": "started", "job_id": job_id })),
    ))
}

/// Report the current/last scan status from the `scan_state` table.
async fn scan_status(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let st = get_scan_state(&state.db, "state").await.unwrap_or_default();
    let state_str = if st.is_empty() {
        "idle".to_string()
    } else {
        st
    };
    let last_report = get_scan_state(&state.db, "last_report")
        .await
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let started_at = get_scan_state(&state.db, "started_at").await;
    let finished_at = get_scan_state(&state.db, "finished_at")
        .await
        .filter(|s| !s.is_empty());
    Ok(Json(json!({
        "state": state_str,
        "last_report": last_report,
        "started_at": started_at,
        "finished_at": finished_at,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn test_state() -> AppState {
        // Off-mode: no principal secret/mode wired → principal_layer skips
        // auth, so handlers fall back to the `?sub=` query param.
        unsafe {
            std::env::remove_var("MEDIA_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("RECOMMENDER_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("INTERNAL_PRINCIPAL_SECRET");
        }
        let db = crate::db::Db::connect_memory().await.unwrap();
        let config = Arc::new(Config::from_env().unwrap());
        let tmdb = crate::tmdb::TmdbClient::new(None);
        AppState {
            db,
            config,
            tmdb,
            scanning: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Enforce-mode state with a known principal secret wired in, so the
    /// `principal_layer` actually verifies the signed Bearer internal-principal
    /// token and the admin gate over `/scan` is live.
    async fn test_state_enforce(secret: &str) -> AppState {
        let db = crate::db::Db::connect_memory().await.unwrap();
        let config = Arc::new(Config {
            host: "127.0.0.1".into(),
            port: 0,
            db_path: ":memory:".into(),
            library_roots: Vec::new(),
            internal_principal_secret: Some(secret.to_string()),
            principal_mode: PrincipalMode::Enforce,
            server_id: "srv-test".into(),
            tmdb_api_key: None,
            scan_interval_secs: 0,
            boot_scan: false,
        });
        let tmdb = crate::tmdb::TmdbClient::new(None);
        AppState {
            db,
            config,
            tmdb,
            scanning: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Mint a Bearer internal-principal token for `role`, signed the same way
    /// the Hono proxy does (HKDF-derived key from the shared secret), so the
    /// `principal_layer` accepts it and inserts the claims into request
    /// extensions for the admin gate to inspect.
    fn signed_principal(secret: &str, role: &str) -> String {
        use emerald_contracts::derive_key;
        use emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL;
        use emerald_contracts::internal_principal::{
            DEFAULT_KID, DEFAULT_TTL_SECS, InternalClaims, encrypt,
        };
        let now = chrono::Utc::now().timestamp();
        let claims = InternalClaims {
            iss: "eex".into(),
            sub: "plex:caller".into(),
            role: role.into(),
            auth_mode: "plex".into(),
            server_id: "srv-test".into(),
            device_id: None,
            req_id: "scan-test".into(),
            iat: now,
            exp: now + DEFAULT_TTL_SECS,
        };
        let key = derive_key(secret.as_bytes(), INFO_INTERNAL_PRINCIPAL);
        encrypt(&key, DEFAULT_KID, &claims)
    }

    async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn seed_media_file(state: &AppState, path: &str) -> i64 {
        sqlx::query(
            "INSERT INTO media_files \
             (path, size_bytes, mtime, container, duration_secs, video_codec, video_height, \
             video_profile, hdr_format, audio_tracks_json, subtitle_tracks_json, scanned_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(path)
        .bind(1_000_i64)
        .bind("2026-01-01T00:00:00Z")
        .bind("mp4")
        .bind(3600_i64)
        .bind("h264")
        .bind(1080_i64)
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind("[]")
        .bind("[]")
        .bind("2026-01-01T00:00:00Z")
        .execute(&state.db.pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    #[tokio::test]
    async fn list_movies_returns_seeded_movie() {
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/a.mp4").await;
        sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
            .bind("The Matrix")
            .bind(1999_i64)
            .bind("2026-01-01T00:00:00Z")
            .bind(file_id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/movies")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 1);
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        assert_eq!(v["items"][0]["title"], "The Matrix");
    }

    #[tokio::test]
    async fn get_movie_missing_is_404() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/movies/9999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_episodes_is_ordered() {
        let state = test_state().await;
        let show_id: i64 = sqlx::query("INSERT INTO shows (title, added_at) VALUES (?, ?)")
            .bind("Foo")
            .bind("2026-01-01T00:00:00Z")
            .execute(&state.db.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        let f1 = seed_media_file(&state, "/lib/s1e2.mp4").await;
        let f2 = seed_media_file(&state, "/lib/s1e1.mp4").await;
        // Insert out of order; query must return season,episode order.
        sqlx::query(
            "INSERT INTO episodes (show_id, season, episode, title, file_id) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(show_id)
        .bind(1_i64)
        .bind(2_i64)
        .bind("Ep2")
        .bind(f1)
        .execute(&state.db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO episodes (show_id, season, episode, title, file_id) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(show_id)
        .bind(1_i64)
        .bind(1_i64)
        .bind("Ep1")
        .bind(f2)
        .execute(&state.db.pool)
        .await
        .unwrap();

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!("/api/media/shows/{show_id}/episodes"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["episode"], 1);
        assert_eq!(items[1]["episode"], 2);
    }

    #[tokio::test]
    async fn watch_state_round_trips() {
        let state = test_state().await;
        let app = crate::build_router(state);

        let post = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/watch?sub=plex:1")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "media_kind": "movie",
                            "media_id": 7,
                            "position_secs": 120,
                            "duration_secs": 3600,
                            "completed": false
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(post.status(), StatusCode::OK);

        let get = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/watch?sub=plex:1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        let v = body_json(get).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["sub"], "plex:1");
        assert_eq!(items[0]["media_id"], 7);
        assert_eq!(items[0]["position_secs"], 120);
    }

    async fn seed_show_with_episodes(state: &AppState, n: i64) {
        let show_id: i64 =
            sqlx::query("INSERT INTO shows (title, norm_title, added_at) VALUES (?, ?, ?)")
                .bind("Bar")
                .bind("bar")
                .bind("2026-01-01T00:00:00Z")
                .execute(&state.db.pool)
                .await
                .unwrap()
                .last_insert_rowid();
        for i in 1..=n {
            let f = seed_media_file(state, &format!("/lib/bar_s1e{i}.mp4")).await;
            sqlx::query(
                "INSERT INTO episodes (show_id, season, episode, title, file_id) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(show_id)
            .bind(1_i64)
            .bind(i)
            .bind(format!("Ep{i}"))
            .bind(f)
            .execute(&state.db.pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn list_episodes_all_returns_items_and_total() {
        let state = test_state().await;
        seed_show_with_episodes(&state, 3).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/episodes")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 3);
        assert_eq!(v["items"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn list_episodes_all_honors_limit() {
        let state = test_state().await;
        seed_show_with_episodes(&state, 3).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/episodes?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 3);
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn acting_sub_rejects_query_sub_outside_off_mode() {
        use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims};
        // Off mode: ?sub= is honored (local/dev).
        assert_eq!(
            acting_sub(&None, Some("plex:1".into()), &PrincipalMode::Off).unwrap(),
            "plex:1"
        );
        // Log mode with no verified claims (e.g. a token that failed to
        // verify): ?sub= must be REJECTED — this is the IDOR guard.
        let err = acting_sub(&None, Some("plex:victim".into()), &PrincipalMode::Log);
        assert!(matches!(err, Err(AppError::Unauthorized(_))));
        // Enforce mode likewise rejects a bare ?sub=.
        let err = acting_sub(&None, Some("plex:victim".into()), &PrincipalMode::Enforce);
        assert!(matches!(err, Err(AppError::Unauthorized(_))));
        // A verified principal is always authoritative and ignores ?sub=.
        let now = 1_748_000_000;
        let claims = Some(InternalClaims {
            iss: "eex".into(),
            sub: "plex:real".into(),
            role: "user".into(),
            auth_mode: "plex".into(),
            server_id: "srv".into(),
            device_id: None,
            req_id: "r1".into(),
            iat: now,
            exp: now + DEFAULT_TTL_SECS,
        });
        assert_eq!(
            acting_sub(
                &claims,
                Some("plex:attacker".into()),
                &PrincipalMode::Enforce
            )
            .unwrap(),
            "plex:real"
        );
    }

    #[tokio::test]
    async fn stream_refuses_when_client_caps_require_transcode() {
        // A file the advertised client cannot direct-play must 503, not stream.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/hevc.mkv").await;
        // seed_media_file stores container=mp4, codec=h264, height=1080; ask
        // for an mp4/av1 client so codec mismatch forces transcode.
        sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
            .bind("Needs Transcode")
            .bind(2020_i64)
            .bind("2026-01-01T00:00:00Z")
            .bind(file_id)
            .execute(&state.db.pool)
            .await
            .unwrap();
        let movie_id: i64 = sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&state.db.pool)
            .await
            .unwrap();

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn trigger_scan_returns_202_with_job_id_then_idle() {
        let state = test_state().await;
        let app = crate::build_router(state.clone());
        let resp = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let v = body_json(resp).await;
        assert_eq!(v["status"], "started");
        assert!(v["job_id"].as_str().is_some());

        // With empty library_roots the background scan completes ~instantly;
        // poll scan/status until it reports idle (bounded).
        let mut idle = false;
        for _ in 0..50 {
            let st = app
                .clone()
                .oneshot(
                    HttpRequest::builder()
                        .uri("/api/media/scan/status")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let sv = body_json(st).await;
            if sv["state"] == "idle" {
                idle = true;
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(idle, "scan/status never returned idle");
    }

    #[test]
    fn authorize_scan_admin_gate() {
        use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims};

        let now = 1_748_000_000;
        let mk = |role: &str| {
            Some(InternalClaims {
                iss: "eex".into(),
                sub: "plex:caller".into(),
                role: role.into(),
                auth_mode: "plex".into(),
                server_id: "srv".into(),
                device_id: None,
                req_id: "r1".into(),
                iat: now,
                exp: now + DEFAULT_TTL_SECS,
            })
        };

        // Off mode: no boundary, gate is skipped regardless of role/claims.
        assert!(authorize_scan(&None, &PrincipalMode::Off).is_ok());
        assert!(authorize_scan(&mk("user"), &PrincipalMode::Off).is_ok());

        // Enforce/Log: admin allowed.
        assert!(authorize_scan(&mk("admin"), &PrincipalMode::Enforce).is_ok());
        assert!(authorize_scan(&mk("admin"), &PrincipalMode::Log).is_ok());

        // Enforce/Log: non-admin and missing principal are rejected with 403.
        for (claims, mode) in [
            (mk("user"), PrincipalMode::Enforce),
            (mk("user"), PrincipalMode::Log),
            (None, PrincipalMode::Enforce),
            (None, PrincipalMode::Log),
        ] {
            let err = authorize_scan(&claims, &mode).expect_err("should reject");
            assert_eq!(err.0, StatusCode::FORBIDDEN);
            assert_eq!(err.1.0["error"], "admin role required");
        }
    }

    #[tokio::test]
    async fn scan_rejects_non_admin_with_403() {
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .header(
                        "authorization",
                        format!("Bearer {}", signed_principal(secret, "user")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let v = body_json(resp).await;
        assert_eq!(v["error"], "admin role required");
    }

    #[tokio::test]
    async fn scan_rejects_missing_principal_with_403() {
        // Enforce mode requires a principal; a missing one is rejected by the
        // principal_layer (401) before reaching the admin gate. Either way an
        // unauthenticated caller cannot trigger a rescan.
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            resp.status() == StatusCode::FORBIDDEN || resp.status() == StatusCode::UNAUTHORIZED,
            "missing principal must not be allowed to scan; got {}",
            resp.status()
        );
    }

    #[tokio::test]
    async fn scan_allows_admin_with_202() {
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .header(
                        "authorization",
                        format!("Bearer {}", signed_principal(secret, "admin")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let v = body_json(resp).await;
        assert_eq!(v["status"], "started");
        assert!(v["job_id"].as_str().is_some());
    }
}
