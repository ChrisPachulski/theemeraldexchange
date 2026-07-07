//! Best-effort TMDB metadata resolution. NEVER blocks a scan: any error or
//! a missing API key yields `None` and the file is kept with filename-derived
//! title only. Failures are logged via `tracing::warn!` (not silently
//! swallowed) so a misconfigured key or rate-limit is visible, then converted
//! to `None` at the public `match_*` boundary.
//!
//! Uses `https://api.themoviedb.org/3/search/{movie,tv}` for the title hit,
//! then `/{movie,tv}/{id}/external_ids` to fill `imdb_id`/`tvdb_id` (the
//! search endpoints never return them), and `/tv/{id}/season/{s}/episode/{e}`
//! for per-episode title/air_date. One shared pooled client, 5s timeout per
//! request. A v4 Read Access Token (JWT) is sent as `Authorization: Bearer`;
//! a classic v3 key rides the `api_key` query param, and all logged reqwest
//! errors are URL-stripped so the key never leaks into logs either way.

use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TmdbMatch {
    pub tmdb_id: i64,
    pub title: String,
    pub year: Option<i64>,
    pub imdb_id: Option<String>,
    pub tvdb_id: Option<i64>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    /// US certification / content rating (movie "PG-13", tv "TV-MA"), filled
    /// by a second request after the search hit (the search endpoints never
    /// return it). `None` when TMDB carried no US entry or the call failed —
    /// enrichment is best-effort and never fails a scan.
    pub content_rating: Option<String>,
}

/// External ids pulled from a TMDB `/external_ids` response. Both fields are
/// optional: a title may carry one, both, or neither.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExternalIds {
    pub imdb_id: Option<String>,
    pub tvdb_id: Option<i64>,
}

/// Per-episode metadata from `/tv/{id}/season/{s}/episode/{e}`. Both fields are
/// optional so a partial response still enriches what it can.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TmdbEpisode {
    pub title: Option<String>,
    pub air_date: Option<String>,
}

#[derive(Clone)]
pub struct TmdbClient {
    pub api_key: Option<String>,
    /// API base (`https://api.themoviedb.org/3` in production). Injectable so a
    /// counting/failing local stub can drive the negative-cache and steady-state
    /// request-avoidance tests without a hardcoded const to a live host.
    base: String,
    /// One pooled HTTP client for the whole process (reqwest::Client is an Arc
    /// internally, cheap to clone). Building a fresh client per call defeated
    /// connection reuse and re-initialized TLS state on every TMDB hit.
    client: reqwest::Client,
}

const API_BASE: &str = "https://api.themoviedb.org/3";

/// Tri-state outcome of a best-effort TMDB enrichment fetch (content rating or
/// per-episode metadata). The negative caches MUST distinguish a DEFINITIVE
/// miss — HTTP 404, or a 200 whose body carried no matching entry (the title or
/// episode genuinely has no such data) — from a TRANSIENT failure (send error,
/// timeout, 5xx, 429-after-retry, JSON-decode error, or a missing API key).
/// Only a [`TmdbFetch::DefinitiveMiss`] may be stamped into a negcache; a
/// [`TmdbFetch::Transient`] leaves the retry budget untouched so the next scan
/// retries instead of suppressing matchable metadata for 30 days (or
/// permanently after the 6-attempt cap) because an outage happened to coincide
/// with the scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmdbFetch<T> {
    Found(T),
    DefinitiveMiss,
    Transient,
}

/// Split a non-success HTTP status into the definitive/transient buckets the
/// enrichment negative caches key on. Only 404 Not Found is definitive (the id
/// genuinely has no such resource); every other non-2xx — 5xx gateway blips
/// (the NAS's documented cloudflared netns outages), 429, 403, 5xx — is
/// transient and must NOT burn the retry budget.
fn status_is_definitive_miss(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::NOT_FOUND
}

/// Hard cap on how long a single 429 back-off will sleep, so a hostile or
/// misconfigured `Retry-After` can never wedge a scan for minutes.
const MAX_RETRY_AFTER_SECS: u64 = 10;

/// Parse a TMDB `Retry-After` header (delta-seconds form) into a capped
/// `Duration`. TMDB sends an integer number of seconds; anything unparseable
/// falls back to one second so a rate-limited request still backs off.
fn retry_after_duration(headers: &reqwest::header::HeaderMap) -> Duration {
    let secs = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(1)
        .clamp(1, MAX_RETRY_AFTER_SECS);
    Duration::from_secs(secs)
}

/// Read the year (first four digits) from a TMDB date string like `2014-11-07`.
fn year_from_date(date: &str) -> Option<i64> {
    let prefix: String = date.chars().take(4).collect();
    if prefix.len() == 4 {
        prefix.parse().ok()
    } else {
        None
    }
}

/// Stopwords dropped before title comparison so a shared "the"/"of" alone never
/// counts as agreement between two otherwise-unrelated titles.
const TITLE_STOPWORDS: &[&str] = &["the", "a", "an", "of", "and", "or", "to", "in"];

/// Normalize a title into lowercased alphanumeric tokens with stopwords removed.
/// Used only for match-confidence scoring, never for what gets stored.
fn title_tokens(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .filter(|w| !TITLE_STOPWORDS.contains(&w.as_str()))
        .collect()
}

/// Confidence that a candidate title is the same work as the query, in
/// `[0.0, 1.0]`. A subset relation either way (query "Batman" vs candidate
/// "Batman Begins") scores 1.0; otherwise it is the Jaccard overlap of the token
/// sets. 0.0 means no shared non-stopword token — a near-certain wrong match.
fn title_match_score(query: &[String], candidate: &[String]) -> f64 {
    use std::collections::BTreeSet;
    let q: BTreeSet<&String> = query.iter().collect();
    let c: BTreeSet<&String> = candidate.iter().collect();
    if q.is_empty() || c.is_empty() {
        return 0.0;
    }
    if q.is_subset(&c) || c.is_subset(&q) {
        return 1.0;
    }
    let inter = q.intersection(&c).count();
    let union = q.union(&c).count();
    inter as f64 / union as f64
}

/// Build a [`TmdbMatch`] from a single TMDB search result object, or `None` if
/// it lacks an id or a non-empty title.
fn parse_one(result: &serde_json::Value, is_movie: bool) -> Option<TmdbMatch> {
    let tmdb_id = result.get("id")?.as_i64()?;

    let title_key = if is_movie { "title" } else { "name" };
    let title = result.get(title_key)?.as_str()?;
    if title.is_empty() {
        return None;
    }

    let date_key = if is_movie {
        "release_date"
    } else {
        "first_air_date"
    };
    let year = result
        .get(date_key)
        .and_then(serde_json::Value::as_str)
        .and_then(year_from_date);

    let overview = result
        .get("overview")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let poster_path = result
        .get("poster_path")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    Some(TmdbMatch {
        tmdb_id,
        title: title.to_string(),
        year,
        imdb_id: None,
        tvdb_id: None,
        overview,
        poster_path,
        // The search endpoints never carry a certification; `match_with` fills
        // it from a follow-up `/release_dates` or `/content_ratings` request.
        content_rating: None,
    })
}

