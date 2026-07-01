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
    /// `media_files` rows removed because their file vanished from disk (the
    /// delete cascades the backing movies/episodes rows).
    pub files_removed: usize,
    /// Watch-state rows reaped because their movie/episode no longer exists.
    pub watch_orphans_removed: usize,
    /// Video files skipped because their canonical path (symlinks resolved)
    /// escapes every configured library root. `stream_file` refuses to serve
    /// such paths (path_within_roots), so indexing them would create
    /// permanently unplayable rows.
    pub files_skipped_outside_roots: usize,
    /// Video files skipped because their name/path is not valid UTF-8 (the
    /// DB stores paths as TEXT, so they cannot be indexed). Surfaced so a
    /// library gap is explainable from the scan report instead of the file
    /// just silently never appearing.
    pub files_skipped_non_utf8: usize,
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
    /// Roots whose directory existed AND whose walk completed without a single
    /// I/O error. Only paths under these roots are eligible for the
    /// missing-file prune: an unmounted/failed root yields 0 files, and
    /// pruning against that view would wipe the whole catalog (cascading
    /// movies/episodes and then the watch-state GC) for a transient mount
    /// hiccup.
    prunable_roots: Vec<std::path::PathBuf>,
    /// Files whose canonical path escapes every root (see
    /// [`ScanReport::files_skipped_outside_roots`]).
    files_outside_roots: usize,
    /// Video files with a non-UTF-8 name/path (see
    /// [`ScanReport::files_skipped_non_utf8`]).
    files_non_utf8: usize,
}

/// Enumerate every video file under `roots`. Pure blocking FS work (WalkDir +
/// stat) — must run inside `spawn_blocking`, never directly on the async
/// runtime where it would starve other tasks for the duration of a large walk.
fn walk_roots(roots: &[LibraryRoot]) -> WalkOutcome {
    let mut out = WalkOutcome {
        files: Vec::new(),
        files_seen: 0,
        errors: 0,
        prunable_roots: Vec::new(),
        files_outside_roots: 0,
        files_non_utf8: 0,
    };

    // Canonical forms of every existing root, for the symlink-containment
    // check below. Mirrors `routes::path_within_roots`: the scanner follows
    // symlinks, but `stream_file` refuses any path that canonicalizes outside
    // all roots — indexing such a file would create a permanently unplayable
    // row, so it is skipped here instead (a symlink resolving into ANOTHER
    // configured root is fine on both sides).
    let canon_roots: Vec<std::path::PathBuf> = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(&r.path).ok())
        .collect();
    // Warn loudly on the first escapee only; the rest are counted (a tree of
    // thousands of out-of-root symlinks must not flood the log every scan).
    let mut warned_outside_roots = false;

    for root in roots {
        // A configured root whose directory is missing (unmounted volume,
        // typo'd MEDIA_LIBRARY_PATHS) must NOT be treated as "everything was
        // deleted". Skip it loudly and keep it out of the prune set.
        if !root.path.is_dir() {
            tracing::error!(
                root = %root.path.display(),
                "library root missing or not a directory; skipping walk AND \
                 excluding it from the missing-file prune (its rows are kept)"
            );
            out.errors += 1;
            continue;
        }

        let root_kind = root.kind;
        // I/O errors local to THIS root; any error disqualifies the root from
        // the prune pass (an incomplete enumeration cannot prove deletion).
        let mut root_errors = 0usize;
        for entry in WalkDir::new(&root.path).follow_links(true) {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("walk error under {}: {e}", root.path.display());
                    root_errors += 1;
                    continue;
                }
            };

            if !entry.file_type().is_file() {
                continue;
            }

            // Non-UTF-8 names/paths cannot be indexed (paths are stored as
            // TEXT), but they used to vanish without a trace. Count them so a
            // missing title is explainable from the scan report. They are NOT
            // root errors: the condition is permanent (not a transient I/O
            // failure), the path can never be in the DB, and treating it as an
            // error would permanently disqualify the root from pruning.
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => {
                    // Only count names that LOOK like video files (judged on
                    // the lossy form) — arbitrary non-UTF-8 junk stays silent,
                    // matching the is_video_file filter for UTF-8 names.
                    let lossy = entry.file_name().to_string_lossy().into_owned();
                    if is_video_file(&lossy) {
                        tracing::warn!(
                            "non-utf8 file name skipped (cannot be indexed): {}",
                            entry.path().display()
                        );
                        out.files_non_utf8 += 1;
                    }
                    continue;
                }
            };
            if !is_video_file(&name) {
                continue;
            }

            let entry_path = entry.path();

            // Bonus-content directories (Plex local-extras conventions, plus
            // Plex's own "Plex Versions" transcode cache) never hold a movie
            // or episode of their own. Indexing them filled the catalog with
            // TMDB-matched phantoms ("Trailer.mkv" → 'Trailer Thrills' 1937)
            // and pointed real titles at Optimized-for-TV copies.
            if in_extras_dir(entry_path, &root.path) {
                continue;
            }

            let path_str = match entry_path.to_str() {
                Some(p) => p.to_string(),
                None => {
                    // Valid-UTF-8 video name under a non-UTF-8 directory.
                    tracing::warn!(
                        "non-utf8 path skipped (cannot be indexed): {}",
                        entry_path.display()
                    );
                    out.files_non_utf8 += 1;
                    continue;
                }
            };

            out.files_seen += 1;

            // Containment: skip files whose canonical path (symlinks resolved)
            // escapes every configured root — stream_file would refuse them.
            match std::fs::canonicalize(entry_path) {
                Ok(canon) => {
                    if !canon_roots.iter().any(|r| canon.starts_with(r)) {
                        if !warned_outside_roots {
                            tracing::warn!(
                                path = %entry_path.display(),
                                resolves_to = %canon.display(),
                                "file resolves outside all library roots; skipping \
                                 (unservable — further escapees this scan are counted silently)"
                            );
                            warned_outside_roots = true;
                        }
                        out.files_outside_roots += 1;
                        continue;
                    }
                }
                Err(e) => {
                    tracing::warn!("canonicalize failed for {path_str}: {e}");
                    root_errors += 1;
                    continue;
                }
            }

            let (size_bytes, mtime) = match file_stat(entry_path) {
                Ok(stat) => stat,
                Err(e) => {
                    tracing::warn!("stat failed for {path_str}: {e}");
                    root_errors += 1;
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

        if root_errors == 0 {
            out.prunable_roots.push(root.path.clone());
        } else {
            tracing::error!(
                root = %root.path.display(),
                errors = root_errors,
                "walk of library root hit I/O errors; excluding it from the \
                 missing-file prune this pass (its rows are kept)"
            );
        }
        out.errors += root_errors;
    }

    out
}

/// Run one full scan pass over `roots`, mutating `db`. The current root's
/// [`RootKind`](crate::filename::RootKind) is authoritative for classification,
/// and `tmdb` is consulted best-effort for enrichment (never fails the scan).
/// Ends with a reconciliation pass: rows whose file vanished from disk are
/// removed (a rename is the old row pruned + the new path indexed) and
/// orphaned watch-state rows are reaped.
pub async fn scan_once(
    db: &Db,
    roots: &[LibraryRoot],
    tmdb: &TmdbClient,
) -> Result<ScanReport, AppError> {
    // Production probes with the installed `ffprobe`. The binary is threaded so
    // the crit-2 100-file timing harness can drive scan_once end-to-end against
    // a deterministic stub (see `scan_once_100_file_library_under_5s`).
    scan_once_with_probe_bin(db, roots, tmdb, "ffprobe").await
}

async fn scan_once_with_probe_bin(
    db: &Db,
    roots: &[LibraryRoot],
    tmdb: &TmdbClient,
    ffprobe_bin: &str,
) -> Result<ScanReport, AppError> {
    let mut report = ScanReport::default();

    // The walk + per-file stat is blocking FS I/O; run it off the runtime.
    let roots_owned = roots.to_vec();
    let walk = tokio::task::spawn_blocking(move || walk_roots(&roots_owned))
        .await
        .map_err(|e| AppError::Internal(format!("walk task failed: {e}")))?;
    report.files_seen = walk.files_seen;
    report.errors = walk.errors;
    report.files_skipped_outside_roots = walk.files_outside_roots;
    report.files_skipped_non_utf8 = walk.files_non_utf8;

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
                let probe_result = probe::ffprobe_with_bin(ffprobe_bin, &file.path).await;
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

    // Reconciliation: prune rows whose backing file no longer exists, then
    // reap watch-state orphans (the polymorphic media_kind/media_id pair has
    // no SQL FK, so a cascade cannot do this). Skipped entirely when no roots
    // are configured (dev/tests) — an empty config must never empty the DB.
    // Pruning is further restricted to roots whose walk was HEALTHY (directory
    // existed, zero I/O errors): an unmounted MEDIA_LIBRARY_PATHS volume
    // enumerates as 0 files, and pruning against that view would delete every
    // media_files row, cascade-destroy movies/episodes, and let the
    // watch-state GC reap all progress — for a transient mount failure.
    if !roots.is_empty() {
        match prune_missing_files(db, &walk.prunable_roots).await {
            Ok(removed) => report.files_removed = removed,
            Err(e) => {
                tracing::warn!("prune of deleted files failed: {e}");
                report.errors += 1;
            }
        }
        match gc_orphan_watch_state(db).await {
            Ok(reaped) => report.watch_orphans_removed = reaped as usize,
            Err(e) => {
                tracing::warn!("watch-state GC failed: {e}");
                report.errors += 1;
            }
        }
    }

    Ok(report)
}

