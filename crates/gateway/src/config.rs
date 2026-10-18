//! Env config for the gateway. Names, defaults and boot rules are
//! `server/env.ts`'s, so the same `.env` carries over. The auth half (secrets,
//! origins, SERVE_SPA, providers, SERVER_DB_PATH, IPTV_SERVICE_URL,
//! IPTV_DISABLED, TOKEN_SWEEP_CRON) is [`auth::config::Config`]; no PLEX_*,
//! ADMINS or IPTV_* provider keys are read.

use serde::Serialize;

const NAS_HOST: &str = "theemeraldexchange.local";

#[derive(Clone)]
pub struct Config {
    pub auth: auth::config::Config,
    pub port: u16,
    pub sonarr_url: String,
    /// None: Sonarr is not configured (typed 503 sonarr_not_configured).
    pub sonarr_api_key: Option<String>,
    pub radarr_url: String,
    pub radarr_api_key: Option<String>,
    pub sab_url: String,
    pub sab_api_key: Option<String>,
    /// Lowercased: compared against lowercased profile names.
    pub default_profile_name: String,
    pub default_sonarr_root_folder_path: Option<String>,
    pub default_radarr_root_folder_path: Option<String>,
    pub min_free_gb: f64,
    pub max_movie_gb: f64,
    pub max_tv_gb_per_episode: f64,
    pub rejections_path: String,
    pub user_feedback_path: String,
    pub user_watchlist_path: String,
    pub user_policies_path: String,
    pub usage_log_path: String,
    pub grab_log_path: String,
    pub suggestions_model: String,
    pub tmdb_read_access_token: Option<String>,
    pub tmdb_api_key: Option<String>,
    pub omdb_api_key: Option<String>,
    pub use_local_recommender: bool,
    pub recommender_url: String,
    /// Required when USE_LOCAL_RECOMMENDER=1.
    pub recommender_event_secret: Option<String>,
    /// exchange.db: read only, for /api/version's schema level.
    pub recommender_db_path: String,
    pub use_media_core: bool,
    /// MUSIC_LIBRARY_PATHS / YOUTUBE_LIBRARY_PATHS set (media-core's config).
    pub music_roots_configured: bool,
    pub youtube_roots_configured: bool,
    pub media_core_url: String,
    pub transcoder_url: String,
    /// media.db: read only (media-core owns every write).
    pub media_db_path: String,
    pub media_stream_token_ttl_secs: u64,
    pub db_backup_dir: String,
    pub db_backup_keep: u32,
    pub db_backup_cron: String,
    pub dvr_enabled: bool,
    /// Handed to client SDKs by /api/telemetry/config.
    pub telemetry_dsn: Option<String>,
    /// The server's own delivery DSN when the public host does not resolve
    /// inside the docker network.
    pub telemetry_dsn_internal: Option<String>,
    pub release: String,
    pub arr_mutate_rate_capacity: u32,
    pub arr_mutate_rate_refill: u32,
    pub arr_mutate_rate_interval_ms: u64,
    /// Third-party bases and the tools the trailer path runs.
    pub ext: External,
}

/// Where TMDB, OMDb, Wikidata, Rotten Tomatoes and Anthropic live and which binaries
/// resolve and mux trailers. The defaults are production's; only
/// EEX_YTRESOLVE_BIN is read from env (as in TS), and tests point the rest
/// at local fakes and stubs.
#[derive(Clone, Debug)]
pub struct External {
    pub tmdb_base: String,
    pub omdb_base: String,
    pub wikidata_sparql: String,
    pub rt_base: String,
    /// The Messages API (`{base}/v1/messages`).
    pub anthropic_base: String,
    pub ytresolve_bin: String,
    pub ytdlp_bin: String,
    pub ffmpeg_bin: String,
    pub ffprobe_bin: String,
    /// Muxed trailers and their part files.
    pub mux_dir: std::path::PathBuf,
}

