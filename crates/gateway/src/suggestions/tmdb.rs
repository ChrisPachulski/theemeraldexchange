//! TMDB for the suggestions route (services/suggestionsTmdb.ts): title search,
//! trending, the genre-seeded candidate pool and the legacy title backfill,
//! each call bounded at 2.5 s with one Retry-After-honouring 429 retry, behind
//! process-wide caches and single-flight maps that bound the TMDB volume.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use axum::http::{StatusCode, header};
use futures_util::future::join_all;
use indexmap::IndexMap;
use serde_json::Value;

use super::{Item, LibItem, SingleFlight, genre_counts};
use crate::AppState;
use crate::routes::{js_str_number, truthy};
use crate::stores::{IdTitle, Kind};

/// Concurrent /search lookups per validation pass (TMDB's ~40 req/10 s).
pub const LOOKUP_CONCURRENCY: usize = 8;
/// Legacy untitled rows resolved per request; the rest wait for the next.
const BACKFILL_MAX_PER_CALL: usize = 10;
const TIMEOUT: Duration = Duration::from_millis(2500);
/// A longer Retry-After would outlive the 2.5 s budget anyway.
const MAX_RETRY_WAIT_MS: f64 = 2000.0;
const TRENDING_TTL: Duration = Duration::from_secs(300);
const LOOKUP_TTL: Duration = Duration::from_secs(10);
const LOOKUP_MAX_KEYS: usize = 500;
const TITLE_NULL_TTL: Duration = Duration::from_secs(300);
const TITLE_NULL_MAX_KEYS: usize = 1000;
const TRENDING_PAGES: u32 = 5;
const POOL_PAGES: u32 = 3;

/// A cached pool: its date:genres key, the items, the expiry.
type Pool = (String, Vec<Item>, Instant);

/// Process-wide: the keys are global, not per user.
#[derive(Default)]
pub struct Tmdb {
    /// Ids TMDB could not title, until the entry expires.
    title_null: std::sync::Mutex<IndexMap<String, Instant>>,
    titles: SingleFlight<String, Option<String>>,
    lookups: std::sync::Mutex<IndexMap<String, (Option<Item>, Instant)>>,
    lookup_flight: SingleFlight<String, Option<Item>>,
    trending: std::sync::Mutex<HashMap<Kind, (Vec<Item>, Instant)>>,
    /// The pool cache: (date:genres key, items, expiry).
    discover: std::sync::Mutex<HashMap<Kind, Pool>>,
}

pub fn configured(st: &AppState) -> bool {
    st.config.tmdb_configured()
}

/// GET `{base}{path}?params[&api_key]` with the read token preferred, inside
/// the 2.5 s budget. None on a network error or timeout.
async fn get(st: &AppState, path: &str, params: &[(&str, &str)]) -> Option<(StatusCode, Value)> {
    let c = &st.config;
    let mut url = reqwest::Url::parse(&format!("{}{path}", c.ext.tmdb_base)).ok()?;
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
    let send = || {
        let mut req = st
            .upstream
            .client()
            .get(url.clone())
            .header(header::ACCEPT, "application/json");
        if let Some(token) = &c.tmdb_read_access_token {
            req = req.bearer_auth(token);
        }
        req.send()
    };
    let fetch = async {
        let mut r = send().await.ok()?;
        if r.status() == StatusCode::TOO_MANY_REQUESTS {
            let after = r
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .filter(|s| !s.is_empty());
            let ms = after.map_or(2000.0, |s| js_str_number(s) * 1000.0);
            if !ms.is_finite() || ms > MAX_RETRY_WAIT_MS {
                tracing::warn!(
                    event = "suggestions",
                    retry_after = after,
                    "TMDB 429 \u{2014} Retry-After exceeds budget; surfacing 429 to caller"
                );
            } else {
                tracing::warn!(
                    event = "suggestions",
                    after_ms = ms,
                    "TMDB 429 \u{2014} retrying"
                );
                tokio::time::sleep(Duration::from_secs_f64(ms.max(0.0) / 1000.0)).await;
                r = send().await.ok()?;
            }
        }
        let status = r.status();
        let body = r.bytes().await.ok()?;
        // A non-JSON body reads as Null: every caller treats it as a failure.
        Some((status, serde_json::from_slice(&body).unwrap_or(Value::Null)))
    };
    tokio::time::timeout(TIMEOUT, fetch).await.ok().flatten()
}

