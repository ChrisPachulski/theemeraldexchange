//! HTTP surface. `/health` + `/version` are public; everything under
//! `/api/media/*` sits behind the internal-principal layer.
//!
//! Library/grant/stream/watch handlers are stubs here (compile + return
//! empty) — OWNER: agent D fills them in against `db`, `models`,
//! `capability`, and `scanner`. Do NOT change `router()` wiring or the
//! `/health` + `/version` handlers without coordinating.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Router, middleware};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::principal_layer;
use crate::error::AppResult;
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

// ── Library read APIs (agent D) ──────────────────────────────────────────

async fn list_movies(
    State(_state): State<AppState>,
    Query(_q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(json!({ "items": [], "total": 0 })))
}

async fn get_movie(State(_state): State<AppState>, Path(_id): Path<i64>) -> AppResult<Json<Value>> {
    Ok(Json(json!({})))
}

async fn list_shows(
    State(_state): State<AppState>,
    Query(_q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(json!({ "items": [], "total": 0 })))
}

async fn get_show(State(_state): State<AppState>, Path(_id): Path<i64>) -> AppResult<Json<Value>> {
    Ok(Json(json!({})))
}

async fn list_episodes(
    State(_state): State<AppState>,
    Path(_show_id): Path<i64>,
) -> AppResult<Json<Value>> {
    Ok(Json(json!({ "items": [] })))
}

async fn get_episode(
    State(_state): State<AppState>,
    Path(_id): Path<i64>,
) -> AppResult<Json<Value>> {
    Ok(Json(json!({})))
}

// ── Playback (agent D, uses capability + scanner) ───────────────────────

async fn play_grant(
    State(_state): State<AppState>,
    Path((_kind, _id)): Path<(String, i64)>,
    body: Option<Json<Value>>,
) -> AppResult<Json<Value>> {
    let _ = body;
    Ok(Json(json!({ "directPlay": false, "transcoderRequired": false })))
}

async fn stream_file(
    State(_state): State<AppState>,
    Path((_kind, _id)): Path<(String, i64)>,
) -> impl IntoResponse {
    StatusCode::NOT_IMPLEMENTED
}

// ── Watch state (agent D) ───────────────────────────────────────────────

async fn get_watch(State(_state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(json!({ "items": [] })))
}

async fn post_watch(
    State(_state): State<AppState>,
    body: Option<Json<Value>>,
) -> AppResult<Json<Value>> {
    let _ = body;
    Ok(Json(json!({ "ok": true })))
}

// ── Scan trigger (agent B/D) ────────────────────────────────────────────

async fn trigger_scan(State(_state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(json!({ "started": true })))
}
