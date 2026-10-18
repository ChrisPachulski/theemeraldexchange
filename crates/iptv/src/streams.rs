//! Grants and non-remux streaming (routes/iptv/stream*.ts, sessions.ts and the
//! shared helpers): the four grant endpoints, the raw live .ts proxy with
//! sibling failover, catch-up, VOD/series range proxying, the HLS segment
//! proxy, and the sessions widget. Hono keeps auth, the live-section, rating
//! and membership checks; this service re-verifies stream tokens for kind and
//! resource, owns the concurrency slots, and is the only process that dials
//! the provider.

// Early returns hand back the ready Response; it is the cold path.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use emerald_contracts::stream_token::StreamKind;
use reqwest::Url;
use serde_json::{Value, json};
use tokio::sync::OnceCell;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::api::{AppState, Claims, Params, js_date, param};
use crate::concurrency::{Acquire, Kind, Limit, Session, Tracker};
use crate::config::Config;
use crate::egress::Egress;
use crate::feed_verify::{LiveIo, LiveSessionRef};
use crate::hls::{self, Owner, Rewrite, internal, is_word_id, json_error, upstream_status};
use crate::playlist;
use crate::remux::Remux;
use crate::remux_map::{self, EnsureOpts, LiveMap};
use crate::siblings::sibling_feeds;
use crate::xtream::{self, Creds, fetch_guarded};

/// The User-Agent every provider dial sends; the provider 503s ffmpeg's
/// default "Lavf/..." (2026-09-12).
pub const UPSTREAM_USER_AGENT: &str = "IPTVSmarters";
/// A slot idles out after this; remux gets REMUX_IDLE_MS.
const IDLE_MS: u64 = 30_000;
/// Byte routes heartbeat their slot at most this often.
const HEARTBEAT_THROTTLE: Duration = Duration::from_secs(5);
/// A clean upstream EOF this soon is a dead-placeholder slate loop, not a live
/// feed (live streams run unbounded).
pub const DEAD_FEED_CLEAN_EOF: Duration = Duration::from_secs(60);
const DEAD_FEED_MEMORY: Duration = Duration::from_secs(10 * 60);
/// A placeholder EOFs fast every time; a provider cap kick does it once. So a
/// feed is only tagged dead on its second fast clean EOF inside the window.
const DEAD_FEED_STRIKES_TO_TAG: u32 = 2;
/// An UP panel probe is remembered this long (a DOWN one never is).
const PROBE_OK_TTL: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a raw live request waits for draining provider sockets.
const DRAIN_WAIT: Duration = Duration::from_secs(6);
/// How long a viewer's dial waits for preempted feed-check captures to exit.
const AUX_YIELD: Duration = Duration::from_secs(3);
const REDACTED: &str = "another household member";

pub struct Streams {
    pub tracker: Arc<Tracker>,
    pub dead: Arc<DeadFeeds>,
    /// The AVPlayer live remux: ffmpeg children and the (channel, viewer) index.
    pub live: LiveMap,
    /// One feed check at a time, on tune or in the idle sweep.
    pub feed: Arc<crate::feed_verify::Scheduler>,
    /// No redirects followed (each hop is guarded by hand), the provider UA.
    pub http: reqwest::Client,
    leases: Mutex<HashMap<String, Lease>>,
    lease_ids: AtomicU64,
    probe_ok_until: Mutex<Option<Instant>>,
    probe_flight: Mutex<Option<Arc<OnceCell<bool>>>>,
}

struct Lease {
    id: u64,
    sub: String,
    stream_id: String,
    stop: CancellationToken,
}

impl Streams {
    /// Needs a tokio runtime: it binds the ffmpeg egress proxy and starts
    /// the remux idle reaper.
    pub fn new(config: &Config) -> Self {
        let tracker = Arc::new(Tracker::new(
            config.iptv_max_concurrent_streams as usize,
            IDLE_MS,
        ));
        let dead = Arc::new(DeadFeeds::default());
        let egress = Egress::start(&config.xtream_host);
        let remux = Remux::new(config, tracker.clone(), dead.clone(), egress);
        Streams {
            live: LiveMap::new(remux, config),
            feed: Arc::default(),
            tracker,
            dead,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(UPSTREAM_USER_AGENT)
                .build()
                .expect("reqwest client builds"),
            leases: Mutex::new(HashMap::new()),
            lease_ids: AtomicU64::new(0),
            probe_ok_until: Mutex::new(None),
            probe_flight: Mutex::new(None),
        }
    }

    /// Provider connections right now; this is what the upstream cap bounds.
    pub fn live_upstream_count(&self) -> usize {
        self.live.remux.live_upstream_count()
    }

    /// One physical byte proxy per viewer/channel: publish the new owner, then
    /// stop the prior proxy, so its late teardown cannot release the new one.
    fn begin_raw_live(self: &Arc<Self>, sub: &str, stream_id: &str) -> LeaseHandle {
        let key = format!("{sub}|{stream_id}");
        let id = self.lease_ids.fetch_add(1, Ordering::SeqCst);
        let stop = CancellationToken::new();
        let prev = self.leases.lock().unwrap().insert(
            key.clone(),
            Lease {
                id,
                sub: sub.into(),
                stream_id: stream_id.into(),
                stop: stop.clone(),
            },
        );
        if let Some(p) = prev {
            p.stop.cancel();
        }
        LeaseHandle {
            streams: self.clone(),
            key,
            id,
            stop,
        }
    }

    pub fn stop_raw_live(&self, sub: &str, stream_id: &str) {
        if let Some(l) = self
            .leases
            .lock()
            .unwrap()
            .remove(&format!("{sub}|{stream_id}"))
        {
            l.stop.cancel();
        }
    }

    pub fn stop_other_raw_lives(&self, sub: &str, keep: Option<&str>) {
        let mut leases = self.leases.lock().unwrap();
        leases.retain(|_, l| {
            let stop = l.sub == sub && keep != Some(l.stream_id.as_str());
            if stop {
                l.stop.cancel();
            }
            !stop
        });
    }

