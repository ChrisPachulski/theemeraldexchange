//! Best-effort TMDB metadata resolution. NEVER blocks a scan: any error or
//! a missing API key yields `None` and the file is kept with filename-derived
//! title only. Failures are logged via `tracing::warn!` (not silently
//! swallowed) so a misconfigured key or rate-limit is visible, then converted
//! to `None` at the public `match_*` boundary.
//!
//! Uses `https://api.themoviedb.org/3/search/{movie,tv}` with the `api_key`
//! query param for the title hit, then `/{movie,tv}/{id}/external_ids` to fill
//! `imdb_id`/`tvdb_id` (the search endpoints never return them), and
//! `/tv/{id}/season/{s}/episode/{e}` for per-episode title/air_date. 5s timeout
//! per request.

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

/// Floor below which a TMDB search hit is treated as "no confident match":
/// [`match_with`] returns `None` rather than writing a wrong tmdb_id/imdb_id/
/// poster onto a scanned file. A score at or above this passes.
const MIN_MATCH_CONFIDENCE: f64 = 0.5;

/// Score how well a chosen TMDB result matches the title (and year) we queried,
/// in `[0.0, 1.0]`. Pure, offline-testable; used only to gate acceptance.
///
/// Title component (weight `0.8`): both titles are run through the existing
/// [`crate::filename::normalize_show_name`] (lowercase, strip punctuation/year/
/// quality tokens) and compared as token *sets* via Jaccard similarity
/// (`|intersection| / |union|`). Identical normalized strings yield `1.0`; an
/// empty token set on either side yields `0.0`.
///
/// Year component (weight `0.2`): if we did not query a year it contributes a
/// neutral `1.0` (cannot penalize what we did not ask for); both present and
/// equal → `1.0`; off by exactly one → `0.5` (cross-region release drift);
/// off by more than one → `0.0`; queried but the result has no year → `0.5`.
fn match_confidence(
    query_title: &str,
    query_year: Option<i64>,
    result_title: &str,
    result_year: Option<i64>,
) -> f64 {
    let q = crate::filename::normalize_show_name(query_title);
    let r = crate::filename::normalize_show_name(result_title);
    let q_tokens: std::collections::BTreeSet<&str> = q.split_whitespace().collect();
    let r_tokens: std::collections::BTreeSet<&str> = r.split_whitespace().collect();

    let title_score = if q_tokens.is_empty() || r_tokens.is_empty() {
        0.0
    } else {
        let intersection = q_tokens.intersection(&r_tokens).count() as f64;
        let union = q_tokens.union(&r_tokens).count() as f64;
        intersection / union
    };

    let year_score = match (query_year, result_year) {
        (None, _) => 1.0,
        (Some(qy), Some(ry)) => match (qy - ry).abs() {
            0 => 1.0,
            1 => 0.5,
            _ => 0.0,
        },
        (Some(_), None) => 0.5,
    };

    0.8 * title_score + 0.2 * year_score
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

/// Pure parser over a TMDB search response. Reads `results[0]` and extracts the
/// id, title (`title` for movies, `name` for tv), year, overview, poster_path.
/// Returns `None` when there is no first result or it lacks an id/title.
fn parse_search_response(doc: &serde_json::Value, is_movie: bool) -> Option<TmdbMatch> {
    let first = doc.get("results")?.as_array()?.first()?;

    let tmdb_id = first.get("id")?.as_i64()?;

    let title_key = if is_movie { "title" } else { "name" };
    let title = first.get(title_key)?.as_str()?;
    if title.is_empty() {
        return None;
    }

    let date_key = if is_movie {
        "release_date"
    } else {
        "first_air_date"
    };
    let year = first
        .get(date_key)
        .and_then(serde_json::Value::as_str)
        .and_then(year_from_date);

    let overview = first
        .get("overview")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let poster_path = first
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

impl TmdbClient {
    pub fn new(api_key: Option<String>) -> Self {
        Self { api_key }
    }

    /// Run a search request, returning a typed error so callers can log the
    /// specific failure mode. `Ok(None)` means "no match"; `Err` means a real
    /// transport/parse failure.
    async fn search(
        &self,
        url: &str,
        title: &str,
        year: Option<i64>,
        is_movie: bool,
    ) -> Result<Option<TmdbMatch>, String> {
        let api_key = match self.api_key.as_deref() {
            Some(k) => k,
            None => return Ok(None),
        };

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| format!("build client: {e}"))?;

        let mut query: Vec<(&str, String)> = vec![
            ("api_key", api_key.to_string()),
            ("query", title.to_string()),
        ];
        if let Some(y) = year {
            let key = if is_movie {
                "year"
            } else {
                "first_air_date_year"
            };
            query.push((key, y.to_string()));
        }

        let resp = client
            .get(url)
            .query(&query)
            .send()
            .await
            .map_err(|e| format!("send: {e}"))?;
        // Honour a single Retry-After back-off on 429 before surfacing failure.
        let resp = if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = retry_after_duration(resp.headers());
            tracing::warn!(
                target: "media_core::tmdb",
                "search rate-limited (429), retrying in {:?}", wait
            );
            tokio::time::sleep(wait).await;
            client
                .get(url)
                .query(&query)
                .send()
                .await
                .map_err(|e| format!("retry send: {e}"))?
        } else {
            resp
        };
        if !resp.status().is_success() {
            return Err(format!("non-2xx status: {}", resp.status()));
        }
        let doc = resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("json: {e}"))?;
        Ok(parse_search_response(&doc, is_movie))
    }

    /// Fetch external ids (`imdb_id`, `tvdb_id`) for a TMDB title via
    /// `/{movie|tv}/{id}/external_ids`. Logs and returns an empty
    /// [`ExternalIds`] on any failure so enrichment is best-effort.
    async fn external_ids(&self, kind: &str, id: i64) -> ExternalIds {
        let api_key = match self.api_key.as_deref() {
            Some(k) => k,
            None => return ExternalIds::default(),
        };
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(target: "media_core::tmdb", "external_ids build client: {e}");
                return ExternalIds::default();
            }
        };
        let url = format!("{API_BASE}/{kind}/{id}/external_ids");
        let resp = match client.get(&url).query(&[("api_key", api_key)]).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(target: "media_core::tmdb", "external_ids send failed: {e}");
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
                tracing::warn!(target: "media_core::tmdb", "external_ids json failed: {e}");
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
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| {
                tracing::warn!(target: "media_core::tmdb", "episode build client: {e}");
            })
            .ok()?;
        let url = format!("{API_BASE}/tv/{show_tmdb_id}/season/{season}/episode/{episode}");
        let send = || async { client.get(&url).query(&[("api_key", api_key)]).send().await };
        let resp = match send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(target: "media_core::tmdb", "episode send failed: {e}");
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
                    tracing::warn!(target: "media_core::tmdb", "episode retry send failed: {e}");
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
                tracing::warn!(target: "media_core::tmdb", "episode json failed: {e}");
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
        let mut found = match self.search(url, title, year, is_movie).await {
            Ok(m) => m?,
            Err(e) => {
                tracing::warn!(
                    target: "media_core::tmdb",
                    "search failed for {title:?}: {e}"
                );
                return None;
            }
        };
        // Guard against a wrong-but-confident `results[0]`: score the queried
        // title/year against the chosen result and reject below the floor
        // BEFORE any external_ids enrichment, so a wrong id is never written.
        let score = match_confidence(title, year, &found.title, found.year);
        if score < MIN_MATCH_CONFIDENCE {
            tracing::warn!(
                target: "media_core::tmdb",
                "rejected low-confidence match for {title:?}: got {:?} (score {:.2})",
                found.title, score
            );
            return None;
        }
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
        let m = parse_search_response(&doc, true).expect("expected a match");
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
        let m = parse_search_response(&doc, false).expect("expected a match");
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
        assert_eq!(parse_search_response(&doc, true), None);
    }

    #[test]
    fn missing_results_key_yields_none() {
        let doc = json!({ "page": 1 });
        assert_eq!(parse_search_response(&doc, true), None);
    }

    #[test]
    fn missing_id_yields_none() {
        let doc = json!({ "results": [ { "title": "No Id" } ] });
        assert_eq!(parse_search_response(&doc, true), None);
    }

    #[test]
    fn missing_title_yields_none() {
        let doc = json!({ "results": [ { "id": 5, "release_date": "1999-01-01" } ] });
        assert_eq!(parse_search_response(&doc, true), None);
    }

    #[test]
    fn missing_date_yields_match_with_no_year() {
        let doc = json!({ "results": [ { "id": 7, "title": "Dateless" } ] });
        let m = parse_search_response(&doc, true).expect("expected a match");
        assert_eq!(m.tmdb_id, 7);
        assert_eq!(m.year, None);
    }

    #[test]
    fn malformed_date_yields_no_year() {
        let doc = json!({ "results": [ { "id": 8, "title": "Short", "release_date": "20" } ] });
        let m = parse_search_response(&doc, true).expect("expected a match");
        assert_eq!(m.year, None);
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

    #[test]
    fn confidence_exact_title_and_year_is_one() {
        // Identical normalized titles → Jaccard 1.0; equal years → 1.0. Exact.
        assert_eq!(
            match_confidence("Interstellar", Some(2014), "Interstellar", Some(2014)),
            1.0
        );
    }

    #[test]
    fn confidence_exact_title_year_off_by_one_still_accepts() {
        // 0.8*1.0 + 0.2*0.5 = 0.9
        let score = match_confidence("Interstellar", Some(2014), "Interstellar", Some(2015));
        assert!((score - 0.9).abs() < 1e-9);
        assert!(score >= MIN_MATCH_CONFIDENCE);
    }

    #[test]
    fn confidence_wrong_title_is_rejected() {
        let score = match_confidence("Interstellar", Some(2014), "The Notebook", Some(2004));
        assert!(score < MIN_MATCH_CONFIDENCE);
    }

    #[test]
    fn confidence_partial_title_overlap() {
        // tokens {the,matrix} vs {matrix,reloaded}: Jaccard 1/3 ≈ 0.333;
        // year neutral (None) → 0.8*0.333 + 0.2*1.0 ≈ 0.4667 < 0.5.
        let score = match_confidence("The Matrix", None, "Matrix Reloaded", None);
        assert!((score - 0.4667).abs() < 0.01);
        assert!(score < MIN_MATCH_CONFIDENCE);
    }

    #[test]
    fn confidence_no_query_year_uses_neutral_year() {
        // Year neutral when not queried → exact 1.0.
        assert_eq!(
            match_confidence("Severance", None, "Severance", Some(2022)),
            1.0
        );
    }

    #[test]
    fn confidence_year_known_vs_unknown_mild_penalty() {
        // 0.8*1.0 + 0.2*0.5 = 0.9
        let score = match_confidence("Dune", Some(2021), "Dune", None);
        assert!((score - 0.9).abs() < 1e-9);
        assert!(score >= MIN_MATCH_CONFIDENCE);
    }

    #[test]
    fn confidence_empty_query_title_is_zero() {
        // Empty query title → empty token set → title score 0.0.
        let score = match_confidence("", Some(2000), "Something", Some(2000));
        assert!(score < MIN_MATCH_CONFIDENCE);
    }

    #[test]
    fn confidence_normalization_ignores_quality_tokens() {
        // Both normalize toward "adventure time" via normalize_show_name.
        let score = match_confidence(
            "adventure.time.2008.1080p.bluray.x265",
            Some(2008),
            "Adventure Time",
            Some(2008),
        );
        assert!(score >= MIN_MATCH_CONFIDENCE);
    }
}