/// Delete every `media_files` row whose path no longer exists on disk. The
/// delete cascades the backing `movies`/`episodes` rows (file_id ON DELETE
/// CASCADE); shows left with zero episodes are swept afterwards so the
/// library never lists an empty series. Returns the number of file rows
/// removed.
///
/// Only rows under `prunable_roots` — roots whose directory existed and whose
/// walk completed without I/O errors — are candidates. Rows under a missing or
/// errored root are deliberately retained: an unmounted volume looks exactly
/// like "every file was deleted", and acting on that view destroys the catalog
/// and all watch state. With no healthy roots, nothing is pruned.
async fn prune_missing_files(
    db: &Db,
    prunable_roots: &[std::path::PathBuf],
) -> Result<usize, AppError> {
    if prunable_roots.is_empty() {
        tracing::warn!("no healthy library roots this pass; skipping missing-file prune");
        return Ok(0);
    }

    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, path FROM media_files")
        .fetch_all(&db.pool)
        .await?;

    // Existence probes are blocking FS I/O; batch them off the runtime.
    let roots = prunable_roots.to_vec();
    let missing: Vec<i64> = tokio::task::spawn_blocking(move || {
        rows.into_iter()
            .filter(|(_, path)| {
                let p = std::path::Path::new(path);
                roots.iter().any(|root| p.starts_with(root)) && !p.exists()
            })
            .map(|(id, _)| id)
            .collect()
    })
    .await
    .map_err(|e| AppError::Internal(format!("prune task failed: {e}")))?;

    let mut removed = 0usize;
    for id in missing {
        removed += sqlx::query("DELETE FROM media_files WHERE id = ?")
            .bind(id)
            .execute(&db.pool)
            .await?
            .rows_affected() as usize;
    }

    if removed > 0 {
        // Shows are not file-backed, so the cascade cannot reach them; sweep
        // any series whose last episode was just pruned.
        sqlx::query("DELETE FROM shows WHERE id NOT IN (SELECT DISTINCT show_id FROM episodes)")
            .execute(&db.pool)
            .await?;
        tracing::info!(removed, "pruned media_files rows for deleted files");
    }
    Ok(removed)
}

/// Remove watch-state rows whose `(media_kind, media_id)` no longer resolves to
/// an existing movie/episode (orphans left by title deletion, or pre-existing
/// forged rows). Returns the number of rows removed. The relationship is
/// polymorphic (media_kind ∈ {movie, episode}), so a SQL foreign key cannot
/// enforce it (§7-8); this GC — wired into the end of every scan pass — is how
/// orphans are reaped.
pub async fn gc_orphan_watch_state(db: &Db) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "DELETE FROM media_watch_state \
         WHERE (media_kind = 'movie'   AND media_id NOT IN (SELECT id FROM movies)) \
            OR (media_kind = 'episode' AND media_id NOT IN (SELECT id FROM episodes)) \
            OR media_kind NOT IN ('movie', 'episode')",
    )
    .execute(&db.pool)
    .await?;
    Ok(res.rows_affected())
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
    join_scan(tokio::spawn(
        async move { scan_once(&db, &roots, &tmdb).await },
    ))
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
/// Upsert one `media_files` row from a probe, keyed on the UNIQUE `path`
/// (`ON CONFLICT(path) DO UPDATE`, never REPLACE — see the [`index_file`] note
/// on why REPLACE would orphan watch state). Returns the stable `(file_id,
/// scanned_at)`. Shared by the video ([`index_file`]) and audio
/// ([`index_music_file`]) paths so both persist the exact same columns.
async fn upsert_media_file(
    db: &Db,
    path: &str,
    size_bytes: i64,
    mtime: &str,
    probe: &FileProbe,
) -> Result<(i64, String), AppError> {
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
    Ok((file_id, scanned_at))
}

async fn index_file(
    db: &Db,
    path: &str,
    size_bytes: i64,
    mtime: &str,
    probe: &FileProbe,
    parsed: &ParsedName,
    tmdb: &TmdbClient,
) -> Result<bool, AppError> {
    let (file_id, scanned_at) = upsert_media_file(db, path, size_bytes, mtime, probe).await?;

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

/// Bonus-content directory names (matched case-insensitively as whole path
/// components below the library root). The list is Plex's local-extras
/// folder convention plus "Plex Versions" (Plex's optimized-transcode cache).
/// "Specials" is deliberately absent — it is the season-0 convention for TV.
const EXTRAS_DIRS: &[&str] = &[
    "featurettes",
    "behind the scenes",
    "deleted scenes",
    "interviews",
    "scenes",
    "shorts",
    "trailers",
    "extras",
    "other",
    "sample",
    "samples",
    "plex versions",
];

/// `true` when any directory component of `path` below `root` is a known
/// bonus-content folder. The filename itself is not checked.
pub fn in_extras_dir(path: &Path, root: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let Some(dir) = rel.parent() else {
        return false;
    };
    dir.components().any(|c| match c {
        std::path::Component::Normal(os) => os
            .to_str()
            .is_some_and(|s| EXTRAS_DIRS.contains(&s.to_lowercase().as_str())),
        _ => false,
    })
}

// ── Music library ─────────────────────────────────────────────────────────
//
// Audio reuses every existing mechanism: the same `media_files` rows (probed by
// the same ffprobe path, served by the same range-capable `stream_file`), plus
// three thin catalog tables (artists/albums/tracks). Classification is pure
// tag-reading — no TMDB, no filename regex — so a music scan is far simpler than
// the video pass and stays wholly independent of its prune/GC logic.

/// Audio extensions the music scanner considers. Shared so tests and the walker
/// agree.
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "flac", "ogg", "opus", "wav"];

pub fn is_audio_file(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct MusicScanReport {
    pub files_seen: usize,
    pub files_added: usize,
    pub files_updated: usize,
    pub tracks: usize,
    /// `media_files` rows removed because their audio file vanished from disk
    /// (the delete cascades the backing tracks; empty albums/artists are swept).
    pub files_removed: usize,
    pub errors: usize,
}

/// Classified music metadata for one file: artist (album_artist ?? artist ??
/// "Unknown Artist"), album ?? "Unknown Album", title ?? filename stem, plus an
/// optional track number and release year parsed from the tags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MusicMeta {
    pub artist: String,
    pub album: String,
    pub title: String,
    pub track_no: Option<i64>,
    pub year: Option<i64>,
}

/// The leading integer of a tag like `"1/12"` or `" 03 "` → `1` / `3`.
fn parse_leading_int(s: &str) -> Option<i64> {
    let digits: String = s.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// A 4-digit 1900–2099 year prefixing a `date`/`year` tag (`"1959-08-17"` →
/// `1959`). Anything shorter or out of range yields `None`.
fn parse_leading_year(s: &str) -> Option<i64> {
    let digits: String = s.trim().chars().take_while(char::is_ascii_digit).collect();
    if digits.len() >= 4
        && let Ok(y) = digits[..4].parse::<i64>()
        && (1900..=2099).contains(&y)
    {
        return Some(y);
    }
    None
}

/// Classify a track from its container-level tags plus the filename stem.
/// Pure and exhaustively unit-testable (mirrors [`filename::parse_filename`]).
pub fn classify_music(tags: &std::collections::BTreeMap<String, String>, stem: &str) -> MusicMeta {
    let get = |k: &str| tags.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let artist = get("album_artist")
        .or_else(|| get("albumartist"))
        .or_else(|| get("artist"))
        .unwrap_or("Unknown Artist")
        .to_string();
    let album = get("album").unwrap_or("Unknown Album").to_string();
    let title = match get("title") {
        Some(t) => t.to_string(),
        None => {
            let s = stem.trim();
            if s.is_empty() {
                "Unknown Track".to_string()
            } else {
                s.to_string()
            }
        }
    };
    let track_no = get("track")
        .or_else(|| get("tracknumber"))
        .and_then(parse_leading_int);
    let year = get("date")
        .or_else(|| get("year"))
        .or_else(|| get("originaldate"))
        .and_then(parse_leading_year);
    MusicMeta {
        artist,
        album,
        title,
        track_no,
        year,
    }
}

/// One audio file collected by the blocking walk phase.
struct WalkedAudio {
    path: std::path::PathBuf,
    path_str: String,
    stem: String,
    size_bytes: i64,
    mtime: String,
}

/// Enumerating outcome for the music roots: candidate files, error tally, and
/// the roots healthy enough to prune against (same guard as the video walk — a
/// missing/errored root must never look like "every track was deleted").
struct AudioWalkOutcome {
    files: Vec<WalkedAudio>,
    errors: usize,
    prunable_roots: Vec<std::path::PathBuf>,
}

/// Walk every audio file under `roots`. Pure blocking FS work — run inside
/// `spawn_blocking`, never directly on the async runtime.
fn walk_audio_roots(roots: &[std::path::PathBuf]) -> AudioWalkOutcome {
    walk_matching_roots(roots, is_audio_file, "music")
}

/// Walk every file matching `matches` under `roots` (shared by the music,
/// audiobook, and photo scans). Pure blocking FS work — run inside
/// `spawn_blocking`, never directly on the async runtime.
fn walk_matching_roots(
    roots: &[std::path::PathBuf],
    matches: fn(&str) -> bool,
    label: &str,
) -> AudioWalkOutcome {
    let mut out = AudioWalkOutcome {
        files: Vec::new(),
        errors: 0,
        prunable_roots: Vec::new(),
    };
    for root in roots {
        if !root.is_dir() {
            tracing::error!(
                root = %root.display(),
                "{label} root missing or not a directory; skipping walk AND excluding \
                 it from the missing-file prune (its rows are kept)"
            );
            out.errors += 1;
            continue;
        }
        let mut root_errors = 0usize;
        for entry in WalkDir::new(root).follow_links(true) {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("{label} walk error under {}: {e}", root.display());
                    root_errors += 1;
                    continue;
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str() else {
                continue;
            };
            if !matches(name) {
                continue;
            }
            let path = entry.path();
            let Some(path_str) = path.to_str().map(str::to_string) else {
                continue;
            };
            let (size_bytes, mtime) = match file_stat(path) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("stat failed for {path_str}: {e}");
                    root_errors += 1;
                    continue;
                }
            };
            let stem = name
                .rsplit_once('.')
                .map(|(s, _)| s)
                .unwrap_or(name)
                .to_string();
            out.files.push(WalkedAudio {
                path: path.to_path_buf(),
                path_str,
                stem,
                size_bytes,
                mtime,
            });
        }
        if root_errors == 0 {
            out.prunable_roots.push(root.clone());
        }
        out.errors += root_errors;
    }
    out
}

