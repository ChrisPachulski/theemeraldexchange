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
        .route("/music/artists", get(list_artists))
        .route("/music/albums", get(list_albums))
        .route("/music/albums/{id}/art", get(album_art))
        .route("/music/tracks", get(list_tracks))
        .route("/play/{kind}/{id}/grant", post(play_grant))
        .route("/watch", get(get_watch).post(post_watch))
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
    claims: Option<Extension<InternalClaims>>,
    Path(show_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, EpisodeRow>(
        "SELECT id, show_id, season, episode, title, air_date, file_id \
         FROM episodes WHERE show_id = ? ORDER BY season, episode",
    )
    .bind(show_id)
    .fetch_all(&state.db.pool)
    .await?;
    // Fire-and-forget: warm the continue episode's keyframes while the user reads
    // this detail page, so a copy-remux first play scrubs instead of showing the
    // LIVE badge — no latency on the play path. Best-effort; never blocks the list.
    tokio::spawn(prewarm_continue_episode(
        state.clone(),
        claims.map(|Extension(c)| c),
        show_id,
    ));
    Ok(Json(json!({ "items": rows })))
}

/// Index of the "continue" episode in a play-ordered episode list: the first the
/// user hasn't completed (a mid-episode resume AND the fresh next episode after
/// finishing one). Falls back to 0 (the first) when all are completed or there is
/// no watch history. `eps` tuples are `(id, season, episode, path)`.
fn continue_episode_index(eps: &[(i64, i64, i64, String)], completed: &[i64]) -> usize {
    eps.iter()
        .position(|(id, ..)| !completed.contains(id))
        .unwrap_or(0)
}

/// Browse-time keyframe prewarm (best-effort, fire-and-forget). The client calls
/// `list_episodes` when a show's detail page opens; we use that as the signal to
/// warm the keyframe cache for the episode the user is most likely to play — the
/// "continue" episode: the first episode in play order they haven't completed
/// (covers both a mid-episode resume AND the fresh next episode after finishing
/// one — the common binge case), else the first downloaded (fresh start). This
/// mirrors the client's hero "continue episode". The ~17s probe runs while the
/// user reads the page, so by the time Play is pressed the copy-remux manifest is
/// a finite VOD (real scrubber) instead of AVPlayer's LIVE chrome — with NO added
/// latency on the play path. Any failure (no transcoder, no downloaded file,
/// DB/network error) is swallowed: this only ever makes the next play nicer. See
/// `POST /api/transcode/warm`.
async fn prewarm_continue_episode(state: AppState, claims: Option<InternalClaims>, show_id: i64) {
    // Downloaded episodes for this show, in play order, with their backing path.
    let eps = sqlx::query_as::<_, (i64, i64, i64, String)>(
        "SELECT e.id, e.season, e.episode, m.path \
         FROM episodes e JOIN media_files m ON m.id = e.file_id \
         WHERE e.show_id = ? AND e.file_id IS NOT NULL \
         ORDER BY e.season, e.episode",
    )
    .bind(show_id)
    .fetch_all(&state.db.pool)
    .await
    .unwrap_or_default();
    if eps.is_empty() {
        return;
    }

    // The continue episode = the first in play order the user hasn't completed.
    // (`position_secs > 0` alone missed the just-finished-an-episode → next-fresh
    // case, the most common binge flow.) No claims → the first downloaded.
    let completed: Vec<i64> = if let Some(c) = claims.as_ref() {
        sqlx::query_scalar(
            "SELECT media_id FROM media_watch_state \
             WHERE sub = ? AND media_kind = 'episode' AND completed = 1",
        )
        .bind(&c.sub)
        .fetch_all(&state.db.pool)
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    let chosen = &eps[continue_episode_index(&eps, &completed)];
    warm_path(&state, &claims, &chosen.3).await;
}

/// On an episode play grant, warm the NEXT downloaded episode's keyframes so
/// autoplay-next also scrubs from its first play (same copy-remux EVENT-vs-VOD
/// reason as the browse prewarm). Best-effort, fire-and-forget; a no-op for the
/// last episode (or a movie, whose grant never calls this).
async fn prewarm_next_episode(state: AppState, claims: Option<InternalClaims>, episode_id: i64) {
    let Ok(Some((show_id, season, episode))) = sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT show_id, season, episode FROM episodes WHERE id = ?",
    )
    .bind(episode_id)
    .fetch_optional(&state.db.pool)
    .await
    else {
        return;
    };
    // First downloaded episode strictly after this one in play order.
    let next = sqlx::query_as::<_, (String,)>(
        "SELECT m.path FROM episodes e JOIN media_files m ON m.id = e.file_id \
         WHERE e.show_id = ? AND e.file_id IS NOT NULL \
         AND (e.season > ? OR (e.season = ? AND e.episode > ?)) \
         ORDER BY e.season, e.episode LIMIT 1",
    )
    .bind(show_id)
    .bind(season)
    .bind(season)
    .bind(episode)
    .fetch_optional(&state.db.pool)
    .await
    .ok()
    .flatten();
    if let Some((path,)) = next {
        warm_path(&state, &claims, &path).await;
    }
}

