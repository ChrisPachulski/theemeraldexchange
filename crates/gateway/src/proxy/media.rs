//! /api/media (routes/media.ts): the playback grant and the proxy to
//! media-core's library, metadata and direct-play bytes.
//!
//! The gate decodes the path once, as media-core's router decodes its params
//! (a raw match let `/chapters/%6dovie/7` skip every gate yet reach movie 7):
//! - `/stream/<kind>/<id>?t=`: a `vod` media token bound to that title, plus
//!   membership; cookieless (a cross-origin `<video>` sends no cookie). The
//!   rating cap was applied when the grant minted the token.
//! - `/stream/...` without a token: the session, then the rating cap, so a
//!   capped profile cannot skip the grant.
//! - `/subtitles/{movie,episode}/<id>/...` and `/chapters/{movie,episode,video}/<id>`:
//!   the session and the rating cap (dialogue is the blocked content).
//! - `/youtube/...`: the session; an unrated catalog, hidden from any cap.
//! - everything else: the session.

use std::time::Instant;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, post};
use serde_json::{Map, Value, json};

use super::{MEDIA_TTFB, Proxy, copy, principal, query_without_token, req_id, token_caller};
use crate::AppState;
use crate::arr::shared::{query_first, query_pairs};
use crate::media_token;
use crate::parental::{Title, rating_blocked};
use crate::principal::Caller;
use crate::routes::{err, js_number, js_str_number, truthy};
use crate::upstream::LAN_TIMEOUT;

/// Range, seeking and revalidation work end to end through the proxy.
const FORWARD_REQUEST: &[&str] = &["range", "if-range", "if-none-match", "if-modified-since"];
/// 206s, seeking, caching, and X-Accel-Buffering so cloudflared does not
/// accumulate a range response before the player sees byte one.
pub(super) const FORWARD_RESPONSE: &[&str] = &[
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
    "etag",
    "last-modified",
    "cache-control",
    "x-accel-buffering",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/media/playback/{kind}/{id}",
            post(playback).fallback(proxy),
        )
        .route("/api/media", any(proxy))
        .route("/api/media/{*rest}", any(proxy))
}

/// Who a gated request acts as.
struct Actor {
    session: auth::session::Session,
    device_id: Option<String>,
}

impl Actor {
    fn caller(&self) -> Caller<'_> {
        Caller {
            sub: &self.session.sub,
            role: self.session.role.as_str(),
            auth_mode: self.session.sub.split(':').next().unwrap_or_default(),
            device_id: self.device_id.as_deref(),
        }
    }
}

async fn session(st: &AppState, headers: &HeaderMap) -> Result<Actor, Response> {
    auth::authenticate(&st.auth, headers)
        .await
        .map(|p| Actor {
            device_id: p.device.map(|d| d.device_id),
            session: p.session,
        })
        .map_err(IntoResponse::into_response)
}

fn blocked() -> Response {
    err(StatusCode::FORBIDDEN, "rating_blocked")
}

async fn gate_rating(st: &AppState, a: &Actor, kind: &str, id: &str) -> Result<(), Response> {
    let Some(title) = Title::parse(kind) else {
        return Ok(());
    };
    match rating_blocked(st, &a.session, title, js_str_number(id)).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(blocked()),
        Err(e) => Err(e.into_response()),
    }
}

/// `^/<lead>/(<kind>)/([^/?]+)` on the decoded subpath.
fn kind_id<'a>(subpath: &'a str, lead: &str, kinds: Option<&[&str]>) -> Option<(&'a str, &'a str)> {
    let rest = subpath.strip_prefix(lead)?.strip_prefix('/')?;
    let (kind, rest) = rest.split_once('/')?;
    let id = rest.split(['/', '?']).next().unwrap_or_default();
    let ok = !kind.is_empty() && !id.is_empty() && kinds.is_none_or(|k| k.contains(&kind));
    ok.then_some((kind, id))
}

