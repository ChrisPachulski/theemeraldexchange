//! HTTP surface. `/health` + `/version` are public; everything under
//! `/api/media/*` sits behind the internal-principal layer.

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

/// Process-wide HTTP client for the outbound transcoder handoff. Built once and
/// reused so each transcode-required request does not spin up a fresh connection
/// pool. A short timeout keeps a slow/dead transcoder from holding the request
/// open — on timeout we fall back to the `503 transcoder required` path.
fn transcoder_http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default()
    })
}

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
        .route("/play/{kind}/{id}/grant", post(play_grant))
        .route("/watch", get(get_watch).post(post_watch))
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

/// Liveness + readiness. `ok` is true only when the DB answers AND its applied
/// schema matches the version this binary was built for. A structurally broken
/// or un-/under-migrated DB where `SELECT 1` still succeeds must NOT report
/// healthy (the prior code returned raw `db_ok`, a half-truth — §7-5). The HTTP
/// status mirrors `ok`: 200 when healthy, 503 otherwise, so a compose/orchestrator
/// healthcheck can act on it. `expected_schema` is echoed for diagnosis.
async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db.pool)
        .await
        .is_ok();
    let schema = state.db.schema_version().await.unwrap_or(-1);
    let healthy = db_ok && schema == SCHEMA_VERSION;
    let status = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "ok": healthy,
            "service": "media-core",
            "schema": schema,
            "expected_schema": SCHEMA_VERSION,
        })),
    )
}

async fn version(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "service": "media-core",
        "schema": SCHEMA_VERSION,
        "server_id": state.config.server_id,
        "library_roots": state.config.library_roots.len(),
    }))
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

// ── Library read APIs ───────────────────────────────────────────────────