/// Fire `POST /api/transcode/warm` for one file (best-effort). Shared by the
/// browse prewarm and the autoplay-next grant warm. Swallows every failure — a
/// warm only ever makes the next play nicer, it never blocks one.
async fn warm_path(state: &AppState, claims: &Option<InternalClaims>, path: &str) {
    let Some(transcoder_url) = state.config.transcoder_url.as_deref() else {
        return;
    };
    let url = format!(
        "{}/api/transcode/warm",
        transcoder_url.trim_end_matches('/')
    );
    let mut request = transcoder_http().post(&url).json(&json!({ "path": path }));
    if let Some(bearer) = mint_transcoder_principal(state, claims) {
        request = request.bearer_auth(bearer);
    }
    if let Err(e) = request.send().await {
        tracing::debug!(error = %e, "keyframe warm request failed (best-effort)");
    }
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

// ── Music library ─────────────────────────────────────────────────────────
//
// Browse endpoints mirroring the movie/episode list shape ({items, total} with
// limit/offset pagination). Each query struct evaluates every field it accepts
// (no accepted-but-ignored params — see the ListQuery note above); music does
// not carry a `?q=` search box, so these deliberately omit it.

#[derive(Debug, Deserialize)]
struct ArtistsQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AlbumsQuery {
    artist_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TracksQuery {
    album_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// GET /music/artists → `{ items: [{id, name, album_count}], total }`.
async fn list_artists(
    State(state): State<AppState>,
    Query(q): Query<ArtistsQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows = sqlx::query_as::<_, (i64, String, i64)>(
        "SELECT a.id, a.name, COUNT(al.id) AS album_count \
         FROM artists a LEFT JOIN albums al ON al.artist_id = a.id \
         GROUP BY a.id, a.name ORDER BY a.name LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artists")
        .fetch_one(&state.db.pool)
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(
            |(id, name, album_count)| json!({ "id": id, "name": name, "album_count": album_count }),
        )
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// GET /music/albums?artist_id= →
/// `{ items: [{id, artist_id, artist_name, title, year, track_count}], total }`.
/// `artist_id` optional (omit to list every album).
async fn list_albums(
    State(state): State<AppState>,
    Query(q): Query<AlbumsQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    // One SQL shape; `artist_id IS NULL OR al.artist_id = ?` lets the same query
    // serve both the filtered and unfiltered listing without duplication.
    let rows = sqlx::query_as::<_, (i64, i64, String, String, Option<i64>, i64, i64)>(
        "SELECT al.id, al.artist_id, ar.name, al.title, al.year, COUNT(t.id) AS track_count, \
         al.art_path IS NOT NULL \
         FROM albums al JOIN artists ar ON ar.id = al.artist_id \
         LEFT JOIN tracks t ON t.album_id = al.id \
         WHERE (? IS NULL OR al.artist_id = ?) \
         GROUP BY al.id ORDER BY ar.name, al.title LIMIT ? OFFSET ?",
    )
    .bind(q.artist_id)
    .bind(q.artist_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM albums WHERE (? IS NULL OR artist_id = ?)")
            .bind(q.artist_id)
            .bind(q.artist_id)
            .fetch_one(&state.db.pool)
            .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(
            |(id, artist_id, artist_name, title, year, track_count, has_art)| {
                json!({
                    "id": id,
                    "artist_id": artist_id,
                    "artist_name": artist_name,
                    "title": title,
                    "year": year,
                    "track_count": track_count,
                    "art_url": (*has_art == 1).then(|| format!("/api/media/music/albums/{id}/art")),
                })
            },
        )
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// GET /music/albums/{id}/art — the album image the scan discovered (folder
/// art referenced in place under a music root, or an extracted embedded
/// cover in the artwork dir). Both locations are containment-checked.
async fn album_art(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    let art_path: Option<Option<String>> =
        sqlx::query_scalar("SELECT art_path FROM albums WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?;
    let art_path = art_path.flatten().ok_or(AppError::NotFound)?;
    let mut allowed = state.config.music_roots.clone();
    allowed.push(state.config.artwork_dir.clone());
    if !path_within_roots(std::path::Path::new(&art_path), &allowed).await {
        tracing::warn!(path = %art_path, "refusing to serve album art outside roots");
        return Err(AppError::NotFound);
    }
    let bytes = tokio::fs::read(&art_path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                image_content_type(&art_path),
            ),
            (axum::http::header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}

/// GET /music/tracks?album_id= →
/// `{ items: [{id, album_id, title, track_no, duration_secs}], total }`.
/// `album_id` optional (omit to list every track).
async fn list_tracks(
    State(state): State<AppState>,
    Query(q): Query<TracksQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows = sqlx::query_as::<_, (i64, i64, String, Option<i64>, Option<i64>)>(
        "SELECT id, album_id, title, track_no, duration_secs FROM tracks \
         WHERE (? IS NULL OR album_id = ?) \
         ORDER BY track_no, title LIMIT ? OFFSET ?",
    )
    .bind(q.album_id)
    .bind(q.album_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tracks WHERE (? IS NULL OR album_id = ?)")
            .bind(q.album_id)
            .bind(q.album_id)
            .fetch_one(&state.db.pool)
            .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|(id, album_id, title, track_no, duration_secs)| {
            json!({
                "id": id,
                "album_id": album_id,
                "title": title,
                "track_no": track_no,
                "duration_secs": duration_secs,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
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
        // A track's backing file lives in `tracks.media_file_id`; from here on
        // it flows through the identical media_files → ServeFile range path.
        "track" => sqlx::query_scalar("SELECT media_file_id FROM tracks WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        // Audiobooks are keyed the same way (same probe, same range path).
        "audiobook" => sqlx::query_scalar("SELECT media_file_id FROM audiobooks WHERE id = ?")
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
    claims: Option<Extension<InternalClaims>>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<ClientCaps>>,
) -> AppResult<Json<Value>> {
    let file = resolve_media_file(&state, &kind, id).await?;
    let caps = body.map(|Json(c)| c).unwrap_or_default();
    // Audio always direct-plays (never transcoded); video runs the capability
    // decision against the advertised client caps.
    let (direct_play, reason) = if kind == "track" || kind == "audiobook" {
        (true, "audio direct play".to_string())
    } else {
        let decision = capability::decide(&file, &caps);
        (decision.direct_play, decision.reason)
    };

    // Autoplay-next: warm the next episode's keyframes now so its first play scrubs
    // too (best-effort, fire-and-forget; no-op for movies / the last episode).
    if kind == "episode" {
        tokio::spawn(prewarm_next_episode(
            state.clone(),
            claims.map(|Extension(c)| c),
            id,
        ));
    }

    Ok(Json(json!({
        "directPlay": direct_play,
        "transcoderRequired": !direct_play,
        "reason": reason,
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
    /// Native HLS player (AVPlayer) — opt into multi-audio muxing for in-band
    /// language switching. Browser/MSE clients omit it (single English track).
    #[serde(default)]
    native_hls: bool,
    /// Client pipeline applies Dolby Vision RPUs itself — gates DV
    /// direct-play and the transcoder's DV copy passthrough.
    #[serde(default)]
    dolby_vision: bool,
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
            || self.dolby_vision
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
            native_hls: self.native_hls,
            dolby_vision: self.dolby_vision,
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
                "dolby_vision": self.caps.dolby_vision,
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

    // Containment: never serve a file outside the configured roots. A track
    // lives under a MUSIC root, an audiobook under an AUDIOBOOK root;
    // movies/episodes under the video library roots.
    let allowed_roots: Vec<std::path::PathBuf> = match kind.as_str() {
        "track" => state.config.music_roots.clone(),
        "audiobook" => state.config.audiobook_roots.clone(),
        _ => state.config.library_paths(),
    };
    if !path_within_roots(std::path::Path::new(&file.path), &allowed_roots).await {
        tracing::warn!(path = %file.path, "refusing to stream file outside library roots");
        return Err(AppError::NotFound);
    }

    // Honor the direct-play contract (§3.5): if the client advertised caps and
    // the file can't direct-play, hand off to the M4 transcoder when one is
    // configured (MEDIA_TRANSCODER_URL). Without a transcoder this is the
    // M3-only posture, so return 503 rather than shipping undecodable bytes.
    // Audio (`track`/`audiobook`) is ALWAYS direct play — never engage the
    // transcoder — so the capability/handoff branch is skipped entirely for it.
    if kind != "track" && kind != "audiobook" && caps_q.advertised() {
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

/// Batch-resolve `id → T` for an `id IN (...)` lookup, sharing the empty-guard,
/// placeholder build, and per-id bind. `sql_for` receives the comma-joined `?`
/// placeholders; `map` turns each decoded row into its `(id, value)` entry.
async fn fetch_by_ids<R, T>(
    state: &AppState,
    ids: &[i64],
    sql_for: impl FnOnce(&str) -> String,
    map: impl Fn(R) -> (i64, T),
) -> AppResult<std::collections::HashMap<i64, T>>
where
    R: for<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> + Send + Unpin,
{
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let mut query = sqlx::query_as::<_, R>(sqlx::AssertSqlSafe(sql_for(&placeholders)));
    for id in ids {
        query = query.bind(id);
    }
    Ok(query
        .fetch_all(&state.db.pool)
        .await?
        .into_iter()
        .map(map)
        .collect())
}

/// Batch-resolve `movies.id → (title, poster_path)` for the watch shelf.
async fn fetch_movie_meta(
    state: &AppState,
    ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, (String, Option<String>)>> {
    fetch_by_ids(
        state,
        ids,
        |ph| format!("SELECT id, title, poster_path FROM movies WHERE id IN ({ph})"),
        |(id, title, poster): (i64, String, Option<String>)| (id, (title, poster)),
    )
    .await
}

/// Batch-resolve `episodes.id → EpisodeMeta` (joined to the parent show for its
/// title + poster) for the watch shelf.
async fn fetch_episode_meta(
    state: &AppState,
    ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, EpisodeMeta>> {
    fetch_by_ids(
        state,
        ids,
        |ph| {
            format!(
                "SELECT e.id, e.title, s.title, s.poster_path, e.season, e.episode \
                 FROM episodes e JOIN shows s ON e.show_id = s.id WHERE e.id IN ({ph})"
            )
        },
        |(id, episode_title, show_title, poster_path, season, episode): (
            i64,
            Option<String>,
            String,
            Option<String>,
            i64,
            i64,
        )| {
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
    .await
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
        "track" => "tracks",
        "audiobook" => "audiobooks",
        "podcast_episode" => "podcast_episodes",
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
                "media_kind must be one of movie, episode, track, audiobook, podcast_episode"
                    .into(),
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

// ── Playlists & collections ──────────────────────────────────────────────

/// The two user-curated list stores share one shape: a named per-user parent
/// row plus polymorphic `(media_kind, media_id)` item rows. Playlists keep a
/// `position` column (ordered); collections are unordered. Table names come
/// only from these two consts (never user input), so the `format!`-built SQL
/// below is injection-safe; all values are still bound parameters.
struct ListStore {
    /// Human noun for error messages ("playlist" / "collection").
    noun: &'static str,
    table: &'static str,
    items_table: &'static str,
    parent_fk: &'static str,
    /// `media_kind` → catalog table: the fixed allow-list for item validation
    /// (polymorphic ids can't be FK-enforced, same as media_watch_state).
    kinds: &'static [(&'static str, &'static str)],
    /// Ordered stores carry a `position` column on their item rows.
    ordered: bool,
}

const PLAYLIST_STORE: ListStore = ListStore {
    noun: "playlist",
    table: "playlists",
    items_table: "playlist_items",
    parent_fk: "playlist_id",
    kinds: &[("movie", "movies"), ("episode", "episodes")],
    ordered: true,
};

const COLLECTION_STORE: ListStore = ListStore {
    noun: "collection",
    table: "collections",
    items_table: "collection_items",
    parent_fk: "collection_id",
    kinds: &[("movie", "movies"), ("show", "shows")],
    ordered: false,
};

#[derive(Debug, Deserialize)]
pub struct NameBody {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct ListItemBody {
    pub media_kind: String,
    pub media_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct ReorderBody {
    pub items: Vec<ListItemBody>,
}

#[derive(Debug, Deserialize)]
pub struct ListItemQuery {
    pub sub: Option<String>,
    pub media_kind: String,
    pub media_id: i64,
}

/// Map an sqlx error to 400 on UNIQUE violation (duplicate `(sub, name)`),
/// otherwise pass it through as a 500-class DB error.
fn unique_to_bad_request(e: sqlx::Error, msg: &str) -> AppError {
    match &e {
        sqlx::Error::Database(db)
            if matches!(db.kind(), sqlx::error::ErrorKind::UniqueViolation) =>
        {
            AppError::BadRequest(msg.into())
        }
        _ => AppError::Db(e),
    }
}

/// 404 unless `id` names a parent row owned by `sub`. Scoping every statement
/// by owner keeps one user's playlist ids useless to another (no IDOR).
async fn store_owned(state: &AppState, store: &ListStore, id: i64, sub: &str) -> AppResult<()> {
    let sql = format!("SELECT 1 FROM {} WHERE id = ? AND sub = ?", store.table);
    let found: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(sub)
        .fetch_optional(&state.db.pool)
        .await?;
    if found.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn store_touch(state: &AppState, store: &ListStore, id: i64) -> AppResult<()> {
    let sql = format!("UPDATE {} SET updated_at = ? WHERE id = ?", store.table);
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&state.db.pool)
        .await?;
    Ok(())
}

async fn store_list(state: &AppState, store: &ListStore, sub: &str) -> AppResult<Json<Value>> {
    let sql = format!(
        "SELECT p.id, p.name, p.created_at, p.updated_at, \
         (SELECT COUNT(*) FROM {items} i WHERE i.{fk} = p.id) \
         FROM {table} p WHERE p.sub = ? ORDER BY p.name COLLATE NOCASE",
        items = store.items_table,
        fk = store.parent_fk,
        table = store.table,
    );
    let rows: Vec<(i64, String, String, String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(sub)
        .fetch_all(&state.db.pool)
        .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, created_at, updated_at, item_count)| {
            json!({
                "id": id,
                "name": name,
                "created_at": created_at,
                "updated_at": updated_at,
                "item_count": item_count,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

async fn store_create(
    state: &AppState,
    store: &ListStore,
    sub: &str,
    name: &str,
) -> AppResult<Json<Value>> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name required".into()));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let sql = format!(
        "INSERT INTO {} (sub, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        store.table
    );
    let id = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(sub)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&state.db.pool)
        .await
        .map_err(|e| {
            unique_to_bad_request(
                e,
                &format!("a {} with that name already exists", store.noun),
            )
        })?
        .last_insert_rowid();
    Ok(Json(json!({ "id": id, "name": name, "created_at": now })))
}

async fn store_rename(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
    name: &str,
) -> AppResult<Json<Value>> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name required".into()));
    }
    store_owned(state, store, id, sub).await?;
    let sql = format!(
        "UPDATE {} SET name = ?, updated_at = ? WHERE id = ? AND sub = ?",
        store.table
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(name)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .bind(sub)
        .execute(&state.db.pool)
        .await
        .map_err(|e| {
            unique_to_bad_request(
                e,
                &format!("a {} with that name already exists", store.noun),
            )
        })?;
    Ok(Json(json!({ "ok": true })))
}

async fn store_delete(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
) -> AppResult<Json<Value>> {
    store_owned(state, store, id, sub).await?;
    // Items first: the item tables carry no FK to the parent (polymorphic
    // store, see the migration header), so cascade by hand.
    let mut tx = state.db.pool.begin().await?;
    let del_items = format!(
        "DELETE FROM {} WHERE {} = ?",
        store.items_table, store.parent_fk
    );
    sqlx::query(sqlx::AssertSqlSafe(del_items))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let del_parent = format!("DELETE FROM {} WHERE id = ? AND sub = ?", store.table);
    sqlx::query(sqlx::AssertSqlSafe(del_parent))
        .bind(id)
        .bind(sub)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

/// Validate `(media_kind, media_id)` against the store's catalog allow-list.
/// Unknown kind → 400, known kind with absent id → 404 (same contract as
/// watch-state's `media_exists`).
async fn store_item_valid(
    state: &AppState,
    store: &ListStore,
    media_kind: &str,
    media_id: i64,
) -> AppResult<()> {
    let Some((_, table)) = store.kinds.iter().find(|(k, _)| *k == media_kind) else {
        let allowed = store
            .kinds
            .iter()
            .map(|(k, _)| format!("'{k}'"))
            .collect::<Vec<_>>()
            .join(" or ");
        return Err(AppError::BadRequest(format!(
            "media_kind must be {allowed}"
        )));
    };
    let sql = format!("SELECT 1 FROM {table} WHERE id = ? LIMIT 1");
    let found: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(media_id)
        .fetch_optional(&state.db.pool)
        .await?;
    if found.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn store_add_item(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
    item: &ListItemBody,
) -> AppResult<Json<Value>> {
    store_owned(state, store, id, sub).await?;
    store_item_valid(state, store, &item.media_kind, item.media_id).await?;
    let now = chrono::Utc::now().to_rfc3339();
    // Re-adding an existing item is a no-op (idempotent), not an error.
    let sql = if store.ordered {
        format!(
            "INSERT INTO {items} ({fk}, media_kind, media_id, position, added_at) \
             VALUES (?, ?, ?, \
             (SELECT COALESCE(MAX(position) + 1, 0) FROM {items} WHERE {fk} = ?), ?) \
             ON CONFLICT DO NOTHING",
            items = store.items_table,
            fk = store.parent_fk,
        )
    } else {
        format!(
            "INSERT INTO {items} ({fk}, media_kind, media_id, added_at) \
             VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
            items = store.items_table,
            fk = store.parent_fk,
        )
    };
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(&item.media_kind)
        .bind(item.media_id);
    if store.ordered {
        query = query.bind(id);
    }
    query.bind(&now).execute(&state.db.pool).await?;
    store_touch(state, store, id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn store_remove_item(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
    media_kind: &str,
    media_id: i64,
) -> AppResult<Json<Value>> {
    store_owned(state, store, id, sub).await?;
    let sql = format!(
        "DELETE FROM {} WHERE {} = ? AND media_kind = ? AND media_id = ?",
        store.items_table, store.parent_fk
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(media_kind)
        .bind(media_id)
        .execute(&state.db.pool)
        .await?;
    store_touch(state, store, id).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Fetch the parent row `(name, created_at, updated_at)` for a detail view.
async fn store_meta(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
) -> AppResult<(String, String, String)> {
    let sql = format!(
        "SELECT name, created_at, updated_at FROM {} WHERE id = ? AND sub = ?",
        store.table
    );
    sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(sub)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or(AppError::NotFound)
}

async fn list_playlists(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_list(&state, &PLAYLIST_STORE, &sub).await
}

async fn create_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_create(&state, &PLAYLIST_STORE, &sub, &body.name).await
}

async fn get_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    let (name, created_at, updated_at) = store_meta(&state, &PLAYLIST_STORE, id, &sub).await?;
    let rows: Vec<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT media_kind, media_id, position, added_at FROM playlist_items \
         WHERE playlist_id = ? ORDER BY position",
    )
    .bind(id)
    .fetch_all(&state.db.pool)
    .await?;

    let movie_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.0 == "movie")
        .map(|r| r.1)
        .collect();
    let episode_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.0 == "episode")
        .map(|r| r.1)
        .collect();
    let movie_meta = fetch_movie_meta(&state, &movie_ids).await?;
    let episode_meta = fetch_episode_meta(&state, &episode_ids).await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|(media_kind, media_id, position, added_at)| {
            let mut v = json!({
                "media_kind": media_kind,
                "media_id": media_id,
                "position": position,
                "added_at": added_at,
            });
            let obj = v.as_object_mut().expect("json object");
            match media_kind.as_str() {
                "movie" => {
                    if let Some((title, poster)) = movie_meta.get(media_id) {
                        obj.insert("title".into(), json!(title));
                        obj.insert("poster_path".into(), json!(poster));
                    }
                }
                "episode" => {
                    if let Some(e) = episode_meta.get(media_id) {
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

    Ok(Json(json!({
        "id": id,
        "name": name,
        "created_at": created_at,
        "updated_at": updated_at,
        "items": items,
    })))
}

async fn rename_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_rename(&state, &PLAYLIST_STORE, id, &sub, &body.name).await
}

async fn delete_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_delete(&state, &PLAYLIST_STORE, id, &sub).await
}

async fn add_playlist_item(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<ListItemBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_add_item(&state, &PLAYLIST_STORE, id, &sub, &body).await
}

async fn delete_playlist_item(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<ListItemQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_remove_item(&state, &PLAYLIST_STORE, id, &sub, &q.media_kind, q.media_id).await
}

/// Full reorder: the body must list every current item exactly once; each
/// item's new `position` is its index in the array. Partial reorders are
/// rejected so positions can never silently collide or gap.
async fn reorder_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<ReorderBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_owned(&state, &PLAYLIST_STORE, id, &sub).await?;

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?")
            .bind(id)
            .fetch_one(&state.db.pool)
            .await?;
    let unique: std::collections::HashSet<(&str, i64)> = body
        .items
        .iter()
        .map(|i| (i.media_kind.as_str(), i.media_id))
        .collect();
    if body.items.len() as i64 != count || unique.len() != body.items.len() {
        return Err(AppError::BadRequest(
            "reorder must list every playlist item exactly once".into(),
        ));
    }

    let mut tx = state.db.pool.begin().await?;
    let mut updated: u64 = 0;
    for (position, item) in body.items.iter().enumerate() {
        let res = sqlx::query(
            "UPDATE playlist_items SET position = ? \
             WHERE playlist_id = ? AND media_kind = ? AND media_id = ?",
        )
        .bind(position as i64)
        .bind(id)
        .bind(&item.media_kind)
        .bind(item.media_id)
        .execute(&mut *tx)
        .await?;
        updated += res.rows_affected();
    }
    if updated != count as u64 {
        // Body named an item that is not in the playlist; tx drop = rollback.
        return Err(AppError::BadRequest(
            "reorder must list every playlist item exactly once".into(),
        ));
    }
    tx.commit().await?;
    store_touch(&state, &PLAYLIST_STORE, id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_collections(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_list(&state, &COLLECTION_STORE, &sub).await
}

async fn create_collection(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_create(&state, &COLLECTION_STORE, &sub, &body.name).await
}

async fn get_collection(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    let (name, created_at, updated_at) = store_meta(&state, &COLLECTION_STORE, id, &sub).await?;
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT media_kind, media_id, added_at FROM collection_items \
         WHERE collection_id = ? ORDER BY added_at",
    )
    .bind(id)
    .fetch_all(&state.db.pool)
    .await?;

    let movie_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.0 == "movie")
        .map(|r| r.1)
        .collect();
    let show_ids: Vec<i64> = rows.iter().filter(|r| r.0 == "show").map(|r| r.1).collect();
    let movie_meta = fetch_movie_meta(&state, &movie_ids).await?;
    let show_meta = fetch_show_meta(&state, &show_ids).await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|(media_kind, media_id, added_at)| {
            let mut v = json!({
                "media_kind": media_kind,
                "media_id": media_id,
                "added_at": added_at,
            });
            let obj = v.as_object_mut().expect("json object");
            let meta = match media_kind.as_str() {
                "movie" => movie_meta.get(media_id),
                "show" => show_meta.get(media_id),
                _ => None,
            };
            if let Some((title, poster)) = meta {
                obj.insert("title".into(), json!(title));
                obj.insert("poster_path".into(), json!(poster));
            }
            v
        })
        .collect();

    Ok(Json(json!({
        "id": id,
        "name": name,
        "created_at": created_at,
        "updated_at": updated_at,
        "items": items,
    })))
}

/// Batch-resolve `shows.id → (title, poster_path)` for collection detail.
async fn fetch_show_meta(
    state: &AppState,
    ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, (String, Option<String>)>> {
    fetch_by_ids(
        state,
        ids,
        |ph| format!("SELECT id, title, poster_path FROM shows WHERE id IN ({ph})"),
        |(id, title, poster): (i64, String, Option<String>)| (id, (title, poster)),
    )
    .await
}

async fn rename_collection(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_rename(&state, &COLLECTION_STORE, id, &sub, &body.name).await
}

async fn delete_collection(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_delete(&state, &COLLECTION_STORE, id, &sub).await
}

async fn add_collection_item(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<ListItemBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_add_item(&state, &COLLECTION_STORE, id, &sub, &body).await
}

async fn delete_collection_item(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<ListItemQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_remove_item(
        &state,
        &COLLECTION_STORE,
        id,
        &sub,
        &q.media_kind,
        q.media_id,
    )
    .await
}

// ── Photos ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PageQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// `(id, width, height, taken_at, mtime)` from `photos`.
type PhotoListRow = (i64, Option<i64>, Option<i64>, Option<String>, String);
/// `(id, feed_url, title, description, image_url, added_at, refreshed_at,
/// episode_count)` from `podcasts`.
type PodcastListRow = (
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    i64,
);
/// `(id, title, audio_url, published_at, duration_secs, description)` from
/// `podcast_episodes`.
type PodcastEpisodeRow = (
    i64,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);

async fn list_photos(
    State(state): State<AppState>,
    Query(q): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    // Timeline order: EXIF taken-at when present, file mtime otherwise (both
    // stored in lexicographically-chronological shapes).
    let rows: Vec<PhotoListRow> = sqlx::query_as(
        "SELECT id, width, height, taken_at, mtime FROM photos \
         ORDER BY COALESCE(taken_at, mtime) DESC LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM photos")
        .fetch_one(&state.db.pool)
        .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, width, height, taken_at, mtime)| {
            json!({
                "id": id,
                "width": width,
                "height": height,
                "taken_at": taken_at,
                "mtime": mtime,
                "url": format!("/api/media/photos/{id}/file"),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// Content type by extension for the photo file endpoint.
fn image_content_type(path: &str) -> &'static str {
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

async fn photo_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    let path: Option<String> = sqlx::query_scalar("SELECT path FROM photos WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db.pool)
        .await?;
    let path = path.ok_or(AppError::NotFound)?;
    // Same defense-in-depth as stream_file: only serve inside the photo roots.
    if !path_within_roots(std::path::Path::new(&path), &state.config.photo_roots).await {
        tracing::warn!(path = %path, "refusing to serve photo outside photo roots");
        return Err(AppError::NotFound);
    }
    // ponytail: originals only, read fully (photos are MBs, not GBs). Add an
    // ffmpeg-scaled thumbnail cache when the grid UI needs one.
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, image_content_type(&path)),
            (axum::http::header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}

// ── Audiobooks ────────────────────────────────────────────────────────────

async fn list_audiobooks(
    State(state): State<AppState>,
    Query(q): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows: Vec<(i64, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT id, author, title, duration_secs FROM audiobooks \
         ORDER BY author COLLATE NOCASE, title COLLATE NOCASE LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audiobooks")
        .fetch_one(&state.db.pool)
        .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, author, title, duration_secs)| {
            json!({
                "id": id,
                "author": author,
                "title": title,
                "duration_secs": duration_secs,
                "streamUrl": format!("/api/media/stream/audiobook/{id}"),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

async fn get_audiobook(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let row: Option<(String, String, Option<i64>, String)> = sqlx::query_as(
        "SELECT author, title, duration_secs, chapters_json FROM audiobooks WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?;
    let (author, title, duration_secs, chapters_json) = row.ok_or(AppError::NotFound)?;
    let chapters: Value = serde_json::from_str(&chapters_json).unwrap_or_else(|_| json!([]));
    Ok(Json(json!({
        "id": id,
        "author": author,
        "title": title,
        "duration_secs": duration_secs,
        "chapters": chapters,
        "streamUrl": format!("/api/media/stream/audiobook/{id}"),
    })))
}

// ── Podcasts ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PodcastAddBody {
    pub feed_url: String,
}

async fn list_podcasts(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let rows: Vec<PodcastListRow> = sqlx::query_as(
        "SELECT p.id, p.feed_url, p.title, p.description, p.image_url, p.added_at, \
         p.refreshed_at, \
         (SELECT COUNT(*) FROM podcast_episodes e WHERE e.podcast_id = p.id) \
         FROM podcasts p ORDER BY p.title COLLATE NOCASE",
    )
    .fetch_all(&state.db.pool)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(
            |(id, feed_url, title, description, image_url, added_at, refreshed_at, count)| {
                json!({
                    "id": id,
                    "feed_url": feed_url,
                    "title": title,
                    "description": description,
                    "image_url": image_url,
                    "added_at": added_at,
                    "refreshed_at": refreshed_at,
                    "episode_count": count,
                })
            },
        )
        .collect();
    Ok(Json(json!({ "items": items })))
}

async fn add_podcast(
    State(state): State<AppState>,
    Json(body): Json<PodcastAddBody>,
) -> AppResult<Json<Value>> {
    let feed_url = body.feed_url.trim().to_string();
    if !(feed_url.starts_with("http://") || feed_url.starts_with("https://")) {
        return Err(AppError::BadRequest("feed_url must be http(s)".into()));
    }
    // Fetch first: a subscription that never parsed is not worth storing.
    let feed = crate::podcasts::fetch_feed(&feed_url)
        .await
        .map_err(AppError::BadRequest)?;

    let id = sqlx::query("INSERT INTO podcasts (feed_url, title, added_at) VALUES (?, ?, ?)")
        .bind(&feed_url)
        .bind(&feed.title)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&state.db.pool)
        .await
        .map_err(|e| unique_to_bad_request(e, "already subscribed to that feed"))?
        .last_insert_rowid();
    let episodes = crate::podcasts::store_feed(&state.db, id, &feed).await?;

    Ok(Json(json!({
        "id": id,
        "title": feed.title,
        "episodes": episodes,
    })))
}

async fn refresh_podcast_route(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let episodes = crate::podcasts::refresh_podcast(&state.db, id).await?;
    Ok(Json(json!({ "ok": true, "episodes": episodes })))
}

async fn delete_podcast(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    // Episodes cascade via their FK (foreign_keys is ON for this pool).
    let affected = sqlx::query("DELETE FROM podcasts WHERE id = ?")
        .bind(id)
        .execute(&state.db.pool)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn list_podcast_episodes(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM podcasts WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db.pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows: Vec<PodcastEpisodeRow> = sqlx::query_as(
        "SELECT id, title, audio_url, published_at, duration_secs, description \
         FROM podcast_episodes WHERE podcast_id = ? \
         ORDER BY published_at IS NULL, published_at DESC LIMIT ? OFFSET ?",
    )
    .bind(id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM podcast_episodes WHERE podcast_id = ?")
            .bind(id)
            .fetch_one(&state.db.pool)
            .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(
            |(id, title, audio_url, published_at, duration_secs, description)| {
                json!({
                    "id": id,
                    "title": title,
                    "audio_url": audio_url,
                    "published_at": published_at,
                    "duration_secs": duration_secs,
                    "description": description,
                })
            },
        )
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

// ── Sidecar subtitles: OpenSubtitles download + Whisper transcription ────

/// Longer-lived client than [`transcoder_http`]: an OpenSubtitles search +
/// download is three sequential internet round-trips, not a LAN hop.
fn subtitles_http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

/// Base URL for the OpenSubtitles REST API; overridable for tests/stubs.
fn opensubtitles_base() -> String {
    std::env::var("OPENSUBTITLES_API_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.opensubtitles.com".to_string())
}

const OPENSUBTITLES_USER_AGENT: &str = "theemeraldexchange v1";

#[derive(Debug, Deserialize, Default)]
pub struct SubtitleLangBody {
    /// BCP-47-ish language code; defaults to English.
    pub language: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SubtitleFileQuery {
    pub language: String,
    pub source: String,
}

/// `(file path, imdb numeric id, Some((season, episode)) for episodes)` for
/// one movie/episode, or the usual 400/404 contract on bad refs. Episodes
/// resolve the PARENT show's imdb id (OpenSubtitles queries take
/// `parent_imdb_id` + season/episode numbers).
async fn subtitle_media_lookup(
    state: &AppState,
    kind: &str,
    id: i64,
) -> AppResult<(String, Option<i64>, Option<(i64, i64)>)> {
    match kind {
        "movie" => {
            let row: Option<(String, Option<String>)> = sqlx::query_as(
                "SELECT mf.path, m.imdb_id FROM movies m \
                 JOIN media_files mf ON m.file_id = mf.id WHERE m.id = ?",
            )
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?;
            let (path, imdb) = row.ok_or(AppError::NotFound)?;
            Ok((
                path,
                imdb.as_deref().and_then(crate::subtitles::imdb_numeric),
                None,
            ))
        }
        "episode" => {
            let row: Option<(String, Option<String>, i64, i64)> = sqlx::query_as(
                "SELECT mf.path, s.imdb_id, e.season, e.episode FROM episodes e \
                 JOIN shows s ON e.show_id = s.id \
                 JOIN media_files mf ON e.file_id = mf.id WHERE e.id = ?",
            )
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?;
            let (path, imdb, season, episode) = row.ok_or(AppError::NotFound)?;
            Ok((
                path,
                imdb.as_deref().and_then(crate::subtitles::imdb_numeric),
                Some((season, episode)),
            ))
        }
        _ => Err(AppError::BadRequest(
            "media_kind must be 'movie' or 'episode'".into(),
        )),
    }
}

/// Public URL (relative, BFF-proxied) for one stored sidecar subtitle.
fn subtitle_url(kind: &str, id: i64, lang: &str, source: &str) -> String {
    format!("/api/media/subtitles/{kind}/{id}/file?language={lang}&source={source}")
}

async fn list_subtitles(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    if kind != "movie" && kind != "episode" {
        return Err(AppError::BadRequest(
            "media_kind must be 'movie' or 'episode'".into(),
        ));
    }
    let prefix = format!("{kind}_{id}_");
    let mut items = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir(&state.config.subtitles_dir).await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(rest) = name
                .strip_prefix(&prefix)
                .and_then(|r| r.strip_suffix(".vtt"))
            else {
                continue;
            };
            // rest = "{lang}_{source}"
            let Some((lang, source)) = rest.split_once('_') else {
                continue;
            };
            items.push(json!({
                "language": lang,
                "source": source,
                "url": subtitle_url(&kind, id, lang, source),
            }));
        }
    }
    Ok(Json(json!({ "items": items })))
}

async fn subtitle_file(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    Query(q): Query<SubtitleFileQuery>,
) -> AppResult<axum::response::Response> {
    if kind != "movie" && kind != "episode" {
        return Err(AppError::BadRequest(
            "media_kind must be 'movie' or 'episode'".into(),
        ));
    }
    // sidecar_name sanitizes lang/source to [a-z0-9-], so the joined path can
    // never escape the subtitles dir.
    let path = state
        .config
        .subtitles_dir
        .join(crate::subtitles::sidecar_name(
            &kind,
            id,
            &q.language,
            &q.source,
        ));
    let body = tokio::fs::read_to_string(&path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/vtt; charset=utf-8")],
        body,
    )
        .into_response())
}

async fn download_subtitle(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<SubtitleLangBody>>,
) -> AppResult<Json<Value>> {
    let Some(api_key) = state.config.opensubtitles_api_key.clone() else {
        return Err(AppError::FeatureDisabled(
            "subtitle download requires OPENSUBTITLES_API_KEY".into(),
        ));
    };
    let lang = crate::subtitles::sanitize_token(
        body.and_then(|Json(b)| b.language)
            .as_deref()
            .unwrap_or("en"),
    );
    let (_path, imdb, episode_nums) = subtitle_media_lookup(&state, &kind, id).await?;
    let Some(imdb) = imdb else {
        return Err(AppError::BadRequest(
            "title has no imdb id to search by".into(),
        ));
    };

    let base = opensubtitles_base();
    let mut search_url = match episode_nums {
        Some((season, episode)) => format!(
            "{base}/api/v1/subtitles?parent_imdb_id={imdb}&season_number={season}&episode_number={episode}&languages={lang}"
        ),
        None => format!("{base}/api/v1/subtitles?imdb_id={imdb}&languages={lang}"),
    };
    search_url.push_str("&order_by=download_count&order_direction=desc");

    let http = subtitles_http();
    let search: Value = http
        .get(&search_url)
        .header("Api-Key", &api_key)
        .header("User-Agent", OPENSUBTITLES_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles search failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles search body: {e}")))?;
    let candidates = crate::subtitles::parse_search_results(&search);
    let Some(best) = crate::subtitles::pick_best(&candidates) else {
        return Err(AppError::NotFound);
    };

    let download: Value = http
        .post(format!("{base}/api/v1/download"))
        .header("Api-Key", &api_key)
        .header("User-Agent", OPENSUBTITLES_USER_AGENT)
        .json(&json!({ "file_id": best.file_id }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles download failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles download body: {e}")))?;
    let Some(link) = download.get("link").and_then(Value::as_str) else {
        return Err(AppError::Internal(
            "opensubtitles download returned no link".into(),
        ));
    };
    let srt = http
        .get(link)
        .header("User-Agent", OPENSUBTITLES_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("subtitle fetch failed: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("subtitle fetch body: {e}")))?;

    let vtt = crate::subtitles::srt_to_vtt(&srt);
    let dir = &state.config.subtitles_dir;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::Internal(format!("subtitles dir: {e}")))?;
    let dest = dir.join(crate::subtitles::sidecar_name(&kind, id, &lang, "os"));
    tokio::fs::write(&dest, vtt)
        .await
        .map_err(|e| AppError::Internal(format!("subtitle write: {e}")))?;

    Ok(Json(json!({
        "ok": true,
        "language": lang,
        "source": "os",
        "url": subtitle_url(&kind, id, &lang, "os"),
    })))
}

async fn subtitle_job_status() -> AppResult<Json<Value>> {
    Ok(Json(json!({
        "job": crate::subtitles::job_status(),
    })))
}

async fn transcribe_subtitle(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<SubtitleLangBody>>,
) -> AppResult<axum::response::Response> {
    let Some(bin) = state.config.whisper_bin.clone() else {
        return Err(AppError::FeatureDisabled(
            "transcription requires WHISPER_BIN".into(),
        ));
    };
    let lang = crate::subtitles::sanitize_token(
        body.and_then(|Json(b)| b.language)
            .as_deref()
            .unwrap_or("en"),
    );
    let (path, _, _) = subtitle_media_lookup(&state, &kind, id).await?;

    let status = crate::subtitles::job_json(&kind, id, &lang, "running", None);
    if let Err(running) = crate::subtitles::claim_job(status) {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "transcription already running", "job": running })),
        )
            .into_response());
    }

    let dir = state.config.subtitles_dir.clone();
    let dest = dir.join(crate::subtitles::sidecar_name(&kind, id, &lang, "whisper"));
    let model = state.config.whisper_model.clone();
    let kind_owned = kind.clone();
    let lang_job = lang.clone();
    // Detached: Whisper on a full movie runs for many minutes. Progress is
    // observable via GET /subtitles/status; the slot frees on completion.
    tokio::spawn(async move {
        let lang = lang_job;
        let result = run_whisper_job(&bin, model.as_deref(), &path, &dir, &dest, &lang).await;
        let (job_state, detail) = match &result {
            Ok(()) => ("done", None),
            Err(e) => ("error", Some(e.as_str())),
        };
        crate::subtitles::finish_job(crate::subtitles::job_json(
            &kind_owned,
            id,
            &lang,
            job_state,
            detail,
        ));
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "ok": true,
            "state": "running",
            "url": subtitle_url(&kind, id, &lang, "whisper"),
        })),
    )
        .into_response())
}

/// Run the Whisper CLI into a scratch dir, then move its `<stem>.vtt` output
/// to the canonical sidecar name. Scratch keeps concurrent-looking filenames
/// (two ids sharing a stem) from clobbering each other.
async fn run_whisper_job(
    bin: &str,
    model: Option<&str>,
    input: &str,
    subtitles_dir: &std::path::Path,
    dest: &std::path::Path,
    lang: &str,
) -> Result<(), String> {
    let input_path = std::path::Path::new(input);
    let scratch = subtitles_dir.join(format!(
        ".whisper-{}",
        dest.file_stem().unwrap_or_default().to_string_lossy()
    ));
    tokio::fs::create_dir_all(&scratch)
        .await
        .map_err(|e| format!("scratch dir: {e}"))?;

    let args = crate::subtitles::whisper_args(input_path, &scratch, model, Some(lang));
    let output = tokio::process::Command::new(bin)
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.chars().rev().take(400).collect::<String>();
        let tail: String = tail.chars().rev().collect();
        let _ = tokio::fs::remove_dir_all(&scratch).await;
        return Err(format!("whisper exited {}: {tail}", output.status));
    }

    let produced = crate::subtitles::whisper_output_path(&scratch, input_path);
    tokio::fs::rename(&produced, dest)
        .await
        .map_err(|e| format!("move {}: {e}", produced.display()))?;
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    Ok(())
}

// ── Markers (intro / credits — M6 "Skip Intro") ──────────────────────────

#[derive(Debug, Deserialize)]
pub struct MarkerQuery {
    pub media_kind: String,
    pub media_id: i64,
    /// Required for DELETE (which marker to remove); ignored by GET (returns all).
    pub marker_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MarkerUpsert {
    pub media_kind: String,
    pub media_id: i64,
    pub marker_type: String,
    pub start_secs: i64,
    pub end_secs: i64,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(sqlx::FromRow)]
struct MarkerRow {
    marker_type: String,
    start_secs: i64,
    end_secs: i64,
    source: String,
    updated_at: String,
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

/// Pure validation of a marker upsert. Returns an error message, or `None`.
fn validate_marker(m: &MarkerUpsert) -> Option<&'static str> {
    if m.marker_type != "intro" && m.marker_type != "credits" {
        return Some("marker_type must be 'intro' or 'credits'");
    }
    if m.start_secs < 0 || m.end_secs <= m.start_secs {
        return Some("require 0 <= start_secs < end_secs");
    }
    if let Some(s) = &m.source
        && !matches!(s.as_str(), "manual" | "imported" | "detected")
    {
        return Some("source must be 'manual', 'imported', or 'detected'");
    }
    None
}

/// GET markers for one title. Readable by any member — the client needs them to
/// render Skip Intro / Skip Credits. Markers are title-scoped, not per-user.
async fn get_markers(
    State(state): State<AppState>,
    Query(q): Query<MarkerQuery>,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, MarkerRow>(
        "SELECT marker_type, start_secs, end_secs, source, updated_at \
         FROM media_markers WHERE media_kind = ? AND media_id = ? ORDER BY marker_type",
    )
    .bind(&q.media_kind)
    .bind(q.media_id)
    .fetch_all(&state.db.pool)
    .await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "marker_type": r.marker_type,
                "start_secs": r.start_secs,
                "end_secs": r.end_secs,
                "source": r.source,
                "updated_at": r.updated_at,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// PUT (upsert) an intro/credits marker. Admin-only; the title must exist.
async fn put_marker(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Json(body): Json<MarkerUpsert>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    require_admin(&claims, &state.config.principal_mode)?;

    if let Some(msg) = validate_marker(&body) {
        return Err(AppError::BadRequest(msg.into()));
    }
    match media_exists(&state, &body.media_kind, body.media_id).await? {
        None => return Err(AppError::BadRequest("unknown media_kind".into())),
        Some(false) => return Err(AppError::NotFound),
        Some(true) => {}
    }

    let source = body.source.as_deref().unwrap_or("manual");
    let updated_at = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO media_markers \
         (media_kind, media_id, marker_type, start_secs, end_secs, source, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(media_kind, media_id, marker_type) DO UPDATE SET \
         start_secs = excluded.start_secs, end_secs = excluded.end_secs, \
         source = excluded.source, updated_at = excluded.updated_at",
    )
    .bind(&body.media_kind)
    .bind(body.media_id)
    .bind(&body.marker_type)
    .bind(body.start_secs)
    .bind(body.end_secs)
    .bind(source)
    .bind(&updated_at)
    .execute(&state.db.pool)
    .await?;

    Ok(Json(json!({ "ok": true, "updated_at": updated_at })))
}

/// DELETE one marker (by media_kind+media_id+marker_type). Admin-only.
async fn delete_marker(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<MarkerQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    require_admin(&claims, &state.config.principal_mode)?;

    let marker_type = q
        .marker_type
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("marker_type required".into()))?;

    let res = sqlx::query(
        "DELETE FROM media_markers WHERE media_kind = ? AND media_id = ? AND marker_type = ?",
    )
    .bind(&q.media_kind)
    .bind(q.media_id)
    .bind(&marker_type)
    .execute(&state.db.pool)
    .await?;

    Ok(Json(json!({ "ok": true, "deleted": res.rows_affected() })))
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

        // Music library scan in the same background task (a no-op when
        // MUSIC_LIBRARY_PATHS is unset). Its summary lands in `last_music_report`
        // for observability; the video report above still drives /scan/status.
        match scanner::scan_music_isolated(
            bg.db.clone(),
            bg.config.music_roots.clone(),
            bg.config.artwork_dir.clone(),
        )
        .await
        {
            Ok(report) => {
                let json = serde_json::to_string(&report).unwrap_or_else(|_| "{}".into());
                set_scan_state(&bg.db, "last_music_report", &json).await;
            }
            Err(e) => {
                tracing::warn!("background music scan failed: {e}");
                set_scan_state(
                    &bg.db,
                    "last_music_report",
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

    fn ep(id: i64, season: i64, episode: i64) -> (i64, i64, i64, String) {
        (id, season, episode, format!("/lib/s{season}e{episode}.mkv"))
    }

    #[test]
    fn continue_episode_is_first_uncompleted_not_just_in_progress() {
        let eps = [ep(101, 1, 1), ep(102, 1, 2), ep(103, 1, 3)];
        // Regression: just finished E1 & E2 (completed), E3 fresh (no watch row).
        // The old `position_secs > 0` logic warmed E1; the continue episode is E3.
        assert_eq!(continue_episode_index(&eps, &[101, 102]), 2);
        // Mid-episode resume: E2 in progress (not completed) → E2.
        assert_eq!(continue_episode_index(&eps, &[101]), 1);
        // No history → the first downloaded.
        assert_eq!(continue_episode_index(&eps, &[]), 0);
        // Whole show completed → fall back to the first (rewatch from the top).
        assert_eq!(continue_episode_index(&eps, &[101, 102, 103]), 0);
    }

    async fn test_state() -> AppState {
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
    async fn test_state_enforce(secret: &str) -> AppState {
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

    /// GET/DELETE/etc. with an empty body.
    fn req(method: &str, uri: impl AsRef<str>) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method(method)
            .uri(uri.as_ref())
            .body(Body::empty())
            .unwrap()
    }

    /// Method + JSON body (sets content-type: application/json).
    fn json_req(method: &str, uri: impl AsRef<str>, body: impl Into<String>) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method(method)
            .uri(uri.as_ref())
            .header("content-type", "application/json")
            .body(Body::from(body.into()))
            .unwrap()
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
        let resp = app.oneshot(req("GET", "/api/media/movies")).await.unwrap();
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
            .oneshot(req("GET", "/api/media/movies/9999"))
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
            .oneshot(req("GET", format!("/api/media/shows/{show_id}/episodes")))
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
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                json!({
                    "media_kind": "movie",
                    "media_id": movie_id,
                    "position_secs": 120,
                    "duration_secs": 3600,
                    "completed": false
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(post.status(), StatusCode::OK);

        let get = app
            .oneshot(req("GET", "/api/media/watch?sub=plex:1"))
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
    async fn playlist_crud_ordering_and_reorder() {
        let state = test_state().await;
        let f1 = seed_media_file(&state, "/lib/p1.mp4").await;
        let f2 = seed_media_file(&state, "/lib/p2.mp4").await;
        let m1 = seed_movie_for_file(&state, f1).await;
        let m2 = seed_movie_for_file(&state, f2).await;
        let app = crate::build_router(state);

        let created = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/playlists?sub=plex:1",
                json!({ "name": "Friday Night" }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let pid = body_json(created).await["id"].as_i64().unwrap();

        for m in [m1, m2] {
            let add = app
                .clone()
                .oneshot(json_req(
                    "POST",
                    format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                    json!({ "media_kind": "movie", "media_id": m }).to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(add.status(), StatusCode::OK);
        }

        let detail = app
            .clone()
            .oneshot(req("GET", format!("/api/media/playlists/{pid}?sub=plex:1")))
            .await
            .unwrap();
        let v = body_json(detail).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        // Insertion order preserved, and enrichment carries the movie title.
        assert_eq!(items[0]["media_id"], m1);
        assert_eq!(items[1]["media_id"], m2);
        assert!(items[0]["title"].is_string());

        // Full reorder: reversed body order becomes the new positions.
        let reorder = app
            .clone()
            .oneshot(json_req(
                "PUT",
                format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                json!({ "items": [
                    { "media_kind": "movie", "media_id": m2 },
                    { "media_kind": "movie", "media_id": m1 },
                ]})
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(reorder.status(), StatusCode::OK);
        let v = body_json(
            app.clone()
                .oneshot(req("GET", format!("/api/media/playlists/{pid}?sub=plex:1")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(v["items"][0]["media_id"], m2);

        // Partial reorder must be rejected (positions could collide).
        let partial = app
            .clone()
            .oneshot(json_req(
                "PUT",
                format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                json!({ "items": [{ "media_kind": "movie", "media_id": m1 }] }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(partial.status(), StatusCode::BAD_REQUEST);

        // Remove one item, then delete the playlist entirely.
        let remove = app
            .clone()
            .oneshot(req(
                "DELETE",
                format!(
                    "/api/media/playlists/{pid}/items?sub=plex:1&media_kind=movie&media_id={m1}"
                ),
            ))
            .await
            .unwrap();
        assert_eq!(remove.status(), StatusCode::OK);
        let del = app
            .clone()
            .oneshot(req(
                "DELETE",
                format!("/api/media/playlists/{pid}?sub=plex:1"),
            ))
            .await
            .unwrap();
        assert_eq!(del.status(), StatusCode::OK);
        let gone = app
            .oneshot(req("GET", format!("/api/media/playlists/{pid}?sub=plex:1")))
            .await
            .unwrap();
        assert_eq!(gone.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn playlists_are_scoped_per_user() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let created = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/playlists?sub=plex:owner",
                json!({ "name": "Mine" }).to_string(),
            ))
            .await
            .unwrap();
        let pid = body_json(created).await["id"].as_i64().unwrap();

        // Another user neither lists nor reads nor deletes it.
        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/playlists?sub=plex:other"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["items"].as_array().unwrap().len(), 0);
        let read = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/playlists/{pid}?sub=plex:other"),
            ))
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::NOT_FOUND);
        let del = app
            .oneshot(req(
                "DELETE",
                format!("/api/media/playlists/{pid}?sub=plex:other"),
            ))
            .await
            .unwrap();
        assert_eq!(del.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn playlist_item_validation_rejects_bad_refs() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let pid = body_json(
            app.clone()
                .oneshot(json_req(
                    "POST",
                    "/api/media/playlists?sub=plex:1",
                    json!({ "name": "Checks" }).to_string(),
                ))
                .await
                .unwrap(),
        )
        .await["id"]
            .as_i64()
            .unwrap();

        // 'show' is a collection kind, not a playlist kind → 400.
        let bad_kind = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                json!({ "media_kind": "show", "media_id": 1 }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(bad_kind.status(), StatusCode::BAD_REQUEST);

        // Known kind, nonexistent id → 404.
        let bad_id = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                json!({ "media_kind": "movie", "media_id": 9999 }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(bad_id.status(), StatusCode::NOT_FOUND);

        // Duplicate playlist name for the same user → 400.
        let dup = app
            .oneshot(json_req(
                "POST",
                "/api/media/playlists?sub=plex:1",
                json!({ "name": "Checks" }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(dup.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn collection_round_trips_with_show_enrichment() {
        let state = test_state().await;
        let f = seed_media_file(&state, "/lib/c1.mp4").await;
        let movie_id = seed_movie_for_file(&state, f).await;
        let show_id: i64 =
            sqlx::query("INSERT INTO shows (title, added_at, poster_path) VALUES (?, ?, ?)")
                .bind("Show Piece")
                .bind("2026-01-01T00:00:00Z")
                .bind("/poster.jpg")
                .execute(&state.db.pool)
                .await
                .unwrap()
                .last_insert_rowid();
        let app = crate::build_router(state);

        let cid = body_json(
            app.clone()
                .oneshot(json_req(
                    "POST",
                    "/api/media/collections?sub=plex:1",
                    json!({ "name": "Favorites" }).to_string(),
                ))
                .await
                .unwrap(),
        )
        .await["id"]
            .as_i64()
            .unwrap();

        for (kind, id) in [("movie", movie_id), ("show", show_id)] {
            let add = app
                .clone()
                .oneshot(json_req(
                    "POST",
                    format!("/api/media/collections/{cid}/items?sub=plex:1"),
                    json!({ "media_kind": kind, "media_id": id }).to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(add.status(), StatusCode::OK);
        }

        let v = body_json(
            app.clone()
                .oneshot(req(
                    "GET",
                    format!("/api/media/collections/{cid}?sub=plex:1"),
                ))
                .await
                .unwrap(),
        )
        .await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let show_item = items
            .iter()
            .find(|i| i["media_kind"] == "show")
            .expect("show item present");
        assert_eq!(show_item["title"], "Show Piece");
        assert_eq!(show_item["poster_path"], "/poster.jpg");

        // Episodes are not a collection kind → 400.
        let bad = app
            .oneshot(json_req(
                "POST",
                format!("/api/media/collections/{cid}/items?sub=plex:1"),
                json!({ "media_kind": "episode", "media_id": 1 }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    }

    /// Off-mode state with the subtitle store pointed at a temp dir.
    async fn test_state_subtitles(dir: &std::path::Path) -> AppState {
        let state = test_state().await;
        let mut config = (*state.config).clone();
        config.subtitles_dir = dir.to_path_buf();
        AppState {
            config: Arc::new(config),
            ..state
        }
    }

    #[tokio::test]
    async fn watch_state_accepts_track_kind() {
        // Migration 0007 widened the kind CHECK; per-track resume must round-trip.
        let state = test_state().await;
        let (_, _, track_id) =
            seed_track(&state, "Artist", "Album", "Song", 1, "/music/a.flac").await;
        let app = crate::build_router(state);
        let post = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                json!({
                    "media_kind": "track",
                    "media_id": track_id,
                    "position_secs": 42,
                    "duration_secs": 200,
                    "completed": false
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(post.status(), StatusCode::OK);
        let v = body_json(
            app.oneshot(req("GET", "/api/media/watch?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(v["items"][0]["media_kind"], "track");
        assert_eq!(v["items"][0]["position_secs"], 42);
    }

    #[tokio::test]
    async fn photos_list_and_file_round_trip() {
        let state = test_state().await;
        let tmp = tempfile::tempdir().unwrap();
        let photo_path = tmp.path().join("sunset.jpg");
        std::fs::write(&photo_path, b"jpegish-bytes").unwrap();
        sqlx::query(
            "INSERT INTO photos (path, size_bytes, mtime, width, height, taken_at, scanned_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(photo_path.to_str().unwrap())
        .bind(13_i64)
        .bind("2026-01-01T00:00:00Z")
        .bind(4032_i64)
        .bind(3024_i64)
        .bind("2025-12-25T10:00:00")
        .bind("2026-01-01T00:00:00Z")
        .execute(&state.db.pool)
        .await
        .unwrap();
        let app = crate::build_router(state);

        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/photos?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["total"], 1);
        let id = list["items"][0]["id"].as_i64().unwrap();
        assert_eq!(list["items"][0]["taken_at"], "2025-12-25T10:00:00");

        // photo_roots is empty in tests → containment skipped → file serves.
        let file = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/photos/{id}/file?sub=plex:1"),
            ))
            .await
            .unwrap();
        assert_eq!(file.status(), StatusCode::OK);
        assert_eq!(
            file.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "image/jpeg"
        );

        let missing = app
            .oneshot(req("GET", "/api/media/photos/9999/file?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn audiobooks_list_and_detail_with_chapters() {
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/books/dispossessed.m4b").await;
        sqlx::query(
            "INSERT INTO audiobooks (media_file_id, author, title, duration_secs, chapters_json) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(file_id)
        .bind("Le Guin")
        .bind("The Dispossessed")
        .bind(41_000_i64)
        .bind(r#"[{"title":"Chapter 1","start_secs":0,"end_secs":1800}]"#)
        .execute(&state.db.pool)
        .await
        .unwrap();
        let app = crate::build_router(state);

        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/audiobooks?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["total"], 1);
        let id = list["items"][0]["id"].as_i64().unwrap();
        assert_eq!(list["items"][0]["author"], "Le Guin");

        let detail = body_json(
            app.clone()
                .oneshot(req("GET", format!("/api/media/audiobooks/{id}?sub=plex:1")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(detail["chapters"][0]["title"], "Chapter 1");
        assert_eq!(
            detail["streamUrl"],
            format!("/api/media/stream/audiobook/{id}")
        );

        // The grant path treats an audiobook as direct-play audio.
        let grant = body_json(
            app.oneshot(json_req(
                "POST",
                format!("/api/media/play/audiobook/{id}/grant?sub=plex:1"),
                "{}",
            ))
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(grant["directPlay"], true);
    }

    #[tokio::test]
    async fn album_art_lists_and_serves_within_roots() {
        let tmp = tempfile::tempdir().unwrap();
        // State whose artwork dir IS the temp dir, so containment passes.
        let base = test_state().await;
        let mut config = (*base.config).clone();
        config.artwork_dir = tmp.path().to_path_buf();
        let state = AppState {
            config: Arc::new(config),
            ..base
        };

        let (_, album_id, _) =
            seed_track(&state, "Ghost", "Haunt", "Intro", 1, "/music/haunt/01.flac").await;
        let art = tmp.path().join("album_art.jpg");
        std::fs::write(&art, b"jpeg-bytes").unwrap();
        sqlx::query("UPDATE albums SET art_path = ? WHERE id = ?")
            .bind(art.to_str().unwrap())
            .bind(album_id)
            .execute(&state.db.pool)
            .await
            .unwrap();
        let app = crate::build_router(state);

        // Listing carries the art_url for decorated albums.
        let albums = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/music/albums?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            albums["items"][0]["art_url"],
            format!("/api/media/music/albums/{album_id}/art")
        );

        let art_resp = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/music/albums/{album_id}/art?sub=plex:1"),
            ))
            .await
            .unwrap();
        assert_eq!(art_resp.status(), StatusCode::OK);
        assert_eq!(
            art_resp
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "image/jpeg"
        );

        // An artless album (or unknown id) → 404.
        let missing = app
            .oneshot(req("GET", "/api/media/music/albums/9999/art?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn podcast_endpoints_validate_without_network() {
        let state = test_state().await;
        let app = crate::build_router(state);

        // Empty list to start.
        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/podcasts?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["items"].as_array().unwrap().len(), 0);

        // Non-http(s) scheme is rejected before any fetch.
        let bad = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/podcasts?sub=plex:1",
                json!({ "feed_url": "file:///etc/passwd" }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);

        // Episodes of an unknown podcast → 404; deleting one → 404.
        let eps = app
            .clone()
            .oneshot(req("GET", "/api/media/podcasts/42/episodes?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(eps.status(), StatusCode::NOT_FOUND);
        let del = app
            .oneshot(req("DELETE", "/api/media/podcasts/42?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(del.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn subtitle_endpoints_gate_on_unconfigured_features() {
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/subgate.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        let app = crate::build_router(state);

        // No OPENSUBTITLES_API_KEY → 503 feature-disabled (not 500).
        let dl = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/subtitles/movie/{movie_id}/download?sub=plex:1"),
                json!({ "language": "en" }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(dl.status(), StatusCode::SERVICE_UNAVAILABLE);
        let v = body_json(dl).await;
        assert!(
            v["error"].as_str().unwrap().contains("OPENSUBTITLES"),
            "{v}"
        );

        // No WHISPER_BIN → 503 feature-disabled.
        let tr = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/subtitles/movie/{movie_id}/transcribe?sub=plex:1"),
                json!({}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(tr.status(), StatusCode::SERVICE_UNAVAILABLE);

        // Unknown kind → 400; unknown id → 404 (would first need the key, so
        // exercise via the list endpoint which needs no config).
        let bad_kind = app
            .clone()
            .oneshot(req("GET", "/api/media/subtitles/song/1?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(bad_kind.status(), StatusCode::BAD_REQUEST);

        // Status starts idle.
        let status = app
            .oneshot(req("GET", "/api/media/subtitles/status?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);
        assert!(body_json(status).await["job"].is_null());
    }

    #[tokio::test]
    async fn subtitle_store_lists_and_serves_vtt() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state_subtitles(tmp.path()).await;
        let file_id = seed_media_file(&state, "/lib/substore.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        std::fs::write(
            tmp.path().join(format!("movie_{movie_id}_en_os.vtt")),
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n",
        )
        .unwrap();
        let app = crate::build_router(state);

        let list = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/subtitles/movie/{movie_id}?sub=plex:1"),
            ))
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::OK);
        let v = body_json(list).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["language"], "en");
        assert_eq!(items[0]["source"], "os");

        let file = app
            .clone()
            .oneshot(req(
                "GET",
                format!(
                    "/api/media/subtitles/movie/{movie_id}/file?sub=plex:1&language=en&source=os"
                ),
            ))
            .await
            .unwrap();
        assert_eq!(file.status(), StatusCode::OK);
        assert_eq!(
            file.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "text/vtt; charset=utf-8"
        );

        // Absent language → 404; traversal-shaped tokens sanitize to a name
        // that simply does not exist (never an escape).
        let missing = app
            .oneshot(req(
                "GET",
                format!(
                    "/api/media/subtitles/movie/{movie_id}/file?sub=plex:1&language=..%2F..&source=os"
                ),
            ))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    /// Seed one artist → album → track backed by a fresh media_files row.
    /// Returns `(artist_id, album_id, track_id)`.
    async fn seed_track(
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

    #[tokio::test]
    async fn music_list_endpoints_return_expected_shapes() {
        let state = test_state().await;
        let (artist_id, album_id, _t1) = seed_track(
            &state,
            "Miles Davis",
            "Kind of Blue",
            "So What",
            1,
            "/music/a1.flac",
        )
        .await;
        seed_track(
            &state,
            "Miles Davis",
            "Kind of Blue",
            "Freddie Freeloader",
            2,
            "/music/a2.flac",
        )
        .await;
        // A second artist, so artist filtering is exercised.
        seed_track(
            &state,
            "John Coltrane",
            "Giant Steps",
            "Giant Steps",
            1,
            "/music/b1.flac",
        )
        .await;

        let app = crate::build_router(state);

        // Artists: {id, name, album_count}, total.
        let resp = app
            .clone()
            .oneshot(req("GET", "/api/media/music/artists"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 2);
        let artists = v["items"].as_array().unwrap();
        assert_eq!(artists.len(), 2);
        // Ordered by name → Coltrane, then Davis.
        assert_eq!(artists[0]["name"], "John Coltrane");
        assert_eq!(artists[0]["album_count"], 1);
        assert_eq!(artists[1]["name"], "Miles Davis");
        assert_eq!(artists[1]["album_count"], 1);

        // Albums filtered by artist: {id, artist_id, artist_name, title, year, track_count}.
        let resp = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/music/albums?artist_id={artist_id}"),
            ))
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["total"], 1);
        let album = &v["items"][0];
        assert_eq!(album["id"], album_id);
        assert_eq!(album["artist_id"], artist_id);
        assert_eq!(album["artist_name"], "Miles Davis");
        assert_eq!(album["title"], "Kind of Blue");
        assert_eq!(album["year"], 2020);
        assert_eq!(album["track_count"], 2);

        // Tracks filtered by album: {id, album_id, title, track_no, duration_secs}, ordered by track_no.
        let resp = app
            .oneshot(req(
                "GET",
                format!("/api/media/music/tracks?album_id={album_id}"),
            ))
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["total"], 2);
        let tracks = v["items"].as_array().unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0]["track_no"], 1);
        assert_eq!(tracks[0]["title"], "So What");
        assert_eq!(tracks[0]["album_id"], album_id);
        assert_eq!(tracks[0]["duration_secs"], 200);
        assert_eq!(tracks[1]["track_no"], 2);
        assert_eq!(tracks[1]["title"], "Freddie Freeloader");
    }

    #[tokio::test]
    async fn play_grant_track_is_always_direct_play() {
        // A track grant must report directPlay:true (audio is never transcoded),
        // regardless of container, and hand back the media stream URL.
        let state = test_state().await;
        let (_a, _al, track_id) =
            seed_track(&state, "Artist", "Album", "Song", 1, "/music/song.flac").await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(req(
                "POST",
                format!("/api/media/play/track/{track_id}/grant"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["directPlay"], true);
        assert_eq!(v["transcoderRequired"], false);
        assert_eq!(
            v["streamUrl"],
            format!("/api/media/stream/track/{track_id}")
        );
    }

    #[tokio::test]
    async fn play_grant_unknown_track_is_404() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(req("POST", "/api/media/play/track/9999/grant"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn validate_marker_rules() {
        let mk = |mt: &str, start: i64, end: i64, source: Option<&str>| MarkerUpsert {
            media_kind: "movie".into(),
            media_id: 1,
            marker_type: mt.into(),
            start_secs: start,
            end_secs: end,
            source: source.map(|s| s.to_string()),
        };
        assert!(validate_marker(&mk("intro", 0, 90, None)).is_none());
        assert!(validate_marker(&mk("credits", 3000, 3300, Some("detected"))).is_none());
        assert!(validate_marker(&mk("bogus", 0, 90, None)).is_some());
        assert!(validate_marker(&mk("intro", 90, 90, None)).is_some()); // end <= start
        assert!(validate_marker(&mk("intro", -1, 90, None)).is_some()); // start < 0
        assert!(validate_marker(&mk("intro", 0, 90, Some("weird"))).is_some());
    }

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
    async fn markers_round_trip() {
        // §M6: title-scoped intro/credits markers. test_state is Off mode, so the
        // admin gate allows and we exercise the upsert/get/delete path end-to-end.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/marker.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        let app = crate::build_router(state);

        let put = |kind: &str, start: i64, end: i64| {
            app.clone().oneshot(json_req(
                "PUT",
                "/api/media/markers",
                json!({
                    "media_kind": "movie",
                    "media_id": movie_id,
                    "marker_type": kind,
                    "start_secs": start,
                    "end_secs": end
                })
                .to_string(),
            ))
        };

        assert_eq!(put("intro", 0, 90).await.unwrap().status(), StatusCode::OK);
        assert_eq!(
            put("credits", 3000, 3300).await.unwrap().status(),
            StatusCode::OK
        );

        let get = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/markers?media_kind=movie&media_id={movie_id}"),
            ))
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        let v = body_json(get).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        // credits sorts before intro alphabetically.
        assert_eq!(items[0]["marker_type"], "credits");
        assert_eq!(items[1]["marker_type"], "intro");
        assert_eq!(items[1]["start_secs"], 0);
        assert_eq!(items[1]["end_secs"], 90);

        // Upsert overwrites the existing intro span.
        assert_eq!(put("intro", 5, 100).await.unwrap().status(), StatusCode::OK);

        // Unknown media_id → 404.
        let put404 = app
            .clone()
            .oneshot(json_req(
                "PUT",
                "/api/media/markers",
                json!({
                    "media_kind": "movie",
                    "media_id": 9999,
                    "marker_type": "intro",
                    "start_secs": 0,
                    "end_secs": 90
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(put404.status(), StatusCode::NOT_FOUND);

        // Delete the intro marker.
        let del = app
            .clone()
            .oneshot(req(
                "DELETE",
                format!(
                    "/api/media/markers?media_kind=movie&media_id={movie_id}&marker_type=intro"
                ),
            ))
            .await
            .unwrap();
        assert_eq!(del.status(), StatusCode::OK);

        let get2 = app
            .oneshot(req(
                "GET",
                format!("/api/media/markers?media_kind=movie&media_id={movie_id}"),
            ))
            .await
            .unwrap();
        let v2 = body_json(get2).await;
        assert_eq!(v2["items"].as_array().unwrap().len(), 1); // only credits remains
    }

    #[tokio::test]
    async fn post_watch_rejects_unknown_media_id() {
        // §7-8: posting watch-state for a nonexistent title must 404, not
        // silently create an orphan row.
        let state = test_state().await;
        let app = crate::build_router(state.clone());
        let resp = app
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                json!({
                    "media_kind": "movie",
                    "media_id": 9999,
                    "position_secs": 10,
                    "completed": false
                })
                .to_string(),
            ))
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
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                json!({
                    "media_kind": "playlist",
                    "media_id": 1,
                    "position_secs": 10,
                    "completed": false
                })
                .to_string(),
            ))
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
            .oneshot(req("GET", format!("/api/media/stream/movie/{movie_id}")))
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
            .oneshot(req("GET", "/api/media/episodes"))
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
            .oneshot(req("GET", "/api/media/episodes?limit=1"))
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
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
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
                req(
                    "GET",
                    format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_bitrate=10000000"
                    ),
                ),
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
                req(
                    "GET",
                    format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_height=1080"
                    ),
                ),
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
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
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
                req(
                    "GET",
                    format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1&start_secs=95"
                    ),
                ),
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
                req(
                    "GET",
                    format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_height=1080&start_secs=42&force_transcode=true"
                    ),
                ),
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
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
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
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
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
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
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
            .oneshot(req("POST", "/api/media/scan"))
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
                .oneshot(req("GET", "/api/media/scan/status"))
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
        let resp = app.oneshot(req("POST", "/api/media/scan")).await.unwrap();
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
        let resp = app.oneshot(req("POST", "/api/media/scan")).await.unwrap();
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
