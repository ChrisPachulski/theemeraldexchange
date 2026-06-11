//! `media.db` connection + a minimal migrator that honors the cross-service
//! convention from `server/services/migrator.ts`: a `schema_migrations`
//! ledger of `(version, applied_at, checksum)`, integer versions applied in
//! order. Checksum = sha256 hex of the CRLF-normalized migration SQL.

use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

/// Embedded migrations, applied in ascending version order. Add a new file
/// under `migrations/` and a row here — that is the SINGLE source of truth for
/// the schema version: [`crate::SCHEMA_VERSION`] is derived from the last entry
/// here (see lib.rs), so there is no second constant to keep in lockstep.
pub const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "0001_init", include_str!("../migrations/0001_init.sql")),
    (
        2,
        "0002_media_metadata",
        include_str!("../migrations/0002_media_metadata.sql"),
    ),
    (
        3,
        "0003_search_fts",
        include_str!("../migrations/0003_search_fts.sql"),
    ),
];

#[derive(Clone)]
pub struct Db {
    pub pool: SqlitePool,
}

impl Db {
    pub async fn connect(path: &str) -> Result<Self, sqlx::Error> {
        if let Some(parent) = std::path::Path::new(path).parent()
            && !parent.as_os_str().is_empty()
        {
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
        // WAL + busy_timeout: the Node backend reads this same DB file
        // concurrently (read-only catalog queries). The default rollback
        // journal blocks readers for the duration of every scan write; WAL
        // lets them proceed, and the busy_timeout retries briefly instead of
        // failing fast with SQLITE_BUSY when the writer holds the lock.
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(5))
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
        // Operator escape hatch for deliberate repairs, mirroring the
        // recommender migrator's ALLOW_MIGRATION_CHECKSUM_MISMATCH contract.
        let allow_mismatch = std::env::var("ALLOW_MIGRATION_CHECKSUM_MISMATCH")
            .map(|v| v == "1")
            .unwrap_or(false);
        self.migrate_with_options(allow_mismatch).await
    }

