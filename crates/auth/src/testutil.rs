//! A temp server.db built from the real migrations, plus row seeders.

use sqlx::SqlitePool;

pub struct TestDb {
    pool: SqlitePool,
    _dir: tempfile::TempDir,
}

impl std::ops::Deref for TestDb {
    type Target = SqlitePool;
    fn deref(&self) -> &SqlitePool {
        &self.pool
    }
}

pub async fn pool() -> TestDb {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(dir.path().join("server.db").to_str().unwrap())
        .await
        .unwrap();
    TestDb { pool, _dir: dir }
}

/// An active member row (what the dropped addMember / a redeem would write).
pub async fn add_member(pool: &SqlitePool, sub: &str, role: &str, auth_mode: &str) {
    add_named_member(pool, sub, None, role, auth_mode).await;
}

pub async fn add_named_member(
    pool: &SqlitePool,
    sub: &str,
    display_name: Option<&str>,
    role: &str,
    auth_mode: &str,
) {
    sqlx::query(
        "INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at) \
         VALUES (?, ?, ?, ?, NULL, ?, NULL)",
    )
    .bind(sub)
    .bind(display_name)
    .bind(role)
    .bind(auth_mode)
    .bind(crate::now_iso())
    .execute(pool)
    .await
    .unwrap();
}

pub async fn set_revoked(pool: &SqlitePool, sub: &str) {
    sqlx::query("UPDATE members SET revoked_at = ? WHERE sub = ?")
        .bind(crate::now_iso())
        .bind(sub)
        .execute(pool)
        .await
        .unwrap();
}