/// `true` when a candidate's release year is compatible with the year the
/// filename asked for. Tolerates ±1 (festival vs wide release, regional
/// labels); a candidate with no known year passes (conservative — title
/// scoring still applies). Without this guard a remake's filename year is
/// powerless against title-score ties: "Aladdin (2019)" scored 1.0 against
/// BOTH Aladdin films and the popularity tiebreak handed it to 1992, and
/// "Spirited (2022)" — a token subset of "Spirited Away" — stole tmdb 129.
fn year_compatible(want: Option<i64>, got: Option<i64>) -> bool {
    match (want, got) {
        (Some(w), Some(g)) => (w - g).abs() <= 1,
        _ => true,
    }
}

/// Detect and strip a trailing country marker from a show name, returning the
/// remaining name plus an ISO 3166-1 alpha-2 hint. Same-name series that differ
/// only by country ("The Office" UK vs US, "Ghosts" UK vs US, "Shameless" UK vs
/// US) title-score 1.0 against BOTH TMDB rows, so the tie fell to TMDB's opaque
/// relevance ordering — the UK rip could bind to the US show. Handles `(UK)`,
/// `(US)`, a dangling `(UK` (the filename cleaner drops the trailing paren), and
/// a bare trailing `UK`/`US` token. `UK` maps to TMDB's `GB`. Returns `None`
/// (no strip) when the remainder would be empty, so the query is never emptied.
fn strip_trailing_country(name: &str) -> Option<(String, String)> {
    let trimmed = name.trim_end();
    let last = trimmed.rsplit(' ').next()?;
    let bare = last.trim_matches(|c| matches!(c, '(' | ')'));
    let iso = match bare.to_ascii_uppercase().as_str() {
        "UK" => "GB",
        "US" => "US",
        _ => return None,
    };
    let cut = trimmed.len() - last.len();
    let rest = trimmed[..cut].trim_end();
    if rest.is_empty() {
        return None;
    }
    Some((rest.to_string(), iso.to_string()))
}

/// The `(query_title, year, country_hint)` actually sent to the TV search for a
/// parsed show name. Two independent suffixes are peeled off:
///
/// * a trailing **country marker** ("The Office (UK)") → an ISO 3166-1 alpha-2
///   hint (`GB`/`US`) that [`parse_search_response_scored`] uses to break the
///   same-name popularity tie toward the matching `origin_country`; and
/// * a trailing **scene release year** ("The American Experiment 2026"), which
///   TMDB's year-less TV name never matches verbatim — strip it for the query
///   and surface it as the year hint (`year_compatible` ±1 still rejects a
///   wrong-era remake).
///
/// A title that is *only* a year ("1923") or *only* a country token is left
/// intact so the query is never emptied; an explicit `year` always wins over
/// the stripped hint.
fn show_search_terms(title: &str, year: Option<i64>) -> (String, Option<i64>, Option<String>) {
    let (trimmed, country) = match strip_trailing_country(title.trim_end()) {
        Some((rest, iso)) => (rest, Some(iso)),
        None => (title.trim_end().to_string(), None),
    };
    let trimmed = trimmed.trim_end();
    if let Some(last) = trimmed.rsplit(' ').next()
        && last.len() == 4
        && last.chars().all(|c| c.is_ascii_digit())
        && let Ok(y) = last.parse::<i64>()
        && (1900..=2099).contains(&y)
    {
        let stripped = trimmed[..trimmed.len() - last.len()].trim_end();
        if !stripped.is_empty() {
            return (stripped.to_string(), year.or(Some(y)), country);
        }
    }
    (trimmed.to_string(), year, country)
}

/// `true` when a TMDB search result's `origin_country` array carries `hint`
/// (case-insensitive). Absent/movie results (no `origin_country`) never match.
fn origin_country_matches(result: &serde_json::Value, hint: &str) -> bool {
    result
        .get("origin_country")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(serde_json::Value::as_str)
                .any(|c| c.eq_ignore_ascii_case(hint))
        })
        .unwrap_or(false)
}

/// Pure parser over a TMDB search response. Instead of blindly trusting
/// `results[0]`, it scores every candidate's title against `query_title` and
/// returns the best-scoring one, breaking ties toward TMDB's own ordering
/// (popularity). A candidate that shares no non-stopword token with the query
/// (score 0.0) is rejected so a confident-but-wrong top hit can never pollute
/// the library — the caller then keeps the filename-derived title. When `year`
/// is known, candidates from a different era are rejected outright (see
/// [`year_compatible`]).
///
/// Deliberately conservative: any token overlap or a subset relation is enough
/// to accept, so legitimate fuzzy matches ("LOTR Fellowship" →
/// "The Lord of the Rings: The Fellowship of the Ring") are preserved. When the
/// query has no usable tokens, it falls back to the first valid result.
/// Country-agnostic wrapper over [`parse_search_response_scored`]. Only the
/// unit tests exercise the hint-free path directly; production always routes
/// through `search`, which supplies the (possibly `None`) country hint.
#[cfg(test)]
fn parse_search_response(
    doc: &serde_json::Value,
    is_movie: bool,
    query_title: &str,
    year: Option<i64>,
) -> Option<TmdbMatch> {
    parse_search_response_scored(doc, is_movie, query_title, year, None)
}

/// [`parse_search_response`] with an optional `country_hint` (ISO 3166-1
/// alpha-2, e.g. `GB`). When two candidates title-score equally — the exact
/// same-name trap "The Office" UK vs US — a candidate whose `origin_country`
/// matches the hint beats a non-matching one, instead of the tie silently
/// falling to TMDB's popularity ordering (which bound UK rips to the US show).
/// With no hint, or when neither ties-candidate matches, the earliest (most
/// popular) result still wins, exactly as before.
fn parse_search_response_scored(
    doc: &serde_json::Value,
    is_movie: bool,
    query_title: &str,
    year: Option<i64>,
    country_hint: Option<&str>,
) -> Option<TmdbMatch> {
    let results = doc.get("results")?.as_array()?;
    let query = title_tokens(query_title);

    // No usable query tokens: nothing to score against, so defer to TMDB's
    // ranking (old behavior) rather than rejecting everything — but still
    // refuse a wrong-era candidate.
    if query.is_empty() {
        return results
            .iter()
            .filter_map(|r| parse_one(r, is_movie))
            .find(|c| year_compatible(year, c.year));
    }

    let mut best: Option<(f64, bool, TmdbMatch)> = None;
    for result in results {
        let Some(candidate) = parse_one(result, is_movie) else {
            continue;
        };
        if !year_compatible(year, candidate.year) {
            continue;
        }
        let score = title_match_score(&query, &title_tokens(&candidate.title));
        if score <= 0.0 {
            continue;
        }
        let country_match = country_hint
            .map(|h| origin_country_matches(result, h))
            .unwrap_or(false);
        // Strictly-higher title score always wins; on an exact score tie a
        // country-hint match beats a non-match (else keep the incumbent, i.e.
        // the earliest/most-popular result). Only `<`/`>` comparisons so an
        // exact-equality float compare never enters the decision.
        let is_better = match best.as_ref() {
            None => true,
            Some((b_score, b_country, _)) => {
                if score > *b_score {
                    true
                } else if score < *b_score {
                    false
                } else {
                    country_match && !*b_country
                }
            }
        };
        if is_better {
            best = Some((score, country_match, candidate));
        }
    }
    best.map(|(_, _, m)| m)
}

