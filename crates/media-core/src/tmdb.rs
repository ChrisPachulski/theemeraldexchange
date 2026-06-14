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
    /// One pooled HTTP client for the whole process (reqwest::Client is an Arc
    /// internally, cheap to clone). Building a fresh client per call defeated
    /// connection reuse and re-initialized TLS state on every TMDB hit.
    client: reqwest::Client,
}

const SEARCH_MOVIE_URL: &str = "https://api.themoviedb.org/3/search/movie";
const SEARCH_TV_URL: &str = "https://api.themoviedb.org/3/search/tv";
const API_BASE: &str = "https://api.themoviedb.org/3";

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
fn parse_search_response(
    doc: &serde_json::Value,
    is_movie: bool,
    query_title: &str,
    year: Option<i64>,
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

    let mut best: Option<(f64, TmdbMatch)> = None;
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
        // Strictly-greater keeps the earliest (most popular) result on ties.
        if best.as_ref().is_none_or(|(b, _)| score > *b) {
            best = Some((score, candidate));
        }
    }
    best.map(|(_, m)| m)
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
        Self { api_key, client }
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
        Ok(parse_search_response(&doc, is_movie, title, want_year))
    }

    /// Fetch external ids (`imdb_id`, `tvdb_id`) for a TMDB title via
    /// `/{movie|tv}/{id}/external_ids`. Logs and returns an empty
    /// [`ExternalIds`] on any failure so enrichment is best-effort.
    async fn external_ids(&self, kind: &str, id: i64) -> ExternalIds {
        let api_key = match self.api_key.as_deref() {
            Some(k) => k,
            None => return ExternalIds::default(),
        };
        let url = format!("{API_BASE}/{kind}/{id}/external_ids");
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

    /// Fetch per-episode metadata (title, air_date) via
    /// `/tv/{show_tmdb_id}/season/{season}/episode/{episode}`. Returns `None`
    /// if no key, no match, or any error (logged) — never fails the scan.
    pub async fn episode(
        &self,
        show_tmdb_id: i64,
        season: i64,
        episode: i64,
    ) -> Option<TmdbEpisode> {
        let api_key = self.api_key.as_deref()?;
        let url = format!("{API_BASE}/tv/{show_tmdb_id}/season/{season}/episode/{episode}");
        let send = || async { self.authed_get(&url, api_key).send().await };
        let resp = match send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "episode send failed: {}",
                    e.without_url()
                );
                return None;
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
                    return None;
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
            return None;
        }
        match resp.json::<serde_json::Value>().await {
            Ok(doc) => parse_episode_response(&doc),
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "episode json failed: {}",
                    e.without_url()
                );
                None
            }
        }
    }

    /// Search TMDB for a movie. Returns `None` if no key, no match, or any
    /// error (logged). On a hit, also fetches `imdb_id`.
    pub async fn match_movie(&self, title: &str, year: Option<i64>) -> Option<TmdbMatch> {
        self.match_with(SEARCH_MOVIE_URL, "movie", title, year, true)
            .await
    }

    /// Search TMDB for a TV show. Returns `None` if no key, no match, or any
    /// error (logged). On a hit, also fetches `imdb_id`.
    pub async fn match_show(&self, title: &str, year: Option<i64>) -> Option<TmdbMatch> {
        self.match_with(SEARCH_TV_URL, "tv", title, year, false)
            .await
    }

    async fn match_with(
        &self,
        url: &str,
        kind: &str,
        title: &str,
        year: Option<i64>,
        is_movie: bool,
    ) -> Option<TmdbMatch> {
        let first = match self.search(url, title, year, year, is_movie).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "search failed for {title:?}: {e}"
                );
                return None;
            }
        };
        // A strict primary_release_year filter can return nothing when the
        // folder year is off by one (festival vs wide release). Retry without
        // the request constraint; year_compatible (±1) still rejects a
        // wrong-era candidate, so a remake can never fall back to the original.
        let found = match first {
            Some(m) => Some(m),
            None if year.is_some() => match self.search(url, title, None, year, is_movie).await {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(
                        target: "media_core::tmdb",
                        "year-relaxed retry failed for {title:?}: {e}"
                    );
                    None
                }
            },
            None => None,
        };
        let mut found = found?;
        let ext = self.external_ids(kind, found.tmdb_id).await;
        found.imdb_id = ext.imdb_id;
        found.tvdb_id = ext.tvdb_id;
        Some(found)
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
            .authed_get(SEARCH_MOVIE_URL, token)
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
        let req = c.authed_get(SEARCH_MOVIE_URL, key).build().unwrap();
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
        }
        let raw = include_str!("../tests/fixtures/tmdb-match-accuracy.json");
        let cases: Vec<Case> = serde_json::from_str(raw).expect("accuracy fixture parses");
        assert!(
            cases.len() >= 20,
            "corpus too small ({}) to be a meaningful eval",
            cases.len()
        );

        let mut correct = 0usize;
        let mut misses: Vec<String> = Vec::new();
        for c in &cases {
            let doc = json!({ "results": c.results });
            let got = parse_search_response(&doc, c.is_movie, &c.query_title, c.query_year)
                .map(|m| m.tmdb_id);
            if got == c.expected_tmdb_id {
                correct += 1;
            } else {
                misses.push(format!(
                    "{}: expected {:?}, got {:?}",
                    c.name, c.expected_tmdb_id, got
                ));
            }
        }
        let total = cases.len();
        let accuracy = correct as f64 / total as f64;
        eprintln!(
            "TMDB match accuracy: {correct}/{total} = {:.1}%",
            accuracy * 100.0
        );
        for m in &misses {
            eprintln!("  MISS {m}");
        }

        // Regression floor for the matcher's selection accuracy (crit-3).
        const ACCURACY_FLOOR: f64 = 1.0;
        assert!(
            accuracy >= ACCURACY_FLOOR,
            "TMDB match accuracy {:.1}% fell below the {:.0}% floor:\n{}",
            accuracy * 100.0,
            ACCURACY_FLOOR * 100.0,
            misses.join("\n")
        );
    }
}
