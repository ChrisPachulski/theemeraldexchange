//! Shared test scaffolding for the `routes` submodules: in-memory app
//! state, request builders, and row seeders. Test-only (`#[cfg(test)]` at
//! the module declaration), so nothing here ships in a release build.

use super::*;
use crate::config::Config;
use axum::body::Body;
use axum::http::Request as HttpRequest;
use std::sync::Arc;

pub(super) async fn test_state() -> AppState {
    // Off-mode: no principal secret/mode wired → principal_layer skips
    // auth, so handlers fall back to the `?sub=` query param. Subtitle
    // feature envs are cleared too so their 503 feature-disabled paths
    // are deterministic regardless of the developer's shell.
    unsafe {
        std::env::remove_var("MEDIA_INTERNAL_PRINCIPAL_MODE");
        std::env::remove_var("RECOMMENDER_INTERNAL_PRINCIPAL_MODE");
        std::env::remove_var("INTERNAL_PRINCIPAL_SECRET");
        std::env::remove_var("OPENSUBTITLES_API_KEY");
        std::env::remove_var("WHISPER_BIN");
    }
    let db = crate::db::Db::connect_memory().await.unwrap();
    let config = Arc::new(Config::from_env().unwrap());
    let tmdb = crate::tmdb::TmdbClient::new(None);
    AppState {
        db,
        config,
        tmdb,
        scanning: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        stream_semaphore: Arc::new(tokio::sync::Semaphore::new(
            crate::DEFAULT_STREAM_CONCURRENCY,
        )),
    }
}

/// Enforce-mode state with a known principal secret wired in, so the
/// `principal_layer` actually verifies the signed Bearer internal-principal
/// token and the admin gate over `/scan` is live.
pub(super) async fn test_state_enforce(secret: &str) -> AppState {
    let db = crate::db::Db::connect_memory().await.unwrap();
    let config = Arc::new(Config {
        host: "127.0.0.1".into(),
        port: 0,
        db_path: ":memory:".into(),
        library_roots: Vec::new(),
        music_roots: Vec::new(),
        photo_roots: Vec::new(),
        audiobook_roots: Vec::new(),
        internal_principal_secret: Some(secret.to_string()),
        principal_mode: PrincipalMode::Enforce,
        server_id: "srv-test".into(),
        tmdb_api_key: None,
        scan_interval_secs: 0,
        boot_scan: false,
        transcoder_url: None,
        opensubtitles_api_key: None,
        whisper_bin: None,
        whisper_model: None,
        subtitles_dir: std::path::PathBuf::from("./data/subtitles"),
        artwork_dir: std::path::PathBuf::from("./data/artwork"),
    });
    let tmdb = crate::tmdb::TmdbClient::new(None);
    AppState {
        db,
        config,
        tmdb,
        scanning: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        stream_semaphore: Arc::new(tokio::sync::Semaphore::new(
            crate::DEFAULT_STREAM_CONCURRENCY,
        )),
    }
}

/// Mint a Bearer internal-principal token for `role`, signed the same way
/// the Hono proxy does (HKDF-derived key from the shared secret), so the
/// `principal_layer` accepts it and inserts the claims into request
/// extensions for the admin gate to inspect.
pub(super) fn signed_principal(secret: &str, role: &str) -> String {
    signed_principal_for(secret, role, "plex:caller")
}