/// mediaAuth.
async fn gate(
    st: &AppState,
    headers: &HeaderMap,
    uri: &axum::http::Uri,
) -> Result<Actor, Response> {
    let Some(decoded) = super::decode_uri_component(uri.path()) else {
        return Err(err(StatusCode::BAD_REQUEST, "bad_path"));
    };
    let subpath = match decoded.strip_prefix("/api/media") {
        Some("") | None => "/",
        Some(rest) => rest,
    };
    let pairs = query_pairs(uri);
    let token = query_first(&pairs, "t").filter(|t| !t.is_empty());
    if let Some((kind, id)) = kind_id(subpath, "/stream", None) {
        if let Some(token) = token {
            let rid = media_token::resource_id(kind, id);
            let sub = media_token::verify(
                &st.config.auth.stream_token_secret,
                token,
                &[media_token::DIRECT],
                Some(&rid),
            )
            .map_err(|r| err(StatusCode::UNAUTHORIZED, r.as_str()))?;
            super::require_member(st, &sub).await?;
            return Ok(Actor {
                session: auth::session::Session {
                    auth_mode: auth::AuthMode::Local,
                    username: String::new(),
                    role: auth::Role::User,
                    sub,
                },
                device_id: None,
            });
        }
        let a = session(st, headers).await?;
        gate_rating(st, &a, kind, id).await?;
        return Ok(a);
    }
    let subs = kind_id(subpath, "/subtitles", Some(&["movie", "episode"]))
        .or_else(|| kind_id(subpath, "/chapters", Some(&["movie", "episode", "video"])));
    if let Some((kind, id)) = subs {
        let a = session(st, headers).await?;
        gate_rating(st, &a, kind, id).await?;
        return Ok(a);
    }
    let a = session(st, headers).await?;
    if subpath.starts_with("/youtube/") {
        match st.stores.policies.cap_blocks_unrated(&a.session).await {
            Ok(false) => {}
            Ok(true) => return Err(blocked()),
            Err(e) => return Err(e.into_response()),
        }
    }
    Ok(a)
}

/// The catch-all: media-core's JSON routes and the `/stream` bytes.
async fn proxy(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let actor = match gate(&st, &parts.headers, &parts.uri).await {
        Ok(a) => a,
        Err(res) => return res,
    };
    let subpath = match parts.uri.path().strip_prefix("/api/media") {
        Some("") | None => "/",
        Some(rest) => rest,
    };
    let url = format!(
        "{}/api/media{subpath}{}",
        st.config.media_core_url,
        query_without_token(&parts.uri)
    );
    let mut headers = HeaderMap::new();
    match principal(&st, &actor.caller(), req_id(&parts.headers)).await {
        Ok(Some(bearer)) => {
            headers.insert(header::AUTHORIZATION, bearer);
        }
        Ok(None) => {}
        Err(res) => return res,
    }
    copy(&parts.headers, &mut headers, FORWARD_REQUEST);

    let has_body = !matches!(parts.method, Method::GET | Method::HEAD);
    let mut forwarded = None;
    let mut watched = None;
    if has_body {
        // The edge already buffered this body under the 1 MiB control limit.
        let bytes = axum::body::to_bytes(body, usize::MAX)
            .await
            .unwrap_or_default();
        let ct = parts.headers.get(header::CONTENT_TYPE).cloned();
        if parts.method == Method::POST
            && subpath == "/watch"
            && ct
                .as_ref()
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.contains("application/json"))
        {
            watched = watch_signal(&st, &actor.session.sub, &bytes).await;
        }
        if let Some(ct) = ct {
            headers.insert(header::CONTENT_TYPE, ct);
        }
        forwarded = Some(bytes);
    }

    let res = match st
        .proxy
        .send(
            "media-core",
            parts.method,
            &url,
            headers,
            forwarded,
            MEDIA_TTFB,
        )
        .await
    {
        Ok(res) => res,
        Err(res) => return res,
    };
    // A media-core 401 is about this server's principal, never the browser's.
    if res.status() == StatusCode::UNAUTHORIZED {
        return err(StatusCode::BAD_GATEWAY, "media_core_auth_failed");
    }
    if res.status().is_success()
        && let Some((kind, tmdb_id)) = watched
        && st.config.use_local_recommender
    {
        let principal = auth::Principal {
            session: actor.session.clone(),
            device: None,
        };
        let caller = crate::recommender::Caller::new(&principal, &parts.headers);
        crate::recommender::post_feedback(
            &st,
            &actor.session.sub,
            kind,
            tmdb_id,
            "watched",
            Some(&caller),
        );
    }
    super::respond(res, Some(FORWARD_RESPONSE))
}

