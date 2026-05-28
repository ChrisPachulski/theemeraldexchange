use std::path::PathBuf;

/// Internal-principal enforcement posture, mirroring the recommender's
/// off → log → enforce rollout. Defaults to `off` so a fresh media-core
/// boots without the secret wired; flip to `enforce` after soak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrincipalMode {
    Off,
    Log,
    Enforce,
}

impl PrincipalMode {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "enforce" => PrincipalMode::Enforce,
            "log" => PrincipalMode::Log,
            _ => PrincipalMode::Off,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub db_path: String,
    pub library_paths: Vec<PathBuf>,
    pub internal_principal_secret: Option<String>,
    pub principal_mode: PrincipalMode,
    pub server_id: String,
    pub tmdb_api_key: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("MEDIA_CORE_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8002);
        let db_path =
            std::env::var("MEDIA_DB_PATH").unwrap_or_else(|_| "./data/media.db".to_string());
        let library_paths = std::env::var("MEDIA_LIBRARY_PATHS")
            .unwrap_or_default()
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
        let internal_principal_secret = std::env::var("INTERNAL_PRINCIPAL_SECRET")
            .ok()
            .filter(|s| !s.is_empty());
        // media-core's own knob, falling back to the recommender's shared
        // posture so a single env flip can govern all internal services.
        let mode_str = std::env::var("MEDIA_INTERNAL_PRINCIPAL_MODE")
            .or_else(|_| std::env::var("RECOMMENDER_INTERNAL_PRINCIPAL_MODE"))
            .unwrap_or_default();
        let principal_mode = PrincipalMode::parse(&mode_str);
        let server_id = std::env::var("SERVER_ID").unwrap_or_default();
        let tmdb_api_key = std::env::var("TMDB_API_KEY").ok().filter(|s| !s.is_empty());

        Config {
            port,
            db_path,
            library_paths,
            internal_principal_secret,
            principal_mode,
            server_id,
            tmdb_api_key,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principal_mode_parse() {
        assert_eq!(PrincipalMode::parse("enforce"), PrincipalMode::Enforce);
        assert_eq!(PrincipalMode::parse(" LOG "), PrincipalMode::Log);
        assert_eq!(PrincipalMode::parse("off"), PrincipalMode::Off);
        assert_eq!(PrincipalMode::parse(""), PrincipalMode::Off);
        assert_eq!(PrincipalMode::parse("garbage"), PrincipalMode::Off);
    }
}
