use std::path::PathBuf;

use crate::filename::RootKind;

/// Default seconds between automatic background scans when
/// `MEDIA_SCAN_INTERVAL_SECS` is unset or malformed (one hour).
pub const DEFAULT_SCAN_INTERVAL_SECS: u64 = 3600;

/// Parse a boolean-ish env var. Recognizes `1/true/yes/on` (true) and
/// `0/false/no/off` (false), case-insensitively; an unset or unrecognized
/// value falls back to `default`. Used for soft toggles where a typo should
/// not fail boot.
fn parse_bool_env(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

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
    /// Parse the posture from an env string. An empty/unset value defaults to
    /// `Off` (a fresh boot with no secret wired). Any *non-empty* value that
    /// is not a known posture is an error rather than a silent fall-through to
    /// `Off` — a typo in `MEDIA_INTERNAL_PRINCIPAL_MODE` must not quietly
    /// disable auth.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "off" => Ok(PrincipalMode::Off),
            "log" => Ok(PrincipalMode::Log),
            "enforce" => Ok(PrincipalMode::Enforce),
            other => Err(format!(
                "invalid principal mode {other:?} (expected off|log|enforce)"
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub db_path: String,
    pub library_roots: Vec<LibraryRoot>,
    /// Audio library roots, parsed from `MUSIC_LIBRARY_PATHS` (colon-separated,
    /// same shape as `MEDIA_LIBRARY_PATHS`). Music has no movie/episode
    /// classification, so these are plain paths, not typed [`LibraryRoot`]s. An
    /// empty list disables the music scan entirely (the M3-only posture).
    pub music_roots: Vec<PathBuf>,
    pub internal_principal_secret: Option<String>,
    pub principal_mode: PrincipalMode,
    pub server_id: String,
    pub tmdb_api_key: Option<String>,
    /// Seconds between automatic background scans. `0` disables the periodic
    /// scheduler entirely (manual `POST /scan` still works). Parsed from
    /// `MEDIA_SCAN_INTERVAL_SECS`; defaults to one hour.
    pub scan_interval_secs: u64,
    /// Whether to run one scan on boot so a freshly deployed instance indexes
    /// its library without an external poke. Parsed from `MEDIA_BOOT_SCAN`
    /// (`0`/`false`/`no`/`off` → disabled); defaults to enabled.
    pub boot_scan: bool,
    /// Base URL of the M4 transcoder (e.g. `http://transcoder:8003`), read from
    /// `MEDIA_TRANSCODER_URL`. When `Some`, a file that cannot direct-play is
    /// handed off to the transcoder (`POST /api/transcode/grant`) instead of
    /// returning `503`. When `None` (the M3-only posture), the transcode-required
    /// path keeps returning `503 transcoder required` — so leaving the env unset
    /// preserves the pre-M4 behavior exactly. An empty string is treated as unset.
    pub transcoder_url: Option<String>,
    /// OpenSubtitles REST API key (`OPENSUBTITLES_API_KEY`). Unset → the
    /// subtitle download endpoint answers 503 feature-disabled.
    pub opensubtitles_api_key: Option<String>,
    /// Whisper CLI binary (`WHISPER_BIN`) honoring the openai-whisper argument
    /// convention (whisper.cpp users point this at a wrapper script). Unset →
    /// the transcription endpoint answers 503 feature-disabled.
    pub whisper_bin: Option<String>,
    /// Whisper model name (`WHISPER_MODEL`, e.g. `small`); omitted → the
    /// CLI's own default.
    pub whisper_model: Option<String>,
    /// Where downloaded/generated sidecar subtitles live
    /// (`MEDIA_SUBTITLES_DIR`; default `<db dir>/subtitles`).
    pub subtitles_dir: PathBuf,
}

impl Config {
    /// Build config from the environment, failing fast on an unsafe or
    /// self-contradictory posture rather than silently degrading auth.
    pub fn from_env() -> Result<Self, String> {
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
        // Music roots share MEDIA_LIBRARY_PATHS' colon-separated shape but carry
        // no RootKind (audio needs no movie/episode classification).
        let music_roots = std::env::var("MUSIC_LIBRARY_PATHS")
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
        let principal_mode = PrincipalMode::parse(&mode_str)?;
        let server_id = std::env::var("SERVER_ID").unwrap_or_default();
        let tmdb_api_key = std::env::var("TMDB_API_KEY").ok().filter(|s| !s.is_empty());
        // Scheduler knobs. A malformed interval falls back to the default
        // rather than failing boot — scanning is best-effort and a typo here
        // must not brick the service. `0` is an explicit "disable periodic".
        let scan_interval_secs = std::env::var("MEDIA_SCAN_INTERVAL_SECS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_SCAN_INTERVAL_SECS);
        let boot_scan = parse_bool_env("MEDIA_BOOT_SCAN", true);
        // M4 handoff target. Unset/empty keeps the M3-only 503 path intact.
        let transcoder_url = std::env::var("MEDIA_TRANSCODER_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let opensubtitles_api_key = std::env::var("OPENSUBTITLES_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let whisper_bin = std::env::var("WHISPER_BIN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let whisper_model = std::env::var("WHISPER_MODEL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let subtitles_dir = std::env::var("MEDIA_SUBTITLES_DIR")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| default_subtitles_dir(&db_path));

        // Fail-fast safety gates (pure, unit-tested via `validate_posture`).
        validate_posture(&host, &principal_mode, internal_principal_secret.is_some())?;

        Ok(Config {
            host,
            port,
            db_path,
            library_roots,
            music_roots,
            internal_principal_secret,
            principal_mode,
            server_id,
            tmdb_api_key,
            scan_interval_secs,
            boot_scan,
            transcoder_url,
            opensubtitles_api_key,
            whisper_bin,
            whisper_model,
            subtitles_dir,
        })
    }

    /// The bare root paths, for call sites that only need locations.
    pub fn library_paths(&self) -> Vec<PathBuf> {
        self.library_roots.iter().map(|r| r.path.clone()).collect()
    }
}

/// Sidecar subtitle store beside the database (`<db dir>/subtitles`). An
/// in-memory or bare-filename db path falls back to `./data/subtitles`.
fn default_subtitles_dir(db_path: &str) -> PathBuf {
    std::path::Path::new(db_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("./data"))
        .join("subtitles")
}

/// The outcome of a posture check: refuse to boot, boot with a warning, or
/// boot clean. Separated from logging/`Err` so it can be unit-tested purely.
#[derive(Debug, PartialEq, Eq)]
pub enum PostureCheck {
    Ok,
    Warn(String),
    Reject(String),
}

/// Classify a boot posture. Two distinct failure modes:
///
/// * `enforce` without a secret → **Reject**: it can never verify a token, so
///   every request would 401; booting would be strictly worse than refusing.
/// * non-loopback bind in `off`/`log` → **Warn**, not reject. Inside the NAS
///   docker network media-core *must* bind `0.0.0.0` to be reachable by the
///   backend container, while the published host port stays bound to
///   `127.0.0.1`; the published mapping, not the in-container bind, is the
///   trust boundary. This is also the legitimate state of the `off→log→enforce`
///   soak, so we warn loudly rather than break the rollout.
///
/// A non-empty but unknown mode string is already rejected upstream by
/// [`PrincipalMode::parse`], so a typo can never silently land in `Off` here.
fn classify_posture(host: &str, mode: &PrincipalMode, has_secret: bool) -> PostureCheck {
    if *mode == PrincipalMode::Enforce && !has_secret {
        return PostureCheck::Reject(
            "principal_mode=enforce requires INTERNAL_PRINCIPAL_SECRET to be set".to_string(),
        );
    }
    let loopback = host == "127.0.0.1" || host == "::1" || host == "localhost";
    if !loopback && *mode != PrincipalMode::Enforce {
        return PostureCheck::Warn(format!(
            "binding non-loopback host {host} with principal_mode={mode:?}: ensure the \
             published port is bound to the host's loopback; flip \
             MEDIA_INTERNAL_PRINCIPAL_MODE=enforce once soak is clean"
        ));
    }
    PostureCheck::Ok
}

/// Apply [`classify_posture`], logging a warning or returning an error.
fn validate_posture(host: &str, mode: &PrincipalMode, has_secret: bool) -> Result<(), String> {
    match classify_posture(host, mode, has_secret) {
        PostureCheck::Ok => Ok(()),
        PostureCheck::Warn(msg) => {
            tracing::warn!("media-core posture: {msg}");
            Ok(())
        }
        PostureCheck::Reject(msg) => Err(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principal_mode_parse() {
        assert_eq!(
            PrincipalMode::parse("enforce").unwrap(),
            PrincipalMode::Enforce
        );
        assert_eq!(PrincipalMode::parse(" LOG ").unwrap(), PrincipalMode::Log);
        assert_eq!(PrincipalMode::parse("off").unwrap(), PrincipalMode::Off);
        // Empty/unset → Off (fresh boot, no secret wired).
        assert_eq!(PrincipalMode::parse("").unwrap(), PrincipalMode::Off);
        // A non-empty typo must be a hard error, never a silent Off — a
        // misspelled mode must not quietly disable internal-principal auth.
        assert!(PrincipalMode::parse("garbage").is_err());
        assert!(PrincipalMode::parse("enforced").is_err());
    }

    #[test]
    fn classify_posture_gates() {
        // Loopback + off is the safe default → clean.
        assert_eq!(
            classify_posture("127.0.0.1", &PrincipalMode::Off, false),
            PostureCheck::Ok
        );
        // Loopback + log/enforce(+secret) clean.
        assert_eq!(
            classify_posture("127.0.0.1", &PrincipalMode::Log, true),
            PostureCheck::Ok
        );
        // Non-loopback bind in off/log → WARN (not reject): this is the live
        // docker-network posture AND the legitimate soak state. Breaking it
        // would brick the off→log→enforce rollout.
        assert!(matches!(
            classify_posture("0.0.0.0", &PrincipalMode::Off, true),
            PostureCheck::Warn(_)
        ));
        assert!(matches!(
            classify_posture("0.0.0.0", &PrincipalMode::Log, true),
            PostureCheck::Warn(_)
        ));
        // Non-loopback + enforce + secret is the clean production posture.
        assert_eq!(
            classify_posture("0.0.0.0", &PrincipalMode::Enforce, true),
            PostureCheck::Ok
        );
        // Enforce without a secret can NEVER verify → hard reject (even loopback).
        assert!(matches!(
            classify_posture("127.0.0.1", &PrincipalMode::Enforce, false),
            PostureCheck::Reject(_)
        ));
        assert!(matches!(
            classify_posture("0.0.0.0", &PrincipalMode::Enforce, false),
            PostureCheck::Reject(_)
        ));
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
    fn parse_bool_env_recognizes_truthy_and_falsy() {
        // Use a unique key to avoid cross-test env contamination.
        let key = "MEDIA_TEST_BOOL_TOGGLE";
        unsafe { std::env::remove_var(key) };
        // Unset → default (both directions).
        assert!(parse_bool_env(key, true));
        assert!(!parse_bool_env(key, false));
        for truthy in ["1", "true", "TRUE", " yes ", "On"] {
            unsafe { std::env::set_var(key, truthy) };
            assert!(parse_bool_env(key, false), "expected {truthy:?} → true");
        }
        for falsy in ["0", "false", "NO", " off "] {
            unsafe { std::env::set_var(key, falsy) };
            assert!(!parse_bool_env(key, true), "expected {falsy:?} → false");
        }
        // Garbage → default, never a silent flip.
        unsafe { std::env::set_var(key, "maybe") };
        assert!(parse_bool_env(key, true));
        assert!(!parse_bool_env(key, false));
        unsafe { std::env::remove_var(key) };
    }

    #[test]
    fn scan_interval_default_and_zero_disable() {
        // The default applies when unset or malformed; `0` is preserved as the
        // explicit "disable periodic scheduler" sentinel.
        let parse = |raw: Option<&str>| {
            raw.and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(DEFAULT_SCAN_INTERVAL_SECS)
        };
        assert_eq!(parse(None), DEFAULT_SCAN_INTERVAL_SECS);
        assert_eq!(parse(Some("not-a-number")), DEFAULT_SCAN_INTERVAL_SECS);
        assert_eq!(parse(Some("0")), 0);
        assert_eq!(parse(Some(" 900 ")), 900);
    }

    #[test]
    fn parses_music_roots_colon_separated() {
        // MUSIC_LIBRARY_PATHS mirrors MEDIA_LIBRARY_PATHS' shape: colon-joined,
        // empty segments dropped, order preserved, plain paths (no RootKind).
        let roots: Vec<PathBuf> = "/media/Music:/mnt/flac::/media/Music2"
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/media/Music"),
                PathBuf::from("/mnt/flac"),
                PathBuf::from("/media/Music2"),
            ]
        );
        // Unset → empty (music scan disabled).
        let empty: Vec<PathBuf> = ""
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
        assert!(empty.is_empty());
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