// --- the watched signal (services/localMediaWatchSignal.ts, watchSignal.ts) ---

/// 40% of a feature is a real commitment: strong enough to count as taste,
/// low enough to catch "watched most of it then stopped".
pub const WATCH_QUALIFY_FRACTION: f64 = 0.4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WatchPoint {
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub completed: bool,
}

pub fn watch_qualified(p: &WatchPoint) -> bool {
    p.completed
        || p.duration_secs
            .is_some_and(|d| d > 0.0 && p.position_secs / d >= WATCH_QUALIFY_FRACTION)
}

/// Fire once, on the report that first crosses into qualified (a missing
/// prior row counts as not qualified).
pub fn crossed_watch_threshold(prior: Option<&WatchPoint>, now: &WatchPoint) -> bool {
    watch_qualified(now) && !prior.is_some_and(watch_qualified)
}

/// The recommender signal a successful watch upsert earns, read from media.db
/// BEFORE the write so the 40% transition is observable. Any doubt (bad body,
/// no identity, no media.db) is no signal; media-core still validates.
async fn watch_signal(
    st: &AppState,
    sub: &str,
    body: &Bytes,
) -> Option<(crate::stores::Kind, u64)> {
    let db = st
        .suggestions
        .media_db
        .get(&st.config.media_db_path)
        .await?;
    let body: Value = serde_json::from_slice(body).ok()?;
    resolve_watched(&db, sub, &body).await
}

pub async fn resolve_watched(
    db: &sqlx::SqlitePool,
    sub: &str,
    body: &Value,
) -> Option<(crate::stores::Kind, u64)> {
    let body = body.as_object()?;
    let media_id = body
        .get("media_id")?
        .as_f64()
        .and_then(crate::routes::safe_positive)?;
    let kind = body.get("media_kind")?.as_str()?;
    if kind != "movie" && kind != "episode" {
        return None;
    }
    let num = |k: &str| match body.get(k) {
        None | Some(Value::Null) => None,
        v => Some(js_number(v)),
    };
    let position = num("position_secs").unwrap_or(0.0);
    let duration = num("duration_secs");
    if !position.is_finite() || duration.is_some_and(|d| !d.is_finite()) {
        return None;
    }
    let now = WatchPoint {
        position_secs: position.floor().max(0.0),
        duration_secs: duration.map(|d| d.floor().max(0.0)),
        completed: body.get("completed").is_some_and(truthy),
    };
    let sql = if kind == "movie" {
        "SELECT m.tmdb_id, w.position_secs, w.duration_secs, w.completed FROM movies m \
         LEFT JOIN media_watch_state w ON w.sub = ? AND w.media_kind = 'movie' AND w.media_id = m.id \
         WHERE m.id = ?"
    } else {
        "SELECT s.tmdb_id, w.position_secs, w.duration_secs, w.completed FROM episodes e \
         JOIN shows s ON s.id = e.show_id \
         LEFT JOIN media_watch_state w ON w.sub = ? AND w.media_kind = 'episode' AND w.media_id = e.id \
         WHERE e.id = ?"
    };
    // All INTEGER columns in media-core's schema.
    type Row = (Option<i64>, Option<i64>, Option<i64>, Option<i64>);
    let (tmdb_id, pos, dur, completed): Row = sqlx::query_as(sql)
        .bind(sub)
        .bind(media_id as i64)
        .fetch_optional(db)
        .await
        .ok()??;
    let tmdb_id = tmdb_id.and_then(|id| crate::routes::safe_positive(id as f64))?;
    let prior = pos.map(|p| WatchPoint {
        position_secs: p as f64,
        duration_secs: dur.map(|d| d as f64),
        completed: completed == Some(1),
    });
    crossed_watch_threshold(prior.as_ref(), &now).then_some((
        if kind == "movie" {
            crate::stores::Kind::Movie
        } else {
            crate::stores::Kind::Tv
        },
        tmdb_id,
    ))
}

// --- the playback grant --------------------------------------------------------------

