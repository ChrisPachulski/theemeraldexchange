//! Best-effort TMDB metadata resolution. NEVER blocks a scan: any error or
//! a missing API key yields `None` and the file is kept with filename-derived
//! title only.
//!
//! OWNER: agent C. Implement the search calls with `reqwest`. Use
//! `https://api.themoviedb.org/3/search/movie` and `/search/tv` with the
//! `api_key` query param. Return the top result. Add a timeout (≈5s) and
//! swallow all network/parse errors into `None`.

use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TmdbMatch {
    pub tmdb_id: i64,
    pub title: String,
    pub year: Option<i64>,
}

#[derive(Clone)]
pub struct TmdbClient {
    pub api_key: Option<String>,
}

const SEARCH_MOVIE_URL: &str = "https://api.themoviedb.org/3/search/movie";
const SEARCH_TV_URL: &str = "https://api.themoviedb.org/3/search/tv";

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
/// id, title (`title` for movies, `name` for tv), and year. Returns `None` when
/// there is no first result or it lacks an id/title.
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

    Some(TmdbMatch {
        tmdb_id,
        title: title.to_string(),
        year,
    })
}

impl TmdbClient {
    pub fn new(api_key: Option<String>) -> Self {
        Self { api_key }
    }

    async fn search(
        &self,
        url: &str,
        title: &str,
        year: Option<i64>,
        is_movie: bool,
    ) -> Option<TmdbMatch> {
        let api_key = self.api_key.as_deref()?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .ok()?;

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

        let resp = client.get(url).query(&query).send().await.ok()?;
        let doc = resp.json::<serde_json::Value>().await.ok()?;
        parse_search_response(&doc, is_movie)
    }

    /// Search TMDB for a movie. Returns `None` if no key, no match, or any error.
    pub async fn match_movie(&self, title: &str, year: Option<i64>) -> Option<TmdbMatch> {
        self.search(SEARCH_MOVIE_URL, title, year, true).await
    }

    /// Search TMDB for a TV show. Returns `None` if no key, no match, or any error.
    pub async fn match_show(&self, title: &str, year: Option<i64>) -> Option<TmdbMatch> {
        self.search(SEARCH_TV_URL, title, year, false).await
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
                { "id": 157336, "title": "Interstellar", "release_date": "2014-11-07" },
                { "id": 1, "title": "Other", "release_date": "2000-01-01" }
            ]
        });
        let m = parse_search_response(&doc, true).expect("expected a match");
        assert_eq!(m.tmdb_id, 157336);
        assert_eq!(m.title, "Interstellar");
        assert_eq!(m.year, Some(2014));
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
