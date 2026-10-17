//! Env config for the iptv service. Names and defaults match `server/env.ts`
//! so the shared `.env` drives both until the cutover. Raw `??` defaults stay
//! raw (an empty value is kept), `opt()` ones treat empty as unset, and a
//! positive-int typo fails the boot instead of becoming NaN.

pub use media_core::config::PrincipalMode;

/// Secrets shorter than this, or a known placeholder, refuse a production boot
/// (mirrors `server/services/secrets.ts`).
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

/// Aggregated iptv-org EPG (epgshare01).
pub const DEFAULT_EXTERNAL_EPG_URL: &str =
    "https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz";

#[derive(Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub xtream_host: String,
    pub xtream_username: String,
    pub xtream_password: String,
    pub iptv_db_path: String,
    pub iptv_epg_path: String,
    /// Third-party XMLTV feeds layered under the provider's (iptv-org via
    /// epgshare01). Unset or blank means the default; a list of only commas
    /// means none.
    pub iptv_external_epg_urls: Vec<String>,
    pub iptv_max_concurrent_streams: u64,
    pub iptv_max_upstream_connections: u64,
    pub iptv_feed_check: bool,
    pub iptv_feed_sweep_hours_utc: String,
    pub iptv_stream_token_ttl_secs: u64,
    pub iptv_live_token_ttl_secs: u64,
    pub iptv_ondemand_token_ttl_secs: u64,
    pub iptv_list_timeout_ms: u64,
    pub iptv_manifest_fetch_timeout_ms: u64,
    pub iptv_manifest_max_bytes: u64,
    pub iptv_sync_cron: String,
    pub iptv_remux_tmp_dir: String,
    pub iptv_reencode_preset: String,
    pub iptv_reencode_threads: u64,
    pub iptv_reencode_max_height: u64,
    pub iptv_disabled: bool,
    pub dvr_enabled: bool,
    pub dvr_dir: String,
    pub stream_token_secret: String,
    pub internal_principal_secret: Option<String>,
    /// Internal-principal posture, shared with media-core and the transcoder
    /// (`MEDIA_INTERNAL_PRINCIPAL_MODE`, compose defaults it to enforce).
    pub principal_mode: PrincipalMode,
    pub allowed_origins: Vec<String>,
    /// `USE_LOCAL_RECOMMENDER=1`: a qualifying watch is posted as `watched`.
    pub use_local_recommender: bool,
    pub recommender_url: String,
    pub recommender_event_secret: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Build from any key lookup, so tests never touch process env.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let raw = |k: &str, d: &str| get(k).unwrap_or_else(|| d.to_string());
        let opt = |k: &str| {
            get(k)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let pos = |k: &str, d: u64| -> Result<u64, String> {
            match opt(k) {
                None => Ok(d),
                Some(v) => v.parse::<u64>().ok().filter(|n| *n > 0).ok_or_else(|| {
                    format!("Invalid env var {k}: expected a positive integer, got {v:?}")
                }),
            }
        };
        let flag = |k: &str| matches!(get(k).as_deref(), Some("1" | "true"));
        let is_prod = get("NODE_ENV").as_deref() == Some("production");

        let stream_token_secret = get("STREAM_TOKEN_SECRET")
            .filter(|v| !v.trim().is_empty())
            .ok_or("Missing required env var: STREAM_TOKEN_SECRET")?;
        let internal_principal_secret = get("INTERNAL_PRINCIPAL_SECRET").filter(|v| !v.is_empty());
        if is_prod && internal_principal_secret.is_none() {
            return Err("Missing required env var: INTERNAL_PRINCIPAL_SECRET".into());
        }
        if is_prod {
            check_secret("STREAM_TOKEN_SECRET", &stream_token_secret)?;
            if let Some(s) = &internal_principal_secret {
                check_secret("INTERNAL_PRINCIPAL_SECRET", s)?;
            }
        }
        let principal_mode =
            PrincipalMode::parse(&get("MEDIA_INTERNAL_PRINCIPAL_MODE").unwrap_or_default())?;
        if principal_mode == PrincipalMode::Enforce && internal_principal_secret.is_none() {
            return Err(
                "principal_mode=enforce requires INTERNAL_PRINCIPAL_SECRET to be set".into(),
            );
        }
        if internal_principal_secret.as_deref() == Some(stream_token_secret.as_str()) {
            return Err(
                "STREAM_TOKEN_SECRET and INTERNAL_PRINCIPAL_SECRET must be distinct".into(),
            );
        }

        Ok(Config {
            host: raw("IPTV_HOST", "127.0.0.1"),
            port: pos("IPTV_PORT", 8004)?
                .try_into()
                .map_err(|_| "Invalid env var IPTV_PORT: out of range".to_string())?,
            xtream_host: raw("XTREAM_HOST", ""),
            xtream_username: raw("XTREAM_USERNAME", ""),
            xtream_password: raw("XTREAM_PASSWORD", ""),
            iptv_db_path: raw("IPTV_DB_PATH", "./data/iptv.db"),
            iptv_epg_path: opt("IPTV_EPG_PATH").unwrap_or_else(|| "/xmltv.php".into()),
            iptv_external_epg_urls: match opt("IPTV_EXTERNAL_EPG_URLS") {
                None => vec![DEFAULT_EXTERNAL_EPG_URL.to_string()],
                Some(v) => v
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
            },
            iptv_max_concurrent_streams: pos("IPTV_MAX_CONCURRENT_STREAMS", 4)?,
            iptv_max_upstream_connections: pos("IPTV_MAX_UPSTREAM_CONNECTIONS", 2)?,
            iptv_feed_check: get("IPTV_FEED_CHECK").as_deref() != Some("0"),
            iptv_feed_sweep_hours_utc: raw("IPTV_FEED_SWEEP_HOURS_UTC", "9-15"),
            iptv_stream_token_ttl_secs: pos("IPTV_STREAM_TOKEN_TTL_SECS", 300)?,
            iptv_live_token_ttl_secs: pos("IPTV_LIVE_TOKEN_TTL_SECS", 43_200)?,
            iptv_ondemand_token_ttl_secs: pos("IPTV_ONDEMAND_TOKEN_TTL_SECS", 21_600)?,
            iptv_list_timeout_ms: pos("IPTV_LIST_TIMEOUT_MS", 30_000)?,
            iptv_manifest_fetch_timeout_ms: pos("IPTV_MANIFEST_FETCH_TIMEOUT_MS", 10_000)?,
            iptv_manifest_max_bytes: pos("IPTV_MANIFEST_MAX_BYTES", 2 * 1024 * 1024)?,
            iptv_sync_cron: raw("IPTV_SYNC_CRON", "0 */6 * * *"),
            iptv_remux_tmp_dir: raw("IPTV_REMUX_TMP_DIR", "/tmp/iptv-remux"),
            iptv_reencode_preset: raw("IPTV_REENCODE_PRESET", "veryfast"),
            iptv_reencode_threads: pos("IPTV_REENCODE_THREADS", 2)?,
            iptv_reencode_max_height: pos("IPTV_REENCODE_MAX_HEIGHT", 1080)?,
            iptv_disabled: flag("IPTV_DISABLED"),
            dvr_enabled: flag("DVR_ENABLED"),
            dvr_dir: raw("DVR_DIR", "./data/recordings"),
            stream_token_secret,
            internal_principal_secret,
            principal_mode,
            allowed_origins: get("ALLOWED_ORIGINS")
                .map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
            use_local_recommender: get("USE_LOCAL_RECOMMENDER").as_deref() == Some("1"),
            recommender_url: opt("RECOMMENDER_URL").unwrap_or_else(|| {
                if is_prod {
                    "http://recommender:8000".into()
                } else {
                    "http://localhost:8000".into()
                }
            }),
            recommender_event_secret: opt("RECOMMENDER_EVENT_SECRET"),
        })
    }

    /// The catalog sync and its scheduler only run with provider creds set and
    /// the deployment gate open (server/index.ts registers the cron the same way).
    pub fn sync_enabled(&self) -> bool {
        !self.iptv_disabled
            && !self.xtream_host.is_empty()
            && !self.xtream_username.is_empty()
            && !self.xtream_password.is_empty()
    }
}