    /// The §9 precedence check: is the panel reachable? UP is cached 60 s and
    /// concurrent tunes share one in-flight probe; DOWN is never cached.
    pub async fn panel_up(&self, config: &Config) -> bool {
        let Ok(creds) = Creds::from_config(config) else {
            return false;
        };
        if self
            .probe_ok_until
            .lock()
            .unwrap()
            .is_some_and(|t| Instant::now() < t)
        {
            return true;
        }
        let cell = self
            .probe_flight
            .lock()
            .unwrap()
            .get_or_insert_with(|| Arc::new(OnceCell::new()))
            .clone();
        let ok = *cell.get_or_init(|| self.probe(&creds)).await;
        {
            let mut flight = self.probe_flight.lock().unwrap();
            if flight.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cell)) {
                *flight = None;
                if ok {
                    *self.probe_ok_until.lock().unwrap() = Some(Instant::now() + PROBE_OK_TTL);
                }
            }
        }
        ok
    }

    /// A 2xx from the bare account endpoint. 4xx (expired line, bad creds),
    /// 5xx, a timeout or a refused redirect hop are all down.
    async fn probe(&self, creds: &Creds) -> bool {
        let Ok(url) = xtream::build_player_api_url(creds, None, &[]) else {
            return false;
        };
        let res =
            tokio::time::timeout(PROBE_TIMEOUT, fetch_guarded(&self.http, url, None, false)).await;
        matches!(res, Ok(Ok(r)) if r.status().is_success())
    }
}

struct LeaseHandle {
    streams: Arc<Streams>,
    key: String,
    id: u64,
    stop: CancellationToken,
}

impl LeaseHandle {
    fn is_current(&self) -> bool {
        self.streams
            .leases
            .lock()
            .unwrap()
            .get(&self.key)
            .is_some_and(|l| l.id == self.id)
    }

    /// Drop the lease if it is still ours; true when it was.
    fn dispose(&self) -> bool {
        let mut leases = self.streams.leases.lock().unwrap();
        if leases.get(&self.key).is_some_and(|l| l.id == self.id) {
            leases.remove(&self.key);
            true
        } else {
            false
        }
    }
}

type Strikes = HashMap<String, (u32, Instant)>;

/// Feeds remembered as dead-channel placeholders, and first strikes.
#[derive(Default)]
pub struct DeadFeeds {
    /// (dead feed -> expiry, feed -> (strikes, expiry)).
    inner: Mutex<(HashMap<String, Instant>, Strikes)>,
}

impl DeadFeeds {
    /// True while `stream_id` is remembered dead; self-expiring so a
    /// recovered channel is re-probed.
    pub fn is_dead(&self, stream_id: &str) -> bool {
        let mut g = self.inner.lock().unwrap();
        match g.0.get(stream_id) {
            Some(exp) if *exp > Instant::now() => true,
            Some(_) => {
                g.0.remove(stream_id);
                false
            }
            None => false,
        }
    }

    /// Record a fast clean EOF; the second inside the window tags the feed.
    pub fn strike(&self, stream_id: &str) {
        let now = Instant::now();
        let mut g = self.inner.lock().unwrap();
        let count = match g.1.get(stream_id) {
            Some((n, exp)) if *exp > now => n + 1,
            _ => 1,
        };
        if count < DEAD_FEED_STRIKES_TO_TAG {
            g.1.insert(stream_id.into(), (count, now + DEAD_FEED_MEMORY));
            tracing::warn!(
                stream_id,
                strike = count,
                "fast clean EOF; re-dialing before declaring it dead"
            );
            return;
        }
        g.1.remove(stream_id);
        g.0.insert(stream_id.into(), now + DEAD_FEED_MEMORY);
        tracing::warn!(
            stream_id,
            "fast clean EOF; tagged as a dead feed, failing over to a sibling"
        );
    }
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/iptv/sessions", get(list_sessions))
        .route("/api/iptv/sessions/{id}", delete(release_session))
        .route("/api/iptv/stream/live/{id}/grant", post(live_grant))
        .route("/api/iptv/stream/catchup/{id}/grant", post(catchup_grant))
        .route("/api/iptv/stream/vod/{id}/grant", post(vod_grant))
        .route("/api/iptv/stream/series/{id}/grant", post(series_grant))
        .route("/api/iptv/stream/live/{file}", get(live_ts))
        .route(
            "/api/iptv/stream/live/{id}/remux/index.m3u8",
            get(remux_manifest),
        )
        .route("/api/iptv/stream/live/{id}/remux/seg", get(remux_seg))
        .route(
            "/api/iptv/stream/catchup/{id}/{start}/{file}",
            get(catchup_ts),
        )
        .route("/api/iptv/stream/vod/{id}/{ext}", get(vod_bytes))
        .route("/api/iptv/stream/series/{id}/{ext}", get(series_bytes))
        .route("/api/iptv/stream/segment", get(segment))
}

// ---- helpers ---------------------------------------------------------------------

fn status_json(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn unauthorized(body: Value) -> Response {
    status_json(StatusCode::UNAUTHORIZED, body)
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `parsePositiveInt`: digits only, a safe integer above zero.
fn positive_int(s: &str) -> Option<i64> {
    if !is_digits(s) {
        return None;
    }
    s.parse::<i64>()
        .ok()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
}

/// JS `encodeURIComponent`.
pub(crate) fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A JS number: whole values serialize without a fraction.
fn js_num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// Best-effort client IP (Cloudflare first, then X-Forwarded-For), so the
/// sessions widget can tell devices apart.
fn client_ip(headers: &HeaderMap) -> Option<String> {
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok());
    if let Some(cf) = h("cf-connecting-ip")
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(cf.to_string());
    }
    h("x-forwarded-for")?
        .split(',')
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(String::from)
}

fn caller(claims: &Claims) -> Result<(String, bool), Response> {
    claims
        .as_ref()
        .map(|c| (c.sub.clone(), c.role == "admin"))
        .ok_or_else(|| status_json(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })))
}

fn creds(s: &AppState) -> Result<Creds, Response> {
    Creds::from_config(&s.config).map_err(|e| internal(&e))
}

fn url(s: &str) -> Result<Url, Response> {
    Url::parse(s).map_err(|_| json_error(StatusCode::BAD_REQUEST, "bad_upstream"))
}

/// The token's canonical sub, which must also be the forwarded principal's.
/// Membership is Hono's check.
fn member_sub(claims: &Claims, token_sub: &str) -> Result<String, Response> {
    let sub = emerald_contracts::sub::parse_sub(token_sub)
        .map_err(|_| {
            unauthorized(json!({ "error": "invalid_token", "detail": "sub_invalid_format" }))
        })?
        .raw;
    if claims.as_ref().is_some_and(|c| c.sub != sub) {
        return Err(unauthorized(
            json!({ "error": "invalid_token", "detail": "sub_mismatch" }),
        ));
    }
    Ok(sub)
}

