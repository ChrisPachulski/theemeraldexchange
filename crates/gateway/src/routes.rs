//! The per-user routes over [`crate::stores`]: /api/feedback (the dots and
//! the household veto), /api/watchlist, /api/policy plus the admin
//! /api/users/policies and /api/users/:sub/policy, and
//! /api/settings/anthropic-key. Every route acts on the caller's own sub;
//! only the admin policy routes name another member.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::recommender::{self, Caller};
use crate::stores::{
    self, CONTENT_RATINGS, Kind, MAX_SAFE, Policy, Sections, Signal, StoreError, WatchEntry,
};

/// A policy document, a watchlist entry, a pasted key: well under 1 KB.
const SMALL_BODY_LIMIT: usize = 4 * 1024;
/// Hono read the dot body unbounded.
const FEEDBACK_BODY_LIMIT: usize = 64 * 1024;
const EXPECTED_SUB_HEADER: &str = "x-eex-expected-sub";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/feedback", get(feedback_get).post(feedback_post))
        .route(
            "/api/feedback/{kind}/{tmdb_id}/{signal}",
            delete(feedback_delete),
        )
        .route("/api/watchlist", get(watchlist_get))
        .route(
            "/api/watchlist/{kind}/{id}",
            put(watchlist_put).delete(watchlist_delete),
        )
        .route("/api/policy", get(own_policy))
        .route("/api/users/policies", get(all_policies))
        .route("/api/users/{sub}/policy", put(set_policy))
        .route(
            "/api/settings/anthropic-key",
            get(key_get).put(key_put).delete(key_delete),
        )
        .merge(crate::recommender::router())
        .merge(crate::syncplay::router())
}

// --- shared helpers -----------------------------------------------------------

pub fn err(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

pub fn ok() -> Response {
    Json(json!({ "ok": true })).into_response()
}

/// JS truthiness of a parsed body.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `Number(s)` for the decimal forms clients send: blank is 0, anything
/// unparsable is NaN. Hex/octal/binary literals read as NaN here.
pub fn js_str_number(s: &str) -> f64 {
    let t = auth::js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let plain = t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'));
    if plain {
        t.parse().unwrap_or(f64::NAN)
    } else if matches!(t, "Infinity" | "+Infinity") {
        f64::INFINITY
    } else if t == "-Infinity" {
        f64::NEG_INFINITY
    } else {
        f64::NAN
    }
}

/// JS `Number(v)` for a body value (an array or object is NaN here).
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_str_number(s),
        Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
    }
}

/// `Number.isSafeInteger(n) && n > 0`.
pub fn safe_positive(n: f64) -> Option<u64> {
    (n.fract() == 0.0 && n > 0.0 && n <= MAX_SAFE).then_some(n as u64)
}

/// Per-(kind, tmdbId) serialization of the two-store feedback mutations:
/// each store has its own writer, but nothing orders a red-to-green flip
/// against a concurrent dislike of the same title, which could leave a
/// dislike without its household veto. Unrelated titles stay parallel.
#[derive(Default)]
pub struct ItemLocks(std::sync::Mutex<HashMap<(Kind, u64), ItemLock>>);

type ItemLock = Arc<tokio::sync::Mutex<()>>;

impl ItemLocks {
    pub async fn run<R>(&self, key: (Kind, u64), f: impl Future<Output = R>) -> R {
        let lock = self.0.lock().unwrap().entry(key).or_default().clone();
        let out = {
            let _held = lock.lock().await;
            f.await
        };
        // The map and this clone are the only holders: nobody is waiting.
        let mut map = self.0.lock().unwrap();
        if Arc::strong_count(&lock) == 2 {
            map.remove(&key);
        }
        out
    }
}

// --- /api/feedback ------------------------------------------------------------

async fn feedback_get(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
) -> Result<Response, StoreError> {
    Ok(Json(st.stores.feedback.user(&p.session.sub).await?).into_response())
}