fn check_secret(name: &str, value: &str) -> Result<(), String> {
    if SECRET_PLACEHOLDERS.contains(&value.to_lowercase().as_str()) {
        return Err(format!("{name} looks like a placeholder value"));
    }
    if value.len() < SECRET_MIN_LEN {
        return Err(format!(
            "{name} is too short for production ({} chars)",
            value.len()
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn test_config(pairs: &[(&str, &str)]) -> Config {
    let mut map: std::collections::HashMap<String, String> =
        // No test reaches epgshare01: external feeds are opt-in per test.
        [
            ("STREAM_TOKEN_SECRET", "s".repeat(40)),
            ("IPTV_EXTERNAL_EPG_URLS", ",".to_string()),
        ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
    for (k, v) in pairs {
        map.insert(k.to_string(), v.to_string());
    }
    Config::from_lookup(|k| map.get(k).cloned()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_env_ts() {
        let c = test_config(&[]);
        assert_eq!(c.iptv_db_path, "./data/iptv.db");
        assert_eq!(c.iptv_sync_cron, "0 */6 * * *");
        assert_eq!(c.iptv_list_timeout_ms, 30_000);
        assert_eq!(c.iptv_max_upstream_connections, 2);
        assert!(c.iptv_feed_check && !c.iptv_disabled && !c.dvr_enabled);
        assert!(!c.sync_enabled(), "no creds, no sync");
        let c = test_config(&[
            ("XTREAM_HOST", "http://p"),
            ("XTREAM_USERNAME", "u"),
            ("XTREAM_PASSWORD", "p"),
        ]);
        assert!(c.sync_enabled());
    }

    #[test]
    fn external_epg_urls_parse_like_env_ts() {
        let urls = |v: &str| test_config(&[("IPTV_EXTERNAL_EPG_URLS", v)]).iptv_external_epg_urls;
        assert_eq!(urls("   "), vec![DEFAULT_EXTERNAL_EPG_URL]);
        assert_eq!(
            urls(" https://a/x.xml , , https://b/y.xml.gz "),
            vec!["https://a/x.xml", "https://b/y.xml.gz"]
        );
        assert!(urls(",").is_empty());
        let unset = Config::from_lookup(|k| (k == "STREAM_TOKEN_SECRET").then(|| "s".repeat(40)));
        assert_eq!(
            unset.unwrap().iptv_external_epg_urls,
            vec![DEFAULT_EXTERNAL_EPG_URL]
        );
    }

    #[test]
    fn bad_positive_int_and_weak_prod_secret_fail_the_boot() {
        let get = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(
            Config::from_lookup(get(&[
                ("STREAM_TOKEN_SECRET", "x"),
                ("IPTV_LIST_TIMEOUT_MS", "abc")
            ]))
            .is_err()
        );
        assert!(
            Config::from_lookup(get(&[
                ("STREAM_TOKEN_SECRET", "x"),
                ("IPTV_LIST_TIMEOUT_MS", "0")
            ]))
            .is_err()
        );
        assert!(
            Config::from_lookup(get(&[])).is_err(),
            "STREAM_TOKEN_SECRET is required"
        );
        assert!(
            Config::from_lookup(get(&[
                ("NODE_ENV", "production"),
                ("STREAM_TOKEN_SECRET", "short"),
                (
                    "INTERNAL_PRINCIPAL_SECRET",
                    "0123456789abcdef0123456789abcdef"
                ),
            ]))
            .is_err()
        );
    }
}
