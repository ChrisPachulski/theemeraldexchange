//! HTTP surface. `/health` + `/version` are public; everything under
//! `/api/media/*` sits behind the internal-principal layer.
//!
//! This module owns the router assembly, the principal layer wiring, and the
//! helpers more than one resource needs (pagination, FTS escaping, path
//! containment, acting-sub resolution, the admin gate). Handlers live in the
//! per-resource submodules below and are re-exported here where other crates
//! consume the type.

use axum::Json;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Extension, Router, middleware};
use emerald_contracts::internal_principal::InternalClaims;
use serde::Deserialize;
use serde_json::{Value, json};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::auth::principal_layer;
use crate::capability::{self, ClientCaps};
use crate::config::PrincipalMode;
use crate::error::{AppError, AppResult};
use crate::models::{EpisodeRow, MediaFileRow, MovieRow, ShowRow, WatchStateRow};
use crate::scanner;
use crate::{AppState, SCHEMA_VERSION};

mod audiobooks;
mod catalog;
mod collections;
mod health;
mod library;
mod markers;
mod music;
mod photos;
mod playlists;
mod podcasts;
mod scan;
mod stores;
mod stream;
mod subtitles;
#[cfg(test)]
mod testsupport;
mod watch;

pub use markers::{MarkerQuery, MarkerUpsert};
pub use podcasts::PodcastAddBody;
pub use stores::{ListItemBody, ListItemQuery, NameBody, ReorderBody};
pub use subtitles::{SubtitleFileQuery, SubtitleLangBody};
pub use watch::{WatchQuery, WatchUpsert};

use self::audiobooks::{get_audiobook, list_audiobooks};
use self::collections::{
    add_collection_item, create_collection, delete_collection, delete_collection_item,
    get_collection, list_collections, rename_collection,
};
use self::health::{health, version};
use self::library::{
    get_episode, get_movie, get_show, list_episodes, list_episodes_all, list_movies, list_shows,
};
use self::markers::{delete_marker, get_markers, put_marker};
use self::music::{album_art, list_albums, list_artists, list_tracks};
use self::photos::{list_photos, photo_file};
use self::playlists::{
    add_playlist_item, create_playlist, delete_playlist, delete_playlist_item, get_playlist,
    list_playlists, rename_playlist, reorder_playlist,
};
use self::podcasts::{
    add_podcast, delete_podcast, list_podcast_episodes, list_podcasts, refresh_podcast_route,
};
use self::scan::{scan_status, trigger_scan};
use self::stream::{play_grant, stream_file};
use self::subtitles::{
    download_subtitle, list_subtitles, subtitle_file, subtitle_job_status, transcribe_subtitle,
};
use self::watch::{delete_watch, get_watch, post_watch};

