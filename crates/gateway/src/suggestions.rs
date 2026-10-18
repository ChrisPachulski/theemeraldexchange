//! GET /api/suggestions/:type (routes/suggestions.ts and the
//! services/suggestions*.ts it dispatches to): the Movies/TV suggestion strip.
//!
//! Every request snapshots the household (the Sonarr/Radarr library, the
//! rejections, the caller's likes), builds the household-safety filters, then
//! serves one of: an explicit `?force=trending`; the local recommender
//! (USE_LOCAL_RECOMMENDER=1, free); or the BYO-key Claude pipeline (the
//! caller's stored Anthropic key ranks a TMDB candidate pool, a validator
//! checks every pick, one retry with the rejections, then a discover/trending
//! fill). Items are TrendingItem-shaped, tagged with where they can already be
//! watched (`available_on`), and every response carries a `_diag` and a
//! Server-Timing header.
//!
//! A GET with side effects (recently-shown rotation, recommender
//! impressions), so it sits behind the trusted-Origin gate.

pub mod availability;
pub mod prompt;
pub mod tmdb;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::hash::Hash;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use futures_util::stream::{self, StreamExt};
use indexmap::IndexMap;
use rand::seq::SliceRandom;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::app::js_number;
use crate::jsonl::JsonlLog;
use crate::recommender::{Caller, Impression};
use crate::routes::{err, js_number as js_value_number, truthy};
use crate::stores::{IdTitle, Kind};
use crate::upstream::{Arr, LAN_TIMEOUT};
use crate::usage;
use prompt::{Blocks, CLAUDE_OVERFETCH, ClaudeResponse, Pick, Usage};

/// Cards per response.
pub const TARGET_COUNT: usize = 20;
/// Below this the genre mix is noise: trending instead of a paid call.
const COLD_START_THRESHOLD: usize = 10;
/// Recently-shown entries per (user, kind), and users remembered.
const RECENTLY_SHOWN_CAP: usize = 150;
const RECENTLY_SHOWN_MAX_KEYS: usize = 200;
/// The sidecar's `n` ceiling (Field(le=50)); clears the ~55% movie attrition.
const RECOMMENDER_OVERFETCH: usize = 50;
const LIBRARY_TTL: Duration = Duration::from_secs(30);
const LIBRARY_FAILURE_TTL: Duration = Duration::from_secs(15);

/// One card. `poster_path`, `overview`, `provenance` and `reason` keep the
/// source's shape: None is left out, Some(Null) is null.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Item {
    pub id: i64,
    pub title: String,
    #[serde(rename = "posterPath", skip_serializing_if = "Option::is_none")]
    pub poster_path: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_on: Option<Vec<String>>,
}

impl Item {
    fn fill(mut self, provenance: &str) -> Item {
        self.provenance = Some(provenance.into());
        self.reason = Some(Value::Null);
        self
    }
}

/// A Sonarr series or Radarr movie, as far as suggestions read it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LibItem {
    pub title: Option<String>,
    pub year: Option<f64>,
    pub tmdb_id: Option<i64>,
    pub genres: Vec<String>,
}

impl LibItem {
    pub fn from_value(v: &Value) -> LibItem {
        LibItem {
            title: v.get("title").and_then(Value::as_str).map(String::from),
            year: v.get("year").and_then(Value::as_f64),
            tmdb_id: v.get("tmdbId").and_then(Value::as_i64),
            genres: v
                .get("genres")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    fn title(&self) -> &str {
        self.title.as_deref().unwrap_or_default()
    }
}

/// Genre tag counts, most frequent first (ties in first-seen order).
pub fn genre_counts(library: &[LibItem]) -> Vec<(String, usize)> {
    let mut counts: IndexMap<&str, usize> = IndexMap::new();
    for it in library {
        for g in it.genres.iter().filter(|g| !g.is_empty()) {
            *counts.entry(g).or_default() += 1;
        }
    }
    let mut out: Vec<(String, usize)> = counts
        .into_iter()
        .map(|(g, n)| (g.to_string(), n))
        .collect();
    out.sort_by_key(|g| std::cmp::Reverse(g.1));
    out
}

// --- title matching --------------------------------------------------------------------

/// Lowercase, drop a leading article, keep only a-z0-9: Sonarr/Radarr and
/// TMDB disagree on punctuation and articles.
pub fn normalize_title(t: &str) -> String {
    let lower = t.to_lowercase();
    let mut rest = lower.as_str();
    for article in ["the", "a", "an"] {
        if let Some(after) = rest.strip_prefix(article)
            && after.starts_with(auth::js_space)
        {
            rest = after.trim_start_matches(auth::js_space);
            break;
        }
    }
    rest.chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// The normalized part before the first subtitle separator (`:`, em/en dash,
/// ` - `), or "" when there is none or it is under 5 characters ("It",
/// "Up" would collide with everything).
pub fn normalize_title_base(t: &str) -> String {
    let chars: Vec<(usize, char)> = t.char_indices().collect();
    let cut = chars.iter().enumerate().find_map(|(n, (i, c))| {
        let dash = auth::js_space(*c)
            && chars.get(n + 1).is_some_and(|(_, d)| *d == '-')
            && chars.get(n + 2).is_some_and(|(_, s)| auth::js_space(*s));
        (matches!(c, ':' | '\u{2014}' | '\u{2013}') || dash).then_some(*i)
    });
    let Some(cut) = cut else {
        return String::new();
    };
    let normalized = normalize_title(&t[..cut]);
    if cut == 0 || normalized.len() < 5 {
        return String::new();
    }
    normalized
}

/// Full normalized titles, plus the base form when `include_base` (the
/// library: another cut of an owned title is a dupe; never for rejections,
/// where one franchise entry must not ban the franchise).
pub fn title_set<'a>(
    titles: impl IntoIterator<Item = &'a str>,
    include_base: bool,
) -> HashSet<String> {
    let mut out = HashSet::new();
    for t in titles.into_iter().filter(|t| !t.is_empty()) {
        out.insert(normalize_title(t));
        if include_base {
            let base = normalize_title_base(t);
            if !base.is_empty() {
                out.insert(base);
            }
        }
    }
    out
}

/// The pick's full or base form is in the set.
pub fn title_matches(pick: &str, set: &HashSet<String>) -> bool {
    if set.is_empty() {
        return false;
    }
    if set.contains(&normalize_title(pick)) {
        return true;
    }
    let base = normalize_title_base(pick);
    !base.is_empty() && set.contains(&base)
}

/// Results in input order, at most `limit` running at once.
pub async fn map_limit<T, R, F: Future<Output = R>>(
    items: Vec<T>,
    limit: usize,
    f: impl FnMut((usize, T)) -> F,
) -> Vec<R> {
    stream::iter(items.into_iter().enumerate())
        .map(f)
        .buffered(limit.max(1))
        .collect()
        .await
}

/// One spawned call per key; concurrent callers await the same result.
pub struct SingleFlight<K, V> {
    flights: std::sync::Mutex<HashMap<K, Shared<BoxFuture<'static, V>>>>,
}

impl<K, V> Default for SingleFlight<K, V> {
    fn default() -> Self {
        SingleFlight {
            flights: Default::default(),
        }
    }
}

impl<K, V> SingleFlight<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone + Send + Sync + 'static,
{
    pub async fn run<Fut>(&self, key: K, make: impl FnOnce() -> Fut) -> V
    where
        Fut: Future<Output = V> + Send + 'static,
    {
        let flight = self
            .flights
            .lock()
            .unwrap()
            .entry(key.clone())
            .or_insert_with(|| {
                // Spawned: a hung-up caller never cancels a shared call.
                let task = tokio::spawn(make());
                async move { task.await.expect("single-flight task panicked") }
                    .boxed()
                    .shared()
            })
            .clone();
        let v = flight.clone().await;
        let mut flights = self.flights.lock().unwrap();
        if flights.get(&key).is_some_and(|f| f.ptr_eq(&flight)) {
            flights.remove(&key);
        }
        v
    }
}

// --- process state ---------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct Timings {
    /// Each Claude attempt's deadline (20 s).
    pub claude_timeout: Duration,
    /// The wait before the one 529/503 retry (3 s).
    pub anthropic_retry_delay: Duration,
    /// How old a last-good library may be and still stand in (24 h).
    pub library_stale_max_age: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            claude_timeout: Duration::from_millis(prompt::CLAUDE_TIMEOUT_MS),
            anthropic_retry_delay: prompt::ANTHROPIC_RETRY_DELAY,
            library_stale_max_age: Duration::from_secs(24 * 3600),
        }
    }
}

