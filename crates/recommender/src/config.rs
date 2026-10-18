//! Env config, the rules of `recommender/app/config.py`. RECOMMENDER_HOST,
//! RECOMMENDER_PORT and the custom embed model knobs are not ported: the
//! service binds 0.0.0.0:8000 and the MiniLM revision is baked into the image.

use std::path::PathBuf;

pub use media_core::config::PrincipalMode;

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
    pub db_path: PathBuf,
    pub tmdb_api_key: Option<String>,
    /// TMDB_READ_ACCESS_TOKEN: bearer auth, preferred over the api_key.
    pub tmdb_read_access_token: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub event_secret: Option<String>,
    pub internal_principal_secret: Option<String>,
    /// RECOMMENDER_INTERNAL_PRINCIPAL_MODE; unset means enforce in production
    /// and off elsewhere.
    pub principal_mode: PrincipalMode,
    pub cold_start_threshold: i64,
    pub default_recipe: String,
    /// RECOMMENDER_OPTIMIZER_MODEL: the Claude model the nightly optimizer asks.
    pub optimizer_model: String,
    pub optimizer_max_drift_pct: f64,
    pub optimizer_max_tokens: i64,
    pub rec_log_retention_days: i64,
    /// RECOMMENDER_HOLDOUT_PATH; when unset or missing the embedded seed is used.
    pub holdout_path: Option<PathBuf>,
    /// RECOMMENDER_MODEL_DIR: the pinned MiniLM files the image bakes in.
    pub model_dir: PathBuf,
}