async fn feedback_post(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match auth::json_body(body, FEEDBACK_BODY_LIMIT).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !truthy(&body) {
        return err(StatusCode::BAD_REQUEST, "invalid_body");
    }
    let Some(kind) = body
        .get("type")
        .and_then(Value::as_str)
        .and_then(Kind::parse)
    else {
        return err(StatusCode::BAD_REQUEST, "invalid_type");
    };
    let Some(signal) = body
        .get("signal")
        .and_then(Value::as_str)
        .and_then(Signal::parse)
    else {
        return err(StatusCode::BAD_REQUEST, "invalid_signal");
    };
    // The stores keep positive integer ids; 1.5 or 1e20 would persist a row
    // the next load drops.
    let Some(id) = safe_positive(js_number(body.get("tmdbId"))) else {
        return err(StatusCode::BAD_REQUEST, "invalid_tmdbId");
    };
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let caller = Caller::new(&p, &headers);
    locked(&st, kind, id, move |st| async move {
        set_signal(&st, &caller, kind, id, signal, &title).await
    })
    .await
}

/// Run `f` under the item lock on its own task, so a client that hangs up
/// cannot stop a two-store write halfway.
async fn locked<F, Fut>(st: &AppState, kind: Kind, id: u64, f: F) -> Response
where
    F: FnOnce(AppState) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), StoreError>> + Send,
{
    let st = st.clone();
    let work = tokio::spawn(async move {
        let locks = st.item_locks.clone();
        locks.run((kind, id), f(st)).await
    });
    match work.await {
        Ok(Ok(())) => ok(),
        Ok(Err(e)) => e.into_response(),
        Err(e) => {
            tracing::error!(event = "feedback", error = %e, "feedback task failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
        }
    }
}

async fn set_signal(
    st: &AppState,
    caller: &Caller,
    kind: Kind,
    id: u64,
    signal: Signal,
    title: &str,
) -> Result<(), StoreError> {
    let (feedback, rejections) = (&st.stores.feedback, &st.stores.rejections);
    let sub = caller.principal.session.sub.as_str();
    let mine = feedback.user(sub).await?;
    let mine = mine.kind(kind);
    let mut opposite = None;
    // Whether the like dropped the household veto (mirrored below).
    let mut veto_cleared = false;

    match signal {
        Signal::Dislike => {
            // The household veto first: its rollback is a plain remove, and
            // if it fails nothing personal has changed yet.
            if mine.liked.iter().any(|e| e.id == id) {
                opposite = Some(Signal::Like);
            }
            let was_rejected = rejections.ids(kind).await?.contains(&id);
            rejections.add(kind, id, title).await?;
            if let Err(e) = feedback.set(sub, kind, id, title, Some(signal)).await {
                // Undo the veto only if this call added it and nobody else
                // dissents.
                if !was_rejected
                    && !feedback
                        .another_user_dislikes(sub, kind, id)
                        .await
                        .unwrap_or(true)
                    && let Err(rb) = rejections.remove(kind, id).await
                {
                    tracing::error!(event = "feedback", set_err = %e, rb_err = %rb,
                        "dislike rollback failed - split-brain (rejection persisted, personal write failed)");
                }
                return Err(e);
            }
        }
        Signal::Like => {
            // Red to green: the earlier dislike put the title in the
            // household veto, which would keep filtering it out of every
            // suggestion. Drop it unless another member still dissents.
            let prior = mine.disliked.iter().find(|e| e.id == id).cloned();
            if prior.is_some() {
                opposite = Some(Signal::Dislike);
                if !feedback.another_user_dislikes(sub, kind, id).await? {
                    rejections.remove(kind, id).await?;
                    veto_cleared = true;
                }
            }
            if let Err(e) = feedback.set(sub, kind, id, title, Some(signal)).await {
                if veto_cleared {
                    let restore = prior.map_or(title.to_string(), |p| p.title);
                    if let Err(rb) = rejections.add(kind, id, &restore).await {
                        tracing::error!(event = "feedback", set_err = %e, rb_err = %rb,
                            "red-to-green rollback failed - split-brain (rejection cleared, like write failed)");
                    }
                }
                return Err(e);
            }
        }
    }

    if st.config.use_local_recommender {
        let c = Some(caller);
        if let Some(op) = opposite {
            recommender::post_clear_feedback(st, sub, kind, id, Some(op.as_str()), c);
        }
        recommender::post_feedback(st, sub, kind, id, signal.as_str(), c);
        match signal {
            Signal::Dislike => recommender::post_rejection(st, kind, id, c),
            Signal::Like if veto_cleared => recommender::post_clear_rejection(st, kind, id, c),
            Signal::Like => {}
        }
    }
    Ok(())
}

async fn feedback_delete(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    headers: HeaderMap,
    Path((kind, tmdb_id, signal)): Path<(String, String, String)>,
) -> Response {
    let Some(kind) = Kind::parse(&kind) else {
        return err(StatusCode::BAD_REQUEST, "invalid_type");
    };
    if Signal::parse(&signal).is_none() {
        return err(StatusCode::BAD_REQUEST, "invalid_signal");
    }
    let Some(id) = safe_positive(js_str_number(&tmdb_id)) else {
        return err(StatusCode::BAD_REQUEST, "invalid_tmdbId");
    };
    let caller = Caller::new(&p, &headers);
    locked(&st, kind, id, move |st| async move {
        clear_signal(&st, &caller, kind, id).await
    })
    .await
}

/// The URL's :signal is a client hint that may be stale (double click, a
/// second tab); the stored signal decides whether the veto is touched.
async fn clear_signal(
    st: &AppState,
    caller: &Caller,
    kind: Kind,
    id: u64,
) -> Result<(), StoreError> {
    let (feedback, rejections) = (&st.stores.feedback, &st.stores.rejections);
    let sub = caller.principal.session.sub.as_str();
    let mine = feedback.user(sub).await?;
    let mine = mine.kind(kind);
    let prior_dislike = mine.disliked.iter().find(|e| e.id == id);
    let prior_like = mine.liked.iter().find(|e| e.id == id);
    let actual = if prior_dislike.is_some() {
        Some(Signal::Dislike)
    } else if prior_like.is_some() {
        Some(Signal::Like)
    } else {
        None
    };
    let prior_title = prior_dislike
        .or(prior_like)
        .map(|e| e.title.clone())
        .unwrap_or_default();

    feedback.set(sub, kind, id, "", None).await?;

    let mut veto_removed = false;
    if actual == Some(Signal::Dislike) {
        let dropped = async {
            // Keep the veto while another member still dissents.
            if !feedback.another_user_dislikes(sub, kind, id).await? {
                rejections.remove(kind, id).await?;
                veto_removed = true;
            }
            Ok::<_, StoreError>(())
        }
        .await;
        if let Err(e) = dropped {
            // Restore the dislike so the member is not left cleared while
            // the household veto still applies.
            if let Err(rb) = feedback
                .set(sub, kind, id, &prior_title, Some(Signal::Dislike))
                .await
            {
                tracing::error!(event = "feedback", rem_err = %e, rb_err = %rb,
                    "dislike-delete rollback failed - split-brain (personal cleared, household veto kept)");
            }
            return Err(e);
        }
    }

    if st.config.use_local_recommender {
        let c = Some(caller);
        recommender::post_clear_feedback(st, sub, kind, id, actual.map(Signal::as_str), c);
        if veto_removed {
            recommender::post_clear_rejection(st, kind, id, c);
        }
    }
    Ok(())
}

// --- /api/watchlist ---------------------------------------------------------------

#[derive(Serialize)]
struct Item<'a> {
    kind: Kind,
    #[serde(flatten)]
    entry: &'a WatchEntry,
}

