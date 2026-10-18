//! The one outbound HTTP client (services/upstream.ts, arr.ts, sab.ts).
//!
//! [`Upstream::fetch`] reads the whole response inside a timeout and never
//! fails: a timeout or a connect/DNS error becomes a synthesized 504
//! `{error, service, message}`, so every route's "non-2xx" branch handles it.
//! An unconfigured integration is [`Error::NotConfigured`] (503
//! `<svc>_not_configured`), and an *arr 401 (this server's API key, not the
//! browser's cookie) becomes 502 `<svc>_auth_failed`.

use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::config::Config;

/// Sonarr/Radarr/SAB on the LAN; covers Sonarr's slower operations.
pub const LAN_TIMEOUT: Duration = Duration::from_secs(15);
/// TMDB and other WAN APIs.
pub const WAN_TIMEOUT: Duration = Duration::from_secs(10);
/// *arr interactive search and grab (GET/POST /release): live indexer
/// queries take 20-60 s; kept under the client's 60 s abort.
pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(50);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The integration has no credentials: a hidden feature, not an incident.
    #[error("{0} is not configured (missing credentials)")]
    NotConfigured(&'static str),
    /// An internal-service call without INTERNAL_PRINCIPAL_SECRET (dev only;
    /// production refuses to boot without it).
    #[error("INTERNAL_PRINCIPAL_SECRET is not set")]
    NoPrincipalSecret,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        match self {
            Error::NotConfigured(svc) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({ "error": format!("{svc}_not_configured") })),
            )
                .into_response(),
            Error::NoPrincipalSecret => {
                tracing::error!(event = "upstream", "{self}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "internal" })),
                )
                    .into_response()
            }
        }
    }
}

/// A fully read upstream response.
#[derive(Debug)]
pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Reply {
    fn json(status: StatusCode, body: &impl Serialize) -> Reply {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        Reply {
            status,
            headers,
            body: serde_json::to_vec(body).expect("serializes").into(),
        }
    }

    pub fn is_success(&self) -> bool {
        self.status.is_success()
    }
}

/// Forwarded as the routes forward it: status, Content-Type and body.
impl IntoResponse for Reply {
    fn into_response(self) -> Response {
        let mut res = (self.status, self.body).into_response();
        if let Some(ct) = self.headers.get(header::CONTENT_TYPE) {
            res.headers_mut().insert(header::CONTENT_TYPE, ct.clone());
        }
        res
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arr {
    Sonarr,
    Radarr,
}

impl Arr {
    pub fn as_str(self) -> &'static str {
        match self {
            Arr::Sonarr => "sonarr",
            Arr::Radarr => "radarr",
        }
    }
}

/// Cheap to clone: one connection pool for every upstream.
#[derive(Clone, Default)]
pub struct Upstream {
    client: reqwest::Client,
}

impl Upstream {
    /// Send `req` and read the body, all inside `timeout`. Never errors.
    pub async fn fetch(
        &self,
        req: reqwest::RequestBuilder,
        timeout: Duration,
        label: &str,
    ) -> Reply {
        let send = async {
            let res = req.send().await?;
            let status = res.status();
            let headers = res.headers().clone();
            let body = res.bytes().await?;
            Ok::<_, reqwest::Error>(Reply {
                status,
                headers,
                body,
            })
        };
        match tokio::time::timeout(timeout, send).await {
            Ok(Ok(reply)) => reply,
            // without_url: the SAB URL carries its apikey.
            Ok(Err(e)) => unreachable_reply("upstream_unreachable", label, &e.without_url()),
            Err(_) => unreachable_reply("upstream_timeout", label, &"This operation was aborted"),
        }
    }

    /// GET/POST/... `{base}{path}` on Sonarr or Radarr with its API key.
    /// `query` pairs replace any same-named pair already in `path`.
    // arrFetch's own parameters plus the config and service it closed over.
    #[allow(clippy::too_many_arguments)]
    pub async fn arr_fetch(
        &self,
        config: &Config,
        svc: Arr,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&serde_json::Value>,
        timeout: Duration,
    ) -> Result<Reply, Error> {
        let (base, key) = match svc {
            Arr::Sonarr => (&config.sonarr_url, &config.sonarr_api_key),
            Arr::Radarr => (&config.radarr_url, &config.radarr_api_key),
        };
        let key = key.as_deref().ok_or(Error::NotConfigured(svc.as_str()))?;
        let Some(url) = with_query(&format!("{base}{path}"), query) else {
            return Ok(unreachable_reply(
                "upstream_unreachable",
                svc.as_str(),
                &"Invalid URL",
            ));
        };
        let mut req = self
            .client
            .request(method, url)
            .header("X-Api-Key", key)
            .header(header::ACCEPT, "application/json");
        if let Some(body) = body {
            req = req.json(body);
        }
        Ok(auth_failure(
            self.fetch(req, timeout, svc.as_str()).await,
            svc.as_str(),
        ))
    }

    /// SAB's `/api?mode=...&output=json&apikey=...` (the key rides the query).
    pub async fn sab_call(
        &self,
        config: &Config,
        mode: &str,
        extra: &[(&str, &str)],
    ) -> Result<Reply, Error> {
        let key = config
            .sab_api_key
            .as_deref()
            .ok_or(Error::NotConfigured("sab"))?;
        let mut query = vec![("mode", mode), ("output", "json"), ("apikey", key)];
        query.extend_from_slice(extra);
        let Some(url) = with_query(&format!("{}/api", config.sab_url), &query) else {
            return Ok(unreachable_reply(
                "upstream_unreachable",
                "sab",
                &"Invalid URL",
            ));
        };
        Ok(self.fetch(self.client.get(url), LAN_TIMEOUT, "sab").await)
    }
}

/// An upstream 401 describes this server's credentials; 401 is reserved for
/// the browser's own authentication, so it never reaches the SPA as one.
pub fn auth_failure(reply: Reply, svc: &str) -> Reply {
    if reply.status != StatusCode::UNAUTHORIZED {
        return reply;
    }
    Reply::json(
        StatusCode::BAD_GATEWAY,
        &serde_json::json!({ "error": format!("{svc}_auth_failed") }),
    )
}

fn unreachable_reply(reason: &str, label: &str, message: &dyn std::fmt::Display) -> Reply {
    let message = message.to_string();
    tracing::error!(event = "upstream", "{label} {reason}: {message}");
    #[derive(Serialize)]
    struct Body<'a> {
        error: &'a str,
        service: &'a str,
        message: &'a str,
    }
    Reply::json(
        StatusCode::GATEWAY_TIMEOUT,
        &Body {
            error: reason,
            service: label,
            message: &message,
        },
    )
}

/// URLSearchParams#set for each pair: drop same-named pairs, then append.
fn with_query(url: &str, pairs: &[(&str, &str)]) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(url).ok()?;
    for (k, v) in pairs {
        let kept: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(n, _)| n != k)
            .map(|(n, v)| (n.into_owned(), v.into_owned()))
            .collect();
        url.query_pairs_mut()
            .clear()
            .extend_pairs(kept)
            .append_pair(k, v);
    }
    Some(url)
}

#[cfg(test)]
mod tests;
