//! Nightly iptv.db snapshot, the iptv.db half of the DB backups (the gateway
//! snapshots server.db and media.db): media_core::backup's `VACUUM INTO
//! <DB_BACKUP_DIR>/iptv-<stamp>.db`, integrity check, keep the newest
//! DB_BACKUP_KEEP.
//!
//! Restore: stop the iptv container, copy the snapshot over iptv.db, delete
//! its -wal/-shm, start it again.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use media_core::cron::{cron_or_default, every};
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::config::Config;

/// One snapshot pass (media_core::backup with the `iptv` prefix). Returns the
/// snapshot path.
pub async fn run(
    pool: &SqlitePool,
    dir: &Path,
    keep: usize,
    now: DateTime<Utc>,
) -> Result<PathBuf, String> {
    let mut conn = pool.acquire().await.map_err(|e| format!("acquire: {e}"))?;
    media_core::backup::snapshot(&mut conn, dir, "iptv", keep, now).await
}

/// Run a snapshot on DB_BACKUP_CRON (03:30 local by default).
pub fn spawn(pool: SqlitePool, config: Arc<Config>) -> JoinHandle<()> {
    let cron = cron_or_default("DB_BACKUP_CRON", &config.db_backup_cron, "30 3 * * *");
    tokio::spawn(every(cron, move || {
        let (pool, config) = (pool.clone(), config.clone());
        async move {
            let dir = PathBuf::from(&config.db_backup_dir);
            match run(&pool, &dir, config.db_backup_keep as usize, Utc::now()).await {
                Ok(path) => tracing::info!("iptv.db snapshot written to {}", path.display()),
                Err(e) => tracing::error!("iptv.db snapshot failed: {e}"),
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[tokio::test]
    async fn snapshots_a_live_db_and_keeps_the_newest_n() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&tmp.path().join("iptv.db").to_string_lossy())
            .await
            .unwrap();
        sqlx::query("INSERT INTO iptv_favorites (sub, kind, item_id, added_ts) VALUES ('local:a', 'live', '1', 'x')")
            .execute(&pool)
            .await
            .unwrap();
        let dir = tmp.path().join("backups");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("server-keep-me.db"), b"").unwrap();

        let mut written = Vec::new();
        for day in 1..=4 {
            let at = Utc.with_ymd_and_hms(2026, 10, day, 3, 30, 0).unwrap();
            written.push(run(&pool, &dir, 2, at).await.unwrap());
        }
        assert_eq!(
            written[0].file_name().unwrap(),
            "iptv-2026-10-01T03-30-00-000Z.db"
        );
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "iptv-2026-10-03T03-30-00-000Z.db",
                "iptv-2026-10-04T03-30-00-000Z.db",
                "server-keep-me.db"
            ]
        );

        // The snapshot carries the rows.
        let snap = crate::db::open(&written[3].to_string_lossy())
            .await
            .unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM iptv_favorites")
            .fetch_one(&snap)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }
}
