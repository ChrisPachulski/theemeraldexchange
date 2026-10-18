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
    let mut config = Config::from_lookup(|k| map.get(k).cloned()).unwrap();
    // Nothing a test forgets to point at a fake can leave the machine or run
    // a real yt-dlp/ffmpeg: port 9 on loopback refuses, the bins do not exist.
    let dead = "http://127.0.0.1:9";
    config.ext.tmdb_base = format!("{dead}/tmdb/3");
    config.ext.omdb_base = format!("{dead}/omdb/");
    config.ext.wikidata_sparql = format!("{dead}/wikidata/sparql");
    config.ext.rt_base = format!("{dead}/rt/");
    config.ext.anthropic_base = format!("{dead}/anthropic");
    for bin in [
        &mut config.ext.ytresolve_bin,
        &mut config.ext.ytdlp_bin,
        &mut config.ext.ffmpeg_bin,
        &mut config.ext.ffprobe_bin,
    ] {
        *bin = format!("/nonexistent/eex-test/{bin}");
    }
    config.ext.mux_dir = std::env::temp_dir().join("eex-test-ytmux-unused");
    config
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

/// State with server.db and the four JSON stores under `dir`.
pub async fn user_state(dir: &tempfile::TempDir, extra: &[(&str, &str)]) -> AppState {
    let p = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
    let paths = [
        ("USER_FEEDBACK_PATH", p("feedback.json")),
        ("REJECTIONS_PATH", p("rejections.json")),
        ("USER_WATCHLIST_PATH", p("watchlist.json")),
        ("USER_POLICIES_PATH", p("policies.json")),
    ];
    let mut env: Vec<(&str, &str)> = paths.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.extend_from_slice(extra);
    state_in(dir, &env).await
}

/// An active member row (what an invite redeem writes).
pub async fn add_member(st: &AppState, sub: &str, username: &str, role: &str) {
    sqlx::query(
        "INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at) \
         VALUES (?, ?, ?, ?, NULL, ?, NULL)",
    )
    .bind(sub)
    .bind(username)
    .bind(role)
    .bind(sub.split(':').next().unwrap())
    .bind(auth::now_iso())
    .execute(&st.auth.pool)
    .await
    .unwrap();
}

/// `eex.session=...` for `sub`; the role comes from its members row.
pub fn cookie(st: &AppState, sub: &str, username: &str) -> String {
    let session = auth::session::Session {
        sub: sub.into(),
        username: username.into(),
        role: auth::Role::User,
        auth_mode: auth::AuthMode::parse(sub.split(':').next().unwrap()).unwrap(),
        plex_auth_token: None,
    };
    let token = auth::session::mint(
        &st.auth.session_key,
        &session,
        chrono::Utc::now().timestamp(),
    );
    format!("eex.session={token}")
}

/// A member with a cookie, in one call.
pub async fn member(st: &AppState, sub: &str, username: &str, role: &str) -> String {
    add_member(st, sub, username, role).await;
    cookie(st, sub, username)
}

/// A request with an optional cookie and JSON body.
pub fn json_req(
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<&serde_json::Value>,
) -> Request<Body> {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(c) = cookie {
        b = b.header("cookie", c);
    }
    match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    }
}

pub const ALICE: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";
pub const BOB: &str = "google:1234567890";
pub const CAROL: &str = "workos:user_01E4ZCR3C56J083X43JQXF3JK5";
pub const ADMIN: &str = "local:01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// One request the fake recommender saw.
#[derive(Clone, Debug)]
pub struct RecCall {
    pub method: String,
    /// Path and query.
    pub path: String,
    pub secret: Option<String>,
    pub bearer: Option<String>,
    pub body: serde_json::Value,
}

/// A local stand-in for the recommender sidecar: records every call and
/// answers 200 `{}`; GET /metrics/funnel echoes its window, and the status
/// for any path can be overridden.
#[derive(Clone)]
pub struct FakeRecommender {
    pub url: String,
    calls: std::sync::Arc<std::sync::Mutex<Vec<RecCall>>>,
    status: std::sync::Arc<std::sync::Mutex<HashMap<String, (u16, String)>>>,
}

impl FakeRecommender {
    pub async fn start() -> FakeRecommender {
        let fake = FakeRecommender {
            url: String::new(),
            calls: Default::default(),
            status: Default::default(),
        };
        let state = fake.clone();
        let app = Router::new().fallback(move |req: Request<Body>| {
            let state = state.clone();
            async move { state.handle(req).await }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FakeRecommender { url, ..fake }
    }

    async fn handle(&self, req: Request<Body>) -> axum::response::Response {
        use axum::response::IntoResponse;
        let (secret, bearer) = {
            let header = |k: &str| {
                req.headers()
                    .get(k)
                    .map(|v| v.to_str().unwrap().to_string())
            };
            (
                header("x-recommender-secret"),
                header("authorization").map(|v| v.trim_start_matches("Bearer ").to_string()),
            )
        };
        let method = req.method().to_string();
        let path = req.uri().path_and_query().unwrap().to_string();
        let bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        self.calls.lock().unwrap().push(RecCall {
            method,
            path: path.clone(),
            secret,
            bearer,
            body,
        });
        let route = path.split('?').next().unwrap().to_string();
        if let Some((code, text)) = self.status.lock().unwrap().get(&route).cloned() {
            return (StatusCode::from_u16(code).unwrap(), text).into_response();
        }
        if route == "/metrics/funnel" {
            let wd = path.split("window_days=").nth(1).unwrap_or("?");
            let text = format!(
                r#"{{"window_days":{wd},"impressions":10,"rates":{{"added":0.25,"clicked":0.5}}}}"#
            );
            return ([("content-type", "application/json")], text).into_response();
        }
        ([("content-type", "application/json")], "{}").into_response()
    }

    /// Answer `path` with this status and body from now on.
    pub fn fail(&self, path: &str, status: u16, body: &str) {
        self.status
            .lock()
            .unwrap()
            .insert(path.to_string(), (status, body.to_string()));
    }

    /// Wait for the fire-and-forget mirrors to land (no new call for 100 ms),
    /// then take what arrived.
    pub async fn settle(&self) -> Vec<RecCall> {
        let mut seen = usize::MAX;
        loop {
            let n = self.calls.lock().unwrap().len();
            if n == seen {
                break;
            }
            seen = n;
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
}