/// RECOMMENDER_MODEL_DIR, else the image's baked-in copy.
pub fn model_dir(get: impl Fn(&str) -> Option<String>) -> PathBuf {
    get("RECOMMENDER_MODEL_DIR")
        .filter(|v| !v.is_empty())
        .map_or_else(|| PathBuf::from("/srv/minilm"), PathBuf::from)
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Build from any key lookup, so tests never touch process env.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let is_prod = get("NODE_ENV").as_deref() == Some("production");
        // Python: os.environ.get(k) or None (empty is unset, nothing trimmed).
        let opt = |k: &str| get(k).filter(|v| !v.is_empty());
        let int = |k: &str, d: i64| -> Result<i64, String> {
            match get(k) {
                None => Ok(d),
                Some(v) => v
                    .trim()
                    .parse()
                    .map_err(|_| format!("invalid {k}: {v:?} is not an integer")),
            }
        };
        let secret = |k: &str| -> Result<Option<String>, String> {
            let Some(raw) = get(k).filter(|v| !v.trim().is_empty()) else {
                return Ok(None);
            };
            if is_prod {
                if SECRET_PLACEHOLDERS.contains(&raw.to_lowercase().as_str()) {
                    return Err(format!("{k} looks like a placeholder value"));
                }
                // Python len() counts code points.
                if raw.chars().count() < SECRET_MIN_LEN {
                    return Err(format!("{k} must be at least {SECRET_MIN_LEN} characters"));
                }
            }
            Ok(Some(raw))
        };

        let internal_principal_secret = secret("INTERNAL_PRINCIPAL_SECRET")?;
        let principal_mode = match get("RECOMMENDER_INTERNAL_PRINCIPAL_MODE") {
            Some(v) if !v.trim().is_empty() => PrincipalMode::parse(&v)
                .map_err(|e| format!("RECOMMENDER_INTERNAL_PRINCIPAL_MODE: {e}"))?,
            _ if is_prod => PrincipalMode::Enforce,
            _ => PrincipalMode::Off,
        };
        // A verifying mode without its secret would 503 every request: fail the boot.
        if is_prod && principal_mode != PrincipalMode::Off && internal_principal_secret.is_none() {
            return Err(format!(
                "INTERNAL_PRINCIPAL_SECRET must be set when RECOMMENDER_INTERNAL_PRINCIPAL_MODE \
                 is {principal_mode:?} (the production default). Provision the secret, or set \
                 RECOMMENDER_INTERNAL_PRINCIPAL_MODE=off to explicitly opt out."
            ));
        }
        // /score and every /events/* endpoint 503 without it: fail the boot.
        let event_secret = secret("RECOMMENDER_EVENT_SECRET")?;
        if is_prod && event_secret.is_none() {
            return Err(
                "RECOMMENDER_EVENT_SECRET must be set in production: /score and all \
                        /events/* endpoints 503 without it, so the recommender is inert. \
                        Provision the secret (shared with the gateway)."
                    .into(),
            );
        }

        let db_path = get("RECOMMENDER_DB_PATH").unwrap_or_else(|| "./data/exchange.db".into());
        Ok(Config {
            db_path: std::path::absolute(&db_path)
                .map_err(|e| format!("RECOMMENDER_DB_PATH {db_path:?}: {e}"))?,
            tmdb_api_key: opt("TMDB_API_KEY"),
            tmdb_read_access_token: opt("TMDB_READ_ACCESS_TOKEN"),
            anthropic_api_key: opt("ANTHROPIC_API_KEY"),
            event_secret,
            internal_principal_secret,
            principal_mode,
            cold_start_threshold: int("RECOMMENDER_COLD_START_THRESHOLD", 10)?,
            default_recipe: get("RECOMMENDER_DEFAULT_RECIPE")
                .unwrap_or_else(|| "mmr_diverse".into()),
            // Python os.environ.get(k, default): an empty value stays empty.
            optimizer_model: get("RECOMMENDER_OPTIMIZER_MODEL")
                .unwrap_or_else(|| "claude-haiku-4-5-20251001".into()),
            optimizer_max_drift_pct: match get("RECOMMENDER_OPTIMIZER_MAX_DRIFT_PCT") {
                None => 0.20,
                Some(v) => v.trim().parse().map_err(|_| {
                    format!("invalid RECOMMENDER_OPTIMIZER_MAX_DRIFT_PCT: {v:?} is not a number")
                })?,
            },
            optimizer_max_tokens: int("RECOMMENDER_OPTIMIZER_MAX_TOKENS", 8000)?,
            rec_log_retention_days: int("RECOMMENDER_REC_LOG_RETENTION_DAYS", 90)?,
            holdout_path: opt("RECOMMENDER_HOLDOUT_PATH").map(PathBuf::from),
            model_dir: model_dir(&get),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(pairs: &[(&str, &str)]) -> Result<Config, String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(move |k| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
    }

    const EVENT: &str = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const PRINCIPAL: &str = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

    // recommender/tests/test_config_principal_mode.py, case for case.
    #[test]
    fn mode_defaults_off_outside_production() {
        assert_eq!(load(&[]).unwrap().principal_mode, PrincipalMode::Off);
    }

    #[test]
    fn mode_defaults_enforce_in_production() {
        let c = load(&[
            ("NODE_ENV", "production"),
            ("RECOMMENDER_EVENT_SECRET", EVENT),
            ("INTERNAL_PRINCIPAL_SECRET", PRINCIPAL),
        ])
        .unwrap();
        assert_eq!(c.principal_mode, PrincipalMode::Enforce);
    }

    #[test]
    fn production_default_fails_fast_without_secret() {
        assert!(
            load(&[
                ("NODE_ENV", "production"),
                ("RECOMMENDER_EVENT_SECRET", EVENT)
            ])
            .is_err()
        );
    }

    #[test]
    fn production_explicit_off_opts_out_without_secret() {
        let c = load(&[
            ("NODE_ENV", "production"),
            ("RECOMMENDER_INTERNAL_PRINCIPAL_MODE", "off"),
            ("RECOMMENDER_EVENT_SECRET", EVENT),
        ])
        .unwrap();
        assert_eq!(c.principal_mode, PrincipalMode::Off);
    }

    #[test]
    fn explicit_log_in_production_requires_secret() {
        assert!(
            load(&[
                ("NODE_ENV", "production"),
                ("RECOMMENDER_INTERNAL_PRINCIPAL_MODE", "log"),
                ("RECOMMENDER_EVENT_SECRET", EVENT),
            ])
            .is_err()
        );
    }

    #[test]
    fn production_fails_fast_without_event_secret() {
        let err = load(&[
            ("NODE_ENV", "production"),
            ("RECOMMENDER_INTERNAL_PRINCIPAL_MODE", "off"),
        ])
        .err()
        .unwrap();
        assert!(err.contains("RECOMMENDER_EVENT_SECRET"), "{err}");
    }

    #[test]
    fn invalid_mode_still_raises() {
        assert!(load(&[("RECOMMENDER_INTERNAL_PRINCIPAL_MODE", "bogus")]).is_err());
    }

    #[test]
    fn production_secret_rules() {
        let prod = |secret: &str| {
            load(&[
                ("NODE_ENV", "production"),
                ("RECOMMENDER_INTERNAL_PRINCIPAL_MODE", "off"),
                ("RECOMMENDER_EVENT_SECRET", secret),
            ])
        };
        assert!(prod("ChangeMe").err().unwrap().contains("placeholder"));
        assert!(prod(&"a".repeat(31)).err().unwrap().contains("at least 32"));
        // 32 code points, more bytes: Python accepts it.
        assert!(prod(&"é".repeat(32)).is_ok());
        assert!(prod("   ").is_err(), "blank is unset");
        // Outside production anything non-blank goes, untrimmed.
        assert_eq!(
            load(&[("RECOMMENDER_EVENT_SECRET", " test ")])
                .unwrap()
                .event_secret
                .as_deref(),
            Some(" test ")
        );
        assert!(
            load(&[("RECOMMENDER_EVENT_SECRET", " ")])
                .unwrap()
                .event_secret
                .is_none()
        );
    }

    #[test]
    fn defaults_and_overrides() {
        let c = load(&[]).unwrap();
        assert!(c.db_path.is_absolute() && c.db_path.ends_with("data/exchange.db"));
        assert_eq!(c.cold_start_threshold, 10);
        assert_eq!(c.default_recipe, "mmr_diverse");
        assert_eq!(c.optimizer_max_drift_pct, 0.20);
        assert_eq!(c.optimizer_max_tokens, 8000);
        assert_eq!(c.optimizer_model, "claude-haiku-4-5-20251001");
        assert_eq!(c.rec_log_retention_days, 90);
        assert_eq!(c.model_dir, PathBuf::from("/srv/minilm"));
        assert!(c.tmdb_api_key.is_none() && c.anthropic_api_key.is_none());
        assert!(c.tmdb_read_access_token.is_none());
        let c = load(&[
            ("RECOMMENDER_DB_PATH", "/data/exchange.db"),
            ("RECOMMENDER_COLD_START_THRESHOLD", "3"),
            ("RECOMMENDER_DEFAULT_RECIPE", "ranker"),
            ("RECOMMENDER_OPTIMIZER_MAX_DRIFT_PCT", "0.5"),
            ("TMDB_API_KEY", "k"),
            ("TMDB_READ_ACCESS_TOKEN", ""),
            ("ANTHROPIC_API_KEY", ""),
            ("RECOMMENDER_MODEL_DIR", "/m"),
        ])
        .unwrap();
        assert_eq!(c.model_dir, PathBuf::from("/m"));
        assert_eq!(c.db_path, PathBuf::from("/data/exchange.db"));
        assert_eq!(c.cold_start_threshold, 3);
        assert_eq!(c.default_recipe, "ranker");
        assert_eq!(c.optimizer_max_drift_pct, 0.5);
        assert_eq!(c.tmdb_api_key.as_deref(), Some("k"));
        assert!(c.tmdb_read_access_token.is_none(), "empty is unset");
        assert!(c.anthropic_api_key.is_none());
        assert!(load(&[("RECOMMENDER_COLD_START_THRESHOLD", "ten")]).is_err());
    }
}