    /// [`Db::migrate`] with the checksum-mismatch escape hatch passed
    /// explicitly (kept separate so tests exercise both paths without racing
    /// on process-global env vars).
    async fn migrate_with_options(&self, allow_checksum_mismatch: bool) -> Result<(), sqlx::Error> {
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

        // Verify already-applied versions against the embedded SQL before
        // touching anything (mirrors recommender/app/db.py): a recorded
        // checksum that no longer matches means the DB schema was produced by
        // a DIFFERENT migration text than this binary carries — running new
        // migrations on top of an unknown schema corrupts silently. Fail the
        // boot loudly instead; ALLOW_MIGRATION_CHECKSUM_MISMATCH=1 is the
        // operator escape hatch for a deliberate repair (after which the
        // stored checksum should be fixed up to match).
        let applied: Vec<(i64, String)> =
            sqlx::query_as("SELECT version, checksum FROM schema_migrations")
                .fetch_all(&self.pool)
                .await?;
        for (version, name, sql) in MIGRATIONS {
            let Some((_, stored)) = applied.iter().find(|(v, _)| v == version) else {
                continue;
            };
            let expected = checksum(sql);
            if *stored != expected {
                if allow_checksum_mismatch {
                    tracing::warn!(
                        version,
                        name,
                        "migration checksum mismatch allowed by \
                         ALLOW_MIGRATION_CHECKSUM_MISMATCH=1; embedded SQL no \
                         longer matches what was applied to this database"
                    );
                    continue;
                }
                return Err(sqlx::Error::Configuration(
                    format!(
                        "migration checksum mismatch on applied migration {version} ({name}): \
                         the embedded SQL no longer matches what was applied to this database \
                         (stored {stored}, embedded {expected}). Restore the original \
                         migration, or set ALLOW_MIGRATION_CHECKSUM_MISMATCH=1 for a \
                         deliberate repair."
                    )
                    .into(),
                ));
            }
        }

        for (version, name, sql) in MIGRATIONS {
            if *version > current {
                let mut tx = self.pool.begin().await?;
                // `sql` is a compile-time-constant migration string from the
                // MIGRATIONS table (never user input). sqlx 0.9 requires an
                // explicit safety assertion for non-'static SQL; audited safe.
                sqlx::raw_sql(sqlx::AssertSqlSafe(*sql))
                    .execute(&mut *tx)
                    .await?;
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

    #[test]
    fn schema_version_matches_last_migration() {
        // SCHEMA_VERSION is derived from MIGRATIONS, so this can only fail if
        // someone reintroduces a hand-maintained literal. Guarding it keeps the
        // /health schema gate trustworthy.
        let last = MIGRATIONS.last().expect("at least one migration").0;
        assert_eq!(
            crate::SCHEMA_VERSION,
            last,
            "SCHEMA_VERSION must equal the last migration version"
        );
    }

    #[test]
    fn migration_versions_are_dense_and_ascending() {
        // 1-based, strictly increasing by 1. A gap or duplicate would let the
        // migrator skip or mis-apply a migration while the derived
        // SCHEMA_VERSION still looked plausible.
        for (i, (version, _, _)) in MIGRATIONS.iter().enumerate() {
            assert_eq!(
                *version,
                (i as i64) + 1,
                "migration {i} has version {version}; expected {}",
                i + 1
            );
        }
    }

    #[tokio::test]
    async fn migrate_is_idempotent_and_sets_version() {
        let db = Db::connect_memory().await.unwrap();
        let expected = crate::SCHEMA_VERSION;
        assert_eq!(db.schema_version().await.unwrap(), expected);
        // Running again must not error or duplicate.
        db.migrate().await.unwrap();
        assert_eq!(db.schema_version().await.unwrap(), expected);
        // Core tables exist.
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN \
             ('media_files','movies','shows','episodes','media_watch_state','scan_state')",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(n, 6);
        // The FTS5 search tables (§7-7) exist too.
        let fts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN \
             ('movies_fts','shows_fts','episodes_fts')",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(fts, 3, "FTS5 virtual tables must be created by 0003");
    }

    #[tokio::test]
    async fn migrate_fails_loud_on_applied_checksum_mismatch() {
        // An applied migration whose recorded checksum no longer matches the
        // embedded SQL means the DB schema came from a different migration
        // text than this binary carries; boot must fail, not run blind.
        let db = Db::connect_memory().await.unwrap();
        sqlx::query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1")
            .execute(&db.pool)
            .await
            .unwrap();

        let err = match db.migrate_with_options(false).await {
            Ok(()) => panic!("migrate must fail on a checksum mismatch"),
            Err(e) => e.to_string(),
        };
        assert!(
            err.contains("checksum mismatch") && err.contains("ALLOW_MIGRATION_CHECKSUM_MISMATCH"),
            "error must name the mismatch and the escape hatch, got: {err}"
        );
    }

    #[tokio::test]
    async fn migrate_mismatch_escape_hatch_allows_boot() {
        // The deliberate-repair path: with the escape hatch set the mismatch
        // is logged but boot proceeds, and the schema version is unchanged.
        let db = Db::connect_memory().await.unwrap();
        sqlx::query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1")
            .execute(&db.pool)
            .await
            .unwrap();

        db.migrate_with_options(true)
            .await
            .expect("escape hatch must allow boot despite the mismatch");
        assert_eq!(db.schema_version().await.unwrap(), crate::SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn migrate_verifies_checksums_match_on_healthy_db() {
        // Sanity for the verification path itself: an untampered DB passes
        // strict verification (no false positives on the recorded hashes).
        let db = Db::connect_memory().await.unwrap();
        db.migrate_with_options(false)
            .await
            .expect("healthy ledger must verify clean");
    }

    #[tokio::test]
    async fn file_backed_db_uses_wal_with_busy_timeout() {
        // The Node backend reads the same file concurrently; the connection
        // must come up in WAL mode with a non-zero busy_timeout, not the
        // default rollback journal that blocks readers during scan writes.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("media.db");
        let db = Db::connect(path.to_str().unwrap()).await.unwrap();

        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");

        let timeout_ms: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(
            timeout_ms >= 5000,
            "busy_timeout must be set (got {timeout_ms}ms)"
        );
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
