//! RS256 identity-token verification against a provider's remote JWKS: Sign
//! in with Apple and Google, the port of `appleAuth.ts` / `googleAuth.ts`.
//! It proves identity only; the members allowlist decides access.
//!
//! The verdicts are jose's (`jwtVerify` + `createRemoteJWKSet`): the alg is
//! pinned to RS256 before any key lookup (alg none and HS/RS confusion are
//! `invalid_signature`), iss and aud are pinned, exp has 60 s of tolerance,
//! the nonce is compared in constant time, and the sub is re-parsed through
//! the contract grammar. A kid miss refetches the key set once unless the last
//! fetch is under 30 s old; the set is refetched after 10 min; a fetch gives
//! up after 5 s. A fetch failure is `jwks_unavailable` (503, not the user's
//! fault). The JWKS URL is a constant per provider, never request-derived.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde_json::{Map, Value};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;

pub const APPLE_JWKS_URL: &str = "https://appleid.apple.com/auth/keys";
pub const GOOGLE_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const APPLE_ISSUERS: &[&str] = &["https://appleid.apple.com"];
/// Google sends either form depending on the flow.
const GOOGLE_ISSUERS: &[&str] = &["accounts.google.com", "https://accounts.google.com"];

const CLOCK_TOLERANCE_SECS: f64 = 60.0;
const COOLDOWN: Duration = Duration::from_secs(30);
const CACHE_MAX_AGE: Duration = Duration::from_secs(600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// The shared Apple/Google failure taxonomy (`reason` on the 401/503 body).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// No audience configured: fail closed, never verify against an empty aud.
    NotConfigured,
    MalformedToken,
    /// Bad signature, or an alg other than RS256.
    InvalidSignature,
    /// The kid is not in the key set, after the one allowed refetch.
    UnknownKey,
    Expired,
    WrongIss,
    WrongAud,
    NonceMismatch,
    /// Missing sub, or one that fails the provider's sub grammar.
    BadSubject,
    /// The key set could not be fetched (network, timeout, non-200, bad JSON).
    JwksUnavailable,
}

impl VerifyError {
    pub fn as_str(self) -> &'static str {
        match self {
            VerifyError::NotConfigured => "not_configured",
            VerifyError::MalformedToken => "malformed_token",
            VerifyError::InvalidSignature => "invalid_signature",
            VerifyError::UnknownKey => "unknown_key",
            VerifyError::Expired => "expired",
            VerifyError::WrongIss => "wrong_iss",
            VerifyError::WrongAud => "wrong_aud",
            VerifyError::NonceMismatch => "nonce_mismatch",
            VerifyError::BadSubject => "bad_subject",
            VerifyError::JwksUnavailable => "jwks_unavailable",
        }
    }

    /// A provider outage is ours to report (503); everything else is a 401.
    pub fn status(self) -> StatusCode {
        if self == VerifyError::JwksUnavailable {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::UNAUTHORIZED
        }
    }
}

/// A verified identity. `sub` is the namespaced contract form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub sub: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone)]
struct Key {
    n: Vec<u8>,
    e: Vec<u8>,
}

#[derive(Default)]
struct Cache {
    keys: HashMap<String, Key>,
    /// When the last successful fetch happened.
    fetched: Option<Instant>,
}

/// One provider's key set and claim pins. One per process: the cache and the
/// refetch cooldown are shared by every sign-in.
pub struct Jwks {
    url: String,
    namespace: &'static str,
    issuers: &'static [&'static str],
    http: reqwest::Client,
    pub(crate) timeout: Duration,
    cache: Mutex<Cache>,
}

impl Jwks {
    pub fn apple() -> Jwks {
        Jwks::apple_at(APPLE_JWKS_URL)
    }

    pub fn google() -> Jwks {
        Jwks::google_at(GOOGLE_JWKS_URL)
    }

    /// Apple's pins against another key-set URL (tests serve one locally).
    pub fn apple_at(url: &str) -> Jwks {
        Jwks::new(url, "apple", APPLE_ISSUERS)
    }

    /// Google's pins against another key-set URL (tests serve one locally).
    pub fn google_at(url: &str) -> Jwks {
        Jwks::new(url, "google", GOOGLE_ISSUERS)
    }