/// Run one music scan pass over `roots`. Probes new/changed audio files (skips
/// files whose `(path, size, mtime)` are unchanged, exactly like the video
/// pass), upserts artists/albums/tracks, then prunes vanished tracks under
/// healthy roots. Empty `roots` is a no-op (the M3-only posture).
pub async fn scan_music_once(
    db: &Db,
    roots: &[std::path::PathBuf],
    art_dir: &std::path::Path,
) -> Result<MusicScanReport, AppError> {
    scan_music_once_with_probe_bin(db, roots, art_dir, "ffprobe").await
}

async fn scan_music_once_with_probe_bin(
    db: &Db,
    roots: &[std::path::PathBuf],
    art_dir: &std::path::Path,
    ffprobe_bin: &str,
) -> Result<MusicScanReport, AppError> {
    let mut report = MusicScanReport::default();
    if roots.is_empty() {
        return Ok(report);
    }

    let roots_owned = roots.to_vec();
    let walk = tokio::task::spawn_blocking(move || walk_audio_roots(&roots_owned))
        .await
        .map_err(|e| AppError::Internal(format!("music walk task failed: {e}")))?;
    report.files_seen = walk.files.len();
    report.errors = walk.errors;

    for file in &walk.files {
        let path_str = &file.path_str;
        match existing_stat(db, path_str).await {
            // Unchanged since last scan → already indexed; skip the reprobe.
            Ok(Some((prev_size, prev_mtime)))
                if prev_size == file.size_bytes && prev_mtime == file.mtime =>
            {
                continue;
            }
            Ok(existing) => {
                let is_update = existing.is_some();
                let probed = match probe::ffprobe_with_bin(ffprobe_bin, &file.path).await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("ffprobe failed for {path_str}: {e}");
                        report.errors += 1;
                        continue;
                    }
                };
                match index_music_file(
                    db,
                    path_str,
                    file.size_bytes,
                    &file.mtime,
                    &probed,
                    &file.stem,
                    Some(art_dir),
                )
                .await
                {
                    Ok(()) => {
                        if is_update {
                            report.files_updated += 1;
                        } else {
                            report.files_added += 1;
                        }
                        report.tracks += 1;
                    }
                    Err(e) => {
                        tracing::warn!("music index failed for {path_str}: {e}");
                        report.errors += 1;
                    }
                }
            }
            Err(e) => {
                tracing::warn!("music lookup failed for {path_str}: {e}");
                report.errors += 1;
            }
        }
    }

    match prune_missing_music(db, &walk.prunable_roots).await {
        Ok(removed) => report.files_removed = removed,
        Err(e) => {
            tracing::warn!("music prune failed: {e}");
            report.errors += 1;
        }
    }

    Ok(report)
}

/// [`scan_music_once`] on its own spawned task so a panic surfaces as `Err`
/// rather than unwinding the caller (mirrors [`scan_once_isolated`]).
pub async fn scan_music_isolated(
    db: Db,
    roots: Vec<std::path::PathBuf>,
    art_dir: std::path::PathBuf,
) -> Result<MusicScanReport, AppError> {
    match tokio::spawn(async move { scan_music_once(&db, &roots, &art_dir).await }).await {
        Ok(result) => result,
        Err(e) => Err(AppError::Internal(format!("music scan task panicked: {e}"))),
    }
}

/// Upsert one audio file into `media_files` + artists/albums/tracks. The track
/// is keyed on its backing `media_file_id`, so a rescan of the same file never
/// duplicates it; the artist/album upserts dedup on name / (artist, title).
/// With `art_dir`, albums without art get it resolved (folder image first,
/// embedded cover extraction second); `None` skips art entirely (tests).
#[allow(clippy::too_many_arguments)]
async fn index_music_file(
    db: &Db,
    path: &str,
    size_bytes: i64,
    mtime: &str,
    probe: &FileProbe,
    stem: &str,
    art_dir: Option<&std::path::Path>,
) -> Result<(), AppError> {
    let (file_id, _scanned_at) = upsert_media_file(db, path, size_bytes, mtime, probe).await?;
    let meta = classify_music(&probe.format_tags, stem);
    let artist_id = upsert_artist(db, &meta.artist).await?;
    let album_id = upsert_album(db, artist_id, &meta.album, meta.year).await?;
    upsert_track(
        db,
        album_id,
        file_id,
        &meta.title,
        meta.track_no,
        probe.duration_secs,
    )
    .await?;
    if let Some(art_dir) = art_dir {
        resolve_album_art(db, album_id, path, probe, art_dir).await?;
    }
    Ok(())
}

/// Fill `albums.art_path` for `album_id` if it is still NULL: a folder image
/// beside the track wins (referenced in place, no copy); otherwise an
/// embedded attached_pic is extracted once into `art_dir/album_{id}.jpg`.
/// Best-effort — an extraction failure just leaves the album artless.
async fn resolve_album_art(
    db: &Db,
    album_id: i64,
    track_path: &str,
    probe: &FileProbe,
    art_dir: &std::path::Path,
) -> Result<(), AppError> {
    let current: Option<Option<String>> =
        sqlx::query_scalar("SELECT art_path FROM albums WHERE id = ?")
            .bind(album_id)
            .fetch_optional(&db.pool)
            .await?;
    if !matches!(current, Some(None)) {
        return Ok(()); // already has art (or the album vanished)
    }

    let track_dir = std::path::Path::new(track_path)
        .parent()
        .map(std::path::PathBuf::from);
    let folder_art = match track_dir {
        Some(dir) => tokio::task::spawn_blocking(move || find_folder_art(&dir))
            .await
            .unwrap_or(None),
        None => None,
    };

    let art_path: Option<String> = if let Some(p) = folder_art {
        p.to_str().map(str::to_string)
    } else if probe.has_embedded_art {
        let dest = art_dir.join(format!("album_{album_id}.jpg"));
        if tokio::fs::create_dir_all(art_dir).await.is_ok()
            && extract_embedded_art(std::path::Path::new(track_path), &dest).await
        {
            dest.to_str().map(str::to_string)
        } else {
            None
        }
    } else {
        None
    };

    if let Some(art) = art_path {
        sqlx::query("UPDATE albums SET art_path = ? WHERE id = ? AND art_path IS NULL")
            .bind(art)
            .bind(album_id)
            .execute(&db.pool)
            .await?;
    }
    Ok(())
}

/// A conventional album image in `dir`: {cover,folder,front,album} ×
/// {jpg,jpeg,png,webp}, case-insensitive. Blocking FS — call off-runtime.
pub fn find_folder_art(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    const STEMS: &[&str] = &["cover", "folder", "front", "album"];
    const EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_ascii_lowercase) else {
            continue;
        };
        if let Some((stem, ext)) = name.rsplit_once('.')
            && STEMS.contains(&stem)
            && EXTS.contains(&ext)
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false)
        {
            return Some(entry.path());
        }
    }
    None
}

/// One-shot embedded-cover extraction: first attached video stream → a JPEG
/// at `dest`. Re-encodes to mjpeg so a PNG cover still lands as .jpg. Returns
/// success; failures are logged by the caller's silence (artless album).
async fn extract_embedded_art(input: &std::path::Path, dest: &std::path::Path) -> bool {
    let ffmpeg_bin = std::env::var("MEDIA_FFMPEG_BIN").unwrap_or_else(|_| "ffmpeg".to_string());
    let output = tokio::process::Command::new(ffmpeg_bin)
        .arg("-y")
        .arg("-v")
        .arg("error")
        .arg("-i")
        .arg(input)
        .arg("-map")
        .arg("0:v:0")
        .arg("-frames:v")
        .arg("1")
        .arg(dest)
        .stdin(std::process::Stdio::null())
        .output()
        .await;
    matches!(output, Ok(o) if o.status.success()) && dest.exists()
}

/// Get-or-create an artist by its UNIQUE name, returning its id.
async fn upsert_artist(db: &Db, name: &str) -> Result<i64, AppError> {
    sqlx::query("INSERT INTO artists (name) VALUES (?) ON CONFLICT(name) DO NOTHING")
        .bind(name)
        .execute(&db.pool)
        .await?;
    let id = sqlx::query_scalar("SELECT id FROM artists WHERE name = ?")
        .bind(name)
        .fetch_one(&db.pool)
        .await?;
    Ok(id)
}