async fn list_movies(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    // §7-7: case/diacritic-insensitive, index-backed search via FTS5 MATCH —
    // replaces the old leading-wildcard `LIKE '%'||?||'%'` (full table scan +
    // a second full-scan COUNT, and ASCII-case-only with no diacritic folding).
    // The FTS join also yields the count without a second scan.
    let (rows, total) = match q.q.as_deref().and_then(fts_query) {
        Some(expr) => {
            let rows = sqlx::query_as::<_, MovieRow>(
                "SELECT m.id, m.tmdb_id, m.imdb_id, m.title, m.year, m.added_at, m.file_id, \
                 m.overview, m.poster_path \
                 FROM movies m JOIN movies_fts f ON f.rowid = m.id \
                 WHERE movies_fts MATCH ? ORDER BY m.title LIMIT ? OFFSET ?",
            )
            .bind(&expr)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM movies m JOIN movies_fts f ON f.rowid = m.id \
                 WHERE movies_fts MATCH ?",
            )
            .bind(&expr)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, MovieRow>(
                "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id, overview, poster_path \
                 FROM movies ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM movies")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

async fn get_movie(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, MovieRow>(
        "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id, overview, poster_path \
         FROM movies WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

async fn list_shows(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    // §7-7: FTS5 MATCH instead of leading-wildcard LIKE (see list_movies).
    let (rows, total) = match q.q.as_deref().and_then(fts_query) {
        Some(expr) => {
            let rows = sqlx::query_as::<_, ShowRow>(
                "SELECT s.id, s.tmdb_id, s.tvdb_id, s.title, s.year, s.added_at, s.imdb_id, \
                 s.overview, s.poster_path \
                 FROM shows s JOIN shows_fts f ON f.rowid = s.id \
                 WHERE shows_fts MATCH ? ORDER BY s.title LIMIT ? OFFSET ?",
            )
            .bind(&expr)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM shows s JOIN shows_fts f ON f.rowid = s.id \
                 WHERE shows_fts MATCH ?",
            )
            .bind(&expr)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, ShowRow>(
                "SELECT id, tmdb_id, tvdb_id, title, year, added_at, imdb_id, overview, poster_path \
                 FROM shows ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shows")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

async fn get_show(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, ShowRow>(
        "SELECT id, tmdb_id, tvdb_id, title, year, added_at, imdb_id, overview, poster_path \
         FROM shows WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

async fn list_episodes(
    State(state): State<AppState>,
    Path(show_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, EpisodeRow>(
        "SELECT id, show_id, season, episode, title, air_date, file_id \
         FROM episodes WHERE show_id = ? ORDER BY season, episode",
    )
    .bind(show_id)
    .fetch_all(&state.db.pool)
    .await?;
    Ok(Json(json!({ "items": rows })))
}

/// Flat, paginated episodes feed (mirrors `list_movies`): returns
/// `{items, total}` with optional `?q=` title filter and `?limit`/`?offset`.
/// Fixes the empty-body `GET /api/media/episodes` (no collection route).
async fn list_episodes_all(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    // §7-7: FTS5 MATCH instead of leading-wildcard LIKE (see list_movies). The
    // episodes_fts index is on title+overview; ordering stays show/season/episode.
    let (rows, total) = match q.q.as_deref().and_then(fts_query) {
        Some(expr) => {
            let rows = sqlx::query_as::<_, EpisodeRow>(
                "SELECT e.id, e.show_id, e.season, e.episode, e.title, e.air_date, e.file_id \
                 FROM episodes e JOIN episodes_fts f ON f.rowid = e.id \
                 WHERE episodes_fts MATCH ? ORDER BY e.show_id, e.season, e.episode \
                 LIMIT ? OFFSET ?",
            )
            .bind(&expr)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM episodes e JOIN episodes_fts f ON f.rowid = e.id \
                 WHERE episodes_fts MATCH ?",
            )
            .bind(&expr)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, EpisodeRow>(
                "SELECT id, show_id, season, episode, title, air_date, file_id \
                 FROM episodes ORDER BY show_id, season, episode LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM episodes")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

async fn get_episode(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, EpisodeRow>(
        "SELECT id, show_id, season, episode, title, air_date, file_id \
         FROM episodes WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

// ── Playback ────────────────────────────────────────────────────────────

/// Resolve the backing `media_files` row for a `(kind, id)` pair. `movie`
/// and `episode` both carry a `file_id` foreign key into `media_files`.
async fn resolve_media_file(state: &AppState, kind: &str, id: i64) -> AppResult<MediaFileRow> {
    let file_id: i64 = match kind {
        "movie" => sqlx::query_scalar("SELECT file_id FROM movies WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        "episode" => sqlx::query_scalar("SELECT file_id FROM episodes WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        _ => return Err(AppError::BadRequest(format!("unknown media kind: {kind}"))),
    };

    sqlx::query_as::<_, MediaFileRow>(
        "SELECT id, path, size_bytes, mtime, container, duration_secs, video_codec, \
         video_height, video_profile, hdr_format, audio_tracks_json, subtitle_tracks_json, \
         scanned_at FROM media_files WHERE id = ?",
    )
    .bind(file_id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)
}

async fn play_grant(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<ClientCaps>>,
) -> AppResult<Json<Value>> {
    let file = resolve_media_file(&state, &kind, id).await?;
    let caps = body.map(|Json(c)| c).unwrap_or_default();
    let decision = capability::decide(&file, &caps);

    Ok(Json(json!({
        "directPlay": decision.direct_play,
        "transcoderRequired": !decision.direct_play,
        "reason": decision.reason,
        "file": {
            "container": file.container,
            "duration_secs": file.duration_secs,
            "video_codec": file.video_codec,
            "video_height": file.video_height,
            "hdr_format": file.hdr_format,
            "audio_tracks": file.audio_tracks(),
            "subtitle_tracks": file.subtitle_tracks(),
        },
        "streamUrl": format!("/api/media/stream/{kind}/{id}"),
    })))
}

/// Defense-in-depth: a streamed path must resolve inside one of the configured
/// library roots. The path is DB-sourced (not raw user input), but a buggy or
/// poisoned scan could persist a path containing `..` or a symlink escaping the
/// library; we must never serve such a file. Canonicalizes both sides so `..`
/// and symlinks are resolved before the prefix check. With no roots configured
/// (dev/tests), containment is skipped. Uses `tokio::fs` so the canonicalize
/// syscalls (blocking FS I/O, possibly against a stalled mount) run off the
/// async runtime instead of pinning a request worker.
async fn path_within_roots(path: &std::path::Path, roots: &[crate::config::LibraryRoot]) -> bool {
    if roots.is_empty() {
        return true;
    }
    let Ok(canon) = tokio::fs::canonicalize(path).await else {
        return false;
    };
    for r in roots {
        if let Ok(root) = tokio::fs::canonicalize(&r.path).await
            && canon.starts_with(&root)
        {
            return true;
        }
    }
    false
}

/// Optional client capabilities advertised on the stream request as query
/// params, so a GET can carry the same direct-play contract that `play_grant`
/// computes from a JSON body — including `max_bitrate` (bits/second) and the
/// audio/fmp4 fields. All fields are optional; absent caps mean "no
/// constraints advertised" and the file streams directly (back-compat).
/// Absent `audio_codecs`/`aac_max_channels` fall back to the browser-safe
/// defaults `ClientCaps` carries (AAC-only, ≤2ch).
#[derive(Debug, Deserialize, Default)]
struct StreamCapsQuery {
    containers: Option<String>,
    video_codecs: Option<String>,
    max_height: Option<i64>,
    max_bitrate: Option<i64>,
    #[serde(default)]
    hdr: bool,
    audio_codecs: Option<String>,
    aac_max_channels: Option<i64>,
    #[serde(default)]
    hls_fmp4_hevc: bool,
    #[serde(default)]
    start_secs: Option<u64>,
    /// Client explicitly requested buffered (HLS) delivery: bypass the
    /// direct-play decision and hand off to the transcoder, which resolves a
    /// direct-play-eligible file to a lossless copy-remux session.
    #[serde(default)]
    force_transcode: bool,
}

impl StreamCapsQuery {
    /// True when the client advertised any capability constraint at all.
    fn advertised(&self) -> bool {
        self.containers.is_some()
            || self.video_codecs.is_some()
            || self.max_height.is_some()
            || self.max_bitrate.is_some()
            || self.hdr
            || self.audio_codecs.is_some()
            || self.aac_max_channels.is_some()
            || self.hls_fmp4_hevc
            || self.force_transcode
    }

    fn to_caps(&self) -> ClientCaps {
        let split = |s: &Option<String>| {
            s.as_deref()
                .map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let defaults = ClientCaps::default();
        ClientCaps {
            containers: split(&self.containers),
            video_codecs: split(&self.video_codecs),
            max_height: self.max_height,
            hdr: self.hdr,
            max_bitrate: self.max_bitrate,
            audio_codecs: match split(&self.audio_codecs) {
                v if v.is_empty() => defaults.audio_codecs,
                v => v,
            },
            aac_max_channels: self.aac_max_channels.unwrap_or(defaults.aac_max_channels),
            hls_fmp4_hevc: self.hls_fmp4_hevc,
        }
    }
}

/// Mint a fresh internal-principal Bearer for the media-core → transcoder hop.
///
/// We do NOT forward the caller's inbound token: it has a 60s TTL already partly
/// spent, and media-core only holds the *verified claims* (not a reusable raw
/// Bearer). Instead we re-mint from the verified claims using the same shared
/// `INTERNAL_PRINCIPAL_SECRET` both services hold, with a fresh time window — so
/// the transcoder verifies it identically. Returns `None` when there is no
/// secret or no verified claims (the `Off`-mode dev path, where the transcoder
/// is also `Off` and needs no Bearer).
fn mint_transcoder_principal(state: &AppState, claims: &Option<InternalClaims>) -> Option<String> {
    let secret = state.config.internal_principal_secret.as_ref()?;
    let inbound = claims.as_ref()?;
    let now = chrono::Utc::now().timestamp();
    let fresh = InternalClaims {
        iss: inbound.iss.clone(),
        sub: inbound.sub.clone(),
        role: inbound.role.clone(),
        auth_mode: inbound.auth_mode.clone(),
        server_id: inbound.server_id.clone(),
        device_id: inbound.device_id.clone(),
        req_id: format!("mc-tx-{now}"),
        iat: now,
        exp: now + emerald_contracts::internal_principal::DEFAULT_TTL_SECS,
    };
    Some(emerald_contracts::internal_principal::encrypt_with_secret(
        secret.as_bytes(),
        &fresh,
    ))
}

/// Everything the transcoder handoff needs for one transcode-required request,
/// bundled so the call does not balloon into a positional-argument soup.
struct TranscodeHandoff<'a> {
    file: &'a MediaFileRow,
    caps: &'a ClientCaps,
    kind: &'a str,
    id: i64,
    claims: &'a Option<InternalClaims>,
    start_secs: u64,
    /// The capability decision reason, echoed back in the grant for the client.
    reason: &'a str,
    /// Forward the client's explicit buffered-delivery request so the
    /// transcoder skips its own DirectPlay short-circuit.
    force_transcode: bool,
}

impl TranscodeHandoff<'_> {
    /// Build the transcoder `POST /api/transcode/grant` body. The transcoder's
    /// `GrantRequest`/`GrantFile`/`ClientCaps` deserialize from these exact
    /// field names (verified against transcoder/src/routes.rs), so we serialize
    /// by hand — `ClientCaps`/`MediaFileRow` are not symmetrically
    /// `Serialize`/`Deserialize` on this side, but the JSON contract is fixed.
    fn grant_body(&self) -> Value {
        let sub = self
            .claims
            .as_ref()
            .map(|c| c.sub.as_str())
            .unwrap_or_default();
        json!({
            "file": {
                "path": self.file.path,
                "container": self.file.container,
                // size powers the transcoder's source-relative bitrate cap
                // (avg bps = size_bytes * 8 / duration_secs).
                "size_bytes": self.file.size_bytes,
                "duration_secs": self.file.duration_secs,
                "video_codec": self.file.video_codec,
                "video_height": self.file.video_height,
                "video_profile": self.file.video_profile,
                "hdr_format": self.file.hdr_format,
                "audio_tracks_json": self.file.audio_tracks_json,
                "subtitle_tracks_json": self.file.subtitle_tracks_json,
            },
            "caps": {
                "containers": self.caps.containers,
                "video_codecs": self.caps.video_codecs,
                "max_height": self.caps.max_height,
                "hdr": self.caps.hdr,
                "max_bitrate": self.caps.max_bitrate,
                "audio_codecs": self.caps.audio_codecs,
                "aac_max_channels": self.caps.aac_max_channels,
                "hls_fmp4_hevc": self.caps.hls_fmp4_hevc,
            },
            "media_kind": self.kind,
            "media_id": self.id,
            "sub": sub,
            "start_secs": self.start_secs,
            "force_transcode": self.force_transcode,
        })
    }
}

/// Hand a transcode-required file off to the M4 transcoder and translate its
/// response into the media-core handoff contract. Returns the JSON grant the
/// client (via the Hono proxy) consumes to start HLS playback.
///
/// Failure handling treats an unreachable/slow/erroring transcoder as "offline"
/// → `AppError::TranscoderRequired` (503), identical to the no-URL path, so a
/// transcoder outage degrades to the exact pre-M4 behavior rather than a 500.
async fn handoff_to_transcoder(
    state: &AppState,
    transcoder_url: &str,
    handoff: &TranscodeHandoff<'_>,
) -> Result<axum::response::Response, AppError> {
    let claims = handoff.claims;
    let reason = handoff.reason;
    let body = handoff.grant_body();
    let url = format!(
        "{}/api/transcode/grant",
        transcoder_url.trim_end_matches('/')
    );

    let mut request = transcoder_http().post(&url).json(&body);
    if let Some(bearer) = mint_transcoder_principal(state, claims) {
        request = request.bearer_auth(bearer);
    }

    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            // Unreachable/timeout → behave as if no transcoder is configured.
            tracing::warn!(error = %e, url = %url, "transcoder unreachable; treating as offline");
            return Err(AppError::TranscoderRequired);
        }
    };

    let status = resp.status();
    let payload: Value = resp.json().await.unwrap_or_else(|_| json!({}));

    if status.is_success() {
        // The transcoder echoes directPlay:true only if it somehow disagreed
        // with our decision; we only call it on !direct_play, so on that edge
        // fall back to the 503 path rather than shipping a contradictory grant.
        if payload.get("directPlay").and_then(Value::as_bool) == Some(true) {
            tracing::warn!("transcoder returned directPlay on a transcode-required file; refusing");
            return Err(AppError::TranscoderRequired);
        }
        let session_id = payload.get("sessionId").and_then(Value::as_str);
        let manifest_url = payload
            .get("manifestUrl")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| session_id.map(|s| format!("/api/transcode/session/{s}/index.m3u8")));
        let heartbeat_url = payload
            .get("heartbeatUrl")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| session_id.map(|s| format!("/api/transcode/session/{s}/heartbeat")));
        // Forward the transcoder's sidecar-subtitle descriptor verbatim
        // ({ url, language, forced } | null). Its `url` is a transcoder-relative
        // asset path; the Node grant layer stream-token-wraps it like the
        // manifest before the player loads it as a <track>.
        let subtitle = payload.get("subtitle").cloned().unwrap_or(Value::Null);

        return Ok(Json(json!({
            "transcode": true,
            "directPlay": false,
            "sessionId": session_id,
            "manifestUrl": manifest_url,
            "heartbeatUrl": heartbeat_url,
            "subtitle": subtitle,
            "reason": reason,
        }))
        .into_response());
    }

    // Surface a genuine "all transcode slots busy" as a 503 the client can
    // back off on; any other transcoder error also degrades to 503 offline.
    if payload.get("error").and_then(Value::as_str) == Some("transcoder_busy") {
        tracing::info!("transcoder busy at capacity");
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "transcoder_busy" })),
        )
            .into_response());
    }

    tracing::warn!(status = %status, ?payload, "transcoder grant failed; treating as offline");
    Err(AppError::TranscoderRequired)
}

async fn stream_file(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    Query(caps_q): Query<StreamCapsQuery>,
    claims: Option<Extension<InternalClaims>>,
    req: Request,
) -> Result<axum::response::Response, AppError> {
    let file = resolve_media_file(&state, &kind, id).await?;

    // Containment: never serve a file outside the configured library roots.
    if !path_within_roots(
        std::path::Path::new(&file.path),
        &state.config.library_roots,
    )
    .await
    {
        tracing::warn!(path = %file.path, "refusing to stream file outside library roots");
        return Err(AppError::NotFound);
    }

    // Honor the direct-play contract (§3.5): if the client advertised caps and
    // the file can't direct-play, hand off to the M4 transcoder when one is
    // configured (MEDIA_TRANSCODER_URL). Without a transcoder this is the
    // M3-only posture, so return 503 rather than shipping undecodable bytes.
    if caps_q.advertised() {
        let caps = caps_q.to_caps();
        let decision = capability::decide(&file, &caps);
        // `force_transcode` bypasses the decision: decide() WILL say
        // direct_play for these files, but the client has asked for buffered
        // (HLS) delivery, so the handoff must be explicit.
        if caps_q.force_transcode || !decision.direct_play {
            let reason = if caps_q.force_transcode {
                "client requested buffered delivery".to_string()
            } else {
                decision.reason
            };
            let claims = claims.map(|Extension(c)| c);
            match state.config.transcoder_url.as_deref() {
                Some(transcoder_url) => {
                    tracing::info!(path = %file.path, reason = %reason, "transcode required; handing off to transcoder");
                    let handoff = TranscodeHandoff {
                        file: &file,
                        caps: &caps,
                        kind: &kind,
                        id,
                        claims: &claims,
                        start_secs: caps_q.start_secs.unwrap_or(0),
                        reason: &reason,
                        force_transcode: caps_q.force_transcode,
                    };
                    return handoff_to_transcoder(&state, transcoder_url, &handoff).await;
                }
                None => {
                    tracing::info!(path = %file.path, reason = %reason, "transcode required; no transcoder configured, returning 503");
                    return Err(AppError::TranscoderRequired);
                }
            }
        }
    }

    // §7-2: bound concurrent direct-play streams. We do NOT put a total-request
    // timeout on this path (it would truncate legitimate multi-hour playback);
    // instead we cap how many serves are in flight. Acquire an owned permit just
    // before serving so the transcoder-handoff and error paths above never
    // consume a slot. When the pool is exhausted, return 503 so a burst of
    // stalled reads against a degraded volume cannot exhaust tokio tasks.
    let permit = state
        .stream_semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::StreamSlotsExhausted)?;

    let service = ServeFile::new(&file.path);
    let mut resp = service
        .oneshot(req)
        .await
        .map_err(|e| AppError::Internal(format!("stream serve failed: {e}")))?
        .into_response();
    // cloudflared buffers tunnel responses by default, which turns each range
    // request of a progressive direct-play into edge-accumulate-then-burst.
    // `X-Accel-Buffering: no` is honored on the tunnel path (proven by the
    // live IPTV .ts proxy) and keeps the bytes streaming client-ward.
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("x-accel-buffering"),
        axum::http::HeaderValue::from_static("no"),
    );
    // Hold the permit for the lifetime of the response (and its streaming body):
    // it drops when the response is dropped after the client finishes or
    // disconnects, freeing the slot.
    resp.extensions_mut()
        .insert(StreamPermit(std::sync::Arc::new(permit)));
    Ok(resp)
}

/// Newtype so the owned stream-concurrency permit can ride in the response
/// extensions (which require `Clone`); it is only ever inserted, never cloned,
/// and exists solely to keep the permit alive until the body is fully sent.
#[derive(Clone)]
struct StreamPermit(
    // Held purely for its `Drop` — keeps the concurrency slot reserved until the
    // response body is fully sent. Never read by design, so silence dead_code.
    #[allow(dead_code)] std::sync::Arc<tokio::sync::OwnedSemaphorePermit>,
);

// ── Watch state ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WatchQuery {
    pub sub: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WatchUpsert {
    pub media_kind: String,
    pub media_id: i64,
    pub position_secs: i64,
    #[serde(default)]
    pub duration_secs: Option<i64>,
    #[serde(default)]
    pub completed: bool,
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

async fn get_watch(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    let rows = sqlx::query_as::<_, WatchStateRow>(
        "SELECT sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed \
         FROM media_watch_state WHERE sub = ? ORDER BY watched_at DESC",
    )
    .bind(&sub)
    .fetch_all(&state.db.pool)
    .await?;

    // Enrich each row with display metadata (title / poster / season / episode)
    // so the client's "continue watching" shelf renders a real title and poster
    // without a second round-trip or a local library join — the Home tab has
    // neither the show nor episode catalogs loaded, so an un-enriched episode row
    // could only show a generic "Episode" with no art. Extra fields are additive;
    // existing consumers ignore them.
    let movie_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.media_kind == "movie")
        .map(|r| r.media_id)
        .collect();
    let episode_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.media_kind == "episode")
        .map(|r| r.media_id)
        .collect();
    let movie_meta = fetch_movie_meta(&state, &movie_ids).await?;
    let episode_meta = fetch_episode_meta(&state, &episode_ids).await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut v = json!({
                "sub": r.sub,
                "media_kind": r.media_kind,
                "media_id": r.media_id,
                "position_secs": r.position_secs,
                "duration_secs": r.duration_secs,
                "watched_at": r.watched_at,
                "completed": r.completed,
            });
            let obj = v.as_object_mut().expect("json object");
            match r.media_kind.as_str() {
                "movie" => {
                    if let Some((title, poster)) = movie_meta.get(&r.media_id) {
                        obj.insert("title".into(), json!(title));
                        obj.insert("poster_path".into(), json!(poster));
                    }
                }
                "episode" => {
                    if let Some(e) = episode_meta.get(&r.media_id) {
                        obj.insert("title".into(), json!(e.episode_title));
                        obj.insert("show_title".into(), json!(e.show_title));
                        obj.insert("poster_path".into(), json!(e.poster_path));
                        obj.insert("season".into(), json!(e.season));
                        obj.insert("episode".into(), json!(e.episode));
                    }
                }
                _ => {}
            }
            v
        })
        .collect();

    Ok(Json(json!({ "items": items })))
}

