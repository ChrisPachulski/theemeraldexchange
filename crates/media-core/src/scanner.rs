//! Library scanner. Walks the configured roots, probes new/changed files
//! with ffprobe, classifies them via `filename::parse_filename`, and upserts
//! `media_files` + `movies`/`shows`/`episodes`.
//!
//! OWNER: agent B. Implement `scan_once`. Use `walkdir` to enumerate video
//! files (mkv, mp4, m4v, mov, avi, ts, webm). Skip files already present
//! with an unchanged `(path, size_bytes, mtime)` — reprobing is the slow
//! part. For new/changed files: probe → insert/replace `media_files` →
//! classify name → upsert into `movies` or `shows`+`episodes`. TMDB enrich
//! is best-effort and must never fail the scan. Return a [`ScanReport`].
//! Target: a 100-file fixture library scans in < 5s (§ success criteria).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use walkdir::WalkDir;

use crate::config::LibraryRoot;
use crate::db::Db;
use crate::error::AppError;
use crate::filename::{self, ParsedName};
use crate::models::FileProbe;
use crate::probe;
use crate::tmdb::{TmdbClient, TmdbEpisode, TmdbMatch};

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ScanReport {
    pub files_seen: usize,
    pub files_added: usize,
    pub files_updated: usize,
    pub movies: usize,
    pub episodes: usize,
    pub enriched: usize,
    /// Unchanged files whose movie/episode row still lacked TMDB metadata and
    /// was successfully backfilled this pass (no reprobe).
    pub backfilled: usize,
    pub errors: usize,
}

/// One candidate video file collected by the blocking walk phase.
struct WalkedFile {
    root_kind: crate::filename::RootKind,
    path: std::path::PathBuf,
    path_str: String,
    name: String,
    size_bytes: i64,
    mtime: String,
}

/// Result of enumerating all roots: the candidate files plus the
/// `files_seen`/`errors` accounting accumulated during the walk.
struct WalkOutcome {
    files: Vec<WalkedFile>,
    files_seen: usize,
    errors: usize,
}

/// Enumerate every video file under `roots`. Pure blocking FS work (WalkDir +
/// stat) — must run inside `spawn_blocking`, never directly on the async
/// runtime where it would starve other tasks for the duration of a large walk.
fn walk_roots(roots: &[LibraryRoot]) -> WalkOutcome {
    let mut out = WalkOutcome {
        files: Vec::new(),
        files_seen: 0,
        errors: 0,
    };

    for root in roots {
        let root_kind = root.kind;
        for entry in WalkDir::new(&root.path).follow_links(true) {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("walk error under {}: {e}", root.path.display());
                    out.errors += 1;
                    continue;
                }
            };

            if !entry.file_type().is_file() {
                continue;
            }

            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !is_video_file(&name) {
                continue;
            }

            let entry_path = entry.path();
            let path_str = match entry_path.to_str() {
                Some(p) => p.to_string(),
                None => {
                    tracing::warn!("non-utf8 path skipped: {}", entry_path.display());
                    out.errors += 1;
                    continue;
                }
            };

            out.files_seen += 1;

            let (size_bytes, mtime) = match file_stat(entry_path) {
                Ok(stat) => stat,
                Err(e) => {
                    tracing::warn!("stat failed for {path_str}: {e}");
                    out.errors += 1;
                    continue;
                }
            };

            out.files.push(WalkedFile {
                root_kind,
                path: entry_path.to_path_buf(),
                path_str,
                name,
                size_bytes,
                mtime,
            });
        }
    }

    out
}

/// Run one full scan pass over `roots`, mutating `db`. The current root's
/// [`RootKind`](crate::filename::RootKind) is authoritative for classification,
/// and `tmdb` is consulted best-effort for enrichment (never fails the scan).
pub async fn scan_once(
    db: &Db,
    roots: &[LibraryRoot],
    tmdb: &TmdbClient,
) -> Result<ScanReport, AppError> {
    let mut report = ScanReport::default();

    // The walk + per-file stat is blocking FS I/O; run it off the runtime.
    let roots_owned = roots.to_vec();
    let walk = tokio::task::spawn_blocking(move || walk_roots(&roots_owned))
        .await
        .map_err(|e| AppError::Internal(format!("walk task failed: {e}")))?;
    report.files_seen = walk.files_seen;
    report.errors = walk.errors;

    for file in &walk.files {
        let path_str = &file.path_str;
        // Skip reprobing unchanged files — probing is the slow path. But an
        // unchanged file whose movie/episode row was indexed before TMDB
        // enrichment existed still carries NULL metadata forever, since the
        // old skip just `continue`d. Run a probe-free backfill: classify the
        // name and, only when the row is missing metadata, hit TMDB and
        // upsert against the already-stored file. Files that are already
        // enriched do zero network work.
        match existing_stat(db, path_str).await {
            Ok(Some((prev_size, prev_mtime)))
                if prev_size == file.size_bytes && prev_mtime == file.mtime =>
            {
                let parsed = filename::classify(file.root_kind, &file.path, &file.name);
                match backfill_metadata(db, path_str, &parsed, tmdb).await {
                    Ok(true) => report.backfilled += 1,
                    Ok(false) => {}
                    Err(e) => {
                        tracing::warn!("backfill failed for {path_str}: {e}");
                        report.errors += 1;
                    }
                }
                continue;
            }
            Ok(existing) => {
                let is_update = existing.is_some();
                let probe_result = probe::ffprobe(&file.path).await;
                let probed = match probe_result {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("ffprobe failed for {path_str}: {e}");
                        report.errors += 1;
                        continue;
                    }
                };
                let parsed = filename::classify(file.root_kind, &file.path, &file.name);
                match index_file(
                    db,
                    path_str,
                    file.size_bytes,
                    &file.mtime,
                    &probed,
                    &parsed,
                    tmdb,
                )
                .await
                {
                    Ok(enriched) => {
                        if is_update {
                            report.files_updated += 1;
                        } else {
                            report.files_added += 1;
                        }
                        if enriched {
                            report.enriched += 1;
                        }
                        match parsed {
                            ParsedName::Movie { .. } => report.movies += 1,
                            ParsedName::Episode { .. } => report.episodes += 1,
                            ParsedName::Unknown => {}
                        }
                    }
                    Err(e) => {
                        tracing::warn!("index failed for {path_str}: {e}");
                        report.errors += 1;
                    }
                }
            }
            Err(e) => {
                tracing::warn!("lookup failed for {path_str}: {e}");
                report.errors += 1;
            }
        }
    }

    Ok(report)
}

/// Run [`scan_once`] on its own spawned task so a panic anywhere in the pass
/// (e.g. a pathological filename) surfaces as an `Err` instead of unwinding
/// the caller — the `scanning` guard in `run_guarded_scan`/`trigger_scan` then
/// always resets rather than wedging every future scan behind a stale flag.
pub async fn scan_once_isolated(
    db: Db,
    roots: Vec<LibraryRoot>,
    tmdb: TmdbClient,
) -> Result<ScanReport, AppError> {
    join_scan(tokio::spawn(async move {
        scan_once(&db, &roots, &tmdb).await
    }))
    .await
}