/// Get-or-create an album by UNIQUE `(artist_id, title)`, backfilling `year`
/// when a later scan supplies one. Returns its id.
async fn upsert_album(
    db: &Db,
    artist_id: i64,
    title: &str,
    year: Option<i64>,
) -> Result<i64, AppError> {
    sqlx::query(
        "INSERT INTO albums (artist_id, title, year) VALUES (?, ?, ?) \
         ON CONFLICT(artist_id, title) DO UPDATE SET year = COALESCE(excluded.year, year)",
    )
    .bind(artist_id)
    .bind(title)
    .bind(year)
    .execute(&db.pool)
    .await?;
    let id = sqlx::query_scalar("SELECT id FROM albums WHERE artist_id = ? AND title = ?")
        .bind(artist_id)
        .bind(title)
        .fetch_one(&db.pool)
        .await?;
    Ok(id)
}

/// Upsert a track keyed on its backing `media_file_id` (UNIQUE), so a rescan of
/// the same file updates in place instead of inserting a duplicate.
async fn upsert_track(
    db: &Db,
    album_id: i64,
    file_id: i64,
    title: &str,
    track_no: Option<i64>,
    duration_secs: Option<i64>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO tracks (album_id, media_file_id, title, track_no, duration_secs) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(media_file_id) DO UPDATE SET \
         album_id = excluded.album_id, title = excluded.title, \
         track_no = excluded.track_no, duration_secs = excluded.duration_secs",
    )
    .bind(album_id)
    .bind(file_id)
    .bind(title)
    .bind(track_no)
    .bind(duration_secs)
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Delete `media_files` rows backing a track whose audio file vanished from
/// disk, restricted to healthy `prunable_roots` (a missing/unmounted music root
/// must never wipe the catalog). The delete cascades tracks; now-empty albums
/// then artists are swept. The `JOIN tracks` guarantees only audio rows are
/// touched — video `media_files` are never in scope. Returns rows removed.
async fn prune_missing_music(
    db: &Db,
    prunable_roots: &[std::path::PathBuf],
) -> Result<usize, AppError> {
    if prunable_roots.is_empty() {
        tracing::warn!("no healthy music roots this pass; skipping music prune");
        return Ok(0);
    }
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT mf.id, mf.path FROM media_files mf JOIN tracks t ON t.media_file_id = mf.id",
    )
    .fetch_all(&db.pool)
    .await?;

    let roots = prunable_roots.to_vec();
    let missing: Vec<i64> = tokio::task::spawn_blocking(move || {
        rows.into_iter()
            .filter(|(_, path)| {
                let p = std::path::Path::new(path);
                roots.iter().any(|root| p.starts_with(root)) && !p.exists()
            })
            .map(|(id, _)| id)
            .collect()
    })
    .await
    .map_err(|e| AppError::Internal(format!("music prune task failed: {e}")))?;

    let mut removed = 0usize;
    for id in missing {
        removed += sqlx::query("DELETE FROM media_files WHERE id = ?")
            .bind(id)
            .execute(&db.pool)
            .await?
            .rows_affected() as usize;
    }
    if removed > 0 {
        // tracks cascade via media_file_id; sweep the now-empty catalog rows.
        sqlx::query("DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks)")
            .execute(&db.pool)
            .await?;
        sqlx::query("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM albums)")
            .execute(&db.pool)
            .await?;
        tracing::info!(removed, "pruned media_files rows for deleted audio files");
    }
    Ok(removed)
}

// ── Photo library ───────────────────────────────────────────────────────
//
// Photos never touch ffprobe or media_files: the scan stats + reads EXIF
// (kamadak-exif, pure Rust) and indexes straight into the `photos` table.
// ponytail: no thumbnail generation yet — the file endpoint serves originals;
// add an ffmpeg-scaled thumb cache when the Photos tab needs a fast grid.

/// Image extensions the photo scanner considers.
pub const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp",
];

pub fn is_image_file(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PhotoScanReport {
    pub files_seen: usize,
    pub files_added: usize,
    pub files_updated: usize,
    pub files_removed: usize,
    pub errors: usize,
}

/// EXIF-derived photo metadata; every field best-effort.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PhotoMeta {
    pub taken_at: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// EXIF datetimes are `"YYYY:MM:DD HH:MM:SS"`; swap the date colons for
/// dashes and the space for `T` so the stored string sorts chronologically
/// alongside RFC3339 mtimes. Anything that doesn't look like that shape is
/// dropped rather than stored unsortable.
pub fn exif_datetime_to_sortable(raw: &str) -> Option<String> {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if s.len() < 19 || bytes[4] != b':' || bytes[7] != b':' || bytes[10] != b' ' {
        return None;
    }
    if !s[..4].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!(
        "{}-{}-{}T{}",
        &s[..4],
        &s[5..7],
        &s[8..10],
        &s[11..19]
    ))
}

/// Read EXIF taken-at + pixel dimensions. Blocking I/O — call inside
/// `spawn_blocking`. Any failure (no EXIF, unsupported container) → defaults.
pub fn read_photo_meta(path: &std::path::Path) -> PhotoMeta {
    let Ok(file) = std::fs::File::open(path) else {
        return PhotoMeta::default();
    };
    let mut reader = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return PhotoMeta::default();
    };
    let field_str = |tag: exif::Tag| {
        exif.get_field(tag, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
    };
    let field_uint = |tag: exif::Tag| {
        exif.get_field(tag, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
            .map(i64::from)
    };
    PhotoMeta {
        taken_at: field_str(exif::Tag::DateTimeOriginal)
            .or_else(|| field_str(exif::Tag::DateTime))
            .and_then(|s| exif_datetime_to_sortable(&s)),
        width: field_uint(exif::Tag::PixelXDimension),
        height: field_uint(exif::Tag::PixelYDimension),
    }
}

/// One photo scan pass: stat-skip unchanged files, EXIF-index new/changed
/// ones, prune vanished rows under healthy roots. Empty `roots` is a no-op.
pub async fn scan_photos_once(
    db: &Db,
    roots: &[std::path::PathBuf],
) -> Result<PhotoScanReport, AppError> {
    let mut report = PhotoScanReport::default();
    if roots.is_empty() {
        return Ok(report);
    }

    let roots_owned = roots.to_vec();
    let walk = tokio::task::spawn_blocking(move || {
        walk_matching_roots(&roots_owned, is_image_file, "photo")
    })
    .await
    .map_err(|e| AppError::Internal(format!("photo walk task failed: {e}")))?;
    report.files_seen = walk.files.len();
    report.errors = walk.errors;

    for file in &walk.files {
        let existing: Option<(i64, String)> =
            sqlx::query_as("SELECT size_bytes, mtime FROM photos WHERE path = ?")
                .bind(&file.path_str)
                .fetch_optional(&db.pool)
                .await?;
        if let Some((prev_size, prev_mtime)) = &existing
            && *prev_size == file.size_bytes
            && *prev_mtime == file.mtime
        {
            continue;
        }
        let path = file.path.clone();
        let meta = tokio::task::spawn_blocking(move || read_photo_meta(&path))
            .await
            .unwrap_or_default();
        sqlx::query(
            "INSERT INTO photos (path, size_bytes, mtime, width, height, taken_at, scanned_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes, \
             mtime = excluded.mtime, width = excluded.width, height = excluded.height, \
             taken_at = excluded.taken_at, scanned_at = excluded.scanned_at",
        )
        .bind(&file.path_str)
        .bind(file.size_bytes)
        .bind(&file.mtime)
        .bind(meta.width)
        .bind(meta.height)
        .bind(&meta.taken_at)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&db.pool)
        .await?;
        if existing.is_some() {
            report.files_updated += 1;
        } else {
            report.files_added += 1;
        }
    }

    // Prune vanished photos under roots that walked cleanly.
    if !walk.prunable_roots.is_empty() {
        let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, path FROM photos")
            .fetch_all(&db.pool)
            .await?;
        let roots = walk.prunable_roots.clone();
        let missing: Vec<i64> = tokio::task::spawn_blocking(move || {
            rows.into_iter()
                .filter(|(_, path)| {
                    let p = std::path::Path::new(path);
                    roots.iter().any(|root| p.starts_with(root)) && !p.exists()
                })
                .map(|(id, _)| id)
                .collect()
        })
        .await
        .map_err(|e| AppError::Internal(format!("photo prune task failed: {e}")))?;
        for id in missing {
            report.files_removed += sqlx::query("DELETE FROM photos WHERE id = ?")
                .bind(id)
                .execute(&db.pool)
                .await?
                .rows_affected() as usize;
        }
    }

    Ok(report)
}

/// [`scan_photos_once`] isolated on its own task (mirrors the other scans).
pub async fn scan_photos_isolated(
    db: Db,
    roots: Vec<std::path::PathBuf>,
) -> Result<PhotoScanReport, AppError> {
    match tokio::spawn(async move { scan_photos_once(&db, &roots).await }).await {
        Ok(result) => result,
        Err(e) => Err(AppError::Internal(format!("photo scan task panicked: {e}"))),
    }
}

// ── Audiobooks ──────────────────────────────────────────────────────────
//
// Audiobooks ride the music machinery: the same media_files upsert (probed by
// the same ffprobe call, which now also captures container chapters), plus a
// thin `audiobooks` catalog row per file. m4b is the canonical container but
// any audio extension under an AUDIOBOOK_LIBRARY_PATHS root counts.