/// Both kinds as one list, newest `added_at` first: the shape GET, PUT and
/// DELETE all answer with.
async fn watchlist_items(st: &AppState, sub: &str) -> Result<Response, StoreError> {
    let wl = st.stores.watchlist.user(sub).await?;
    let mut items: Vec<Item> = wl
        .movie
        .iter()
        .map(|entry| Item {
            kind: Kind::Movie,
            entry,
        })
        .chain(wl.tv.iter().map(|entry| Item {
            kind: Kind::Tv,
            entry,
        }))
        .collect();
    items.sort_by(|a, b| b.entry.added_at.cmp(&a.entry.added_at));
    #[derive(Serialize)]
    struct Items<'a> {
        items: Vec<Item<'a>>,
    }
    Ok(Json(Items { items }).into_response())
}

#[allow(clippy::result_large_err)]
fn watch_target(kind: &str, id: &str) -> Result<(Kind, u64), Response> {
    let kind = Kind::parse(kind).ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_kind"))?;
    let id = safe_positive(js_str_number(id))
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_id"))?;
    Ok((kind, id))
}

async fn watchlist_get(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
) -> Result<Response, StoreError> {
    watchlist_items(&st, &p.session.sub).await
}

async fn watchlist_put(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    Path((kind, id)): Path<(String, String)>,
    body: Body,
) -> Result<Response, Response> {
    let (kind, id) = watch_target(&kind, &id)?;
    let body = auth::json_body(body, SMALL_BODY_LIMIT).await?;
    let title = auth::js_trim(
        body.get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if title.is_empty() || auth::js_len(title) > stores::MAX_WATCHLIST_STR_LEN {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_title"));
    }
    let poster = match body.get("poster_path") {
        None => None,
        Some(Value::String(s)) if auth::js_len(s) <= stores::MAX_WATCHLIST_STR_LEN => {
            Some(s.as_str())
        }
        Some(_) => return Err(err(StatusCode::BAD_REQUEST, "invalid_poster_path")),
    };
    let sub = &p.session.sub;
    st.stores
        .watchlist
        .upsert(sub, kind, id, title, poster)
        .await
        .map_err(IntoResponse::into_response)?;
    watchlist_items(&st, sub)
        .await
        .map_err(IntoResponse::into_response)
}

async fn watchlist_delete(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Response, Response> {
    let (kind, id) = watch_target(&kind, &id)?;
    let sub = &p.session.sub;
    st.stores
        .watchlist
        .remove(sub, kind, id)
        .await
        .map_err(IntoResponse::into_response)?;
    watchlist_items(&st, sub)
        .await
        .map_err(IntoResponse::into_response)
}

// --- /api/policy and the admin /api/users policy routes ---------------------------

async fn own_policy(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
) -> Result<Response, StoreError> {
    Ok(Json(st.stores.policies.policy(&p.session.sub).await?).into_response())
}

async fn all_policies(
    State(st): State<AppState>,
    _admin: auth::RequireAdmin,
) -> Result<Response, StoreError> {
    #[derive(Serialize)]
    struct All<'a> {
        policies: &'a stores::PoliciesFile,
    }
    let all = st.stores.policies.get().await?;
    Ok(Json(All { policies: &all }).into_response())
}

async fn set_policy(
    State(st): State<AppState>,
    _admin: auth::RequireAdmin,
    Path(sub): Path<String>,
    body: Body,
) -> Result<Response, Response> {
    if sub.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_sub"));
    }
    let body = auth::json_body(body, SMALL_BODY_LIMIT).await?;
    let policy = parse_policy(&body).map_err(|code| err(StatusCode::BAD_REQUEST, code))?;
    let policies = &st.stores.policies;
    let stored = async {
        policies.set(&sub, policy).await?;
        policies.policy(&sub).await
    }
    .await
    .map_err(IntoResponse::into_response)?;
    Ok(Json(stored).into_response())
}

