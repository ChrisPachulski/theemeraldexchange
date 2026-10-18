//! HTTP surface: `/api/iptv/*` (paths and JSON shapes byte-identical to the
//! Hono routes the Swift and web clients decode) and `/internal/*` (the
//! iptv.db reads and writes Hono used to do directly).
//!
//! Hono stays the gateway: it keeps requireAuth, the live-section, rating and
//! membership checks, then forwards here with a 60 s internal-principal JWE.
//! This service trusts the principal for the acting sub and role only.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use emerald_contracts::internal_principal::{self, InternalClaims};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::catalog::{self, GridOpts, ListOpts};
use crate::config::{Config, PrincipalMode};
use crate::playlist;
use crate::xtream::{iso, parse_js_number};
use media_core::rate_limit::RateLimiter;

const KINDS: [&str; 3] = ["live", "vod", "series"];
const HIST_KINDS: [&str; 3] = ["live", "vod", "series_episode"];
const PLAYLIST_TOKEN_MAX_BODY_BYTES: usize = 1024;
const GZIP_MIN_CHARS: usize = 64 * 1024;
const JSON_UTF8: &str = "application/json; charset=utf-8";
/// Fire-and-forget recommender posts are bounded so a hung sidecar cannot
/// pile up sockets.
const MIRROR_TIMEOUT: Duration = Duration::from_secs(3);
/// A title becomes a `watched` signal at 40% played (or completed).
const WATCH_QUALIFY_FRACTION: f64 = 0.4;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    http: reqwest::Client,
    search_limit: Arc<RateLimiter>,
    /// Concurrency slots, raw live leases, dead-feed memory, the panel probe.
    pub streams: Arc<crate::streams::Streams>,
    /// The DVR recorder; Some only with DVR_ENABLED (and IPTV on), which is
    /// also what mounts /api/dvr.
    pub dvr: Option<crate::dvr::FfmpegRecorder>,
    pub(crate) dvr_limit: Arc<RateLimiter>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Arc<Config>) -> Self {
        let streams = Arc::new(crate::streams::Streams::new(&config));
        let dvr = (config.dvr_enabled && !config.iptv_disabled).then(|| {
            crate::dvr::FfmpegRecorder::new(
                pool.clone(),
                &config,
                streams.tracker.clone(),
                streams.live.remux.clone(),
            )
        });
        AppState {
            http: reqwest::Client::builder()
                .timeout(MIRROR_TIMEOUT)
                .build()
                .expect("reqwest client builds"),
            // A read, not an indexer budget: a literal 10 req/s per caller.
            search_limit: Arc::new(RateLimiter::new(10, 10, Duration::from_secs(1))),
            dvr_limit: Arc::new(RateLimiter::new(
                config.arr_mutate_rate_capacity as u32,
                config.arr_mutate_rate_refill as u32,
                Duration::from_millis(config.arr_mutate_rate_interval_ms),
            )),
            streams,
            dvr,
            pool,
            config,
        }
    }
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/iptv/categories", get(categories))
        .route("/api/iptv/live", get(list_live))
        .route("/api/iptv/vod", get(list_vod))
        .route("/api/iptv/vod/{id}", get(vod_detail))
        .route("/api/iptv/series", get(list_series))
        .route("/api/iptv/series/{id}", get(series_detail))
        .route("/api/iptv/epg/now", get(epg_now))
        .route("/api/iptv/epg/channel/{id}", get(epg_channel))
        .route("/api/iptv/epg/grid", get(epg_grid))
        .route("/api/iptv/epg/search", get(epg_search))
        .route("/api/iptv/favorites", get(favorites).post(add_favorite))
        .route(
            "/api/iptv/favorites/{kind}/{item_id}",
            delete(remove_favorite),
        )
        .route("/api/iptv/history", get(history).post(put_history))
        .route("/api/iptv/playlist/token", post(mint_playlist_token))
        .route("/api/iptv/playlist/tokens", get(list_playlist_tokens))
        .route(
            "/api/iptv/playlist/tokens/{jti}",
            delete(revoke_playlist_token),
        )
        .route("/api/iptv/playlist.m3u", get(playlist_m3u))
        .route(
            "/internal/members/{sub}/revoke-playlist-tokens",
            post(internal_revoke_tokens),
        )
        .route("/internal/members/{sub}", delete(internal_erase_member))
        .route("/internal/availability", post(internal_availability))
        .merge(crate::streams::routes())
        .merge(if state.dvr.is_some() {
            crate::dvr::routes()
        } else {
            Router::new()
        })
        .layer(middleware::from_fn_with_state(
            state.clone(),
            principal_layer,
        ));
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(api)
        .with_state(state)
}