type Library = Arc<Vec<LibItem>>;

#[derive(Default)]
struct LibraryCache {
    fresh: HashMap<Kind, (Library, Instant)>,
    /// The last good fetch: filters through a brief upstream outage.
    stale: HashMap<Kind, (Library, Instant)>,
}

/// One per process: library and TMDB caches, recently-shown rotation and
/// the media.db handle.
#[derive(Default)]
pub struct Suggestions {
    pub timings: Timings,
    library: std::sync::Mutex<LibraryCache>,
    library_flight: SingleFlight<Kind, Result<Library, ()>>,
    pub tmdb: tmdb::Tmdb,
    recently_shown: std::sync::Mutex<IndexMap<String, Vec<IdTitle>>>,
    pub media_db: availability::MediaDb,
}

impl Suggestions {
    pub fn new(timings: Timings) -> Suggestions {
        Suggestions {
            timings,
            ..Suggestions::default()
        }
    }

    /// The last good snapshot's age.
    fn snapshot_age(&self, kind: Kind) -> Option<Duration> {
        self.library
            .lock()
            .unwrap()
            .stale
            .get(&kind)
            .map(|(_, at)| at.elapsed())
    }

    /// Recently shown to `sub`, newest first; reading marks the user as
    /// recently used.
    fn recently_shown(&self, sub: &str, kind: Kind) -> Vec<IdTitle> {
        let key = format!("{sub}:{}", kind.as_str());
        let mut m = self.recently_shown.lock().unwrap();
        match m.shift_remove(&key) {
            Some(items) => {
                m.insert(key, items.clone());
                items
            }
            None => vec![],
        }
    }

    /// Titled items go to the front (deduped by id), older ones fill to 150.
    fn record_shown(&self, sub: &str, kind: Kind, items: &[Item]) {
        let key = format!("{sub}:{}", kind.as_str());
        let mut m = self.recently_shown.lock().unwrap();
        let prev = m.get(&key).cloned().unwrap_or_default();
        let mut seen = HashSet::new();
        let mut merged: Vec<IdTitle> = vec![];
        for it in items.iter().filter(|it| !it.title.is_empty()) {
            if let Ok(id) = u64::try_from(it.id)
                && seen.insert(id)
            {
                merged.push(IdTitle {
                    id,
                    title: it.title.clone(),
                });
            }
        }
        for it in prev {
            if merged.len() >= RECENTLY_SHOWN_CAP {
                break;
            }
            if seen.insert(it.id) {
                merged.push(it);
            }
        }
        merged.truncate(RECENTLY_SHOWN_CAP);
        m.insert(key, merged);
        while m.len() > RECENTLY_SHOWN_MAX_KEYS {
            m.shift_remove_index(0);
        }
    }

    /// Test hook: the TS `_resetLibraryCacheForTests` (the TTL entry only).
    #[cfg(test)]
    pub(crate) fn drop_library_ttl(&self) {
        self.library.lock().unwrap().fresh.clear();
    }
}

// --- the library -----------------------------------------------------------------------