/// Pure parser over an `/external_ids` response: pulls a non-empty `imdb_id`
/// and (for tv) a `tvdb_id`. TMDB serializes `tvdb_id` as an integer.
fn parse_external_ids(doc: &serde_json::Value) -> ExternalIds {
    let imdb_id = doc
        .get("imdb_id")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let tvdb_id = doc.get("tvdb_id").and_then(serde_json::Value::as_i64);
    ExternalIds { imdb_id, tvdb_id }
}

/// The US entry of a TMDB `.results[]` array keyed by `iso_3166_1`. Both the
/// movie `/release_dates` and tv `/content_ratings` responses nest their
/// per-country rating under this same shape, so the country pick is shared.
fn us_result(doc: &serde_json::Value) -> Option<&serde_json::Value> {
    doc.get("results")?
        .as_array()?
        .iter()
        .find(|r| r.get("iso_3166_1").and_then(serde_json::Value::as_str) == Some("US"))
}

/// Pure parser over a `/movie/{id}/release_dates` response: the US theatrical/
/// digital certification (e.g. "PG-13", "R"). The US block lists one entry per
/// release type (theatrical, digital, physical…) and only some carry a
/// `certification`; return the first non-empty one. `None` when there is no US
/// block or every entry's certification is blank.
fn parse_movie_certification(doc: &serde_json::Value) -> Option<String> {
    us_result(doc)?
        .get("release_dates")?
        .as_array()?
        .iter()
        .filter_map(|rd| rd.get("certification").and_then(serde_json::Value::as_str))
        .find(|c| !c.is_empty())
        .map(str::to_string)
}