/// Show + episode display metadata for one watched episode (Bug: Home "continue
/// watching" rows showed a bare "Episode" with no art because the client had no
/// episode→show catalog to join against).
struct EpisodeMeta {
    episode_title: Option<String>,
    show_title: String,
    poster_path: Option<String>,
    season: i64,
    episode: i64,
}

/// Batch-resolve `movies.id → (title, poster_path)` for the watch shelf.
async fn fetch_movie_meta(
    state: &AppState,
    ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, (String, Option<String>)>> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT id, title, poster_path FROM movies WHERE id IN ({placeholders})");
    let mut query = sqlx::query_as::<_, (i64, String, Option<String>)>(sqlx::AssertSqlSafe(sql));
    for id in ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(&state.db.pool).await?;
    Ok(rows
        .into_iter()
        .map(|(id, title, poster)| (id, (title, poster)))
        .collect())
}

/// Batch-resolve `episodes.id → EpisodeMeta` (joined to the parent show for its
/// title + poster) for the watch shelf.
async fn fetch_episode_meta(
    state: &AppState,
    ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, EpisodeMeta>> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT e.id, e.title, s.title, s.poster_path, e.season, e.episode \
         FROM episodes e JOIN shows s ON e.show_id = s.id WHERE e.id IN ({placeholders})"
    );
    let mut query = sqlx::query_as::<_, (i64, Option<String>, String, Option<String>, i64, i64)>(
        sqlx::AssertSqlSafe(sql),
    );
    for id in ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(&state.db.pool).await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, episode_title, show_title, poster_path, season, episode)| {
                (
                    id,
                    EpisodeMeta {
                        episode_title,
                        show_title,
                        poster_path,
                        season,
                        episode,
                    },
                )
            },
        )
        .collect())
}

