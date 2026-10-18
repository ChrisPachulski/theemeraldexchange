//! /api/tmdb (routes/tmdb.ts): the TMDB proxy that keeps the key server-side
//! (credits, person and filmography, trending, videos, related), the trailer
//! grant and the muxed-trailer stream; and [`crate::ratings`]'s route.
//!
//! Every route needs a session except `/trailer/<id>/stream.mp4?t=...`, which
//! authenticates by a `vod` media token bound to that video id so AVPlayer
//! can fetch it cookielessly; its member must still be allowed.

use std::cmp::Ordering;

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use indexmap::IndexMap;
use serde_json::{Value, json};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::AppState;
use crate::app::js_number;
use crate::arr::shared::{query_first, query_pairs};
use crate::routes::{err, js_str_number, safe_positive, truthy};
use crate::trailer::{muxed_path, valid_youtube_id};
use crate::upstream::{Reply, WAN_TIMEOUT};
use crate::{media_token, ratings};

/// A prolific actor has 200+ credits; the most popular survive the cut.
const PERSON_CAST_CAP: usize = 40;
const RELATED_CAP: usize = 20;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tmdb/credits", get(credits))
        .route("/api/tmdb/person/{person_id}", get(person))
        .route("/api/tmdb/person/{person_id}/credits", get(person_credits))
        .route("/api/tmdb/trending/{kind}", get(trending))
        .route("/api/tmdb/videos", get(videos))
        .route("/api/tmdb/related", get(related))
        .route("/api/tmdb/trailer", get(trailer))
        .route("/api/tmdb/trailer/{key}/stream.mp4", get(trailer_stream))
        .route("/api/ratings", get(ratings::get))
}

// --- helpers ---------------------------------------------------------------------------

/// A positive safe integer (`Number(raw)`), validated before any upstream
/// call so garbage cannot turn into TMDB requests on the shared budget.
fn positive_id(raw: Option<&str>) -> Option<u64> {
    safe_positive(js_str_number(raw?))
}

fn internal() -> Response {
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

fn not_configured() -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "tmdb_not_configured")
}

/// `{error, status}` with the upstream's status.
fn failed(code: &str, reply: &Reply) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": code, "status": reply.status.as_u16() })),
    )
        .into_response()
}

/// A JS value interpolated into a path.
pub(crate) fn js_string(v: &Value) -> String {
    match v {
        Value::Number(n) => n
            .as_f64()
            .map_or_else(|| n.to_string(), |f| js_number(f).to_string()),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn parse(reply: &Reply) -> Option<Value> {
    serde_json::from_slice(&reply.body).ok()
}

/// The parsed body forwarded as TMDB wrote it (Hono re-serialized the same
/// value).
fn forward(reply: &Reply) -> Response {
    if parse(reply).is_none() {
        return internal();
    }
    (
        [(header::CONTENT_TYPE, "application/json")],
        reply.body.clone(),
    )
        .into_response()
}

/// `x ?? null`.
fn or_null(v: &Value, k: &str) -> Value {
    v.get(k).cloned().unwrap_or(Value::Null)
}

/// `x ?? []` for a list field: None when it is something else (the TS threw).
fn list<'a>(v: &'a Value, k: &str) -> Option<&'a [Value]> {
    match v.get(k) {
        None | Some(Value::Null) => Some(&[]),
        Some(Value::Array(a)) => Some(a),
        Some(_) => None,
    }
}

async fn tmdb_fetch(st: &AppState, path: &str, params: &[(&str, &str)]) -> Reply {
    let c = &st.config;
    let req = match reqwest::Url::parse(&format!("{}{path}", c.ext.tmdb_base)) {
        Ok(mut url) => {
            {
                let mut q = url.query_pairs_mut();
                for (k, v) in params {
                    q.append_pair(k, v);
                }
                if c.tmdb_read_access_token.is_none()
                    && let Some(key) = &c.tmdb_api_key
                {
                    q.append_pair("api_key", key);
                }
            }
            let mut req = st
                .upstream
                .client()
                .get(url)
                .header(header::ACCEPT, "application/json");
            if let Some(token) = &c.tmdb_read_access_token {
                req = req.bearer_auth(token);
            }
            req
        }
        // An unusable base: the client's own error becomes the synthesized 504.
        Err(_) => st.upstream.client().get("http://invalid.invalid/"),
    };
    st.upstream
        .fetch(req, WAN_TIMEOUT, &format!("tmdb{path}"))
        .await
}

