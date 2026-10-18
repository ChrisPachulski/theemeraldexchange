//! `iptv.db`: pool + migrations. The SQL files in crates/iptv/migrations are the
//! Node migrator's files byte-for-byte, so the checksums match its ledger.

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};

macro_rules! migration {
    ($v:expr, $name:literal) => {
        (
            $v,
            $name,
            include_str!(concat!("../migrations/", $name, ".sql")),
        )
    };
}

pub const MIGRATIONS: &[(i64, &str, &str)] = &[
    migration!(1, "0001_init"),
    migration!(2, "0002_namespace_sub"),
    migration!(3, "0003_link_tombstones"),
    migration!(4, "0004_playlist_tokens"),
    migration!(5, "0005_lowercase_epg_id"),
    migration!(6, "0006_epg_resolved_id"),
    migration!(7, "0007_dvr_recordings"),
    migration!(8, "0008_feed_checks"),
    migration!(9, "0009_epg_derived"),
    migration!(10, "0010_feed_check_reason"),
];

/// Open (creating if needed) and migrate. Same pragmas as the Node opener:
/// WAL, busy_timeout 5000, synchronous NORMAL, foreign keys on.
pub async fn open(path: &str) -> Result<SqlitePool, sqlx::Error> {
    if let Some(parent) = std::path::Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| {
            sqlx::Error::Configuration(format!("failed to create {}: {e}", parent.display()).into())
        })?;
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5))
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    media_core::db::migrate(
        &pool,
        MIGRATIONS,
        media_core::db::allow_checksum_mismatch_from_env(),
    )
    .await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[tokio::test]
    async fn all_migrations_apply_and_ledger_matches_the_files_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        let rows: Vec<(i64, String)> =
            sqlx::query_as("SELECT version, checksum FROM schema_migrations ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            rows.iter().map(|r| r.0).collect::<Vec<_>>(),
            (1..=10).collect::<Vec<_>>()
        );

        // Read the files themselves (not the embedded copies), LF-normalize, hash.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        for ((version, name, _), (_, stored)) in MIGRATIONS.iter().zip(&rows) {
            let text = std::fs::read_to_string(dir.join(format!("{name}.sql"))).unwrap();
            let want: String = Sha256::digest(text.replace("\r\n", "\n").as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(stored, &want, "checksum of v{version} {name}");
        }
    }

    #[tokio::test]
    async fn reopen_is_idempotent_with_wal_and_busy_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("iptv.db");
        drop(open(path.to_str().unwrap()).await.unwrap());
        let pool = open(path.to_str().unwrap()).await.unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode, "wal");
        let busy: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(busy, 5000);
        let tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN \
             ('channels','vod','series','series_episodes','categories','epg_programs', \
              'iptv_favorites','iptv_watch_history','iptv_title_link','iptv_sync_state')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tables, 10);
    }
}
