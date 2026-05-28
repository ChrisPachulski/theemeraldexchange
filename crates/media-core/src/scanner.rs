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
use crate::tmdb::{TmdbClient, TmdbMatch};

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ScanReport {
    pub files_seen: usize,
    pub files_added: usize,
    pub files_updated: usize,
    pub movies: usize,
    pub episodes: usize,
    pub enriched: usize,
    pub errors: usize,
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

    for root in roots {
        let root_kind = root.kind;
        for entry in WalkDir::new(&root.path).follow_links(true) {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("walk error under {}: {e}", root.path.display());
                    report.errors += 1;
                    continue;
                }
            };

            if !entry.file_type().is_file() {
                continue;
            }

            let name = match entry.file_name().to_str() {
                Some(n) => n,
                None => continue,
            };
            if !is_video_file(name) {
                continue;
            }

            let entry_path = entry.path();
            let path_str = match entry_path.to_str() {
                Some(p) => p.to_string(),
                None => {
                    tracing::warn!("non-utf8 path skipped: {}", entry_path.display());
                    report.errors += 1;
                    continue;
                }
            };

            report.files_seen += 1;

            let (size_bytes, mtime) = match file_stat(entry_path) {
                Ok(stat) => stat,
                Err(e) => {
                    tracing::warn!("stat failed for {path_str}: {e}");
                    report.errors += 1;
                    continue;
                }
            };

            // Skip unchanged files — reprobing is the slow path.
            match existing_stat(db, &path_str).await {
                Ok(Some((prev_size, prev_mtime)))
                    if prev_size == size_bytes && prev_mtime == mtime =>
                {
                    continue;
                }
                Ok(existing) => {
                    let is_update = existing.is_some();
                    let probe_result = probe::ffprobe(entry_path).await;
                    let probed = match probe_result {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::warn!("ffprobe failed for {path_str}: {e}");
                            report.errors += 1;
                            continue;
                        }
                    };
                    let parsed = filename::classify(root_kind, entry_path, name);
                    match index_file(db, &path_str, size_bytes, &mtime, &probed, &parsed, tmdb)
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
    }

    Ok(report)
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
/// `media_files` is keyed on the UNIQUE `path`; `INSERT OR REPLACE` keeps the
/// row current. The resulting file id then drives the movie/episode upserts.
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
        "INSERT OR REPLACE INTO media_files \
         (path, size_bytes, mtime, container, duration_secs, video_codec, \
          video_height, video_profile, hdr_format, audio_tracks_json, \
          subtitle_tracks_json, scanned_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            upsert_episode(db, show_id, *season, *episode, file_id).await?;
            m.is_some()
        }
        ParsedName::Unknown => false,
    };

    Ok(enriched)
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

/// Get-or-create a show by its NORMALIZED title, returning its id. Dedup keys
/// on `norm_title` so `Adventure Time` / `Adventure Time 2008` collapse to one
/// row. When a TMDB match is present, the metadata columns are populated.
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
    let overview = tmdb.and_then(|m| m.overview.clone());
    let poster_path = tmdb.and_then(|m| m.poster_path.clone());

    if let Some(id) = sqlx::query_scalar::<_, i64>("SELECT id FROM shows WHERE norm_title = ?")
        .bind(&key)
        .fetch_optional(&db.pool)
        .await?
    {
        // Backfill metadata onto the existing row when TMDB provided it.
        if tmdb.is_some() {
            sqlx::query(
                "UPDATE shows SET tmdb_id = COALESCE(?, tmdb_id), \
                 imdb_id = COALESCE(?, imdb_id), year = COALESCE(?, year), \
                 overview = COALESCE(?, overview), poster_path = COALESCE(?, poster_path) \
                 WHERE id = ?",
            )
            .bind(tmdb_id)
            .bind(&imdb_id)
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
         (tmdb_id, imdb_id, title, norm_title, year, overview, poster_path, added_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(tmdb_id)
    .bind(&imdb_id)
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

/// Upsert an episode keyed on the UNIQUE `(show_id, season, episode)`.
async fn upsert_episode(
    db: &Db,
    show_id: i64,
    season: i64,
    episode: i64,
    file_id: i64,
) -> Result<(), AppError> {
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM episodes WHERE show_id = ? AND season = ? AND episode = ?",
    )
    .bind(show_id)
    .bind(season)
    .bind(episode)
    .fetch_optional(&db.pool)
    .await?;

    match existing {
        Some(id) => {
            sqlx::query("UPDATE episodes SET file_id = ? WHERE id = ?")
                .bind(file_id)
                .bind(id)
                .execute(&db.pool)
                .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO episodes (show_id, season, episode, file_id) VALUES (?, ?, ?, ?)",
            )
            .bind(show_id)
            .bind(season)
            .bind(episode)
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
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
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
}
