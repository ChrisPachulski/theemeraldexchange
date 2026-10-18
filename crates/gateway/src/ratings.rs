//! /api/ratings (routes/ratings.ts): IMDb, Rotten Tomatoes (Tomatometer and
//! Popcornmeter) and Metacritic scores keyed by IMDb id, cached in server.db's
//! title_ratings.
//!
//! Per title: OMDb (IMDb, Metacritic, sometimes an RT critic score), Wikidata
//! SPARQL batched per request (IMDb id P345 -> RT id P1258), then the RT page's
//! embedded JSON (RT has no public API). Every answer, "not found" included,
//! is cached for 7 days; a transport failure on either source caches nothing,
//! so the next request retries. A request returns the cache plus whatever the
//! fill queue completes within the synchronous wait, and lists the rest in
//! `pending` for the client to poll.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared, join_all};
use indexmap::IndexMap;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::AppState;
use crate::app::js_number;
use crate::routes::err;
use crate::upstream::{Upstream, WAN_TIMEOUT};

pub const TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// One library page is well under this; more is a client bug or abuse.
const MAX_IDS: usize = 60;
// ponytail: fixed fan-out against RT/OMDb; 3 keeps a cold 300-title fill
// polite (~2 min) without tripping WAN timeouts.
const FILL_CONCURRENCY: usize = 3;
pub const SYNC_WAIT: Duration = Duration::from_secs(6);
/// RT serves its full page (scores included) to a browser UA.
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
/// Wikidata's etiquette policy asks for an identifying UA.
const WIKIDATA_UA: &str = "EmeraldExchange/1.0 (self-hosted media library; ratings enrichment)";

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleRatings {
    #[serde(serialize_with = "js_opt")]
    pub imdb: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub rt: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub rt_audience: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub metacritic: Option<f64>,
}

/// 87, not 87.0.
fn js_opt<S: serde::Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    v.map(js_number).serialize(s)
}

/// The two RT meters.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RtScores {
    pub rt: Option<f64>,
    pub rt_audience: Option<f64>,
}

/// `Number.parseFloat`: the longest leading decimal number, else None.
fn parse_float(s: &str) -> Option<f64> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| {
        Regex::new(r"^[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)").expect("static regex")
    });
    let m = r.find(auth::js_trim(s))?;
    m.as_str().parse::<f64>().ok().filter(|n| n.is_finite())
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// OMDb's payload onto our scores; "N/A" and absent fields are None.
pub fn parse_omdb(body: &Value) -> TitleRatings {
    let rt = body
        .get("Ratings")
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .find(|r| str_field(r, "Source") == Some("Rotten Tomatoes"))
        })
        .and_then(|r| str_field(r, "Value"))
        .filter(|v| !v.is_empty())
        .and_then(|v| parse_float(&v.replacen('%', "", 1)));
    TitleRatings {
        imdb: str_field(body, "imdbRating").and_then(parse_float),
        rt,
        rt_audience: None,
        metacritic: str_field(body, "Metascore").and_then(parse_float),
    }
}