/// Bounded total-request timeout for the small, fast JSON/metadata handlers. The
/// streaming route is intentionally excluded (see [`router`]).
const API_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub fn router(state: AppState) -> Router {
    // §7-2: the fast JSON/metadata handlers get a bounded TimeoutLayer so a
    // wedged query cannot pin a connection indefinitely. The direct-play
    // `/stream` route is split out and NOT wrapped — a blanket request timeout
    // there would truncate a legitimate multi-hour playback. Its abuse vector
    // (too many long-lived streams) is instead bounded by the per-instance
    // `stream_semaphore` that `stream_file` acquires.
    let timed_api = Router::new()
        .route("/movies", get(list_movies))
        .route("/movies/{id}", get(get_movie))
        .route("/shows", get(list_shows))
        .route("/shows/{id}", get(get_show))
        .route("/shows/{id}/episodes", get(list_episodes))
        .route("/episodes", get(list_episodes_all))
        .route("/episodes/{id}", get(get_episode))
        .route("/music/artists", get(list_artists))
        .route("/music/albums", get(list_albums))
        .route("/music/albums/{id}/art", get(album_art))
        .route("/music/tracks", get(list_tracks))
        .route("/play/{kind}/{id}/grant", post(play_grant))
        .route(
            "/watch",
            get(get_watch).post(post_watch).delete(delete_watch),
        )
        .route("/playlists", get(list_playlists).post(create_playlist))
        .route(
            "/playlists/{id}",
            get(get_playlist)
                .put(rename_playlist)
                .delete(delete_playlist),
        )
        .route(
            "/playlists/{id}/items",
            post(add_playlist_item)
                .put(reorder_playlist)
                .delete(delete_playlist_item),
        )
        .route(
            "/collections",
            get(list_collections).post(create_collection),
        )
        .route(
            "/collections/{id}",
            get(get_collection)
                .put(rename_collection)
                .delete(delete_collection),
        )
        .route(
            "/collections/{id}/items",
            post(add_collection_item).delete(delete_collection_item),
        )
        .route("/photos", get(list_photos))
        .route("/photos/{id}/file", get(photo_file))
        .route("/audiobooks", get(list_audiobooks))
        .route("/audiobooks/{id}", get(get_audiobook))
        .route("/podcasts", get(list_podcasts).post(add_podcast))
        .route("/podcasts/{id}", axum::routing::delete(delete_podcast))
        .route("/podcasts/{id}/refresh", post(refresh_podcast_route))
        .route("/podcasts/{id}/episodes", get(list_podcast_episodes))
        .route("/subtitles/status", get(subtitle_job_status))
        .route("/subtitles/{kind}/{id}", get(list_subtitles))
        .route("/subtitles/{kind}/{id}/file", get(subtitle_file))
        .route("/subtitles/{kind}/{id}/download", post(download_subtitle))
        .route(
            "/subtitles/{kind}/{id}/transcribe",
            post(transcribe_subtitle),
        )
        .route(
            "/markers",
            get(get_markers).put(put_marker).delete(delete_marker),
        )
        .route("/scan", post(trigger_scan))
        .route("/scan/status", get(scan_status))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            API_REQUEST_TIMEOUT,
        ));

    let stream_api = Router::new().route("/stream/{kind}/{id}", get(stream_file));

    let api = timed_api
        .merge(stream_api)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            principal_layer,
        ));

    Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .nest("/api/media", api)
        .with_state(state)
}

/// List-endpoint query params. Every field here is evaluated — do not add
/// accepted-but-ignored params (a `genre` filter was once deserialized and
/// silently dropped; nothing in server/ or the SPA ever sent it).
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Normalize the pagination knobs: limit defaults to 50 and clamps to
/// `1..=200`; offset defaults to 0 and never goes negative.
fn paginate(limit: Option<i64>, offset: Option<i64>) -> (i64, i64) {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let offset = offset.unwrap_or(0).max(0);
    (limit, offset)
}

/// Turn a free-text search box value into a safe FTS5 MATCH expression (§7-7).
///
/// Each whitespace-separated word becomes a double-quoted prefix term
/// (`"word"*`) AND-ed together, so "the dark" matches a row with a token
/// starting with "the" and one starting with "dark", case- and diacritic-folded
/// by the unicode61/remove_diacritics tokenizer. Quoting makes every term a
/// string literal, so FTS5 operators a user might type (`-`, `*`, `:`, `(`, `"`,
/// `AND`/`OR`/`NOT`) cannot inject query syntax. Returns `None` when the term
/// has no usable tokens, so the caller falls back to the unfiltered listing.
fn fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        .map(|w| w.replace('"', "").trim().to_string())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// Page-only query params for the endpoints with no search box (photos,
/// audiobooks, podcast episodes).
#[derive(Debug, Deserialize)]
pub struct PageQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Content type by extension for the photo and album-art file endpoints.
pub(super) fn image_content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()) {
        Some(ext) => match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "heic" | "heif" => "image/heic",
            "tif" | "tiff" => "image/tiff",
            "bmp" => "image/bmp",
            _ => "application/octet-stream",
        },
        None => "application/octet-stream",
    }
}

/// Defense-in-depth: a streamed path must resolve inside one of the configured
/// library roots. The path is DB-sourced (not raw user input), but a buggy or
/// poisoned scan could persist a path containing `..` or a symlink escaping the
/// library; we must never serve such a file. Canonicalizes both sides so `..`
/// and symlinks are resolved before the prefix check. With no roots configured
/// (dev/tests), containment is skipped. Uses `tokio::fs` so the canonicalize
/// syscalls (blocking FS I/O, possibly against a stalled mount) run off the
/// async runtime instead of pinning a request worker.
async fn path_within_roots(path: &std::path::Path, roots: &[std::path::PathBuf]) -> bool {
    if roots.is_empty() {
        return true;
    }
    let Ok(canon) = tokio::fs::canonicalize(path).await else {
        return false;
    };
    for r in roots {
        if let Ok(root) = tokio::fs::canonicalize(r).await
            && canon.starts_with(&root)
        {
            return true;
        }
    }
    false
}