async fn fetch_library(st: &AppState, kind: Kind) -> Result<Vec<LibItem>, String> {
    let (svc, path, name) = match kind {
        Kind::Movie => (Arr::Radarr, "/api/v3/movie", "Radarr"),
        Kind::Tv => (Arr::Sonarr, "/api/v3/series", "Sonarr"),
    };
    let reply = st
        .upstream
        .arr_fetch(&st.config, svc, Method::GET, path, &[], None, LAN_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    if !reply.is_success() {
        let body = String::from_utf8_lossy(&reply.body);
        return Err(format!(
            "{name} {path} returned {}: {}",
            reply.status.as_u16(),
            auth::js_slice(&body, 200)
        ));
    }
    match serde_json::from_slice(&reply.body).map_err(|e| e.to_string())? {
        Value::Array(rows) => Ok(rows.iter().map(LibItem::from_value).collect()),
        _ => Err(format!("{name} {path} returned a non-array body")),
    }
}

/// The library, cached 30 s and fetched once for concurrent callers. A failed
/// fetch serves the last good snapshot (cached 15 s) while it is under a day
/// old; otherwise the library is unavailable (a 502: an empty library would
/// leak owned titles back into trending).
async fn library(st: &AppState, kind: Kind) -> Result<Library, ()> {
    let s = &st.suggestions;
    if let Some((items, exp)) = s.library.lock().unwrap().fresh.get(&kind)
        && *exp > Instant::now()
    {
        return Ok(items.clone());
    }
    let st2 = st.clone();
    s.library_flight
        .run(
            kind,
            move || async move { refresh_library(&st2, kind).await },
        )
        .await
}

async fn refresh_library(st: &AppState, kind: Kind) -> Result<Library, ()> {
    let s = &st.suggestions;
    let fetched = fetch_library(st, kind).await;
    let mut cache = s.library.lock().unwrap();
    let k = kind.as_str();
    match fetched {
        Ok(items) => {
            let items = Arc::new(items);
            let now = Instant::now();
            cache.fresh.insert(kind, (items.clone(), now + LIBRARY_TTL));
            cache.stale.insert(kind, (items.clone(), now));
            Ok(items)
        }
        Err(e) => {
            let Some((items, at)) = cache.stale.get(&kind).cloned() else {
                tracing::error!(event = "suggestions", error = %e, "{k} library fetch failed and no stale snapshot \u{2014} failing closed");
                return Err(());
            };
            let age = at.elapsed();
            let age_hours = (age.as_secs_f64() / 3600.0).round();
            if age > s.timings.library_stale_max_age {
                tracing::error!(event = "suggestions", age_hours, error = %e, "{k} library fetch failed and stale snapshot is expired \u{2014} failing closed");
                return Err(());
            }
            tracing::warn!(event = "suggestions", items = items.len(), age_hours, error = %e, "{k} library fetch failed, serving stale snapshot");
            cache
                .fresh
                .insert(kind, (items.clone(), Instant::now() + LIBRARY_FAILURE_TTL));
            Ok(items)
        }
    }
}

// --- the route -------------------------------------------------------------------------

pub fn router(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/api/suggestions/{kind}", get(suggestions))
        .route_layer(axum::middleware::from_fn_with_state(
            state.auth.config.clone(),
            auth::csrf::require_trusted_origin,
        ))
}

/// Server-Timing phases (RFC 8673), so DevTools shows the breakdown.
#[derive(Default)]
struct Timing(Vec<(&'static str, f64)>);

impl Timing {
    fn end(&mut self, name: &'static str, start: Instant) {
        self.0.push((name, start.elapsed().as_secs_f64() * 1000.0));
    }

    fn header(&self) -> Option<HeaderValue> {
        let h = self
            .0
            .iter()
            .map(|(n, ms)| format!("{n};dur={ms:.1}"))
            .collect::<Vec<_>>()
            .join(", ");
        HeaderValue::from_str(&h).ok().filter(|_| !h.is_empty())
    }
}

fn num(n: f64) -> Value {
    Value::Number(js_number(n))
}

/// Math.round(x * 100) / 100.
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Everything the path runners share, captured once per request.
struct Ctx<'a> {
    st: &'a AppState,
    p: &'a auth::Principal,
    caller: Caller,
    kind: Kind,
    library: Library,
    kind_rejections: Vec<IdTitle>,
    rejected_ids: HashSet<i64>,
    library_ids: HashSet<i64>,
    rejected_titles: HashSet<String>,
    library_titles: HashSet<String>,
    library_titles_full: HashSet<String>,
    library_genres: Vec<String>,
    snapshot_age: Option<Duration>,
    timing: Timing,
}

impl Ctx<'_> {
    fn sub(&self) -> &str {
        &self.p.session.sub
    }

    /// Every trending/Claude return path: not rejected or owned, by id or by
    /// title (the library also by base form: entries without a tmdbId and
    /// subtitle disagreements slip past ids).
    fn household_safe(&self, items: Vec<Item>) -> Vec<Item> {
        items
            .into_iter()
            .filter(|i| {
                !self.rejected_ids.contains(&i.id)
                    && !self.library_ids.contains(&i.id)
                    && !title_matches(&i.title, &self.rejected_titles)
                    && !title_matches(&i.title, &self.library_titles)
            })
            .collect()
    }

    /// The recommender already excludes the household by id; its picks are
    /// matched by id and FULL title only, since a base form would let one
    /// owned "Batman: X" ban every other Batman film.
    fn recommender_safe(&self, items: Vec<Item>) -> Vec<Item> {
        items
            .into_iter()
            .filter(|i| {
                let full = normalize_title(&i.title);
                !self.rejected_ids.contains(&i.id)
                    && !self.library_ids.contains(&i.id)
                    && !self.rejected_titles.contains(&full)
                    && !self.library_titles_full.contains(&full)
            })
            .collect()
    }

    fn diag(&self, extra: Value) -> Value {
        let mut d = Map::new();
        d.insert("libraryCount".into(), self.library.len().into());
        d.insert("rejectionCount".into(), self.kind_rejections.len().into());
        if !self.library_genres.is_empty() {
            d.insert("libraryGenres".into(), json!(self.library_genres));
        }
        if let Some(age) = self.snapshot_age {
            let hours: f64 = format!("{:.2}", age.as_secs_f64() * 1000.0 / 3_600_000.0)
                .parse()
                .unwrap_or_default();
            d.insert("librarySnapshotAgeHours".into(), num(hours));
        }
        if let Value::Object(extra) = extra {
            d.extend(extra);
        }
        Value::Object(d)
    }

    /// Household-safe trending, tagged as a fill.
    async fn trending(&self) -> Vec<Item> {
        let items = tmdb::trending(self.st, self.kind).await;
        self.household_safe(items)
            .into_iter()
            .map(|i| i.fill("trending"))
            .collect()
    }

    async fn tag_iptv(&self, items: Vec<Item>) -> Vec<Item> {
        availability::tag_iptv(self.st, items, self.sub()).await
    }

    fn reply(&self, status: StatusCode, body: Value, timing: bool) -> Response {
        let mut res = (status, axum::Json(body)).into_response();
        if timing && let Some(h) = self.timing.header() {
            res.headers_mut().insert("server-timing", h);
        }
        res
    }

    fn ok(&self, source: &str, items: Vec<Item>, diag: Value) -> Response {
        let body = json!({ "source": source, "items": items, "_diag": diag });
        self.reply(StatusCode::OK, body, true)
    }
}

async fn suggestions(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    Path(kind): Path<String>,
    Query(q): Query<Vec<(String, String)>>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    let Some(kind) = Kind::parse(&kind) else {
        return Ok(err(StatusCode::BAD_REQUEST, "invalid_type"));
    };
    let force_trending = q
        .iter()
        .find(|(k, _)| k == "force")
        .is_some_and(|(_, v)| v == "trending");

    let mut timing = Timing::default();
    let start = Instant::now();
    let (library, rejections) = tokio::join!(library(&st, kind), st.stores.rejections.get());
    timing.end("prologue", start);
    let Ok(library) = library else {
        let mut res = (
            StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": "library_unavailable", "kind": kind })),
        )
            .into_response();
        if let Some(h) = timing.header() {
            res.headers_mut().insert("server-timing", h);
        }
        return Ok(res);
    };
    let kind_rejections = rejections
        .map_err(IntoResponse::into_response)?
        .kind(kind)
        .clone();

    let titles = || library.iter().map(LibItem::title);
    let mut ctx = Ctx {
        st: &st,
        p: &p,
        caller: Caller::new(&p, &headers),
        kind,
        rejected_ids: kind_rejections
            .iter()
            .filter_map(|r| i64::try_from(r.id).ok())
            .collect(),
        library_ids: library.iter().filter_map(|l| l.tmdb_id).collect(),
        rejected_titles: title_set(kind_rejections.iter().map(|r| r.title.as_str()), false),
        library_titles: title_set(titles(), true),
        library_titles_full: title_set(titles(), false),
        library_genres: prompt::compute_genre_distribution(&library, 5),
        snapshot_age: st.suggestions.snapshot_age(kind),
        kind_rejections,
        library: library.clone(),
        timing,
    };

    // An explicit Trending choice, honoured in every mode (it needs TMDB).
    if force_trending && tmdb::configured(&st) {
        let start = Instant::now();
        let items = ctx.trending().await;
        ctx.timing.end("trending", start);
        let items = ctx
            .tag_iptv(items.into_iter().take(TARGET_COUNT).collect())
            .await;
        return Ok(ctx.ok("trending", items, ctx.diag(json!({}))));
    }
    if st.config.use_local_recommender {
        return recommender_path(ctx).await;
    }
    claude_path(ctx).await
}

// --- the local recommender path --------------------------------------------------------

#[derive(serde::Deserialize)]
struct Scored {
    items: Vec<Value>,
    model_version: Option<Value>,
    recipe: Option<Value>,
    diag: Option<Value>,
}

/// The sidecar ranks for free. Its own cold-start recipe handles small
/// libraries, so no server-side cold start here. Real picks only: a short
/// list is shown as is; an empty one falls back to trending.
async fn recommender_path(mut ctx: Ctx<'_>) -> Result<Response, Response> {
    let st = ctx.st;
    let feedback = st
        .stores
        .feedback
        .user(ctx.sub())
        .await
        .map_err(IntoResponse::into_response)?;
    let lists = feedback.kind(ctx.kind);
    let source = match ctx.kind {
        Kind::Movie => "radarr",
        Kind::Tv => "sonarr",
    };
    // tmdb_id>0-or-omitted everywhere: one 0 (Sonarr keys on tvdbId) would
    // 422 the whole batch.
    let library: Vec<Value> = ctx
        .library
        .iter()
        .filter(|it| it.tmdb_id.is_some_and(|id| id > 0) || !it.title().is_empty())
        .map(|it| {
            let mut m = Map::new();
            if let Some(id) = it.tmdb_id.filter(|id| *id > 0) {
                m.insert("tmdb_id".into(), id.into());
            }
            if let Some(t) = &it.title {
                m.insert("title".into(), t.clone().into());
            }
            m.insert("source".into(), source.into());
            Value::Object(m)
        })
        .collect();
    let feedback: Vec<Value> = lists
        .liked
        .iter()
        .map(|e| (e.id, "like"))
        .chain(lists.disliked.iter().map(|e| (e.id, "dislike")))
        .filter(|(id, _)| *id > 0)
        .map(|(id, signal)| json!({ "tmdb_id": id, "signal": signal }))
        .collect();
    let req = json!({
        "sub": ctx.sub(),
        "kind": ctx.kind,
        "n": RECOMMENDER_OVERFETCH,
        "exclude_recently_shown": true,
        "library": library,
        "feedback": feedback,
        "household_rejections": ctx.kind_rejections.iter().map(|r| r.id).filter(|id| *id > 0).collect::<Vec<_>>(),
    });

    let start = Instant::now();
    let scored = crate::recommender::score_once::<Scored>(st, &req, Some(&ctx.caller)).await;
    ctx.timing.end("recommender", start);
    let (rec_items, model_version, recipe, rec_diag, succeeded) = match scored {
        Ok(s) => (s.items, s.model_version, s.recipe, s.diag, true),
        Err(e) => {
            tracing::warn!(event = "suggestions", detail = %e.message, "recommender call failed, falling back to trending");
            sentry::with_scope(
                |scope| scope.set_extra("error", e.message.clone().into()),
                || {
                    sentry::capture_message(
                        "recommender scoreOnce failed; served trending fallback",
                        sentry::Level::Warning,
                    )
                },
            );
            (
                vec![],
                Some("unknown".into()),
                Some("unknown".into()),
                Some(json!({})),
                false,
            )
        }
    };
    let rec_diag_fields = |path: Option<&str>| {
        let mut m = Map::new();
        if let Some(path) = path {
            m.insert("path".into(), path.into());
        }
        for (k, v) in [
            ("modelVersion", &model_version),
            ("recipe", &recipe),
            ("rec", &rec_diag),
        ] {
            if let Some(v) = v {
                m.insert(k.into(), v.clone());
            }
        }
        m
    };

    let mapped: Vec<Item> = rec_items
        .iter()
        .filter_map(|r| {
            Some(Item {
                id: r.get("tmdb_id")?.as_i64()?,
                title: match r.get("title") {
                    None | Some(Value::Null) => "?".into(),
                    Some(t) => crate::tmdb::js_string(t),
                },
                poster_path: r.get("poster_path").cloned(),
                overview: r.get("overview").filter(|v| !v.is_null()).cloned(),
                year: r.get("year").and_then(Value::as_i64),
                provenance: r.get("provenance").cloned(),
                reason: r.get("reason").cloned(),
                available_on: None,
            })
        })
        .collect();
    let safe = ctx.recommender_safe(mapped);

    if safe.is_empty() {
        if !tmdb::configured(st) {
            let diag = ctx.diag(Value::Object(rec_diag_fields(Some(
                "recommender_empty_no_tmdb_fallback",
            ))));
            return Ok(ctx.ok("recommender", vec![], diag));
        }
        let shown: Vec<Item> = ctx
            .trending()
            .await
            .into_iter()
            .take(TARGET_COUNT)
            .collect();
        // Mark the fallback shown so the next refresh rotates; pointless
        // when /score itself just failed.
        if !shown.is_empty() && succeeded {
            let ids: Vec<u64> = shown
                .iter()
                .filter_map(|i| u64::try_from(i.id).ok())
                .collect();
            crate::recommender::post_shown(st, ctx.sub(), ctx.kind, &ids, Some(&ctx.caller));
        }
        let diag = ctx.diag(Value::Object(rec_diag_fields(Some(
            "recommender_fallback_trending",
        ))));
        let items = ctx.tag_iptv(shown).await;
        return Ok(ctx.ok("trending", items, diag));
    }

    let recommender_returned = safe.len();
    let items: Vec<Item> = safe.into_iter().take(TARGET_COUNT).collect();
    let by_id: HashMap<i64, &Value> = rec_items
        .iter()
        .filter_map(|r| Some((r.get("tmdb_id")?.as_i64()?, r)))
        .collect();
    let mv = model_version.clone().unwrap_or(Value::Null);
    let impressions: Vec<Impression> = items
        .iter()
        .enumerate()
        .filter_map(|(rank, it)| {
            let r = by_id.get(&it.id)?;
            Some(Impression {
                tmdb_id: u64::try_from(it.id).ok()?,
                rank: rank as u32,
                score: r.get("score").and_then(Value::as_f64).unwrap_or_default(),
                provenance: crate::tmdb::js_string(r.get("provenance").unwrap_or(&Value::Null)),
                model_version: crate::tmdb::js_string(&mv),
            })
        })
        .collect();
    crate::recommender::post_impressions(st, ctx.sub(), ctx.kind, &impressions, Some(&ctx.caller));

    let mut extra = rec_diag_fields(None);
    extra.insert("costCents".into(), 0.into());
    extra.insert("recommenderReturned".into(), recommender_returned.into());
    extra.insert("fillCount".into(), 0.into());
    let diag = ctx.diag(Value::Object(extra));
    let items = ctx.tag_iptv(items).await;
    let items = availability::tag_local(st, items, ctx.kind).await;
    Ok(ctx.ok("recommender", items, diag))
}

// --- the Claude path -------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    pub lookup_nulls: u32,
    pub dropped_as_dedupe: u32,
    pub dropped_as_rejected: u32,
    pub dropped_as_library: u32,
    pub dropped_as_year_mismatch: u32,
    pub pool_hits: u32,
}