pub fn is_audiobook_file(name: &str) -> bool {
    is_audio_file(name)
        || name
            .rsplit_once('.')
            .map(|(_, ext)| ext.eq_ignore_ascii_case("m4b"))
            .unwrap_or(false)
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct AudiobookScanReport {
    pub files_seen: usize,
    pub files_added: usize,
    pub files_updated: usize,
    pub files_removed: usize,
    pub errors: usize,
}

/// Author/title classification for an audiobook file. Tags first (author →
/// album_artist → artist), then the parent directory name, then fallbacks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudiobookMeta {
    pub author: String,
    pub title: String,
}

pub fn classify_audiobook(
    tags: &std::collections::BTreeMap<String, String>,
    stem: &str,
    parent_dir: Option<&str>,
) -> AudiobookMeta {
    let get = |k: &str| tags.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let author = get("author")
        .or_else(|| get("album_artist"))
        .or_else(|| get("albumartist"))
        .or_else(|| get("artist"))
        .map(str::to_string)
        .or_else(|| {
            parent_dir
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Unknown Author".to_string());
    let title = get("album")
        .or_else(|| get("title"))
        .map(str::to_string)
        .unwrap_or_else(|| {
            let s = stem.trim();
            if s.is_empty() {
                "Unknown Audiobook".to_string()
            } else {
                s.to_string()
            }
        });
    AudiobookMeta { author, title }
}

/// One audiobook scan pass over `roots` (mirrors [`scan_music_once`]).
pub async fn scan_audiobooks_once(
    db: &Db,
    roots: &[std::path::PathBuf],
) -> Result<AudiobookScanReport, AppError> {
    scan_audiobooks_once_with_probe_bin(db, roots, "ffprobe").await
}

async fn scan_audiobooks_once_with_probe_bin(
    db: &Db,
    roots: &[std::path::PathBuf],
    ffprobe_bin: &str,
) -> Result<AudiobookScanReport, AppError> {
    let mut report = AudiobookScanReport::default();
    if roots.is_empty() {
        return Ok(report);
    }

    let roots_owned = roots.to_vec();
    let walk = tokio::task::spawn_blocking(move || {
        walk_matching_roots(&roots_owned, is_audiobook_file, "audiobook")
    })
    .await
    .map_err(|e| AppError::Internal(format!("audiobook walk task failed: {e}")))?;
    report.files_seen = walk.files.len();
    report.errors = walk.errors;

    for file in &walk.files {
        let path_str = &file.path_str;
        match existing_stat(db, path_str).await {
            Ok(Some((prev_size, prev_mtime)))
                if prev_size == file.size_bytes && prev_mtime == file.mtime =>
            {
                continue;
            }
            Ok(existing) => {
                let is_update = existing.is_some();
                let probed = match probe::ffprobe_with_bin(ffprobe_bin, &file.path).await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("ffprobe failed for {path_str}: {e}");
                        report.errors += 1;
                        continue;
                    }
                };
                let parent_dir = file
                    .path
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str());
                let meta = classify_audiobook(&probed.format_tags, &file.stem, parent_dir);
                let index = async {
                    let (file_id, _) =
                        upsert_media_file(db, path_str, file.size_bytes, &file.mtime, &probed)
                            .await?;
                    let chapters_json = serde_json::to_string(&probed.chapters)
                        .unwrap_or_else(|_| "[]".to_string());
                    sqlx::query(
                        "INSERT INTO audiobooks (media_file_id, author, title, duration_secs, chapters_json) \
                         VALUES (?, ?, ?, ?, ?) \
                         ON CONFLICT(media_file_id) DO UPDATE SET author = excluded.author, \
                         title = excluded.title, duration_secs = excluded.duration_secs, \
                         chapters_json = excluded.chapters_json",
                    )
                    .bind(file_id)
                    .bind(&meta.author)
                    .bind(&meta.title)
                    .bind(probed.duration_secs)
                    .bind(&chapters_json)
                    .execute(&db.pool)
                    .await?;
                    Ok::<(), AppError>(())
                };
                match index.await {
                    Ok(()) => {
                        if is_update {
                            report.files_updated += 1;
                        } else {
                            report.files_added += 1;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("audiobook index failed for {path_str}: {e}");
                        report.errors += 1;
                    }
                }
            }
            Err(e) => {
                tracing::warn!("audiobook lookup failed for {path_str}: {e}");
                report.errors += 1;
            }
        }
    }

    // Prune media_files rows backing audiobooks whose file vanished (cascades
    // the audiobooks row), restricted to healthy roots — same guard as music.
    if !walk.prunable_roots.is_empty() {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT mf.id, mf.path FROM media_files mf JOIN audiobooks a ON a.media_file_id = mf.id",
        )
        .fetch_all(&db.pool)
        .await?;
        let roots = walk.prunable_roots.clone();
        let missing: Vec<i64> = tokio::task::spawn_blocking(move || {
            rows.into_iter()
                .filter(|(_, path)| {
                    let p = std::path::Path::new(path);
                    roots.iter().any(|root| p.starts_with(root)) && !p.exists()
                })
                .map(|(id, _)| id)
                .collect()
        })
        .await
        .map_err(|e| AppError::Internal(format!("audiobook prune task failed: {e}")))?;
        for id in missing {
            report.files_removed += sqlx::query("DELETE FROM media_files WHERE id = ?")
                .bind(id)
                .execute(&db.pool)
                .await?
                .rows_affected() as usize;
        }
    }

    Ok(report)
}