// --- credits ---------------------------------------------------------------------------

async fn credits(State(st): State<AppState>, _auth: auth::RequireAuth, uri: Uri) -> Response {
    if !st.config.tmdb_configured() {
        return not_configured();
    }
    let q = query_pairs(&uri);
    match query_first(&q, "type") {
        Some("tv") => {
            let Some(tvdb_id) = positive_id(query_first(&q, "tvdbId")) else {
                return err(StatusCode::BAD_REQUEST, "invalid_tvdbId");
            };
            let find = tmdb_fetch(
                &st,
                &format!("/find/{tvdb_id}"),
                &[("external_source", "tvdb_id")],
            )
            .await;
            if !find.is_success() {
                return failed("tmdb_find_failed", &find);
            }
            let Some(data) = parse(&find) else {
                return internal();
            };
            let id = data.pointer("/tv_results/0/id").filter(|v| truthy(v));
            let Some(id) = id else {
                return Json(json!({ "cast": [], "crew": [] })).into_response();
            };
            let reply = tmdb_fetch(
                &st,
                &format!("/tv/{}/aggregate_credits", js_string(id)),
                &[],
            )
            .await;
            if !reply.is_success() {
                return failed("tmdb_credits_failed", &reply);
            }
            forward(&reply)
        }
        Some("movie") => {
            let Some(tmdb_id) = positive_id(query_first(&q, "tmdbId")) else {
                return err(StatusCode::BAD_REQUEST, "invalid_tmdbId");
            };
            let reply = tmdb_fetch(&st, &format!("/movie/{tmdb_id}/credits"), &[]).await;
            if !reply.is_success() {
                return failed("tmdb_credits_failed", &reply);
            }
            forward(&reply)
        }
        _ => err(StatusCode::BAD_REQUEST, "invalid_query"),
    }
}

// --- person ----------------------------------------------------------------------------

/// `(x ?? 0)` as the subtraction coerces it.
fn sort_key(r: &Value, k: &str) -> f64 {
    match r.get(k) {
        None | Some(Value::Null) => 0.0,
        v => crate::routes::js_number(v),
    }
}

/// Movie and TV roles with a title or name, popularity then rating first,
/// capped, projected onto the fields the apps render.
fn project_person_cast(cast: &[Value]) -> Vec<IndexMap<&'static str, Value>> {
    let mut rows: Vec<&Value> = cast
        .iter()
        .filter(|r| {
            matches!(
                r.get("media_type").and_then(Value::as_str),
                Some("movie" | "tv")
            ) && (r.get("title").is_some_and(truthy) || r.get("name").is_some_and(truthy))
        })
        .collect();
    rows.sort_by(|a, b| {
        let pop = sort_key(b, "popularity") - sort_key(a, "popularity");
        let d = if pop != 0.0 && !pop.is_nan() {
            pop
        } else {
            sort_key(b, "vote_average") - sort_key(a, "vote_average")
        };
        d.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
    });
    rows.into_iter()
        .take(PERSON_CAST_CAP)
        .map(|r| {
            let mut m = IndexMap::new();
            // An absent id stays absent, as JSON.stringify dropped undefined.
            if let Some(id) = r.get("id") {
                m.insert("id", id.clone());
            }
            m.insert("media_type", or_null(r, "media_type"));
            for k in [
                "title",
                "name",
                "poster_path",
                "release_date",
                "first_air_date",
                "character",
                "vote_average",
            ] {
                m.insert(k, or_null(r, k));
            }
            m
        })
        .collect()
}

/// The projected combined_credits, or the response to send instead.
async fn person_cast(
    st: &AppState,
    person_id: u64,
) -> Result<Vec<IndexMap<&'static str, Value>>, Response> {
    let reply = tmdb_fetch(st, &format!("/person/{person_id}/combined_credits"), &[]).await;
    if !reply.is_success() {
        return Err(err(StatusCode::BAD_GATEWAY, "tmdb_credits_failed"));
    }
    let data = parse(&reply).ok_or_else(internal)?;
    let cast = list(&data, "cast").ok_or_else(internal)?;
    Ok(project_person_cast(cast))
}