/// True iff `(media_kind, media_id)` names a row that currently exists. Used to
/// keep watch-state from referencing titles that never existed or were deleted.
/// The relationship is polymorphic (media_kind ∈ {movie, episode}), so a SQL
/// foreign key cannot enforce it (§7-8); this is the in-handler equivalent.
/// `Ok(None)` distinguishes an unknown `media_kind` (→ 400) from a known kind
/// whose id is absent (`Ok(Some(false))` → 404).
async fn media_exists(
    state: &AppState,
    media_kind: &str,
    media_id: i64,
) -> AppResult<Option<bool>> {
    let table = match media_kind {
        "movie" => "movies",
        "episode" => "episodes",
        _ => return Ok(None),
    };
    // `table` is from the fixed allow-list above (never user input), so the
    // format! is injection-safe; `media_id` is still bound as a parameter.
    // sqlx 0.9 requires an explicit safety assertion for non-'static SQL.
    let sql = format!("SELECT 1 FROM {table} WHERE id = ? LIMIT 1");
    let found: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(media_id)
        .fetch_optional(&state.db.pool)
        .await?;
    Ok(Some(found.is_some()))
}

async fn post_watch(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<WatchUpsert>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;

    // §7-8: validate (media_kind, media_id) against a real title before writing.
    // Without this an arbitrary/stale id silently creates an orphan or forgeable
    // watch row (no SQL FK can guard a polymorphic id). Unknown kind → 400;
    // known kind but absent id → 404. (The schema CHECK already constrains the
    // stored kind, but rejecting early gives the client a clear, non-500 error.)
    match media_exists(&state, &body.media_kind, body.media_id).await? {
        Some(true) => {}
        Some(false) => return Err(AppError::NotFound),
        None => {
            return Err(AppError::BadRequest(
                "media_kind must be 'movie' or 'episode'".into(),
            ));
        }
    }

    let watched_at = chrono::Utc::now().to_rfc3339();
    let completed = i64::from(body.completed);

    sqlx::query(
        "INSERT INTO media_watch_state \
         (sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(sub, media_kind, media_id) DO UPDATE SET \
         position_secs = excluded.position_secs, \
         duration_secs = excluded.duration_secs, \
         watched_at = excluded.watched_at, \
         completed = excluded.completed",
    )
    .bind(&sub)
    .bind(&body.media_kind)
    .bind(body.media_id)
    .bind(body.position_secs)
    .bind(body.duration_secs)
    .bind(&watched_at)
    .bind(completed)
    .execute(&state.db.pool)
    .await?;

    Ok(Json(json!({ "ok": true, "watched_at": watched_at })))
}

// ── Scan trigger ────────────────────────────────────────────────────────

/// Upsert one `scan_state` (key, value, ts) row. Best-effort: logs on failure
/// so the background task never panics on a transient DB error.
async fn set_scan_state(db: &crate::db::Db, key: &str, value: &str) {
    let ts = chrono::Utc::now().to_rfc3339();
    if let Err(e) = sqlx::query(
        "INSERT INTO scan_state (key, value, ts) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
    )
    .bind(key)
    .bind(value)
    .bind(&ts)
    .execute(&db.pool)
    .await
    {
        tracing::warn!("failed to persist scan_state {key}: {e}");
    }
}

async fn get_scan_state(db: &crate::db::Db, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM scan_state WHERE key = ?")
        .bind(key)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten()
}

/// Authorize a scan trigger. A full library rescan is an expensive, DoS-prone
/// operation, so outside `Off` mode (local/dev, no auth boundary) it is gated to
/// admins: the caller must present a verified internal principal whose
/// `role == "admin"`. This mirrors the Hono proxy's `requireAdmin` gate over
/// `/scan` (403 `admin role required`). In `Off` mode there is no principal and
/// no boundary, so the gate is skipped. Returns the rejection response on deny.
fn authorize_scan(
    claims: &Option<InternalClaims>,
    mode: &PrincipalMode,
) -> Result<(), (StatusCode, Json<Value>)> {
    if *mode == PrincipalMode::Off {
        return Ok(());
    }
    let is_admin = claims.as_ref().map(|c| c.role == "admin").unwrap_or(false);
    if is_admin {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "admin role required" })),
        ))
    }
}