// ---- responses ---------------------------------------------------------------

pub(crate) type ApiResult = Result<Response, ApiError>;
pub(crate) type Claims = Option<Extension<InternalClaims>>;

/// An error status and its JSON body (`{"error": ...}` unless noted).
pub(crate) struct ApiError(StatusCode, Value);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

pub(crate) fn error(status: StatusCode, code: &str) -> ApiError {
    ApiError(status, json!({ "error": code }))
}

pub(crate) fn bad(code: &str) -> ApiError {
    error(StatusCode::BAD_REQUEST, code)
}

pub(crate) fn db(e: sqlx::Error) -> ApiError {
    tracing::error!("iptv db error: {e}");
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
}

pub(crate) fn json_ok<T: Serialize>(v: &T) -> Response {
    Json(v).into_response()
}

/// The guide payloads: gzip when the client accepts it and the body is over
/// 64 KB (JS string length), compressed off the async threads. Never applied
/// globally, so byte-stream routes are never wrapped.
async fn json_maybe_gzip<T: Serialize>(headers: &HeaderMap, v: &T) -> Response {
    let text = serde_json::to_string(v).expect("response serializes");
    let accepts = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.to_lowercase().contains("gzip"));
    let big = text.len() > GZIP_MIN_CHARS
        && text.chars().map(char::len_utf16).sum::<usize>() > GZIP_MIN_CHARS;
    if !(accepts && big) {
        return ([(header::CONTENT_TYPE, JSON_UTF8)], text).into_response();
    }
    let gz = tokio::task::spawn_blocking(move || {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut e, text.as_bytes())?;
        e.finish()
    })
    .await;
    match gz {
        Ok(Ok(body)) => (
            [
                (header::CONTENT_TYPE, JSON_UTF8),
                (header::CONTENT_ENCODING, "gzip"),
                (header::VARY, "Accept-Encoding"),
            ],
            body,
        )
            .into_response(),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error").into_response(),
    }
}

// ---- principal -----------------------------------------------------------------

/// Verified claims go into the extensions. A missing or bad principal is a
/// 401 in enforce, a warning in log, and ignored in off (local dev).
async fn principal_layer(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let mode = &state.config.principal_mode;
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let verified = match (token, state.config.internal_principal_secret.as_deref()) {
        (Some(t), Some(secret)) => {
            media_core::auth::verify_principal(secret, t, Utc::now().timestamp())
        }
        _ => Err("internal-principal missing or secret unset".into()),
    };
    match verified {
        Ok(claims) => {
            req.extensions_mut().insert(claims);
        }
        Err(e) => match mode {
            PrincipalMode::Enforce => {
                tracing::warn!("internal-principal rejected: {e}");
                return error(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
            }
            PrincipalMode::Log => {
                tracing::warn!("internal-principal verify failed (log mode): {e}")
            }
            PrincipalMode::Off => {}
        },
    }
    next.run(req).await
}

/// The acting member. Per-user routes need a principal in every posture.
pub(crate) fn sub_of(claims: &Claims) -> Result<String, ApiError> {
    claims
        .as_ref()
        .map(|c| c.sub.clone())
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))
}