async fn person(
    State(st): State<AppState>,
    _auth: auth::RequireAuth,
    Path(person_id): Path<String>,
) -> Response {
    if !st.config.tmdb_configured() {
        return not_configured();
    }
    let Some(person_id) = positive_id(Some(&person_id)) else {
        return err(StatusCode::BAD_REQUEST, "invalid_personId");
    };
    let reply = tmdb_fetch(&st, &format!("/person/{person_id}"), &[]).await;
    if !reply.is_success() {
        return failed("tmdb_person_failed", &reply);
    }
    let Some(p) = parse(&reply) else {
        return internal();
    };
    let cast = match person_cast(&st, person_id).await {
        Ok(cast) => cast,
        Err(res) => return res,
    };
    let mut body: IndexMap<&str, Value> = IndexMap::new();
    for k in ["id", "name"] {
        if let Some(v) = p.get(k) {
            body.insert(k, v.clone());
        }
    }
    for k in ["profile_path", "biography", "known_for_department"] {
        body.insert(k, or_null(&p, k));
    }
    body.insert("cast", serde_json::to_value(cast).expect("serializes"));
    Json(body).into_response()
}

/// The filmography without the bio fetch.
async fn person_credits(
    State(st): State<AppState>,
    _auth: auth::RequireAuth,
    Path(person_id): Path<String>,
) -> Response {
    if !st.config.tmdb_configured() {
        return not_configured();
    }
    let Some(person_id) = positive_id(Some(&person_id)) else {
        return err(StatusCode::BAD_REQUEST, "invalid_personId");
    };
    match person_cast(&st, person_id).await {
        Ok(cast) => Json(json!({ "cast": cast })).into_response(),
        Err(res) => res,
    }
}

// --- trending, videos, related ---------------------------------------------------------

/// TMDB's week window (day trending whipsaws on news cycles).
async fn trending(
    State(st): State<AppState>,
    _auth: auth::RequireAuth,
    Path(kind): Path<String>,
) -> Response {
    if !st.config.tmdb_configured() {
        return not_configured();
    }
    if kind != "movie" && kind != "tv" {
        return err(StatusCode::BAD_REQUEST, "invalid_type");
    }
    let reply = tmdb_fetch(&st, &format!("/trending/{kind}/week"), &[]).await;
    if !reply.is_success() {
        return failed("tmdb_trending_failed", &reply);
    }
    forward(&reply)
}

/// (type, tmdbId | tvdbId) to TMDB's id and path segment; a TV show is
/// looked up by its TVDB id.
async fn resolve_tmdb(
    st: &AppState,
    q: &[(String, String)],
) -> Result<(String, &'static str), Response> {
    let movie_id = positive_id(query_first(q, "tmdbId"));
    let tvdb_id = positive_id(query_first(q, "tvdbId"));
    match query_first(q, "type") {
        Some("movie") => movie_id
            .map(|id| (id.to_string(), "movie"))
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_tmdbId")),
        Some("tv") => {
            let Some(tvdb_id) = tvdb_id else {
                return Err(err(StatusCode::BAD_REQUEST, "invalid_tvdbId"));
            };
            let find_failed = || err(StatusCode::BAD_GATEWAY, "tmdb_find_failed");
            let find = tmdb_fetch(
                st,
                &format!("/find/{tvdb_id}"),
                &[("external_source", "tvdb_id")],
            )
            .await;
            if !find.is_success() {
                return Err(find_failed());
            }
            let data = parse(&find).ok_or_else(internal)?;
            match data.pointer("/tv_results/0/id") {
                None | Some(Value::Null) => Err(find_failed()),
                Some(id) => Ok((js_string(id), "tv")),
            }
        }
        _ => Err(err(StatusCode::BAD_REQUEST, "invalid_query")),
    }
}

/// The YouTube trailers and extras, official trailers first; playback goes
/// through /trailer (tvOS cannot embed YouTube).
async fn videos(State(st): State<AppState>, _auth: auth::RequireAuth, uri: Uri) -> Response {
    if !st.config.tmdb_configured() {
        return not_configured();
    }
    let (id, path) = match resolve_tmdb(&st, &query_pairs(&uri)).await {
        Ok(r) => r,
        Err(res) => return res,
    };
    let reply = tmdb_fetch(&st, &format!("/{path}/{id}/videos"), &[]).await;
    if !reply.is_success() {
        return failed("tmdb_videos_failed", &reply);
    }
    let Some(results) = parse(&reply).and_then(|d| list(&d, "results").map(<[Value]>::to_vec))
    else {
        return internal();
    };
    let rank = |v: &IndexMap<&str, Value>| match v.get("type").and_then(Value::as_str) {
        Some("Trailer") if v.get("official").is_some_and(truthy) => 0,
        Some("Trailer") => 1,
        Some("Teaser") => 2,
        _ => 3,
    };
    let mut out: Vec<IndexMap<&str, Value>> = results
        .iter()
        .filter(|v| {
            v.get("site").and_then(Value::as_str) == Some("YouTube")
                && v.get("key")
                    .and_then(Value::as_str)
                    .is_some_and(valid_youtube_id)
        })
        .map(|v| {
            let mut m = IndexMap::new();
            for k in ["key", "name", "type"] {
                if let Some(x) = v.get(k) {
                    m.insert(k, x.clone());
                }
            }
            let official = match v.get("official") {
                None | Some(Value::Null) => Value::Bool(false),
                Some(x) => x.clone(),
            };
            m.insert("official", official);
            m
        })
        .collect();
    out.sort_by_key(rank);
    Json(json!({ "videos": out })).into_response()
}