/// A non-empty string field (`r.title || r.name`).
fn text<'a>(row: &'a Value, k: &str) -> Option<&'a str> {
    row.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The release or first-air date, or "".
fn date(row: &Value) -> &str {
    text(row, "release_date")
        .or_else(|| text(row, "first_air_date"))
        .unwrap_or_default()
}

/// `Number(date.slice(0, 4))` when finite (and whole).
fn year_of(date: &str) -> Option<i64> {
    if date.is_empty() {
        return None;
    }
    let n = js_str_number(auth::js_slice(date, 4));
    (n.is_finite() && n.fract() == 0.0).then_some(n as i64)
}

fn item(row: &Value, id: i64, title: String) -> Item {
    Item {
        id,
        title,
        poster_path: row.get("poster_path").cloned(),
        overview: row.get("overview").cloned(),
        year: year_of(date(row)),
        ..Item::default()
    }
}

/// One page's `results` (`?? []`); None when the page failed.
fn results(
    reply: Option<(StatusCode, Value)>,
    what: &str,
    page: u32,
    loud: bool,
) -> Option<Vec<Value>> {
    let (status, body) = reply?;
    if !status.is_success() {
        if loud && status != StatusCode::TOO_MANY_REQUESTS {
            tracing::error!(
                event = "suggestions",
                status = status.as_u16(),
                page,
                "TMDB {what} non-ok"
            );
        }
        return None;
    }
    match body.get("results") {
        Some(Value::Array(rows)) => Some(rows.clone()),
        None | Some(Value::Null) if !body.is_null() => Some(vec![]),
        _ => {
            if loud {
                tracing::error!(event = "suggestions", page, "TMDB {what} unreadable");
            }
            None
        }
    }
}

/// Rows in order, the first of each truthy id kept.
fn dedupe(rows: impl IntoIterator<Item = Value>, today: Option<&str>) -> Vec<Item> {
    let mut seen = HashSet::new();
    let mut items = vec![];
    for r in rows {
        let Some(id) = r.get("id").and_then(Value::as_i64).filter(|id| *id != 0) else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }
        if let Some(today) = today {
            let d = date(&r);
            if !d.is_empty() && d > today {
                continue;
            }
        }
        let title = text(&r, "title")
            .or_else(|| text(&r, "name"))
            .unwrap_or_default()
            .to_string();
        items.push(item(&r, id, title));
    }
    items
}

impl Tmdb {
    fn title_null_cached(&self, key: &str, now: Instant) -> bool {
        let mut m = self.title_null.lock().unwrap();
        match m.get(key) {
            Some(exp) if *exp > now => true,
            Some(_) => {
                m.shift_remove(key);
                false
            }
            None => false,
        }
    }

    fn set_title_null(&self, key: &str, null: bool) {
        let mut m = self.title_null.lock().unwrap();
        m.shift_remove(key);
        if null {
            m.insert(key.to_string(), Instant::now() + TITLE_NULL_TTL);
            while m.len() > TITLE_NULL_MAX_KEYS {
                m.shift_remove_index(0);
            }
        }
    }
}

