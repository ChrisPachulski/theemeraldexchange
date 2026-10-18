//! `server.db`: pool, migrations and the stable server_id. The SQL files in
//! crates/auth/migrations are the ones the Node migrator applied (moved by
//! git mv), so their checksums match the prod ledger.

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
    migration!(2, "0002_device_tokens"),
    migration!(3, "0003_members_invites"),
    migration!(4, "0004_webauthn"),
    migration!(5, "0005_device_token_username"),
    migration!(6, "0006_user_api_keys"),
    migration!(7, "0007_google_auth_mode"),
    migration!(8, "0008_workos_auth_mode"),
    migration!(9, "0009_title_ratings"),
    migration!(10, "0010_title_ratings_rt_audience"),
    migration!(11, "0011_device_link_codes"),
    migration!(12, "0012_invite_role"),
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

/// The server's stable id (a v4 UUID), written once and never changed.
pub async fn ensure_server_id(pool: &SqlitePool) -> Result<String, sqlx::Error> {
    sqlx::query(
        "INSERT OR IGNORE INTO server_state (key, value, ts) VALUES ('server_id', ?, datetime('now'))",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(pool)
    .await?;
    sqlx::query_scalar("SELECT value FROM server_state WHERE key = 'server_id'")
        .fetch_one(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ledger_checksums_equal_the_ts_migrators() {
        // tests/fixtures/gen-server-ledger.ts ran the Node migrator on the same files.
        let golden: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/fixtures/server-ledger.json")).unwrap();
        let golden: Vec<(i64, String)> = golden
            .iter()
            .map(|r| {
                (
                    r["version"].as_i64().unwrap(),
                    r["checksum"].as_str().unwrap().to_string(),
                )
            })
            .collect();

        let dir = tempfile::tempdir().unwrap();
        let pool = open(dir.path().join("server.db").to_str().unwrap())
            .await
            .unwrap();
        let rows: Vec<(i64, String)> =
            sqlx::query_as("SELECT version, checksum FROM schema_migrations ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows, golden);
        assert_eq!(rows.len(), MIGRATIONS.len());
    }

    #[tokio::test]
    async fn reopen_is_idempotent_and_creates_the_identity_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/server.db");
        drop(open(path.to_str().unwrap()).await.unwrap());
        let pool = open(path.to_str().unwrap()).await.unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode, "wal");
        let tables: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();
        for t in [
            "members",
            "invites",
            "device_tokens",
            "device_token_revocations",
            "device_link_codes",
            "server_state",
        ] {
            assert!(tables.iter().any(|n| n == t), "missing {t}");
        }
    }

    #[tokio::test]
    async fn server_id_is_written_once() {
        let pool = crate::testutil::pool().await;
        let a = ensure_server_id(&pool).await.unwrap();
        let b = ensure_server_id(&pool).await.unwrap();
        assert_eq!(a, b);
        assert!(uuid::Uuid::parse_str(&a).is_ok());
    }
}