impl Counters {
    fn add(self, b: Counters) -> Counters {
        Counters {
            lookup_nulls: self.lookup_nulls + b.lookup_nulls,
            dropped_as_dedupe: self.dropped_as_dedupe + b.dropped_as_dedupe,
            dropped_as_rejected: self.dropped_as_rejected + b.dropped_as_rejected,
            dropped_as_library: self.dropped_as_library + b.dropped_as_library,
            dropped_as_year_mismatch: self.dropped_as_year_mismatch + b.dropped_as_year_mismatch,
            pool_hits: self.pool_hits + b.pool_hits,
        }
    }

    fn dropped(&self) -> u32 {
        self.dropped_as_library
            + self.dropped_as_rejected
            + self.lookup_nulls
            + self.dropped_as_year_mismatch
            + self.dropped_as_dedupe
    }
}

pub struct Validated {
    pub accepted: Vec<Item>,
    /// (title, why), fed back to Claude on the retry.
    pub rejected: Vec<(String, String)>,
    pub counters: Counters,
}

/// The pick's trimmed reason, at most 120 UTF-16 units, or null.
fn reason_of(p: &Pick) -> Value {
    match p.reason.as_str().map(auth::js_trim) {
        Some(r) if !r.is_empty() => auth::js_slice(r, 120).into(),
        _ => Value::Null,
    }
}