/// `/{kind}/{id}` → title || name. A miss is remembered for 5 minutes.
async fn title_by_id(st: &AppState, kind: Kind, id: u64) -> Option<String> {
    if !configured(st) {
        return None;
    }
    let key = format!("{}:{id}", kind.as_str());
    let t = &st.suggestions.tmdb;
    if t.title_null_cached(&key, Instant::now()) {
        return None;
    }
    let (st2, k2) = (st.clone(), key.clone());
    t.titles
        .run(key, move || async move {
            let title = match get(&st2, &format!("/{}/{id}", kind.as_str()), &[]).await {
                Some((s, body)) if s.is_success() => text(&body, "title")
                    .or_else(|| text(&body, "name"))
                    .map(String::from),
                _ => None,
            };
            st2.suggestions.tmdb.set_title_null(&k2, title.is_none());
            title
        })
        .await
}

/// Titles for at most ten untitled rows not already known to be dead.
async fn resolve_titles(st: &AppState, kind: Kind, needed: &[&IdTitle]) -> HashMap<u64, String> {
    let now = Instant::now();
    let slice: Vec<u64> = needed
        .iter()
        .filter(|e| {
            !st.suggestions
                .tmdb
                .title_null_cached(&format!("{}:{}", kind.as_str(), e.id), now)
        })
        .take(BACKFILL_MAX_PER_CALL)
        .map(|e| e.id)
        .collect();
    let titles = join_all(slice.iter().map(|id| title_by_id(st, kind, *id))).await;
    slice
        .into_iter()
        .zip(titles)
        .filter_map(|(id, t)| Some((id, t?)))
        .collect()
}

/// Legacy untitled rows with TMDB titles where resolvable. A resolved title
/// is persisted only onto a row that still exists (the user may have cleared
/// it meanwhile); a failed write is logged and the prompt still gets it.
pub async fn backfill(
    st: &AppState,
    sub: Option<&str>,
    kind: Kind,
    entries: Vec<IdTitle>,
) -> Vec<IdTitle> {
    let needed: Vec<&IdTitle> = entries.iter().filter(|e| e.title.is_empty()).collect();
    if needed.is_empty() {
        return entries;
    }
    let updates = resolve_titles(st, kind, &needed).await;
    if updates.is_empty() {
        return entries;
    }
    for (id, title) in &updates {
        let write = match sub {
            None => {
                st.stores
                    .rejections
                    .update_title_if_present(kind, *id, title)
                    .await
            }
            Some(sub) => {
                st.stores
                    .feedback
                    .update_liked_title_if_present(sub, kind, *id, title)
                    .await
            }
        };
        if let Err(e) = write {
            let what = if sub.is_some() { "liked" } else { "rejection" };
            tracing::error!(event = "suggestions", error = %e, "{what} title backfill failed");
        }
    }
    entries
        .into_iter()
        .map(|e| match updates.get(&e.id) {
            Some(t) => IdTitle {
                id: e.id,
                title: t.clone(),
            },
            None => e,
        })
        .collect()
}

/// The top /search hit for a pick, the year as a hint first (TMDB's year
/// filter is strict; Claude often gives a TV show's latest-season year).
/// Results are cached for 10 s and shared between concurrent callers.
pub async fn lookup(st: &AppState, kind: Kind, title: &str, year: &Value) -> Option<Item> {
    if !configured(st) {
        return None;
    }
    let year_key = if year.is_null() {
        String::new()
    } else {
        crate::tmdb::js_string(year)
    };
    let key = format!("{}:{}:{year_key}", kind.as_str(), title.to_lowercase());
    let t = &st.suggestions.tmdb;
    {
        let mut cache = t.lookups.lock().unwrap();
        match cache.get(&key) {
            Some((item, exp)) if *exp > Instant::now() => return item.clone(),
            Some(_) => {
                cache.shift_remove(&key);
            }
            None => {}
        }
    }
    let (st2, k2, title, year) = (st.clone(), key.clone(), title.to_string(), year.clone());
    t.lookup_flight
        .run(key, move || async move {
            let (item, cacheable) = search(&st2, kind, &title, &year).await;
            if cacheable {
                let mut cache = st2.suggestions.tmdb.lookups.lock().unwrap();
                cache.insert(k2, (item.clone(), Instant::now() + LOOKUP_TTL));
                while cache.len() > LOOKUP_MAX_KEYS {
                    cache.shift_remove_index(0);
                }
            }
            item
        })
        .await
}