/// Tomatometer and Popcornmeter from an RT title page's embedded JSON.
pub fn parse_rt_page(html: &str) -> RtScores {
    static CRITICS: OnceLock<Regex> = OnceLock::new();
    static AUDIENCE: OnceLock<Regex> = OnceLock::new();
    let pick = |cell: &'static OnceLock<Regex>, key: &str| {
        let r = cell.get_or_init(|| {
            Regex::new(&format!(r#""{key}":\{{[^}}]*?"score":"(\d*)""#)).expect("static regex")
        });
        r.captures(html).and_then(|c| parse_float(&c[1]))
    };
    RtScores {
        rt: pick(&CRITICS, "criticsScore"),
        rt_audience: pick(&AUDIENCE, "audienceScore"),
    }
}

fn imdb_id(id: &str) -> bool {
    let digits = id.strip_prefix("tt").unwrap_or_default();
    (5..=10).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
}

fn rt_slug(s: &str) -> bool {
    let rest = s.strip_prefix("m/").or_else(|| s.strip_prefix("tv/"));
    rest.is_some_and(|r| {
        !r.is_empty()
            && r.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    })
}

// --- upstreams -------------------------------------------------------------------------

/// The upstream half of the route state: everything a fill job needs.
#[derive(Clone)]
struct Sources {
    upstream: Upstream,
    pool: SqlitePool,
    omdb_key: Option<String>,
    omdb_base: String,
    wikidata: String,
    rt_base: String,
}

impl Sources {
    /// None on a transport failure or non-2xx (retry later); all-None
    /// without an OMDb key (nothing to ask).
    async fn omdb(&self, id: &str) -> Option<TitleRatings> {
        let Some(key) = &self.omdb_key else {
            return Some(TitleRatings::default());
        };
        let mut url = reqwest::Url::parse(&self.omdb_base).ok()?;
        url.query_pairs_mut()
            .append_pair("apikey", key)
            .append_pair("i", id);
        let req = self
            .upstream
            .client()
            .get(url)
            .header(header::ACCEPT, "application/json");
        let reply = self.upstream.fetch(req, WAN_TIMEOUT, "omdb").await;
        if !reply.is_success() {
            return None;
        }
        serde_json::from_slice(&reply.body)
            .ok()
            .map(|v: Value| parse_omdb(&v))
    }

    /// One SPARQL round-trip for a batch; Wikidata down means no RT this
    /// cycle (the TTL retries later).
    async fn rt_slugs(&self, ids: &[String]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        if ids.is_empty() {
            return out;
        }
        let values = ids
            .iter()
            .map(|id| format!("\"{id}\""))
            .collect::<Vec<_>>()
            .join(" ");
        let query = format!(
            "SELECT ?imdb ?rt WHERE {{ VALUES ?imdb {{ {values} }} ?item wdt:P345 ?imdb . ?item wdt:P1258 ?rt }}"
        );
        let Ok(mut url) = reqwest::Url::parse(&self.wikidata) else {
            return out;
        };
        url.query_pairs_mut()
            .append_pair("format", "json")
            .append_pair("query", &query);
        let req = self
            .upstream
            .client()
            .get(url)
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, WIKIDATA_UA);
        let reply = self.upstream.fetch(req, WAN_TIMEOUT, "wikidata").await;
        if !reply.is_success() {
            return out;
        }
        let Ok(data) = serde_json::from_slice::<Value>(&reply.body) else {
            return out;
        };
        let bindings = data
            .pointer("/results/bindings")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        for b in bindings {
            let imdb = b.pointer("/imdb/value").and_then(Value::as_str);
            let slug = b.pointer("/rt/value").and_then(Value::as_str);
            if let (Some(imdb), Some(slug)) = (imdb, slug)
                && rt_slug(slug)
                && !out.contains_key(imdb)
            {
                out.insert(imdb.to_string(), slug.to_string());
            }
        }
        out
    }

    /// None on a transport failure or non-2xx other than 404 (a definitive
    /// "no page").
    async fn rt_page(&self, slug: &str) -> Option<RtScores> {
        let url = reqwest::Url::parse(&self.rt_base).ok()?.join(slug).ok()?;
        let req = self
            .upstream
            .client()
            .get(url)
            .header(header::USER_AGENT, BROWSER_UA)
            .header(header::ACCEPT, "text/html");
        let reply = self
            .upstream
            .fetch(req, WAN_TIMEOUT, "rottentomatoes")
            .await;
        if reply.status == StatusCode::NOT_FOUND {
            return Some(RtScores::default());
        }
        if !reply.is_success() {
            return None;
        }
        Some(parse_rt_page(&String::from_utf8_lossy(&reply.body)))
    }

    async fn fill_one(&self, id: &str, slug: Option<&str>, now: i64) {
        let rt = async {
            match slug {
                Some(slug) => self.rt_page(slug).await,
                None => Some(RtScores::default()),
            }
        };
        let (omdb, rt) = tokio::join!(self.omdb(id), rt);
        let (Some(omdb), Some(rt)) = (omdb, rt) else {
            return;
        };
        let merged = TitleRatings {
            imdb: omdb.imdb,
            rt: rt.rt.or(omdb.rt),
            rt_audience: rt.rt_audience,
            metacritic: omdb.metacritic,
        };
        if let Err(e) = write_cached(&self.pool, id, &merged, slug, now).await {
            tracing::error!(event = "ratings", id, message = %e, "title_ratings write failed");
        }
    }
}

// --- cache -----------------------------------------------------------------------------

/// imdb, rt, rt_audience, metacritic, fetched_at.
type Row = (Option<f64>, Option<f64>, Option<f64>, Option<f64>, i64);

