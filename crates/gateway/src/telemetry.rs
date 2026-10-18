//! Glitchtip (§15): the server's own crash reports, scrubbed before they
//! leave the box by `emerald_contracts::telemetry` (the key denylist plus the
//! stream-token and JWE string rules) and the login query secrets SDK URLs
//! can carry. An event that cannot be scrubbed is dropped, never sent raw.

use std::sync::{Arc, OnceLock};

use regex::Regex;
use sentry::protocol::{Breadcrumb, Event};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::config::Config;

/// The internal DSN (reachable inside the docker network) wins over the
/// public one handed to clients. None, or an unparsable DSN, leaves the SDK
/// off.
pub fn init(config: &Config) -> Option<sentry::ClientInitGuard> {
    let dsn = config
        .telemetry_dsn_internal
        .as_deref()
        .or(config.telemetry_dsn.as_deref())?;
    let Ok(dsn) = dsn.parse::<sentry::types::Dsn>() else {
        tracing::error!(
            event = "telemetry",
            "EEX_TELEMETRY_DSN is not a valid DSN; telemetry off"
        );
        return None;
    };
    let mut options = sentry::ClientOptions::default();
    options.dsn = Some(dsn);
    options.release = Some(config.release.clone().into());
    options.environment = Some(
        if config.auth.is_prod {
            "production"
        } else {
            "staging"
        }
        .into(),
    );
    options.send_default_pii = false;
    options.before_send = Some(Arc::new(|e: Event<'static>| scrub(&e)));
    options.before_breadcrumb = Some(Arc::new(|b: Breadcrumb| scrub(&b)));
    Some(sentry::init(options))
}

fn auth_query_secret() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r#"(?i)([?&](?:inviteCode|invite_code|setupToken|idToken|id_token)=)[^&#\s"']+"#)
            .expect("static regex")
    })
}

/// Round-trip through JSON: redact URL login secrets in the text, then walk
/// it with the contract scrubber.
pub fn scrub<T: Serialize + DeserializeOwned>(item: &T) -> Option<T> {
    let text = serde_json::to_string(item).ok()?;
    let text = auth_query_secret().replace_all(&text, "${1}REDACTED");
    let mut value: serde_json::Value = serde_json::from_str(&text).ok()?;
    emerald_contracts::telemetry::scrub_value(&mut value);
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_lose_tokens_cookies_and_login_secrets() {
        let mut event = Event {
            message: Some("grant /api/media/stream?t=tok123 eyJhbGciOiJkaXIifQ.x.y.z.w".into()),
            ..Default::default()
        };
        event
            .extra
            .insert("authorization".into(), "Bearer abc".into());
        event.extra.insert(
            "url".into(),
            "https://api.example/api/auth/workos/start?inviteCode=INV-1&x=1".into(),
        );
        let out = scrub(&event).unwrap();
        let msg = out.message.unwrap();
        assert!(
            msg.contains("t=REDACTED") && !msg.contains("tok123"),
            "{msg}"
        );
        assert!(!msg.contains("eyJhbGciOiJkaXIifQ"), "{msg}");
        assert_eq!(out.extra["authorization"], "REDACTED");
        assert_eq!(
            out.extra["url"],
            "https://api.example/api/auth/workos/start?inviteCode=REDACTED&x=1"
        );
        assert_eq!(out.event_id, event.event_id);
    }

    #[test]
    fn breadcrumbs_are_scrubbed_too() {
        let mut b = Breadcrumb {
            message: Some("GET /api/x?id_token=secret".into()),
            ..Default::default()
        };
        b.data.insert("cookie".into(), "eex.session=abc".into());
        let out = scrub(&b).unwrap();
        assert_eq!(out.message.as_deref(), Some("GET /api/x?id_token=REDACTED"));
        assert_eq!(out.data["cookie"], "REDACTED");
    }
}
