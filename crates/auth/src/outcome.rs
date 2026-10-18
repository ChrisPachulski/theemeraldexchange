//! One structured `auth_outcome` event per sign-in request. Port of
//! services/authOutcome.ts. Every dimension is a closed enum, so no token,
//! cookie, sub, email, IP or invite code can reach the line.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use axum::http::HeaderMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Plex,
    Apple,
    Google,
    Workos,
    Link,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Check,
    IdentityVerify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Authorized,
    Denied,
    RateLimited,
    Transient,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Cookie,
    DevicePair,
    DeviceLink,
    LocalRateLimit,
    /// plex.tv refused a PIN poll (429), kept apart from our own limits.
    ProviderRateLimit,
    NotConfigured,
    InvalidRequest,
    IdentityTokenInvalid,
    ProviderUnavailable,
    ServerError,
    NoInvite,
}

/// Which rate-limit bucket refused the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Global,
    TrustedClient,
    /// One Plex PIN's polls.
    Pin,
    Identity,
    /// The provider's own backpressure (plex.tv), not one of our buckets.
    Upstream,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Plex => "plex",
            Provider::Apple => "apple",
            Provider::Google => "google",
            Provider::Workos => "workos",
            Provider::Link => "link",
        }
    }
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Check => "check",
            Phase::IdentityVerify => "identity_verify",
        }
    }
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Authorized => "authorized",
            Outcome::Denied => "denied",
            Outcome::RateLimited => "rate_limited",
            Outcome::Transient => "transient",
            Outcome::Invalid => "invalid",
        }
    }
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Cookie => "cookie",
            Reason::DevicePair => "device_pair",
            Reason::DeviceLink => "device_link",
            Reason::LocalRateLimit => "local_rate_limit",
            Reason::ProviderRateLimit => "provider_rate_limit",
            Reason::NotConfigured => "not_configured",
            Reason::InvalidRequest => "invalid_request",
            Reason::IdentityTokenInvalid => "identity_token_invalid",
            Reason::ProviderUnavailable => "provider_unavailable",
            Reason::ServerError => "server_error",
            Reason::NoInvite => "no_invite",
        }
    }
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Global => "global",
            Scope::TrustedClient => "trusted_client",
            Scope::Pin => "pin",
            Scope::Identity => "identity",
            Scope::Upstream => "upstream",
        }
    }
}

/// Records a request's terminal outcome once; later calls are no-ops.
pub struct Reporter {
    provider: Provider,
    phase: Phase,
    started: Instant,
    request_id: String,
    recorded: AtomicBool,
}

impl Reporter {
    pub fn new(headers: &HeaderMap, provider: Provider, phase: Phase) -> Reporter {
        Reporter {
            provider,
            phase,
            started: Instant::now(),
            request_id: request_id(headers),
            recorded: AtomicBool::new(false),
        }
    }

    /// True when this call wrote the event.
    pub fn record(&self, outcome: Outcome, reason: Reason) -> bool {
        self.emit(outcome, reason, None, None)
    }

    pub(crate) fn record_rate_limited(&self, scope: Scope, retry_after_seconds: u64) -> bool {
        self.emit(
            Outcome::RateLimited,
            Reason::LocalRateLimit,
            Some(scope),
            Some(retry_after_seconds),
        )
    }

    /// plex.tv's 429 on a PIN poll: scope upstream, with the clamped seconds.
    pub(crate) fn record_provider_rate_limited(&self, retry_after_seconds: u64) -> bool {
        self.emit(
            Outcome::RateLimited,
            Reason::ProviderRateLimit,
            Some(Scope::Upstream),
            Some(retry_after_seconds),
        )
    }

    /// Await a handler body; an `Err` it did not record becomes one
    /// transient/server_error event (withAuthOutcome's catch). The error
    /// itself is never logged here.
    pub async fn run<T, E>(&self, body: impl Future<Output = Result<T, E>>) -> Result<T, E> {
        let result = body.await;
        if result.is_err() {
            self.record(Outcome::Transient, Reason::ServerError);
        }
        result
    }

