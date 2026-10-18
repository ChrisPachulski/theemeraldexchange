//! Fixed-window rate limits for the sign-in routes. Port of auth.ts's
//! enforceAuthRateLimit / enforceAuthIdentityRateLimit. Every request counts
//! against the kind's global bucket and, behind a trusted proxy, its client
//! bucket; routes that receive an identity token also count it against an
//! identity bucket, which bites even when client IPs are not trusted. A Plex
//! PIN poll also counts against its PIN's bucket.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::client_address;
use crate::outcome::{Reporter, Scope};

const WINDOW: Duration = Duration::from_secs(60);
/// Polls of one Plex PIN per minute: two normal sign-ins from one household
/// fit, a stuffing run against one PIN does not.
const PIN_LIMIT: u32 = 60;
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// Which route family a request belongs to; each has its own buckets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Device-link start.
    Pin,
    /// Device-link poll and Plex PIN poll (one shared set of buckets).
    Check,
    Apple,
    Google,
    Workos,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Pin => "pin",
            Kind::Check => "check",
            Kind::Apple => "apple",
            Kind::Google => "google",
            Kind::Workos => "workos",
        }
    }

    /// Per trusted client and per identity, per minute. Sign-in kinds are a
    /// verify plus an authZ decision each, with no innocuous polling.
    fn client_limit(self) -> u32 {
        match self {
            Kind::Pin => 10,
            Kind::Check => 300,
            Kind::Apple | Kind::Google | Kind::Workos => 20,
        }
    }

    fn global_limit(self) -> u32 {
        match self {
            Kind::Pin => 120,
            Kind::Check => 600,
            Kind::Apple | Kind::Google | Kind::Workos => 200,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    count: u32,
    reset_at: Instant,
}

struct Rule {
    key: String,
    scope: Scope,
    limit: u32,
}

struct Buckets {
    map: HashMap<String, Bucket>,
    last_sweep: Option<Instant>,
}

pub struct Limiter {
    trust_client_ip_headers: bool,
    buckets: Mutex<Buckets>,
}

impl Limiter {
    pub fn new(trust_client_ip_headers: bool) -> Limiter {
        Limiter {
            trust_client_ip_headers,
            buckets: Mutex::new(Buckets {
                map: HashMap::new(),
                last_sweep: None,
            }),
        }
    }

    /// Count the request against its global and trusted-client buckets, or
    /// the 429 (Retry-After, one rate_limited outcome) when one is full.
    // The 429 is the cold path; boxing it buys nothing.
    #[allow(clippy::result_large_err)]
    pub fn check(
        &self,
        headers: &HeaderMap,
        kind: Kind,
        outcome: &Reporter,
    ) -> Result<(), Response> {
        self.check_at(Instant::now(), headers, kind, None, outcome)
    }

    /// [`Limiter::check`] for a Plex PIN poll: the check kind's buckets plus,
    /// when the body named an integer pinId, that PIN's bucket. A malformed
    /// body consumes no PIN bucket.
    #[allow(clippy::result_large_err)]
    pub fn check_plex_pin(
        &self,
        headers: &HeaderMap,
        pin_id: Option<i64>,
        outcome: &Reporter,
    ) -> Result<(), Response> {
        self.check_at(Instant::now(), headers, Kind::Check, pin_id, outcome)
    }

    /// Count an attempted identity (rate-limit keying only, never an auth
    /// signal). None skips: there is nothing to key on. Randomising
    /// identities only splits an attacker's traffic, still capped globally;
    /// hammering one identity cannot escape its bucket. The key holds a
    /// truncated SHA-256, never the identity.
    #[allow(clippy::result_large_err)]
    pub fn check_identity(
        &self,
        kind: Kind,
        identity: Option<&str>,
        outcome: &Reporter,
    ) -> Result<(), Response> {
        self.check_identity_at(Instant::now(), kind, identity, outcome)
    }

    #[allow(clippy::result_large_err)]
    fn check_at(
        &self,
        now: Instant,
        headers: &HeaderMap,
        kind: Kind,
        pin_id: Option<i64>,
        outcome: &Reporter,
    ) -> Result<(), Response> {
        let mut rules = vec![Rule {
            key: format!("{}:global", kind.as_str()),
            scope: Scope::Global,
            limit: kind.global_limit(),
        }];
        if let Some((source, address)) =
            client_address::trusted(headers, self.trust_client_ip_headers)
        {
            rules.push(Rule {
                key: format!("{}:client:{source}:{address}", kind.as_str()),
                scope: Scope::TrustedClient,
                limit: kind.client_limit(),
            });
        }
        if let Some(pin) = pin_id {
            rules.push(Rule {
                key: format!("{}:pin:{pin}", kind.as_str()),
                scope: Scope::Pin,
                limit: PIN_LIMIT,
            });
        }
        self.apply(now, &rules, outcome)
    }

    #[allow(clippy::result_large_err)]
    fn check_identity_at(
        &self,
        now: Instant,
        kind: Kind,
        identity: Option<&str>,
        outcome: &Reporter,
    ) -> Result<(), Response> {
        let Some(identity) = identity.filter(|i| !i.is_empty()) else {
            return Ok(());
        };
        let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
        let rule = Rule {
            key: format!("{}:identity:{}", kind.as_str(), &digest[..16]),
            scope: Scope::Identity,
            limit: kind.client_limit(),
        };
        self.apply(now, &[rule], outcome)
    }

    /// All rules pass and each count goes up, or the first full bucket refuses
    /// and nothing is counted.
    #[allow(clippy::result_large_err)]
    fn apply(&self, now: Instant, rules: &[Rule], outcome: &Reporter) -> Result<(), Response> {
        let mut b = self.buckets.lock().unwrap();
        b.sweep(now);
        let current: Vec<Bucket> = rules
            .iter()
            .map(|r| {
                b.map
                    .get(&r.key)
                    .filter(|x| x.reset_at > now)
                    .copied()
                    .unwrap_or(Bucket {
                        count: 0,
                        reset_at: now + WINDOW,
                    })
            })
            .collect();
        if let Some((rule, bucket)) = rules.iter().zip(&current).find(|(r, x)| x.count >= r.limit) {
            b.map.insert(rule.key.clone(), *bucket);
            drop(b);
            return Err(reject(rule.scope, bucket.reset_at, now, outcome));
        }
        for (rule, mut bucket) in rules.iter().zip(current) {
            bucket.count += 1;
            b.map.insert(rule.key.clone(), bucket);
        }
        Ok(())
    }

    #[cfg(test)]
    fn bucket_count(&self) -> usize {
        self.buckets.lock().unwrap().map.len()
    }
}

impl Buckets {
    /// Drop expired buckets at most once a minute, so rotating keys cannot
    /// grow the map without bound.
    fn sweep(&mut self, now: Instant) {
        if self
            .last_sweep
            .is_some_and(|t| now.duration_since(t) < SWEEP_EVERY)
        {
            return;
        }
        self.last_sweep = Some(now);
        self.map.retain(|_, b| b.reset_at > now);
    }
}

fn reject(scope: Scope, reset_at: Instant, now: Instant, outcome: &Reporter) -> Response {
    let retry_after = retry_after_seconds(reset_at.saturating_duration_since(now));
    outcome.record_rate_limited(scope, retry_after);
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, retry_after.to_string())],
        Json(serde_json::json!({ "error": "rate_limited" })),
    )
        .into_response()
}

/// Whole seconds until the window resets, rounded up, at least 1.
fn retry_after_seconds(left: Duration) -> u64 {
    (left.as_millis().div_ceil(1000) as u64).max(1)
}

/// The UNVERIFIED `sub` claim of a compact JWT, for identity-bucket keying
/// only; the route verifies the signature afterwards.
pub fn unverified_jwt_sub(token: &str) -> Option<String> {
    let mut parts = token.split('.');
    let (Some(_), Some(payload), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    // Buffer.from(s, 'base64url') takes padded or unpadded input.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("sub")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
}

#[cfg(test)]
mod tests;