impl External {
    fn new(ytresolve_bin: Option<String>) -> External {
        External {
            tmdb_base: "https://api.themoviedb.org/3".into(),
            omdb_base: "https://www.omdbapi.com/".into(),
            wikidata_sparql: "https://query.wikidata.org/sparql".into(),
            rt_base: "https://www.rottentomatoes.com/".into(),
            anthropic_base: "https://api.anthropic.com".into(),
            ytresolve_bin: ytresolve_bin.unwrap_or_else(|| "eex-ytresolve".into()),
            ytdlp_bin: "yt-dlp".into(),
            ffmpeg_bin: "ffmpeg".into(),
            ffprobe_bin: "ffprobe".into(),
            mux_dir: std::env::temp_dir().join("eex-ytmux"),
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Build from any key lookup, so tests never touch process env.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let auth = auth::config::Config::from_lookup(&get)?;
        let is_prod = auth.is_prod;
        // compose's ${VAR:-} hands over empty strings: blank counts as unset.
        let opt = |k: &str| {
            get(k)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        // `process.env.X ?? default`: only an unset key takes the default.
        let raw = |k: &str, default: &str| get(k).unwrap_or_else(|| default.into());
        let flag = |k: &str| get(k).as_deref() == Some("1");
        let by_env = |k: &str, prod: &str, dev: &str| {
            opt(k).unwrap_or_else(|| if is_prod { prod } else { dev }.into())
        };
        let positive = |k: &str, default: f64| positive_number(k, opt(k), default);
        let positive_int = |k: &str, default: u64| positive_integer(k, opt(k), default);

        let use_local_recommender = flag("USE_LOCAL_RECOMMENDER");
        let recommender_event_secret = opt("RECOMMENDER_EVENT_SECRET");
        if use_local_recommender && recommender_event_secret.is_none() {
            return Err(
                "Missing required env var when USE_LOCAL_RECOMMENDER=1: RECOMMENDER_EVENT_SECRET"
                    .into(),
            );
        }
        if is_prod && let Some(secret) = &recommender_event_secret {
            auth::config::check_strength("RECOMMENDER_EVENT_SECRET", secret)?;
        }

        let sonarr_api_key = opt("SONARR_API_KEY");
        let radarr_api_key = opt("RADARR_API_KEY");
        let shared_root = opt("DEFAULT_ROOT_FOLDER_PATH");
        let default_sonarr_root_folder_path =
            opt("DEFAULT_SONARR_ROOT_FOLDER_PATH").or_else(|| shared_root.clone());
        let default_radarr_root_folder_path =
            opt("DEFAULT_RADARR_ROOT_FOLDER_PATH").or_else(|| shared_root.clone());
        // Root folders guard non-admin adds, so only a configured *arr needs one.
        if is_prod
            && ((sonarr_api_key.is_some() && default_sonarr_root_folder_path.is_none())
                || (radarr_api_key.is_some() && default_radarr_root_folder_path.is_none()))
        {
            return Err(
                "Missing required env var in production: DEFAULT_SONARR_ROOT_FOLDER_PATH \
                        and/or DEFAULT_RADARR_ROOT_FOLDER_PATH (exact upstream root folder paths \
                        for non-admin adds)"
                    .into(),
            );
        }

        let telemetry_dsn = opt("EEX_TELEMETRY_DSN");
        if is_prod && flag("TELEMETRY_ENABLED") && telemetry_dsn.is_none() {
            return Err(
                "Missing required env var in production when TELEMETRY_ENABLED=1: \
                        EEX_TELEMETRY_DSN (Sentry-compatible DSN for your self-hosted Glitchtip \
                        project), or unset TELEMETRY_ENABLED."
                    .into(),
            );
        }

        let port = positive_int("PORT", 3001)?;
        let port = u16::try_from(port)
            .map_err(|_| format!("Invalid env var PORT: expected a TCP port, got {port}"))?;

        Ok(Config {
            port,
            sonarr_url: opt("SONARR_URL").unwrap_or_else(|| format!("http://{NAS_HOST}:8989/tv")),
            sonarr_api_key,
            radarr_url: opt("RADARR_URL")
                .unwrap_or_else(|| format!("http://{NAS_HOST}:7878/movies")),
            radarr_api_key,
            sab_url: opt("SAB_URL").unwrap_or_else(|| format!("http://{NAS_HOST}:8080")),
            sab_api_key: opt("SAB_API_KEY"),
            default_profile_name: opt("DEFAULT_PROFILE_NAME")
                .unwrap_or_else(|| "choose me".into())
                .to_lowercase(),
            default_sonarr_root_folder_path,
            default_radarr_root_folder_path,
            min_free_gb: positive("MIN_FREE_GB", 100.0)?,
            max_movie_gb: positive("MAX_MOVIE_SIZE_GB", 10.0)?,
            max_tv_gb_per_episode: positive("MAX_TV_GB_PER_EPISODE", 5.0)?,
            rejections_path: raw("REJECTIONS_PATH", "./data/rejections.json"),
            user_feedback_path: raw("USER_FEEDBACK_PATH", "./data/user-feedback.json"),
            user_watchlist_path: raw("USER_WATCHLIST_PATH", "./data/user-watchlist.json"),
            user_policies_path: raw("USER_POLICIES_PATH", "./data/user-policies.json"),
            usage_log_path: raw("USAGE_LOG_PATH", "./data/usage.jsonl"),
            grab_log_path: raw("GRAB_LOG_PATH", "./data/grabs.jsonl"),
            suggestions_model: opt("SUGGESTIONS_MODEL")
                .unwrap_or_else(|| "claude-haiku-4-5".into()),
            tmdb_read_access_token: opt("TMDB_READ_ACCESS_TOKEN"),
            tmdb_api_key: opt("TMDB_API_KEY"),
            omdb_api_key: opt("OMDB_API_KEY"),
            use_local_recommender,
            recommender_url: by_env(
                "RECOMMENDER_URL",
                "http://recommender:8000",
                "http://localhost:8000",
            ),
            recommender_event_secret,
            recommender_db_path: raw("RECOMMENDER_DB_PATH", "./data/exchange.db"),
            use_media_core: flag("USE_MEDIA_CORE"),
            music_roots_configured: opt("MUSIC_LIBRARY_PATHS").is_some(),
            youtube_roots_configured: opt("YOUTUBE_LIBRARY_PATHS").is_some(),
            media_core_url: by_env(
                "MEDIA_CORE_URL",
                "http://media-core:8002",
                "http://127.0.0.1:8002",
            ),
            transcoder_url: by_env(
                "MEDIA_TRANSCODER_URL",
                "http://transcoder:8003",
                "http://127.0.0.1:8003",
            ),
            media_db_path: raw("MEDIA_DB_PATH", "./data/media.db"),
            media_stream_token_ttl_secs: positive_int("MEDIA_STREAM_TOKEN_TTL_SECS", 21_600)?,
            db_backup_dir: raw("DB_BACKUP_DIR", "./data/backups"),
            db_backup_keep: small(positive_int("DB_BACKUP_KEEP", 7)?, "DB_BACKUP_KEEP")?,
            db_backup_cron: raw("DB_BACKUP_CRON", "30 3 * * *"),
            dvr_enabled: matches!(get("DVR_ENABLED").as_deref(), Some("1" | "true")),
            telemetry_dsn,
            telemetry_dsn_internal: opt("EEX_TELEMETRY_DSN_INTERNAL"),
            release: opt("EEX_RELEASE").unwrap_or_else(|| "dev".into()),
            arr_mutate_rate_capacity: small(
                positive_int("ARR_MUTATE_RATE_CAPACITY", 12)?,
                "ARR_MUTATE_RATE_CAPACITY",
            )?,
            arr_mutate_rate_refill: small(
                positive_int("ARR_MUTATE_RATE_REFILL", 12)?,
                "ARR_MUTATE_RATE_REFILL",
            )?,
            arr_mutate_rate_interval_ms: positive_int("ARR_MUTATE_RATE_INTERVAL_MS", 60_000)?,
            ext: External::new(opt("EEX_YTRESOLVE_BIN")),
            auth,
        })
    }

    /// TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY is set.
    pub fn tmdb_configured(&self) -> bool {
        self.tmdb_read_access_token.is_some() || self.tmdb_api_key.is_some()
    }

    /// The SPA hides Sonarr/Radarr/SAB surfaces an unconfigured install
    /// cannot serve.
    pub fn sonarr_enabled(&self) -> bool {
        self.sonarr_api_key.is_some()
    }

    pub fn radarr_enabled(&self) -> bool {
        self.radarr_api_key.is_some()
    }

    pub fn sab_enabled(&self) -> bool {
        self.sab_api_key.is_some()
    }

    /// /api/dvr is served only with IPTV on.
    pub fn dvr_mounted(&self) -> bool {
        self.dvr_enabled && !self.auth.iptv_disabled
    }
}

/// A positive finite number (`Number(raw)` in TS). A typo must fail the boot:
/// NaN would silently disable the disk-space gate. Hex literals ("0x10")
/// are refused here where JS read them as numbers.
fn positive_number(name: &str, raw: Option<String>, default: f64) -> Result<f64, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };
    match raw.parse::<f64>() {
        Ok(n) if n.is_finite() && n > 0.0 => Ok(n),
        _ => Err(format!(
            "Invalid env var {name}: expected a positive finite number, got {raw:?}"
        )),
    }
}