/// Title checks first (no TMDB spend on a library or rejected title), then
/// the pool fast path (the id is known), then concurrency-bounded /search
/// lookups with the movie year guard, dedupe and id+title re-checks.
async fn validate(
    ctx: &Ctx<'_>,
    picks: &[Pick],
    pool_by_title: &HashMap<String, Vec<Item>>,
) -> Validated {
    let mut v = Validated {
        accepted: vec![],
        rejected: vec![],
        counters: Counters::default(),
    };
    let mut survivors: Vec<&Pick> = vec![];
    let mut seen = HashSet::new();
    for p in picks {
        if title_matches(&p.title, &ctx.rejected_titles) {
            v.counters.dropped_as_rejected += 1;
            v.rejected.push((
                p.title.clone(),
                "on the household NEVER SUGGEST list (matched by title)".into(),
            ));
            continue;
        }
        if title_matches(&p.title, &ctx.library_titles) {
            v.counters.dropped_as_library += 1;
            v.rejected.push((
                p.title.clone(),
                "already in the household library (matched by title)".into(),
            ));
            continue;
        }
        let matches = pool_by_title
            .get(&normalize_title(&p.title))
            .map_or(&[][..], Vec::as_slice);
        let pool_item = if truthy(&p.year) {
            matches
                .iter()
                .find(|it| it.year.is_some_and(|y| p.year.as_f64() == Some(y as f64)))
        } else if matches.len() == 1 {
            matches.first()
        } else {
            None
        };
        if let Some(item) = pool_item {
            if !seen.insert(item.id) {
                v.counters.dropped_as_dedupe += 1;
                v.rejected.push((
                    p.title.clone(),
                    "duplicate of an earlier pick in this batch".into(),
                ));
                continue;
            }
            v.counters.pool_hits += 1;
            let mut item = item.clone();
            item.provenance = Some("personalized".into());
            item.reason = Some(reason_of(p));
            v.accepted.push(item);
            if v.accepted.len() >= TARGET_COUNT {
                break;
            }
            continue;
        }
        survivors.push(p);
    }
    if v.accepted.len() >= TARGET_COUNT {
        return v;
    }
    let jobs: Vec<(String, Value)> = survivors
        .iter()
        .map(|p| (p.title.clone(), p.year.clone()))
        .collect();
    let (st, kind) = (ctx.st, ctx.kind);
    let lookups = map_limit(
        jobs,
        tmdb::LOOKUP_CONCURRENCY,
        |(_, (title, year))| async move { tmdb::lookup(st, kind, &title, &year).await },
    )
    .await;
    for (p, r) in survivors.into_iter().zip(lookups) {
        if v.accepted.len() >= TARGET_COUNT {
            break;
        }
        let original = p.title.clone();
        let Some(mut r) = r else {
            v.counters.lookup_nulls += 1;
            v.rejected.push((
                original,
                "TMDB lookup failed \u{2014} title may be misspelled".into(),
            ));
            continue;
        };
        // Movies only: TV years legitimately disagree (latest season vs
        // premiere); for movies this catches remake confusion.
        if ctx.kind == Kind::Movie
            && truthy(&p.year)
            && let Some(ry) = r.year.filter(|y| *y != 0)
            && (ry as f64 - js_value_number(Some(&p.year))).abs() > 5.0
        {
            v.counters.dropped_as_year_mismatch += 1;
            let why = format!(
                "TMDB top match was \"{}\" ({ry}), but you asked for {} \u{2014} likely a different work; pick a closer title or use the exact year",
                r.title,
                crate::tmdb::js_string(&p.year)
            );
            v.rejected.push((original, why));
            continue;
        }
        if seen.contains(&r.id) {
            v.counters.dropped_as_dedupe += 1;
            v.rejected.push((
                original,
                "duplicate of an earlier pick in this batch".into(),
            ));
            continue;
        }
        if ctx.rejected_ids.contains(&r.id) || title_matches(&r.title, &ctx.rejected_titles) {
            v.counters.dropped_as_rejected += 1;
            v.rejected
                .push((original, "on the household NEVER SUGGEST list".into()));
            continue;
        }
        let by_id = ctx.library_ids.contains(&r.id);
        let by_title = title_matches(&r.title, &ctx.library_titles);
        if by_id || by_title {
            v.counters.dropped_as_library += 1;
            v.rejected
                .push((original, "already in the household library".into()));
            tracing::warn!(
                event = "suggestions",
                kind = ctx.kind.as_str(),
                pick_id = r.id,
                pick_title = %r.title,
                full = %normalize_title(&r.title),
                base = %normalize_title_base(&r.title),
                matched_by_id = by_id,
                matched_by_title = by_title,
                "library duplicate dropped"
            );
            continue;
        }
        seen.insert(r.id);
        r.provenance = Some("personalized".into());
        r.reason = Some(reason_of(p));
        v.accepted.push(r);
    }
    v
}