    fn emit(
        &self,
        outcome: Outcome,
        reason: Reason,
        scope: Option<Scope>,
        retry_after_seconds: Option<u64>,
    ) -> bool {
        if self.recorded.swap(true, Ordering::Relaxed) {
            return false;
        }
        let elapsed = round_elapsed(self.started.elapsed().as_millis());
        macro_rules! event {
            ($level:ident) => {
                tracing::$level!(
                    event = "auth_outcome",
                    provider = self.provider.as_str(),
                    phase = self.phase.as_str(),
                    outcome = outcome.as_str(),
                    reason = reason.as_str(),
                    scope = scope.map(Scope::as_str),
                    retryAfterSeconds = retry_after_seconds,
                    elapsedMs = elapsed,
                    requestId = self.request_id.as_str(),
                    "terminal"
                )
            };
        }
        if outcome == Outcome::Authorized {
            event!(info);
        } else {
            event!(warn);
        }
        true
    }
}

/// Elapsed time to the nearest 100 ms, so the line cannot time a credential
/// check finely.
fn round_elapsed(ms: u128) -> u64 {
    ((ms + 50) / 100 * 100) as u64
}

/// X-Request-Id when it passes Hono's requestId() rule (word characters, `-`
/// and `=`, at most 255), else "unavailable". The gateway's request-id layer
/// sets it.
pub(crate) fn request_id(headers: &HeaderMap) -> String {
    headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 255
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'='))
        })
        .unwrap_or("unavailable")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{capture_logs, logs};

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    fn outcome_lines() -> Vec<String> {
        logs()
            .lines()
            .filter(|l| l.contains("event=\"auth_outcome\""))
            .map(String::from)
            .collect()
    }

    #[test]
    fn uses_closed_low_cardinality_dimensions() {
        let providers = [
            Provider::Plex,
            Provider::Apple,
            Provider::Google,
            Provider::Workos,
            Provider::Link,
        ];
        assert_eq!(
            providers.map(Provider::as_str),
            ["plex", "apple", "google", "workos", "link"]
        );
        assert_eq!(
            [Phase::Check, Phase::IdentityVerify].map(Phase::as_str),
            ["check", "identity_verify"]
        );
        let outcomes = [
            Outcome::Authorized,
            Outcome::Denied,
            Outcome::RateLimited,
            Outcome::Transient,
            Outcome::Invalid,
        ];
        assert_eq!(
            outcomes.map(Outcome::as_str),
            [
                "authorized",
                "denied",
                "rate_limited",
                "transient",
                "invalid"
            ]
        );
        let reasons = [
            Reason::Cookie,
            Reason::DevicePair,
            Reason::DeviceLink,
            Reason::LocalRateLimit,
            Reason::ProviderRateLimit,
            Reason::NotConfigured,
            Reason::InvalidRequest,
            Reason::IdentityTokenInvalid,
            Reason::ProviderUnavailable,
            Reason::ServerError,
            Reason::NoInvite,
        ];
        assert_eq!(
            reasons.map(Reason::as_str),
            [
                "cookie",
                "device_pair",
                "device_link",
                "local_rate_limit",
                "provider_rate_limit",
                "not_configured",
                "invalid_request",
                "identity_token_invalid",
                "provider_unavailable",
                "server_error",
                "no_invite"
            ]
        );
        assert_eq!(
            [
                Scope::Global,
                Scope::TrustedClient,
                Scope::Pin,
                Scope::Identity,
                Scope::Upstream
            ]
            .map(Scope::as_str),
            ["global", "trusted_client", "pin", "identity", "upstream"]
        );
    }

    #[test]
    fn elapsed_rounds_to_the_nearest_100_ms() {
        assert_eq!(round_elapsed(0), 0);
        assert_eq!(round_elapsed(49), 0);
        assert_eq!(round_elapsed(50), 100);
        assert_eq!(round_elapsed(149), 100);
        assert_eq!(round_elapsed(150), 200);
    }

    #[test]
    fn emits_a_rounded_redacted_event_at_most_once_per_request() {
        capture_logs();
        let h = headers(&[
            ("x-request-id", "auth-outcome-request"),
            ("authorization", "Bearer TOKEN-SENTINEL"),
            ("cookie", "eex.session=COOKIE-SENTINEL"),
            ("cf-connecting-ip", "198.51.100.20"),
        ]);
        let r = Reporter::new(&h, Provider::Apple, Phase::IdentityVerify);
        assert!(r.record(Outcome::Authorized, Reason::Cookie));
        assert!(!r.record(Outcome::Denied, Reason::NoInvite));

        let lines = outcome_lines();
        assert_eq!(lines.len(), 1, "{lines:?}");
        let line = &lines[0];
        assert!(line.contains(" INFO "), "{line}");
        for field in [
            "terminal",
            "provider=\"apple\"",
            "phase=\"identity_verify\"",
            "outcome=\"authorized\"",
            "reason=\"cookie\"",
            "requestId=\"auth-outcome-request\"",
        ] {
            assert!(line.contains(field), "{field} missing: {line}");
        }
        let elapsed: u64 = line
            .split("elapsedMs=")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(elapsed % 100, 0);
        // No scope or retry-after unless rate limited.
        assert!(!line.contains("scope=") && !line.contains("retryAfterSeconds="));
        for sentinel in ["TOKEN-SENTINEL", "COOKIE-SENTINEL", "198.51.100.20"] {
            assert!(!line.contains(sentinel), "{line}");
        }
    }

    #[test]
    fn rate_limited_events_carry_scope_and_retry_after_at_warn() {
        capture_logs();
        let r = Reporter::new(&HeaderMap::new(), Provider::Link, Phase::Check);
        assert!(r.record_rate_limited(Scope::TrustedClient, 42));
        let lines = outcome_lines();
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert!(line.contains(" WARN "), "{line}");
        assert!(line.contains("scope=\"trusted_client\""), "{line}");
        assert!(line.contains("retryAfterSeconds=42"), "{line}");
        assert!(line.contains("reason=\"local_rate_limit\""), "{line}");
        assert!(line.contains("requestId=\"unavailable\""), "{line}");
    }

    #[tokio::test]
    async fn records_one_bounded_transient_event_when_a_handler_fails() {
        capture_logs();
        let h = headers(&[("x-request-id", "unexpected-auth-failure")]);
        let r = Reporter::new(&h, Provider::Google, Phase::IdentityVerify);
        let result: Result<(), &str> = r.run(async { Err("VERIFIER-ERROR-SENTINEL") }).await;
        assert!(result.is_err());
        let lines = outcome_lines();
        assert_eq!(lines.len(), 1, "{lines:?}");
        let line = &lines[0];
        assert!(line.contains(" WARN "), "{line}");
        for field in [
            "provider=\"google\"",
            "outcome=\"transient\"",
            "reason=\"server_error\"",
            "requestId=\"unexpected-auth-failure\"",
        ] {
            assert!(line.contains(field), "{field} missing: {line}");
        }
        assert!(!logs().contains("VERIFIER-ERROR-SENTINEL"));

        // An outcome recorded before the failure stands alone.
        capture_logs();
        let r = Reporter::new(&h, Provider::Google, Phase::IdentityVerify);
        let result: Result<(), &str> = r
            .run(async {
                r.record(Outcome::Invalid, Reason::InvalidRequest);
                Err("late")
            })
            .await;
        assert!(result.is_err());
        let lines = outcome_lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("outcome=\"invalid\""));

        // Success records nothing on its own.
        capture_logs();
        let r = Reporter::new(&h, Provider::Google, Phase::IdentityVerify);
        let ok: Result<u8, &str> = r.run(async { Ok(1) }).await;
        assert_eq!(ok, Ok(1));
        assert!(outcome_lines().is_empty());
    }

    #[test]
    fn request_id_follows_honos_rule() {
        let id = |v: &str| request_id(&headers(&[("x-request-id", v)]));
        assert_eq!(id("abc-DEF_1="), "abc-DEF_1=");
        assert_eq!(id("has space"), "unavailable");
        assert_eq!(id("a\"b"), "unavailable");
        assert_eq!(id(&"a".repeat(256)), "unavailable");
        assert_eq!(id(&"a".repeat(255)), "a".repeat(255));
        assert_eq!(request_id(&HeaderMap::new()), "unavailable");
    }
}
