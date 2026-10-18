//! Env config for auth. Names, defaults and boot checks are `server/env.ts`'s
//! (and `services/secrets.ts`'s), so the same `.env` carries over. Plex and the
//! legacy ADMINS username list are not read.

/// Secrets shorter than this, or a known placeholder, refuse a production boot.
const SECRET_MIN_LEN: usize = 32;
const SECRET_PLACEHOLDERS: &[&str] = &[
    "changeme",
    "change-me",
    "change_me",
    "placeholder",
    "secret",
    "password",
    "test",
    "test-secret",
    "replaceme",
    "replace-me",
    "replace_me",
    "your-secret-here",
    "session-secret",
];

#[derive(Clone)]
pub struct Config {
    pub session_secret: String,
    pub stream_token_secret: String,
    /// Required in production; None in dev when unset (mint paths refuse).
    pub device_token_secret: Option<String>,
    pub internal_principal_secret: Option<String>,
    /// Owner bootstrap: admins, and allowed without an invite. Contract-valid.
    pub admin_subs: Vec<String>,
    pub allowed_origins: Vec<String>,
    /// The backend serves the built SPA same-origin.
    pub serve_spa: bool,
    pub is_prod: bool,
    pub trust_client_ip_headers: bool,
    pub apple_client_id: Option<String>,
    pub google_client_ids: Vec<String>,
    pub workos_client_id: Option<String>,
    pub workos_api_key: Option<String>,
    pub workos_redirect_uri: Option<String>,
    pub workos_native_redirect_uri: String,
    pub server_db_path: String,
    /// The iptv service (crates/iptv): a member revoke calls its
    /// /internal/members/:sub/revoke-playlist-tokens.
    pub iptv_service_url: String,
    /// IPTV_DISABLED=1|true: no IPTV surface, so nothing to call.
    pub iptv_disabled: bool,
    /// The nightly expired-device-token sweep (node-cron syntax).
    pub token_sweep_cron: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Build from any key lookup, so tests never touch process env.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let opt = |k: &str| {
            get(k)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let csv = |k: &str| -> Vec<String> {
            get(k)
                .map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default()
        };
        let flag = |k: &str| get(k).as_deref() == Some("1");
        let required = |k: &str| {
            get(k)
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| format!("Missing required env var: {k}"))
        };
        let is_prod = get("NODE_ENV").as_deref() == Some("production");

        let serve_spa = match get("SERVE_SPA").as_deref() {
            Some("1") => true,
            Some("0") => false,
            _ => std::path::Path::new("./dist/index.html").exists(),
        };
        let allowed_origins = csv("ALLOWED_ORIGINS");
        if is_prod && allowed_origins.is_empty() && !serve_spa {
            return Err("Missing required env var in production: ALLOWED_ORIGINS \
                        (not required when SERVE_SPA serves the SPA same-origin)"
                .into());
        }

        let session_secret = required("SESSION_SECRET")?;
        let stream_token_secret = required("STREAM_TOKEN_SECRET")?;
        // Dev tolerates these unset (an empty value counts as unset).
        let prod_required = |k: &str| -> Result<Option<String>, String> {
            if is_prod {
                required(k).map(Some)
            } else {
                Ok(get(k).filter(|v| !v.is_empty()))
            }
        };
        let device_token_secret = prod_required("DEVICE_TOKEN_SECRET")?;
        let internal_principal_secret = prod_required("INTERNAL_PRINCIPAL_SECRET")?;
        let secrets = [
            ("SESSION_SECRET", Some(&session_secret)),
            ("STREAM_TOKEN_SECRET", Some(&stream_token_secret)),
            ("DEVICE_TOKEN_SECRET", device_token_secret.as_ref()),
            (
                "INTERNAL_PRINCIPAL_SECRET",
                internal_principal_secret.as_ref(),
            ),
        ];
        let present: Vec<(&str, &String)> = secrets
            .iter()
            .filter_map(|(n, v)| v.map(|v| (*n, v)))
            .collect();
        if is_prod {
            for (name, value) in &present {
                check_strength(name, value)?;
            }
        }
        // Pairwise distinct in every environment: a shared value defeats key separation.
        for (i, (a, va)) in present.iter().enumerate() {
            for (b, vb) in &present[i + 1..] {
                if va == vb {
                    return Err(format!(
                        "FATAL: {a} and {b} must be different values. Shared secrets defeat \
                         key-separation."
                    ));
                }
            }
        }