/// checkToken: HMAC and time window, kind, and the resource when given.
/// Returns (sub, rid). Every tracked kind is multi-use within its TTL, so the
/// replay cache's only refusal (past exp) is the time window here.
pub(crate) fn check_token(
    s: &AppState,
    claims: &Claims,
    token: &str,
    kind: StreamKind,
    rid: Option<&str>,
) -> Result<(String, String), Response> {
    let c = playlist::verify(&s.config.stream_token_secret, token)
        .map_err(|d| unauthorized(json!({ "error": "invalid_token", "detail": d })))?;
    if c.k != kind || rid.is_some_and(|r| r != c.rid) {
        let error = if rid.is_none() {
            "invalid_token"
        } else {
            "token_mismatch"
        };
        return Err(unauthorized(json!({ "error": error })));
    }
    Ok((member_sub(claims, &c.sub)?, c.rid))
}

/// A title for the sessions widget, or None (the UI shows the resource id).
async fn session_title(s: &AppState, kind: Kind, rid: &str) -> Option<String> {
    let pool = &s.pool;
    let name = |sql: &'static str, id: i64| async move {
        sqlx::query_scalar::<_, String>(sql)
            .bind(id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
    };
    let num = |s: &str| s.parse::<i64>().ok();
    match kind {
        Kind::Live | Kind::Remux => {
            name("SELECT name FROM channels WHERE stream_id = ?", num(rid)?).await
        }
        Kind::Catchup => {
            let sid = num(rid.split('|').next()?)?;
            name("SELECT name FROM channels WHERE stream_id = ?", sid).await
        }
        Kind::Vod => name("SELECT name FROM vod WHERE stream_id = ?", num(rid)?).await,
        Kind::Series => {
            let (title, series_id): (Option<String>, i64) =
                sqlx::query_as("SELECT title, series_id FROM series_episodes WHERE episode_id = ?")
                    .bind(rid)
                    .fetch_optional(pool)
                    .await
                    .ok()
                    .flatten()?;
            match name("SELECT name FROM series WHERE series_id = ?", series_id).await {
                Some(series) => Some(match title.filter(|t| !t.is_empty()) {
                    Some(t) => format!("{series} \u{2014} {t}"),
                    None => series,
                }),
                None => title,
            }
        }
    }
}

/// Sessions with `resolvedTitle`; other members' rows redacted for a
/// non-admin (every field stays present: the Swift client decodes this shape).
async fn enrich(s: &AppState, list: Vec<Session>, caller: &str, admin: bool) -> Vec<Value> {
    let mut out = Vec::with_capacity(list.len());
    for sess in list {
        let resolved = match &sess.title {
            Some(t) => Some(t.clone()),
            None => session_title(s, sess.kind, &sess.resource_id).await,
        };
        let mut v = serde_json::to_value(&sess).expect("session serializes");
        v["resolvedTitle"] = json!(resolved);
        if !admin && sess.sub != caller {
            v["sub"] = Value::Null;
            v["ip"] = Value::Null;
            v["title"] = json!(REDACTED);
            v["resolvedTitle"] = json!(REDACTED);
        }
        out.push(v);
    }
    out
}

async fn limit_429(s: &AppState, l: Limit, caller: &str, admin: bool) -> Response {
    status_json(
        StatusCode::TOO_MANY_REQUESTS,
        json!({
            "ok": false,
            "reason": "iptv_concurrency_limit",
            "limit": l.limit,
            "current": l.current,
            "sessions": enrich(s, l.sessions, caller, admin).await,
        }),
    )
}

fn source_unavailable() -> Response {
    status_json(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "ok": false, "reason": "source_unavailable", "available_alternatives": [] }),
    )
}

