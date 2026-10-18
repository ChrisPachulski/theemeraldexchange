//! Online SQLite snapshots for the services that own a DB (the gateway's
//! server.db and media.db, iptv's iptv.db): `VACUUM INTO
//! <dir>/<prefix>-<stamp>.db` (transactionally consistent on a live WAL DB),
//! `PRAGMA integrity_check` on the copy before anything is pruned, then keep
//! the newest `keep` snapshots of that prefix.
//!
//! Restore: stop the owning container, copy the snapshot over the live DB,
//! delete its -wal/-shm, start it again.

use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, SqliteConnection};

/// `toISOString()` with ':' and '.' made filesystem-safe, so names sort by time.
pub fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
        .replace([':', '.'], "-")
}

/// Snapshot the DB behind `conn` to `<dir>/<prefix>-<stamp>.db`, verify the
/// copy, then prune. Returns the snapshot path. A failed check leaves every
/// older snapshot in place.
pub async fn snapshot(
    conn: &mut SqliteConnection,
    dir: &Path,
    prefix: &str,
    keep: usize,
    now: DateTime<Utc>,
) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    let dest = dir.join(format!("{prefix}-{}.db", stamp(now)));
    // VACUUM INTO refuses to overwrite; only a same-millisecond rerun hits this.
    let _ = tokio::fs::remove_file(&dest).await;
    sqlx::query("VACUUM INTO ?")
        .bind(dest.to_string_lossy().into_owned())
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("VACUUM INTO: {e}"))?;
    verify(&dest).await?;
    prune(dir, prefix, keep).await;
    Ok(dest)
}

/// `PRAGMA integrity_check` must answer exactly `ok`: a copy of a subtly
/// corrupt source, or one truncated by a full disk, still "succeeds".
pub async fn verify(path: &Path) -> Result<(), String> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let mut snap = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await
        .map_err(|e| format!("open snapshot {name}: {e}"))?;
    let rows = sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
        .fetch_all(&mut snap)
        .await
        .map_err(|e| format!("integrity_check failed for {name}: {e}"));
    drop(snap);
    let rows = rows?;
    if rows != ["ok"] {
        let detail: String = rows.join("; ").chars().take(200).collect();
        return Err(format!("integrity_check failed for {name}: {detail}"));
    }
    Ok(())
}

/// Delete all but the newest `keep` `<prefix>-*.db` snapshots (best effort).
async fn prune(dir: &Path, prefix: &str, keep: usize) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let lead = format!("{prefix}-");
    let mut snaps = Vec::new();
    while let Ok(Some(e)) = entries.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(&lead) && name.ends_with(".db") {
            snaps.push(name);
        }
    }
    snaps.sort();
    let excess = snaps.len().saturating_sub(keep);
    for name in &snaps[..excess] {
        let _ = tokio::fs::remove_file(dir.join(name)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use sqlx::Connection;

    async fn db(path: &Path) -> SqliteConnection {
        let mut c = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        sqlx::query("CREATE TABLE IF NOT EXISTS t (v TEXT)")
            .execute(&mut c)
            .await
            .unwrap();
        c
    }

    #[tokio::test]
    async fn snapshots_and_keeps_the_newest_n_of_its_own_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db(&tmp.path().join("live.db")).await;
        sqlx::query("INSERT INTO t VALUES ('row')")
            .execute(&mut conn)
            .await
            .unwrap();
        let dir = tmp.path().join("backups");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("other-keep-me.db"), b"").unwrap();

        let mut written = Vec::new();
        for day in 1..=4 {
            let at = Utc.with_ymd_and_hms(2026, 10, day, 3, 30, 0).unwrap();
            written.push(snapshot(&mut conn, &dir, "svc", 2, at).await.unwrap());
        }
        assert_eq!(
            written[0].file_name().unwrap(),
            "svc-2026-10-01T03-30-00-000Z.db"
        );
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "other-keep-me.db",
                "svc-2026-10-03T03-30-00-000Z.db",
                "svc-2026-10-04T03-30-00-000Z.db",
            ]
        );
        let mut snap = db(&written[3]).await;
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM t")
            .fetch_one(&mut snap)
            .await
            .unwrap();
        assert_eq!(n, 1);
        snap.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_corrupt_copy_fails_the_integrity_check() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("snap.db");
        let mut c = db(&path).await;
        for i in 0..200 {
            sqlx::query("INSERT INTO t VALUES (?)")
                .bind(format!("{i:0>500}"))
                .execute(&mut c)
                .await
                .unwrap();
        }
        c.close().await.unwrap();
        // Scribble over the second page's b-tree header.
        let mut bytes = std::fs::read(&path).unwrap();
        for b in &mut bytes[4096..4096 + 12] {
            *b = 0xA5;
        }
        std::fs::write(&path, bytes).unwrap();
        let err = verify(&path).await.unwrap_err();
        assert!(
            err.starts_with("integrity_check failed for snap.db"),
            "{err}"
        );

        std::fs::write(&path, b"not a database at all, just text").unwrap();
        assert!(verify(&path).await.is_err());
    }
}