fn positive_integer(name: &str, raw: Option<String>, default: u64) -> Result<u64, String> {
    let n = positive_number(name, raw.clone(), default as f64)?;
    if n.fract() != 0.0 || n > u64::MAX as f64 {
        return Err(format!(
            "Invalid env var {name}: expected a positive integer, got {:?}",
            raw.unwrap_or_default()
        ));
    }
    Ok(n as u64)
}

fn small(n: u64, name: &str) -> Result<u32, String> {
    u32::try_from(n).map_err(|_| format!("Invalid env var {name}: {n} is too large"))
}

/// The boot log's authentication posture: public provider flags and
/// deployment booleans only. An origin that is not exactly its own
/// `scheme://host[:port]` logs as `invalid_origin`, so URL credentials or
/// paths never reach the log.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthPosture {
    pub event: &'static str,
    pub providers: Providers,
    pub serve_spa: bool,
    pub trusted_client_ip_headers: bool,
    pub session_cookie_same_site: &'static str,
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Providers {
    pub apple: bool,
    pub google: bool,
    pub workos: bool,
}

pub fn auth_posture(c: &auth::config::Config) -> AuthPosture {
    AuthPosture {
        event: "auth_posture",
        providers: Providers {
            apple: c.apple_client_id.is_some(),
            google: !c.google_client_ids.is_empty(),
            workos: c.workos_client_id.is_some(),
        },
        serve_spa: c.serve_spa,
        trusted_client_ip_headers: c.trust_client_ip_headers,
        session_cookie_same_site: if c.serve_spa || !c.is_prod {
            "lax"
        } else {
            "none"
        },
        allowed_origins: c.allowed_origins.iter().map(|o| safe_origin(o)).collect(),
    }
}

fn safe_origin(value: &str) -> String {
    match reqwest::Url::parse(value) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https")
                && url.origin().ascii_serialization() == value =>
        {
            value.to_string()
        }
        _ => "invalid_origin".into(),
    }
}

#[cfg(test)]
mod tests;
