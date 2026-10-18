//! Thin TMDB v3 client (port of workers/tmdb_client.py): bearer or api_key
//! query auth, a 40-per-10 s sliding-window limiter, and 5 attempts with
//! exponential backoff (0.5 s doubling, capped at 8 s) on transport errors,
//! 429 and 5xx. The api_key never reaches a log line or an error text.

use std::collections::VecDeque;
use std::time::Duration;

use reqwest::Url;
use serde_json::Value;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::config::Config;
use crate::{Error, Result};

pub const TMDB_BASE: &str = "https://api.themoviedb.org/3";
const ATTEMPTS: u32 = 5;
const BACKOFF_CAP: Duration = Duration::from_secs(8);
const TIMEOUT: Duration = Duration::from_secs(15);

pub enum Auth {
    Bearer(String),
    Query(String),
}

/// At most `capacity` calls per `window`.
pub struct RateLimit {
    capacity: usize,
    window: Duration,
    stamps: Mutex<VecDeque<Instant>>,
}

impl RateLimit {
    pub fn new(capacity: usize, window: Duration) -> Self {
        Self {
            capacity,
            window,
            stamps: Mutex::new(VecDeque::new()),
        }
    }

    pub async fn acquire(&self) {
        loop {
            let wait = {
                let mut stamps = self.stamps.lock().await;
                let now = Instant::now();
                while stamps.front().is_some_and(|&t| now - t >= self.window) {
                    stamps.pop_front();
                }
                if stamps.len() < self.capacity {
                    stamps.push_back(now);
                    return;
                }
                (stamps[0] + self.window).saturating_duration_since(now)
            };
            tokio::time::sleep(wait.max(Duration::from_millis(10))).await;
        }
    }
}

/// The wait after failed attempt `n` (1-based): base * 2^(n-1), at most 8 s
/// (tenacity's wait_exponential(multiplier=0.5, max=8)).
pub fn backoff(base: Duration, attempt: u32) -> Duration {
    base.saturating_mul(1 << (attempt - 1).min(16))
        .min(BACKOFF_CAP)
}

pub struct TmdbClient {
    http: reqwest::Client,
    base: String,
    api_key: Option<String>,
    pub(crate) limiter: RateLimit,
    pub(crate) backoff_base: Duration,
}

enum Failure {
    Retryable(String),
    Fatal(String),
}