fn live_kind_cap(c: &Config) -> usize {
    c.iptv_max_concurrent_streams
        .min(c.iptv_max_upstream_connections) as usize
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Keep the slot an on-demand byte route serves under. A slot swept while the
/// player paused is taken again under the same cap; the 429 when that fails.
async fn hold_slot(
    s: &AppState,
    headers: &HeaderMap,
    sub: &str,
    kind: Kind,
    rid: &str,
) -> Option<Response> {
    let tracker = &s.streams.tracker;
    if tracker.heartbeat_by_resource(sub, kind, rid) {
        return None;
    }
    let acquired = tracker.try_acquire(Acquire {
        sub: sub.into(),
        session_id: format!(
            "{}:{rid}:{sub}:{}",
            format!("{kind:?}").to_lowercase(),
            now_ms()
        ),
        kind,
        resource_id: rid.into(),
        ip: client_ip(headers),
        title: session_title(s, kind, rid).await,
        kind_cap: None,
        replace_live: false,
    });
    match acquired {
        Ok(()) => None,
        Err(l) => Some(limit_429(s, l, sub, false).await),
    }
}

// ---- body watcher -----------------------------------------------------------------

/// Hooks on a proxied upstream body. `on_abort` fires when the body (or the
/// request before it) is dropped without a clean upstream EOF: a client
/// disconnect, an upstream error or a stop.
#[derive(Default)]
struct Watch {
    /// Throttled per chunk; false stops the stream.
    beat: Option<Box<dyn FnMut() -> bool + Send>>,
    on_eof: Option<Box<dyn FnOnce() + Send>>,
    on_abort: Option<Box<dyn FnOnce() + Send>>,
    stop: Option<CancellationToken>,
}

impl Watch {
    fn disarm(mut self) {
        self.on_abort = None;
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        if let Some(f) = self.on_abort.take() {
            f();
        }
    }
}

fn watched_body(res: reqwest::Response, watch: Watch) -> Body {
    struct St {
        res: reqwest::Response,
        w: Watch,
        last_beat: Option<Instant>,
        done: bool,
    }
    let st = St {
        res,
        w: watch,
        last_beat: None,
        done: false,
    };
    Body::from_stream(futures_util::stream::unfold(st, |mut st| async move {
        if st.done {
            return None;
        }
        let next = match st.w.stop.clone() {
            Some(t) => tokio::select! {
                biased;
                _ = t.cancelled() => return None,
                c = st.res.chunk() => c,
            },
            None => st.res.chunk().await,
        };
        match next {
            Ok(Some(bytes)) => {
                if let Some(beat) = st.w.beat.as_mut()
                    && st
                        .last_beat
                        .is_none_or(|t| t.elapsed() >= HEARTBEAT_THROTTLE)
                {
                    st.last_beat = Some(Instant::now());
                    if !beat() {
                        return None;
                    }
                }
                Some((Ok::<_, std::io::Error>(bytes), st))
            }
            Ok(None) => {
                st.w.on_abort = None;
                if let Some(f) = st.w.on_eof.take() {
                    f();
                }
                None
            }
            Err(e) => {
                st.done = true;
                Some((Err(std::io::Error::other(e.without_url())), st))
            }
        }
    }))
}

/// The upstream status and the Range headers a player needs, over the
/// watched body.
fn proxied(res: reqwest::Response, content_type: HeaderValue, watch: Watch) -> Response {
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut kept = Vec::new();
    for name in [
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = res.headers().get(&name) {
            kept.push((name, v.clone()));
        }
    }
    let mut out = Response::new(watched_body(res, watch));
    *out.status_mut() = status;
    let h = out.headers_mut();
    h.insert(header::CONTENT_TYPE, content_type);
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.extend(kept);
    out
}

fn with_headers(mut res: Response, pairs: &[(header::HeaderName, &'static str)]) -> Response {
    for (k, v) in pairs {
        res.headers_mut()
            .insert(k.clone(), HeaderValue::from_static(v));
    }
    res
}

// ---- sessions ----------------------------------------------------------------------

/// The caller's own sessions (all of them for an admin) and the provider's
/// own connection counters.
async fn list_sessions(State(s): State<AppState>, claims: Claims) -> Response {
    let (sub, admin) = match caller(&claims) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let mine: Vec<Session> = s
        .streams
        .tracker
        .list()
        .into_iter()
        .filter(|x| admin || x.sub == sub)
        .collect();
    let ours = enrich(&s, mine, &sub, true).await;
    let upstream = match Creds::from_config(&s.config)
        .and_then(|c| xtream::Client::new(c, s.config.iptv_list_timeout_ms))
    {
        Ok(client) => match client.account_info().await {
            Ok(info) => json!({
                "activeConnections": js_num(info.active_connections),
                "maxConnections": js_num(info.max_connections),
                "status": info.status,
            }),
            Err(_) => Value::Null,
        },
        Err(_) => Value::Null,
    };
    axum::Json(json!({ "self": sub, "upstream": upstream, "ours": ours })).into_response()
}

/// Force-release a slot: admins any, members their own. DVR slots are stopped
/// from the DVR panel, which ends the recording and the slot together.
async fn release_session(
    State(s): State<AppState>,
    claims: Claims,
    Path(id): Path<String>,
) -> Response {
    let (sub, admin) = match caller(&claims) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let Some(target) = s
        .streams
        .tracker
        .list()
        .into_iter()
        .find(|x| x.session_id == id)
    else {
        return json_error(StatusCode::NOT_FOUND, "not_found");
    };
    if !admin && target.sub != sub {
        return json_error(StatusCode::FORBIDDEN, "forbidden");
    }
    if target.sub.starts_with("dvr:") {
        return status_json(
            StatusCode::CONFLICT,
            json!({
                "error": "dvr_recording_session",
                "message": "stop this recording from the DVR panel (DELETE /api/dvr/recordings/:id), not the sessions widget",
            }),
        );
    }
    s.streams.tracker.release(&id);
    match target.kind {
        Kind::Live => s.streams.stop_raw_live(&target.sub, &target.resource_id),
        // The remux child holds a provider connection: stop it now, not at
        // the idle reap.
        Kind::Remux => {
            let live = &s.streams.live;
            if let Some(e) = live.get_active(&target.resource_id, &target.sub) {
                live.forget(&target.resource_id, &target.sub, &e.session_id);
            }
        }
        _ => {}
    }
    axum::Json(json!({ "ok": true, "released": id })).into_response()
}

// ---- grants ------------------------------------------------------------------------

async fn live_grant(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Params,
) -> Response {
    if !is_digits(&id) {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id");
    }
    if !s.streams.panel_up(&s.config).await {
        return source_unavailable();
    }
    let (sub, admin) = match caller(&claims) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let remux = param(&q, "client") == Some("avplayer");
    // A guide preview is not a watch: it must not tear down this account's
    // other tuners, or a guide focus on one device evicts a watch on another.
    let preview = param(&q, "intent") == Some("preview");
    let tracker = &s.streams.tracker;
    let borrowed = preview && remux && tracker.find(&sub, Kind::Remux, &id).is_some();
    let session_id = (!borrowed).then(|| format!("live:{id}:{sub}:{}", uuid::Uuid::new_v4()));
    if let Some(sid) = &session_id {
        let acquired = tracker.try_acquire(Acquire {
            sub: sub.clone(),
            session_id: sid.clone(),
            kind: if remux { Kind::Remux } else { Kind::Live },
            resource_id: id.clone(),
            ip: client_ip(&headers),
            title: session_title(&s, Kind::Live, &id).await,
            // Live grants open a provider connection, hard-capped upstream.
            kind_cap: Some(live_kind_cap(&s.config)),
            replace_live: !preview,
        });
        if let Err(l) = acquired {
            return limit_429(&s, l, &sub, admin).await;
        }
    }
    if !preview {
        // Admission replaced the caller's live reservations; only now stop
        // the old renderers, so a failed admission keeps existing playback.
        s.streams.stop_other_raw_lives(&sub, None);
        s.streams
            .live
            .drop_others(&sub, if remux { id.as_str() } else { "" });
    }
    let ttl = s.config.iptv_live_token_ttl_secs as i64;
    let secret = &s.config.stream_token_secret;
    let (url, delivery) = if remux {
        let t = playlist::sign(secret, StreamKind::Remux, &id, &sub, ttl, None);
        (
            format!("/api/iptv/stream/live/{id}/remux/index.m3u8?t={t}"),
            "hls",
        )
    } else {
        let t = playlist::sign(secret, StreamKind::Live, &id, &sub, ttl, None);
        (format!("/api/iptv/stream/live/{id}.ts?t={t}"), "mpegts")
    };
    let mut body = json!({ "url": url, "delivery": delivery });
    if let Some(sid) = session_id {
        body["sessionId"] = json!(sid);
    }
    axum::Json(body).into_response()
}

async fn catchup_grant(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Params,
) -> Response {
    if !is_digits(&id) {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id");
    }
    let start_utc = param(&q, "startUtc").unwrap_or("").to_string();
    let duration = positive_int(param(&q, "durationMin").unwrap_or(""));
    let start = (!start_utc.is_empty())
        .then(|| js_date(&start_utc))
        .flatten();
    let (Some(start), Some(duration)) = (start, duration) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid_params");
    };
    // The rid is streamId|startUtc|durationMin; a '|' would inject a segment.
    if start_utc.contains('|') {
        return json_error(StatusCode::BAD_REQUEST, "rid_invalid");
    }
    let channel: Option<(i64, Option<i64>)> = match sqlx::query_as(
        "SELECT tv_archive, tv_archive_duration FROM channels WHERE stream_id = ?",
    )
    .bind(id.parse::<i64>().unwrap_or(-1))
    .fetch_optional(&s.pool)
    .await
    {
        Ok(c) => c,
        Err(e) => return internal(&e.to_string()),
    };
    let Some((archive, days)) = channel else {
        return json_error(StatusCode::NOT_FOUND, "not_found");
    };
    if archive != 1 {
        return json_error(StatusCode::BAD_REQUEST, "catchup_unavailable");
    }
    let cutoff = chrono::Utc::now() - chrono::TimeDelta::days(days.unwrap_or(7));
    if start < cutoff {
        return json_error(StatusCode::BAD_REQUEST, "beyond_archive_window");
    }
    if !s.streams.panel_up(&s.config).await {
        return source_unavailable();
    }
    let (sub, admin) = match caller(&claims) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let rid = format!("{id}|{start_utc}|{duration}");
    let session_id = format!("catchup:{id}:{start_utc}:{sub}:{}", now_ms());
    let acquired = s.streams.tracker.try_acquire(Acquire {
        sub: sub.clone(),
        session_id: session_id.clone(),
        kind: Kind::Catchup,
        resource_id: rid.clone(),
        ip: client_ip(&headers),
        title: session_title(&s, Kind::Catchup, &rid).await,
        kind_cap: None,
        replace_live: false,
    });
    if let Err(l) = acquired {
        return limit_429(&s, l, &sub, admin).await;
    }
    // A finite archive re-presents this token on every seek: playback TTL.
    let t = playlist::sign(
        &s.config.stream_token_secret,
        StreamKind::Catchup,
        &rid,
        &sub,
        s.config.iptv_ondemand_token_ttl_secs as i64,
        None,
    );
    axum::Json(json!({
        "url": format!(
            "/api/iptv/stream/catchup/{id}/{}/{duration}.ts?t={t}",
            encode_uri_component(&start_utc)
        ),
        "delivery": "mpegts",
        "sessionId": session_id,
    }))
    .into_response()
}

/// The VOD/series grant body: ext from container_extension.
fn on_demand_grant(
    s: &AppState,
    kind: StreamKind,
    id: &str,
    sub: &str,
    ext: Option<String>,
    session_id: String,
) -> Response {
    let ext = ext.unwrap_or_else(|| "mp4".into()).to_lowercase();
    let t = playlist::sign(
        &s.config.stream_token_secret,
        kind,
        id,
        sub,
        s.config.iptv_ondemand_token_ttl_secs as i64,
        None,
    );
    let hls = ext == "m3u8";
    axum::Json(json!({
        "url": format!("/api/iptv/stream/{}/{id}/{ext}?t={t}", kind.as_wire()),
        "delivery": if hls { "hls" } else { "progressive" },
        "mime": mime(&ext, hls),
        "sessionId": session_id,
    }))
    .into_response()
}

fn mime(ext: &str, hls: bool) -> &'static str {
    match (hls, ext) {
        (true, _) => "application/vnd.apple.mpegurl",
        (false, "mkv") => "video/x-matroska",
        _ => "video/mp4",
    }
}

async fn vod_grant(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !is_digits(&id) {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id");
    }
    let (sub, admin) = match caller(&claims) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let detail: Option<(String, Option<String>)> =
        match sqlx::query_as("SELECT name, container_extension FROM vod WHERE stream_id = ?")
            .bind(id.parse::<i64>().unwrap_or(-1))
            .fetch_optional(&s.pool)
            .await
        {
            Ok(d) => d,
            Err(e) => return internal(&e.to_string()),
        };
    let Some((name, ext)) = detail else {
        return json_error(StatusCode::NOT_FOUND, "not_found");
    };
    if !s.streams.panel_up(&s.config).await {
        return source_unavailable();
    }
    let session_id = format!("vod:{id}:{sub}:{}", now_ms());
    let acquired = s.streams.tracker.try_acquire(Acquire {
        sub: sub.clone(),
        session_id: session_id.clone(),
        kind: Kind::Vod,
        resource_id: id.clone(),
        ip: client_ip(&headers),
        title: Some(name),
        kind_cap: None,
        replace_live: false,
    });
    if let Err(l) = acquired {
        return limit_429(&s, l, &sub, admin).await;
    }
    on_demand_grant(&s, StreamKind::Vod, &id, &sub, ext, session_id)
}

async fn series_grant(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !is_word_id(&id) {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id");
    }
    let (sub, admin) = match caller(&claims) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let row: Option<(Option<String>,)> = match sqlx::query_as(
        "SELECT container_extension FROM series_episodes WHERE episode_id = ?",
    )
    .bind(&id)
    .fetch_optional(&s.pool)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal(&e.to_string()),
    };
    let Some((ext,)) = row else {
        return json_error(StatusCode::NOT_FOUND, "not_found");
    };
    if !s.streams.panel_up(&s.config).await {
        return source_unavailable();
    }
    let session_id = format!("series:{id}:{sub}:{}", now_ms());
    let acquired = s.streams.tracker.try_acquire(Acquire {
        sub: sub.clone(),
        session_id: session_id.clone(),
        kind: Kind::Series,
        resource_id: id.clone(),
        ip: client_ip(&headers),
        title: session_title(&s, Kind::Series, &id).await,
        kind_cap: None,
        replace_live: false,
    });
    if let Err(l) = acquired {
        return limit_429(&s, l, &sub, admin).await;
    }
    on_demand_grant(&s, StreamKind::Series, &id, &sub, ext, session_id)
}

