//! The `eex.session` cookie: a stateless JWE (alg dir, enc A256GCM) under
//! HKDF(SESSION_SECRET, 'eex/session/v1'), 30-day exp. The wire format is the
//! one `server/session.ts` mints with jose, so a cookie from either side
//! verifies on the other (tests/fixtures/auth-goldens.json proves both ways).
//! TS cookies carry no `kid`; Rust mints `kid: session-v1` so a later rotation
//! can dispatch by kid, and jose ignores the kid when given the key directly.
//! A Plex sign-in carries the user's plex.tv token as the `plexAuthToken`
//! claim (encrypted, never readable from the cookie, never in `/api/me`).

use axum::http::{HeaderMap, HeaderValue, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use emerald_contracts::{INFO_SESSION, derive_key, jwe, parse_sub};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::Config;
use crate::{AuthMode, Role};

pub const COOKIE_NAME: &str = "eex.session";
pub const TTL_SECS: i64 = 30 * 24 * 60 * 60;
pub const KID: &str = "session-v1";

/// A verified session. Serializes as the `/api/me` `user` object, which never
/// shows the Plex token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Session {
    pub sub: String,
    pub username: String,
    pub role: Role,
    pub auth_mode: AuthMode,
    /// The user's plex.tv token (Plex sign-in only), so Plex-backed routes
    /// call plex.tv as the user. Cookie claim `plexAuthToken`.
    #[serde(skip)]
    pub plex_auth_token: Option<String>,
}

#[derive(Clone, Copy)]
pub struct SessionKey([u8; 32]);

impl SessionKey {
    pub fn from_secret(secret: &str) -> SessionKey {
        SessionKey(derive_key(secret.as_bytes(), INFO_SESSION))
    }
}

#[derive(Serialize)]
struct Claims<'a> {
    #[serde(flatten)]
    session: &'a Session,
    #[serde(rename = "plexAuthToken", skip_serializing_if = "Option::is_none")]
    plex_auth_token: Option<&'a str>,
    iat: i64,
    exp: i64,
}

/// Mint a cookie value issued at unix time `now`.
pub fn mint(key: &SessionKey, session: &Session, now: i64) -> String {
    let claims = Claims {
        session,
        plex_auth_token: session.plex_auth_token.as_deref(),
        iat: now,
        exp: now + TTL_SECS,
    };
    let plaintext = serde_json::to_vec(&claims).expect("session claims serialize");
    jwe::encrypt(&key.0, KID, &plaintext)
}

/// Verify a cookie value at unix time `now`. Strict, like `verifySession`:
/// string `sub` that passes the contract grammar, string `username`, role
/// admin|user, auth_mode one of [`AuthMode`], and jose's time rules (numeric
/// iat/nbf/exp; exp <= now or nbf > now rejects). A non-string or empty
/// `plexAuthToken` reads as none, as in TS.
pub fn verify(key: &SessionKey, token: &str, now: i64) -> Option<Session> {
    let header: Map<String, Value> =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token.split('.').next()?).ok()?).ok()?;
    let field = |k: &str| header.get(k).and_then(Value::as_str);
    // jose refuses zip and crit headers; a kid other than ours is a key we do not hold.
    if field("alg") != Some("dir")
        || field("enc") != Some("A256GCM")
        || header.get("kid").is_some_and(|k| k.as_str() != Some(KID))
        || header.contains_key("zip")
        || header.contains_key("crit")
    {
        return None;
    }
    let claims: Map<String, Value> =
        serde_json::from_slice(&jwe::decrypt_with_key(&key.0, token).ok()?).ok()?;

    // A present date claim must be a number. exp is required: every cookie
    // either side mints carries one.
    let date = |k: &str| match claims.get(k) {
        None => Ok(None),
        Some(v) => v.as_f64().map(Some).ok_or(()),
    };
    let (Ok(_iat), Ok(nbf), Ok(Some(exp))) = (date("iat"), date("nbf"), date("exp")) else {
        return None;
    };
    let now = now as f64;
    if exp <= now || nbf.is_some_and(|nbf| nbf > now) {
        return None;
    }

    let text = |k: &str| claims.get(k).and_then(Value::as_str);
    let sub = parse_sub(text("sub")?).ok()?.raw;
    let username = text("username")?.to_string();
    let role = Role::parse(text("role")?)?;
    let auth_mode = AuthMode::parse(text("auth_mode")?)?;
    let plex_auth_token = text("plexAuthToken")
        .filter(|t| !t.is_empty())
        .map(String::from);
    Some(Session {
        sub,
        username,
        role,
        auth_mode,
        plex_auth_token,
    })
}

/// The `eex.session` value from the Cookie header(s), parsed the way Hono's
/// getCookie does: first well-formed pair wins, surrounding quotes stripped.
pub fn read_cookie(headers: &HeaderMap) -> Option<&str> {
    read_named_cookie(headers, COOKIE_NAME)
}

/// Cookie `name`, parsed as [`read_cookie`] parses `eex.session`.
pub fn read_named_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let ws: &[char] = &[' ', '\t'];
    let valid = |v: &str| {
        v.bytes()
            .all(|b| matches!(b, b' ' | b'!' | b'#'..=b':' | b'<'..=b'[' | b']'..=b'~'))
    };
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.split_once('='))
        .filter(|(n, _)| n.trim_matches(ws) == name)
        .map(|(_, v)| {
            let v = v.trim_matches(ws);
            v.strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(v)
        })
        .find(|v| valid(v))
}

/// `setSessionCookie`'s attributes. Same-origin (SERVE_SPA): Lax, Secure only
/// when the request itself came over https. Split SPA/API: None+Secure in
/// production, Lax in dev.
pub fn set_cookie(config: &Config, token: &str, https: bool) -> HeaderValue {
    let (secure, same_site) = if config.serve_spa {
        (https, "Lax")
    } else if config.is_prod {
        (true, "None")
    } else {
        (false, "Lax")
    };
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={token}; Max-Age={TTL_SECS}; Path=/; HttpOnly{secure}; SameSite={same_site}"
    ))
    .expect("cookie header is ASCII")
}

/// `clearSessionCookie` (Hono deleteCookie with path /).
pub fn clear_cookie() -> HeaderValue {
    HeaderValue::from_static("eex.session=; Max-Age=0; Path=/")
}

#[cfg(test)]
mod tests;