/// Pure parser over a `/tv/{id}/content_ratings` response: the US `rating`
/// (e.g. "TV-MA", "TV-14"). `None` when there is no US entry or its rating is
/// blank.
fn parse_tv_content_rating(doc: &serde_json::Value) -> Option<String> {
    us_result(doc)?
        .get("rating")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `true` when `(season, episode)` can exist on TMDB at all. TMDB episode
/// numbering starts at 1 (season 0 — "Specials" — is real, episode 0 is
/// not). Filename parses that land S0E0 (unnumbered specials/extras) can
/// never resolve, and because their rows stay untitled, the backfill pass
/// re-issued the identical doomed lookup for EVERY such file on EVERY scan —
/// dozens of serial 404s per boot for one anime dir. Gate before the network.
fn episode_lookupable(season: i64, episode: i64) -> bool {
    season >= 0 && episode >= 1
}

/// Pure parser over a `/tv/{id}/season/{s}/episode/{e}` response: pulls the
/// episode `name` and `air_date`. Returns `None` only when both are absent so
/// callers do not bother binding an all-empty row.
fn parse_episode_response(doc: &serde_json::Value) -> Option<TmdbEpisode> {
    let title = doc
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let air_date = doc
        .get("air_date")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if title.is_none() && air_date.is_none() {
        return None;
    }
    Some(TmdbEpisode { title, air_date })
}

/// `true` when the configured credential is a TMDB v4 Read Access Token (a
/// JWT, always `eyJ…`) rather than a classic v3 key. v4 tokens ride the
/// `Authorization: Bearer` header — never the URL — so they cannot leak via
/// logged request errors. v3 keys are NOT accepted as Bearer by TMDB, so they
/// must stay on the `api_key` query param; for those, every logged reqwest
/// error is stripped of its URL (`without_url`) instead.
fn is_v4_token(key: &str) -> bool {
    key.starts_with("eyJ")
}

impl TmdbClient {
    pub fn new(api_key: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            // Builder failure here means TLS init failed; the default client
            // keeps the scanner functional (requests will surface errors).
            .unwrap_or_default();
        Self {
            api_key,
            base: API_BASE.to_string(),
            client,
        }
    }

    /// Test-only constructor pointing the client at an arbitrary API base (a
    /// local counting/failing stub) so the negcache and request-avoidance tests
    /// run hermetically. Never compiled into release.
    #[cfg(test)]
    pub(crate) fn with_base(api_key: Option<String>, base: String) -> Self {
        Self {
            base,
            ..Self::new(api_key)
        }
    }

    fn search_movie_url(&self) -> String {
        format!("{}/search/movie", self.base)
    }

    fn search_tv_url(&self) -> String {
        format!("{}/search/tv", self.base)
    }

    /// A GET on `url` carrying the TMDB credential: Bearer header for a v4
    /// token, `api_key` query param for a v3 key (see [`is_v4_token`]).
    fn authed_get(&self, url: &str, key: &str) -> reqwest::RequestBuilder {
        let rb = self.client.get(url);
        if is_v4_token(key) {
            rb.bearer_auth(key)
        } else {
            rb.query(&[("api_key", key)])
        }
    }

    /// Run a search request, returning a typed error so callers can log the
    /// specific failure mode. `Ok(None)` means "no match"; `Err` means a real
    /// transport/parse failure. Error strings are URL-free (`without_url`) so
    /// a v3 `api_key` query param can never leak into logs.
    ///
    /// `query_year` constrains the TMDB request itself; `want_year` is what
    /// the filename claims and drives [`year_compatible`] candidate rejection.
    /// They are split so a no-results retry can drop the request constraint
    /// without losing the wrong-era guard.
    async fn search(
        &self,
        url: &str,
        title: &str,
        query_year: Option<i64>,
        want_year: Option<i64>,
        is_movie: bool,
        country_hint: Option<&str>,
    ) -> Result<Option<TmdbMatch>, String> {
        let api_key = match self.api_key.as_deref() {
            Some(k) => k,
            None => return Ok(None),
        };

        let mut query: Vec<(&str, String)> = vec![("query", title.to_string())];
        if let Some(y) = query_year {
            // `year` matches ANY release-dates entry (re-releases included), so
            // a remake's year still surfaced the more-popular original —
            // `primary_release_year` is the strict filter. TV has no such trap;
            // `first_air_date_year` stays.
            let key = if is_movie {
                "primary_release_year"
            } else {
                "first_air_date_year"
            };
            query.push((key, y.to_string()));
        }

        let resp = self
            .authed_get(url, api_key)
            .query(&query)
            .send()
            .await
            .map_err(|e| format!("send: {}", e.without_url()))?;
        // Honour a single Retry-After back-off on 429 before surfacing failure.
        let resp = if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = retry_after_duration(resp.headers());
            tracing::warn!(
                target: "media_core::tmdb",
                "search rate-limited (429), retrying in {:?}", wait
            );
            tokio::time::sleep(wait).await;
            self.authed_get(url, api_key)
                .query(&query)
                .send()
                .await
                .map_err(|e| format!("retry send: {}", e.without_url()))?
        } else {
            resp
        };
        if !resp.status().is_success() {
            return Err(format!("non-2xx status: {}", resp.status()));
        }
        let doc = resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("json: {}", e.without_url()))?;
        Ok(parse_search_response_scored(
            &doc,
            is_movie,
            title,
            want_year,
            country_hint,
        ))
    }

    /// Fetch external ids (`imdb_id`, `tvdb_id`) for a TMDB title via
    /// `/{movie|tv}/{id}/external_ids`. Logs and returns an empty
    /// [`ExternalIds`] on any failure so enrichment is best-effort.
    async fn external_ids(&self, kind: &str, id: i64) -> ExternalIds {
        let api_key = match self.api_key.as_deref() {
            Some(k) => k,
            None => return ExternalIds::default(),
        };
        let url = format!("{}/{kind}/{id}/external_ids", self.base);
        let resp = match self.authed_get(&url, api_key).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "external_ids send failed: {}",
                    e.without_url()
                );
                return ExternalIds::default();
            }
        };
        if !resp.status().is_success() {
            tracing::warn!(
                target: "media_core::tmdb",
                "external_ids non-2xx: {}",
                resp.status()
            );
            return ExternalIds::default();
        }
        match resp.json::<serde_json::Value>().await {
            Ok(doc) => parse_external_ids(&doc),
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "external_ids json failed: {}",
                    e.without_url()
                );
                ExternalIds::default()
            }
        }
    }

    /// Fetch the US certification / content rating for a title. Movies use
    /// `/movie/{id}/release_dates` (nested per-release `certification`), tv uses
    /// `/tv/{id}/content_ratings` (flat per-country `rating`). Returns a
    /// [`TmdbFetch`] so the caller can tell a genuine "no US certification" (a
    /// definitive miss, safe to negcache) apart from a transient outage (must
    /// not burn the retry budget). Enrichment stays best-effort — a missing
    /// rating never fails a scan, it just leaves the column NULL. `kind` is
    /// "movie" or "tv" to mirror [`Self::external_ids`]. Rating-only fetch for
    /// an already-matched movie (the backfill path re-enriches pre-0010 rows
    /// without a full re-match round trip).
    pub(crate) async fn movie_content_rating(&self, id: i64) -> TmdbFetch<String> {
        self.content_rating("movie", id).await
    }

    async fn content_rating(&self, kind: &str, id: i64) -> TmdbFetch<String> {
        // No credential is NOT a definitive miss — a keyless deploy window must
        // not stamp the negcache and permanently suppress a real rating.
        let api_key = match self.api_key.as_deref() {
            Some(k) => k,
            None => return TmdbFetch::Transient,
        };
        let endpoint = if kind == "movie" {
            "release_dates"
        } else {
            "content_ratings"
        };
        let url = format!("{}/{kind}/{id}/{endpoint}", self.base);
        let resp = match self.authed_get(&url, api_key).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "content_rating send failed: {}",
                    e.without_url()
                );
                return TmdbFetch::Transient;
            }
        };
        if !resp.status().is_success() {
            tracing::warn!(
                target: "media_core::tmdb",
                "content_rating non-2xx for {kind} {id}: {}",
                resp.status()
            );
            return if status_is_definitive_miss(resp.status()) {
                TmdbFetch::DefinitiveMiss
            } else {
                TmdbFetch::Transient
            };
        }
        let doc = match resp.json::<serde_json::Value>().await {
            Ok(doc) => doc,
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "content_rating json failed: {}",
                    e.without_url()
                );
                return TmdbFetch::Transient;
            }
        };
        let parsed = if kind == "movie" {
            parse_movie_certification(&doc)
        } else {
            parse_tv_content_rating(&doc)
        };
        match parsed {
            Some(r) => TmdbFetch::Found(r),
            // A 200 with no US entry: the title genuinely carries no US
            // certification (foreign/indie) — a definitive miss, negcached on
            // the cooldown schedule rather than re-probed every scan.
            None => TmdbFetch::DefinitiveMiss,
        }
    }

    /// Fetch per-episode metadata (title, air_date) via
    /// `/tv/{show_tmdb_id}/season/{season}/episode/{episode}`. Returns a
    /// [`TmdbFetch`] so the caller stamps the episode negcache ONLY on a
    /// definitive miss (404, or a resolved-but-empty body — the mis-numbered
    /// episode genuinely doesn't exist) and never on a transient outage/rate
    /// limit. Never fails the scan.
    pub async fn episode(
        &self,
        show_tmdb_id: i64,
        season: i64,
        episode: i64,
    ) -> TmdbFetch<TmdbEpisode> {
        // S0E0 / negative numbering can never exist on TMDB — a definitive miss
        // so the negcache stamps it and stops re-probing every scan.
        if !episode_lookupable(season, episode) {
            return TmdbFetch::DefinitiveMiss;
        }
        let api_key = match self.api_key.as_deref() {
            Some(k) => k,
            None => return TmdbFetch::Transient,
        };
        let url = format!(
            "{}/tv/{show_tmdb_id}/season/{season}/episode/{episode}",
            self.base
        );
        let send = || async { self.authed_get(&url, api_key).send().await };
        let resp = match send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "episode send failed: {}",
                    e.without_url()
                );
                return TmdbFetch::Transient;
            }
        };
        // On 429, honour Retry-After once before giving up so a fresh full scan
        // does not lose every episode to a transient rate-limit burst.
        let resp = if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = retry_after_duration(resp.headers());
            tracing::warn!(
                target: "media_core::tmdb",
                "episode rate-limited (429), retrying in {:?}", wait
            );
            tokio::time::sleep(wait).await;
            match send().await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(
                        target: "media_core::tmdb",
                        "episode retry send failed: {}",
                        e.without_url()
                    );
                    return TmdbFetch::Transient;
                }
            }
        } else {
            resp
        };
        if !resp.status().is_success() {
            tracing::warn!(
                target: "media_core::tmdb",
                "episode non-2xx for tv {show_tmdb_id} S{season}E{episode}: {}",
                resp.status()
            );
            return if status_is_definitive_miss(resp.status()) {
                TmdbFetch::DefinitiveMiss
            } else {
                TmdbFetch::Transient
            };
        }
        match resp.json::<serde_json::Value>().await {
            // A resolved 200 with no name/air_date is a definitive empty row.
            Ok(doc) => match parse_episode_response(&doc) {
                Some(ep) => TmdbFetch::Found(ep),
                None => TmdbFetch::DefinitiveMiss,
            },
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "episode json failed: {}",
                    e.without_url()
                );
                TmdbFetch::Transient
            }
        }
    }

    /// Search TMDB for a movie. Returns `None` if no key, no match, or any
    /// error (logged). On a hit, also fetches `imdb_id`.
    pub async fn match_movie(&self, title: &str, year: Option<i64>) -> Option<TmdbMatch> {
        self.match_with(&self.search_movie_url(), "movie", title, year, true, None)
            .await
    }

    /// Search TMDB for a TV show. Returns `None` if no key, no match, or any
    /// error (logged). On a hit, also fetches `imdb_id`. A trailing country
    /// marker ("The Office (UK)") is peeled off and passed as an origin-country
    /// hint so a same-name UK/US tie resolves to the right series.
    pub async fn match_show(&self, title: &str, year: Option<i64>) -> Option<TmdbMatch> {
        let (title, year, country) = show_search_terms(title, year);
        self.match_with(
            &self.search_tv_url(),
            "tv",
            &title,
            year,
            false,
            country.as_deref(),
        )
        .await
    }

    /// Search TMDB for a movie, surfacing the tri-state so the caller can
    /// negcache a DEFINITIVE no-results search (a title TMDB genuinely doesn't
    /// carry — home video, obscure rip) on the cooldown schedule without
    /// stamping on a transient outage. On a Found hit, `imdb_id`/`tvdb_id`/
    /// rating are enriched exactly as [`Self::match_movie`].
    pub async fn match_movie_outcome(&self, title: &str, year: Option<i64>) -> TmdbFetch<TmdbMatch> {
        self.match_with_outcome(&self.search_movie_url(), "movie", title, year, true, None)
            .await
    }

    async fn match_with(
        &self,
        url: &str,
        kind: &str,
        title: &str,
        year: Option<i64>,
        is_movie: bool,
        country_hint: Option<&str>,
    ) -> Option<TmdbMatch> {
        match self
            .match_with_outcome(url, kind, title, year, is_movie, country_hint)
            .await
        {
            TmdbFetch::Found(m) => Some(m),
            TmdbFetch::DefinitiveMiss | TmdbFetch::Transient => None,
        }
    }

    async fn match_with_outcome(
        &self,
        url: &str,
        kind: &str,
        title: &str,
        year: Option<i64>,
        is_movie: bool,
        country_hint: Option<&str>,
    ) -> TmdbFetch<TmdbMatch> {
        // No credential is a TRANSIENT state, not a definitive no-results: a
        // keyless deploy window must never stamp a match negcache and suppress a
        // title once the key returns. (search() collapses keyless to Ok(None),
        // so guard here before that becomes an indistinguishable "no results".)
        if self.api_key.is_none() {
            return TmdbFetch::Transient;
        }
        let first = match self.search(url, title, year, year, is_movie, country_hint).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "search failed for {title:?}: {e}"
                );
                return TmdbFetch::Transient;
            }
        };
        // A strict primary_release_year filter can return nothing when the
        // folder year is off by one (festival vs wide release). Retry without
        // the request constraint; year_compatible (±1) still rejects a
        // wrong-era candidate, so a remake can never fall back to the original.
        let found = match first {
            Some(m) => Some(m),
            None if year.is_some() => match self
                .search(url, title, None, year, is_movie, country_hint)
                .await
            {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(
                        target: "media_core::tmdb",
                        "year-relaxed retry failed for {title:?}: {e}"
                    );
                    return TmdbFetch::Transient;
                }
            },
            None => None,
        };
        // Both searches completed but returned no acceptable candidate: a
        // definitive no-results, safe for the caller to negcache.
        let mut found = match found {
            Some(m) => m,
            None => return TmdbFetch::DefinitiveMiss,
        };
        let ext = self.external_ids(kind, found.tmdb_id).await;
        found.imdb_id = ext.imdb_id;
        found.tvdb_id = ext.tvdb_id;
        found.content_rating = match self.content_rating(kind, found.tmdb_id).await {
            TmdbFetch::Found(r) => Some(r),
            // A miss (definitive or transient) at match time just leaves the
            // column NULL; the backfill path re-attempts with negcache gating.
            TmdbFetch::DefinitiveMiss | TmdbFetch::Transient => None,
        };
        TmdbFetch::Found(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn no_api_key_yields_none() {
        let client = TmdbClient::new(None);
        assert_eq!(client.match_movie("Interstellar", Some(2014)).await, None);
        assert_eq!(client.match_show("Severance", None).await, None);
    }

    // Regression: a scene episode release ("The American Experiment 2026") was
    // parsed as a year-suffixed show name and searched on TMDB verbatim, which
    // returns ZERO results (TMDB's name is "The American Experiment"), so the
    // show was stored with NULL tmdb_id/tvdb_id and the apps lost its Play
    // button. The search must drop the trailing release year and feed it as the
    // year hint instead. Fails if `show_search_terms` stops stripping.
    #[test]
    fn show_search_strips_scene_release_year() {
        assert_eq!(
            show_search_terms("The American Experiment 2026", None),
            ("The American Experiment".to_string(), Some(2026), None)
        );
        // An explicit year wins over the stripped suffix.
        assert_eq!(
            show_search_terms("Doctor Who 2005", Some(1963)),
            ("Doctor Who".to_string(), Some(1963), None)
        );
        // A show literally named for a year is NOT emptied.
        assert_eq!(
            show_search_terms("1923", None),
            ("1923".to_string(), None, None)
        );
        // A year-less name is untouched.
        assert_eq!(
            show_search_terms("Severance", None),
            ("Severance".to_string(), None, None)
        );
    }

    #[test]
    fn show_search_strips_trailing_country_marker() {
        // A trailing country marker is peeled off and surfaced as an ISO hint
        // (UK → GB); the query is the bare name so it matches both same-name
        // TMDB rows and the hint breaks the tie downstream.
        assert_eq!(
            show_search_terms("The Office (UK)", None),
            ("The Office".to_string(), None, Some("GB".to_string()))
        );
        // The filename cleaner drops the trailing paren → a dangling "(UK".
        assert_eq!(
            show_search_terms("The Office (UK", None),
            ("The Office".to_string(), None, Some("GB".to_string()))
        );
        // Bare trailing token, and US maps to itself.
        assert_eq!(
            show_search_terms("Shameless US", None),
            ("Shameless".to_string(), None, Some("US".to_string()))
        );
        // A name that is ONLY a country token is not emptied.
        assert_eq!(show_search_terms("UK", None), ("UK".to_string(), None, None));
        // A non-country trailing token is left alone.
        assert_eq!(
            show_search_terms("Severance", None),
            ("Severance".to_string(), None, None)
        );
    }

    #[test]
    fn country_hint_breaks_same_name_tie_to_matching_origin() {
        // Both TMDB rows are titled "The Office" and title-score 1.0 against the
        // query, so without a country hint the tie falls to results[0] (the US
        // show). The GB hint must pull the UK row (origin_country ["GB"]).
        let doc = json!({
            "results": [
                { "id": 2316, "name": "The Office", "first_air_date": "2005-03-24",
                  "origin_country": ["US"] },
                { "id": 2996, "name": "The Office", "first_air_date": "2001-07-09",
                  "origin_country": ["GB"] }
            ]
        });
        // No hint → the first (US) row, as before.
        let us = parse_search_response(&doc, false, "The Office", None).expect("a match");
        assert_eq!(us.tmdb_id, 2316);
        // GB hint → the UK row, breaking the popularity tie.
        let gb = parse_search_response_scored(&doc, false, "The Office UK", None, Some("GB"))
            .expect("a match");
        assert_eq!(gb.tmdb_id, 2996);
        // US hint still selects the US row.
        let us2 = parse_search_response_scored(&doc, false, "The Office US", None, Some("US"))
            .expect("a match");
        assert_eq!(us2.tmdb_id, 2316);
    }

    #[test]
    fn movie_result_parses_to_some() {
        let doc = json!({
            "results": [
                { "id": 157336, "title": "Interstellar", "release_date": "2014-11-07",
                  "overview": "A team travels through a wormhole.", "poster_path": "/p.jpg" },
                { "id": 1, "title": "Other", "release_date": "2000-01-01" }
            ]
        });
        let m = parse_search_response(&doc, true, "Interstellar", None).expect("expected a match");
        assert_eq!(m.tmdb_id, 157336);
        assert_eq!(m.title, "Interstellar");
        assert_eq!(m.year, Some(2014));
        assert_eq!(
            m.overview.as_deref(),
            Some("A team travels through a wormhole.")
        );
        assert_eq!(m.poster_path.as_deref(), Some("/p.jpg"));
        assert_eq!(m.imdb_id, None);
    }

    #[test]
    fn tv_result_parses_name_and_year() {
        let doc = json!({
            "results": [
                { "id": 95396, "name": "Severance", "first_air_date": "2022-02-18" }
            ]
        });
        let m = parse_search_response(&doc, false, "Severance", None).expect("expected a match");
        assert_eq!(m.tmdb_id, 95396);
        assert_eq!(m.title, "Severance");
        assert_eq!(m.year, Some(2022));
    }

    #[test]
    fn external_ids_parses_imdb_and_tvdb() {
        let doc = json!({ "imdb_id": "tt0816692", "tvdb_id": 123 });
        let ext = parse_external_ids(&doc);
        assert_eq!(ext.imdb_id.as_deref(), Some("tt0816692"));
        assert_eq!(ext.tvdb_id, Some(123));
    }

    #[test]
    fn external_ids_empty_imdb_yields_none_but_keeps_tvdb() {
        let doc = json!({ "imdb_id": "", "tvdb_id": 77 });
        let ext = parse_external_ids(&doc);
        assert_eq!(ext.imdb_id, None);
        assert_eq!(ext.tvdb_id, Some(77));
    }

    #[test]
    fn external_ids_missing_both_yields_default() {
        let doc = json!({ "page": 1 });
        assert_eq!(parse_external_ids(&doc), ExternalIds::default());
    }

    #[test]
    fn movie_certification_picks_us_nonempty() {
        // The US block lists several release types; only the theatrical one
        // carries a certification. The first non-empty one must win, and a
        // non-US block (GB) must be ignored.
        let doc = json!({
            "id": 550,
            "results": [
                { "iso_3166_1": "GB", "release_dates": [ { "certification": "18", "type": 3 } ] },
                { "iso_3166_1": "US", "release_dates": [
                    { "certification": "", "type": 1 },
                    { "certification": "R", "type": 3 }
                ] }
            ]
        });
        assert_eq!(parse_movie_certification(&doc).as_deref(), Some("R"));
    }

    #[test]
    fn movie_certification_absent_us_yields_none() {
        // No US block at all, and an all-blank US block, both yield None so the
        // column stays NULL rather than storing an empty string.
        let no_us = json!({ "id": 1, "results": [
            { "iso_3166_1": "FR", "release_dates": [ { "certification": "12" } ] }
        ] });
        assert_eq!(parse_movie_certification(&no_us), None);

        let blank_us = json!({ "id": 1, "results": [
            { "iso_3166_1": "US", "release_dates": [ { "certification": "" } ] }
        ] });
        assert_eq!(parse_movie_certification(&blank_us), None);

        assert_eq!(parse_movie_certification(&json!({ "id": 1 })), None);
    }

    #[test]
    fn tv_content_rating_picks_us() {
        let doc = json!({
            "id": 1396,
            "results": [
                { "iso_3166_1": "AU", "rating": "MA15+" },
                { "iso_3166_1": "US", "rating": "TV-MA" }
            ]
        });
        assert_eq!(parse_tv_content_rating(&doc).as_deref(), Some("TV-MA"));
    }

    #[test]
    fn tv_content_rating_absent_or_blank_us_yields_none() {
        let blank = json!({ "results": [ { "iso_3166_1": "US", "rating": "" } ] });
        assert_eq!(parse_tv_content_rating(&blank), None);

        let no_us = json!({ "results": [ { "iso_3166_1": "JP", "rating": "G" } ] });
        assert_eq!(parse_tv_content_rating(&no_us), None);

        assert_eq!(parse_tv_content_rating(&json!({ "id": 1 })), None);
    }

    #[test]
    fn search_response_leaves_content_rating_unfilled() {
        // The search endpoints never carry a certification; parse_one must
        // default it to None so match_with's follow-up request is the only
        // source of a rating (never a stale/blank guess from the search hit).
        let doc = json!({
            "results": [ { "id": 550, "title": "Fight Club", "release_date": "1999-10-15" } ]
        });
        let m = parse_search_response(&doc, true, "Fight Club", None).expect("a match");
        assert_eq!(m.content_rating, None);
    }

    #[test]
    fn episode_response_parses_name_and_air_date() {
        let doc = json!({ "name": "Pilot", "air_date": "2008-01-20" });
        let ep = parse_episode_response(&doc).expect("expected an episode");
        assert_eq!(ep.title.as_deref(), Some("Pilot"));
        assert_eq!(ep.air_date.as_deref(), Some("2008-01-20"));
    }

    #[test]
    fn episode_response_partial_still_some() {
        let doc = json!({ "name": "Only Title", "air_date": "" });
        let ep = parse_episode_response(&doc).expect("expected an episode");
        assert_eq!(ep.title.as_deref(), Some("Only Title"));
        assert_eq!(ep.air_date, None);
    }

    #[test]
    fn episode_response_empty_yields_none() {
        let doc = json!({ "name": "", "air_date": "" });
        assert_eq!(parse_episode_response(&doc), None);
        assert_eq!(parse_episode_response(&json!({ "id": 1 })), None);
    }

    #[test]
    fn episode_zero_is_never_lookupable() {
        // E0 does not exist on TMDB; S0 ("Specials") does. The guard is what
        // stops the backfill pass from re-firing an identical doomed lookup
        // for every unnumbered-special file on every scan.
        assert!(!episode_lookupable(0, 0));
        assert!(!episode_lookupable(3, 0));
        assert!(!episode_lookupable(-1, 5));
        assert!(episode_lookupable(0, 1)); // real special
        assert!(episode_lookupable(5, 10));
    }

    #[test]
    fn empty_results_yields_none() {
        let doc = json!({ "results": [] });
        assert_eq!(parse_search_response(&doc, true, "Anything", None), None);
    }

    #[test]
    fn missing_results_key_yields_none() {
        let doc = json!({ "page": 1 });
        assert_eq!(parse_search_response(&doc, true, "Anything", None), None);
    }

    #[test]
    fn missing_id_yields_none() {
        let doc = json!({ "results": [ { "title": "No Id" } ] });
        assert_eq!(parse_search_response(&doc, true, "No Id", None), None);
    }

    #[test]
    fn missing_title_yields_none() {
        let doc = json!({ "results": [ { "id": 5, "release_date": "1999-01-01" } ] });
        assert_eq!(parse_search_response(&doc, true, "Anything", None), None);
    }

    #[test]
    fn missing_date_yields_match_with_no_year() {
        let doc = json!({ "results": [ { "id": 7, "title": "Dateless" } ] });
        let m = parse_search_response(&doc, true, "Dateless", None).expect("expected a match");
        assert_eq!(m.tmdb_id, 7);
        assert_eq!(m.year, None);
    }

    #[test]
    fn malformed_date_yields_no_year() {
        let doc = json!({ "results": [ { "id": 8, "title": "Short", "release_date": "20" } ] });
        let m = parse_search_response(&doc, true, "Short", None).expect("expected a match");
        assert_eq!(m.year, None);
    }

    #[test]
    fn rejects_zero_overlap_top_result() {
        // TMDB returned a confident top hit that shares no word with the query.
        // The old `results[0]` path would have stored it; the gate rejects it so
        // the scanner keeps the filename-derived title instead.
        let doc = json!({
            "results": [ { "id": 99, "title": "Completely Unrelated Film",
                           "release_date": "2010-01-01" } ]
        });
        assert_eq!(
            parse_search_response(&doc, true, "Interstellar", None),
            None
        );
    }

    #[test]
    fn picks_best_title_match_not_just_first() {
        // results[0] only partially overlaps; results[1] is an exact subset of
        // the query and must win over TMDB's ordering.
        let doc = json!({
            "results": [
                { "id": 1, "title": "Batman & Robin", "release_date": "1997-06-20" },
                { "id": 2, "title": "Batman Begins", "release_date": "2005-06-15" }
            ]
        });
        let m = parse_search_response(&doc, true, "Batman Begins", None).expect("expected a match");
        assert_eq!(m.tmdb_id, 2);
    }

    #[test]
    fn keeps_fuzzy_subset_match() {
        // A short filename title that is a subset of the canonical title must
        // still match — the gate protects recall, it does not tighten it.
        let doc = json!({
            "results": [ { "id": 268, "title": "Batman Begins", "release_date": "2005-06-15" } ]
        });
        let m = parse_search_response(&doc, true, "Batman", None).expect("expected a match");
        assert_eq!(m.tmdb_id, 268);
    }

    #[test]
    fn empty_query_falls_back_to_first_valid() {
        // A token-less query (nothing to score) defers to TMDB's ranking rather
        // than rejecting everything.
        let doc = json!({
            "results": [ { "id": 5, "title": "Something", "release_date": "2001-01-01" } ]
        });
        let m = parse_search_response(&doc, true, "   ", None).expect("expected a match");
        assert_eq!(m.tmdb_id, 5);
    }

    #[test]
    fn remake_year_beats_popularity_tie() {
        // The live "Aladdin (2019)" failure: both films title-score 1.0, TMDB
        // ranks the 1992 original first, and the popularity tiebreak swallowed
        // the remake into the original's row. The year guard must pick 2019.
        let doc = json!({
            "results": [
                { "id": 812, "title": "Aladdin", "release_date": "1992-11-25" },
                { "id": 420817, "title": "Aladdin", "release_date": "2019-05-22" }
            ]
        });
        let m = parse_search_response(&doc, true, "Aladdin", Some(2019)).expect("expected 2019");
        assert_eq!(m.tmdb_id, 420817);
    }

    #[test]
    fn subset_title_cannot_steal_across_eras() {
        // The live "Spirited (2022)" failure: "spirited" is a token subset of
        // "Spirited Away" (score 1.0 both ways), so the more popular 2001 film
        // stole the match. With the year known, the wrong era is rejected.
        let doc = json!({
            "results": [
                { "id": 129, "title": "Spirited Away", "release_date": "2001-07-20" },
                { "id": 632856, "title": "Spirited", "release_date": "2022-11-10" }
            ]
        });
        let m = parse_search_response(&doc, true, "Spirited", Some(2022)).expect("expected 2022");
        assert_eq!(m.tmdb_id, 632856);
    }

    #[test]
    fn year_off_by_one_is_tolerated() {
        // Festival vs wide release: a folder labeled one year off must still
        // enrich (the strict primary_release_year request is retried without
        // the constraint; the parse-side guard allows ±1).
        let doc = json!({
            "results": [ { "id": 7, "title": "Some Film", "release_date": "2018-12-30" } ]
        });
        let m = parse_search_response(&doc, true, "Some Film", Some(2019)).expect("±1 must pass");
        assert_eq!(m.tmdb_id, 7);
    }

    #[test]
    fn wrong_era_with_no_alternative_yields_none() {
        // Better no enrichment (filename-derived row) than the wrong film.
        let doc = json!({
            "results": [ { "id": 8587, "title": "The Lion King", "release_date": "1994-06-15" } ]
        });
        assert_eq!(
            parse_search_response(&doc, true, "The Lion King", Some(2019)),
            None
        );
    }

    #[test]
    fn dateless_candidate_passes_year_guard() {
        // A candidate with no release_date cannot be year-checked; keep it
        // (conservative) rather than dropping enrichment entirely.
        let doc = json!({
            "results": [ { "id": 11, "title": "Obscure Film" } ]
        });
        let m = parse_search_response(&doc, true, "Obscure Film", Some(2019))
            .expect("dateless candidate must survive");
        assert_eq!(m.tmdb_id, 11);
    }

    #[test]
    fn v4_token_rides_authorization_header_not_url() {
        // A v4 Read Access Token (JWT) must NEVER appear in the URL — reqwest
        // errors Display the URL (incl. query) and get logged verbatim.
        let token = "eyJhbGciOiJIUzI1NiJ9.fake.token";
        let c = TmdbClient::new(Some(token.into()));
        let req = c
            .authed_get(&c.search_movie_url(), token)
            .query(&[("query", "Heat")])
            .build()
            .unwrap();
        assert!(
            !req.url().as_str().contains("eyJ"),
            "token leaked into URL: {}",
            req.url()
        );
        let auth = req
            .headers()
            .get("authorization")
            .expect("Bearer header must be set")
            .to_str()
            .unwrap();
        assert_eq!(auth, format!("Bearer {token}"));
    }

    #[test]
    fn v3_key_rides_query_param_without_bearer() {
        // TMDB does not accept v3 keys as Bearer, so a classic key keeps the
        // api_key query param (log redaction handles the leak vector instead).
        let key = "0123456789abcdef0123456789abcdef";
        let c = TmdbClient::new(Some(key.into()));
        let req = c.authed_get(&c.search_movie_url(), key).build().unwrap();
        assert!(req.url().query().unwrap().contains("api_key="));
        assert!(req.headers().get("authorization").is_none());
    }

    #[test]
    fn retry_after_parses_seconds_and_caps() {
        use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};

        let mut h = HeaderMap::new();
        h.insert(RETRY_AFTER, HeaderValue::from_static("3"));
        assert_eq!(retry_after_duration(&h), Duration::from_secs(3));

        // Hostile/huge value is clamped to the hard cap.
        let mut h = HeaderMap::new();
        h.insert(RETRY_AFTER, HeaderValue::from_static("9999"));
        assert_eq!(
            retry_after_duration(&h),
            Duration::from_secs(MAX_RETRY_AFTER_SECS)
        );
    }

    #[test]
    fn retry_after_missing_or_unparseable_falls_back_to_one_second() {
        use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};

        // Absent header → 1s default back-off.
        let h = HeaderMap::new();
        assert_eq!(retry_after_duration(&h), Duration::from_secs(1));

        // HTTP-date form (not delta-seconds) is unparseable here → 1s default.
        let mut h = HeaderMap::new();
        h.insert(
            RETRY_AFTER,
            HeaderValue::from_static("Wed, 21 Oct 2015 07:28:00 GMT"),
        );
        assert_eq!(retry_after_duration(&h), Duration::from_secs(1));
    }

    /// Crit-3 measurement: corpus-driven matcher-accuracy eval. Drives the pure
    /// `parse_search_response` selection logic over a labeled fixture set of
    /// real-world failure modes (remake collapse, token-subset traps, year
    /// off-by-one, fuzzy-legit, zero-overlap rejection, TV) and asserts a
    /// measured accuracy floor. Hermetic — no network, no TMDB key. Raise the
    /// floor when the matcher improves; never lower it to paper over a
    /// regression.
    #[test]
    fn tmdb_match_accuracy_eval() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            is_movie: bool,
            query_title: String,
            query_year: Option<i64>,
            expected_tmdb_id: Option<i64>,
            results: serde_json::Value,
            /// A case the matcher is KNOWN not to resolve today — it documents a
            /// real limitation (e.g. a filename in a film's original/romaji title
            /// vs TMDB's English `title`, or a stylized numeral like "Se7en"),
            /// i.e. the "language filter absent" gap. Allowed to miss so the
            /// corpus stays representative instead of cherry-picked to 100%; a
            /// gap case that starts PASSING (matcher improved) simply lifts the
            /// score. Clean (non-gap) cases must always match.
            #[serde(default)]
            known_gap: bool,
        }
        let raw = include_str!("../tests/fixtures/tmdb-match-accuracy.json");
        let cases: Vec<Case> = serde_json::from_str(raw).expect("accuracy fixture parses");
        assert!(
            cases.len() >= 45,
            "corpus too small ({}) for a representative ≥95% eval",
            cases.len()
        );

        let mut correct = 0usize;
        let mut clean_misses: Vec<String> = Vec::new();
        let mut gap_misses: Vec<String> = Vec::new();
        for c in &cases {
            let doc = json!({ "results": c.results });
            let got = parse_search_response(&doc, c.is_movie, &c.query_title, c.query_year)
                .map(|m| m.tmdb_id);
            if got == c.expected_tmdb_id {
                correct += 1;
            } else {
                let line = format!(
                    "{}: expected {:?}, got {:?}",
                    c.name, c.expected_tmdb_id, got
                );
                if c.known_gap {
                    gap_misses.push(line);
                } else {
                    clean_misses.push(line);
                }
            }
        }
        let total = cases.len();
        let accuracy = correct as f64 / total as f64;
        eprintln!(
            "TMDB match accuracy: {correct}/{total} = {:.1}% ({} known-gap miss(es))",
            accuracy * 100.0,
            gap_misses.len()
        );
        for m in gap_misses.iter().chain(clean_misses.iter()) {
            eprintln!("  MISS {m}");
        }

        // Two gates. (1) Every CLEAN case must resolve — a regression on a case
        // the matcher is supposed to handle fails immediately, regardless of the
        // distributional score. (2) The whole corpus must clear the crit-3 bar
        // of ≥95% accuracy. Known-gap cases are permitted to miss under (2) but
        // are still reported, so the documented limitation stays visible.
        assert!(
            clean_misses.is_empty(),
            "matcher regressed on case(s) it must handle:\n{}",
            clean_misses.join("\n")
        );
        const ACCURACY_FLOOR: f64 = 0.95; // M3 crit-3 success criterion
        assert!(
            accuracy >= ACCURACY_FLOOR,
            "TMDB match accuracy {:.1}% fell below the {:.0}% crit-3 floor:\n{}",
            accuracy * 100.0,
            ACCURACY_FLOOR * 100.0,
            gap_misses.join("\n")
        );
    }

    #[test]
    fn only_404_is_a_definitive_miss() {
        // 404 = the id genuinely has no such resource → safe to negcache.
        assert!(status_is_definitive_miss(reqwest::StatusCode::NOT_FOUND));
        // Every transient/gateway/rate-limit status must NOT burn the budget.
        for s in [
            reqwest::StatusCode::BAD_GATEWAY,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            reqwest::StatusCode::GATEWAY_TIMEOUT,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            assert!(!status_is_definitive_miss(s), "status {s} must be transient");
        }
    }

    #[tokio::test]
    async fn content_rating_502_is_transient_404_is_definitive_200_empty_is_definitive() {
        // A 5xx gateway blip must be Transient (retryable); a 404 and a 200 with
        // no US block must both be a DefinitiveMiss (safe to negcache).
        let stub = stub::StubServer::start(|path| {
            if path.contains("/movie/1/") {
                (502, "{}".to_string())
            } else if path.contains("/movie/2/") {
                (404, "{}".to_string())
            } else {
                // 200 with an empty results array → no US certification.
                (200, r#"{"results":[]}"#.to_string())
            }
        });
        let c = TmdbClient::with_base(Some("k".into()), stub.base.clone());
        assert_eq!(c.movie_content_rating(1).await, TmdbFetch::Transient);
        assert_eq!(c.movie_content_rating(2).await, TmdbFetch::DefinitiveMiss);
        assert_eq!(c.movie_content_rating(3).await, TmdbFetch::DefinitiveMiss);
    }

    #[tokio::test]
    async fn keyless_content_rating_is_transient_not_definitive() {
        // A keyless deploy window must NOT stamp the negcache (Transient), so a
        // real rating is not permanently suppressed once the key returns.
        let c = TmdbClient::new(None);
        assert_eq!(c.movie_content_rating(550).await, TmdbFetch::Transient);
    }

    #[tokio::test]
    async fn episode_502_is_transient_404_is_definitive() {
        let stub = stub::StubServer::start(|path| {
            if path.contains("/episode/1") {
                (502, "{}".to_string())
            } else {
                (404, "{}".to_string())
            }
        });
        let c = TmdbClient::with_base(Some("k".into()), stub.base.clone());
        assert_eq!(c.episode(100, 1, 1).await, TmdbFetch::Transient);
        assert_eq!(c.episode(100, 1, 2).await, TmdbFetch::DefinitiveMiss);
        // S0E0 short-circuits to a definitive miss with no request at all.
        assert_eq!(c.episode(100, 0, 0).await, TmdbFetch::DefinitiveMiss);
    }
}