/// Kick off a background scan and return `202` immediately. A second request
/// while a scan is in flight returns `409`. Progress + the final report land
/// in the `scan_state` table, readable via `GET /scan/status`.
///
/// Authorization: outside `Off` mode the caller must be a verified admin
/// principal (see [`authorize_scan`]); a non-admin gets `403`.
async fn trigger_scan(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
) -> AppResult<impl IntoResponse> {
    use std::sync::atomic::Ordering;

    let claims = claims.map(|Extension(c)| c);
    if let Err(rejection) = authorize_scan(&claims, &state.config.principal_mode) {
        return Ok(rejection);
    }

    // Atomically claim the scan slot; bail with 409 if already running.
    if state
        .scanning
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok((
            StatusCode::CONFLICT,
            Json(
                json!({ "status": "running", "job_id": get_scan_state(&state.db, "job_id").await }),
            ),
        ));
    }

    let job_id = chrono::Utc::now().timestamp_millis().to_string();
    let started_at = chrono::Utc::now().to_rfc3339();

    // CANCELLATION SAFETY: spawn the background task IMMEDIATELY after the
    // compare_exchange claim, with no intervening await. The bookkeeping
    // writes below run inside the spawned task: if they ran here and the
    // handler future was dropped mid-await (client disconnect, TimeoutLayer),
    // the spawn would never happen and `scanning` would stay true, 409-ing
    // every future POST /scan forever.
    let bg = state.clone();
    let bg_job_id = job_id.clone();
    tokio::spawn(async move {
        set_scan_state(&bg.db, "state", "running").await;
        set_scan_state(&bg.db, "job_id", &bg_job_id).await;
        set_scan_state(&bg.db, "started_at", &started_at).await;
        set_scan_state(&bg.db, "finished_at", "").await;

        // scan_once_isolated contains a panic in the scan pass as an Err, so
        // the state/flag resets below always run — otherwise one bad file
        // would leave `scanning` true and 409 every future POST /scan.
        let result = scanner::scan_once_isolated(
            bg.db.clone(),
            bg.config.library_roots.clone(),
            bg.tmdb.clone(),
        )
        .await;
        match result {
            Ok(report) => {
                let json = serde_json::to_string(&report).unwrap_or_else(|_| "{}".into());
                set_scan_state(&bg.db, "last_report", &json).await;
            }
            Err(e) => {
                tracing::warn!("background scan failed: {e}");
                set_scan_state(
                    &bg.db,
                    "last_report",
                    &json!({ "error": e.to_string() }).to_string(),
                )
                .await;
            }
        }
        set_scan_state(&bg.db, "finished_at", &chrono::Utc::now().to_rfc3339()).await;
        set_scan_state(&bg.db, "state", "idle").await;
        bg.scanning.store(false, Ordering::SeqCst);
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "status": "started", "job_id": job_id })),
    ))
}