impl TmdbClient {
    /// `base` is TMDB_BASE in production, a local fake in tests.
    pub fn new(auth: Auth, base: &str) -> Result<Self> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        let api_key = match auth {
            Auth::Bearer(token) => {
                let mut v = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|_| Error::Invalid("TMDB token is not a valid header value".into()))?;
                v.set_sensitive(true);
                headers.insert(reqwest::header::AUTHORIZATION, v);
                None
            }
            Auth::Query(key) => Some(key),
        };
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(TIMEOUT)
            // httpx did not follow redirects; a 3xx is a failed call.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| Error::Tmdb(e.without_url().to_string()))?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            api_key,
            limiter: RateLimit::new(40, Duration::from_secs(10)),
            backoff_base: Duration::from_millis(500),
        })
    }

    /// TMDB_READ_ACCESS_TOKEN (bearer) wins over TMDB_API_KEY (query).
    pub fn from_config(config: &Config) -> Result<Self> {
        let auth = match (&config.tmdb_read_access_token, &config.tmdb_api_key) {
            (Some(token), _) => Auth::Bearer(token.clone()),
            (None, Some(key)) => Auth::Query(key.clone()),
            (None, None) => {
                return Err(Error::Invalid(
                    "TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY is required".into(),
                ));
            }
        };
        Self::new(auth, TMDB_BASE)
    }

    /// The URL with the api_key value replaced, for logs and errors.
    fn redacted(&self, url: &Url) -> String {
        if !url.query_pairs().any(|(k, _)| k == "api_key") {
            return url.to_string();
        }
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| {
                let v = if k == "api_key" {
                    "<redacted>".into()
                } else {
                    v.into_owned()
                };
                (k.into_owned(), v)
            })
            .collect();
        let mut out = url.clone();
        out.query_pairs_mut().clear().extend_pairs(pairs);
        out.to_string()
    }

    /// Any text that might carry the key, with the key cut out.
    fn scrub(&self, text: String) -> String {
        match &self.api_key {
            Some(key) if !key.is_empty() => text.replace(key.as_str(), "<redacted>"),
            _ => text,
        }
    }

    pub async fn get(&self, path: &str, params: &[(&str, String)]) -> Result<Value> {
        let mut url = Url::parse(&format!("{}{path}", self.base))
            .map_err(|e| Error::Invalid(format!("bad TMDB url for {path:?}: {e}")))?;
        {
            let mut q = url.query_pairs_mut();
            q.extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
            if let Some(key) = &self.api_key {
                q.append_pair("api_key", key);
            }
        }
        let mut attempt = 1;
        loop {
            self.limiter.acquire().await;
            match self.attempt(&url).await {
                Ok(v) => return Ok(v),
                Err(Failure::Retryable(msg)) if attempt < ATTEMPTS => {
                    let wait = backoff(self.backoff_base, attempt);
                    tracing::debug!("TMDB attempt {attempt} failed ({msg}); retrying in {wait:?}");
                    tokio::time::sleep(wait).await;
                    attempt += 1;
                }
                Err(Failure::Retryable(msg) | Failure::Fatal(msg)) => return Err(Error::Tmdb(msg)),
            }
        }
    }

    async fn attempt(&self, url: &Url) -> std::result::Result<Value, Failure> {
        let transport = |e: reqwest::Error| {
            let e = e.without_url();
            let mut msg = e.to_string();
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                msg = format!("{msg}: {s}");
                src = s.source();
            }
            Failure::Retryable(self.scrub(msg))
        };
        let resp = self.http.get(url.clone()).send().await.map_err(transport)?;
        let status = resp.status();
        let shown = self.redacted(url);
        tracing::debug!("HTTP Request: GET {shown} \"{status}\"");
        if !status.is_success() {
            let msg = format!(
                "HTTP {} {} for GET {shown}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            );
            return Err(if status.as_u16() == 429 || status.is_server_error() {
                Failure::Retryable(msg)
            } else {
                Failure::Fatal(msg)
            });
        }
        let body = resp.bytes().await.map_err(transport)?;
        serde_json::from_slice(&body)
            .map_err(|e| Failure::Fatal(format!("invalid JSON from GET {shown}: {e}")))
    }

    pub async fn discover(
        &self,
        kind: &str,
        page: i64,
        vote_count_gte: i64,
        year_gte: i64,
        year_lte: i64,
    ) -> Result<Value> {
        validate_kind(kind)?;
        let date = if kind == "movie" {
            "primary_release_date"
        } else {
            "first_air_date"
        };
        let (gte, lte) = (format!("{date}.gte"), format!("{date}.lte"));
        self.get(
            &format!("/discover/{kind}"),
            &[
                ("page", page.to_string()),
                ("include_adult", "false".into()),
                ("vote_count.gte", vote_count_gte.to_string()),
                ("sort_by", "popularity.desc".into()),
                (&gte, format!("{year_gte}-01-01")),
                (&lte, format!("{year_lte}-12-31")),
            ],
        )
        .await
    }

    pub async fn detail(&self, kind: &str, tmdb_id: i64) -> Result<Value> {
        validate_kind(kind)?;
        if tmdb_id <= 0 {
            return Err(Error::Invalid(format!("unsupported TMDB id: {tmdb_id}")));
        }
        self.get(
            &format!("/{kind}/{tmdb_id}"),
            &[("append_to_response", "keywords,credits".into())],
        )
        .await
    }

    pub async fn changes(&self, kind: &str, start: &str, end: &str, page: i64) -> Result<Value> {
        validate_kind(kind)?;
        self.get(
            &format!("/{kind}/changes"),
            &[
                ("start_date", start.into()),
                ("end_date", end.into()),
                ("page", page.to_string()),
            ],
        )
        .await
    }
}

fn validate_kind(kind: &str) -> Result<()> {
    match kind {
        "movie" | "tv" => Ok(()),
        _ => Err(Error::Invalid(format!("unsupported TMDB kind: '{kind}'"))),
    }
}

#[cfg(test)]
mod tests;