/// Hono's requireAdmin, for the internal endpoints. Off (no auth boundary,
/// local dev) allows, as in media-core.
pub(crate) fn require_admin(state: &AppState, claims: &Claims) -> Result<(), ApiError> {
    if state.config.principal_mode == PrincipalMode::Off
        || claims.as_ref().is_some_and(|c| c.role == "admin")
    {
        return Ok(());
    }
    Err(ApiError(
        StatusCode::FORBIDDEN,
        json!({ "error": "forbidden", "reason": "admin_only" }),
    ))
}

// ---- JS coercions (the TS routes parse with Number()/new Date()) ----------------

pub(crate) type Params = Query<Vec<(String, String)>>;

/// First value of a query key, like Hono's `c.req.query(key)`.
pub(crate) fn param<'a>(q: &'a [(String, String)], key: &str) -> Option<&'a str> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// `Number.isInteger(Number(s))` as an i64.
fn js_int(s: &str) -> Option<i64> {
    let n = parse_js_number(s);
    (n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

/// `intOrUndef`: blank is unset, a finite number truncates.
fn int_or_undef(s: Option<&str>) -> Option<i64> {
    let s = s.filter(|s| !s.is_empty())?;
    let n = parse_js_number(s);
    n.is_finite().then_some(n.trunc() as i64)
}

/// JS `Number(v)` for a JSON body value.
pub(crate) fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => parse_js_number(s),
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `s.slice(0, n)` in UTF-16 code units (a split surrogate pair is dropped).
fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// `new Date(s)` for the forms clients send: RFC 3339 (any offset), a zoneless
/// date-time (taken as UTC, the container's zone) or a bare date.
pub(crate) fn js_date(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, f) {
            return Some(d.and_utc());
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc())
}

/// `from`/`to` (default now .. now + hours), normalized to toISOString, or
/// None for an unparseable or empty window.
fn epg_window(q: &[(String, String)], hours: i64) -> Option<(String, String)> {
    let now = Utc::now();
    let from = param(q, "from").map_or(Some(now), js_date)?;
    let to = param(q, "to").map_or(Some(now + chrono::TimeDelta::hours(hours)), js_date)?;
    (to > from).then(|| (iso(from), iso(to)))
}

/// `categoryIds` CSV: positive integers only, at most 500.
fn category_ids(q: &[(String, String)]) -> Vec<i64> {
    param(q, "categoryIds")
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.split(',')
                .filter_map(|p| js_int(p.trim()).filter(|n| *n > 0))
                .take(500)
                .collect()
        })
        .unwrap_or_default()
}

/// Trimmed, capped at 100 chars; blank is None.
fn search_term(q: &[(String, String)]) -> Option<&str> {
    param(q, "q")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| js_slice(s, 100))
}

/// An optional positive-integer `limit`; Err is the 400.
fn positive_limit(q: &[(String, String)]) -> Result<Option<i64>, ApiError> {
    match param(q, "limit").filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => js_int(s)
            .filter(|n| *n > 0)
            .map(Some)
            .ok_or_else(|| bad("invalid_limit")),
    }
}

// ---- catalog + guide -----------------------------------------------------------

async fn categories(State(s): State<AppState>, Query(q): Params) -> ApiResult {
    let kind = param(&q, "kind").unwrap_or("");
    if !KINDS.contains(&kind) {
        return Err(bad("invalid_kind"));
    }
    Ok(json_ok(
        &catalog::categories(&s.pool, kind).await.map_err(db)?,
    ))
}

fn list_opts(q: &[(String, String)]) -> ListOpts {
    ListOpts {
        category_id: int_or_undef(param(q, "categoryId")),
        q: param(q, "q").map(String::from),
        limit: int_or_undef(param(q, "limit")),
        offset: int_or_undef(param(q, "offset")),
    }
}

