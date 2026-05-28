//! `media.db` connection + a minimal migrator that honors the cross-service
//! convention from `server/services/migrator.ts`: a `schema_migrations`
//! ledger of `(version, applied_at, checksum)`, integer versions applied in
//! order. Checksum = sha256 hex of the CRLF-normalized migration SQL.

use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

/// Embedded migrations, applied in ascending version order. Add a new file
/// under `migrations/` and a row here in lockstep; bump `SCHEMA_VERSION`.
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "0001_init", include_str!("../migrations/0001_init.sql")),
    (
        2,
        "0002_media_metadata",
        include_str!("../migrations/0002_media_metadata.sql"),
    ),
];

#[derive(Clone)]
pub struct Db {
    pub pool: SqlitePool,
}

impl Db {
    pub async fn connect(path: &str) -> Result<Self, sqlx::Error> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    sqlx::Error::Configuration(
                        format!(
                            "failed to create parent directory {} for media database: {e}",
                            parent.display()
                        )
                        .into(),
                    )
                })?;
            }
        }
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        let db = Db { pool };
        db.migrate().await?;
        Ok(db)
    }

    /// In-memory DB for tests.
    pub async fn connect_memory() -> Result<Self, sqlx::Error> {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        // A single connection so the in-memory DB persists across queries.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await?;
        let db = Db { pool };
        db.migrate().await?;
        Ok(db)
    }

    pub async fn migrate(&self) -> Result<(), sqlx::Error> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS schema_migrations (\
             version INTEGER PRIMARY KEY, \
             applied_at TEXT NOT NULL, \
             checksum TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await?;

        let current: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
                .fetch_one(&self.pool)
                .await?;

        for (version, name, sql) in MIGRATIONS {
            if *version > current {
                let mut tx = self.pool.begin().await?;
                sqlx::raw_sql(sql).execute(&mut *tx).await?;
                sqlx::query(
                    "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)",
                )
                .bind(version)
                .bind(now_rfc3339())
                .bind(checksum(sql))
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
                tracing::info!("applied migration {name} (v{version})");
            }
        }
        Ok(())
    }

    pub async fn schema_version(&self) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
            .fetch_one(&self.pool)
            .await
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn checksum(sql: &str) -> String {
    let normalized = sql.replace("\r\n", "\n");
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrate_is_idempotent_and_sets_version() {
        let db = Db::connect_memory().await.unwrap();
        assert_eq!(db.schema_version().await.unwrap(), 2);
        // Running again must not error or duplicate.
        db.migrate().await.unwrap();
        assert_eq!(db.schema_version().await.unwrap(), 2);
        // Core tables exist.
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN \
             ('media_files','movies','shows','episodes','media_watch_state','scan_state')",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(n, 6);
    }

    #[tokio::test]
    async fn connect_surfaces_directory_creation_failure() {
        // Create a regular file, then ask to open a DB whose parent directory
        // would have to be created *underneath* that file. `create_dir_all`
        // cannot succeed, so the error must be attributed to directory
        // creation rather than being swallowed and re-surfacing later as a
        // confusing connect error.
        let mut blocker = std::env::temp_dir();
        blocker.push(format!("media_core_db_test_blocker_{}", std::process::id()));
        std::fs::write(&blocker, b"not a directory").unwrap();

        // <blocker>/subdir/media.db — the parent <blocker>/subdir cannot be
        // created because <blocker> is a file.
        let db_path = blocker.join("subdir").join("media.db");
        let result = Db::connect(db_path.to_str().unwrap()).await;

        std::fs::remove_file(&blocker).ok();

        // `Db` is not `Debug`, so match on the Result rather than `expect_err`.
        let msg = match result {
            Ok(_) => panic!("connect should fail when the parent dir cannot be created"),
            Err(e) => e.to_string(),
        };
        assert!(
            msg.contains("failed to create parent directory"),
            "error should attribute the failure to directory creation, got: {msg}"
        );
    }
}