// ---- byte routes -------------------------------------------------------------------

/// Raw live MPEG-TS for browsers and external players. Playlist URLs arrive
/// without a grant, so a missing reservation is taken here under the cap.
async fn live_ts(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Path(file): Path<String>,
    Query(q): Params,
) -> Response {
    let Some(id) = file.strip_suffix(".ts").filter(|i| !i.is_empty()) else {
        return json_error(StatusCode::NOT_FOUND, "not_found");
    };
    let (sub, _) = match check_token(
        &s,
        &claims,
        param(&q, "t").unwrap_or(""),
        StreamKind::Live,
        Some(id),
    ) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let streams = &s.streams;
    let tracker = &streams.tracker;
    let session_id = match tracker.find(&sub, Kind::Live, id) {
        Some(r) => r.session_id,
        None => {
            let sid = format!("live:{id}:{sub}:{}", uuid::Uuid::new_v4());
            let acquired = tracker.try_acquire(Acquire {
                sub: sub.clone(),
                session_id: sid.clone(),
                kind: Kind::Live,
                resource_id: id.into(),
                ip: client_ip(&headers),
                title: session_title(&s, Kind::Live, id).await,
                kind_cap: Some(live_kind_cap(&s.config)),
                replace_live: false,
            });
            if let Err(l) = acquired {
                return limit_429(&s, l, &sub, false).await;
            }
            sid
        }
    };
    tracker.heartbeat_by_resource(&sub, Kind::Live, id);
    // A feed check's capture never holds a slot a viewer needs.
    streams.live.remux.yield_aux("raw-live", AUX_YIELD).await;
    // A replaced remux child can still be draining its provider socket.
    let cap = s.config.iptv_max_upstream_connections as usize;
    let deadline = Instant::now() + DRAIN_WAIT;
    while streams.live_upstream_count() > cap && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if !tracker.has(&session_id) {
            return json_error(StatusCode::GONE, "session_gone");
        }
    }
    if streams.live_upstream_count() > cap {
        tracker.release(&session_id);
        return status_json(
            StatusCode::TOO_MANY_REQUESTS,
            json!({
                "ok": false,
                "reason": "iptv_concurrency_limit",
                "limit": cap,
                "current": streams.live_upstream_count(),
                "sessions": enrich(&s, tracker.list(), &sub, false).await,
            }),
        );
    }
    let creds = match creds(&s) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let candidates = match sibling_feeds(&s.pool, id).await {
        Ok(c) => c,
        Err(e) => return internal(&e.to_string()),
    };

    let lease = Arc::new(streams.begin_raw_live(&sub, id));
    let release = {
        let (lease, streams, session_id) = (lease.clone(), streams.clone(), session_id.clone());
        move || {
            if lease.dispose() {
                streams.tracker.release(&session_id);
            }
        }
    };
    let mut watch = Watch::default();
    watch.on_abort = Some(Box::new(release.clone()));
    watch.stop = Some(lease.stop.clone());
    // Walk self then siblings, skipping remembered placeholders; a down or
    // refused candidate falls through to the next.
    let mut dialed = None;
    for feed in candidates {
        if streams.dead.is_dead(&feed) {
            continue;
        }
        let target = match Url::parse(&format!(
            "{}/live/{}/{}/{feed}.ts",
            creds.host,
            encode_uri_component(&creds.username),
            encode_uri_component(&creds.password)
        )) {
            Ok(u) => u,
            Err(_) => return internal("xtream_bad_host"),
        };
        match fetch_guarded(&streams.http, target, None, false).await {
            Ok(res) if res.status().is_success() => {
                dialed = Some((feed, res));
                break;
            }
            Ok(_) => {}
            Err(e) if e.is_blocked() => {}
            Err(e) => return internal(&format!("{e:?}")),
        }
    }
    let Some((feed, upstream)) = dialed else {
        // Every candidate dead or down: off the air upstream (terminal).
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "channel_offline_upstream");
    };
    let dialed_at = Instant::now();
    watch.beat = Some(Box::new({
        let (lease, streams, sub, id, session_id) = (
            lease.clone(),
            streams.clone(),
            sub.clone(),
            id.to_string(),
            session_id.clone(),
        );
        move || {
            if !lease.is_current() || !streams.tracker.has(&session_id) {
                return false;
            }
            streams.tracker.heartbeat_by_resource(&sub, Kind::Live, &id);
            true
        }
    }));
    watch.on_eof = Some(Box::new({
        let (lease, streams) = (lease.clone(), streams.clone());
        move || {
            if !lease.is_current() {
                return;
            }
            if dialed_at.elapsed() <= DEAD_FEED_CLEAN_EOF {
                streams.dead.strike(&feed);
            }
            release();
        }
    }));
    let res = Response::new(watched_body(upstream, watch));
    with_headers(
        res,
        &[
            (header::CONTENT_TYPE, "video/mp2t"),
            (header::CACHE_CONTROL, "no-store, no-transform"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
    )
}

async fn catchup_ts(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Path((id, start_utc, file)): Path<(String, String, String)>,
    Query(q): Params,
) -> Response {
    if !is_digits(&id) {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id");
    }
    let Some(duration) = file.strip_suffix(".ts").and_then(positive_int) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid_params");
    };
    let Some(start) = js_date(&start_utc) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid_params");
    };
    let rid = format!("{id}|{start_utc}|{duration}");
    let (sub, _) = match check_token(
        &s,
        &claims,
        param(&q, "t").unwrap_or(""),
        StreamKind::Catchup,
        Some(&rid),
    ) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Some(r) = hold_slot(&s, &headers, &sub, Kind::Catchup, &rid).await {
        return r;
    }
    let creds = match creds(&s) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let target = match url(&format!(
        "{}/streaming/timeshift.php?username={}&password={}&stream={id}&start={}&duration={duration}",
        creds.host,
        encode_uri_component(&creds.username),
        encode_uri_component(&creds.password),
        start.format("%Y-%m-%d:%H-%M"),
    )) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let tracker_owner = s.streams.clone();
    let (beat_sub, beat_rid) = (sub.clone(), rid.clone());
    let mut watch = Watch::default();
    watch.beat = Some(Box::new({
        let streams = s.streams.clone();
        move || {
            streams
                .tracker
                .heartbeat_by_resource(&beat_sub, Kind::Catchup, &beat_rid);
            true
        }
    }));
    watch.on_abort = Some(Box::new(move || {
        tracker_owner
            .tracker
            .release_by_resource(&sub, Kind::Catchup, &rid);
    }));
    match fetch_guarded(&s.streams.http, target, None, false).await {
        Ok(res) if res.status().is_success() => with_headers(
            Response::new(watched_body(res, watch)),
            &[
                (header::CONTENT_TYPE, "video/mp2t"),
                (header::CACHE_CONTROL, "no-store"),
            ],
        ),
        Ok(res) => {
            watch.disarm();
            upstream_status(res.status())
        }
        Err(e) => {
            watch.disarm();
            if e.is_blocked() {
                json_error(StatusCode::BAD_REQUEST, "bad_upstream")
            } else {
                internal(&format!("{e:?}"))
            }
        }
    }
}

