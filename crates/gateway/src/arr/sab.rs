//! /api/sab (routes/sab.ts). SAB is one endpoint upstream (`mode=`/`name=`);
//! here reads are GET (queue, history: any member with the downloads
//! section) and the queue mutations are POST/DELETE (admin), so a
//! cross-site GET can never pause or delete anything.

use axum::extract::{Path, State};
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::json;

use super::gate;
use super::shared::{query_first, query_pairs};
use crate::AppState;
use crate::routes::js_str_number;
use crate::stores::Section;
use crate::upstream::Reply;

const DOWNLOADS: (Section, bool) = (Section::Downloads, false);
const DEFAULT_HISTORY_LIMIT: f64 = 10.0;
const MAX_HISTORY_LIMIT: f64 = 100.0;

type Res = Result<Response, Response>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sab/api", get(read))
        .route("/api/sab/api/queue/{nzo}/pause", post(pause))
        .route("/api/sab/api/queue/{nzo}/resume", post(resume))
        .route("/api/sab/api/queue/{nzo}", delete(remove))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response()
}

/// A `name` parameter is refused outright: the legacy
/// `?mode=queue&name=pause` GET must never act.
async fn read(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    gate(&st, &p, &method, DOWNLOADS, false, None).await?;
    let pairs = query_pairs(&uri);
    if pairs.iter().any(|(k, _)| k == "name") {
        return Ok(not_found());
    }
    let r = match query_first(&pairs, "mode") {
        Some("queue") => st.upstream.sab_call(&st.config, "queue", &[]).await?,
        Some("history") => {
            let limit = history_limit(query_first(&pairs, "limit"));
            st.upstream
                .sab_call(&st.config, "history", &[("limit", &limit)])
                .await?
        }
        _ => return Ok(not_found()),
    };
    Ok(forward(r))
}

fn history_limit(raw: Option<&str>) -> String {
    let n = raw.map_or(DEFAULT_HISTORY_LIMIT, |r| {
        let v = js_str_number(r);
        if v.fract() == 0.0 && v >= 1.0 {
            v.min(MAX_HISTORY_LIMIT)
        } else {
            DEFAULT_HISTORY_LIMIT
        }
    });
    (n as u64).to_string()
}

/// The bucket runs before the admin check (Hono's order), so a member's
/// refused attempts still spend it.
async fn mutate(
    st: &AppState,
    p: &auth::Principal,
    method: &Method,
    extra: &[(&str, &str)],
) -> Res {
    gate(st, p, method, DOWNLOADS, false, Some(&st.arr.sab_limit)).await?;
    if p.session.role != auth::Role::Admin {
        return Err(auth::Rejection::AdminOnly.into_response());
    }
    Ok(forward(
        st.upstream.sab_call(&st.config, "queue", extra).await?,
    ))
}

async fn pause(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path(nzo): Path<String>,
) -> Res {
    mutate(&st, &p, &method, &[("name", "pause"), ("value", &nzo)]).await
}

async fn resume(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path(nzo): Path<String>,
) -> Res {
    mutate(&st, &p, &method, &[("name", "resume"), ("value", &nzo)]).await
}

async fn remove(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path(nzo): Path<String>,
) -> Res {
    mutate(
        &st,
        &p,
        &method,
        &[("name", "delete"), ("value", &nzo), ("del_files", "1")],
    )
    .await
}

/// output=json is forced, so a 2xx that is not JSON is SAB's HTML error page
/// for a rejected key, answered as a clear auth failure instead of a 200
/// the SPA cannot parse.
fn forward(r: Reply) -> Response {
    let ct = r.headers.get(header::CONTENT_TYPE).cloned();
    let json_ct = ct
        .as_ref()
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("application/json"));
    if r.is_success() && !json_ct && serde_json::from_slice::<serde_json::Value>(&r.body).is_err() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "sab_auth_failed" })),
        )
            .into_response();
    }
    let mut res = (r.status, r.body).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        ct.unwrap_or_else(|| HeaderValue::from_static("application/json")),
    );
    res
}
