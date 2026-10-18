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

/// Insert golden rows verbatim (every column the TS DB held).
pub async fn insert_rows(pool: &SqlitePool, table: &str, rows: &Value) {
    for row in rows.as_array().unwrap() {
        let row = row.as_object().unwrap();
        let cols: Vec<&str> = row.keys().map(String::as_str).collect();
        let sql = format!(
            "INSERT INTO {table} ({}) VALUES ({})",
            cols.join(", "),
            vec!["?"; cols.len()].join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for v in row.values() {
            q = match v {
                Value::Null => q.bind(None::<String>),
                Value::Number(n) => q.bind(n.as_i64().unwrap()),
                v => q.bind(v.as_str().unwrap().to_string()),
            };
        }
        q.execute(pool).await.unwrap();
    }
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

// ── Identity tokens: committed test-only RSA keys and a local JWKS server ──

use std::sync::Arc;
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair, RsaPublicKeyComponents};
use serde_json::{Value, json};

pub const TEST_KID: &str = "test-kid";

/// tests/fixtures/jwks-test-key.pk8: the key the local JWKS serves.
pub fn test_key() -> RsaKeyPair {
    RsaKeyPair::from_pkcs8(include_bytes!("../tests/fixtures/jwks-test-key.pk8")).unwrap()
}

/// tests/fixtures/jwks-other-key.pk8: never served (a forged signature).
pub fn other_key() -> RsaKeyPair {
    RsaKeyPair::from_pkcs8(include_bytes!("../tests/fixtures/jwks-other-key.pk8")).unwrap()
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The public JWK of `key` under `kid`.
pub fn jwk(key: &RsaKeyPair, kid: &str) -> Value {
    let c: RsaPublicKeyComponents<Vec<u8>> = key.public().into();
    json!({ "kty": "RSA", "alg": "RS256", "use": "sig", "kid": kid, "n": b64(&c.n), "e": b64(&c.e) })
}

fn signing_input(header: &Value, claims: &Value) -> String {
    format!(
        "{}.{}",
        b64(header.to_string().as_bytes()),
        b64(claims.to_string().as_bytes())
    )
}

/// An RS256 compact JWS of `claims` under `header`.
pub fn sign(key: &RsaKeyPair, header: &Value, claims: &Value) -> String {
    let input = signing_input(header, claims);
    let mut sig = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        input.as_bytes(),
        &mut sig,
    )
    .unwrap();
    format!("{input}.{}", b64(&sig))
}

/// An HS256 compact JWS keyed by `secret` (the RS/HS confusion attack).
pub fn sign_hs256(secret: &[u8], header: &Value, claims: &Value) -> String {
    let input = signing_input(header, claims);
    let tag = ring::hmac::sign(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret),
        input.as_bytes(),
    );
    format!("{input}.{}", b64(tag.as_ref()))
}

/// An unsigned (alg none) token.
pub fn unsigned(claims: &Value) -> String {
    format!(
        "{}.",
        signing_input(&json!({ "alg": "none", "kid": TEST_KID }), claims)
    )
}

/// A local JWKS endpoint. Tests change what it serves through the handles.
pub struct JwksServer {
    pub url: String,
    pub hits: Arc<AtomicUsize>,
    pub keys: Arc<std::sync::Mutex<Vec<Value>>>,
    pub status: Arc<AtomicU16>,
    pub delay_ms: Arc<AtomicU64>,
}