async fn vod_bytes(
    state: State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Path((id, ext)): Path<(String, String)>,
    q: Params,
) -> Response {
    on_demand_bytes(state, claims, headers, Kind::Vod, id, ext, q).await
}

async fn series_bytes(
    state: State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Path((id, ext)): Path<(String, String)>,
    q: Params,
) -> Response {
    on_demand_bytes(state, claims, headers, Kind::Series, id, ext, q).await
}

/// VOD/series bytes: an HLS playlist is rewritten (tagged with this grant so
/// segment fetches keep its slot), anything else is range-proxied.
async fn on_demand_bytes(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    kind: Kind,
    id: String,
    ext: String,
    Query(q): Params,
) -> Response {
    let ext = ext.to_lowercase();
    // Both land raw in the provider URL, so plain tokens only.
    let ext_ok = (1..=5).contains(&ext.len())
        && ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if !is_word_id(&id) || !ext_ok {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id");
    }
    let (token_kind, path, owner_kind) = match kind {
        Kind::Vod => (StreamKind::Vod, "movie", "vod"),
        _ => (StreamKind::Series, "series", "series"),
    };
    let (sub, _) = match check_token(
        &s,
        &claims,
        param(&q, "t").unwrap_or(""),
        token_kind,
        Some(&id),
    ) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Some(r) = hold_slot(&s, &headers, &sub, kind, &id).await {
        return r;
    }
    let creds = match creds(&s) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let upstream = format!(
        "{}/{path}/{}/{}/{id}.{ext}",
        creds.host,
        encode_uri_component(&creds.username),
        encode_uri_component(&creds.password)
    );
    if ext == "m3u8" {
        // The playlist is fetched once; its segment fetches carry the grant.
        let owner = Owner {
            kind: owner_kind,
            id: id.clone(),
        };
        return hls::fetch_and_rewrite(&rewrite(&s, &sub), &upstream, Some(&owner)).await;
    }
    let target = match url(&upstream) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let streams = s.streams.clone();
    let mut watch = Watch::default();
    watch.on_abort = Some(Box::new(move || {
        streams.tracker.release_by_resource(&sub, kind, &id);
    }));
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match fetch_guarded(&s.streams.http, target, range, false).await {
        Ok(res) if res.status().is_success() => {
            proxied(res, HeaderValue::from_static(mime(&ext, false)), watch)
        }
        Ok(res) => {
            watch.disarm();
            upstream_status(res.status())
        }
        Err(e) => {
            watch.disarm();
            if e.is_blocked() {
                json_error(StatusCode::BAD_REQUEST, "bad_upstream")
            } else {
                internal(&format!("{e:?}"))
            }
        }
    }
}

