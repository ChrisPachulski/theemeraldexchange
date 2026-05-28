use std::path::PathBuf;

use crate::filename::RootKind;

/// A configured library root plus its authoritative kind, inferred from the
/// path's final component (`tv`/`shows`/`series` → Shows, `movies`/`films` →
/// Movies, else Auto). The kind, not the filename, decides movie-vs-episode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryRoot {
    pub path: PathBuf,
    pub kind: RootKind,
}

impl LibraryRoot {
    /// Build a root from a path, inferring kind from its last component.
    pub fn from_path(path: PathBuf) -> Self {
        let kind = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(infer_root_kind)
            .unwrap_or(RootKind::Auto);
        LibraryRoot { path, kind }
    }
}

/// Infer a [`RootKind`] from a directory's final component name.
fn infer_root_kind(name: &str) -> RootKind {
    let lower = name.to_ascii_lowercase();
    let normalized = lower.replace(['_', '-', ' '], "");
    match normalized.as_str() {
        "tv" | "tvshows" | "shows" | "series" => RootKind::Shows,
        "movies" | "films" | "film" => RootKind::Movies,
        _ => RootKind::Auto,
    }
}

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
    pub host: String,
    pub port: u16,
    pub db_path: String,
    pub library_roots: Vec<LibraryRoot>,
    pub internal_principal_secret: Option<String>,
    pub principal_mode: PrincipalMode,
    pub server_id: String,
    pub tmdb_api_key: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        // Defaults to loopback for dev safety; compose sets 0.0.0.0 so the
        // backend container can reach it over the docker network while the
        // published port stays bound to the NAS host's 127.0.0.1.
        let host = std::env::var("MEDIA_CORE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("MEDIA_CORE_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8002);
        let db_path =
            std::env::var("MEDIA_DB_PATH").unwrap_or_else(|_| "./data/media.db".to_string());
        let library_roots = std::env::var("MEDIA_LIBRARY_PATHS")
            .unwrap_or_default()
            .split(':')
            .filter(|s| !s.is_empty())
            .map(|s| LibraryRoot::from_path(PathBuf::from(s)))
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
            host,
            port,
            db_path,
            library_roots,
            internal_principal_secret,
            principal_mode,
            server_id,
            tmdb_api_key,
        }
    }

    /// The bare root paths, for call sites that only need locations.
    pub fn library_paths(&self) -> Vec<PathBuf> {
        self.library_roots.iter().map(|r| r.path.clone()).collect()
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

    #[test]
    fn root_kind_inferred_from_final_component() {
        assert_eq!(
            LibraryRoot::from_path(PathBuf::from("/media/Movies")).kind,
            RootKind::Movies
        );
        assert_eq!(
            LibraryRoot::from_path(PathBuf::from("/media/films")).kind,
            RootKind::Movies
        );
        assert_eq!(
            LibraryRoot::from_path(PathBuf::from("/media/tv_shows")).kind,
            RootKind::Shows
        );
        assert_eq!(
            LibraryRoot::from_path(PathBuf::from("/media/Series")).kind,
            RootKind::Shows
        );
        assert_eq!(
            LibraryRoot::from_path(PathBuf::from("/media/tv")).kind,
            RootKind::Shows
        );
        assert_eq!(
            LibraryRoot::from_path(PathBuf::from("/media/misc")).kind,
            RootKind::Auto
        );
    }

    #[test]
    fn parses_typed_roots_in_order() {
        // MEDIA_LIBRARY_PATHS=/media/Movies:/media/tv_shows -> [Movies, Shows]
        let roots: Vec<LibraryRoot> = "/media/Movies:/media/tv_shows"
            .split(':')
            .filter(|s| !s.is_empty())
            .map(|s| LibraryRoot::from_path(PathBuf::from(s)))
            .collect();
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].kind, RootKind::Movies);
        assert_eq!(roots[1].kind, RootKind::Shows);
    }
}