/// Test-only in-process HTTP stub for the TMDB API base, shared by the tmdb and
/// scanner test modules. Records every request path so a test can assert an
/// exact call count (the steady-state "zero requests on the second pass" gate)
/// and returns a caller-chosen `(status, body)` per path (the transient-vs-
/// definitive negcache gates). Never compiled into release.
#[cfg(test)]
pub(crate) mod stub {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    pub(crate) struct StubServer {
        /// `http://127.0.0.1:PORT/3` — hand straight to [`super::TmdbClient::with_base`].
        pub base: String,
        hits: Arc<Mutex<Vec<String>>>,
    }

    impl StubServer {
        /// Spawn a blocking HTTP/1.1 stub on an ephemeral loopback port. `handler`
        /// maps a request path (with query) to `(status, json_body)`. Each
        /// response carries `Connection: close` so reqwest opens a fresh
        /// connection per request, keeping the recorded path list an accurate
        /// call count. The accept thread is detached; tests are short-lived so it
        /// dies with the process.
        pub fn start<F>(handler: F) -> Self
        where
            F: Fn(&str) -> (u16, String) + Send + 'static,
        {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback stub");
            let addr = listener.local_addr().expect("stub local_addr");
            let hits: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let hits_thread = Arc::clone(&hits);
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_string();
                    let (status, body) = handler(&path);
                    hits_thread.lock().unwrap().push(path);
                    let resp = format!(
                        "HTTP/1.1 {status} STATUS\r\nContent-Type: application/json\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();
                }
            });
            StubServer {
                base: format!("http://{addr}/3"),
                hits,
            }
        }

        /// Every request path recorded so far.
        pub fn hits(&self) -> Vec<String> {
            self.hits.lock().unwrap().clone()
        }

        /// How many recorded request paths contain `needle`.
        pub fn hit_count_containing(&self, needle: &str) -> usize {
            self.hits()
                .iter()
                .filter(|p| p.contains(needle))
                .count()
        }

        /// Total recorded requests.
        pub fn total_hits(&self) -> usize {
            self.hits().len()
        }
    }
}