/// Strict: unknown keys and wrong types are a 400, so an admin write can
/// never persist a policy the gates would misread. PUT replaces the whole
/// document, so an omitted key takes its open default (the Swift client
/// omits maxContentRating when unrestricted, which must clear a cap).
pub fn parse_policy(raw: &Value) -> Result<Policy, &'static str> {
    let o = raw.as_object().ok_or("invalid_body")?;
    if o.keys()
        .any(|k| !matches!(k.as_str(), "maxContentRating" | "allowedSections" | "kid"))
    {
        return Err("unknown_key");
    }
    let rating = match o.get("maxContentRating") {
        None | Some(Value::Null) => None,
        Some(Value::String(r)) if CONTENT_RATINGS.contains(&r.as_str()) => Some(r.clone()),
        Some(_) => return Err("invalid_maxContentRating"),
    };
    let kid = match o.get("kid") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("invalid_kid"),
    };
    let sections = match o.get("allowedSections") {
        None | Some(Value::Null) => None,
        Some(Value::Object(s)) => {
            if s.keys()
                .any(|k| !matches!(k.as_str(), "live" | "downloads" | "arr"))
            {
                return Err("unknown_section_key");
            }
            let flag = |k: &str| {
                s.get(k)
                    .and_then(Value::as_bool)
                    .ok_or("invalid_allowedSections")
            };
            Some(Sections {
                live: flag("live")?,
                downloads: flag("downloads")?,
                arr: flag("arr")?,
            })
        }
        Some(_) => return Err("invalid_allowedSections"),
    };
    Ok(Policy {
        max_content_rating: rating,
        allowed_sections: sections,
        kid,
    })
}