/// "More like this": TMDB's recommendations, else /similar.
async fn related(State(st): State<AppState>, _auth: auth::RequireAuth, uri: Uri) -> Response {
    if !st.config.tmdb_configured() {
        return not_configured();
    }
    let (id, path) = match resolve_tmdb(&st, &query_pairs(&uri)).await {
        Ok(r) => r,
        Err(res) => return res,
    };
    let fetch_list = async |kind: &str| -> Result<Vec<Value>, Response> {
        let reply = tmdb_fetch(&st, &format!("/{path}/{id}/{kind}"), &[]).await;
        if !reply.is_success() {
            return Ok(vec![]);
        }
        let data = parse(&reply).ok_or_else(internal)?;
        Ok(list(&data, "results").ok_or_else(internal)?.to_vec())
    };
    let mut rows = match fetch_list("recommendations").await {
        Ok(rows) => rows,
        Err(res) => return res,
    };
    if rows.is_empty() {
        rows = match fetch_list("similar").await {
            Ok(rows) => rows,
            Err(res) => return res,
        };
    }
    let first_set = |r: &Value, keys: [&str; 2]| {
        keys.iter()
            .find_map(|k| r.get(*k).filter(|v| !v.is_null()).cloned())
    };
    let items: Vec<IndexMap<&str, Value>> = rows
        .iter()
        .filter(|r| r.get("poster_path").is_some_and(truthy))
        .take(RELATED_CAP)
        .map(|r| {
            let date = first_set(r, ["release_date", "first_air_date"]);
            let year: String = date
                .as_ref()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(4)
                .collect();
            let year = js_str_number(&year);
            let mut m = IndexMap::new();
            m.insert("tmdbId", or_null(r, "id"));
            m.insert(
                "title",
                first_set(r, ["title", "name"]).unwrap_or_else(|| Value::String(String::new())),
            );
            m.insert(
                "year",
                if year == 0.0 || year.is_nan() {
                    Value::Null
                } else {
                    Value::Number(js_number(year))
                },
            );
            m.insert("posterPath", or_null(r, "poster_path"));
            m
        })
        .collect();
    Json(json!({ "items": items })).into_response()
}

// --- trailers --------------------------------------------------------------------------

fn url(u: &str) -> Response {
    Json(json!({ "url": u })).into_response()
}

/// A directly playable URL for a YouTube id, first that works: the
/// resolver's HLS manifest; its adaptive pair muxed here and handed out as a
/// tokenised /stream.mp4 (full resolution, so ahead of progressive); its
/// progressive mp4 (360p); yt-dlp; else 502 so the app says "Trailer
/// unavailable" rather than opening a dead player.
async fn trailer(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let q = query_pairs(&uri);
    let key = query_first(&q, "key").unwrap_or_default();
    if !valid_youtube_id(key) {
        return err(StatusCode::BAD_REQUEST, "invalid_key");
    }
    let ext = &st.config.ext;
    if let Ok(r) = st.trailers.resolve(ext, key).await {
        if let Some(hls) = r.hls.as_deref().filter(|s| !s.is_empty()) {
            return url(hls);
        }
        if r.video.is_some()
            && r.audio.is_some()
            && st
                .trailers
                .ensure_muxed(st.upstream.client(), ext, key, &r)
                .await
                .is_ok()
        {
            let token = media_token::sign(
                &st.config.auth.stream_token_secret,
                &p.session.sub,
                &media_token::resource_id("trailer", key),
                media_token::DIRECT,
                st.config.media_stream_token_ttl_secs,
            );
            let base = public_base_url(&headers, &st.config.auth.allowed_origins);
            return url(&format!(
                "{base}/api/tmdb/trailer/{key}/stream.mp4?t={token}"
            ));
        }
        if let Some(progressive) = r.progressive.as_deref().filter(|s| !s.is_empty()) {
            return url(progressive);
        }
    }
    match st.trailers.ytdlp(ext, key).await {
        Some(u) => url(&u),
        None => err(StatusCode::BAD_GATEWAY, "trailer_unavailable"),
    }
}

