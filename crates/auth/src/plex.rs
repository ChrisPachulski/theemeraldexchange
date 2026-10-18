//! The plex.tv and Plex Media Server (PMS) client, the port of `plex.ts`:
//! only what PIN sign-in, the session gate and the Users tab need. Plex is
//! optional: with PLEX_CLIENT_ID unset every plex.tv call is
//! [`PlexError::NotConfigured`] and nothing else in the server cares.
//!
//! PINs are created by the clients (web SPA, tvOS/iOS), never here: a
//! server-side create put the host's IP on plex.tv's sign-in page. The server
//! only polls the PIN with the same public client id.
//!
//! PIN ids and the client id are login artifacts and never reach the logs;
//! [`Plex::check_pin`] logs only whether a token came back. Tests point
//! [`Plex::at`] at a local fake; the PMS base is `Config::plex_server_url`.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use axum::http::header::{ACCEPT, RETRY_AFTER};
use regex::Regex;
use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::Config;

mod signin;
pub(crate) use signin::routes;

pub const PLEX_TV: &str = "https://plex.tv";
/// The product plex.tv names on its sign-in page; the clients create their
/// PINs under the same label.
pub const PLEX_PRODUCT: &str = "The Emerald Exchange";
/// plex.tv crosses the WAN.
const WAN_TIMEOUT: Duration = Duration::from_secs(10);
/// The best-effort friend lists, so a slow plex.tv cannot hold /api/users.
const LIST_TIMEOUT: Duration = Duration::from_secs(5);
const RATE_LIMIT_FALLBACK: &str = "5";
const RATE_LIMIT_LOG_MAX_SECONDS: u64 = 30;
/// JS Number.MAX_SAFE_INTEGER: synthesized ids stay exact in the SPA.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, thiserror::Error)]
pub enum PlexError {
    /// PLEX_CLIENT_ID unset: the routes answer 503 plex_not_configured.
    #[error("plex is not configured (missing credentials)")]
    NotConfigured,
    /// plex.tv backpressure on a PIN poll, kept apart from our own limits.
    /// `retry_after` is digits or an HTTP-date, else "5"; the seconds are
    /// for logs only, clamped to 0-30.
    #[error("Plex PIN polling rate-limited")]
    RateLimited {
        retry_after: String,
        retry_after_seconds: u64,
    },
    #[error("plex.{op} failed: {status}")]
    Status { op: &'static str, status: u16 },
    /// Connect failure, timeout or a cut-off body.
    #[error("plex.{op} unreachable")]
    Unreachable { op: &'static str },
    #[error("plex.{op} returned an unreadable body")]
    Body { op: &'static str },
}

pub type Result<T> = std::result::Result<T, PlexError>;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Pin {
    pub id: i64,
    #[serde(default)]
    pub code: String,
    #[serde(rename = "authToken", default)]
    pub auth_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PlexUser {
    pub id: i64,
    #[serde(default)]
    pub uuid: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub thumb: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlexResource {
    pub name: String,
    pub client_identifier: String,
    pub owned: bool,
    pub home: bool,
    pub provides: String,
}

/// The session gate needs revoked (401/403) told apart from an outage
/// (5xx, network): only the first signs the user out.
#[derive(Debug, Clone, PartialEq)]
pub enum Probe {
    Ok(Vec<PlexResource>),
    HttpError(u16),
    NetworkError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FriendStatus {
    Accepted,
    Pending,
}

/// One row of the Users tab.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlexFriend {
    pub id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub email: Option<String>,
    pub thumb: Option<String>,
    pub status: FriendStatus,
}

pub struct Plex {
    tv: String,
    http: reqwest::Client,
}

impl Default for Plex {
    fn default() -> Plex {
        Plex::at(PLEX_TV)
    }
}

impl Plex {
    /// plex.tv at another base URL (tests serve a fake locally).
    pub fn at(tv: &str) -> Plex {
        Plex {
            tv: tv.trim_end_matches('/').to_string(),
            // No redirects: X-Plex-Token must never follow one off-host.
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client builds"),
        }
    }

    /// An /api/v2 request with the X-Plex-* headers.
    fn v2(
        &self,
        config: &Config,
        method: Method,
        path: &str,
        token: Option<&str>,
    ) -> Result<RequestBuilder> {
        let req = self
            .http
            .request(method, format!("{}/api/v2{path}", self.tv))
            .header(ACCEPT, "application/json")
            .header("X-Plex-Product", PLEX_PRODUCT)
            .header("X-Plex-Client-Identifier", client_id(config)?)
            .header("X-Plex-Version", "0.1.0")
            .header("X-Plex-Platform", "Web")
            .header("X-Plex-Device", PLEX_PRODUCT);
        Ok(match token {
            Some(t) => req.header("X-Plex-Token", t),
            None => req,
        })
    }

    /// A legacy XML endpoint on plex.tv.
    fn xml(&self, config: &Config, url: reqwest::Url, token: &str) -> Result<RequestBuilder> {
        Ok(self
            .http
            .get(url)
            .header("X-Plex-Product", PLEX_PRODUCT)
            .header("X-Plex-Client-Identifier", client_id(config)?)
            .header("X-Plex-Token", token)
            .header(ACCEPT, "application/xml"))
    }

    fn tv_url(&self, path: &str) -> reqwest::Url {
        reqwest::Url::parse(&format!("{}{path}", self.tv)).expect("plex.tv base URL parses")
    }

    /// Poll a client-created PIN until it carries an authToken.
    pub async fn check_pin(&self, config: &Config, pin_id: i64) -> Result<Pin> {
        const OP: &str = "checkPin";
        let req = self.v2(config, Method::GET, &format!("/pins/{pin_id}"), None)?;
        let res = send(req, WAN_TIMEOUT, OP).await?;
        if res.status() == StatusCode::TOO_MANY_REQUESTS {
            let retry_after = normalized_retry_after(
                res.headers().get(RETRY_AFTER).and_then(|v| v.to_str().ok()),
            );
            return Err(PlexError::RateLimited {
                retry_after_seconds: retry_after_seconds(&retry_after),
                retry_after,
            });
        }
        if !res.status().is_success() {
            let status = res.status().as_u16();
            tracing::error!(event = "plex", op = OP, status, "plex.checkPin failed");
            return Err(PlexError::Status { op: OP, status });
        }
        let pin: Pin = json(res, OP).await?;
        tracing::info!(
            event = "plex",
            op = OP,
            token_present = pin.auth_token.as_deref().is_some_and(|t| !t.is_empty()),
            "plex.checkPin ok"
        );
        Ok(pin)
    }

    /// The account behind an authToken.
    pub async fn get_user(&self, config: &Config, token: &str) -> Result<PlexUser> {
        const OP: &str = "getUser";
        let req = self.v2(config, Method::GET, "/user", Some(token))?;
        json(ok(send(req, WAN_TIMEOUT, OP).await?, OP)?, OP).await
    }

    /// Every resource the token can see (its own servers and shares). Never
    /// errors: a missing client id, a timeout or a bad body all read as
    /// `NetworkError`, so the gate fails open.
    pub async fn probe_resources(&self, config: &Config, token: &str) -> Probe {
        const OP: &str = "probeResources";
        let Ok(req) = self.v2(
            config,
            Method::GET,
            "/resources?includeHttps=1",
            Some(token),
        ) else {
            return Probe::NetworkError;
        };
        match send(req, WAN_TIMEOUT, OP).await {
            Err(_) => Probe::NetworkError,
            Ok(res) if !res.status().is_success() => Probe::HttpError(res.status().as_u16()),
            Ok(res) => json(res, OP).await.map_or(Probe::NetworkError, Probe::Ok),
        }
    }

    pub async fn sign_out(&self, config: &Config, token: &str) -> Result<()> {
        const OP: &str = "signOut";
        let req = self.v2(config, Method::POST, "/signout", Some(token))?;
        ok(send(req, WAN_TIMEOUT, OP).await?, OP).map(drop)
    }

    /// Accepted shares, from the legacy /api/users XML (python-plexapi's
    /// MyPlexAccount.users()).
    pub async fn list_accepted_users(
        &self,
        config: &Config,
        token: &str,
    ) -> Result<Vec<PlexFriend>> {
        const OP: &str = "listAcceptedUsers";
        let req = self.xml(config, self.tv_url("/api/users"), token)?;
        let res = ok(send(req, WAN_TIMEOUT, OP).await?, OP)?;
        Ok(parse_users(&text(res, OP).await?))
    }

    /// Invites the owner sent that are not accepted yet. 404 means none; the
    /// body is a raw array or `{friends: [...]}` depending on the account.
    pub async fn list_pending_invites(
        &self,
        config: &Config,
        token: &str,
    ) -> Result<Vec<PlexFriend>> {
        const OP: &str = "listPendingInvites";
        let req = self.v2(config, Method::GET, "/friends/requested", Some(token))?;
        let Some(res) = ok_or_404(send(req, LIST_TIMEOUT, OP).await?, OP)? else {
            return Ok(Vec::new());
        };
        let bytes = res
            .bytes()
            .await
            .map_err(|_| PlexError::Unreachable { op: OP })?;
        Ok(parse_pending(
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        ))
    }

    /// Every share on our server (catches recipients /api/users misses).
    /// Empty without PLEX_SERVER_ID.
    pub async fn list_shared_server_invitees(
        &self,
        config: &Config,
        token: &str,
    ) -> Result<Vec<PlexFriend>> {
        const OP: &str = "listSharedServerInvitees";
        let Some(server_id) = config.plex_server_id.as_deref() else {
            return Ok(Vec::new());
        };
        let mut url = self.tv_url("/api/servers");
        url.path_segments_mut()
            .expect("plex.tv base URL has a path")
            .extend([server_id, "shared_servers"]);
        let req = self.xml(config, url, token)?;
        match ok_or_404(send(req, LIST_TIMEOUT, OP).await?, OP)? {
            Some(res) => Ok(parse_shared_servers(&text(res, OP).await?)),
            None => Ok(Vec::new()),
        }
    }

    /// Every account that ever used our PMS (current, revoked, managed),
    /// from the PMS itself: what Tautulli's Top Users reads.
    pub async fn list_local_server_accounts(
        &self,
        config: &Config,
        token: &str,
    ) -> Result<Vec<PlexFriend>> {
        const OP: &str = "listLocalServerAccounts";
        let req = self
            .http
            .get(format!(
                "{}/accounts",
                config.plex_server_url.trim_end_matches('/')
            ))
            .header("X-Plex-Token", token)
            .header(ACCEPT, "application/xml");
        match ok_or_404(send(req, LIST_TIMEOUT, OP).await?, OP)? {
            Some(res) => Ok(parse_accounts(&text(res, OP).await?)),
            None => Ok(Vec::new()),
        }
    }

    /// Plex Home profiles under the owner's account (not shares).
    pub async fn list_home_users(&self, config: &Config, token: &str) -> Result<Vec<PlexFriend>> {
        const OP: &str = "listHomeUsers";
        let req = self.xml(config, self.tv_url("/api/home/users"), token)?;
        match ok_or_404(send(req, LIST_TIMEOUT, OP).await?, OP)? {
            Some(res) => Ok(parse_users(&text(res, OP).await?)),
            None => Ok(Vec::new()),
        }
    }
}

fn client_id(config: &Config) -> Result<&str> {
    config
        .plex_client_id
        .as_deref()
        .ok_or(PlexError::NotConfigured)
}

/// The reqwest error is not logged: its Display carries the URL, and a PIN
/// URL carries the PIN id.
async fn send(req: RequestBuilder, timeout: Duration, op: &'static str) -> Result<Response> {
    req.timeout(timeout).send().await.map_err(|e| {
        tracing::error!(
            event = "plex",
            op,
            timeout = e.is_timeout(),
            "plex upstream unreachable"
        );
        PlexError::Unreachable { op }
    })
}

fn ok(res: Response, op: &'static str) -> Result<Response> {
    if res.status().is_success() {
        Ok(res)
    } else {
        Err(PlexError::Status {
            op,
            status: res.status().as_u16(),
        })
    }
}

fn ok_or_404(res: Response, op: &'static str) -> Result<Option<Response>> {
    if res.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    ok(res, op).map(Some)
}

async fn json<T: serde::de::DeserializeOwned>(res: Response, op: &'static str) -> Result<T> {
    let bytes = res
        .bytes()
        .await
        .map_err(|_| PlexError::Unreachable { op })?;
    serde_json::from_slice(&bytes).map_err(|_| PlexError::Body { op })
}

async fn text(res: Response, op: &'static str) -> Result<String> {
    res.text().await.map_err(|_| PlexError::Unreachable { op })
}

// ── Retry-After ──

/// The three HTTP-date forms (IMF-fixdate, RFC 850, asctime), exactly.
fn http_date_patterns() -> &'static [Regex; 3] {
    static R: OnceLock<[Regex; 3]> = OnceLock::new();
    R.get_or_init(|| {
        const DAY: &str = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
        const MON: &str = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
        const TIME: &str = "(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]";
        [
            format!("^{DAY}, (?:0[1-9]|[12][0-9]|3[01]) {MON} [0-9]{{4}} {TIME} GMT$"),
            format!(
                "^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \
                 (?:0[1-9]|[12][0-9]|3[01])-{MON}-[0-9]{{2}} {TIME} GMT$"
            ),
            format!("^{DAY} {MON} (?: [1-9]|[12][0-9]|3[01]) {TIME} [0-9]{{4}}$"),
        ]
        .map(|p| Regex::new(&p).expect("static regex"))
    })
}

/// An HTTP-date as UTC. Like JS Date.parse the weekday is not checked.
// ponytail: RFC 850's two-digit year follows chrono (00-68 = 20xx), JS
// puts 50-68 in the 1900s; it only moves a clamped log figure.
fn parse_http_date(v: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let [imf, rfc850, asctime] = http_date_patterns();
    let (rest, fmt) = if imf.is_match(v) {
        (&v[5..], "%d %b %Y %H:%M:%S GMT")
    } else if rfc850.is_match(v) {
        (v.split_once(", ")?.1, "%d-%b-%y %H:%M:%S GMT")
    } else if asctime.is_match(v) {
        (&v[4..], "%b %e %H:%M:%S %Y")
    } else {
        return None;
    };
    chrono::NaiveDateTime::parse_from_str(rest, fmt)
        .ok()
        .map(|t| t.and_utc())
}

fn is_digits(v: &str) -> bool {
    !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())
}

/// Plex's Retry-After passes through only as digits or an HTTP-date.
fn normalized_retry_after(value: Option<&str>) -> String {
    match value.map(crate::js_trim) {
        Some(v) if is_digits(v) || parse_http_date(v).is_some() => v.to_string(),
        _ => RATE_LIMIT_FALLBACK.to_string(),
    }
}

/// Seconds to wait, for the logs: 0-30.
fn retry_after_seconds(retry_after: &str) -> u64 {
    let max = RATE_LIMIT_LOG_MAX_SECONDS;
    if is_digits(retry_after) {
        return retry_after.parse::<u64>().map_or(max, |n| n.min(max));
    }
    match parse_http_date(retry_after) {
        Some(t) => {
            let ms = (t - chrono::Utc::now()).num_milliseconds();
            (ms.div_euclid(1000) + i64::from(ms.rem_euclid(1000) > 0)).clamp(0, max as i64) as u64
        }
        None => RATE_LIMIT_FALLBACK.parse().unwrap(),
    }
}

// ── The friend-list payloads ──

fn unescape_xml(s: &str) -> String {
    // Same order as plex.ts, so `&amp;lt;` decodes twice there and here.
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// The unescaped attributes of every `<tag .../>` element. A regex, not an
/// XML parser: Plex's payloads are flat attribute lists.
fn element_attrs(xml: &str, tag: &str) -> Vec<HashMap<String, String>> {
    static ATTR: OnceLock<Regex> = OnceLock::new();
    let attr =
        ATTR.get_or_init(|| Regex::new(r#"([A-Za-z0-9_]+)="([^"]*)""#).expect("static regex"));
    let element = Regex::new(&format!(r"<{tag}\s+([^>]+?)/?>")).expect("tag regex");
    element
        .captures_iter(xml)
        .map(|m| {
            attr.captures_iter(&m[1])
                .map(|a| (a[1].to_string(), unescape_xml(&a[2])))
                .collect()
        })
        .collect()
}

/// JS `Number(attr)` for the integer ids Plex sends: absent is NaN, "" is 0.
fn js_number(v: Option<&str>) -> Option<i64> {
    let v = crate::js_trim(v?);
    if v.is_empty() {
        return Some(0);
    }
    v.parse().ok()
}

/// A non-empty attribute (JS `attrs.x || ...`).
fn attr<'a>(a: &'a HashMap<String, String>, k: &str) -> Option<&'a str> {
    a.get(k).map(String::as_str).filter(|v| !v.is_empty())
}

fn parse_users(xml: &str) -> Vec<PlexFriend> {
    element_attrs(xml, "User")
        .iter()
        .filter_map(|a| {
            Some(PlexFriend {
                id: js_number(a.get("id").map(String::as_str))?,
                username: attr(a, "username")
                    .or(attr(a, "title"))
                    .unwrap_or_default()
                    .into(),
                title: attr(a, "title").or(attr(a, "username")).map(Into::into),
                email: attr(a, "email").map(Into::into),
                thumb: attr(a, "thumb").map(Into::into),
                status: FriendStatus::Accepted,
            })
        })
        .collect()
}

fn parse_shared_servers(xml: &str) -> Vec<PlexFriend> {
    element_attrs(xml, "SharedServer")
        .iter()
        .filter_map(|a| {
            // The Plex account id (userID) over the share's own id.
            let id = js_number(attr(a, "userID").or(a.get("id").map(String::as_str)))?;
            let name = attr(a, "username").or(attr(a, "email"))?;
            Some(PlexFriend {
                id,
                username: name.into(),
                title: Some(name.into()),
                email: attr(a, "email").map(Into::into),
                thumb: None,
                status: if a.get("accepted").is_some_and(|v| v == "0") {
                    FriendStatus::Pending
                } else {
                    FriendStatus::Accepted
                },
            })
        })
        .collect()
}

fn parse_accounts(xml: &str) -> Vec<PlexFriend> {
    element_attrs(xml, "Account")
        .iter()
        .filter_map(|a| {
            let id = js_number(a.get("id").map(String::as_str))?;
            // Account 0 is anonymous local playback.
            let name = attr(a, "name").filter(|_| id != 0)?;
            Some(PlexFriend {
                id,
                username: name.into(),
                title: Some(name.into()),
                email: None,
                thumb: attr(a, "thumb").map(Into::into),
                status: FriendStatus::Accepted,
            })
        })
        .collect()
}

fn parse_pending(raw: Value) -> Vec<PlexFriend> {
    let records = match raw {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("friends") {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    records
        .iter()
        .filter_map(|r| {
            let s = |k: &str| r.get(k).and_then(Value::as_str);
            let truthy = |k: &str| s(k).filter(|v| !v.is_empty());
            // `email ?? invitedEmail`: an empty email string still wins.
            let email = s("email").or(s("invitedEmail"));
            let some_email = email.filter(|v| !v.is_empty());
            let title = truthy("friendlyName")
                .or(truthy("title"))
                .or(truthy("username"))
                .or(some_email)
                .unwrap_or_default();
            let username = truthy("username").or(some_email).unwrap_or_default();
            if title.is_empty() && username.is_empty() {
                return None;
            }
            let id = r.get("id").and_then(Value::as_i64).unwrap_or_else(|| {
                // Email-only invites have no account id yet: a stable negative
                // one that cannot collide with a real id.
                -stable_hash(some_email.unwrap_or(title))
            });
            Some(PlexFriend {
                id,
                username: username.into(),
                title: Some(title.into()),
                email: email.map(Into::into),
                thumb: s("thumb").map(Into::into),
                status: FriendStatus::Pending,
            })
        })
        .collect()
}

/// sha256, first 8 bytes big-endian, mod MAX_SAFE_INTEGER, plus 1.
fn stable_hash(s: &str) -> i64 {
    let digest = Sha256::digest(s.as_bytes());
    let head = u64::from_be_bytes(digest[..8].try_into().expect("8 bytes"));
    (head % MAX_SAFE_INTEGER + 1) as i64
}

#[cfg(test)]
pub(crate) mod tests;
