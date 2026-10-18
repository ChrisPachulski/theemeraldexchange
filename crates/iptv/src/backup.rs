//! Nightly iptv.db snapshot, the iptv.db half of server/services/dbBackup.ts
//! (the backend can no longer open this file): `VACUUM INTO
//! <DB_BACKUP_DIR>/iptv-<stamp>.db`, `PRAGMA integrity_check` on the copy
//! before anything is pruned, then keep the newest DB_BACKUP_KEEP.
//!
//! Restore: stop the iptv container, copy the snapshot over iptv.db, delete
//! its -wal/-shm, start it again.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, SqlitePool};
use tokio::task::JoinHandle;

use crate::config::Config;
use crate::scheduler::{every, parse_cron};

/// `toISOString()` with ':' and '.' made filesystem-safe, so names sort by time.
fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
        .replace([':', '.'], "-")
}

/// One snapshot pass. Returns the snapshot path.
pub async fn run(
    pool: &SqlitePool,
    dir: &Path,
    keep: usize,
    now: DateTime<Utc>,
) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    let dest = dir.join(format!("iptv-{}.db", stamp(now)));
    // VACUUM INTO refuses to overwrite; only a same-millisecond rerun hits this.
    let _ = tokio::fs::remove_file(&dest).await;
    sqlx::query("VACUUM INTO ?")
        .bind(dest.to_string_lossy().into_owned())
        .execute(pool)
        .await
        .map_err(|e| format!("VACUUM INTO: {e}"))?;

    let mut snap = SqliteConnectOptions::new()
        .filename(&dest)
        .read_only(true)
        .connect()
        .await
        .map_err(|e| format!("open snapshot: {e}"))?;
    let rows: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut snap)
        .await
        .map_err(|e| format!("integrity_check: {e}"))?;
    drop(snap);
    if rows != ["ok"] {
        return Err(format!(
            "integrity_check failed for {}: {}",
            dest.display(),
            rows.join("; ")
        ));
    }

    prune(dir, keep).await;
    Ok(dest)
}

/// Delete all but the newest `keep` iptv-*.db snapshots (best effort).
async fn prune(dir: &Path, keep: usize) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let mut snaps = Vec::new();
    while let Ok(Some(e)) = entries.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("iptv-") && name.ends_with(".db") {
            snaps.push(name);
        }
    }
    snaps.sort();
    let excess = snaps.len().saturating_sub(keep);
    for name in &snaps[..excess] {
        let _ = tokio::fs::remove_file(dir.join(name)).await;
    }
}

/// Run a snapshot on DB_BACKUP_CRON (03:30 local by default).
pub fn spawn(pool: SqlitePool, config: Arc<Config>) -> JoinHandle<()> {
    let cron = parse_cron(&config.db_backup_cron).unwrap_or_else(|| {
        tracing::error!(
            "invalid DB_BACKUP_CRON {:?}; using 30 3 * * *",
            config.db_backup_cron
        );
        parse_cron("30 3 * * *").expect("default cron parses")
    });
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