/// [`scan_audiobooks_once`] isolated on its own task.
pub async fn scan_audiobooks_isolated(
    db: Db,
    roots: Vec<std::path::PathBuf>,
) -> Result<AudiobookScanReport, AppError> {
    match tokio::spawn(async move { scan_audiobooks_once(&db, &roots).await }).await {
        Ok(result) => result,
        Err(e) => Err(AppError::Internal(format!(
            "audiobook scan task panicked: {e}"
        ))),
    }
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
            format_tags: Default::default(),
            chapters: Vec::new(),
            has_embedded_art: false,
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
    fn extras_dirs_are_skipped_by_path_component() {
        let root = Path::new("/media/Movies");
        for p in [
            "/media/Movies/Forgetting Sarah Marshall (2008)/Featurettes/Trailer.mkv",
            "/media/Movies/Some Movie (2002)/Plex Versions/Optimized for TV/Some Movie.mp4",
            "/media/Movies/Some Movie (2002)/Behind The Scenes/clip.mkv",
            "/media/Movies/Some Movie (2002)/extras/thing.mkv",
        ] {
            assert!(in_extras_dir(Path::new(p), root), "should skip: {p}");
        }
        for p in [
            "/media/Movies/Aladdin (2019)/Aladdin.2019.2160p.mkv",
            // The filename itself is never checked — only directories.
            "/media/Movies/Trailers (2021)/Trailer.mkv",
            "/media/Movies/The Sample Movie (1999)/sample movie.mkv",
        ] {
            // "Trailers (2021)" is not an exact component match; a title dir
            // merely CONTAINING an extras word must not be skipped.
            assert!(!in_extras_dir(Path::new(p), root), "should keep: {p}");
        }
        // TV: season-0 "Specials" must never be skipped.
        let tv_root = Path::new("/media/tv_shows");
        assert!(!in_extras_dir(
            Path::new("/media/tv_shows/Doctor Who/Specials/ep.mkv"),
            tv_root
        ));
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
    async fn scan_prunes_deleted_files_and_reaps_orphan_watch_state() {
        // A row whose file vanished from disk must be removed at the end of
        // the pass (cascading its movie), and the watch state that pointed at
        // it reaped — while the surviving title's row and watch state stay.
        let tmp = tempdir().unwrap();
        let kept_path = tmp.path().join("Kept Movie (2020).mkv");
        std::fs::write(&kept_path, b"bytes").unwrap();
        let db = Db::connect_memory().await.unwrap();

        // Seed the surviving file with its EXACT on-disk stat so the scan
        // takes the probe-free skip branch (no real ffprobe needed).
        let (size, mtime) = file_stat(&kept_path).unwrap();
        sqlx::query(
            "INSERT INTO media_files \
             (path, size_bytes, mtime, container, duration_secs, video_codec, \
              video_height, video_profile, hdr_format, audio_tracks_json, \
              subtitle_tracks_json, scanned_at) \
             VALUES (?, ?, ?, 'mkv', 1, 'h264', 1080, NULL, NULL, '[]', '[]', 't')",
        )
        .bind(kept_path.to_str().unwrap())
        .bind(size)
        .bind(&mtime)
        .execute(&db.pool)
        .await
        .unwrap();
        let kept_file: i64 = sqlx::query_scalar("SELECT id FROM media_files WHERE path = ?")
            .bind(kept_path.to_str().unwrap())
            .fetch_one(&db.pool)
            .await
            .unwrap();
        upsert_movie(&db, "Kept Movie", Some(2020), kept_file, "t", None)
            .await
            .unwrap();

        // A second row whose path never existed on disk (a deleted file).
        let gone_path = tmp.path().join("Gone Movie (2019).mkv");
        let gone_file = seed_media_file(&db, gone_path.to_str().unwrap()).await;
        upsert_movie(&db, "Gone Movie", Some(2019), gone_file, "t", None)
            .await
            .unwrap();

        let (kept_movie, gone_movie): (i64, i64) = {
            let k: i64 = sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
                .bind(kept_file)
                .fetch_one(&db.pool)
                .await
                .unwrap();
            let g: i64 = sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
                .bind(gone_file)
                .fetch_one(&db.pool)
                .await
                .unwrap();
            (k, g)
        };
        for movie_id in [kept_movie, gone_movie] {
            sqlx::query(
                "INSERT INTO media_watch_state \
                 (sub, media_kind, media_id, position_secs, watched_at, completed) \
                 VALUES ('plex:1', 'movie', ?, 10, 't', 0)",
            )
            .bind(movie_id)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        let roots = vec![LibraryRoot {
            path: tmp.path().to_path_buf(),
            kind: RootKind::Movies,
        }];
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();

        assert_eq!(report.files_removed, 1, "the deleted file's row is pruned");
        assert_eq!(
            report.watch_orphans_removed, 1,
            "the orphaned watch row is reaped"
        );
        assert_eq!(count(&db, "media_files").await, 1);
        assert_eq!(count(&db, "movies").await, 1, "cascade removed the movie");
        let surviving_watch: i64 =
            sqlx::query_scalar("SELECT media_id FROM media_watch_state WHERE media_kind='movie'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(
            surviving_watch, kept_movie,
            "the surviving title's watch state stays"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn scan_counts_non_utf8_video_names_without_failing_prune() {
        // A video file with a non-UTF-8 name cannot be indexed (paths are
        // stored as TEXT) but used to vanish silently. It must be counted in
        // files_skipped_non_utf8, must NOT bump errors, and must NOT
        // disqualify the root from the missing-file prune (the condition is
        // permanent, not a transient I/O failure).
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let tmp = tempdir().unwrap();
        // Invalid UTF-8 byte in the stem; extension still reads ".mkv".
        // APFS/HFS+ (macOS) reject non-UTF-8 names outright (EILSEQ), so the
        // full scenario is only constructible on Linux filesystems — exactly
        // where prod (NAS, ext4/xfs in Docker) runs and where CI executes.
        // On a UTF-8-enforcing FS, degrade to proving the healthy-prune half.
        let bad_name = OsStr::from_bytes(b"caf\xff (2020).mkv");
        let non_utf8_supported = std::fs::write(tmp.path().join(bad_name), b"bytes").is_ok();
        if non_utf8_supported {
            // Non-video non-UTF-8 junk stays silent (no count).
            let bad_junk = OsStr::from_bytes(b"junk\xff.nfo");
            std::fs::write(tmp.path().join(bad_junk), b"x").unwrap();
        }

        let db = Db::connect_memory().await.unwrap();
        // A vanished row under the same root: prune must still fire.
        let gone = tmp.path().join("Gone (2019).mkv");
        let gone_file = seed_media_file(&db, gone.to_str().unwrap()).await;
        upsert_movie(&db, "Gone", Some(2019), gone_file, "t", None)
            .await
            .unwrap();

        let roots = vec![LibraryRoot {
            path: tmp.path().to_path_buf(),
            kind: RootKind::Movies,
        }];
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();

        if non_utf8_supported {
            assert_eq!(
                report.files_skipped_non_utf8, 1,
                "the non-utf8 VIDEO file is counted (junk is not)"
            );
        } else {
            eprintln!("filesystem enforces UTF-8 names; non-utf8 half skipped");
        }
        assert_eq!(report.errors, 0, "non-utf8 is a skip stat, not an error");
        assert_eq!(
            report.files_removed, 1,
            "the root stays prune-healthy despite the non-utf8 skip"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn scan_skips_symlinks_escaping_all_roots() {
        // Consistency with stream_file: a symlinked file whose canonical path
        // escapes every library root would be indexed by the scanner but
        // refused by path_within_roots at stream time — a permanently
        // unplayable row. The scanner must skip (and count) it, while a
        // symlink resolving WITHIN a root stays indexable.
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();

        // A real, in-root file (seeded as unchanged so no ffprobe is needed).
        let real = root.path().join("Inside (2020).mkv");
        std::fs::write(&real, b"bytes").unwrap();
        // An in-root symlink to an in-root target: allowed.
        let in_link = root.path().join("Also Inside (2021).mkv");
        std::os::unix::fs::symlink(&real, &in_link).unwrap();
        // An in-root symlink escaping to a file outside every root: skipped.
        let escapee_target = outside.path().join("Escapee (2022).mkv");
        std::fs::write(&escapee_target, b"bytes").unwrap();
        let escapee = root.path().join("Escapee (2022).mkv");
        std::os::unix::fs::symlink(&escapee_target, &escapee).unwrap();

        let db = Db::connect_memory().await.unwrap();
        for p in [&real, &in_link] {
            let (size, mtime) = file_stat(p).unwrap();
            sqlx::query(
                "INSERT INTO media_files \
                 (path, size_bytes, mtime, container, duration_secs, video_codec, \
                  video_height, video_profile, hdr_format, audio_tracks_json, \
                  subtitle_tracks_json, scanned_at) \
                 VALUES (?, ?, ?, 'mkv', 1, 'h264', 1080, NULL, NULL, '[]', '[]', 't')",
            )
            .bind(p.to_str().unwrap())
            .bind(size)
            .bind(&mtime)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        let roots = vec![LibraryRoot {
            path: root.path().to_path_buf(),
            kind: RootKind::Movies,
        }];
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();

        assert_eq!(report.files_seen, 3, "all three candidates are walked");
        assert_eq!(
            report.files_skipped_outside_roots, 1,
            "exactly the escaping symlink is skipped"
        );
        let escapee_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_files WHERE path LIKE '%Escapee%'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(escapee_rows, 0, "the escapee must not be indexed");
        // The in-root rows survive (the escapee skip must not poison prune).
        assert_eq!(count(&db, "media_files").await, 2);
    }

    #[tokio::test]
    async fn scan_with_missing_root_never_prunes() {
        // REGRESSION: an unmounted/missing MEDIA_LIBRARY_PATHS volume must not
        // be read as "every file was deleted". A configured root whose
        // directory does not exist enumerates 0 files; pruning against that
        // view used to delete EVERY media_files row, cascade movies/episodes,
        // and let the watch-state GC reap all progress.
        let db = Db::connect_memory().await.unwrap();
        let gone_root = std::path::PathBuf::from("/definitely-not-mounted-eex-test");
        let file_id =
            seed_media_file(&db, "/definitely-not-mounted-eex-test/Movie (2020).mkv").await;
        upsert_movie(&db, "Movie", Some(2020), file_id, "t", None)
            .await
            .unwrap();
        let movie_id: i64 = sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO media_watch_state \
             (sub, media_kind, media_id, position_secs, watched_at, completed) \
             VALUES ('plex:1', 'movie', ?, 10, 't', 0)",
        )
        .bind(movie_id)
        .execute(&db.pool)
        .await
        .unwrap();

        let roots = vec![LibraryRoot {
            path: gone_root,
            kind: RootKind::Movies,
        }];
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();

        assert_eq!(report.files_removed, 0, "missing root must prune nothing");
        assert_eq!(report.watch_orphans_removed, 0, "watch state must survive");
        assert!(
            report.errors >= 1,
            "the skipped root is surfaced as an error"
        );
        assert_eq!(count(&db, "media_files").await, 1);
        assert_eq!(count(&db, "movies").await, 1);
        assert_eq!(count(&db, "media_watch_state").await, 1);
    }

    #[tokio::test]
    async fn scan_prunes_only_under_healthy_roots() {
        // Mixed config: one healthy root with a genuinely deleted file, one
        // missing root with intact rows. Exactly the healthy root's vanished
        // file is pruned; the missing root's catalog is untouched.
        let tmp = tempdir().unwrap();
        let db = Db::connect_memory().await.unwrap();

        // Healthy root: one row whose file was deleted.
        let gone_path = tmp.path().join("Deleted (2019).mkv");
        let gone_file = seed_media_file(&db, gone_path.to_str().unwrap()).await;
        upsert_movie(&db, "Deleted", Some(2019), gone_file, "t", None)
            .await
            .unwrap();

        // Missing root: a row that must survive.
        let kept_file = seed_media_file(&db, "/unmounted-eex-test/Kept (2021).mkv").await;
        upsert_movie(&db, "Kept", Some(2021), kept_file, "t", None)
            .await
            .unwrap();

        let roots = vec![
            LibraryRoot {
                path: tmp.path().to_path_buf(),
                kind: RootKind::Movies,
            },
            LibraryRoot {
                path: std::path::PathBuf::from("/unmounted-eex-test"),
                kind: RootKind::Movies,
            },
        ];
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();

        assert_eq!(
            report.files_removed, 1,
            "exactly the healthy root's deleted file is pruned"
        );
        let remaining: Vec<String> = sqlx::query_scalar("SELECT path FROM media_files")
            .fetch_all(&db.pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec!["/unmounted-eex-test/Kept (2021).mkv"]);
        assert_eq!(count(&db, "movies").await, 1);
    }

    #[tokio::test]
    async fn scan_with_no_roots_never_prunes() {
        // Empty roots (dev/tests) must never trigger the reconciliation pass —
        // otherwise a misconfigured deploy with MEDIA_LIBRARY_PATHS unset
        // would empty the entire library DB on its first scan.
        let db = Db::connect_memory().await.unwrap();
        let file_id = seed_media_file(&db, "/lib/not-on-this-machine.mkv").await;
        upsert_movie(&db, "Phantom", None, file_id, "t", None)
            .await
            .unwrap();

        let report = scan_once(&db, &[], &no_tmdb()).await.unwrap();
        assert_eq!(report.files_removed, 0);
        assert_eq!(count(&db, "media_files").await, 1);
        assert_eq!(count(&db, "movies").await, 1);
    }

    #[tokio::test]
    async fn scan_handles_rename_as_prune_plus_add() {
        // A rename is the old row pruned + the new path seen by the walk. With
        // empty placeholder files ffprobe fails (or is absent), so the new
        // path lands in `errors` rather than `files_added` — the assertion
        // here is that the OLD path's row is gone and the new path was seen.
        let tmp = tempdir().unwrap();
        let new_path = tmp.path().join("Renamed (2021).mkv");
        std::fs::write(&new_path, b"bytes").unwrap();
        let db = Db::connect_memory().await.unwrap();

        let old_file =
            seed_media_file(&db, tmp.path().join("Old (2021).mkv").to_str().unwrap()).await;
        upsert_movie(&db, "Old", Some(2021), old_file, "t", None)
            .await
            .unwrap();

        let roots = vec![LibraryRoot {
            path: tmp.path().to_path_buf(),
            kind: RootKind::Movies,
        }];
        let report = scan_once(&db, &roots, &no_tmdb()).await.unwrap();
        assert_eq!(report.files_seen, 1, "the renamed file is walked");
        assert_eq!(report.files_removed, 1, "the old path's row is pruned");
        let old_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_files WHERE path LIKE '%Old%'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(old_rows, 0);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn scan_once_100_file_library_under_5s() {
        // Regression guard for the stated success criterion (scanner.rs line 11:
        // "a 100-file fixture library scans in < 5s"). Drives the REAL scan_once
        // orchestration end-to-end — walk + stat + skip-check + classify + the
        // movie/episode upserts + prune/GC reconciliation — over a 100-file
        // library. A deterministic ffprobe stub stands in for the binary so
        // every file actually PROBES + INDEXES (the bar then covers the DB write
        // path, not just the walk-then-error path empty files would take), and
        // the figure reflects scan_once's own overhead rather than ffprobe's
        // variable decode cost. Runs without real media files or an installed
        // ffprobe, as CI does.
        let stub_dir = tempfile::tempdir().unwrap();
        let stub = crate::probe::write_echoing_stub_path(stub_dir.path());

        let tmp = tempdir().unwrap();
        build_synthetic_library(tmp.path(), 100, 0);
        let db = Db::connect_memory().await.unwrap();
        let roots = vec![LibraryRoot {
            path: tmp.path().to_path_buf(),
            kind: RootKind::Movies,
        }];
        let start = std::time::Instant::now();
        let report = scan_once_with_probe_bin(&db, &roots, &no_tmdb(), stub.to_str().unwrap())
            .await
            .unwrap();
        let elapsed = start.elapsed();
        assert_eq!(report.files_seen, 100, "all 100 videos walked");
        assert_eq!(report.files_added, 100, "all 100 videos probed + indexed");
        assert_eq!(
            report.errors, 0,
            "no probe/index errors on the clean fixture"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "100-file scan took {elapsed:?} (crit-2 bar: <5s)"
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

    // ── Music ─────────────────────────────────────────────────────────────

    /// A `FileProbe` for an audio file: a duration + the given container-level
    /// tags, no video stream (mirrors what ffprobe reports for a real track).
    fn music_probe(tags: &[(&str, &str)], duration: i64) -> FileProbe {
        FileProbe {
            container: Some("flac".into()),
            duration_secs: Some(duration),
            video_codec: None,
            video_height: None,
            video_profile: None,
            hdr_format: None,
            audio_tracks: vec![AudioTrack {
                index: 0,
                codec: Some("flac".into()),
                channels: Some(2),
                language: None,
                title: None,
            }],
            subtitle_tracks: vec![],
            format_tags: tags
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            chapters: Vec::new(),
            has_embedded_art: false,
        }
    }

    // ── Photos & audiobooks ────────────────────────────────────────────

    #[test]
    fn image_and_audiobook_extensions_recognized() {
        assert!(is_image_file("IMG_0001.JPG"));
        assert!(is_image_file("pic.heic"));
        assert!(!is_image_file("movie.mkv"));
        assert!(!is_image_file("noext"));
        // m4b is audiobook-only; plain audio counts for audiobooks too.
        assert!(is_audiobook_file("book.m4b"));
        assert!(is_audiobook_file("book.mp3"));
        assert!(!is_audio_file("book.m4b"));
    }

    #[test]
    fn exif_datetime_converts_to_sortable() {
        assert_eq!(
            exif_datetime_to_sortable("2023:06:14 10:20:30"),
            Some("2023-06-14T10:20:30".to_string())
        );
        assert_eq!(exif_datetime_to_sortable("garbage"), None);
        assert_eq!(exif_datetime_to_sortable("2023-06-14 10:20:30"), None);
        assert_eq!(exif_datetime_to_sortable(""), None);
    }

    #[test]
    fn classify_audiobook_prefers_tags_then_parent_dir() {
        let tags = |pairs: &[(&str, &str)]| -> std::collections::BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let m = classify_audiobook(
            &tags(&[
                ("artist", "Ursula K. Le Guin"),
                ("album", "The Dispossessed"),
            ]),
            "part1",
            Some("SomeDir"),
        );
        assert_eq!(m.author, "Ursula K. Le Guin");
        assert_eq!(m.title, "The Dispossessed");

        // No tags: author falls to the parent dir, title to the stem.
        let m = classify_audiobook(&tags(&[]), "The Left Hand of Darkness", Some("Le Guin"));
        assert_eq!(m.author, "Le Guin");
        assert_eq!(m.title, "The Left Hand of Darkness");

        // Nothing at all: explicit unknowns, never empty strings.
        let m = classify_audiobook(&tags(&[]), "", None);
        assert_eq!(m.author, "Unknown Author");
        assert_eq!(m.title, "Unknown Audiobook");
    }

    #[tokio::test]
    async fn photo_scan_indexes_skips_and_prunes() {
        let db = Db::connect_memory().await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        // Not a real JPEG — EXIF read fails gracefully → NULL meta columns.
        std::fs::write(root.join("a.jpg"), b"not-really-a-jpeg").unwrap();
        std::fs::write(root.join("b.png"), b"fake-png").unwrap();
        std::fs::write(root.join("notes.txt"), b"skipped").unwrap();

        let report = scan_photos_once(&db, &[root.clone()]).await.unwrap();
        assert_eq!(report.files_seen, 2);
        assert_eq!(report.files_added, 2);
        assert_eq!(count(&db, "photos").await, 2);

        // Unchanged rescan is a no-op.
        let report = scan_photos_once(&db, &[root.clone()]).await.unwrap();
        assert_eq!(report.files_added, 0);
        assert_eq!(report.files_updated, 0);

        // Deleting a file prunes its row (root still healthy).
        std::fs::remove_file(root.join("b.png")).unwrap();
        let report = scan_photos_once(&db, &[root.clone()]).await.unwrap();
        assert_eq!(report.files_removed, 1);
        assert_eq!(count(&db, "photos").await, 1);

        // A vanished ROOT must not wipe the catalog.
        drop(dir);
        let report = scan_photos_once(&db, &[root]).await.unwrap();
        assert_eq!(report.files_removed, 0);
        assert_eq!(count(&db, "photos").await, 1);
    }

    #[test]
    fn folder_art_found_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Cover.JPG"), b"img").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        let found = find_folder_art(dir.path()).unwrap();
        assert_eq!(found.file_name().unwrap().to_str().unwrap(), "Cover.JPG");

        let empty = tempfile::tempdir().unwrap();
        assert!(find_folder_art(empty.path()).is_none());
    }

    #[tokio::test]
    async fn music_index_records_folder_art_once() {
        let db = Db::connect_memory().await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let art = dir.path().join("cover.jpg");
        std::fs::write(&art, b"img").unwrap();
        let track = dir.path().join("01 Song.flac");
        std::fs::write(&track, b"audio").unwrap();

        let probe = music_probe(&[("artist", "Ghost"), ("album", "Haunt")], 100);
        let art_dir = tempfile::tempdir().unwrap();
        index_music_file(
            &db,
            track.to_str().unwrap(),
            5,
            "t",
            &probe,
            "01 Song",
            Some(art_dir.path()),
        )
        .await
        .unwrap();

        let stored: Option<String> = sqlx::query_scalar("SELECT art_path FROM albums LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(stored.as_deref(), art.to_str());
        // No embedded art + already-set art → a rescan never overwrites.
        index_music_file(
            &db,
            track.to_str().unwrap(),
            6,
            "t2",
            &probe,
            "01 Song",
            Some(art_dir.path()),
        )
        .await
        .unwrap();
        let count_art: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM albums WHERE art_path IS NOT NULL")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(count_art, 1);
    }

    #[test]
    fn is_audio_file_recognizes_extensions() {
        assert!(is_audio_file("song.mp3"));
        assert!(is_audio_file("Track 01.FLAC"));
        assert!(is_audio_file("a.m4a"));
        assert!(is_audio_file("b.opus"));
        assert!(!is_audio_file("movie.mkv"));
        assert!(!is_audio_file("cover.jpg"));
        assert!(!is_audio_file("noext"));
        // A trailing suffix means the real extension is not audio.
        assert!(!is_audio_file("song.mp3.part"));
    }

    #[test]
    fn classify_music_prefers_album_artist_and_parses_track_and_year() {
        let tags: std::collections::BTreeMap<String, String> = [
            ("artist", "Track Artist"),
            ("album_artist", "Album Artist"),
            ("album", "Kind of Blue"),
            ("title", "So What"),
            ("track", "1/5"),
            ("date", "1959-08-17"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let meta = classify_music(&tags, "01 - So What");
        assert_eq!(meta.artist, "Album Artist", "album_artist wins over artist");
        assert_eq!(meta.album, "Kind of Blue");
        assert_eq!(meta.title, "So What");
        assert_eq!(meta.track_no, Some(1), "track '1/5' → 1");
        assert_eq!(meta.year, Some(1959), "date '1959-08-17' → 1959");
    }

    #[test]
    fn classify_music_falls_back_to_unknowns_and_stem() {
        // No tags at all → Unknown Artist/Album, title from the filename stem.
        let tags = std::collections::BTreeMap::new();
        let meta = classify_music(&tags, "Untitled Demo");
        assert_eq!(meta.artist, "Unknown Artist");
        assert_eq!(meta.album, "Unknown Album");
        assert_eq!(meta.title, "Untitled Demo");
        assert_eq!(meta.track_no, None);
        assert_eq!(meta.year, None);
        // artist present but blank album_artist → falls through to artist.
        let tags: std::collections::BTreeMap<String, String> =
            [("album_artist", "  "), ("artist", "Real Artist")]
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        assert_eq!(classify_music(&tags, "x").artist, "Real Artist");
    }

    #[tokio::test]
    async fn music_index_is_idempotent_no_duplicate_artist_album_track() {
        // Rescanning the same file must not duplicate the artist, album, or
        // track — the whole point of the (name)/(artist,title)/(media_file_id)
        // uniqueness. Runs index_music_file directly (no ffprobe needed).
        let db = Db::connect_memory().await.unwrap();
        let probe = music_probe(
            &[
                ("album_artist", "Radiohead"),
                ("album", "OK Computer"),
                ("title", "Airbag"),
                ("track", "1"),
                ("date", "1997"),
            ],
            260,
        );
        for _ in 0..3 {
            index_music_file(
                &db,
                "/music/Radiohead/OK Computer/01 Airbag.flac",
                1,
                "t",
                &probe,
                "01 Airbag",
                None,
            )
            .await
            .unwrap();
        }
        assert_eq!(count(&db, "artists").await, 1);
        assert_eq!(count(&db, "albums").await, 1);
        assert_eq!(count(&db, "tracks").await, 1);
        assert_eq!(count(&db, "media_files").await, 1);

        let (title, track_no, dur): (String, Option<i64>, Option<i64>) =
            sqlx::query_as("SELECT title, track_no, duration_secs FROM tracks LIMIT 1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(title, "Airbag");
        assert_eq!(track_no, Some(1));
        assert_eq!(dur, Some(260));

        // A second album by the same artist reuses the one artist row.
        let probe2 = music_probe(
            &[
                ("album_artist", "Radiohead"),
                ("album", "In Rainbows"),
                ("title", "15 Step"),
                ("track", "1"),
            ],
            238,
        );
        index_music_file(
            &db,
            "/music/Radiohead/In Rainbows/01 15 Step.flac",
            1,
            "t",
            &probe2,
            "01 15 Step",
            None,
        )
        .await
        .unwrap();
        assert_eq!(count(&db, "artists").await, 1, "same artist, one row");
        assert_eq!(count(&db, "albums").await, 2, "two albums");
        assert_eq!(count(&db, "tracks").await, 2);
    }

    /// Build a synthetic music library: `n` audio files across two artist/album
    /// dirs, cycling `AUDIO_EXTENSIONS`, plus a couple of non-audio decoys.
    fn build_music_library(dir: &std::path::Path, n: usize) {
        use std::fs::{File, create_dir_all};
        use std::io::Write;
        let a = dir.join("Artist A").join("Album One");
        let b = dir.join("Artist B").join("Album Two");
        create_dir_all(&a).unwrap();
        create_dir_all(&b).unwrap();
        for i in 0..n {
            let ext = AUDIO_EXTENSIONS[i % AUDIO_EXTENSIONS.len()];
            let target = if i % 2 == 0 { &a } else { &b };
            let mut f = File::create(target.join(format!("{:02} Track.{ext}", i + 1))).unwrap();
            f.write_all(b"audio bytes").unwrap();
        }
        // Decoys the is_audio_file filter must exclude.
        File::create(a.join("cover.jpg")).unwrap();
        File::create(a.join("notes.txt")).unwrap();
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn scan_music_once_walks_audio_and_indexes_via_stub() {
        // Drives the real scan_music_once walk end-to-end against a deterministic
        // ffprobe stub (the echoing stub reports a valid probe with no music
        // tags → classify_music falls back to Unknown Artist/Album + stem title).
        let stub_dir = tempfile::tempdir().unwrap();
        let stub = crate::probe::write_echoing_stub_path(stub_dir.path());
        let tmp = tempdir().unwrap();
        build_music_library(tmp.path(), 8);
        let db = Db::connect_memory().await.unwrap();
        let roots = vec![tmp.path().to_path_buf()];

        let report = scan_music_once_with_probe_bin(
            &db,
            &roots,
            std::env::temp_dir().as_path(),
            stub.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(report.files_seen, 8, "only the 8 audio files are walked");
        assert_eq!(report.files_added, 8, "all 8 probed + indexed");
        assert_eq!(report.tracks, 8);
        assert_eq!(report.errors, 0);
        assert_eq!(count(&db, "tracks").await, 8);
        // No tags → one Unknown Artist / Unknown Album collecting every track.
        assert_eq!(count(&db, "artists").await, 1);
        assert_eq!(count(&db, "albums").await, 1);

        // A second scan is all-skips (unchanged): no new files, no errors.
        let again = scan_music_once_with_probe_bin(
            &db,
            &roots,
            std::env::temp_dir().as_path(),
            stub.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(again.files_seen, 8);
        assert_eq!(again.files_added, 0, "unchanged files take the skip path");
        assert_eq!(again.tracks, 0);
        assert_eq!(count(&db, "tracks").await, 8, "no duplication on rescan");
    }

    #[tokio::test]
    async fn scan_music_empty_roots_is_noop() {
        let db = Db::connect_memory().await.unwrap();
        let report = scan_music_once(&db, &[], std::env::temp_dir().as_path())
            .await
            .unwrap();
        assert_eq!(report.files_seen, 0);
        assert_eq!(report.files_added, 0);
        assert_eq!(count(&db, "tracks").await, 0);
    }

    #[tokio::test]
    async fn scan_music_prunes_deleted_track_and_sweeps_empty_album_artist() {
        // A track whose file vanished is pruned (cascading the track), and the
        // now-empty album + artist are swept — while a surviving track stays.
        let tmp = tempdir().unwrap();
        let db = Db::connect_memory().await.unwrap();

        // Kept: a real on-disk file seeded with its EXACT stat so the walk takes
        // the probe-free skip path (no dependency on a real ffprobe binary).
        let kept = tmp.path().join("keep.flac");
        std::fs::write(&kept, b"bytes").unwrap();
        let (ksize, kmtime) = file_stat(&kept).unwrap();
        let kp = music_probe(&[("album_artist", "Keeper"), ("album", "Stays")], 100);
        index_music_file(
            &db,
            kept.to_str().unwrap(),
            ksize,
            &kmtime,
            &kp,
            "keep",
            None,
        )
        .await
        .unwrap();

        // Gone: a track pointing at a path that does not exist under the root.
        let gone = tmp.path().join("gone.flac");
        let gp = music_probe(&[("album_artist", "Goner"), ("album", "Vanishes")], 100);
        index_music_file(&db, gone.to_str().unwrap(), 5, "t", &gp, "gone", None)
            .await
            .unwrap();

        assert_eq!(count(&db, "tracks").await, 2);
        assert_eq!(count(&db, "artists").await, 2);

        let roots = vec![tmp.path().to_path_buf()];
        let report = scan_music_once(&db, &roots, std::env::temp_dir().as_path())
            .await
            .unwrap();
        assert_eq!(
            report.files_removed, 1,
            "the deleted track's file is pruned"
        );
        assert_eq!(
            count(&db, "tracks").await,
            1,
            "only the surviving track remains"
        );
        // The Goner artist/album are swept; only Keeper survives.
        assert_eq!(count(&db, "albums").await, 1);
        assert_eq!(count(&db, "artists").await, 1);
        let name: String = sqlx::query_scalar("SELECT name FROM artists LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(name, "Keeper");
    }

    #[tokio::test]
    async fn scan_music_missing_root_never_prunes() {
        // An unmounted music root enumerates 0 files; it must NOT be read as
        // "every track was deleted" (same guard as the video scan).
        let db = Db::connect_memory().await.unwrap();
        let probe = music_probe(&[("album_artist", "Ghost"), ("album", "Haunt")], 100);
        index_music_file(
            &db,
            "/definitely-not-mounted-eex-music/song.flac",
            5,
            "t",
            &probe,
            "song",
            None,
        )
        .await
        .unwrap();

        let roots = vec![std::path::PathBuf::from(
            "/definitely-not-mounted-eex-music",
        )];
        let report = scan_music_once(&db, &roots, std::env::temp_dir().as_path())
            .await
            .unwrap();
        assert_eq!(report.files_removed, 0, "missing root prunes nothing");
        assert!(
            report.errors >= 1,
            "the skipped root is surfaced as an error"
        );
        assert_eq!(count(&db, "tracks").await, 1, "the track survives");
    }
}