/// Appends one usage line; a failure is logged and flagged in the diag.
async fn record_usage(log: &JsonlLog, ev: &usage::Event<'_>, failed: &mut bool) {
    if let Err(e) = usage::append(log, ev).await {
        *failed = true;
        tracing::error!(event = "suggestions", error = %e, "usage log append failed");
    }
}

/// The BYO-key pipeline (only when the local recommender is off).
async fn claude_path(mut ctx: Ctx<'_>) -> Result<Response, Response> {
    let st = ctx.st;
    let kind = ctx.kind;
    if !tmdb::configured(st) {
        return Ok(ctx.reply(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "tmdb_not_configured" }),
            true,
        ));
    }
    if ctx.library.len() < COLD_START_THRESHOLD {
        tracing::warn!(event = "suggestions", diag = %ctx.diag(json!({})), "Cold-start path: library too small to filter");
        let start = Instant::now();
        let items = ctx.trending().await;
        ctx.timing.end("trending", start);
        let n = ctx.library.len();
        let diag = ctx.diag(json!({
            "reason": "library_below_threshold",
            "libraryCount": n,
            "threshold": COLD_START_THRESHOLD,
            "hint": format!("Add at least {} more title(s) to get personalized recommendations", COLD_START_THRESHOLD - n),
        }));
        let items = ctx
            .tag_iptv(items.into_iter().take(TARGET_COUNT).collect())
            .await;
        return Ok(ctx.ok("trending", items, diag));
    }

    // The caller's own key, stored encrypted per sub. 402: they must
    // provide credentials themselves. The key is never logged.
    let key = crate::stores::api_key(&st.auth.pool, &st.config.auth.session_secret, ctx.sub())
        .await
        .map_err(|e| auth::Error::from(e).into_response())?
        .filter(|k| k.starts_with(crate::stores::API_KEY_PREFIX));
    let Some(key) = key else {
        return Ok(ctx.reply(
            StatusCode::PAYMENT_REQUIRED,
            json!({ "error": "api_key_required", "hint": "set your key in the user menu" }),
            false,
        ));
    };

    let feedback = st
        .stores
        .feedback
        .user(ctx.sub())
        .await
        .map_err(IntoResponse::into_response)?;
    let liked_raw = feedback.kind(kind).liked.clone();

    // Top-5 genres seed the pool; it is fetched alongside the backfills.
    let top_genre_ids = tmdb::genre_ids(kind, &tmdb::top_genre_names(&ctx.library, 5));
    let start = Instant::now();
    let (rejections_titled, liked, raw_pool) = tokio::join!(
        tmdb::backfill(st, None, kind, ctx.kind_rejections.clone()),
        tmdb::backfill(st, Some(ctx.sub()), kind, liked_raw),
        tmdb::candidate_pool(st, kind, &top_genre_ids),
    );
    ctx.timing.end("candidatePool", start);

    // Shuffled per request so refreshes see a different numbered list.
    let mut safe_pool = ctx.household_safe(raw_pool);
    safe_pool.shuffle(&mut rand::rng());
    // At least ~20% of the pool stays uncontested by recently-shown.
    let recent_cap = if safe_pool.is_empty() {
        RECENTLY_SHOWN_CAP
    } else {
        ((safe_pool.len() as f64 * 0.8).floor() as usize).max(30)
    };
    let recent: Vec<IdTitle> = st
        .suggestions
        .recently_shown(ctx.sub(), kind)
        .into_iter()
        .take(recent_cap)
        .collect();
    let mut pool_by_title: HashMap<String, Vec<Item>> = HashMap::new();
    for it in &safe_pool {
        pool_by_title
            .entry(normalize_title(&it.title))
            .or_default()
            .push(it.clone());
    }
    let is_pool_hit = |item: &Item| {
        pool_by_title
            .get(&normalize_title(&item.title))
            .is_some_and(|v| v.iter().any(|p| p.id == item.id))
    };
    let blocks = Blocks {
        library: prompt::build_library_block(kind, &ctx.library, &rejections_titled),
        priority: prompt::build_priority_taste_block(&ctx.library),
        likes: prompt::build_user_likes_block(&liked),
        recently_shown: prompt::build_recently_shown_block(&recent),
        pool: prompt::build_candidate_pool_block(&safe_pool),
    };

    let model = st.config.suggestions_model.as_str();
    let username = ctx.p.session.username.clone();
    let mut usage_failed = false;
    let salt = prompt::refresh_salt();
    let hint = (!ctx.library_genres.is_empty()).then(|| {
        ctx.library_genres
            .iter()
            .take(2)
            .cloned()
            .collect::<Vec<_>>()
            .join(" and ")
    });
    let start = Instant::now();
    let r1: ClaudeResponse = match prompt::call(
        st,
        &key,
        &prompt::initial_body(model, kind, &blocks, &salt, hint.as_deref()),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            ctx.timing.end("claudeInitial", start);
            tracing::error!(event = "suggestions", error_msg = %e.message, error_status = e.status, "Claude call failed");
            let ev = usage::Event::error(ctx.sub(), &username, model, kind, &e.message);
            record_usage(&st.usage, &ev, &mut usage_failed).await;
            let items = ctx.trending().await;
            let mut extra = json!({ "reason": "claude_threw", "claudeError": e.message });
            if let Some(status) = e.status {
                extra["claudeStatus"] = status.into();
            }
            if usage_failed {
                extra["usageLogFailed"] = true.into();
            }
            let diag = ctx.diag(extra);
            let items = ctx
                .tag_iptv(items.into_iter().take(TARGET_COUNT).collect())
                .await;
            return Ok(ctx.ok("trending_fallback", items, diag));
        }
    };
    ctx.timing.end("claudeInitial", start);
    let mut call_count = 1;
    let mut total = Usage::default().merge(r1.usage);
    let truncated = r1.truncated;

    let start = Instant::now();
    let v1 = validate(&ctx, &r1.picks, &pool_by_title).await;
    ctx.timing.end("validate1", start);
    let mut accepted = v1.accepted;
    let mut counters = v1.counters;
    let mut retried = false;

    // Retry once when Claude can act on it: rejections to replace, or an
    // empty list (truncation, constraints read as unsatisfiable).
    if let Some(prior) = &r1.tool_use
        && accepted.len() < TARGET_COUNT
        && (!v1.rejected.is_empty() || r1.picks.is_empty())
    {
        retried = true;
        let n_needed = CLAUDE_OVERFETCH.min(TARGET_COUNT - accepted.len() + 4);
        let body = prompt::retry_body(
            model,
            kind,
            &blocks,
            prior,
            &v1.rejected,
            n_needed,
            &salt,
            hint.as_deref(),
        );
        let start = Instant::now();
        match prompt::call(st, &key, &body).await {
            Ok(r2) => {
                call_count += 1;
                total = total.merge(r2.usage);
                ctx.timing.end("claudeRetry", start);
                let start = Instant::now();
                let v2 = validate(&ctx, &r2.picks, &pool_by_title).await;
                ctx.timing.end("validate2", start);
                // Drops add up across both passes.
                counters = counters.add(v2.counters);
                let mut ids: HashSet<i64> = accepted.iter().map(|a| a.id).collect();
                for item in v2.accepted {
                    if ids.insert(item.id) {
                        accepted.push(item);
                        if accepted.len() >= TARGET_COUNT {
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                tracing::error!(event = "suggestions", error = %e.message, "Claude retry failed");
            }
        }
    }

    let cost = usage::compute_cost_cents(&total);
    let input_total = total.input.unwrap_or(0)
        + total.cache_read.unwrap_or(0)
        + total.cache_creation.unwrap_or(0);
    let cache_hit_rate = if input_total > 0 {
        round2(total.cache_read.unwrap_or(0) as f64 / input_total as f64)
    } else {
        0.0
    };
    let ev = usage::Event::call(ctx.sub(), &username, model, kind, call_count, &total, cost);
    record_usage(&st.usage, &ev, &mut usage_failed).await;
    let dropped = counters.dropped();
    let recent_count = recent.len();
    let tail = |mut m: Value| {
        if truncated {
            m["claudeTruncated"] = true.into();
        }
        if usage_failed {
            m["usageLogFailed"] = true.into();
        }
        m
    };

    if accepted.len() < TARGET_COUNT {
        // Fill so the strip is full: library-genre discover first, then
        // trending.
        let start = Instant::now();
        let fill_ids: HashSet<i64> = accepted.iter().map(|a| a.id).collect();
        let mut fill_source = "trending";
        let mut fill: Vec<Item> = vec![];
        if !top_genre_ids.is_empty() {
            let discover: Vec<Item> = ctx
                .household_safe(tmdb::candidate_pool(st, kind, &top_genre_ids).await)
                .into_iter()
                .filter(|t| !fill_ids.contains(&t.id))
                .map(|it| it.fill("discover"))
                .collect();
            if !discover.is_empty() {
                fill = discover;
                fill_source = "discover";
            }
        }
        if accepted.len() + fill.len() < TARGET_COUNT {
            let after: HashSet<i64> = fill_ids
                .iter()
                .copied()
                .chain(fill.iter().map(|f| f.id))
                .collect();
            fill.extend(
                ctx.trending()
                    .await
                    .into_iter()
                    .filter(|t| !after.contains(&t.id)),
            );
            fill_source = if fill_source == "discover" {
                "discover+trending"
            } else {
                "trending"
            };
        }
        let filled: Vec<Item> = accepted
            .iter()
            .cloned()
            .chain(fill)
            .take(TARGET_COUNT)
            .collect();
        ctx.timing.end("fill", start);
        tracing::warn!(
            event = "suggestions",
            kind = kind.as_str(),
            sub = ctx.sub(),
            library_count = ctx.library.len(),
            rejection_count = rejections_titled.len(),
            titled_rejections = rejections_titled.iter().filter(|r| !r.title.is_empty()).count(),
            accepted = accepted.len(),
            retry_attempted = retried,
            fill_source,
            last_counters = %json!(counters),
            "Personalized picks short of target \u{2014} filling"
        );
        st.suggestions.record_shown(ctx.sub(), kind, &filled);
        let pool_hits = accepted.iter().filter(|i| is_pool_hit(i)).count();
        let counters = Counters {
            pool_hits: pool_hits as u32,
            ..counters
        };
        let mut extra = json!({
            "accepted": accepted.len(),
            "retryAttempted": retried,
            "fillSource": fill_source,
            "lastCounters": counters,
            "poolSize": safe_pool.len(),
            "droppedPicks": dropped,
            "costCents": num(cost),
            "cacheHitRate": num(cache_hit_rate),
            "callCount": call_count,
            "recentlyShownCount": recent_count,
        });
        let source = if accepted.is_empty() {
            extra["poolHitRate"] = 0.into();
            "personalized_empty_trending_fallback"
        } else {
            extra["poolHits"] = pool_hits.into();
            extra["poolHitRate"] = num(round2(pool_hits as f64 / accepted.len() as f64));
            "personalized_filled"
        };
        let diag = ctx.diag(tail(extra));
        let items = ctx.tag_iptv(filled).await;
        return Ok(ctx.ok(source, items, diag));
    }

    let accepted_count = accepted.len();
    let final_items: Vec<Item> = accepted.into_iter().take(TARGET_COUNT).collect();
    let pool_hits = final_items.iter().filter(|i| is_pool_hit(i)).count();
    let counters = Counters {
        pool_hits: pool_hits as u32,
        ..counters
    };
    st.suggestions.record_shown(ctx.sub(), kind, &final_items);
    let diag = ctx.diag(tail(json!({
        "accepted": accepted_count,
        "retryAttempted": retried,
        "poolSize": safe_pool.len(),
        "poolHits": pool_hits,
        "poolHitRate": num(if final_items.is_empty() { 0.0 } else { round2(pool_hits as f64 / final_items.len() as f64) }),
        "lastCounters": counters,
        "droppedPicks": dropped,
        "costCents": num(cost),
        "cacheHitRate": num(cache_hit_rate),
        "callCount": call_count,
        "recentlyShownCount": recent_count,
    })));
    let items = ctx.tag_iptv(final_items).await;
    Ok(ctx.ok("personalized", items, diag))
}

#[cfg(test)]
mod fake;
#[cfg(test)]
mod goldens;
#[cfg(test)]
mod tests;