/// Bearer request carrying an internal principal.
pub(super) fn bearer_req(method: &str, uri: impl AsRef<str>, token: &str) -> HttpRequest<Body> {
    HttpRequest::builder()
        .method(method)
        .uri(uri.as_ref())
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

/// Like [`signed_principal`] but for an explicit `sub`, so owner-scoping tests
/// can act as two different members.
pub(super) fn signed_principal_for(secret: &str, role: &str, sub: &str) -> String {
    use emerald_contracts::derive_key;
    use emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL;
    use emerald_contracts::internal_principal::{
        DEFAULT_KID, DEFAULT_TTL_SECS, InternalClaims, encrypt,
    };
    let now = chrono::Utc::now().timestamp();
    let claims = InternalClaims {
        iss: "eex".into(),
        sub: sub.into(),
        role: role.into(),
        auth_mode: "plex".into(),
        server_id: "srv-test".into(),
        device_id: None,
        req_id: "scan-test".into(),
        iat: now,
        exp: now + DEFAULT_TTL_SECS,
    };
    let key = derive_key(secret.as_bytes(), INFO_INTERNAL_PRINCIPAL);
    encrypt(&key, DEFAULT_KID, &claims)
}

pub(super) async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

pub(super) async fn seed_media_file(state: &AppState, path: &str) -> i64 {
    sqlx::query(
        "INSERT INTO media_files \
         (path, size_bytes, mtime, container, duration_secs, video_codec, video_height, \
         video_profile, hdr_format, audio_tracks_json, subtitle_tracks_json, scanned_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(path)
    .bind(1_000_i64)
    .bind("2026-01-01T00:00:00Z")
    .bind("mp4")
    .bind(3600_i64)
    .bind("h264")
    .bind(1080_i64)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind("[]")
    .bind("[]")
    .bind("2026-01-01T00:00:00Z")
    .execute(&state.db.pool)
    .await
    .unwrap()
    .last_insert_rowid()
}

/// GET/DELETE/etc. with an empty body.
pub(super) fn req(method: &str, uri: impl AsRef<str>) -> HttpRequest<Body> {
    HttpRequest::builder()
        .method(method)
        .uri(uri.as_ref())
        .body(Body::empty())
        .unwrap()
}

/// Method + JSON body (sets content-type: application/json).
pub(super) fn json_req(
    method: &str,
    uri: impl AsRef<str>,
    body: impl Into<String>,
) -> HttpRequest<Body> {
    HttpRequest::builder()
        .method(method)
        .uri(uri.as_ref())
        .header("content-type", "application/json")
        .body(Body::from(body.into()))
        .unwrap()
}

/// Seed one artist → album → track backed by a fresh media_files row.
/// Returns `(artist_id, album_id, track_id)`.
pub(super) async fn seed_track(
    state: &AppState,
    artist: &str,
    album: &str,
    title: &str,
    track_no: i64,
    path: &str,
) -> (i64, i64, i64) {
    let file_id = seed_media_file(state, path).await;
    // ON CONFLICT DO NOTHING makes last_insert_rowid unreliable (a skipped
    // insert leaves it pointing at the prior row), so always resolve by key.
    sqlx::query("INSERT INTO artists (name) VALUES (?) ON CONFLICT(name) DO NOTHING")
        .bind(artist)
        .execute(&state.db.pool)
        .await
        .unwrap();
    let artist_id: i64 = sqlx::query_scalar("SELECT id FROM artists WHERE name = ?")
        .bind(artist)
        .fetch_one(&state.db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO albums (artist_id, title, year) VALUES (?, ?, 2020) \
         ON CONFLICT(artist_id, title) DO NOTHING",
    )
    .bind(artist_id)
    .bind(album)
    .execute(&state.db.pool)
    .await
    .unwrap();
    let album_id: i64 =
        sqlx::query_scalar("SELECT id FROM albums WHERE artist_id = ? AND title = ?")
            .bind(artist_id)
            .bind(album)
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
    let track_id: i64 = sqlx::query(
        "INSERT INTO tracks (album_id, media_file_id, title, track_no, duration_secs) \
         VALUES (?, ?, ?, ?, 200)",
    )
    .bind(album_id)
    .bind(file_id)
    .bind(title)
    .bind(track_no)
    .execute(&state.db.pool)
    .await
    .unwrap()
    .last_insert_rowid();
    (artist_id, album_id, track_id)
}

pub(super) async fn seed_movie_for_file(state: &AppState, file_id: i64) -> i64 {
    sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
        .bind("Sample")
        .bind(2020_i64)
        .bind("2026-01-01T00:00:00Z")
        .bind(file_id)
        .execute(&state.db.pool)
        .await
        .unwrap();
    sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
        .bind(file_id)
        .fetch_one(&state.db.pool)
        .await
        .unwrap()
}