/// (hit, cacheable): a 200 that is not JSON is not cached (the TS promise
/// rejected there).
async fn search(st: &AppState, kind: Kind, title: &str, year: &Value) -> (Option<Item>, bool) {
    let path = format!("/search/{}", kind.as_str());
    let year_param = match kind {
        Kind::Movie => "primary_release_year",
        Kind::Tv => "first_air_date_year",
    };
    let year_text = crate::tmdb::js_string(year);
    let run = |with_year: bool| {
        let path = path.clone();
        let year_text = year_text.clone();
        async move {
            let mut params = vec![("query", title)];
            if with_year && truthy(year) {
                params.push((year_param, year_text.as_str()));
            }
            match get(st, &path, &params).await {
                Some((s, Value::Null)) if s.is_success() => Err(()),
                Some((s, body)) if s.is_success() => Ok(body
                    .get("results")
                    .and_then(Value::as_array)
                    .and_then(|r| r.first())
                    .filter(|top| top.is_object())
                    .cloned()),
                _ => Ok(None),
            }
        }
    };
    let mut top = match run(true).await {
        Ok(t) => t,
        Err(()) => return (None, false),
    };
    if top.is_none() && truthy(year) {
        top = match run(false).await {
            Ok(t) => t,
            Err(()) => return (None, false),
        };
    }
    let Some(top) = top else {
        return (None, true);
    };
    let Some(id) = top.get("id").and_then(Value::as_i64) else {
        return (None, true);
    };
    let name = text(&top, "title")
        .or_else(|| text(&top, "name"))
        .unwrap_or(title)
        .to_string();
    (Some(item(&top, id, name)), true)
}

/// This week's trending, up to five pages fetched at once; a failed page
/// only thins the list. Only a non-empty result is cached (5 minutes), so an
/// outage clears on the next call.
pub async fn trending(st: &AppState, kind: Kind) -> Vec<Item> {
    if !configured(st) {
        return vec![];
    }
    let t = &st.suggestions.tmdb;
    if let Some((items, exp)) = t.trending.lock().unwrap().get(&kind)
        && *exp > Instant::now()
    {
        return items.clone();
    }
    let path = format!("/trending/{}/week", kind.as_str());
    let pages = join_all((1..=TRENDING_PAGES).map(|p| {
        let path = path.clone();
        async move {
            let page = p.to_string();
            results(
                get(st, &path, &[("page", &page)]).await,
                "/trending",
                p,
                true,
            )
        }
    }))
    .await;
    let items = dedupe(pages.into_iter().flatten().flatten(), None);
    if !items.is_empty() {
        t.trending
            .lock()
            .unwrap()
            .insert(kind, (items.clone(), Instant::now() + TRENDING_TTL));
    }
    items
}

/// The candidate pool Claude ranks from (and the fill source): three pages
/// of acclaimed titles in the household's top genres (OR-ed) plus one page
/// of recent releases, released by today, deduped by id. Keyed by date and
/// genre set; only a non-empty pool is cached (5 minutes).
pub async fn candidate_pool(st: &AppState, kind: Kind, genre_ids: &[i64]) -> Vec<Item> {
    if !configured(st) || genre_ids.is_empty() {
        return vec![];
    }
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let mut sorted = genre_ids.to_vec();
    sorted.sort_unstable();
    let genre_key = sorted
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join("|");
    let key = format!("{today}:{genre_key}");
    let t = &st.suggestions.tmdb;
    if let Some((k, items, exp)) = t.discover.lock().unwrap().get(&kind)
        && *k == key
        && *exp > Instant::now()
    {
        return items.clone();
    }
    let path = format!("/discover/{}", kind.as_str());
    let (lte, recent) = match kind {
        Kind::Movie => ("primary_release_date.lte", "primary_release_date.desc"),
        Kind::Tv => ("first_air_date.lte", "first_air_date.desc"),
    };
    let page = |p: u32, sort: &'static str, votes: &'static str, loud: bool| {
        let (path, genre_key, today) = (path.clone(), genre_key.clone(), today.clone());
        async move {
            let n = p.to_string();
            let params = [
                ("page", n.as_str()),
                ("sort_by", sort),
                ("vote_count.gte", votes),
                ("with_genres", genre_key.as_str()),
                (lte, today.as_str()),
            ];
            results(get(st, &path, &params).await, "/discover (pool)", p, loud)
        }
    };
    let (quality, novelty) = tokio::join!(
        join_all((1..=POOL_PAGES).map(|p| page(p, "vote_average.desc", "200", true))),
        join_all([page(1, recent, "30", false)]),
    );
    let rows = quality.into_iter().chain(novelty).flatten().flatten();
    let items = dedupe(rows, Some(&today));
    if !items.is_empty() {
        t.discover
            .lock()
            .unwrap()
            .insert(kind, (key, items.clone(), Instant::now() + TRENDING_TTL));
    }
    items
}

