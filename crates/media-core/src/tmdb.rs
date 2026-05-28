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
        let resp = match client.get(&url).query(&[("api_key", api_key)]).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(target: "media_core::tmdb", "episode send failed: {e}");
                return None;
            }
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
}