        let admin_subs = csv("ADMIN_SUBS")
            .into_iter()
            .map(|s| {
                emerald_contracts::parse_sub(&s).map(|p| p.raw).map_err(|_| {
                    format!(
                        "Invalid entry in ADMIN_SUBS: {s:?}. Each entry must be a namespaced sub \
                         like \"apple:000000.<32 hex>.0000\", \"google:<sub>\", \
                         \"workos:user_<ulid>\" or \"local:<ulid>\"."
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        let apple_client_id = opt("APPLE_CLIENT_ID");
        if is_prod && flag("ENABLE_APPLE_SIGN_IN") && apple_client_id.is_none() {
            return Err(
                "Missing required env var in production when ENABLE_APPLE_SIGN_IN=1: \
                        APPLE_CLIENT_ID"
                    .into(),
            );
        }
        let google_client_ids = csv("GOOGLE_CLIENT_ID");
        if is_prod && flag("ENABLE_GOOGLE_SIGN_IN") && google_client_ids.is_empty() {
            return Err(
                "Missing required env var in production when ENABLE_GOOGLE_SIGN_IN=1: \
                        GOOGLE_CLIENT_ID"
                    .into(),
            );
        }
        let workos_client_id = opt("WORKOS_CLIENT_ID");
        let workos_api_key = opt("WORKOS_API_KEY");
        let workos_redirect_uri = opt("WORKOS_REDIRECT_URI");
        if is_prod
            && flag("ENABLE_WORKOS_SIGN_IN")
            && (workos_client_id.is_none()
                || workos_api_key.is_none()
                || workos_redirect_uri.is_none())
        {
            return Err(
                "Missing required env vars in production when ENABLE_WORKOS_SIGN_IN=1: \
                        WORKOS_CLIENT_ID, WORKOS_API_KEY and WORKOS_REDIRECT_URI"
                    .into(),
            );
        }

        Ok(Config {
            session_secret,
            stream_token_secret,
            device_token_secret,
            internal_principal_secret,
            admin_subs,
            allowed_origins,
            serve_spa,
            is_prod,
            trust_client_ip_headers: flag("TRUST_CLIENT_IP_HEADERS"),
            apple_client_id,
            google_client_ids,
            workos_client_id,
            workos_api_key,
            workos_redirect_uri,
            workos_native_redirect_uri: opt("WORKOS_NATIVE_REDIRECT_URI")
                .unwrap_or_else(|| "emerald://auth/workos".into()),
            server_db_path: get("SERVER_DB_PATH").unwrap_or_else(|| "./data/server.db".into()),
            iptv_service_url: opt("IPTV_SERVICE_URL").unwrap_or_else(|| {
                if is_prod {
                    "http://iptv:8004"
                } else {
                    "http://127.0.0.1:8004"
                }
                .into()
            }),
            iptv_disabled: matches!(get("IPTV_DISABLED").as_deref(), Some("1" | "true")),
            token_sweep_cron: get("TOKEN_SWEEP_CRON").unwrap_or_else(|| "15 3 * * *".into()),
        })
    }

    pub fn apple_configured(&self) -> bool {
        self.apple_client_id.is_some()
    }

    pub fn google_configured(&self) -> bool {
        !self.google_client_ids.is_empty()
    }

    pub fn workos_configured(&self) -> bool {
        self.workos_client_id.is_some()
            && self.workos_api_key.is_some()
            && self.workos_redirect_uri.is_some()
    }
}

fn check_strength(name: &str, value: &str) -> Result<(), String> {
    if SECRET_PLACEHOLDERS.contains(&value.to_lowercase().as_str()) {
        return Err(format!(
            "{name} looks like a placeholder value. Generate a real secret with \
             `openssl rand -base64 48` and redeploy."
        ));
    }
    // JS string length is UTF-16 units; secrets are ASCII in practice.
    if value.chars().count() < SECRET_MIN_LEN {
        return Err(format!(
            "{name} is too short for production ({} chars). Use at least {SECRET_MIN_LEN} bytes.",
            value.chars().count()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn strong(c: char) -> String {
        c.to_string().repeat(40)
    }

    fn build(pairs: &[(&str, &str)]) -> Result<Config, String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    fn dev(extra: &[(&str, &str)]) -> Result<Config, String> {
        let (s, t) = (strong('s'), strong('t'));
        let mut pairs = vec![
            ("SESSION_SECRET", s.as_str()),
            ("STREAM_TOKEN_SECRET", t.as_str()),
        ];
        pairs.extend_from_slice(extra);
        build(&pairs)
    }

    fn prod(extra: &[(&str, &str)]) -> Result<Config, String> {
        let (d, i) = (strong('d'), strong('i'));
        let mut pairs = vec![
            ("NODE_ENV", "production"),
            ("ALLOWED_ORIGINS", "https://theemeraldexchange.com"),
            ("DEVICE_TOKEN_SECRET", d.as_str()),
            ("INTERNAL_PRINCIPAL_SECRET", i.as_str()),
        ];
        pairs.extend_from_slice(extra);
        dev(&pairs)
    }

    #[test]
    fn dev_defaults() {
        let c = dev(&[("SERVE_SPA", "0")]).unwrap();
        assert!(!c.is_prod && !c.serve_spa && !c.trust_client_ip_headers);
        assert_eq!(c.device_token_secret, None);
        assert_eq!(c.internal_principal_secret, None);
        assert_eq!(c.server_db_path, "./data/server.db");
        assert_eq!(c.workos_native_redirect_uri, "emerald://auth/workos");
        assert_eq!(c.iptv_service_url, "http://127.0.0.1:8004");
        assert!(!c.iptv_disabled);
        assert_eq!(c.token_sweep_cron, "15 3 * * *");
        assert!(dev(&[("IPTV_DISABLED", "true")]).unwrap().iptv_disabled);
        assert!(c.admin_subs.is_empty());
        assert!(!c.apple_configured() && !c.google_configured() && !c.workos_configured());
        // A short secret is fine outside production.
        assert!(
            build(&[
                ("SESSION_SECRET", "short"),
                ("STREAM_TOKEN_SECRET", "other")
            ])
            .is_ok()
        );
    }

    #[test]
    fn session_and_stream_secrets_are_always_required() {
        assert!(
            build(&[("STREAM_TOKEN_SECRET", "x")])
                .err()
                .unwrap()
                .contains("SESSION_SECRET")
        );
        assert!(
            build(&[("SESSION_SECRET", "x"), ("STREAM_TOKEN_SECRET", "  ")])
                .err()
                .unwrap()
                .contains("STREAM_TOKEN_SECRET")
        );
    }

    #[test]
    fn production_requires_device_and_internal_secrets() {
        assert_eq!(prod(&[]).unwrap().iptv_service_url, "http://iptv:8004");
        for k in ["DEVICE_TOKEN_SECRET", "INTERNAL_PRINCIPAL_SECRET"] {
            let err = prod(&[(k, "")]).err().unwrap();
            assert!(err.contains(k), "{err}");
        }
    }

    #[test]
    fn production_rejects_placeholders_and_short_secrets() {
        assert!(
            prod(&[("SESSION_SECRET", "CHANGEME")])
                .err()
                .unwrap()
                .contains("placeholder")
        );
        let short = "a".repeat(31);
        assert!(
            prod(&[("DEVICE_TOKEN_SECRET", &short)])
                .err()
                .unwrap()
                .contains("too short")
        );
        let at_min = "a".repeat(32);
        assert!(prod(&[("STREAM_TOKEN_SECRET", &at_min)]).is_ok());
        assert!(
            prod(&[("INTERNAL_PRINCIPAL_SECRET", "secret")])
                .err()
                .unwrap()
                .contains("placeholder")
        );
    }

    #[test]
    fn secrets_must_be_pairwise_distinct_in_every_environment() {
        let t = strong('t');
        let err = dev(&[("SESSION_SECRET", &t)]).err().unwrap();
        assert!(
            err.contains("SESSION_SECRET and STREAM_TOKEN_SECRET"),
            "{err}"
        );
        let err = dev(&[("DEVICE_TOKEN_SECRET", &t)]).err().unwrap();
        assert!(
            err.contains("STREAM_TOKEN_SECRET and DEVICE_TOKEN_SECRET"),
            "{err}"
        );
        let s = strong('s');
        let err = prod(&[("INTERNAL_PRINCIPAL_SECRET", &s)]).err().unwrap();
        assert!(
            err.contains("SESSION_SECRET and INTERNAL_PRINCIPAL_SECRET"),
            "{err}"
        );
        // An absent device secret is skipped.
        assert!(dev(&[("DEVICE_TOKEN_SECRET", "")]).is_ok());
    }

    #[test]
    fn allowed_origins_is_required_in_production_unless_the_spa_is_same_origin() {
        assert!(
            prod(&[("ALLOWED_ORIGINS", " , ")])
                .err()
                .unwrap()
                .contains("ALLOWED_ORIGINS")
        );
        let c = prod(&[("ALLOWED_ORIGINS", ""), ("SERVE_SPA", "1")]).unwrap();
        assert!(c.serve_spa);
        let c = prod(&[("ALLOWED_ORIGINS", "https://a.example, https://b.example")]).unwrap();
        assert_eq!(
            c.allowed_origins,
            ["https://a.example", "https://b.example"]
        );
        assert!(dev(&[("ALLOWED_ORIGINS", "")]).is_ok());
    }

    #[test]
    fn admin_subs_are_validated_against_the_contract() {
        let c = dev(&[(
            "ADMIN_SUBS",
            " apple:000000.0123456789abcdef0123456789abcdef.0000 , workos:user_01E4ZCR3C56J083X43JQXF3JK5,",
        )])
        .unwrap();
        assert_eq!(
            c.admin_subs,
            [
                "apple:000000.0123456789abcdef0123456789abcdef.0000",
                "workos:user_01E4ZCR3C56J083X43JQXF3JK5"
            ]
        );
        assert!(
            dev(&[("ADMIN_SUBS", "494190801")])
                .err()
                .unwrap()
                .contains("ADMIN_SUBS")
        );
    }

    #[test]
    fn provider_settings_and_their_production_assertions() {
        let c = dev(&[
            ("APPLE_CLIENT_ID", " com.example.app "),
            (
                "GOOGLE_CLIENT_ID",
                "a.apps.googleusercontent.com, b.apps.googleusercontent.com",
            ),
            ("WORKOS_CLIENT_ID", "client_1"),
            ("WORKOS_API_KEY", "sk_1"),
            ("WORKOS_REDIRECT_URI", "https://x/cb"),
            ("TRUST_CLIENT_IP_HEADERS", "1"),
        ])
        .unwrap();
        assert_eq!(c.apple_client_id.as_deref(), Some("com.example.app"));
        assert_eq!(c.google_client_ids.len(), 2);
        assert!(c.apple_configured() && c.google_configured() && c.workos_configured());
        assert!(c.trust_client_ip_headers);

        assert!(
            prod(&[("ENABLE_APPLE_SIGN_IN", "1")])
                .err()
                .unwrap()
                .contains("APPLE_CLIENT_ID")
        );
        assert!(
            prod(&[("ENABLE_GOOGLE_SIGN_IN", "1")])
                .err()
                .unwrap()
                .contains("GOOGLE_CLIENT_ID")
        );
        assert!(
            prod(&[("ENABLE_WORKOS_SIGN_IN", "1"), ("WORKOS_CLIENT_ID", "c")])
                .err()
                .unwrap()
                .contains("WORKOS_API_KEY")
        );
        // Without the assertion a missing provider is just unconfigured.
        assert!(!prod(&[]).unwrap().apple_configured());
    }
}