/// Report the current/last scan status from the `scan_state` table.
async fn scan_status(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let st = get_scan_state(&state.db, "state").await.unwrap_or_default();
    let state_str = if st.is_empty() {
        "idle".to_string()
    } else {
        st
    };
    let last_report = get_scan_state(&state.db, "last_report")
        .await
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let started_at = get_scan_state(&state.db, "started_at").await;
    let finished_at = get_scan_state(&state.db, "finished_at")
        .await
        .filter(|s| !s.is_empty());
    Ok(Json(json!({
        "state": state_str,
        "last_report": last_report,
        "started_at": started_at,
        "finished_at": finished_at,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn test_state() -> AppState {
        // Off-mode: no principal secret/mode wired → principal_layer skips
        // auth, so handlers fall back to the `?sub=` query param.
        unsafe {
            std::env::remove_var("MEDIA_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("RECOMMENDER_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("INTERNAL_PRINCIPAL_SECRET");
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
    async fn test_state_enforce(secret: &str) -> AppState {
        let db = crate::db::Db::connect_memory().await.unwrap();
        let config = Arc::new(Config {
            host: "127.0.0.1".into(),
            port: 0,
            db_path: ":memory:".into(),
            library_roots: Vec::new(),
            internal_principal_secret: Some(secret.to_string()),
            principal_mode: PrincipalMode::Enforce,
            server_id: "srv-test".into(),
            tmdb_api_key: None,
            scan_interval_secs: 0,
            boot_scan: false,
            transcoder_url: None,
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
    fn signed_principal(secret: &str, role: &str) -> String {
        use emerald_contracts::derive_key;
        use emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL;
        use emerald_contracts::internal_principal::{
            DEFAULT_KID, DEFAULT_TTL_SECS, InternalClaims, encrypt,
        };
        let now = chrono::Utc::now().timestamp();
        let claims = InternalClaims {
            iss: "eex".into(),
            sub: "plex:caller".into(),
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

    async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn seed_media_file(state: &AppState, path: &str) -> i64 {
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

    #[tokio::test]
    async fn list_movies_returns_seeded_movie() {
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/a.mp4").await;
        sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
            .bind("The Matrix")
            .bind(1999_i64)
            .bind("2026-01-01T00:00:00Z")
            .bind(file_id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/movies")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 1);
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        assert_eq!(v["items"][0]["title"], "The Matrix");
    }

    #[tokio::test]
    async fn get_movie_missing_is_404() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/movies/9999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_episodes_is_ordered() {
        let state = test_state().await;
        let show_id: i64 = sqlx::query("INSERT INTO shows (title, added_at) VALUES (?, ?)")
            .bind("Foo")
            .bind("2026-01-01T00:00:00Z")
            .execute(&state.db.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        let f1 = seed_media_file(&state, "/lib/s1e2.mp4").await;
        let f2 = seed_media_file(&state, "/lib/s1e1.mp4").await;
        // Insert out of order; query must return season,episode order.
        sqlx::query(
            "INSERT INTO episodes (show_id, season, episode, title, file_id) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(show_id)
        .bind(1_i64)
        .bind(2_i64)
        .bind("Ep2")
        .bind(f1)
        .execute(&state.db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO episodes (show_id, season, episode, title, file_id) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(show_id)
        .bind(1_i64)
        .bind(1_i64)
        .bind("Ep1")
        .bind(f2)
        .execute(&state.db.pool)
        .await
        .unwrap();

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!("/api/media/shows/{show_id}/episodes"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["episode"], 1);
        assert_eq!(items[1]["episode"], 2);
    }

    #[tokio::test]
    async fn watch_state_round_trips() {
        let state = test_state().await;
        // §7-8: watch-state now requires the title to exist, so seed a movie.
        let file_id = seed_media_file(&state, "/lib/watch.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        let app = crate::build_router(state);

        let post = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/watch?sub=plex:1")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "media_kind": "movie",
                            "media_id": movie_id,
                            "position_secs": 120,
                            "duration_secs": 3600,
                            "completed": false
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(post.status(), StatusCode::OK);

        let get = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/watch?sub=plex:1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        let v = body_json(get).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["sub"], "plex:1");
        assert_eq!(items[0]["media_id"], movie_id);
        assert_eq!(items[0]["position_secs"], 120);
    }

    #[tokio::test]
    async fn post_watch_rejects_unknown_media_id() {
        // §7-8: posting watch-state for a nonexistent title must 404, not
        // silently create an orphan row.
        let state = test_state().await;
        let app = crate::build_router(state.clone());
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/watch?sub=plex:1")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "media_kind": "movie",
                            "media_id": 9999,
                            "position_secs": 10,
                            "completed": false
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_watch_state")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "rejected watch must not create a row");
    }

    #[tokio::test]
    async fn post_watch_rejects_unknown_kind() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/watch?sub=plex:1")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "media_kind": "playlist",
                            "media_id": 1,
                            "position_secs": 10,
                            "completed": false
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn gc_removes_orphaned_watch_rows() {
        // §7-8: the GC reaps watch rows whose (kind,id) no longer resolves
        // (title deleted / pre-validation forged rows) and keeps valid ones.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/gc.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        // A valid row (via the validated handler) + a forged orphan (direct).
        let _ = post_watch(
            State(state.clone()),
            None,
            Query(WatchQuery {
                sub: Some("plex:1".into()),
            }),
            Json(WatchUpsert {
                media_kind: "movie".into(),
                media_id: movie_id,
                position_secs: 5,
                duration_secs: None,
                completed: false,
            }),
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO media_watch_state \
             (sub, media_kind, media_id, position_secs, watched_at, completed) \
             VALUES ('plex:1', 'movie', 4242, 0, '0', 0)",
        )
        .execute(&state.db.pool)
        .await
        .unwrap();

        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_watch_state")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(before, 2);

        let removed = crate::scanner::gc_orphan_watch_state(&state.db)
            .await
            .unwrap();
        assert_eq!(removed, 1, "exactly the orphan row is reaped");
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_watch_state")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(after, 1, "the valid watch row survives GC");
    }

    #[tokio::test]
    async fn movie_search_is_case_and_diacritic_insensitive() {
        // §7-7: FTS5 unicode61 + remove_diacritics=2 folds case and diacritics,
        // which the old ASCII-only leading-wildcard LIKE could not do.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/amelie.mkv").await;
        sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
            .bind("Amélie")
            .bind(2001_i64)
            .bind("2026-01-01T00:00:00Z")
            .bind(file_id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        async fn search(state: &AppState, term: &str) -> i64 {
            let v = list_movies(
                State(state.clone()),
                Query(ListQuery {
                    q: Some(term.to_string()),
                    limit: None,
                    offset: None,
                }),
            )
            .await
            .unwrap();
            v.0["total"].as_i64().unwrap()
        }

        assert_eq!(search(&state, "amelie").await, 1, "diacritic-folded match");
        assert_eq!(search(&state, "AMÉLIE").await, 1, "case-folded match");
        assert_eq!(search(&state, "ame").await, 1, "prefix match");
        assert_eq!(search(&state, "zzz").await, 0, "non-match returns nothing");
    }

    #[tokio::test]
    async fn stream_returns_503_when_concurrency_exhausted() {
        // §7-2: with the stream pool exhausted, a new direct-play request must
        // get 503 rather than spawning another long-lived serve task. Build a
        // state whose semaphore has zero permits available and confirm the 503.
        let mut state = test_state().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.mp4");
        std::fs::write(&path, b"bytes").unwrap();
        let file_id = seed_media_file(&state, path.to_str().unwrap()).await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        // Drain the pool: a 1-permit semaphore with its single permit forgotten.
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        sem.clone().try_acquire_owned().unwrap().forget();
        state.stream_semaphore = sem;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!("/api/media/stream/movie/{movie_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        // The body must carry the DISTINCT capacity code, not the misleading
        // "transcoder required (M4 offline)" outage message — ops/clients need
        // to tell "retry shortly, at capacity" from "transcoder is down".
        let v = body_json(resp).await;
        assert_eq!(v["error"], "stream_slots_exhausted");
    }

    async fn seed_show_with_episodes(state: &AppState, n: i64) {
        let show_id: i64 =
            sqlx::query("INSERT INTO shows (title, norm_title, added_at) VALUES (?, ?, ?)")
                .bind("Bar")
                .bind("bar")
                .bind("2026-01-01T00:00:00Z")
                .execute(&state.db.pool)
                .await
                .unwrap()
                .last_insert_rowid();
        for i in 1..=n {
            let f = seed_media_file(state, &format!("/lib/bar_s1e{i}.mp4")).await;
            sqlx::query(
                "INSERT INTO episodes (show_id, season, episode, title, file_id) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(show_id)
            .bind(1_i64)
            .bind(i)
            .bind(format!("Ep{i}"))
            .bind(f)
            .execute(&state.db.pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn list_episodes_all_returns_items_and_total() {
        let state = test_state().await;
        seed_show_with_episodes(&state, 3).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/episodes")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 3);
        assert_eq!(v["items"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn list_episodes_all_honors_limit() {
        let state = test_state().await;
        seed_show_with_episodes(&state, 3).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/media/episodes?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 3);
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
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

    /// Cross-platform continue-watching contract (M3 crit 4/5): resume position
    /// is scoped to the ACCOUNT (`sub`), never the device. Two device tokens for
    /// the same account — e.g. the web SPA and the native tvOS client — both
    /// resolve to the same `sub`, so progress written from one device is the
    /// resume point on the other; a different account sees none of it. This is
    /// the backend half of the sync the Apple client (sibling repo, native
    /// continue-watching) consumes over `/api/media/watch`.
    #[tokio::test]
    async fn resume_state_is_account_scoped_across_devices() {
        use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims};

        let now = 1_748_000_000;
        let device = |sub: &str, device_id: &str| {
            Some(InternalClaims {
                iss: "eex".into(),
                sub: sub.into(),
                role: "user".into(),
                auth_mode: "plex".into(),
                server_id: "srv".into(),
                device_id: Some(device_id.into()),
                req_id: "r1".into(),
                iat: now,
                exp: now + DEFAULT_TTL_SECS,
            })
        };

        // (1) Auth layer: the SAME account on two DIFFERENT devices resolves to
        // one identity; a different account is isolated. Device id is irrelevant
        // to the resume key by construction.
        let web = device("plex:42", "web-session-A");
        let tv = device("plex:42", "appletv-B");
        let other = device("plex:99", "web-session-C");
        assert_eq!(
            acting_sub(&web, None, &PrincipalMode::Enforce).unwrap(),
            acting_sub(&tv, None, &PrincipalMode::Enforce).unwrap(),
            "same account, different device → same resume identity"
        );
        assert_eq!(
            acting_sub(&tv, None, &PrincipalMode::Enforce).unwrap(),
            "plex:42"
        );
        assert_ne!(
            acting_sub(&other, None, &PrincipalMode::Enforce).unwrap(),
            "plex:42",
            "a different account must not share the resume identity"
        );

        // (2) Store layer: write progress as the resolved sub (web), read it back
        // as the same sub (tvOS) → same position. A different account reads none.
        // This is exactly the SQL the get/post_watch handlers run, keyed only on
        // `sub` — there is no device column in media_watch_state.
        let state = test_state().await;
        let watched_at = "2026-06-17T00:00:00Z";
        sqlx::query(
            "INSERT INTO media_watch_state \
             (sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed) \
             VALUES (?, 'movie', 7, 1800, 5400, ?, 0)",
        )
        .bind("plex:42")
        .bind(watched_at)
        .execute(&state.db.pool)
        .await
        .unwrap();

        let resume_on_tv: Option<i64> = sqlx::query_scalar(
            "SELECT position_secs FROM media_watch_state WHERE sub = ? AND media_id = 7",
        )
        .bind("plex:42")
        .fetch_optional(&state.db.pool)
        .await
        .unwrap();
        assert_eq!(
            resume_on_tv,
            Some(1800),
            "progress written by web is the resume point on tvOS (same account)"
        );

        let leak: Option<i64> = sqlx::query_scalar(
            "SELECT position_secs FROM media_watch_state WHERE sub = ? AND media_id = 7",
        )
        .bind("plex:99")
        .fetch_optional(&state.db.pool)
        .await
        .unwrap();
        assert_eq!(leak, None, "a different account sees no resume state");
    }

    #[tokio::test]
    async fn stream_refuses_when_client_caps_require_transcode() {
        // A file the advertised client cannot direct-play must 503, not stream.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/hevc.mkv").await;
        // seed_media_file stores container=mp4, codec=h264, height=1080; ask
        // for an mp4/av1 client so codec mismatch forces transcode.
        sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
            .bind("Needs Transcode")
            .bind(2020_i64)
            .bind("2026-01-01T00:00:00Z")
            .bind(file_id)
            .execute(&state.db.pool)
            .await
            .unwrap();
        let movie_id: i64 = sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&state.db.pool)
            .await
            .unwrap();

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn stream_refuses_when_bitrate_exceeds_client_max() {
        // The GET stream path must honor ?max_bitrate just like the JSON grant
        // body — previously the param could not be expressed and the cap was
        // silently ignored. 9GB/3600s ≈ 20 Mbps > a 10 Mbps client cap → 503.
        let state = test_state().await;
        sqlx::query(
            "INSERT INTO media_files \
             (path, size_bytes, mtime, container, duration_secs, video_codec, video_height, \
             video_profile, hdr_format, audio_tracks_json, subtitle_tracks_json, scanned_at) \
             VALUES (?, 9000000000, 't', 'mp4', 3600, 'h264', 1080, NULL, NULL, '[]', '[]', 't')",
        )
        .bind("/lib/huge.mp4")
        .execute(&state.db.pool)
        .await
        .unwrap();
        let file_id: i64 = sqlx::query_scalar("SELECT id FROM media_files WHERE path = ?")
            .bind("/lib/huge.mp4")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_bitrate=10000000"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// Off-mode in-memory state with a transcoder URL wired in, so the
    /// transcode-required path hands off instead of returning 503. Roots are
    /// empty (containment skipped) so a seeded path need not exist on disk for
    /// the handoff path (which never opens the file — only the transcoder does).
    async fn test_state_with_transcoder(url: &str) -> AppState {
        unsafe {
            std::env::remove_var("MEDIA_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("RECOMMENDER_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("INTERNAL_PRINCIPAL_SECRET");
        }
        let db = crate::db::Db::connect_memory().await.unwrap();
        let mut config = Config::from_env().unwrap();
        config.transcoder_url = Some(url.to_string());
        AppState {
            db,
            config: Arc::new(config),
            tmdb: crate::tmdb::TmdbClient::new(None),
            scanning: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            stream_semaphore: Arc::new(tokio::sync::Semaphore::new(
                crate::DEFAULT_STREAM_CONCURRENCY,
            )),
        }
    }

    /// Spawn a tiny one-route axum server standing in for the M4 transcoder's
    /// `POST /api/transcode/grant`. Returns `(base_url, JoinHandle)`. The mock
    /// echoes a successful grant so media-core's handoff translation can be
    /// asserted end-to-end without the real transcoder crate.
    async fn spawn_mock_transcoder(
        response: Value,
        status: StatusCode,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/api/transcode/grant",
            post(move || {
                let response = response.clone();
                async move { (status, Json(response)) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    async fn spawn_mock_transcoder_capture(
        response: Value,
        status: StatusCode,
        seen_body: Arc<tokio::sync::Mutex<Option<Value>>>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/api/transcode/grant",
            post(move |Json(body): Json<Value>| {
                let response = response.clone();
                let seen_body = seen_body.clone();
                async move {
                    *seen_body.lock().await = Some(body);
                    (status, Json(response))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    async fn seed_movie_for_file(state: &AppState, file_id: i64) -> i64 {
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

    #[tokio::test]
    async fn stream_direct_play_serves_bytes_when_caps_match() {
        // A file the advertised client CAN direct-play must stream the bytes,
        // never touch the transcoder, and not 503 — even with a transcoder
        // configured. Guards against the handoff hijacking the direct path.
        let (base, handle) = spawn_mock_transcoder(json!({}), StatusCode::OK).await;
        let state = test_state_with_transcoder(&base).await;

        // Write a real file so ServeFile can stream it; roots are empty so the
        // containment check is skipped and any on-disk path is allowed.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.mp4");
        std::fs::write(&path, b"fake-mp4-bytes").unwrap();
        let file_id = seed_media_file(&state, path.to_str().unwrap()).await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        // seed_media_file stores container=mp4, codec=h264, height=1080 → caps
        // that match exactly direct-play.
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_height=1080"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"fake-mp4-bytes");
        handle.abort();
    }

    #[tokio::test]
    async fn stream_hands_off_to_transcoder_when_configured() {
        // !direct_play + transcoder configured → media-core POSTs the grant and
        // returns the handoff JSON (manifestUrl) instead of 503.
        let grant = json!({
            "directPlay": false,
            "transcode": true,
            "sessionId": "sess-abc",
            "manifestUrl": "/api/transcode/session/sess-abc/index.m3u8",
            "heartbeatUrl": "/api/transcode/session/sess-abc/heartbeat",
            "subtitle": {
                "url": "/api/transcode/session/sess-abc/subtitles.vtt",
                "language": "eng",
                "forced": false,
            },
        });
        let (base, handle) = spawn_mock_transcoder(grant, StatusCode::OK).await;
        let state = test_state_with_transcoder(&base).await;
        let file_id = seed_media_file(&state, "/lib/needs-transcode.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["transcode"], true);
        assert_eq!(v["directPlay"], false);
        assert_eq!(v["sessionId"], "sess-abc");
        assert_eq!(
            v["manifestUrl"],
            "/api/transcode/session/sess-abc/index.m3u8"
        );
        // The sidecar-subtitle descriptor is forwarded verbatim for the Node
        // grant layer to stream-token-wrap and the player to load as a <track>.
        assert_eq!(
            v["subtitle"]["url"],
            "/api/transcode/session/sess-abc/subtitles.vtt"
        );
        assert_eq!(v["subtitle"]["language"], "eng");
        assert_eq!(v["subtitle"]["forced"], false);
        assert!(
            v["reason"].as_str().is_some(),
            "handoff must carry the decision reason"
        );
        handle.abort();
    }

    #[tokio::test]
    async fn stream_handoff_forwards_resume_start_secs_to_transcoder() {
        let grant = json!({
            "directPlay": false,
            "transcode": true,
            "sessionId": "sess-resume",
            "manifestUrl": "/api/transcode/session/sess-resume/index.m3u8",
            "heartbeatUrl": "/api/transcode/session/sess-resume/heartbeat",
        });
        let seen = Arc::new(tokio::sync::Mutex::new(None));
        let (base, handle) =
            spawn_mock_transcoder_capture(grant, StatusCode::OK, seen.clone()).await;
        let state = test_state_with_transcoder(&base).await;
        let file_id = seed_media_file(&state, "/lib/resume.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1&start_secs=95"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = seen.lock().await.clone().expect("transcoder grant body");
        assert_eq!(body["start_secs"], 95);
        handle.abort();
    }

    #[tokio::test]
    async fn stream_force_transcode_bypasses_direct_play() {
        // The stall-escalation contract: a file the caps WOULD direct-play
        // must, with ?force_transcode=true, hand off to the transcoder (which
        // resolves it to a lossless copy-remux) instead of serving bytes —
        // and the grant body must carry force_transcode so the transcoder
        // skips its own DirectPlay short-circuit.
        let grant = json!({
            "directPlay": false,
            "transcode": true,
            "sessionId": "sess-forced",
            "manifestUrl": "/api/transcode/session/sess-forced/index.m3u8",
            "heartbeatUrl": "/api/transcode/session/sess-forced/heartbeat",
        });
        let seen = Arc::new(tokio::sync::Mutex::new(None));
        let (base, handle) =
            spawn_mock_transcoder_capture(grant, StatusCode::OK, seen.clone()).await;
        let state = test_state_with_transcoder(&base).await;
        // seed_media_file stores container=mp4, codec=h264, height=1080 — the
        // caps below match exactly, so without the flag this direct-plays
        // (proven by stream_direct_play_serves_bytes_when_caps_match).
        let file_id = seed_media_file(&state, "/lib/direct-eligible.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_height=1080&start_secs=42&force_transcode=true"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["transcode"], true);
        assert_eq!(v["sessionId"], "sess-forced");
        assert_eq!(v["reason"], "client requested buffered delivery");
        let body = seen.lock().await.clone().expect("transcoder grant body");
        assert_eq!(body["force_transcode"], true);
        assert_eq!(body["start_secs"], 42);
        handle.abort();
    }

    #[tokio::test]
    async fn stream_503s_when_no_transcoder_configured() {
        // Regression guard: with MEDIA_TRANSCODER_URL unset, the transcode-
        // required path must keep the exact pre-M4 503 behavior.
        let state = test_state().await;
        assert!(
            state.config.transcoder_url.is_none(),
            "default test state must have no transcoder"
        );
        let file_id = seed_media_file(&state, "/lib/needs-transcode.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn stream_handoff_maps_transcoder_busy_to_503() {
        // A transcoder at capacity returns {error:"transcoder_busy"}; media-core
        // surfaces that as a 503 with the same error code so the client backs off.
        let (base, handle) = spawn_mock_transcoder(
            json!({ "error": "transcoder_busy", "cpuCap": true }),
            StatusCode::SERVICE_UNAVAILABLE,
        )
        .await;
        let state = test_state_with_transcoder(&base).await;
        let file_id = seed_media_file(&state, "/lib/needs-transcode.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let v = body_json(resp).await;
        assert_eq!(v["error"], "transcoder_busy");
        handle.abort();
    }

    #[tokio::test]
    async fn stream_handoff_degrades_to_503_when_transcoder_unreachable() {
        // A configured-but-dead transcoder must degrade to the offline 503 path,
        // not a 500 — an outage looks identical to the M3-only posture.
        // Point at a port with nothing listening.
        let state = test_state_with_transcoder("http://127.0.0.1:1").await;
        let file_id = seed_media_file(&state, "/lib/needs-transcode.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn trigger_scan_returns_202_with_job_id_then_idle() {
        let state = test_state().await;
        let app = crate::build_router(state.clone());
        let resp = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let v = body_json(resp).await;
        assert_eq!(v["status"], "started");
        assert!(v["job_id"].as_str().is_some());

        // With empty library_roots the background scan completes ~instantly;
        // poll scan/status until it reports idle (bounded).
        let mut idle = false;
        for _ in 0..50 {
            let st = app
                .clone()
                .oneshot(
                    HttpRequest::builder()
                        .uri("/api/media/scan/status")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let sv = body_json(st).await;
            if sv["state"] == "idle" {
                idle = true;
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(idle, "scan/status never returned idle");
    }

    #[tokio::test]
    async fn trigger_scan_dropped_mid_flight_never_wedges_the_flag() {
        // REGRESSION: trigger_scan used to claim the `scanning` flag and then
        // await four scan_state writes BEFORE tokio::spawn. A handler future
        // dropped in that window (client disconnect, TimeoutLayer) left the
        // flag true forever, 409-ing every future POST /scan. The fix spawns
        // immediately after the claim with no intervening await — so a single
        // poll must complete the handler (claim + spawn + 202), and dropping
        // the future right after must still let the background task reset the
        // flag.
        use std::future::Future;

        let state = test_state().await;
        {
            let fut = trigger_scan(State(state.clone()), None);
            let mut fut = std::pin::pin!(fut);
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            // One poll, then drop — simulating cancellation at the first await
            // point. With no await between claim and spawn this poll already
            // returns Ready(202).
            let polled = fut.as_mut().poll(&mut cx);
            assert!(
                polled.is_ready(),
                "trigger_scan must reach tokio::spawn without an await point \
                 between the scanning-flag claim and the spawn"
            );
        }

        // The spawned task owns the flag reset; with empty roots it finishes
        // almost immediately.
        let mut cleared = false;
        for _ in 0..200 {
            if !state.scanning.load(std::sync::atomic::Ordering::SeqCst) {
                cleared = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(cleared, "scanning flag wedged after handler drop");

        // And a follow-up scan can start: 202, not 409.
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
    }

    #[test]
    fn authorize_scan_admin_gate() {
        use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims};

        let now = 1_748_000_000;
        let mk = |role: &str| {
            Some(InternalClaims {
                iss: "eex".into(),
                sub: "plex:caller".into(),
                role: role.into(),
                auth_mode: "plex".into(),
                server_id: "srv".into(),
                device_id: None,
                req_id: "r1".into(),
                iat: now,
                exp: now + DEFAULT_TTL_SECS,
            })
        };

        // Off mode: no boundary, gate is skipped regardless of role/claims.
        assert!(authorize_scan(&None, &PrincipalMode::Off).is_ok());
        assert!(authorize_scan(&mk("user"), &PrincipalMode::Off).is_ok());

        // Enforce/Log: admin allowed.
        assert!(authorize_scan(&mk("admin"), &PrincipalMode::Enforce).is_ok());
        assert!(authorize_scan(&mk("admin"), &PrincipalMode::Log).is_ok());

        // Enforce/Log: non-admin and missing principal are rejected with 403.
        for (claims, mode) in [
            (mk("user"), PrincipalMode::Enforce),
            (mk("user"), PrincipalMode::Log),
            (None, PrincipalMode::Enforce),
            (None, PrincipalMode::Log),
        ] {
            let err = authorize_scan(&claims, &mode).expect_err("should reject");
            assert_eq!(err.0, StatusCode::FORBIDDEN);
            assert_eq!(err.1.0["error"], "admin role required");
        }
    }

    #[tokio::test]
    async fn scan_rejects_non_admin_with_403() {
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .header(
                        "authorization",
                        format!("Bearer {}", signed_principal(secret, "user")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let v = body_json(resp).await;
        assert_eq!(v["error"], "admin role required");
    }

    #[tokio::test]
    async fn scan_rejects_missing_principal_with_403() {
        // Enforce mode requires a principal; a missing one is rejected by the
        // principal_layer (401) before reaching the admin gate. Either way an
        // unauthenticated caller cannot trigger a rescan.
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            resp.status() == StatusCode::FORBIDDEN || resp.status() == StatusCode::UNAUTHORIZED,
            "missing principal must not be allowed to scan; got {}",
            resp.status()
        );
    }

    #[tokio::test]
    async fn scan_allows_admin_with_202() {
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .header(
                        "authorization",
                        format!("Bearer {}", signed_principal(secret, "admin")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let v = body_json(resp).await;
        assert_eq!(v["status"], "started");
        assert!(v["job_id"].as_str().is_some());
    }
}