/// A muxed trailer, by the `?t=` token for this id (cookieless, for
/// AVPlayer) or a session. Ranges, HEAD and conditional requests are
/// tower-http's ServeFile; the file is faststart, so playback starts early.
async fn trailer_stream(
    State(st): State<AppState>,
    Path(key): Path<String>,
    req: Request,
) -> Response {
    let (mut parts, _) = req.into_parts();
    let q = query_pairs(&parts.uri);
    let token = query_first(&q, "t").filter(|t| !t.is_empty());
    match token {
        Some(token) if valid_youtube_id(&key) => {
            let rid = media_token::resource_id("trailer", &key);
            let sub = match media_token::verify(
                &st.config.auth.stream_token_secret,
                token,
                &[media_token::DIRECT],
                Some(&rid),
            ) {
                Ok(sub) => sub,
                Err(refusal) => return err(StatusCode::UNAUTHORIZED, refusal.as_str()),
            };
            match auth::member_status(&st.auth.pool, &st.config.auth.admin_subs, &sub).await {
                Ok(auth::members::MemberStatus::Allowed) => {}
                Ok(_) => return err(StatusCode::UNAUTHORIZED, "access_revoked"),
                Err(e) => return e.into_response(),
            }
        }
        _ => {
            if let Err(rejection) = auth::RequireAuth::from_request_parts(&mut parts, &st).await {
                return rejection.into_response();
            }
        }
    }
    if !valid_youtube_id(&key) {
        return err(StatusCode::BAD_REQUEST, "invalid_key");
    }
    let path = muxed_path(&st.config.ext.mux_dir, &key);
    if !tokio::fs::metadata(&path).await.is_ok_and(|m| m.is_file()) {
        // Evicted or expired between /trailer and playback: the app re-taps.
        return err(StatusCode::NOT_FOUND, "trailer_not_ready");
    }
    let Ok(mut res) = ServeFile::new(path)
        .oneshot(Request::from_parts(parts, Body::empty()))
        .await;
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    res.into_response()
}

// --- public base URL -------------------------------------------------------------------

fn first_value(headers: &HeaderMap, name: impl header::AsHeaderName) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Exactly an allowed origin's host, or a subdomain of one (the API lives at
/// api.<spa-domain>). A malformed allowlist entry never matches.
fn allowed_host(host: &str, allowed: &[String]) -> bool {
    let lower = host.to_ascii_lowercase();
    let hostname = match lower.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => lower.as_str(),
    };
    allowed.iter().any(|origin| {
        reqwest::Url::parse(origin)
            .ok()
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
            .is_some_and(|o| hostname == o || hostname.ends_with(&format!(".{o}")))
    })
}

/// The origin a client reached us on, for URLs handed back. X-Forwarded-Host
/// and Host are attacker-controlled wherever the backend is reachable without
/// the trusted proxy, so a host is echoed only when it belongs to
/// ALLOWED_ORIGINS; otherwise the first parseable configured origin, else the
/// request's own Host. With no allowlist (dev, direct LAN) it passes through.
pub fn public_base_url(headers: &HeaderMap, allowed: &[String]) -> String {
    let request_host = Some(first_value(headers, header::HOST))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "localhost".into());
    let proto = match first_value(headers, "x-forwarded-proto")
        .to_ascii_lowercase()
        .as_str()
    {
        "https" => "https",
        _ => "http",
    };
    let forwarded = first_value(headers, "x-forwarded-host");
    let candidate = if forwarded.is_empty() {
        request_host.clone()
    } else {
        forwarded
    };
    let unsafe_host = candidate
        .chars()
        .any(|c| c.is_whitespace() || c == '/' || c == '\\');
    let host = if unsafe_host {
        request_host.clone()
    } else {
        candidate
    };
    if allowed.is_empty() || allowed_host(&host, allowed) {
        return format!("{proto}://{host}");
    }
    allowed
        .iter()
        .find_map(|o| reqwest::Url::parse(o).ok())
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|| format!("{proto}://{request_host}"))
}

#[cfg(test)]
pub(crate) mod fake;
#[cfg(test)]
mod goldens;
#[cfg(test)]
mod tests;