/// Sonarr/Radarr genre names → TMDB /discover ids (lowercased, with
/// aliases); unknown names drop.
pub fn genre_ids(kind: Kind, names: &[String]) -> Vec<i64> {
    let mut out: Vec<i64> = vec![];
    for n in names {
        let lower = n.to_lowercase();
        if let Some(id) = genre_id(kind, auth::js_trim(&lower))
            && !out.contains(&id)
        {
            out.push(id);
        }
    }
    out
}

fn genre_id(kind: Kind, name: &str) -> Option<i64> {
    Some(match (kind, name) {
        (Kind::Movie, "action") => 28,
        (Kind::Movie, "adventure") => 12,
        (Kind::Movie, "animation") => 16,
        (Kind::Movie, "comedy") => 35,
        (Kind::Movie, "crime") => 80,
        (Kind::Movie, "documentary") => 99,
        (Kind::Movie, "drama") => 18,
        (Kind::Movie, "family") => 10751,
        (Kind::Movie, "fantasy") => 14,
        (Kind::Movie, "history") => 36,
        (Kind::Movie, "horror") => 27,
        (Kind::Movie, "music" | "musical") => 10402,
        (Kind::Movie, "mystery") => 9648,
        (Kind::Movie, "romance") => 10749,
        (Kind::Movie, "science fiction" | "sci-fi" | "sci-fi & fantasy") => 878,
        (Kind::Movie, "thriller") => 53,
        (Kind::Movie, "war") => 10752,
        (Kind::Movie, "western") => 37,
        (Kind::Movie, "biography") => 36,
        (Kind::Movie, "sport") => 99,
        (Kind::Tv, "action" | "adventure" | "action & adventure") => 10759,
        (Kind::Tv, "animation" | "anime") => 16,
        (Kind::Tv, "comedy") => 35,
        (Kind::Tv, "crime") => 80,
        (Kind::Tv, "documentary") => 99,
        (Kind::Tv, "drama" | "history") => 18,
        (Kind::Tv, "family") => 10751,
        (Kind::Tv, "fantasy" | "science fiction" | "sci-fi" | "sci-fi & fantasy") => 10765,
        (Kind::Tv, "horror" | "mystery" | "thriller") => 9648,
        (Kind::Tv, "kids") => 10762,
        (Kind::Tv, "news") => 10763,
        (Kind::Tv, "reality") => 10764,
        (Kind::Tv, "soap") => 10766,
        (Kind::Tv, "talk") => 10767,
        (Kind::Tv, "war" | "war & politics") => 10768,
        (Kind::Tv, "western") => 37,
        (Kind::Tv, "romance") => 10749,
        _ => return None,
    })
}

/// The library's n most frequent genre names (ties in first-seen order).
pub fn top_genre_names(library: &[LibItem], n: usize) -> Vec<String> {
    genre_counts(library)
        .into_iter()
        .take(n)
        .map(|(g, _)| g)
        .collect()
}