/// What the client can play. Defaults: the web-safe mp4 + h264 + AAC stereo
/// profile, so anything else goes to the transcoder rather than a `<video>`
/// that cannot decode it.
struct Caps {
    containers: Vec<Value>,
    video_codecs: Vec<Value>,
    max_height: Value,
    hdr: bool,
    audio_codecs: Vec<Value>,
    aac_max_channels: f64,
    hls_fmp4_hevc: bool,
    native_hls: bool,
    alt_audio: bool,
    dolby_vision: bool,
    max_bitrate: Option<f64>,
}

impl Caps {
    fn from_request(r: &Map<String, Value>) -> Caps {
        let list = |k: &str, default: &str| match r.get(k) {
            Some(Value::Array(a)) if !a.is_empty() => a.clone(),
            _ => vec![Value::from(default)],
        };
        let flag = |k: &str| r.get(k).is_some_and(truthy);
        let number = |k: &str| r.get(k).and_then(Value::as_f64);
        Caps {
            containers: list("containers", "mp4"),
            video_codecs: list("video_codecs", "h264"),
            max_height: match r.get("max_height") {
                Some(v @ Value::Number(_)) => v.clone(),
                _ => Value::from(2160),
            },
            hdr: flag("hdr"),
            audio_codecs: list("audio_codecs", "aac"),
            aac_max_channels: number("aac_max_channels")
                .filter(|n| *n >= 2.0)
                .map_or(2.0, f64::floor),
            hls_fmp4_hevc: flag("hls_fmp4_hevc"),
            native_hls: flag("native_hls"),
            alt_audio: flag("alt_audio"),
            dolby_vision: flag("dolby_vision"),
            max_bitrate: number("max_bitrate")
                .filter(|n| n.is_finite() && *n > 0.0)
                .map(f64::floor),
        }
    }

    fn grant_body(&self) -> Value {
        let mut b = json!({
            "containers": self.containers,
            "video_codecs": self.video_codecs,
            "max_height": self.max_height,
            "hdr": self.hdr,
            "audio_codecs": self.audio_codecs,
            "aac_max_channels": num(self.aac_max_channels),
            "hls_fmp4_hevc": self.hls_fmp4_hevc,
            "dolby_vision": self.dolby_vision,
        });
        if let Some(m) = self.max_bitrate {
            b["max_bitrate"] = num(m);
        }
        b
    }

    /// The handoff query, in URLSearchParams#set order.
    fn query(&self, start_secs: Option<f64>, force_transcode: bool) -> String {
        let join = |v: &[Value]| {
            v.iter()
                .map(|x| match x {
                    Value::Null => String::new(),
                    other => crate::tmdb::js_string(other),
                })
                .collect::<Vec<_>>()
                .join(",")
        };
        let mut url = reqwest::Url::parse("http://q/").expect("static url");
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("containers", &join(&self.containers));
            q.append_pair("video_codecs", &join(&self.video_codecs));
            if self.max_height.is_number() {
                q.append_pair("max_height", &crate::tmdb::js_string(&self.max_height));
            }
            q.append_pair("hdr", &self.hdr.to_string());
            q.append_pair("audio_codecs", &join(&self.audio_codecs));
            q.append_pair("aac_max_channels", &num(self.aac_max_channels).to_string());
            q.append_pair("hls_fmp4_hevc", &self.hls_fmp4_hevc.to_string());
            if self.native_hls {
                q.append_pair("native_hls", "true");
            }
            if self.alt_audio {
                q.append_pair("alt_audio", "true");
            }
            if self.dolby_vision {
                q.append_pair("dolby_vision", "true");
            }
            if let Some(m) = self.max_bitrate {
                q.append_pair("max_bitrate", &num(m).to_string());
            }
            if let Some(s) = start_secs {
                q.append_pair("start_secs", &num(s).to_string());
            }
            if force_transcode {
                q.append_pair("force_transcode", "true");
            }
        }
        url.query().unwrap_or_default().to_string()
    }
}

fn num(n: f64) -> Value {
    Value::Number(crate::app::js_number(n))
}