/// Resolve the acting `sub`. A verified internal principal is always
/// authoritative. The client-supplied `?sub=` fallback is honored **only** in
/// `Off` mode (local/dev, no auth boundary). In `log`/`enforce` mode, trusting
/// `?sub=` would be an IDOR: an authenticated caller — or, in `log` mode, one
/// whose token simply failed to verify — could read or overwrite any other
/// user's watch state by naming their `sub`. So outside `Off` mode the only
/// accepted identity is the verified principal.
fn acting_sub(
    claims: &Option<InternalClaims>,
    query_sub: Option<String>,
    mode: &PrincipalMode,
) -> AppResult<String> {
    if let Some(c) = claims {
        return Ok(c.sub.clone());
    }
    if *mode != PrincipalMode::Off {
        return Err(AppError::Unauthorized(
            "internal-principal required to resolve acting user".into(),
        ));
    }
    match query_sub.filter(|s| !s.is_empty()) {
        Some(s) => Ok(s),
        None => Err(AppError::BadRequest("sub required".into())),
    }
}

/// Admin gate for marker writes. Mirrors [`authorize_scan`]: `Off` mode (local
/// dev, no auth boundary) allows; otherwise only a verified `admin` principal.
fn require_admin(claims: &Option<InternalClaims>, mode: &PrincipalMode) -> AppResult<()> {
    if *mode == PrincipalMode::Off {
        return Ok(());
    }
    let is_admin = claims.as_ref().map(|c| c.role == "admin").unwrap_or(false);
    if is_admin {
        Ok(())
    } else {
        Err(AppError::Unauthorized("admin role required".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn require_admin_gate() {
        use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims};
        let now = 1_748_000_000;
        let claims = |role: &str| {
            Some(InternalClaims {
                iss: "eex".into(),
                sub: "plex:1".into(),
                role: role.into(),
                auth_mode: "plex".into(),
                server_id: "s".into(),
                device_id: None,
                req_id: "r".into(),
                iat: now,
                exp: now + DEFAULT_TTL_SECS,
            })
        };
        assert!(require_admin(&claims("admin"), &PrincipalMode::Enforce).is_ok());
        assert!(matches!(
            require_admin(&claims("user"), &PrincipalMode::Enforce),
            Err(AppError::Unauthorized(_))
        ));
        // Off mode (local dev) allows even without claims.
        assert!(require_admin(&None, &PrincipalMode::Off).is_ok());
    }

    #[tokio::test]
    async fn acting_sub_rejects_query_sub_outside_off_mode() {
        use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims};
        // Off mode: ?sub= is honored (local/dev).
        assert_eq!(
            acting_sub(&None, Some("plex:1".into()), &PrincipalMode::Off).unwrap(),
            "plex:1"
        );
        // Log mode with no verified claims (e.g. a token that failed to
        // verify): ?sub= must be REJECTED — this is the IDOR guard.
        let err = acting_sub(&None, Some("plex:victim".into()), &PrincipalMode::Log);
        assert!(matches!(err, Err(AppError::Unauthorized(_))));
        // Enforce mode likewise rejects a bare ?sub=.
        let err = acting_sub(&None, Some("plex:victim".into()), &PrincipalMode::Enforce);
        assert!(matches!(err, Err(AppError::Unauthorized(_))));
        // A verified principal is always authoritative and ignores ?sub=.
        let now = 1_748_000_000;
        let claims = Some(InternalClaims {
            iss: "eex".into(),
            sub: "plex:real".into(),
            role: "user".into(),
            auth_mode: "plex".into(),
            server_id: "srv".into(),
            device_id: None,
            req_id: "r1".into(),
            iat: now,
            exp: now + DEFAULT_TTL_SECS,
        });
        assert_eq!(
            acting_sub(
                &claims,
                Some("plex:attacker".into()),
                &PrincipalMode::Enforce
            )
            .unwrap(),
            "plex:real"
        );
    }
}
