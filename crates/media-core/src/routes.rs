//! HTTP surface. `/health` + `/version` are public; everything under
//! `/api/media/*` sits behind the internal-principal layer.

use axum::Json;
use axum::extract::{Path, Query, Request, State};
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
        .route("/episodes/{id}", get(get_episode))
        .route("/play/{kind}/{id}/grant", post(play_grant))
        .route("/stream/{kind}/{id}", get(stream_file))
        .route("/watch", get(get_watch).post(post_watch))
        .route("/scan", post(trigger_scan))
        .layer(middleware::from_fn_with_state(state.clone(), principal_layer));

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
        "library_roots": state.config.library_paths.len(),
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
                "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id \
                 FROM movies WHERE title LIKE '%' || ? || '%' \
                 ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(term)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM movies WHERE title LIKE '%' || ? || '%'",
            )
            .bind(term)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, MovieRow>(
                "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id \
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
        "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id FROM movies WHERE id = ?",
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
                "SELECT id, tmdb_id, tvdb_id, title, year, added_at \
                 FROM shows WHERE title LIKE '%' || ? || '%' \
                 ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(term)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM shows WHERE title LIKE '%' || ? || '%'",
            )
            .bind(term)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, ShowRow>(
                "SELECT id, tmdb_id, tvdb_id, title, year, added_at \
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
        "SELECT id, tmdb_id, tvdb_id, title, year, added_at FROM shows WHERE id = ?",
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
async fn resolve_media_file(
    state: &AppState,
    kind: &str,
    id: i64,
) -> AppResult<MediaFileRow> {
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

async fn stream_file(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    req: Request,
) -> Result<axum::response::Response, AppError> {
    let file = resolve_media_file(&state, &kind, id).await?;
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

/// Resolve the acting `sub`: prefer the verified internal principal, else
/// fall back to an explicit `?sub=` query param (off-mode), else error.
fn acting_sub(
    claims: &Option<InternalClaims>,
    query_sub: Option<String>,
) -> AppResult<String> {
    if let Some(c) = claims {
        return Ok(c.sub.clone());
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
    let sub = acting_sub(&claims, q.sub)?;
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
    let sub = acting_sub(&claims, q.sub)?;
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

async fn trigger_scan(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let report = scanner::scan_once(&state.db, &state.config.library_paths).await?;
    Ok(Json(json!(report)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
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
        let config = Arc::new(Config::from_env());
        AppState { db, config }
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
        sqlx::query(
            "INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)",
        )
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
}