/// Starting window the first manifest response waits for.
const START_SEGMENTS: usize = 4;
/// Well inside the client's 25 s readiness watchdog; a cold HEVC probe (10M
/// analyzeduration) can push the first segment past 8 s.
const MANIFEST_WAIT: Duration = Duration::from_secs(15);

/// 503 for a missing session: terminal when every candidate feed is dead,
/// otherwise a transient warming retry (re-dialing here is the churn that
/// trips the provider's abuse block, so the throttle decides).
fn remux_unavailable(live: &LiveMap, candidates: &[String]) -> Response {
    if live.is_offline(candidates) {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "channel_offline_upstream");
    }
    with_headers(
        json_error(StatusCode::SERVICE_UNAVAILABLE, "remux_warming"),
        &[(header::RETRY_AFTER, "3")],
    )
}

/// Check that the stream behind this viewer's session carries the channel they
/// picked; if it carries another, switch them (feed_verify). Cheap per poll: a
/// session is only ever checked once.
fn start_feed_check(s: &AppState, creds: &Creds, e: &remux_map::Entry) {
    let (Ok(tuned), Ok(dialed)) = (e.stream_id.parse(), e.dialed_stream_id.parse()) else {
        return;
    };
    let streams = s.streams.clone();
    let io = Arc::new(LiveIo::new(
        streams.live.remux.clone(),
        streams.dead.clone(),
        creds,
    ));
    let r = LiveSessionRef {
        tuned,
        dialed,
        session_id: e.session_id.clone(),
        dir: e.dir.clone(),
        started_at_ms: chrono::Utc::now().timestamp_millis()
            - e.started_at.elapsed().as_millis() as i64,
    };
    let (st, stream_id, sub, sid) = (
        streams.clone(),
        e.stream_id.clone(),
        e.sub.clone(),
        e.session_id.clone(),
    );
    let is_active = Arc::new(move || {
        st.live
            .get_active(&stream_id, &sub)
            .is_some_and(|x| x.session_id == sid)
    });
    let (st, stream_id, sub, sid) = (
        streams.clone(),
        e.stream_id.clone(),
        e.sub.clone(),
        e.session_id.clone(),
    );
    streams
        .feed
        .schedule_live(io, s.pool.clone(), r, is_active, move |to| {
            st.live
                .redirect(&stream_id, &sub, &to.to_string(), &sid, Instant::now())
        });
}