impl JwksServer {
    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

#[derive(Clone)]
struct Served {
    hits: Arc<AtomicUsize>,
    keys: Arc<std::sync::Mutex<Vec<Value>>>,
    status: Arc<AtomicU16>,
    delay_ms: Arc<AtomicU64>,
}

async fn serve_keys(
    axum::extract::State(s): axum::extract::State<Served>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    s.hits.fetch_add(1, Ordering::SeqCst);
    let delay = s.delay_ms.load(Ordering::SeqCst);
    if delay > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
    let status = axum::http::StatusCode::from_u16(s.status.load(Ordering::SeqCst)).unwrap();
    let keys = s.keys.lock().unwrap().clone();
    (status, axum::Json(json!({ "keys": keys }))).into_response()
}

/// Serve `keys` at http://127.0.0.1:<port>/keys.
pub async fn jwks_server(keys: Vec<Value>) -> JwksServer {
    let served = Served {
        hits: Arc::default(),
        keys: Arc::new(std::sync::Mutex::new(keys)),
        status: Arc::new(AtomicU16::new(200)),
        delay_ms: Arc::default(),
    };
    let app = axum::Router::new()
        .route("/keys", axum::routing::get(serve_keys))
        .with_state(served.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/keys", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    JwksServer {
        url,
        hits: served.hits,
        keys: served.keys,
        status: served.status,
        delay_ms: served.delay_ms,
    }
}

/// A URL nothing listens on (connection refused).
pub async fn dead_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    format!("http://{}/keys", listener.local_addr().unwrap())
}

pub fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

// ── Route helpers ──

pub struct Reply {
    pub status: u16,
    pub headers: axum::http::HeaderMap,
    /// The raw body text (the route goldens compare it byte for byte).
    pub text: String,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }
}

/// Send one request through `app`. `body` is sent as-is.
pub async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Reply {
    use tower::ServiceExt;
    let mut req = axum::http::Request::builder().method(method).uri(path);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let body = match body {
        Some(b) => axum::body::Body::from(b.to_string()),
        None => axum::body::Body::empty(),
    };
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    Reply {
        status,
        headers,
        text: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

/// `Cookie: eex.session=...` for `sub` (role and provider as given).
pub fn cookie(st: &crate::AuthState, sub: &str, username: &str, role: crate::Role) -> String {
    let session = crate::session::Session {
        sub: sub.into(),
        username: username.into(),
        role,
        auth_mode: crate::AuthMode::parse(crate::sub_namespace(sub)).unwrap(),
        plex_auth_token: None,
    };
    format!(
        "eex.session={}",
        crate::session::mint(&st.session_key, &session, unix_now())
    )
}

/// Mint a device token (and its row) for `sub`.
pub async fn device_token(st: &crate::AuthState, sub: &str, device_id: &str, name: &str) -> String {
    crate::device_tokens::mint(
        &st.pool,
        st.device_keys.as_deref().unwrap(),
        &crate::device_tokens::MintInput {
            sub,
            role: crate::Role::User,
            auth_mode: crate::AuthMode::parse(crate::sub_namespace(sub)).unwrap(),
            device_id,
            device_platform: "tvos",
            device_name: name,
            username: None,
            server_id: "01HXYZ01234567890ABCDEFGHJ",
        },
    )
    .await
    .unwrap()
}

/// `METHOD path` and the Authorization header, per request.
pub type Calls = Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>;

/// A local stand-in for the iptv service: records `METHOD path` and the
/// Authorization header of every request, answers `status` with {"ok":true}.
pub struct IptvStub {
    pub url: String,
    pub calls: Calls,
    pub status: Arc<AtomicU16>,
}

impl IptvStub {
    pub fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(c, _)| c.clone())
            .collect()
    }
}

pub async fn iptv_stub() -> IptvStub {
    #[derive(Clone)]
    struct S {
        calls: Calls,
        status: Arc<AtomicU16>,
    }
    async fn any(
        axum::extract::State(s): axum::extract::State<S>,
        req: axum::extract::Request,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        let auth = req
            .headers()
            .get(axum::http::header::AUTHORIZATION)
            .map(|v| v.to_str().unwrap().to_string());
        s.calls
            .lock()
            .unwrap()
            .push((format!("{} {}", req.method(), req.uri()), auth));
        let status = axum::http::StatusCode::from_u16(s.status.load(Ordering::SeqCst)).unwrap();
        (status, axum::Json(json!({ "ok": true }))).into_response()
    }
    let s = S {
        calls: Arc::default(),
        status: Arc::new(AtomicU16::new(200)),
    };
    let app = axum::Router::new().fallback(any).with_state(s.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    IptvStub {
        url,
        calls: s.calls,
        status: s.status,
    }
}