    fn new(url: &str, namespace: &'static str, issuers: &'static [&'static str]) -> Jwks {
        Jwks {
            url: url.to_string(),
            namespace,
            issuers,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client builds"),
            timeout: FETCH_TIMEOUT,
            cache: Mutex::new(Cache::default()),
        }
    }

    /// Verify `token` at unix time `now` for one of `audiences`. With
    /// `nonce`, the token's nonce claim must equal it exactly.
    pub async fn verify(
        &self,
        token: &str,
        audiences: &[String],
        nonce: Option<&str>,
        now: i64,
    ) -> Result<Identity, VerifyError> {
        self.verify_at(token, audiences, nonce, now, Instant::now())
            .await
    }

    pub(crate) async fn verify_at(
        &self,
        token: &str,
        audiences: &[String],
        nonce: Option<&str>,
        now: i64,
        clock: Instant,
    ) -> Result<Identity, VerifyError> {
        use VerifyError::*;
        if audiences.is_empty() {
            return Err(NotConfigured);
        }
        let mut parts = token.split('.');
        let (Some(header), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(MalformedToken);
        };
        let header = json_object(header).ok_or(MalformedToken)?;
        // jose refuses crit headers it does not understand (it knows none here).
        if header.contains_key("crit") {
            return Err(MalformedToken);
        }
        match text(&header, "alg") {
            Some("RS256") => {}
            Some(_) => return Err(InvalidSignature),
            None => return Err(MalformedToken),
        }
        let kid = text(&header, "kid").ok_or(MalformedToken)?;
        let key = self.key(kid, clock).await?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| MalformedToken)?;
        let signed = &token[..header_len(token)];
        RsaPublicKeyComponents {
            n: &key.n,
            e: &key.e,
        }
        .verify(&RSA_PKCS1_2048_8192_SHA256, signed.as_bytes(), &signature)
        .map_err(|_| InvalidSignature)?;

        let claims = json_object(payload).ok_or(MalformedToken)?;
        // jose's claim order: presence of iss then aud, their values, then times.
        let iss = claims.get("iss").ok_or(WrongIss)?;
        if !self.issuers.iter().any(|i| iss.as_str() == Some(i)) {
            return Err(WrongIss);
        }
        let aud_ok = match claims.get("aud").ok_or(WrongAud)? {
            Value::String(a) => audiences.contains(a),
            Value::Array(list) => list
                .iter()
                .any(|a| a.as_str().is_some_and(|a| audiences.iter().any(|x| x == a))),
            _ => false,
        };
        if !aud_ok {
            return Err(WrongAud);
        }
        let number = |k: &str| match claims.get(k) {
            None => Ok(None),
            Some(v) => v.as_f64().map(Some).ok_or(MalformedToken),
        };
        let now = now as f64;
        number("iat")?;
        if number("nbf")?.is_some_and(|nbf| nbf > now + CLOCK_TOLERANCE_SECS) {
            return Err(MalformedToken);
        }
        // Required here (jose checks exp only when present); both providers send it.
        let exp = number("exp")?.ok_or(MalformedToken)?;
        if exp <= now - CLOCK_TOLERANCE_SECS {
            return Err(Expired);
        }

        if let Some(expected) = nonce {
            let matches = text(&claims, "nonce")
                .is_some_and(|n| bool::from(n.as_bytes().ct_eq(expected.as_bytes())));
            if !matches {
                return Err(NonceMismatch);
            }
        }

        let sub = text(&claims, "sub")
            .filter(|s| !s.is_empty())
            .ok_or(BadSubject)?;
        let sub = emerald_contracts::parse_sub(&format!("{}:{sub}", self.namespace))
            .map_err(|_| BadSubject)?
            .raw;
        Ok(Identity {
            sub,
            email: text(&claims, "email").map(String::from),
            name: text(&claims, "name").map(String::from),
        })
    }

    /// The key for `kid`: a stale or empty cache reloads first; a miss reloads
    /// once more unless the last fetch is inside the cooldown.
    async fn key(&self, kid: &str, now: Instant) -> Result<Key, VerifyError> {
        let mut cache = self.cache.lock().await;
        if cache
            .fetched
            .is_none_or(|t| now.duration_since(t) >= CACHE_MAX_AGE)
        {
            self.reload(&mut cache, now).await?;
        }
        if let Some(k) = cache.keys.get(kid) {
            return Ok(k.clone());
        }
        if cache
            .fetched
            .is_some_and(|t| now.duration_since(t) < COOLDOWN)
        {
            return Err(VerifyError::UnknownKey);
        }
        self.reload(&mut cache, now).await?;
        cache.keys.get(kid).cloned().ok_or(VerifyError::UnknownKey)
    }

    async fn reload(&self, cache: &mut Cache, now: Instant) -> Result<(), VerifyError> {
        let fetched = async {
            let res = self
                .http
                .get(&self.url)
                .timeout(self.timeout)
                .send()
                .await
                .ok()?;
            if res.status() != reqwest::StatusCode::OK {
                return None;
            }
            parse_jwks(&res.bytes().await.ok()?)
        }
        .await;
        let Some(keys) = fetched else {
            tracing::warn!(
                event = "auth_jwks",
                provider = self.namespace,
                "JWKS fetch failed"
            );
            return Err(VerifyError::JwksUnavailable);
        };
        cache.keys = keys;
        cache.fetched = Some(now);
        Ok(())
    }
}

/// Length of `header.payload` (the signing input) in a three-part token.
fn header_len(token: &str) -> usize {
    token.rfind('.').unwrap_or(token.len())
}

fn text<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

fn json_object(segment: &str) -> Option<Map<String, Value>> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).ok()?).ok()
}

/// RSA signing keys with a kid. Others (EC, `use: enc`, another alg) are skipped.
fn parse_jwks(body: &[u8]) -> Option<HashMap<String, Key>> {
    let set: Value = serde_json::from_slice(body).ok()?;
    let keys = set.get("keys")?.as_array()?;
    let field = |k: &Value, f: &str| k.get(f).and_then(Value::as_str).map(String::from);
    Some(
        keys.iter()
            .filter(|k| field(k, "kty").as_deref() == Some("RSA"))
            .filter(|k| field(k, "alg").is_none_or(|a| a == "RS256"))
            .filter(|k| field(k, "use").is_none_or(|u| u == "sig"))
            .filter_map(|k| {
                let b64 = |f: &str| URL_SAFE_NO_PAD.decode(field(k, f)?).ok();
                Some((
                    field(k, "kid")?,
                    Key {
                        n: b64("n")?,
                        e: b64("e")?,
                    },
                ))
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests;