/// The AVPlayer live playlist: ensure the viewer's remux session, wait for a
/// small starting window, and serve it rewritten to signed segment URLs.
async fn remux_manifest(
    State(s): State<AppState>,
    claims: Claims,
    Path(id): Path<String>,
    Query(q): Params,
) -> Response {
    if !is_digits(&id) {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id");
    }
    let token = param(&q, "t").unwrap_or("");
    let (sub, _) = match check_token(&s, &claims, token, StreamKind::Remux, Some(&id)) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let tracker = &s.streams.tracker;
    // Every poll keeps the grant's slot alive; a released slot never reopens.
    if !tracker.heartbeat_by_resource(&sub, Kind::Remux, &id) {
        return json_error(StatusCode::GONE, "session_gone");
    }
    let Some(reservation) = tracker.find(&sub, Kind::Remux, &id) else {
        return json_error(StatusCode::GONE, "session_gone");
    };
    let owns = || tracker.has(&reservation.session_id);
    let creds = match creds(&s) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let url_for = |sid: &str| {
        format!(
            "{}/live/{}/{}/{sid}.ts",
            creds.host,
            encode_uri_component(&creds.username),
            encode_uri_component(&creds.password)
        )
    };
    // Itself first, then siblings; dead placeholders are skipped.
    let candidates = match sibling_feeds(&s.pool, &id).await {
        Ok(c) => c,
        Err(e) => return internal(&e.to_string()),
    };
    let opts = EnsureOpts {
        stream_id: &id,
        sub: &sub,
        feeds: &candidates,
        url_for: &url_for,
    };
    let live = &s.streams.live;
    // About to dial for a viewer: a feed check's capture gives up its slot first.
    if live.get_active(&id, &sub).is_none() {
        live.remux.yield_aux("remux", AUX_YIELD).await;
    }
    // The viewer's other channels were freed at grant time, not here: on this
    // hot path two overlapping sessions of one sub would kill each other.
    let mut entry = match live.ensure(&opts, Instant::now()) {
        Ok(Some(e)) => e,
        Ok(None) => return remux_unavailable(live, &candidates),
        Err(e) => return internal(&e),
    };
    live.remux.heartbeat(&entry.session_id);
    if s.config.iptv_feed_check {
        start_feed_check(&s, &creds, &entry);
    }
    let deadline = Instant::now() + MANIFEST_WAIT;
    while !remux_map::manifest_ready(&entry.manifest_path, START_SEGMENTS)
        && Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if !owns() {
            return json_error(StatusCode::GONE, "session_gone");
        }
        // A copy session that found non-H.264 input kills itself; re-ensure so
        // it respawns as a re-encode within this request. None = cooldown.
        match live.ensure(&opts, Instant::now()) {
            Ok(Some(e)) => entry = e,
            Ok(None) => break,
            Err(e) => return internal(&e),
        }
        live.remux.heartbeat(&entry.session_id);
    }
    // A slow channel serves what it has; only a missing manifest is a retry,
    // and the session is left running (forgetting it feeds respawn churn).
    let text = match tokio::fs::read_to_string(&entry.manifest_path).await {
        Ok(t) => t,
        Err(_) => return remux_unavailable(live, &candidates),
    };
    if !owns() {
        return json_error(StatusCode::GONE, "session_gone");
    }
    // The wait may have outlived the token.
    if let Err(r) = check_token(&s, &claims, token, StreamKind::Remux, Some(&id)) {
        return r;
    }
    let body = live.rewrite(&text, &id, &entry.session_id, &sub);
    with_headers(
        Response::new(Body::from(body)),
        &[
            (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
            (header::CACHE_CONTROL, "no-store"),
        ],
    )
}

/// One remux segment, bound by its token to a session of this viewer.
async fn remux_seg(
    State(s): State<AppState>,
    claims: Claims,
    Path(id): Path<String>,
    Query(q): Params,
) -> Response {
    if !is_digits(&id) {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id");
    }
    let (sub, rid) = match check_token(
        &s,
        &claims,
        param(&q, "t").unwrap_or(""),
        StreamKind::Remux,
        None,
    ) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some((session_id, seg)) = remux_map::segment_resource(&rid) else {
        return json_error(StatusCode::BAD_REQUEST, "bad_resource");
    };
    if !s
        .streams
        .tracker
        .heartbeat_by_resource(&sub, Kind::Remux, &id)
    {
        return json_error(StatusCode::GONE, "session_gone");
    }
    let live = &s.streams.live;
    let Some(entry) = live
        .get_active(&id, &sub)
        .filter(|e| e.session_id == session_id)
    else {
        return json_error(StatusCode::GONE, "session_gone");
    };
    let Ok(file) = tokio::fs::File::open(entry.dir.join(seg)).await else {
        return json_error(StatusCode::NOT_FOUND, "segment_gone");
    };
    live.remux.heartbeat(&entry.session_id);
    with_headers(
        Response::new(Body::from_stream(tokio_util::io::ReaderStream::new(file))),
        &[
            (header::CONTENT_TYPE, "video/mp2t"),
            (header::CACHE_CONTROL, "no-store"),
        ],
    )
}

fn rewrite<'a>(s: &'a AppState, sub: &'a str) -> Rewrite<'a> {
    Rewrite {
        http: &s.streams.http,
        secret: &s.config.stream_token_secret,
        sub,
        // Segment URLs are fetched for the whole runtime: playback TTL.
        ttl: s.config.iptv_ondemand_token_ttl_secs as i64,
        timeout: Duration::from_millis(s.config.iptv_manifest_fetch_timeout_ms),
        max_bytes: s.config.iptv_manifest_max_bytes,
    }
}

/// A signed on-demand HLS segment or sub-playlist. The rid comes from
/// provider-controlled manifest lines, so every hop must be public.
async fn segment(
    State(s): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    Query(q): Params,
) -> Response {
    let c = match playlist::verify(&s.config.stream_token_secret, param(&q, "u").unwrap_or("")) {
        Ok(c) if c.k == StreamKind::Segment => c,
        Ok(_) => {
            return unauthorized(json!({ "error": "invalid_token", "detail": "kind_mismatch" }));
        }
        Err(d) => return unauthorized(json!({ "error": "invalid_token", "detail": d })),
    };
    let sub = match member_sub(&claims, &c.sub) {
        Ok(sub) => sub,
        Err(r) => return r,
    };
    // For HLS VOD/series this route IS the playback: keep the grant's slot.
    let owner = hls::parse_owner(param(&q, "ok"), param(&q, "oid"));
    if let Some(o) = &owner {
        let kind = if o.kind == "vod" {
            Kind::Vod
        } else {
            Kind::Series
        };
        if let Some(r) = hold_slot(&s, &headers, &sub, kind, &o.id).await {
            return r;
        }
    }
    let target = match url(&c.rid) {
        Ok(u) => u,
        Err(r) => return r,
    };
    if target.path().to_lowercase().ends_with(".m3u8") {
        return hls::fetch_and_rewrite(&rewrite(&s, &sub), &c.rid, owner.as_ref()).await;
    }
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match fetch_guarded(&s.streams.http, target, range, true).await {
        Ok(res) if res.status().is_success() => {
            let ct = res
                .headers()
                .get(header::CONTENT_TYPE)
                .cloned()
                .unwrap_or(HeaderValue::from_static("application/octet-stream"));
            proxied(res, ct, Watch::default())
        }
        Ok(res) => upstream_status(res.status()),
        Err(e) if e.is_blocked() => json_error(StatusCode::BAD_REQUEST, "bad_upstream"),
        Err(e) => internal(&format!("{e:?}")),
    }
}

#[cfg(test)]
mod tests;