async fn read_cached(
    pool: &SqlitePool,
    ids: &[String],
    now: i64,
) -> sqlx::Result<HashMap<String, TitleRatings>> {
    let mut out = HashMap::new();
    for id in ids {
        // CAST: a score stored in an INTEGER column reads as a JS number either way.
        let row: Option<Row> = sqlx::query_as(
            "SELECT CAST(imdb AS REAL), CAST(rt AS REAL), CAST(rt_audience AS REAL), \
                 CAST(metacritic AS REAL), fetched_at FROM title_ratings WHERE imdb_id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        if let Some((imdb, rt, rt_audience, metacritic, fetched_at)) = row
            && now - fetched_at < TTL_MS
        {
            out.insert(
                id.clone(),
                TitleRatings {
                    imdb,
                    rt,
                    rt_audience,
                    metacritic,
                },
            );
        }
    }
    Ok(out)
}

/// SQLite's column affinity stores a whole-number score in the INTEGER
/// columns as an integer, as better-sqlite3's JS number did.
async fn write_cached(
    pool: &SqlitePool,
    id: &str,
    r: &TitleRatings,
    slug: Option<&str>,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO title_ratings (imdb_id, imdb, rt, rt_audience, metacritic, rt_slug, fetched_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(imdb_id) DO UPDATE SET \
           imdb = excluded.imdb, rt = excluded.rt, rt_audience = excluded.rt_audience, \
           metacritic = excluded.metacritic, rt_slug = excluded.rt_slug, fetched_at = excluded.fetched_at",
    )
    .bind(id)
    .bind(r.imdb)
    .bind(r.rt)
    .bind(r.rt_audience)
    .bind(r.metacritic)
    .bind(slug)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

// --- the fill queue --------------------------------------------------------------------

type Job = Shared<BoxFuture<'static, ()>>;

/// One in-process queue: ids fill in arrival order, [`FILL_CONCURRENCY`] at a
/// time (a FIFO semaphore), each id at most once at a time.
pub struct Ratings {
    sync_wait: Duration,
    permits: Arc<Semaphore>,
    inflight: Arc<Mutex<HashMap<String, Job>>>,
}

impl Default for Ratings {
    fn default() -> Self {
        Ratings::new(SYNC_WAIT)
    }
}

impl Ratings {
    pub fn new(sync_wait: Duration) -> Ratings {
        Ratings {
            sync_wait,
            permits: Arc::new(Semaphore::new(FILL_CONCURRENCY)),
            inflight: Arc::default(),
        }
    }

    fn pending(&self, id: &str) -> bool {
        self.inflight.lock().unwrap().contains_key(id)
    }

    /// The job for each id, starting one for every id not already filling.
    /// The batch's ids share one Wikidata lookup, which starts at once.
    fn enqueue(&self, src: &Sources, ids: &[String], now: i64) -> Vec<Job> {
        let mut inflight = self.inflight.lock().unwrap();
        let fresh: Vec<String> = ids
            .iter()
            .filter(|id| !inflight.contains_key(*id))
            .cloned()
            .collect();
        if !fresh.is_empty() {
            let lookup = {
                let (src, fresh) = (src.clone(), fresh.clone());
                tokio::spawn(async move { src.rt_slugs(&fresh).await })
            };
            let slugs = async move { lookup.await.unwrap_or_default() }
                .boxed()
                .shared();
            for id in fresh {
                let (src, slugs, permits, registry) = (
                    src.clone(),
                    slugs.clone(),
                    self.permits.clone(),
                    self.inflight.clone(),
                );
                let key = id.clone();
                // Spawned under the registry lock, so its removal cannot run
                // before the insert below.
                let handle = tokio::spawn(async move {
                    let permit = permits.acquire_owned().await;
                    let slug = slugs.await.get(&id).cloned();
                    src.fill_one(&id, slug.as_deref(), now).await;
                    drop(permit);
                    registry.lock().unwrap().remove(&id);
                });
                let job = async move {
                    let _ = handle.await;
                }
                .boxed()
                .shared();
                inflight.insert(key, job);
            }
        }
        ids.iter()
            .filter_map(|id| inflight.get(id).cloned())
            .collect()
    }
}

/// GET /api/ratings?ids=tt0903747,tt1520211
/// -> `{ ratings: { tt0903747: {imdb, rt, rtAudience, metacritic} }, pending: [...] }`
pub async fn get(
    State(st): State<AppState>,
    _auth: auth::RequireAuth,
    uri: axum::http::Uri,
) -> Response {
    let pairs = crate::arr::shared::query_pairs(&uri);
    let raw = crate::arr::shared::query_first(&pairs, "ids").unwrap_or_default();
    let mut seen = HashSet::new();
    let ids: Vec<String> = raw
        .split(',')
        .map(auth::js_trim)
        .filter(|s| !s.is_empty() && seen.insert(*s))
        .map(String::from)
        .collect();
    if ids.is_empty() || ids.len() > MAX_IDS || !ids.iter().all(|id| imdb_id(id)) {
        return err(StatusCode::BAD_REQUEST, "invalid_ids");
    }
    let pool = &st.auth.pool;
    let now = chrono::Utc::now().timestamp_millis();
    let Ok(mut result) = read_cached(pool, &ids, now).await else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    };
    let missing: Vec<String> = ids
        .iter()
        .filter(|id| !result.contains_key(*id))
        .cloned()
        .collect();
    if !missing.is_empty() {
        let c = &st.config;
        let src = Sources {
            upstream: st.upstream.clone(),
            pool: pool.clone(),
            omdb_key: c.omdb_api_key.clone(),
            omdb_base: c.ext.omdb_base.clone(),
            wikidata: c.ext.wikidata_sparql.clone(),
            rt_base: c.ext.rt_base.clone(),
        };
        let jobs = st.ratings.enqueue(&src, &missing, now);
        let _ = tokio::time::timeout(st.ratings.sync_wait, join_all(jobs)).await;
        let Ok(again) = read_cached(pool, &ids, now).await else {
            return err(StatusCode::INTERNAL_SERVER_ERROR, "internal");
        };
        result = again;
    }
    let pending: Vec<&String> = ids
        .iter()
        .filter(|id| !result.contains_key(*id) && st.ratings.pending(id))
        .collect();
    #[derive(Serialize)]
    struct Body<'a> {
        /// In request order, as Object.fromEntries kept it.
        ratings: IndexMap<&'a String, TitleRatings>,
        pending: Vec<&'a String>,
    }
    let ratings = ids
        .iter()
        .filter_map(|id| result.get(id).map(|r| (id, *r)))
        .collect();
    Json(Body { ratings, pending }).into_response()
}

#[cfg(test)]
mod tests;
