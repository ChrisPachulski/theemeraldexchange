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

/// tests/fixtures/auth-goldens.json, written by gen-auth-goldens.ts.
pub fn goldens() -> &'static serde_json::Value {
    static G: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    G.get_or_init(|| {
        serde_json::from_str(include_str!("../tests/fixtures/auth-goldens.json")).unwrap()
    })
}

/// A Config under the goldens' secrets and ADMIN_SUBS, plus `extra` env.
pub fn config(extra: &[(&str, &str)]) -> crate::config::Config {
    let g = goldens();
    let admin_subs: Vec<&str> = g["admin_subs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    let mut env: std::collections::HashMap<String, String> = [
        ("SESSION_SECRET", g["session_secret"].as_str().unwrap()),
        (
            "DEVICE_TOKEN_SECRET",
            g["device_token_secret"].as_str().unwrap(),
        ),
        (
            "STREAM_TOKEN_SECRET",
            "auth-goldens-stream-secret-0123456789abcdef",
        ),
        (
            "INTERNAL_PRINCIPAL_SECRET",
            "auth-goldens-internal-secret-0123456789abcdef",
        ),
        ("ADMIN_SUBS", &admin_subs.join(",")),
        ("SERVE_SPA", "0"),
    ]
    .into_iter()
    .chain(extra.iter().copied())
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    env.retain(|_, v| !v.is_empty());
    crate::config::Config::from_lookup(|k| env.get(k).cloned()).unwrap()
}

/// A fresh server.db and an AuthState over it (golden secrets, dev posture).
pub async fn state() -> (TestDb, crate::AuthState) {
    let db = pool().await;
    let state = crate::AuthState::new(db.pool.clone(), config(&[]));
    (db, state)
}

thread_local! {
    static LOGS: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

struct ThreadLogs;

impl std::io::Write for ThreadLogs {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        LOGS.with(|l| l.borrow_mut().extend_from_slice(b));
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// One global subscriber writing to a per-thread buffer: a thread-local
/// `set_default` loses events to tracing's global interest cache when other
/// tests run concurrently. A current-thread tokio test logs on its own thread.
pub fn capture_logs() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .with_writer(|| ThreadLogs)
            .with_ansi(false)
            .finish();
        tracing::subscriber::set_global_default(subscriber).unwrap();
    });
    LOGS.with(|l| l.borrow_mut().clear());
}

pub fn logs() -> String {
    LOGS.with(|l| String::from_utf8(l.borrow().clone()).unwrap())
}