/// Map a scan task's `JoinError` (panic or cancellation) onto the normal
/// error path so callers' cleanup always runs.
async fn join_scan(
    handle: tokio::task::JoinHandle<Result<ScanReport, AppError>>,
) -> Result<ScanReport, AppError> {
    match handle.await {
        Ok(result) => result,
        Err(e) => Err(AppError::Internal(format!("scan task panicked: {e}"))),
    }
}

/// Read `(size_bytes, mtime_rfc3339)` from the filesystem.
fn file_stat(path: &Path) -> Result<(i64, String), std::io::Error> {
    let meta = std::fs::metadata(path)?;
    let size_bytes = meta.len() as i64;
    let modified = meta.modified()?;
    Ok((size_bytes, system_time_to_rfc3339(modified)))
}

/// Format a `SystemTime` as an RFC3339 / ISO-8601 UTC timestamp.
fn system_time_to_rfc3339(t: SystemTime) -> String {
    let dt: DateTime<Utc> = match t.duration_since(UNIX_EPOCH) {
        Ok(d) => DateTime::<Utc>::from_timestamp(d.as_secs() as i64, d.subsec_nanos())
            .unwrap_or_else(Utc::now),
        Err(_) => Utc::now(),
    };
    dt.to_rfc3339()
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

/// The `video_height` recorded for a media file, if any. Used to pick the
/// higher-resolution file when two rips back the same episode.
async fn file_video_height(db: &Db, file_id: i64) -> Result<Option<i64>, AppError> {
    let row: Option<Option<i64>> =
        sqlx::query_scalar("SELECT video_height FROM media_files WHERE id = ?")
            .bind(file_id)
            .fetch_optional(&db.pool)
            .await?;
    Ok(row.flatten())
}

/// Current `(size_bytes, mtime)` stored for `path`, if any.
async fn existing_stat(db: &Db, path: &str) -> Result<Option<(i64, String)>, AppError> {
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT size_bytes, mtime FROM media_files WHERE path = ?")
            .bind(path)
            .fetch_optional(&db.pool)
            .await?;
    Ok(row)
}

/// Upsert one media file plus its `movies`/`shows`/`episodes` rows. Returns
/// `true` when TMDB enrichment found a match for this file.
///
/// `media_files` is keyed on the UNIQUE `path`; the upsert MUST be
/// `ON CONFLICT(path) DO UPDATE` and never `INSERT OR REPLACE` — REPLACE
/// deletes the conflicting row first, which cascades through
/// `movies.file_id`/`episodes.file_id` (ON DELETE CASCADE), reissues new
/// autoincrement movie/episode ids, and silently orphans every
/// `media_watch_state` row keyed on the old ids. The stable file id then
/// drives the movie/episode upserts.
async fn index_file(
    db: &Db,
    path: &str,
    size_bytes: i64,
    mtime: &str,
    probe: &FileProbe,
    parsed: &ParsedName,
    tmdb: &TmdbClient,
) -> Result<bool, AppError> {
    let audio_json = serde_json::to_string(&probe.audio_tracks)
        .map_err(|e| AppError::Internal(format!("serialize audio tracks: {e}")))?;
    let subtitle_json = serde_json::to_string(&probe.subtitle_tracks)
        .map_err(|e| AppError::Internal(format!("serialize subtitle tracks: {e}")))?;
    let scanned_at = now_rfc3339();

    sqlx::query(
        "INSERT INTO media_files \
         (path, size_bytes, mtime, container, duration_secs, video_codec, \
          video_height, video_profile, hdr_format, audio_tracks_json, \
          subtitle_tracks_json, scanned_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(path) DO UPDATE SET \
         size_bytes = excluded.size_bytes, mtime = excluded.mtime, \
         container = excluded.container, duration_secs = excluded.duration_secs, \
         video_codec = excluded.video_codec, video_height = excluded.video_height, \
         video_profile = excluded.video_profile, hdr_format = excluded.hdr_format, \
         audio_tracks_json = excluded.audio_tracks_json, \
         subtitle_tracks_json = excluded.subtitle_tracks_json, \
         scanned_at = excluded.scanned_at",
    )
    .bind(path)
    .bind(size_bytes)
    .bind(mtime)
    .bind(&probe.container)
    .bind(probe.duration_secs)
    .bind(&probe.video_codec)
    .bind(probe.video_height)
    .bind(&probe.video_profile)
    .bind(&probe.hdr_format)
    .bind(&audio_json)
    .bind(&subtitle_json)
    .bind(&scanned_at)
    .execute(&db.pool)
    .await?;

    let file_id: i64 = sqlx::query_scalar("SELECT id FROM media_files WHERE path = ?")
        .bind(path)
        .fetch_one(&db.pool)
        .await?;

    let enriched = match parsed {
        ParsedName::Movie { title, year } => {
            // Best-effort TMDB enrichment: errors/None leave the
            // filename-derived row intact and never fail the scan.
            let m = tmdb.match_movie(title, *year).await;
            upsert_movie(db, title, *year, file_id, &scanned_at, m.as_ref()).await?;
            m.is_some()
        }
        ParsedName::Episode {
            show,
            season,
            episode,
        } => {
            let m = tmdb.match_show(show, None).await;
            let show_id = upsert_show(db, show, &scanned_at, m.as_ref()).await?;
            // Best-effort per-episode enrichment: only when the show resolved to
            // a TMDB id AND this episode is not already titled. Gating on a
            // missing title keeps a rescan from re-issuing ~20k serial TMDB
            // calls for episodes that are already enriched. Errors/None leave
            // title/air_date NULL and never fail the scan.
            let already_titled: Option<bool> = sqlx::query_scalar(
                "SELECT title IS NOT NULL FROM episodes \
                 WHERE show_id = ? AND season = ? AND episode = ?",
            )
            .bind(show_id)
            .bind(*season)
            .bind(*episode)
            .fetch_optional(&db.pool)
            .await?;
            let ep = match (m.as_ref(), already_titled) {
                (Some(found), Some(true)) => {
                    // Show resolved but the episode is already enriched: skip
                    // the per-episode round-trip, just keep the file pointer.
                    let _ = found;
                    None
                }
                (Some(found), _) => tmdb.episode(found.tmdb_id, *season, *episode).await,
                (None, _) => None,
            };
            upsert_episode(db, show_id, *season, *episode, file_id, ep.as_ref()).await?;
            m.is_some()
        }
        ParsedName::Unknown => false,
    };

    Ok(enriched)
}

/// Probe-free metadata backfill for an UNCHANGED file. Looks up the already
/// stored `media_files` id, and only when the corresponding movie/episode row
/// is still missing TMDB metadata does it consult TMDB and upsert. Returns
/// `true` when a row was actually backfilled (drives `ScanReport::backfilled`).
///
/// This is the path that repairs a library indexed before per-title/per-episode
/// enrichment existed: the unchanged-file skip used to `continue` outright, so
/// those rows would stay NULL forever. An already-enriched row short-circuits
/// before any network call, so a steady-state rescan does no TMDB work.
async fn backfill_metadata(
    db: &Db,
    path: &str,
    parsed: &ParsedName,
    tmdb: &TmdbClient,
) -> Result<bool, AppError> {
    let file_id: Option<i64> = sqlx::query_scalar("SELECT id FROM media_files WHERE path = ?")
        .bind(path)
        .fetch_optional(&db.pool)
        .await?;
    let file_id = match file_id {
        Some(id) => id,
        // No stored row to attach to (shouldn't happen for an unchanged file);
        // nothing to backfill.
        None => return Ok(false),
    };
    let scanned_at = now_rfc3339();

    match parsed {
        ParsedName::Movie { title, year } => {
            // Already enriched? A non-NULL tmdb_id means TMDB already resolved
            // this film; skip the network round-trip entirely.
            let has_meta: Option<bool> =
                sqlx::query_scalar("SELECT tmdb_id IS NOT NULL FROM movies WHERE file_id = ?")
                    .bind(file_id)
                    .fetch_optional(&db.pool)
                    .await?;
            if matches!(has_meta, Some(true)) {
                return Ok(false);
            }
            let m = tmdb.match_movie(title, *year).await;
            if m.is_none() {
                return Ok(false);
            }
            upsert_movie(db, title, *year, file_id, &scanned_at, m.as_ref()).await?;
            Ok(true)
        }
        ParsedName::Episode {
            show,
            season,
            episode,
        } => {
            let m = tmdb.match_show(show, None).await;
            let show_id = upsert_show(db, show, &scanned_at, m.as_ref()).await?;
            // Already enriched? A non-NULL episode title means the per-episode
            // fetch already landed; skip the network round-trip. (The show
            // upsert above is cheap and idempotent and may have just backfilled
            // the show's own metadata, so it always runs.)
            let has_title: Option<bool> = sqlx::query_scalar(
                "SELECT title IS NOT NULL FROM episodes \
                 WHERE show_id = ? AND season = ? AND episode = ?",
            )
            .bind(show_id)
            .bind(season)
            .bind(episode)
            .fetch_optional(&db.pool)
            .await?;
            if matches!(has_title, Some(true)) {
                return Ok(false);
            }
            let ep = match m.as_ref() {
                Some(found) => tmdb.episode(found.tmdb_id, *season, *episode).await,
                None => None,
            };
            if ep.is_none() {
                return Ok(false);
            }
            // The episode row already exists (unchanged file); reuse its file_id
            // so the quality-preference logic in upsert_episode is a no-op tie.
            let existing_file_id: Option<i64> = sqlx::query_scalar(
                "SELECT file_id FROM episodes WHERE show_id = ? AND season = ? AND episode = ?",
            )
            .bind(show_id)
            .bind(season)
            .bind(episode)
            .fetch_optional(&db.pool)
            .await?;
            let fid = existing_file_id.unwrap_or(file_id);
            upsert_episode(db, show_id, *season, *episode, fid, ep.as_ref()).await?;
            Ok(true)
        }
        ParsedName::Unknown => Ok(false),
    }
}

/// Upsert a movie keyed on its backing `file_id` (one movie per media file).
/// When a TMDB match is present, the canonical title/year are preferred and the
/// metadata columns are populated.
async fn upsert_movie(
    db: &Db,
    title: &str,
    year: Option<i64>,
    file_id: i64,
    added_at: &str,
    tmdb: Option<&TmdbMatch>,
) -> Result<(), AppError> {
    let final_title = tmdb.map(|m| m.title.as_str()).unwrap_or(title);
    let final_year = tmdb.and_then(|m| m.year).or(year);
    let tmdb_id = tmdb.map(|m| m.tmdb_id);
    let imdb_id = tmdb.and_then(|m| m.imdb_id.clone());
    let overview = tmdb.and_then(|m| m.overview.clone());
    let poster_path = tmdb.and_then(|m| m.poster_path.clone());

    // Resolve the existing row to update. A movie is identified first by its
    // TMDB id (so multiple files for one film — a 1080p and a 4K rip — collapse
    // onto a single row instead of colliding on the UNIQUE tmdb_id), then by
    // file_id (a re-scan of the same file, or a movie with no TMDB match where
    // tmdb_id is NULL and so cannot dedup by id). Mirrors `upsert_show`'s
    // norm_title dedup.
    let existing: Option<i64> = match tmdb_id {
        Some(tid) => {
            match sqlx::query_scalar::<_, i64>("SELECT id FROM movies WHERE tmdb_id = ?")
                .bind(tid)
                .fetch_optional(&db.pool)
                .await?
            {
                Some(id) => Some(id),
                None => {
                    sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
                        .bind(file_id)
                        .fetch_optional(&db.pool)
                        .await?
                }
            }
        }
        None => {
            sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
                .bind(file_id)
                .fetch_optional(&db.pool)
                .await?
        }
    };

    match existing {
        Some(id) => {
            sqlx::query(
                "UPDATE movies SET title = ?, year = ?, tmdb_id = COALESCE(?, tmdb_id), \
                 imdb_id = COALESCE(?, imdb_id), overview = COALESCE(?, overview), \
                 poster_path = COALESCE(?, poster_path) WHERE id = ?",
            )
            .bind(final_title)
            .bind(final_year)
            .bind(tmdb_id)
            .bind(&imdb_id)
            .bind(&overview)
            .bind(&poster_path)
            .bind(id)
            .execute(&db.pool)
            .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO movies \
                 (tmdb_id, imdb_id, title, year, overview, poster_path, added_at, file_id) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(tmdb_id)
            .bind(&imdb_id)
            .bind(final_title)
            .bind(final_year)
            .bind(&overview)
            .bind(&poster_path)
            .bind(added_at)
            .bind(file_id)
            .execute(&db.pool)
            .await?;
        }
    }
    Ok(())
}

/// Get-or-create a show, returning its id. A show is identified first by its
/// TMDB id (so two differently-spelled filename variants that resolve to the
/// same series — e.g. `Adventure Time` vs `Adventure Time With Finn And Jake` —
/// collapse onto a single row instead of colliding on the UNIQUE `tmdb_id`),
/// then by its NORMALIZED title (so `Adventure Time` / `Adventure Time 2008`
/// collapse even with no TMDB match). Mirrors `upsert_movie`'s tmdb_id-first
/// dedup. When a TMDB match is present, the metadata columns are populated.
async fn upsert_show(
    db: &Db,
    display_title: &str,
    added_at: &str,
    tmdb: Option<&TmdbMatch>,
) -> Result<i64, AppError> {
    let key = filename::normalize_show_name(display_title);
    let final_title = tmdb.map(|m| m.title.as_str()).unwrap_or(display_title);
    let final_year = tmdb.and_then(|m| m.year);
    let tmdb_id = tmdb.map(|m| m.tmdb_id);
    let imdb_id = tmdb.and_then(|m| m.imdb_id.clone());
    let tvdb_id = tmdb.and_then(|m| m.tvdb_id);
    let overview = tmdb.and_then(|m| m.overview.clone());
    let poster_path = tmdb.and_then(|m| m.poster_path.clone());

    // Resolve the existing row to update: prefer the TMDB id (collapses
    // descriptive-suffix aliases onto one row and avoids the UNIQUE tmdb_id
    // collision that would otherwise surface as a scan error and silently drop
    // the show), falling back to the norm_title dedup key.
    let existing: Option<i64> = match tmdb_id {
        Some(tid) => {
            match sqlx::query_scalar::<_, i64>("SELECT id FROM shows WHERE tmdb_id = ?")
                .bind(tid)
                .fetch_optional(&db.pool)
                .await?
            {
                Some(id) => Some(id),
                None => {
                    sqlx::query_scalar("SELECT id FROM shows WHERE norm_title = ?")
                        .bind(&key)
                        .fetch_optional(&db.pool)
                        .await?
                }
            }
        }
        None => {
            sqlx::query_scalar("SELECT id FROM shows WHERE norm_title = ?")
                .bind(&key)
                .fetch_optional(&db.pool)
                .await?
        }
    };

    if let Some(id) = existing {
        // Backfill metadata onto the existing row when TMDB provided it.
        if tmdb.is_some() {
            sqlx::query(
                "UPDATE shows SET tmdb_id = COALESCE(?, tmdb_id), \
                 imdb_id = COALESCE(?, imdb_id), tvdb_id = COALESCE(?, tvdb_id), \
                 year = COALESCE(?, year), overview = COALESCE(?, overview), \
                 poster_path = COALESCE(?, poster_path) WHERE id = ?",
            )
            .bind(tmdb_id)
            .bind(&imdb_id)
            .bind(tvdb_id)
            .bind(final_year)
            .bind(&overview)
            .bind(&poster_path)
            .bind(id)
            .execute(&db.pool)
            .await?;
        }
        return Ok(id);
    }

    sqlx::query(
        "INSERT INTO shows \
         (tmdb_id, imdb_id, tvdb_id, title, norm_title, year, overview, poster_path, added_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(tmdb_id)
    .bind(&imdb_id)
    .bind(tvdb_id)
    .bind(final_title)
    .bind(&key)
    .bind(final_year)
    .bind(&overview)
    .bind(&poster_path)
    .bind(added_at)
    .execute(&db.pool)
    .await?;

    let id: i64 = sqlx::query_scalar("SELECT id FROM shows WHERE norm_title = ?")
        .bind(&key)
        .fetch_one(&db.pool)
        .await?;
    Ok(id)
}

/// Upsert an episode keyed on the UNIQUE `(show_id, season, episode)`. When
/// TMDB episode metadata is present, `title`/`air_date` are populated; missing
/// fields are left untouched (COALESCE) so a later enriched scan can backfill.
///
/// Dual-version handling: when an episode already has a backing file and a
/// second file for the same `(show, season, episode)` arrives (e.g. a 1080p and
/// a 2160p rip), the higher-resolution file wins deterministically — the
/// incoming `file_id` only replaces the existing one when its `video_height` is
/// strictly greater. Mirrors the quality preference movies get via tmdb_id
/// dedup; without it, scan order alone (last-wins) decided which file streamed.
async fn upsert_episode(
    db: &Db,
    show_id: i64,
    season: i64,
    episode: i64,
    file_id: i64,
    tmdb: Option<&TmdbEpisode>,
) -> Result<(), AppError> {
    let title = tmdb.and_then(|e| e.title.clone());
    let air_date = tmdb.and_then(|e| e.air_date.clone());

    let existing: Option<(i64, i64)> = sqlx::query_as(
        "SELECT id, file_id FROM episodes WHERE show_id = ? AND season = ? AND episode = ?",
    )
    .bind(show_id)
    .bind(season)
    .bind(episode)
    .fetch_optional(&db.pool)
    .await?;

    match existing {
        Some((id, existing_file_id)) => {
            // Decide whether the incoming file should back this episode. Keep
            // the existing file unless the incoming one is higher-resolution
            // (or the incoming row IS the existing one — a plain re-scan). A
            // NULL height sorts below any known height so a probed file beats
            // an unprobed one, and ties keep the incumbent (no churn).
            let keep_incoming = if file_id == existing_file_id {
                true
            } else {
                let incoming_h: Option<i64> = file_video_height(db, file_id).await?;
                let existing_h: Option<i64> = file_video_height(db, existing_file_id).await?;
                incoming_h.unwrap_or(0) > existing_h.unwrap_or(0)
            };
            let new_file_id = if keep_incoming {
                file_id
            } else {
                existing_file_id
            };
            sqlx::query(
                "UPDATE episodes SET file_id = ?, title = COALESCE(?, title), \
                 air_date = COALESCE(?, air_date) WHERE id = ?",
            )
            .bind(new_file_id)
            .bind(&title)
            .bind(&air_date)
            .bind(id)
            .execute(&db.pool)
            .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO episodes (show_id, season, episode, title, air_date, file_id) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(show_id)
            .bind(season)
            .bind(episode)
            .bind(&title)
            .bind(&air_date)
            .bind(file_id)
            .execute(&db.pool)
            .await?;
        }
    }
    Ok(())
}

/// Video extensions the scanner considers. Shared so tests and the walker
/// agree.
pub const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "m4v", "mov", "avi", "ts", "webm"];

pub fn is_video_file(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| VIDEO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AudioTrack, SubtitleTrack};

    /// A TMDB client with no key never matches — exercises the
    /// best-effort/no-enrichment path without network access.
    fn no_tmdb() -> TmdbClient {
        TmdbClient::new(None)
    }

    fn sample_probe() -> FileProbe {
        FileProbe {
            container: Some("matroska".into()),
            duration_secs: Some(7200),
            video_codec: Some("hevc".into()),
            video_height: Some(1080),
            video_profile: Some("Main 10".into()),
            hdr_format: Some("hdr10".into()),
            audio_tracks: vec![AudioTrack {
                index: 1,
                codec: Some("eac3".into()),
                channels: Some(6),
                language: Some("eng".into()),
                title: None,
            }],
            subtitle_tracks: vec![SubtitleTrack {
                index: 2,
                codec: Some("subrip".into()),
                language: Some("eng".into()),
                title: None,
                forced: false,
            }],
        }
    }

    async fn count(db: &Db, table: &str) -> i64 {
        // Test-only helper; `table` is a hardcoded test literal. sqlx 0.9
        // requires an explicit safety assertion for non-'static SQL.
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    /// Insert a minimal `media_files` row and return its id. `episodes.file_id`
    /// is a foreign key into `media_files`, so episode upserts need a real id.
    async fn seed_media_file(db: &Db, path: &str) -> i64 {
        seed_media_file_h(db, path, 1080).await
    }

    /// Like [`seed_media_file`] but with an explicit `video_height`, for the
    /// dual-version quality-preference tests.
    async fn seed_media_file_h(db: &Db, path: &str, height: i64) -> i64 {
        sqlx::query(
            "INSERT INTO media_files \
             (path, size_bytes, mtime, container, duration_secs, video_codec, \
              video_height, video_profile, hdr_format, audio_tracks_json, \
              subtitle_tracks_json, scanned_at) \
             VALUES (?, 1, 't', 'mkv', 1, 'h264', ?, NULL, NULL, '[]', '[]', 't')",
        )
        .bind(path)
        .bind(height)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query_scalar("SELECT id FROM media_files WHERE path = ?")
            .bind(path)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn movie_indexes_media_file_and_movie_row() {
        let db = Db::connect_memory().await.unwrap();
        let parsed = ParsedName::Movie {
            title: "Blade Runner".into(),
            year: Some(1982),
        };
        index_file(
            &db,
            "/lib/Blade Runner (1982).mkv",
            1234,
            "2024-01-01T00:00:00+00:00",
            &sample_probe(),
            &parsed,
            &no_tmdb(),
        )
        .await
        .unwrap();

        assert_eq!(count(&db, "media_files").await, 1);
        assert_eq!(count(&db, "movies").await, 1);
        assert_eq!(count(&db, "shows").await, 0);
        assert_eq!(count(&db, "episodes").await, 0);

        let (title, year): (String, Option<i64>) =
            sqlx::query_as("SELECT title, year FROM movies LIMIT 1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(title, "Blade Runner");
        assert_eq!(year, Some(1982));

        // Probe fields persisted, tracks round-trip through JSON.
        let (container, codec, audio_json): (Option<String>, Option<String>, String) =
            sqlx::query_as(
                "SELECT container, video_codec, audio_tracks_json FROM media_files LIMIT 1",
            )
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(container.as_deref(), Some("matroska"));
        assert_eq!(codec.as_deref(), Some("hevc"));
        let audio: Vec<AudioTrack> = serde_json::from_str(&audio_json).unwrap();
        assert_eq!(audio.len(), 1);
        assert_eq!(audio[0].language.as_deref(), Some("eng"));
    }

    #[tokio::test]
    async fn episode_indexes_media_file_show_and_episode() {
        let db = Db::connect_memory().await.unwrap();
        let parsed = ParsedName::Episode {
            show: "The Wire".into(),
            season: 2,
            episode: 5,
        };
        index_file(
            &db,
            "/lib/The Wire - S02E05.mkv",
            42,
            "2024-02-02T00:00:00+00:00",
            &sample_probe(),
            &parsed,
            &no_tmdb(),
        )
        .await
        .unwrap();

        assert_eq!(count(&db, "media_files").await, 1);
        assert_eq!(count(&db, "shows").await, 1);
        assert_eq!(count(&db, "episodes").await, 1);
        assert_eq!(count(&db, "movies").await, 0);

        let (season, episode): (i64, i64) =
            sqlx::query_as("SELECT season, episode FROM episodes LIMIT 1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!((season, episode), (2, 5));
    }

    #[tokio::test]
    async fn reindexing_same_path_is_idempotent() {
        let db = Db::connect_memory().await.unwrap();
        let parsed = ParsedName::Movie {
            title: "Heat".into(),
            year: Some(1995),
        };
        let path = "/lib/Heat (1995).mkv";
        for _ in 0..3 {
            index_file(
                &db,
                path,
                999,
                "2024-03-03T00:00:00+00:00",
                &sample_probe(),
                &parsed,
                &no_tmdb(),
            )
            .await
            .unwrap();
        }
        assert_eq!(count(&db, "media_files").await, 1);
        assert_eq!(count(&db, "movies").await, 1);
    }

    #[tokio::test]
    async fn rescan_of_changed_file_preserves_ids_and_watch_state() {
        // Regression: index_file used INSERT OR REPLACE, which DELETEs the
        // conflicting media_files row, cascades movies/episodes (file_id ON
        // DELETE CASCADE), reissues new autoincrement ids, and orphans every
        // media_watch_state row keyed on the old ids. A size/mtime change on
        // rescan must keep the same file AND movie ids so watch state resolves.
        let db = Db::connect_memory().await.unwrap();
        let parsed = ParsedName::Movie {
            title: "Heat".into(),
            year: Some(1995),
        };
        let path = "/lib/Heat (1995).mkv";
        index_file(&db, path, 100, "t1", &sample_probe(), &parsed, &no_tmdb())
            .await
            .unwrap();
        let (file_id, movie_id): (i64, i64) =
            sqlx::query_as("SELECT file_id, id FROM movies LIMIT 1")
                .fetch_one(&db.pool)
                .await
                .unwrap();

        // Record progress against the movie, as POST /watch does.
        sqlx::query(
            "INSERT INTO media_watch_state \
             (sub, media_kind, media_id, position_secs, watched_at, completed) \
             VALUES ('plex:1', 'movie', ?, 1200, 't1', 0)",
        )
        .bind(movie_id)
        .execute(&db.pool)
        .await
        .unwrap();

        // The file changed on disk (new size + mtime) and is reindexed.
        index_file(&db, path, 200, "t2", &sample_probe(), &parsed, &no_tmdb())
            .await
            .unwrap();

        let (new_file_id, new_movie_id, size): (i64, i64, i64) = sqlx::query_as(
            "SELECT m.file_id, m.id, f.size_bytes FROM movies m \
             JOIN media_files f ON f.id = m.file_id LIMIT 1",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(new_file_id, file_id, "media_files id must be stable");
        assert_eq!(new_movie_id, movie_id, "movie id must be stable");
        assert_eq!(size, 200, "the changed stat must still be persisted");

        // The watch row still resolves to the (same) movie.
        let resumable: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM media_watch_state w \
             JOIN movies m ON m.id = w.media_id WHERE w.media_kind = 'movie'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(resumable, 1, "watch state must survive a rescan");
    }

    #[tokio::test]
    async fn two_episodes_share_one_show_row() {
        let db = Db::connect_memory().await.unwrap();
        let ep1 = ParsedName::Episode {
            show: "Fargo".into(),
            season: 1,
            episode: 1,
        };
        let ep2 = ParsedName::Episode {
            show: "Fargo".into(),
            season: 1,
            episode: 2,
        };
        index_file(
            &db,
            "/lib/Fargo S01E01.mkv",
            1,
            "t1",
            &sample_probe(),
            &ep1,
            &no_tmdb(),
        )
        .await
        .unwrap();
        index_file(
            &db,
            "/lib/Fargo S01E02.mkv",
            2,
            "t2",
            &sample_probe(),
            &ep2,
            &no_tmdb(),
        )
        .await
        .unwrap();

        assert_eq!(count(&db, "shows").await, 1);
        assert_eq!(count(&db, "episodes").await, 2);
        assert_eq!(count(&db, "media_files").await, 2);
    }

    #[tokio::test]
    async fn show_year_variants_collapse_to_one_row() {
        let db = Db::connect_memory().await.unwrap();
        let ep1 = ParsedName::Episode {
            show: "Adventure Time".into(),
            season: 1,
            episode: 1,
        };
        let ep2 = ParsedName::Episode {
            show: "Adventure Time 2008".into(),
            season: 2,
            episode: 3,
        };
        index_file(
            &db,
            "/lib/at_a.mkv",
            1,
            "t1",
            &sample_probe(),
            &ep1,
            &no_tmdb(),
        )
        .await
        .unwrap();
        index_file(
            &db,
            "/lib/at_b.mkv",
            2,
            "t2",
            &sample_probe(),
            &ep2,
            &no_tmdb(),
        )
        .await
        .unwrap();

        // Both variants normalize to one show; both episodes repointed to it.
        assert_eq!(count(&db, "shows").await, 1);
        assert_eq!(count(&db, "episodes").await, 2);
        let norm: String = sqlx::query_scalar("SELECT norm_title FROM shows LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(norm, "adventure time");
    }

    #[tokio::test]
    async fn failing_tmdb_leaves_metadata_null_without_erroring() {
        let db = Db::connect_memory().await.unwrap();
        let parsed = ParsedName::Movie {
            title: "Heat".into(),
            year: Some(1995),
        };
        // No key → no match; the row still inserts with NULL tmdb_id.
        let enriched = index_file(
            &db,
            "/lib/Heat (1995).mkv",
            1,
            "t1",
            &sample_probe(),
            &parsed,
            &no_tmdb(),
        )
        .await
        .unwrap();
        assert!(!enriched);
        let tmdb_id: Option<i64> = sqlx::query_scalar("SELECT tmdb_id FROM movies LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(tmdb_id, None);
    }

    #[tokio::test]
    async fn two_files_same_tmdb_id_collapse_to_one_movie() {
        // A library with two files for one film (e.g. a 1080p and a 4K rip)
        // resolves both to the same TMDB id. They must collapse onto a single
        // movies row rather than collide on the UNIQUE tmdb_id constraint.
        let db = Db::connect_memory().await.unwrap();

        async fn seed_file(db: &Db, path: &str) -> i64 {
            sqlx::query(
                "INSERT INTO media_files \
                 (path, size_bytes, mtime, container, duration_secs, video_codec, \
                  video_height, video_profile, hdr_format, audio_tracks_json, \
                  subtitle_tracks_json, scanned_at) \
                 VALUES (?, 1, 't', 'mkv', 1, 'h264', 1080, NULL, NULL, '[]', '[]', 't')",
            )
            .bind(path)
            .execute(&db.pool)
            .await
            .unwrap();
            sqlx::query_scalar("SELECT id FROM media_files WHERE path = ?")
                .bind(path)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        }

        let m = TmdbMatch {
            tmdb_id: 812,
            title: "Aladdin".into(),
            year: Some(2019),
            imdb_id: Some("tt6139732".into()),
            tvdb_id: None,
            overview: Some("A kindhearted street urchin...".into()),
            poster_path: Some("/poster.jpg".into()),
        };

        let f1 = seed_file(&db, "/media/Movies/Aladdin (2019)/Aladdin.1080p.mkv").await;
        let f2 = seed_file(&db, "/media/Movies/Aladdin (2019)/Aladdin.2160p.4K.mkv").await;

        // Both files enrich to the same tmdb_id; the second must not error.
        upsert_movie(&db, "Aladdin", Some(2019), f1, "t", Some(&m))
            .await
            .unwrap();
        upsert_movie(&db, "Aladdin", Some(2019), f2, "t", Some(&m))
            .await
            .unwrap();

        // One logical movie, not two; no UNIQUE collision.
        assert_eq!(count(&db, "movies").await, 1);
        let (tmdb_id, title): (Option<i64>, String) =
            sqlx::query_as("SELECT tmdb_id, title FROM movies LIMIT 1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(tmdb_id, Some(812));
        assert_eq!(title, "Aladdin");
    }

    #[tokio::test]
    async fn shows_root_unparseable_basename_yields_no_movie_row() {
        // Invariant: no media file under a Shows root ever creates a movies row.
        use crate::filename::{RootKind, classify};
        use std::path::Path;
        let db = Db::connect_memory().await.unwrap();
        let path = Path::new("/media/tv_shows/Foo/random clip.mkv");
        let parsed = classify(RootKind::Shows, path, "random clip.mkv");
        assert!(!matches!(parsed, ParsedName::Movie { .. }));
        index_file(
            &db,
            "/media/tv_shows/Foo/random clip.mkv",
            1,
            "t1",
            &sample_probe(),
            &parsed,
            &no_tmdb(),
        )
        .await
        .unwrap();
        assert_eq!(count(&db, "movies").await, 0);
    }

    #[tokio::test]
    async fn upsert_episode_binds_title_and_air_date() {
        // M8: episode title/air_date must be written when TMDB episode metadata
        // is available, not left perpetually NULL.
        let db = Db::connect_memory().await.unwrap();
        let show_id = upsert_show(&db, "Breaking Bad", "t", None).await.unwrap();
        let file_id = seed_media_file(&db, "/lib/Breaking Bad - S01E01.mkv").await;
        let ep = TmdbEpisode {
            title: Some("Pilot".into()),
            air_date: Some("2008-01-20".into()),
        };
        upsert_episode(&db, show_id, 1, 1, file_id, Some(&ep))
            .await
            .unwrap();

        let (title, air_date): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT title, air_date FROM episodes LIMIT 1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(title.as_deref(), Some("Pilot"));
        assert_eq!(air_date.as_deref(), Some("2008-01-20"));
    }

    #[tokio::test]
    async fn upsert_episode_backfills_metadata_on_reindex() {
        // A first pass with no episode metadata leaves title/air_date NULL; a
        // later enriched pass must backfill them without clobbering on missing.
        let db = Db::connect_memory().await.unwrap();
        let show_id = upsert_show(&db, "Severance", "t", None).await.unwrap();
        let file_id = seed_media_file(&db, "/lib/Severance - S01E01.mkv").await;

        upsert_episode(&db, show_id, 1, 1, file_id, None)
            .await
            .unwrap();
        let title: Option<String> = sqlx::query_scalar("SELECT title FROM episodes LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(title, None);

        let ep = TmdbEpisode {
            title: Some("Good News About Hell".into()),
            air_date: None,
        };
        upsert_episode(&db, show_id, 1, 1, file_id, Some(&ep))
            .await
            .unwrap();
        // Still exactly one row (UNIQUE upsert), now with a title backfilled.
        assert_eq!(count(&db, "episodes").await, 1);
        let title: Option<String> = sqlx::query_scalar("SELECT title FROM episodes LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(title.as_deref(), Some("Good News About Hell"));
    }

    #[tokio::test]
    async fn upsert_show_binds_tvdb_id() {
        // M8: shows.tvdb_id must be written when the TMDB external_ids response
        // carries one, instead of being discarded.
        let db = Db::connect_memory().await.unwrap();
        let m = TmdbMatch {
            tmdb_id: 1396,
            title: "Breaking Bad".into(),
            year: Some(2008),
            imdb_id: Some("tt0903747".into()),
            tvdb_id: Some(81189),
            overview: Some("A chemistry teacher...".into()),
            poster_path: Some("/bb.jpg".into()),
        };
        upsert_show(&db, "Breaking Bad", "t", Some(&m))
            .await
            .unwrap();

        let tvdb_id: Option<i64> = sqlx::query_scalar("SELECT tvdb_id FROM shows LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(tvdb_id, Some(81189));
    }

    #[tokio::test]
    async fn two_shows_same_tmdb_id_collapse_to_one_row() {
        // Two filename variants that normalize differently ("Adventure Time" vs
        // "Adventure Time With Finn And Jake") but resolve to the SAME TMDB id
        // must collapse onto one shows row, not collide on the UNIQUE tmdb_id
        // (which previously surfaced as a scan error and dropped the show).
        let db = Db::connect_memory().await.unwrap();
        let m = TmdbMatch {
            tmdb_id: 15260,
            title: "Adventure Time".into(),
            year: Some(2010),
            imdb_id: Some("tt1305826".into()),
            tvdb_id: Some(152831),
            overview: Some("Finn and Jake...".into()),
            poster_path: Some("/at.jpg".into()),
        };

        let id1 = upsert_show(&db, "Adventure Time", "t", Some(&m))
            .await
            .unwrap();
        // Different norm_title, same TMDB id — must reuse the first row.
        let id2 = upsert_show(&db, "Adventure Time With Finn And Jake", "t", Some(&m))
            .await
            .unwrap();

        assert_eq!(id1, id2, "same tmdb_id must collapse to one show id");
        assert_eq!(count(&db, "shows").await, 1);
    }

    #[tokio::test]
    async fn episodes_for_aliased_show_share_one_row_no_errors() {
        // End-to-end of the alias collapse via index_file with a fake match is
        // not possible without network, so exercise the upsert path directly:
        // two episodes whose show resolves to the same tmdb_id land under one
        // show with no UNIQUE collision.
        let db = Db::connect_memory().await.unwrap();
        let m = TmdbMatch {
            tmdb_id: 15260,
            title: "Adventure Time".into(),
            year: Some(2010),
            imdb_id: None,
            tvdb_id: None,
            overview: None,
            poster_path: None,
        };
        let s1 = upsert_show(&db, "Adventure Time", "t", Some(&m))
            .await
            .unwrap();
        let s2 = upsert_show(&db, "Adventure Time With Finn And Jake", "t", Some(&m))
            .await
            .unwrap();
        assert_eq!(s1, s2);
        let f1 = seed_media_file(&db, "/lib/at_s01e01.mkv").await;
        let f2 = seed_media_file(&db, "/lib/at_s01e02.mkv").await;
        upsert_episode(&db, s1, 1, 1, f1, None).await.unwrap();
        upsert_episode(&db, s2, 1, 2, f2, None).await.unwrap();
        assert_eq!(count(&db, "shows").await, 1);
        assert_eq!(count(&db, "episodes").await, 2);
    }

    #[tokio::test]
    async fn upsert_episode_keeps_higher_resolution_file() {
        // Dual-version: a 1080p and a 2160p rip back the same episode. The
        // higher-resolution file must win deterministically regardless of which
        // arrives second, instead of plain last-wins.
        let db = Db::connect_memory().await.unwrap();
        let show_id = upsert_show(&db, "Dune", "t", None).await.unwrap();
        let hd = seed_media_file_h(&db, "/lib/Dune S01E01 1080p.mkv", 1080).await;
        let uhd = seed_media_file_h(&db, "/lib/Dune S01E01 2160p.mkv", 2160).await;

        // 1080p first, then 2160p arrives → 2160p wins.
        upsert_episode(&db, show_id, 1, 1, hd, None).await.unwrap();
        upsert_episode(&db, show_id, 1, 1, uhd, None).await.unwrap();
        let fid: i64 = sqlx::query_scalar("SELECT file_id FROM episodes LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(fid, uhd, "higher-res file should back the episode");

        // 1080p arrives again afterward → must NOT downgrade.
        upsert_episode(&db, show_id, 1, 1, hd, None).await.unwrap();
        let fid: i64 = sqlx::query_scalar("SELECT file_id FROM episodes LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(fid, uhd, "a lower-res rescan must not downgrade the file");
        assert_eq!(count(&db, "episodes").await, 1);
    }

    #[tokio::test]
    async fn backfill_metadata_no_key_is_noop_without_error() {
        // The backfill path for an unchanged file with no TMDB key must be a
        // safe no-op: it never errors and reports nothing backfilled.
        let db = Db::connect_memory().await.unwrap();
        // Seed an unenriched movie (mirrors a pre-enrichment indexed row).
        let file_id = seed_media_file(&db, "/lib/Heat (1995).mkv").await;
        upsert_movie(&db, "Heat", Some(1995), file_id, "t", None)
            .await
            .unwrap();
        let parsed = ParsedName::Movie {
            title: "Heat".into(),
            year: Some(1995),
        };
        let did = backfill_metadata(&db, "/lib/Heat (1995).mkv", &parsed, &no_tmdb())
            .await
            .unwrap();
        assert!(!did, "no key → nothing backfilled");
        // Row untouched.
        assert_eq!(count(&db, "movies").await, 1);
    }

    #[tokio::test]
    async fn backfill_metadata_unknown_path_is_noop() {
        // An unchanged file with no stored media_files row (shouldn't happen,
        // but must not panic or error) backfills nothing.
        let db = Db::connect_memory().await.unwrap();
        let parsed = ParsedName::Episode {
            show: "Ghost".into(),
            season: 1,
            episode: 1,
        };
        let did = backfill_metadata(&db, "/lib/missing.mkv", &parsed, &no_tmdb())
            .await
            .unwrap();
        assert!(!did);
        assert_eq!(count(&db, "episodes").await, 0);
    }

    #[tokio::test]
    async fn join_scan_contains_a_panicking_task() {
        // A panic inside the scan pass must come back as a plain Err so the
        // callers' `scanning`-flag cleanup always runs (it would otherwise
        // wedge `POST /scan` at 409 forever).
        let handle = tokio::spawn(async { panic!("synthetic scan panic") });
        let err = join_scan(handle)
            .await
            .expect_err("a panicking scan task must surface as Err");
        assert!(
            err.to_string().contains("panicked"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn is_video_file_recognizes_extensions() {
        assert!(is_video_file("movie.mkv"));
        assert!(is_video_file("clip.mp4"));
        assert!(is_video_file("UPPER.MKV"));
        assert!(is_video_file("Trailer.MP4"));
        assert!(!is_video_file("subtitles.srt"));
        assert!(!is_video_file("notes.txt"));
        assert!(!is_video_file("metadata.nfo"));
        assert!(!is_video_file("noextension"));
    }

    // ── scan_once fixture harness ─────────────────────────────────────────
    //
    // These tests drive the real `scan_once` WalkDir walk end-to-end against a
    // synthetic on-disk library, locking in the documented success criterion at
    // the top of this file ("a 100-file fixture library scans in < 5s"). The
    // lower-level tests above call `index_file`/`backfill` directly and never
    // exercise the walk, the `is_video_file` filter, or the
    // `files_seen`/`errors` accounting.
    //
    // CRITICAL: `scan_once` calls `probe::ffprobe` on every NEW video file, and
    // ffprobe is a real external binary that may be absent in CI (and cannot
    // probe empty files anyway). On a probe failure the code does
    // `warn + errors += 1 + continue`. So these assertions target only
    // counters that are deterministic regardless of whether ffprobe exists:
    // `files_seen` (incremented before any probe, once per `is_video_file`
    // match) is the reliable target. We do NOT assert indexed movie/episode
    // counts, which depend on ffprobe succeeding.

    use crate::filename::RootKind;
    use tempfile::tempdir;

    /// Build a synthetic library under `dir`: `n_videos` empty video files with
    /// realistic movie/episode names cycling through `VIDEO_EXTENSIONS`, spread
    /// across nested subdirectories to prove recursion, plus `n_decoys`
    /// non-video files and an empty subdir to prove the `is_video_file` filter
    /// and the `is_file()` check exclude them.
    fn build_synthetic_library(dir: &std::path::Path, n_videos: usize, n_decoys: usize) {
        use std::fs::{File, create_dir_all};

        // A couple of nested subdirs so the walk has to recurse.
        let sub_a = dir.join("Movies");
        let sub_b = dir.join("Shows").join("Season 01");
        create_dir_all(&sub_a).unwrap();
        create_dir_all(&sub_b).unwrap();
        // An empty subdir that must be skipped (not a file).
        create_dir_all(dir.join("empty_dir")).unwrap();

        for i in 0..n_videos {
            let ext = VIDEO_EXTENSIONS[i % VIDEO_EXTENSIONS.len()];
            // Alternate movie-style and episode-style names, and alternate the
            // target subdirectory so recursion is exercised.
            let (name, target) = if i % 2 == 0 {
                (format!("Blade Runner {i} (1982).{ext}"), &sub_a)
            } else {
                let season = (i % 3) + 1;
                let episode = (i % 9) + 1;
                (format!("Show {i} S{season:02}E{episode:02}.{ext}"), &sub_b)
            };
            File::create(target.join(name)).unwrap();
        }

        // Decoys: non-video files plus a `.partial` (a video ext with a trailing
        // suffix, which must NOT match). Cycle through a few extensions.
        let decoy_exts = ["nfo", "srt", "txt", "jpg", "mkv.partial"];
        for i in 0..n_decoys {
            let ext = decoy_exts[i % decoy_exts.len()];
            File::create(sub_a.join(format!("decoy_{i}.{ext}"))).unwrap();
        }
    }

    #[tokio::test]
    async fn scan_once_walks_synthetic_library_and_counts_only_videos() {
        let tmp = tempdir().unwrap();
        build_synthetic_library(tmp.path(), 12, 8);
        let db = Db::connect_memory().await.unwrap();
        let roots = vec![LibraryRoot {
            path: tmp.path().to_path_buf(),
            kind: RootKind::Movies,
        }];
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();
        // Only the 12 video files are seen; the 8 decoys and the directories
        // (including the empty one) are filtered out before the counter. This
        // is the core, ffprobe-independent assertion.
        assert_eq!(report.files_seen, 12);
    }

    #[tokio::test]
    async fn scan_once_skips_unchanged_files_on_rescan() {
        // Proves the skip-unchanged fast path: when a media_files row already
        // matches the on-disk `(path, size_bytes, mtime)`, the scanner takes the
        // probe-FREE backfill branch and `continue`s — no ffprobe call. We
        // pre-seed rows whose path/size/mtime EXACTLY match the fixture files
        // (replicating `file_stat`'s RFC3339 mtime format), then assert the
        // first scan is all-skips: `files_seen == video count` and `errors == 0`
        // (a probe attempt on an empty file would otherwise bump `errors`).
        let tmp = tempdir().unwrap();
        build_synthetic_library(tmp.path(), 6, 3);
        let db = Db::connect_memory().await.unwrap();

        // Pre-seed a matching media_files row for every on-disk video file using
        // the SAME size + mtime the scanner will compute, so the
        // `prev_size == size_bytes && prev_mtime == mtime` skip branch fires.
        for entry in WalkDir::new(tmp.path()).follow_links(true) {
            let entry = entry.unwrap();
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_str().unwrap();
            if !is_video_file(name) {
                continue;
            }
            let path = entry.path();
            let (size_bytes, mtime) = file_stat(path).unwrap();
            sqlx::query(
                "INSERT INTO media_files \
                 (path, size_bytes, mtime, container, duration_secs, video_codec, \
                  video_height, video_profile, hdr_format, audio_tracks_json, \
                  subtitle_tracks_json, scanned_at) \
                 VALUES (?, ?, ?, 'mkv', 1, 'h264', 1080, NULL, NULL, '[]', '[]', 't')",
            )
            .bind(path.to_str().unwrap())
            .bind(size_bytes)
            .bind(&mtime)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        let roots = vec![LibraryRoot {
            path: tmp.path().to_path_buf(),
            kind: RootKind::Auto,
        }];
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();
        // Every video file matched an unchanged row, so the probe-free backfill
        // branch was taken for all of them: no ffprobe, hence no probe errors.
        assert_eq!(report.files_seen, 6);
        assert_eq!(
            report.errors, 0,
            "unchanged files must take the probe-free skip path (no ffprobe, no errors)"
        );
        // No new files were probed/indexed on this all-unchanged pass.
        assert_eq!(report.files_added, 0);
        assert_eq!(report.files_updated, 0);
    }

    #[tokio::test]
    async fn scan_once_100_file_library_under_5s() {
        // Coarse regression guard for the stated success criterion (scanner.rs
        // line 11: "a 100-file fixture library scans in < 5s"). NOT a benchmark:
        // empty files fail ffprobe fast (or ffprobe is absent), so the walk +
        // stat + lookup loop dominates and should be well under the ceiling.
        let tmp = tempdir().unwrap();
        build_synthetic_library(tmp.path(), 100, 0);
        let db = Db::connect_memory().await.unwrap();
        let roots = vec![LibraryRoot {
            path: tmp.path().to_path_buf(),
            kind: RootKind::Movies,
        }];
        let start = std::time::Instant::now();
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();
        let elapsed = start.elapsed();
        assert_eq!(report.files_seen, 100);
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "scan took {elapsed:?}"
        );
    }

    #[test]
    fn is_video_file_filters_extensions() {
        // Pins the filter behavior the harness relies on: known video
        // extensions match (case-insensitively), everything else does not.
        assert!(is_video_file("a.mkv"));
        assert!(is_video_file("A.MP4"));
        assert!(!is_video_file("a.nfo"));
        assert!(!is_video_file("noext"));
        // A trailing `.partial` suffix means the real extension is not a video
        // extension, so it must be excluded.
        assert!(!is_video_file("a.mkv.partial"));
    }

    /// Create a synthetic FLAT library of `n` video files (plus `noise`
    /// non-video sidecar files) under `root`, returning the count of video
    /// files written. Files have real bytes so `file_stat` reports a non-zero
    /// size; the probe itself is driven by the deterministic echoing stub, not
    /// these contents. Distinct from the nested-dir `build_synthetic_library`
    /// used by the scan_once harness above — kept separate to avoid coupling
    /// the throughput benchmark to that harness's directory layout.
    #[cfg(unix)]
    fn build_flat_probe_library(root: &Path, n: usize, noise: usize) -> usize {
        use std::io::Write;
        for i in 0..n {
            let p = root.join(format!("Movie {i} (2020).mkv"));
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(b"not real video bytes").unwrap();
        }
        for i in 0..noise {
            let p = root.join(format!("notes_{i}.txt"));
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(b"sidecar").unwrap();
        }
        n
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn scan_probe_path_throughput_parametrized() {
        // Real benchmark for the SLOW path: empty-file scans let ffprobe fail
        // fast or be absent, so they never time the spawn+parse cost that
        // dominates a first-time production scan. This drives a SUCCESSFUL
        // ffprobe per file via a deterministic stub, plus the same file_stat +
        // is_video_file walk work production does, so it models the real scan.
        let stub_dir = tempfile::tempdir().unwrap();
        let stub = crate::probe::write_echoing_stub_path(stub_dir.path());

        for &n in &[10usize, 50, 200] {
            let tmp = tempfile::tempdir().unwrap();
            build_flat_probe_library(tmp.path(), n, n / 5);

            let mut probed = 0usize;
            let start = std::time::Instant::now();
            for entry in WalkDir::new(tmp.path()).follow_links(true) {
                let entry = entry.unwrap();
                if !entry.file_type().is_file() {
                    continue;
                }
                let name = entry.file_name().to_str().unwrap();
                if !is_video_file(name) {
                    continue;
                }
                let path = entry.path();
                let _stat = file_stat(path).unwrap();
                let p = crate::probe::ffprobe_with_bin_for_test(stub.to_str().unwrap(), path)
                    .await
                    .expect("stub probe must succeed");
                // Touch a parsed field so the parse is not optimized away.
                assert!(p.video_height.is_some());
                probed += 1;
            }
            let elapsed = start.elapsed();

            assert_eq!(probed, n, "every video file must be probed (n={n})");
            if n == 200 {
                assert!(
                    elapsed < std::time::Duration::from_secs(30),
                    "200-file probe-path scan took {elapsed:?} (regression tripwire)"
                );
            }
        }
    }
}
