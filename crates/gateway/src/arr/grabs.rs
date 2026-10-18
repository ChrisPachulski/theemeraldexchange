//! /api/grabs (routes/grabs.ts): read-only views of the grab-event log.
//! `/recent` is the admin activity feed; `/by-item` is one title's history,
//! scoped to the caller's own events (the small sequential *arr ids are no
//! capability), with pre-attribution rows still visible.

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::json;

use super::shared::{events_response, query_first, query_pairs};
use crate::AppState;
use crate::routes::{js_str_number, safe_positive};
use crate::upstream::Arr;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/grabs/recent", get(recent))
        .route("/api/grabs/by-item", get(by_item))
}

/// A positive number floored and capped; anything else is the fallback.
fn limit(raw: Option<&str>, fallback: usize, max: usize) -> usize {
    let n = raw.map_or(f64::NAN, js_str_number);
    if !n.is_finite() || n <= 0.0 {
        return fallback;
    }
    (n.floor() as usize).min(max)
}

async fn recent(State(st): State<AppState>, _: auth::RequireAdmin, uri: Uri) -> Response {
    let pairs = query_pairs(&uri);
    let n = limit(query_first(&pairs, "limit"), 20, 200);
    events_response(&st.arr.grabs.recent(n).await)
}

async fn by_item(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    uri: Uri,
) -> Response {
    let pairs = query_pairs(&uri);
    let app = match query_first(&pairs, "app") {
        Some("sonarr") => Arr::Sonarr,
        Some("radarr") => Arr::Radarr,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid_app" })),
            )
                .into_response();
        }
    };
    let Some(item) = query_first(&pairs, "itemId")
        .map(js_str_number)
        .and_then(safe_positive)
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_itemId" })),
        )
            .into_response();
    };
    let n = limit(query_first(&pairs, "limit"), 20, 100);
    events_response(&st.arr.grabs.for_item(app, item, n, &p.session.sub).await)
}
