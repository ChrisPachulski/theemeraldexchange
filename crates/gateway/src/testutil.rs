//! Test config, a temp server.db, one-shot requests and log capture.

use std::collections::HashMap;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use tower::ServiceExt;

use crate::AppState;
use crate::config::Config;

pub const SESSION_SECRET: &str = "gateway-test-session-secret-0123456789abcdef";

/// Dev config with distinct secrets, SPA off; `extra` wins.
pub fn config(extra: &[(&str, &str)]) -> Config {
    let mut map: HashMap<String, String> = [
        ("SESSION_SECRET", SESSION_SECRET),
        (
            "STREAM_TOKEN_SECRET",
            "gateway-test-stream-secret-0123456789abcdef",
        ),
        (
            "DEVICE_TOKEN_SECRET",
            "gateway-test-device-secret-0123456789abcdef",
        ),
        (
            "INTERNAL_PRINCIPAL_SECRET",
            "gateway-test-internal-secret-0123456789ab",
        ),
        ("SERVE_SPA", "0"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    for (k, v) in extra {
        map.insert(k.to_string(), v.to_string());
    }
    Config::from_lookup(|k| map.get(k).cloned()).unwrap()
}

/// State over a fresh server.db in `dir` (kept alive by the caller).
pub async fn state_in(dir: &tempfile::TempDir, extra: &[(&str, &str)]) -> AppState {
    let db = dir.path().join("server.db");
    let mut extra = extra.to_vec();
    let db = db.to_str().unwrap().to_string();
    extra.push(("SERVER_DB_PATH", &db));
    let config = config(&extra);
    let pool = auth::db::open(&config.auth.server_db_path).await.unwrap();
    AppState::new(pool, config)
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: String,
}

pub async fn send(app: &Router, req: Request<Body>) -> Reply {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    Reply {
        status,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

pub fn get_req(path: &str) -> Request<Body> {
    Request::get(path).body(Body::empty()).unwrap()
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

/// One global subscriber writing to a per-thread buffer (a current-thread
/// tokio test logs on its own thread).
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
