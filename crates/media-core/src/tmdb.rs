//! Best-effort TMDB metadata resolution. NEVER blocks a scan: any error or
//! a missing API key yields `None` and the file is kept with filename-derived
//! title only. Failures are logged via `tracing::warn!` (not silently
//! swallowed) so a misconfigured key or rate-limit is visible, then converted
//! to `None` at the public `match_*` boundary.
//!
//! Uses `https://api.themoviedb.org/3/search/{movie,tv}` with the `api_key`
//! query param for the title hit, then `/{movie,tv}/{id}/external_ids` to fill
//! `imdb_id` (the search endpoints never return it). 5s timeout per request.

use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TmdbMatch {
    pub tmdb_id: i64,
    pub title: String,
    pub year: Option<i64>,
    pub imdb_id: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
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
        overview,
        poster_path,
    })
}

/// Pure parser over an `/external_ids` response: pulls a non-empty `imdb_id`.
fn parse_external_ids(doc: &serde_json::Value) -> Option<String> {
    doc.get("imdb_id")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
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

    /// Fetch the IMDb id for a TMDB title via `/{movie|tv}/{id}/external_ids`.
    /// Logs and returns `None` on any failure.
    async fn external_ids(&self, kind: &str, id: i64) -> Option<String> {
        let api_key = self.api_key.as_deref()?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .ok()?;
        let url = format!("{API_BASE}/{kind}/{id}/external_ids");
        let resp = match client.get(&url).query(&[("api_key", api_key)]).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(target: "media_core::tmdb", "external_ids send failed: {e}");
                return None;
            }
        };
        if !resp.status().is_success() {
            tracing::warn!(
                target: "media_core::tmdb",
                "external_ids non-2xx: {}",
                resp.status()
            );
            return None;
        }
        match resp.json::<serde_json::Value>().await {
            Ok(doc) => parse_external_ids(&doc),
            Err(e) => {
                tracing::warn!(target: "media_core::tmdb", "external_ids json failed: {e}");
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
        found.imdb_id = self.external_ids(kind, found.tmdb_id).await;
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
    fn external_ids_parses_imdb_id() {
        let doc = json!({ "imdb_id": "tt0816692", "tvdb_id": 123 });
        assert_eq!(parse_external_ids(&doc), Some("tt0816692".to_string()));
    }

    #[test]
    fn external_ids_empty_yields_none() {
        let doc = json!({ "imdb_id": "" });
        assert_eq!(parse_external_ids(&doc), None);
        let doc2 = json!({ "tvdb_id": 1 });
        assert_eq!(parse_external_ids(&doc2), None);
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