/// A string field when present and non-empty (JS truthiness of a string).
fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// POST /api/media/playback/{kind}/{id}: the media-core capability grant,
/// then either a direct-play token or a transcoder session whose first
/// segment exists before the client gets the URL (hls.js fetches a manifest
/// once and never retries its 503). Mirrors the IPTV grant shape.
async fn playback(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let actor = match gate(&st, &parts.headers, &parts.uri).await {
        Ok(a) => a,
        Err(res) => return res,
    };
    // Hono's route params are decoded.
    let mut segs = parts.uri.path().rsplit('/');
    let raw_id = segs.next().unwrap_or_default();
    let raw_kind = segs.next().unwrap_or_default();
    let (Some(kind), Some(id)) = (
        super::decode_uri_component(raw_kind),
        super::decode_uri_component(raw_id),
    ) else {
        return err(StatusCode::BAD_REQUEST, "bad_path");
    };
    let Some(title) = Title::parse(&kind) else {
        return err(StatusCode::BAD_REQUEST, "unknown media kind");
    };
    match rating_blocked(&st, &actor.session, title, js_str_number(&id)).await {
        Ok(false) => {}
        Ok(true) => return blocked(),
        Err(e) => return e.into_response(),
    }

    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .unwrap_or_default();
    let request: Map<String, Value> = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let caps = Caps::from_request(&request);
    let start_secs = request
        .get("start_secs")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(f64::floor);
    // Audio is always direct play, so HLS is never forced for a track.
    let force_hls = title != Title::Track && request.get("force_hls").is_some_and(truthy);

    let mut auth = HeaderMap::new();
    match principal(&st, &actor.caller(), req_id(&parts.headers)).await {
        Ok(Some(bearer)) => {
            auth.insert(header::AUTHORIZATION, bearer);
        }
        Ok(None) => {}
        Err(res) => return res,
    }

    // 1. The capability decision (and the file's duration): a small JSON
    // control call with a whole-transfer deadline.
    let mc = &st.config.media_core_url;
    let req = st
        .upstream
        .client()
        .post(format!("{mc}/api/media/play/{kind}/{id}/grant"))
        .headers(auth.clone())
        .header(header::CONTENT_TYPE, "application/json")
        .body(caps.grant_body().to_string());
    let reply = st.upstream.fetch(req, LAN_TIMEOUT, "media-core").await;
    if reply.status == StatusCode::NOT_FOUND {
        return err(StatusCode::NOT_FOUND, "not_found");
    }
    if !reply.is_success() {
        return err(StatusCode::BAD_GATEWAY, "grant_failed");
    }
    let Ok(grant) = serde_json::from_slice::<Value>(&reply.body) else {
        return err(StatusCode::BAD_GATEWAY, "media_core_unreachable");
    };
    let duration_secs = match grant.get("file").and_then(|f| f.get("duration_secs")) {
        None | Some(Value::Null) => Value::Null,
        Some(v) => v.clone(),
    };
    let secret = &st.config.auth.stream_token_secret;
    let ttl = st.config.media_stream_token_ttl_secs;

    // 2a. Direct play: a vod token on the proxied stream URL, unless the
    // client forced buffered delivery.
    if grant.get("directPlay").is_some_and(truthy) && !force_hls {
        let rid = media_token::resource_id(&kind, &id);
        let token = media_token::sign(secret, &actor.session.sub, &rid, media_token::DIRECT, ttl);
        return Json(json!({
            "delivery": "progressive",
            "url": format!("/api/media/stream/{kind}/{id}?t={token}"),
            "durationSecs": duration_secs,
        }))
        .into_response();
    }

    // 2b. A transcoder session, started by media-core's handoff.
    let req = st
        .upstream
        .client()
        .get(format!(
            "{mc}/api/media/stream/{kind}/{id}?{}",
            caps.query(start_secs, force_hls)
        ))
        .headers(auth.clone());
    let reply = st.upstream.fetch(req, LAN_TIMEOUT, "media-core").await;
    if reply.status == StatusCode::SERVICE_UNAVAILABLE {
        return err(StatusCode::SERVICE_UNAVAILABLE, "transcoder_unavailable");
    }
    if !reply.is_success() {
        return err(StatusCode::BAD_GATEWAY, "transcode_start_failed");
    }
    let Ok(handoff) = serde_json::from_slice::<Value>(&reply.body) else {
        return err(StatusCode::BAD_GATEWAY, "transcoder_unreachable");
    };
    let (Some(sid), Some(manifest)) = (text(&handoff, "sessionId"), text(&handoff, "manifestUrl"))
    else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "transcoder_unavailable");
    };

    let tc = &st.config.transcoder_url;
    let ready = wait_ready(&st, &format!("{tc}{manifest}"), &auth).await;

    let token = media_token::sign(
        secret,
        &actor.session.sub,
        &media_token::session_resource_id(sid),
        media_token::HLS,
        ttl,
    );
    let with_token = |u: &str| {
        let sep = if u.contains('?') { '&' } else { '?' };
        format!("{u}{sep}t={token}")
    };
    // The client POSTs stop on close, so the transcoder frees its slot now
    // instead of after the idle reaper.
    let stop = match manifest.strip_suffix("/index.m3u8") {
        Some(base) => format!("{base}/stop"),
        None => manifest.to_string(),
    };
    let subtitle = handoff
        .get("subtitle")
        .filter(|s| text(s, "url").is_some())
        .map_or(Value::Null, |s| {
            json!({
                "url": with_token(text(s, "url").unwrap_or_default()),
                "language": s.get("language").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
                "forced": s.get("forced").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Bool(false)),
            })
        });

    // Trick-play: one probe proves the I-frame rendition exists (it 404s for
    // copy-remux or no-duration sessions); a failure is just no previews.
    let mut trickplay = Value::Null;
    if ready && let Some(base) = manifest.strip_suffix("/index.m3u8") {
        let iframe = format!("{base}/iframe.m3u8");
        let req = st
            .upstream
            .client()
            .get(format!("{tc}{iframe}"))
            .headers(auth.clone());
        let reply = st.upstream.fetch(req, LAN_TIMEOUT, "transcoder").await;
        if reply.is_success()
            && String::from_utf8_lossy(&reply.body).contains("#EXT-X-I-FRAMES-ONLY")
        {
            trickplay = Value::String(with_token(&iframe));
        }
    }

    Json(json!({
        "delivery": "hls",
        "url": with_token(text(&handoff, "masterUrl").unwrap_or(manifest)),
        "heartbeatUrl": text(&handoff, "heartbeatUrl").map_or(Value::Null, |h| Value::String(with_token(h))),
        "stopUrl": with_token(&stop),
        "sessionId": sid,
        "durationSecs": duration_secs,
        "subtitle": subtitle,
        "trickplayUrl": trickplay,
    }))
    .into_response()
}

