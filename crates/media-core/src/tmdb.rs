//! Best-effort TMDB metadata resolution. NEVER blocks a scan: any error or
//! a missing API key yields `None` and the file is kept with filename-derived
//! title only.
//!
//! OWNER: agent C. Implement the search calls with `reqwest`. Use
//! `https://api.themoviedb.org/3/search/movie` and `/search/tv` with the
//! `api_key` query param. Return the top result. Add a timeout (≈5s) and
//! swallow all network/parse errors into `None`.

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

impl TmdbClient {
    pub fn new(api_key: Option<String>) -> Self {
        Self { api_key }
    }

    /// Search TMDB for a movie. Returns `None` if no key, no match, or any error.
    pub async fn match_movie(&self, _title: &str, _year: Option<i64>) -> Option<TmdbMatch> {
        todo!("AGENT C: TMDB movie search via reqwest; swallow errors to None")
    }

    /// Search TMDB for a TV show. Returns `None` if no key, no match, or any error.
    pub async fn match_show(&self, _title: &str, _year: Option<i64>) -> Option<TmdbMatch> {
        todo!("AGENT C: TMDB tv search via reqwest; swallow errors to None")
    }
}