async fn list_live(State(s): State<AppState>, Query(q): Params) -> ApiResult {
    Ok(json_ok(
        &catalog::list_live(&s.pool, &list_opts(&q))
            .await
            .map_err(db)?,
    ))
}

async fn list_vod(State(s): State<AppState>, Query(q): Params) -> ApiResult {
    Ok(json_ok(
        &catalog::list_vod(&s.pool, &list_opts(&q))
            .await
            .map_err(db)?,
    ))
}

async fn list_series(State(s): State<AppState>, Query(q): Params) -> ApiResult {
    Ok(json_ok(
        &catalog::list_series(&s.pool, &list_opts(&q))
            .await
            .map_err(db)?,
    ))
}

/// A detail id: `Number.isFinite` or 400; a non-integer can match no row.
fn detail_id(raw: &str) -> Result<Option<i64>, ApiError> {
    let n = parse_js_number(raw);
    if !n.is_finite() {
        return Err(bad("invalid_id"));
    }
    Ok((n.fract() == 0.0).then_some(n as i64))
}

fn found<T: Serialize>(v: Option<T>) -> ApiResult {
    v.map(|v| json_ok(&v))
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "not_found"))
}

async fn vod_detail(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let Some(id) = detail_id(&id)? else {
        return found(None::<()>);
    };
    found(catalog::vod_detail(&s.pool, id).await.map_err(db)?)
}

async fn series_detail(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let Some(id) = detail_id(&id)? else {
        return found(None::<()>);
    };
    found(catalog::series_detail(&s.pool, id).await.map_err(db)?)
}

async fn epg_now(State(s): State<AppState>, Query(q): Params) -> ApiResult {
    let ids: Vec<i64> = param(&q, "channelIds")
        .unwrap_or("")
        .split(',')
        .filter_map(|p| js_int(p).filter(|n| *n > 0))
        .collect();
    Ok(json_ok(
        &catalog::epg_now(&s.pool, &ids, &iso(Utc::now()))
            .await
            .map_err(db)?,
    ))
}

async fn epg_channel(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Params,
) -> ApiResult {
    let id = js_int(&id)
        .filter(|n| *n > 0)
        .ok_or_else(|| bad("invalid_id"))?;
    let (from, to) = epg_window(&q, 24).ok_or_else(|| bad("invalid_window"))?;
    Ok(json_ok(
        &catalog::epg_channel_window(&s.pool, id, &from, &to)
            .await
            .map_err(db)?,
    ))
}

async fn epg_grid(State(s): State<AppState>, headers: HeaderMap, Query(q): Params) -> ApiResult {
    let (from, to) = epg_window(&q, 4).ok_or_else(|| bad("invalid_window"))?;
    let category_id = match param(&q, "categoryId").filter(|v| !v.is_empty()) {
        None => None,
        Some(v) => Some(
            js_int(v)
                .filter(|n| *n > 0)
                .ok_or_else(|| bad("invalid_category"))?,
        ),
    };
    let category_ids = category_ids(&q);
    let term = search_term(&q);
    let has_epg_only = matches!(param(&q, "hasEpg"), Some("1" | "true"));
    // Native clients bound the payload with `limit`; the web grid omits it.
    let limit = positive_limit(&q)?;
    let opts = GridOpts {
        category_id,
        category_ids,
        q: term.map(String::from),
        has_epg_only,
        limit,
    };
    let rows = catalog::epg_grid(&s.pool, &from, &to, &opts)
        .await
        .map_err(db)?;
    if !opts.category_ids.is_empty() && term.is_none() {
        // Bookkeeping for the idle feed checks; never fails the guide.
        if let Err(e) = catalog::remember_guide_scope(
            &s.pool,
            &opts.category_ids,
            limit,
            has_epg_only,
            &iso(Utc::now()),
        )
        .await
        {
            tracing::warn!("could not record the guide scope: {e}");
        }
    }
    Ok(json_maybe_gzip(&headers, &rows).await)
}

