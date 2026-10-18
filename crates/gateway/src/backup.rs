//! Scheduled snapshots of the DBs the gateway reaches (services/dbBackup.ts,
//! dbBackupScheduler.ts): server.db (server_id, members, device tokens) and
//! media.db (the only home of watch state; media-core is its live writer,
//! and a WAL DB takes a cross-process VACUUM INTO). Each goes through
//! media_core::backup (integrity check before pruning, keep DB_BACKUP_KEEP),
//! then server_state.last_backup_at is stamped: the freshness a destructive
//! migration's gate checks. iptv.db is snapshotted by the iptv service.
//!
//! Restore: stop the gateway, copy `server-<ts>.db` over SERVER_DB_PATH and
//! `media-<ts>.db` over MEDIA_DB_PATH, delete stale -wal/-shm, start it.
//! server_id lives in server.db, so paired devices keep working.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, SqlitePool};
use tokio::task::JoinHandle;

use crate::config::Config;

pub const DEFAULT_DB_BACKUP_CRON: &str = "30 3 * * *";

/// One pass. Returns the snapshot paths and the stamp; a failure stops the
/// pass before anything later (an unverified pass is never stamped).
pub async fn run(
    pool: &SqlitePool,
    config: &Config,
    now: DateTime<Utc>,
) -> Result<(Vec<PathBuf>, String), String> {
    let dir = Path::new(&config.db_backup_dir);
    let keep = config.db_backup_keep as usize;
    let mut files = vec![];
    {
        let mut conn = pool
            .acquire()
            .await
            .map_err(|e| format!("acquire server.db: {e}"))?;
        files.push(media_core::backup::snapshot(&mut conn, dir, "server", keep, now).await?);
    }
    let media = Path::new(&config.media_db_path);
    if media.exists() {
        // Read-write (VACUUM INTO needs it) but never created; the busy
        // timeout waits out media-core's writer.
        let mut conn = SqliteConnectOptions::new()
            .filename(media)
            .busy_timeout(std::time::Duration::from_secs(5))
            .connect()
            .await
            .map_err(|e| format!("open media.db: {e}"))?;
        let snap = media_core::backup::snapshot(&mut conn, dir, "media", keep, now).await;
        let _ = sqlx::Connection::close(conn).await;
        files.push(snap?);
    }
    let stamped_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query(
        "INSERT INTO server_state (key, value, ts) VALUES ('last_backup_at', ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
    )
    .bind(&stamped_at)
    .bind(&stamped_at)
    .execute(pool)
    .await
    .map_err(|e| format!("stamp last_backup_at: {e}"))?;
    Ok((files, stamped_at))
}

/// Run a pass on DB_BACKUP_CRON (03:30 local by default). A failure is an
/// error log, which the sentry layer turns into a Glitchtip issue: a silently
/// failing backup is worse than none.
pub fn spawn(pool: SqlitePool, config: Arc<Config>) -> JoinHandle<()> {
    let cron = media_core::cron::cron_or_default(
        "DB_BACKUP_CRON",
        &config.db_backup_cron,
        DEFAULT_DB_BACKUP_CRON,
    );
    tokio::spawn(media_core::cron::every(cron, move || {
        let (pool, config) = (pool.clone(), config.clone());
        async move {
            match run(&pool, &config, Utc::now()).await {
                Ok((files, at)) => tracing::info!(
                    event = "backup",
                    "snapshot ok: {} file(s) in {}, stamped {at}",
                    files.len(),
                    config.db_backup_dir
                ),
                Err(message) => {
                    tracing::error!(event = "backup", message, "scheduled DB backup failed")
                }
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    async fn state(dir: &tempfile::TempDir, keep: &str) -> crate::AppState {
        let backups = dir.path().join("backups");
        let media = dir.path().join("media.db");
        crate::testutil::state_in(
            dir,
            &[
                ("DB_BACKUP_DIR", backups.to_str().unwrap()),
                ("DB_BACKUP_KEEP", keep),
                ("MEDIA_DB_PATH", media.to_str().unwrap()),
            ],
        )
        .await
    }

    #[tokio::test]
    async fn snapshots_both_dbs_and_stamps_last_backup_at() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(&dir, "7").await;
        crate::testutil::add_member(&st, crate::testutil::ALICE, "alice", "user").await;
        let media = dir.path().join("media.db");
        let mut m = SqliteConnectOptions::new()
            .filename(&media)
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        sqlx::query("CREATE TABLE media_watch_state (sub TEXT, media_id INTEGER); INSERT INTO media_watch_state VALUES ('apple:x', 7)")
            .execute(&mut m)
            .await
            .unwrap();

        let at = Utc.with_ymd_and_hms(2026, 10, 18, 3, 30, 0).unwrap();
        let (files, stamped) = run(&st.auth.pool, &st.config, at).await.unwrap();
        assert_eq!(stamped, "2026-10-18T03:30:00.000Z");
        assert_eq!(
            names(&dir.path().join("backups")),
            [
                "media-2026-10-18T03-30-00-000Z.db",
                "server-2026-10-18T03-30-00-000Z.db"
            ]
        );
        assert_eq!(files.len(), 2);
        let (value, ts): (String, String) =
            sqlx::query_as("SELECT value, ts FROM server_state WHERE key = 'last_backup_at'")
                .fetch_one(&st.auth.pool)
                .await
                .unwrap();
        assert_eq!(
            (value.as_str(), ts.as_str()),
            (stamped.as_str(), stamped.as_str())
        );

        // The snapshots carry the rows (server_id survives a restore).
        let snap = auth::db::open(files[0].to_str().unwrap()).await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM members")
            .fetch_one(&snap)
            .await
            .unwrap();
        assert_eq!(n, 1);
        let mut snap = SqliteConnectOptions::new()
            .filename(&files[1])
            .read_only(true)
            .connect()
            .await
            .unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_watch_state")
            .fetch_one(&mut snap)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn prunes_to_keep_and_skips_an_absent_media_db() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(&dir, "2").await;
        for day in 1..=4 {
            let at = Utc.with_ymd_and_hms(2026, 10, day, 3, 30, 0).unwrap();
            run(&st.auth.pool, &st.config, at).await.unwrap();
        }
        assert_eq!(
            names(&dir.path().join("backups")),
            [
                "server-2026-10-03T03-30-00-000Z.db",
                "server-2026-10-04T03-30-00-000Z.db"
            ]
        );
        let stamp: String =
            sqlx::query_scalar("SELECT value FROM server_state WHERE key = 'last_backup_at'")
                .fetch_one(&st.auth.pool)
                .await
                .unwrap();
        assert_eq!(stamp, "2026-10-04T03:30:00.000Z");
    }

    #[tokio::test]
    async fn a_failed_media_snapshot_is_not_stamped() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(&dir, "7").await;
        std::fs::write(dir.path().join("media.db"), b"not a database").unwrap();
        let at = Utc.with_ymd_and_hms(2026, 10, 18, 3, 30, 0).unwrap();
        assert!(run(&st.auth.pool, &st.config, at).await.is_err());
        let stamp: Option<String> =
            sqlx::query_scalar("SELECT value FROM server_state WHERE key = 'last_backup_at'")
                .fetch_optional(&st.auth.pool)
                .await
                .unwrap();
        assert_eq!(stamp, None);
    }
}