/// Poll the manifest until it lists a segment (`.ts` or fMP4 `.m4s`), within
/// a wall-clock deadline. A failed probe is transient.
async fn wait_ready(st: &AppState, url: &str, auth: &HeaderMap) -> bool {
    static SEGMENT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let segment = SEGMENT
        .get_or_init(|| regex::Regex::new(r"(?m)\.(?:ts|m4s)(\?|\s|$)").expect("static regex"));
    let Proxy { timings, .. } = &*st.proxy;
    let deadline = Instant::now() + timings.ready_deadline;
    while Instant::now() < deadline {
        let req = st.upstream.client().get(url).headers(auth.clone());
        let reply = st.upstream.fetch(req, LAN_TIMEOUT, "transcoder").await;
        if reply.is_success() && segment.is_match(&String::from_utf8_lossy(&reply.body)) {
            return true;
        }
        tokio::time::sleep(timings.ready_poll).await;
    }
    false
}

/// Purge one member's media-core watch state (account deletion). Best
/// effort by contract: a non-2xx is a failed erasure step. In the dev
/// posture media-core takes the member from `?sub=`.
pub async fn erase_watch_state(st: &AppState, sub: &str) -> Result<(), String> {
    let query = if st.config.auth.internal_principal_secret.is_some() {
        String::new()
    } else {
        format!("?sub={}", super::encode_uri_component(sub))
    };
    let mut req = st.upstream.client().delete(format!(
        "{}/api/media/watch{query}",
        st.config.media_core_url
    ));
    if let Some(bearer) = principal(st, &token_caller(sub), None)
        .await
        .map_err(|_| "failed to mint internal-principal".to_string())?
    {
        req = req.header(header::AUTHORIZATION, bearer);
    }
    let status = tokio::time::timeout(std::time::Duration::from_secs(10), req.send())
        .await
        .map_err(|_| "The operation was aborted due to timeout".to_string())?
        .map_err(|e| e.without_url().to_string())?
        .status();
    if !status.is_success() {
        return Err(format!(
            "media-core DELETE /api/media/watch answered {}",
            status.as_u16()
        ));
    }
    Ok(())
}