// --- /api/settings/anthropic-key --------------------------------------------------

/// A stale-tab guard, not authentication: the signed session stays
/// authoritative, and a required exact binding stops a tab opened before an
/// account switch from writing the secret under the new account.
#[allow(clippy::result_large_err)]
fn expected_sub(headers: &HeaderMap, sub: &str) -> Result<(), Response> {
    let sent = headers.get(EXPECTED_SUB_HEADER).map(|v| v.as_bytes());
    if sent == Some(sub.as_bytes()) {
        Ok(())
    } else {
        Err(err(StatusCode::CONFLICT, "principal_changed"))
    }
}

async fn key_get(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
) -> Result<Response, auth::Error> {
    let info = stores::api_key_info(
        &st.auth.pool,
        &st.config.auth.session_secret,
        &p.session.sub,
    )
    .await?;
    Ok(Json(info).into_response())
}

async fn key_put(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, Response> {
    let sub = &p.session.sub;
    expected_sub(&headers, sub)?;
    let body = auth::json_body(body, SMALL_BODY_LIMIT).await?;
    let key = auth::js_trim(body.get("key").and_then(Value::as_str).unwrap_or_default());
    if !stores::plausible_anthropic_key(key) {
        // Never echo the submitted value, even an invalid one.
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_key", "hint": "expected an sk-ant-\u{2026} Anthropic API key" })),
        )
            .into_response());
    }
    let (pool, secret) = (&st.auth.pool, &st.config.auth.session_secret);
    let info = async {
        stores::set_api_key(pool, secret, sub, key).await?;
        stores::api_key_info(pool, secret, sub).await
    }
    .await
    .map_err(|e| auth::Error::from(e).into_response())?;
    Ok(Json(info).into_response())
}

async fn key_delete(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    headers: HeaderMap,
) -> Result<Response, Response> {
    expected_sub(&headers, &p.session.sub)?;
    stores::delete_api_key(&st.auth.pool, &p.session.sub)
        .await
        .map_err(|e| auth::Error::from(e).into_response())?;
    Ok(Json(json!({ "set": false })).into_response())
}

#[cfg(test)]
mod tests;