async fn epg_search(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Query(q): Params,
) -> ApiResult {
    if let Err(r) = s.search_limit.check(&limit_key(&claims)) {
        return Ok(r);
    }
    // One char would match nearly every programme: require two.
    let term = search_term(&q)
        .filter(|t| t.encode_utf16().count() >= 2)
        .ok_or_else(|| bad("invalid_query"))?;
    let (from, to) = epg_window(&q, 4).ok_or_else(|| bad("invalid_window"))?;
    let ids = category_ids(&q);
    let limit = positive_limit(&q)?;
    let result = catalog::epg_search(&s.pool, &from, &to, term, &ids, limit)
        .await
        .map_err(db)?;
    Ok(json_maybe_gzip(&headers, &result).await)
}

// ---- favorites + history ---------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
struct Favorite {
    sub: String,
    kind: String,
    item_id: String,
    added_ts: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct HistoryRow {
    sub: String,
    kind: String,
    item_id: String,
    position_secs: i64,
    duration_secs: Option<i64>,
    watched_at: String,
    completed: i64,
}

/// An unparseable body reads as `{}`, like `c.req.json().catch(() => ({}))`.
fn body_json(body: &Bytes) -> Value {
    serde_json::from_slice(body).unwrap_or_else(|_| json!({}))
}

async fn favorites(State(s): State<AppState>, claims: Claims) -> ApiResult {
    let sub = sub_of(&claims)?;
    let rows: Vec<Favorite> = sqlx::query_as(
        "SELECT sub, kind, item_id, added_ts FROM iptv_favorites WHERE sub = ? ORDER BY added_ts DESC",
    )
    .bind(sub)
    .fetch_all(&s.pool)
    .await
    .map_err(db)?;
    Ok(json_ok(&rows))
}

async fn add_favorite(State(s): State<AppState>, claims: Claims, body: Bytes) -> ApiResult {
    let sub = sub_of(&claims)?;
    let body = body_json(&body);
    let kind = body["kind"]
        .as_str()
        .filter(|k| KINDS.contains(k))
        .ok_or_else(|| bad("invalid_kind"))?;
    let item = body["itemId"]
        .as_str()
        .filter(|i| !i.is_empty())
        .ok_or_else(|| bad("invalid_item"))?;
    sqlx::query(
        "INSERT OR IGNORE INTO iptv_favorites (sub, kind, item_id, added_ts) VALUES (?, ?, ?, ?)",
    )
    .bind(sub)
    .bind(kind)
    .bind(item)
    .bind(iso(Utc::now()))
    .execute(&s.pool)
    .await
    .map_err(db)?;
    Ok(StatusCode::CREATED.into_response())
}

async fn remove_favorite(
    State(s): State<AppState>,
    claims: Claims,
    Path((kind, item)): Path<(String, String)>,
) -> ApiResult {
    let sub = sub_of(&claims)?;
    if !KINDS.contains(&kind.as_str()) {
        return Err(bad("invalid_kind"));
    }
    sqlx::query("DELETE FROM iptv_favorites WHERE sub = ? AND kind = ? AND item_id = ?")
        .bind(sub)
        .bind(kind)
        .bind(item)
        .execute(&s.pool)
        .await
        .map_err(db)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn history(State(s): State<AppState>, claims: Claims, Query(q): Params) -> ApiResult {
    let sub = sub_of(&claims)?;
    let limit = match param(&q, "limit").filter(|v| !v.is_empty()) {
        None => 50,
        Some(v) => {
            let n = parse_js_number(v);
            if n.is_finite() {
                (n.floor() as i64).clamp(1, 100)
            } else {
                50
            }
        }
    };
    let rows: Vec<HistoryRow> = sqlx::query_as(
        "SELECT sub, kind, item_id, position_secs, duration_secs, watched_at, completed \
         FROM iptv_watch_history WHERE sub = ? ORDER BY watched_at DESC LIMIT ?",
    )
    .bind(sub)
    .bind(limit)
    .fetch_all(&s.pool)
    .await
    .map_err(db)?;
    Ok(json_ok(&rows))
}

/// (position_secs, duration_secs, completed)
type WatchPoint = (i64, Option<i64>, i64);

fn watch_qualified((pos, dur, completed): WatchPoint) -> bool {
    completed == 1 || dur.is_some_and(|d| d > 0 && pos as f64 / d as f64 >= WATCH_QUALIFY_FRACTION)
}

/// True only for the report that crosses into "qualified": the signal fires
/// once on the transition, not on every progress tick. No prior row counts as
/// not qualified.
fn crossed_watch_threshold(prior: Option<WatchPoint>, now: WatchPoint) -> bool {
    watch_qualified(now) && !prior.is_some_and(watch_qualified)
}

async fn put_history(State(s): State<AppState>, claims: Claims, body: Bytes) -> ApiResult {
    let sub = sub_of(&claims)?;
    let body = body_json(&body);
    let kind = body["kind"]
        .as_str()
        .filter(|k| HIST_KINDS.contains(k))
        .ok_or_else(|| bad("invalid_kind"))?;
    let item = body["itemId"]
        .as_str()
        .filter(|i| !i.is_empty())
        .ok_or_else(|| bad("invalid_item"))?;
    let pos = js_number(&body["positionSecs"]);
    let pos = if pos.is_finite() {
        pos.floor().max(0.0) as i64
    } else {
        0
    };
    let dur = (!body["durationSecs"].is_null())
        .then(|| js_number(&body["durationSecs"]))
        .filter(|d| d.is_finite())
        .map(|d| d.floor().max(0.0) as i64);
    let completed = i64::from(js_truthy(&body["completed"]));

    // The prior row, read before the upsert, so `watched` fires exactly once.
    let prior: Option<WatchPoint> = sqlx::query_as(
        "SELECT position_secs, duration_secs, completed FROM iptv_watch_history \
         WHERE sub = ? AND kind = ? AND item_id = ?",
    )
    .bind(&sub)
    .bind(kind)
    .bind(item)
    .fetch_optional(&s.pool)
    .await
    .map_err(db)?;
    sqlx::query(
        "INSERT INTO iptv_watch_history (sub, kind, item_id, position_secs, duration_secs, watched_at, completed) \
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sub, kind, item_id) DO UPDATE SET \
         position_secs = excluded.position_secs, duration_secs = excluded.duration_secs, \
         watched_at = excluded.watched_at, completed = excluded.completed",
    )
    .bind(&sub)
    .bind(kind)
    .bind(item)
    .bind(pos)
    .bind(dur)
    .bind(iso(Utc::now()))
    .bind(completed)
    .execute(&s.pool)
    .await
    .map_err(db)?;

    if s.config.use_local_recommender
        && kind != "live"
        && crossed_watch_threshold(prior, (pos, dur, completed))
        && let Some(Extension(claims)) = claims
    {
        tokio::spawn(emit_watched(
            s.clone(),
            claims,
            kind.to_string(),
            item.to_string(),
        ));
    }
    Ok(StatusCode::CREATED.into_response())
}

/// Forward a qualifying watch to the recommender as a `watched` positive:
/// vod -> movie, series_episode -> its series (tv); no TMDB id, no signal.
/// Best-effort: a recommender hiccup never touches the history write.
async fn emit_watched(s: AppState, claims: InternalClaims, kind: String, item: String) {
    let lookup = if kind == "vod" {
        let Some(id) = js_int(&item) else { return };
        sqlx::query_scalar::<_, Option<i64>>("SELECT tmdb_id FROM vod WHERE stream_id = ?")
            .bind(id)
            .fetch_optional(&s.pool)
            .await
    } else {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT s.tmdb_id FROM series_episodes e JOIN series s ON s.series_id = e.series_id \
             WHERE e.episode_id = ?",
        )
        .bind(&item)
        .fetch_optional(&s.pool)
        .await
    };
    let Ok(Some(Some(tmdb_id))) = lookup else {
        return;
    };
    if tmdb_id <= 0 {
        return;
    }
    let rec_kind = if kind == "vod" { "movie" } else { "tv" };
    let url = format!("{}/events/feedback", s.config.recommender_url);
    let mut req = s.http.post(&url).json(
        &json!({ "sub": claims.sub, "kind": rec_kind, "tmdb_id": tmdb_id, "signal": "watched" }),
    );
    if let Some(secret) = &s.config.recommender_event_secret {
        req = req.header("x-recommender-secret", secret);
    }
    if let Some(secret) = &s.config.internal_principal_secret {
        // A fresh 60 s principal for the same caller; the inbound one may be
        // nearly spent.
        let now = Utc::now().timestamp();
        let fresh = InternalClaims {
            iat: now,
            exp: now + internal_principal::DEFAULT_TTL_SECS,
            ..claims
        };
        let jwe = internal_principal::encrypt_with_secret(secret.as_bytes(), &fresh);
        req = req.header(header::AUTHORIZATION, format!("Bearer {jwe}"));
    }
    match req.send().await {
        Ok(r) if r.status().is_success() => {}
        // error!: a dropped training signal is reported, as the TS mirror did.
        Ok(r) => tracing::error!(
            status = r.status().as_u16(),
            "recommender mirror non-ok: watched"
        ),
        Err(e) => tracing::error!("recommender mirror failed: watched: {}", e.without_url()),
    }
}

// ---- playlist tokens ---------------------------------------------------------------

async fn mint_playlist_token(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    body: Body,
) -> ApiResult {
    let sub = sub_of(&claims)?;
    let too_large = || error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large");
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map(parse_js_number);
    if declared.is_some_and(|n| n.is_finite() && n > PLAYLIST_TOKEN_MAX_BODY_BYTES as f64) {
        return Err(too_large());
    }
    let bytes = axum::body::to_bytes(body, PLAYLIST_TOKEN_MAX_BODY_BYTES)
        .await
        .map_err(|_| too_large())?;
    // deviceName is optional, so no body or a bad one is just "no name".
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let device_name = body
        .get("deviceName")
        .and_then(Value::as_str)
        .map(|d| js_slice(d.trim(), 120).to_string());
    let base = playlist::public_base_url(&headers, &s.config.allowed_origins);
    let minted = playlist::mint(
        &s.pool,
        &s.config.stream_token_secret,
        &sub,
        device_name,
        &base,
    )
    .await
    .map_err(db)?;
    Ok(json_ok(&minted))
}

async fn list_playlist_tokens(State(s): State<AppState>, claims: Claims) -> ApiResult {
    let sub = sub_of(&claims)?;
    let tokens = playlist::list(&s.pool, &sub).await.map_err(db)?;
    Ok(json_ok(&json!({ "tokens": tokens })))
}

async fn revoke_playlist_token(
    State(s): State<AppState>,
    claims: Claims,
    Path(jti): Path<String>,
) -> ApiResult {
    let sub = sub_of(&claims)?;
    let is_admin = claims.as_ref().is_some_and(|c| c.role == "admin");
    Ok(
        match playlist::revoke(&s.pool, &jti, &sub, is_admin)
            .await
            .map_err(db)?
        {
            playlist::Revoke::NotFound => return Err(error(StatusCode::NOT_FOUND, "not_found")),
            playlist::Revoke::Forbidden => return Err(error(StatusCode::FORBIDDEN, "forbidden")),
            playlist::Revoke::AlreadyRevoked => {
                return Err(error(StatusCode::CONFLICT, "already_revoked"));
            }
            playlist::Revoke::Revoked => json_ok(&json!({ "ok": true })),
        },
    )
}

/// External players (VLC, TiviMate) fetch this with the token in the URL.
/// Hono verifies membership and the live/rating policy, then forwards with a
/// principal for the token's member; the token and its jti row are checked here.
async fn playlist_m3u(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Query(q): Params,
) -> ApiResult {
    let token = param(&q, "t").unwrap_or("");
    let sub = match playlist::authorize(&s.pool, &s.config.stream_token_secret, token)
        .await
        .map_err(db)?
    {
        Ok(sub) => sub,
        Err(r) => {
            let body = match r.detail {
                Some(d) => json!({ "error": r.error, "detail": d }),
                None => json!({ "error": r.error }),
            };
            return Err(ApiError(StatusCode::UNAUTHORIZED, body));
        }
    };
    if claims.as_ref().is_some_and(|c| c.sub != sub) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "invalid_token", "detail": "sub_mismatch" }),
        ));
    }
    let base = playlist::public_base_url(&headers, &s.config.allowed_origins);
    let m3u = playlist::build_m3u(&s.pool, &s.config.stream_token_secret, &sub, &base)
        .await
        .map_err(db)?;
    Ok((
        [
            (header::CONTENT_TYPE, "audio/x-mpegurl"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"theemeraldexchange.m3u\"",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        m3u,
    )
        .into_response())
}

// ---- internal (Hono's former direct iptv.db access) -----------------------------

/// adminInvites: a revoked member's playlist tokens die with the membership.
async fn internal_revoke_tokens(
    State(s): State<AppState>,
    claims: Claims,
    Path(sub): Path<String>,
) -> ApiResult {
    require_admin(&s, &claims)?;
    let revoked = playlist::revoke_all(&s.pool, &sub).await.map_err(db)?;
    Ok(json_ok(&json!({ "ok": true, "revoked": revoked })))
}

/// memberErasure: revoke the member's playlist tokens and delete their
/// favorites and watch history, in one transaction.
async fn internal_erase_member(
    State(s): State<AppState>,
    claims: Claims,
    Path(sub): Path<String>,
) -> ApiResult {
    require_admin(&s, &claims)?;
    let mut tx = s.pool.begin().await.map_err(db)?;
    playlist::revoke_all(&mut *tx, &sub).await.map_err(db)?;
    for sql in [
        "DELETE FROM iptv_favorites WHERE sub = ?",
        "DELETE FROM iptv_watch_history WHERE sub = ?",
    ] {
        sqlx::query(sql)
            .bind(&sub)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(json_ok(&json!({ "ok": true })))
}

/// tagIptvAvailability: which of these TMDB ids a live catalog title links to.
async fn internal_availability(
    State(s): State<AppState>,
    claims: Claims,
    body: Bytes,
) -> ApiResult {
    require_admin(&s, &claims)?;
    let ids: Vec<i64> = match serde_json::from_slice::<Value>(&body) {
        Ok(v) => match v["tmdb_ids"].as_array() {
            Some(a) => a.iter().filter_map(Value::as_i64).collect(),
            None => return Err(bad("invalid_body")),
        },
        Err(_) => return Err(bad("invalid_body")),
    };
    let linked: Vec<i64> = sqlx::query_scalar(
        "SELECT DISTINCT tmdb_id FROM iptv_title_link \
         WHERE tmdb_id IN (SELECT value FROM json_each(?)) AND removed_at IS NULL ORDER BY tmdb_id",
    )
    .bind(serde_json::to_string(&ids).unwrap_or_default())
    .fetch_all(&s.pool)
    .await
    .map_err(db)?;
    Ok(json_ok(&json!({ "tmdb_ids": linked })))
}

// ---- rate limit --------------------------------------------------------------------

/// The bucket key for the Hono rateLimit middleware: the principal's sub,
/// `anon` without one.
pub(crate) fn limit_key(claims: &Claims) -> String {
    claims
        .as_ref()
        .map_or_else(|| "anon".to_string(), |c| format!("sub:{}", c.sub))
}

#[cfg(test)]
mod tests;
