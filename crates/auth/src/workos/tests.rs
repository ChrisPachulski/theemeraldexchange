//! workosAuth.test.ts and workosNative.test.ts, plus the redirect flow
//! (/start, /callback) and /api/auth/logout. The TS suites stubbed fetch;
//! here every exchange goes to a local fake WorkOS (an axum server on
//! 127.0.0.1), and authZ runs on a real server.db. Nothing calls
//! api.workos.com.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{Request, header};
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::invites::IssueOptions;
use crate::testutil::*;
use crate::{AuthState, Role};

const USER_ID: &str = "user_01E4ZCR3C56J083X43JQXF3JK5";
const SUB: &str = "workos:user_01M12813GMJQQ4DXDWTBRC75G2";
const ISSUER: &str = "workos:user_01E4ZCR3C56J083X43JQXF3JK5";
const SPA: &str = "https://app.example.test";
const REDIRECT: &str = "https://api.example.test/api/auth/workos/callback";
const VERIFIER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHALLENGE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DEVICE: [(&str, &str); 3] = [
    ("device_id", "ulid-phone-1"),
    ("device_name", "Ana's iPhone"),
    ("device_platform", "ios"),
];

// ── The fake WorkOS ──

/// Records every request (path, JSON body) and answers with `reply`.
#[derive(Clone)]
struct Fake {
    url: String,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    reply: Arc<Mutex<(u16, String)>>,
    delay_ms: Arc<AtomicU64>,
}

impl Fake {
    fn reply(&self, status: u16, body: Value) {
        *self.reply.lock().unwrap() = (status, body.to_string());
    }

    fn reply_raw(&self, status: u16, body: &str) {
        *self.reply.lock().unwrap() = (status, body.into());
    }

    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

fn user_reply(id: &str) -> Value {
    json!({ "user": { "id": id, "email": "ana@example.test", "first_name": "Ana" } })
}

async fn fake_workos() -> Fake {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake = Fake {
        url: format!("http://{}", listener.local_addr().unwrap()),
        calls: Arc::default(),
        reply: Arc::new(Mutex::new((
            200,
            user_reply(SUB.strip_prefix("workos:").unwrap()).to_string(),
        ))),
        delay_ms: Arc::default(),
    };
    let served = fake.clone();
    let app = axum::Router::new().fallback(move |uri: Uri, body: Bytes| {
        let f = served.clone();
        async move {
            let parsed = serde_json::from_slice(&body).unwrap_or(Value::Null);
            f.calls
                .lock()
                .unwrap()
                .push((uri.path().to_string(), parsed));
            let delay = f.delay_ms.load(Ordering::SeqCst);
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            let (status, body) = f.reply.lock().unwrap().clone();
            (
                StatusCode::from_u16(status).unwrap(),
                [(header::CONTENT_TYPE, "application/json")],
                body,
            )
                .into_response()
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fake
}

// ── Harness ──

struct Harness {
    db: TestDb,
    st: AuthState,
    fake: Fake,
}

impl Harness {
    fn app(&self) -> axum::Router {
        crate::router(self.st.clone())
    }
}

fn workos_env() -> Vec<(&'static str, &'static str)> {
    vec![
        ("WORKOS_CLIENT_ID", "client_test"),
        ("WORKOS_API_KEY", "sk_test"),
        ("WORKOS_REDIRECT_URI", REDIRECT),
        ("ALLOWED_ORIGINS", SPA),
    ]
}

async fn harness(extra: &[(&str, &str)]) -> Harness {
    let db = pool().await;
    let mut env = workos_env();
    env.extend_from_slice(extra);
    let mut st = AuthState::new((*db).clone(), config(&env));
    let fake = fake_workos().await;
    st.workos = Arc::new(Workos::at(&fake.url));
    Harness { db, st, fake }
}

async fn member(h: &Harness) {
    add_member(&h.db, SUB, "user", "workos").await;
}

struct Reply {
    status: u16,
    body: Value,
    location: Option<String>,
    cookies: Vec<String>,
}

impl Reply {
    fn cookie(&self, name: &str) -> Option<&str> {
        self.cookies
            .iter()
            .find(|c| c.starts_with(&format!("{name}=")))
            .map(String::as_str)
    }

    fn location_url(&self) -> reqwest::Url {
        reqwest::Url::parse(self.location.as_deref().expect("a Location")).unwrap()
    }
}

async fn send(
    app: &axum::Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> Reply {
    let mut req = Request::builder().method(method).uri(path);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let body = match body {
        Some(b) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let location = res
        .headers()
        .get(header::LOCATION)
        .map(|v| v.to_str().unwrap().to_string());
    let cookies = res
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        location,
        cookies,
    }
}

async fn post(h: &Harness, path: &str, body: Value) -> Reply {
    send(&h.app(), "POST", path, &[], Some(body)).await
}

fn with_device(mut body: Value) -> Value {
    for (k, v) in DEVICE {
        body[k] = v.into();
    }
    body
}

fn param(url: &reqwest::Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

async fn invite(h: &Harness) -> String {
    crate::invites::issue(
        &h.db,
        ISSUER,
        IssueOptions {
            label: None,
            role: Role::User,
            expires_in_days: None,
            max_uses: 1,
        },
    )
    .await
    .unwrap()
    .code
}

// ── workosAuth.test.ts: the authorize URL ──

#[test]
fn authorize_url_carries_client_id_registered_redirect_authkit_and_state() {
    let cfg = config(&workos_env());
    let url =
        reqwest::Url::parse(&Workos::new().authorize_url(&cfg, "nonce-1", None, None)).unwrap();
    assert_eq!(
        format!("{}{}", url.origin().ascii_serialization(), url.path()),
        "https://api.workos.com/user_management/authorize"
    );
    assert_eq!(param(&url, "client_id").as_deref(), Some("client_test"));
    assert_eq!(param(&url, "redirect_uri").as_deref(), Some(REDIRECT));
    assert_eq!(param(&url, "response_type").as_deref(), Some("code"));
    assert_eq!(param(&url, "provider").as_deref(), Some("authkit"));
    assert_eq!(param(&url, "state").as_deref(), Some("nonce-1"));
    assert_eq!(param(&url, "client_secret"), None);
    assert_eq!(param(&url, "code_challenge"), None);
    assert!(!url.as_str().contains("sk_test"));
}

#[test]
fn authorize_url_deep_links_google_and_apple_and_nothing_else() {
    let cfg = config(&workos_env());
    let w = Workos::new();
    let provider = |p| {
        let url = reqwest::Url::parse(&w.authorize_url(&cfg, "n", Some(p), None)).unwrap();
        param(&url, "provider").unwrap()
    };
    assert_eq!(provider("google"), "GoogleOAuth");
    assert_eq!(provider("apple"), "AppleOAuth");
    // TS's `in` let inherited keys through (toString -> a function's source).
    for other in ["toString", "constructor", "__proto__", "GoogleOAuth", ""] {
        assert_eq!(provider(other), "authkit", "{other}");
    }
}

// ── workosAuth.test.ts: the code exchange ──

#[tokio::test]
async fn exchange_returns_the_contract_sub_plus_name_and_email() {
    let fake = fake_workos().await;
    fake.reply(
        200,
        json!({ "user": { "id": USER_ID, "email": "a@b.test", "first_name": "Ada", "last_name": "L" } }),
    );
    let cfg = config(&workos_env());
    let id = Workos::at(&fake.url)
        .exchange(&cfg, "code-1", None)
        .await
        .unwrap();
    assert_eq!(
        id,
        Identity {
            sub: format!("workos:{USER_ID}"),
            email: Some("a@b.test".into()),
            name: Some("Ada L".into()),
        }
    );
    let calls = fake.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "/user_management/authenticate");
    assert_eq!(
        calls[0].1,
        json!({
            "client_id": "client_test",
            "client_secret": "sk_test",
            "grant_type": "authorization_code",
            "code": "code-1",
        })
    );
}

#[tokio::test]
async fn exchange_skips_blank_name_parts_and_non_string_fields() {
    let fake = fake_workos().await;
    let cfg = config(&workos_env());
    let w = Workos::at(&fake.url);
    fake.reply(
        200,
        json!({ "user": { "id": USER_ID, "first_name": "  ", "last_name": "Lovelace", "email": 7 } }),
    );
    let id = w.exchange(&cfg, "c", None).await.unwrap();
    assert_eq!((id.name.as_deref(), id.email), (Some("Lovelace"), None));
    fake.reply(200, json!({ "user": { "id": USER_ID, "first_name": 1 } }));
    assert_eq!(w.exchange(&cfg, "c", None).await.unwrap().name, None);
}

#[tokio::test]
async fn exchange_maps_4xx_to_code_invalid_and_5xx_or_network_to_unavailable() {
    let fake = fake_workos().await;
    let cfg = config(&workos_env());
    let w = Workos::at(&fake.url);
    fake.reply(400, json!({ "error": "invalid_grant" }));
    assert_eq!(
        w.exchange(&cfg, "bad", None).await,
        Err(ExchangeError::CodeInvalid)
    );
    fake.reply(503, json!({}));
    assert_eq!(
        w.exchange(&cfg, "x", None).await,
        Err(ExchangeError::ProviderUnavailable)
    );
    fake.reply_raw(200, "not json");
    assert_eq!(
        w.exchange(&cfg, "x", None).await,
        Err(ExchangeError::CodeInvalid)
    );
    let dead = dead_url().await;
    let dead = dead.trim_end_matches("/keys");
    assert_eq!(
        Workos::at(dead).exchange(&cfg, "x", None).await,
        Err(ExchangeError::ProviderUnavailable)
    );
}

#[tokio::test]
async fn exchange_gives_up_after_the_timeout() {
    let fake = fake_workos().await;
    fake.delay_ms.store(2_000, Ordering::SeqCst);
    let mut w = Workos::at(&fake.url);
    assert_eq!(w.timeout, Duration::from_secs(15));
    w.timeout = Duration::from_millis(100);
    let started = Instant::now();
    assert_eq!(
        w.exchange(&config(&workos_env()), "x", None).await,
        Err(ExchangeError::ProviderUnavailable)
    );
    assert!(started.elapsed() < Duration::from_millis(1_500));
}

#[tokio::test]
async fn exchange_rejects_a_user_id_outside_the_workos_contract() {
    let fake = fake_workos().await;
    let cfg = config(&workos_env());
    let w = Workos::at(&fake.url);
    for reply in [
        json!({ "user": { "id": "user_lowercase" } }),
        json!({ "user": {} }),
        json!({ "user": { "id": 42 } }),
        json!({}),
        json!(null),
        json!([1]),
    ] {
        fake.reply(200, reply.clone());
        assert_eq!(
            w.exchange(&cfg, "x", None).await,
            Err(ExchangeError::BadSubject),
            "{reply}"
        );
    }
}

// ── The state compare ──

#[test]
fn state_matches_only_the_exact_non_empty_nonce() {
    let nonce = "0123456789abcdef0123456789abcdef";
    assert!(state_matches(nonce, nonce));
    for got in [
        "",
        &nonce[..31],
        &nonce[..1],
        &format!("{nonce}0"),
        &format!("{nonce}{nonce}"),
        "0123456789abcdef0123456789abcdee",
        "1123456789abcdef0123456789abcdef",
    ] {
        assert!(!state_matches(nonce, got), "{got}");
    }
    assert!(!state_matches("", ""));
}

/// A plain `==` would pass every functional test, so the compare's source is
/// pinned: constant time through subtle, with the length checked first.
#[test]
fn the_state_compare_stays_constant_time_and_length_checked() {
    let src = include_str!("../workos.rs");
    let start = src.find("fn state_matches(").unwrap();
    let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
    assert!(body.contains(".ct_eq("), "{body}");
    assert!(body.contains("expected.len() == got.len()"), "{body}");
    let rest = body.replace("expected.len() == got.len()", "");
    for banned in ["==", "!=", "starts_with", "ends_with", "contains", ".eq("] {
        assert!(!rest.contains(banned), "{banned} in {body}");
    }
}

// ── GET /api/auth/workos/start ──

#[tokio::test]
async fn start_503s_when_not_configured() {
    let h = harness(&[("WORKOS_API_KEY", "")]).await;
    let r = send(&h.app(), "GET", "/api/auth/workos/start", &[], None).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.body, json!({ "error": "workos_not_configured" }));
    assert!(r.cookies.is_empty());
}

#[tokio::test]
async fn start_parks_the_state_cookie_and_redirects_to_authkit() {
    let h = harness(&[]).await;
    let code = invite(&h).await;
    let r = send(
        &h.app(),
        "GET",
        &format!("/api/auth/workos/start?invite={code}&provider=google"),
        &[],
        None,
    )
    .await;
    assert_eq!(r.status, 302);
    assert_eq!(r.cookies.len(), 1);
    let cookie = r.cookie(STATE_COOKIE).unwrap();
    let value = cookie
        .strip_prefix("eex_workos_state=")
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let (nonce, parked) = value.split_once('.').unwrap();
    assert_eq!(nonce.len(), 32);
    assert!(nonce.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(parked, code);
    assert_eq!(
        cookie,
        format!(
            "eex_workos_state={value}; Max-Age=600; Path=/api/auth/workos/callback; HttpOnly; SameSite=Lax"
        )
    );
    let url = r.location_url();
    assert!(url.as_str().starts_with(&h.fake.url));
    assert_eq!(url.path(), "/user_management/authorize");
    assert_eq!(param(&url, "state").as_deref(), Some(nonce));
    assert_eq!(param(&url, "provider").as_deref(), Some("GoogleOAuth"));
    assert_eq!(param(&url, "redirect_uri").as_deref(), Some(REDIRECT));
    assert!(!url.as_str().contains(&code));
    // A fresh nonce per start; the provider is never called here.
    let again = send(&h.app(), "GET", "/api/auth/workos/start", &[], None).await;
    assert_ne!(
        param(&again.location_url(), "state").as_deref(),
        Some(nonce)
    );
    assert_eq!(
        param(&again.location_url(), "provider").as_deref(),
        Some("authkit")
    );
    assert!(h.fake.calls().is_empty());
}

#[tokio::test]
async fn start_drops_an_invite_of_the_wrong_shape() {
    let h = harness(&[]).await;
    for bad in [
        "abcdefghijklmnopqrstu",
        "abcdefghijklmnopqrstuvw",
        "abcdefghijklmnopqrst.v",
        "abcdefghijklmnopqrst%3Bv",
        "",
    ] {
        let r = send(
            &h.app(),
            "GET",
            &format!("/api/auth/workos/start?invite={bad}"),
            &[],
            None,
        )
        .await;
        let cookie = r.cookie(STATE_COOKIE).unwrap();
        let value = cookie.split(';').next().unwrap();
        assert!(value.ends_with('.'), "{bad}: {value}");
    }
}

#[tokio::test]
async fn start_state_cookie_is_secure_in_production() {
    let db = pool().await;
    let mut cfg = config(&workos_env());
    cfg.is_prod = true;
    let st = AuthState::new((*db).clone(), cfg);
    let r = send(
        &crate::router(st),
        "GET",
        "/api/auth/workos/start",
        &[],
        None,
    )
    .await;
    assert_eq!(r.status, 302);
    assert!(
        r.cookie(STATE_COOKIE)
            .unwrap()
            .ends_with("; HttpOnly; Secure; SameSite=Lax")
    );
}

// ── GET /api/auth/workos/callback ──

/// Run /start, then call back with that nonce (or `state` instead).
async fn round_trip(h: &Harness, start_query: &str, state: Option<&str>, code: &str) -> Reply {
    let started = send(
        &h.app(),
        "GET",
        &format!("/api/auth/workos/start{start_query}"),
        &[],
        None,
    )
    .await;
    let cookie = started.cookie(STATE_COOKIE).unwrap();
    let pair = cookie.split(';').next().unwrap().to_string();
    let nonce = param(&started.location_url(), "state").unwrap();
    let state = state.unwrap_or(&nonce);
    send(
        &h.app(),
        "GET",
        &format!("/api/auth/workos/callback?code={code}&state={state}"),
        &[("cookie", &pair)],
        None,
    )
    .await
}

fn clears_state(r: &Reply) -> bool {
    r.cookie(STATE_COOKIE) == Some("eex_workos_state=; Max-Age=0; Path=/api/auth/workos/callback")
}

#[tokio::test]
async fn callback_signs_a_member_in_and_redirects_to_the_spa() {
    let h = harness(&[]).await;
    member(&h).await;
    let r = round_trip(&h, "", None, "code_123").await;
    assert_eq!(r.status, 302);
    assert_eq!(r.location.as_deref(), Some("https://app.example.test/"));
    assert!(clears_state(&r), "{:?}", r.cookies);
    let session = r.cookie("eex.session").unwrap();
    assert!(session.ends_with("; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax"));
    let calls = h.fake.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1["code"], "code_123");
    assert!(calls[0].1.get("code_verifier").is_none());

    let pair = session.split(';').next().unwrap();
    let me = send(&h.app(), "GET", "/api/me", &[("cookie", pair)], None).await;
    assert_eq!(me.status, 200);
    assert_eq!(
        me.body["user"],
        json!({ "sub": SUB, "username": "Ana", "role": "user", "auth_mode": "workos" })
    );
}

#[tokio::test]
async fn callback_rejects_a_bad_state_without_calling_workos() {
    let h = harness(&[]).await;
    member(&h).await;
    let app = h.app();
    let nonce = "0123456789abcdef0123456789abcdef";
    let cookie = format!("eex_workos_state={nonce}.");
    let cases: Vec<(Option<String>, String)> = vec![
        // No cookie at all.
        (None, format!("code=c&state={nonce}")),
        // An empty nonce never matches, not even an empty state.
        (Some("eex_workos_state=.".into()), "code=c&state=".into()),
        (Some("eex_workos_state=".into()), "code=c&state=".into()),
        (Some("eex_workos_state=.abc".into()), "code=c&state=".into()),
        // Prefix, extension, same-length mismatch, missing state.
        (
            Some(cookie.clone()),
            format!("code=c&state={}", &nonce[..16]),
        ),
        (Some(cookie.clone()), format!("code=c&state={nonce}00")),
        (
            Some(cookie.clone()),
            "code=c&state=0123456789abcdef0123456789abcdee".into(),
        ),
        (Some(cookie.clone()), "code=c".into()),
        // A good state with no code, or an empty one.
        (Some(cookie.clone()), format!("state={nonce}")),
        (Some(cookie.clone()), format!("code=&state={nonce}")),
    ];
    for (cookie, query) in cases {
        let headers: Vec<(&str, &str)> = cookie
            .as_deref()
            .map(|c| vec![("cookie", c)])
            .unwrap_or_default();
        let r = send(
            &app,
            "GET",
            &format!("/api/auth/workos/callback?{query}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(r.status, 302, "{cookie:?} {query}");
        assert_eq!(
            r.location.as_deref(),
            Some("https://app.example.test/?auth_error=workos_state_invalid"),
            "{cookie:?} {query}"
        );
        assert!(clears_state(&r), "{cookie:?} {query}");
        assert!(r.cookie("eex.session").is_none());
    }
    assert!(h.fake.calls().is_empty());
}

#[tokio::test]
async fn callback_compares_the_first_state_param() {
    let h = harness(&[]).await;
    member(&h).await;
    let nonce = "0123456789abcdef0123456789abcdef";
    let r = send(
        &h.app(),
        "GET",
        &format!("/api/auth/workos/callback?code=c&state=wrong&state={nonce}"),
        &[("cookie", &format!("eex_workos_state={nonce}."))],
        None,
    )
    .await;
    assert_eq!(
        param(&r.location_url(), "auth_error").as_deref(),
        Some("workos_state_invalid")
    );
}

#[tokio::test]
async fn callback_maps_exchange_failures_to_auth_errors() {
    let h = harness(&[]).await;
    member(&h).await;
    for (status, body, want) in [
        (503, json!({}), "workos_unavailable"),
        (500, json!({}), "workos_unavailable"),
        (
            400,
            json!({ "error": "invalid_grant" }),
            "workos_code_invalid",
        ),
        (
            200,
            json!({ "user": { "id": "user_lowercase" } }),
            "workos_code_invalid",
        ),
    ] {
        h.fake.reply(status, body);
        let r = round_trip(&h, "", None, "c").await;
        assert_eq!(r.status, 302);
        assert_eq!(
            param(&r.location_url(), "auth_error").as_deref(),
            Some(want),
            "{status}"
        );
        assert!(clears_state(&r));
        assert!(r.cookie("eex.session").is_none());
    }
}

#[tokio::test]
async fn callback_denies_a_non_member_without_an_invite() {
    let h = harness(&[]).await;
    let r = round_trip(&h, "", None, "c").await;
    assert_eq!(
        r.location.as_deref(),
        Some("https://app.example.test/?auth_error=no_invite")
    );
    assert!(clears_state(&r));
    assert!(r.cookie("eex.session").is_none());
}

#[tokio::test]
async fn callback_redeems_the_invite_parked_at_start() {
    let h = harness(&[]).await;
    let code = invite(&h).await;
    let r = round_trip(&h, &format!("?invite={code}"), None, "c").await;
    assert_eq!(r.location.as_deref(), Some("https://app.example.test/"));
    assert!(r.cookie("eex.session").is_some());
    let row: (Option<String>, String) =
        sqlx::query_as("SELECT display_name, auth_mode FROM members WHERE sub = ?")
            .bind(SUB)
            .fetch_one(&*h.db)
            .await
            .unwrap();
    assert_eq!(row, (Some("Ana".into()), "workos".into()));
}

#[tokio::test]
async fn callback_admin_subs_identity_gets_an_admin_session() {
    let h = harness(&[]).await;
    h.fake.reply(200, user_reply(USER_ID));
    assert!(h.st.config.admin_subs.iter().any(|s| s == ISSUER));
    let r = round_trip(&h, "", None, "c").await;
    let pair = r
        .cookie("eex.session")
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let me = send(&h.app(), "GET", "/api/me", &[("cookie", &pair)], None).await;
    assert_eq!(me.body["user"]["role"], "admin");
}

#[tokio::test]
async fn callback_redirects_to_the_request_origin_when_serving_the_spa() {
    let h = harness(&[("SERVE_SPA", "1"), ("ALLOWED_ORIGINS", "")]).await;
    let nonce = "0123456789abcdef0123456789abcdef";
    let r = send(
        &h.app(),
        "GET",
        "/api/auth/workos/callback?code=c&state=x",
        &[
            ("host", "eex.example.test:8080"),
            ("cookie", &format!("eex_workos_state={nonce}.")),
        ],
        None,
    )
    .await;
    assert_eq!(
        r.location.as_deref(),
        Some("http://eex.example.test:8080/?auth_error=workos_state_invalid")
    );
}

#[tokio::test]
async fn callback_without_an_spa_origin_redirects_relative() {
    let h = harness(&[("ALLOWED_ORIGINS", "")]).await;
    let r = send(&h.app(), "GET", "/api/auth/workos/callback", &[], None).await;
    assert_eq!(
        r.location.as_deref(),
        Some("/?auth_error=workos_state_invalid")
    );
}

#[tokio::test]
async fn callback_503s_when_not_configured_and_keeps_the_cookie() {
    let h = harness(&[("WORKOS_CLIENT_ID", "")]).await;
    let r = send(&h.app(), "GET", "/api/auth/workos/callback", &[], None).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.body, json!({ "error": "workos_not_configured" }));
    assert!(r.cookies.is_empty());
}

#[tokio::test]
async fn callback_and_native_share_the_workos_rate_limit() {
    let h = harness(&[("TRUST_CLIENT_IP_HEADERS", "1")]).await;
    let app = h.app();
    let ip = [("cf-connecting-ip", "203.0.113.7")];
    for _ in 0..10 {
        let r = send(&app, "GET", "/api/auth/workos/callback", &ip, None).await;
        assert_eq!(r.status, 302);
        let r = send(
            &app,
            "POST",
            "/api/auth/workos/native",
            &ip,
            Some(json!({})),
        )
        .await;
        assert_eq!(r.status, 400);
    }
    for (method, path) in [
        ("GET", "/api/auth/workos/callback"),
        ("POST", "/api/auth/workos/native"),
    ] {
        let r = send(&app, method, path, &ip, Some(json!({}))).await;
        assert_eq!(r.status, 429, "{path}");
        assert_eq!(r.body, json!({ "error": "rate_limited" }));
    }
    // /start has no limiter.
    let r = send(&app, "GET", "/api/auth/workos/start", &ip, None).await;
    assert_eq!(r.status, 302);
}

#[tokio::test]
async fn callback_logs_one_outcome_without_the_code_or_the_api_key() {
    let h = harness(&[]).await;
    member(&h).await;
    capture_logs();
    let r = round_trip(&h, "", None, "SECRETCODE123").await;
    assert_eq!(r.status, 302);
    let out = logs();
    let lines: Vec<&str> = out.lines().filter(|l| l.contains("auth_outcome")).collect();
    assert_eq!(lines.len(), 1, "{out}");
    for want in [
        "provider=\"workos\"",
        "phase=\"identity_verify\"",
        "outcome=\"authorized\"",
        "reason=\"cookie\"",
    ] {
        assert!(lines[0].contains(want), "{want} in {}", lines[0]);
    }
    for secret in ["SECRETCODE123", "sk_test", SUB] {
        assert!(!out.contains(secret), "{secret} in {out}");
    }
}

// ── workosNative.test.ts: POST /api/auth/workos/native/start ──

#[tokio::test]
async fn native_start_returns_an_authkit_url_bound_to_the_native_redirect_and_challenge() {
    let h = harness(&[]).await;
    let r = post(
        &h,
        "/api/auth/workos/native/start",
        json!({ "code_challenge": CHALLENGE }),
    )
    .await;
    assert_eq!(r.status, 200);
    let url = reqwest::Url::parse(r.body["url"].as_str().unwrap()).unwrap();
    assert_eq!(
        param(&url, "redirect_uri").as_deref(),
        Some("emerald://auth/workos")
    );
    assert_eq!(param(&url, "code_challenge").as_deref(), Some(CHALLENGE));
    assert_eq!(
        param(&url, "code_challenge_method").as_deref(),
        Some("S256")
    );
    assert_eq!(param(&url, "provider").as_deref(), Some("authkit"));
    assert_eq!(param(&url, "state").as_deref(), r.body["state"].as_str());
    assert_eq!(r.body["redirect_uri"], "emerald://auth/workos");

    let r = post(
        &h,
        "/api/auth/workos/native/start",
        json!({ "code_challenge": CHALLENGE, "provider": "apple" }),
    )
    .await;
    let url = reqwest::Url::parse(r.body["url"].as_str().unwrap()).unwrap();
    assert_eq!(param(&url, "provider").as_deref(), Some("AppleOAuth"));
}

#[tokio::test]
async fn native_start_uses_the_configured_native_redirect() {
    let h = harness(&[("WORKOS_NATIVE_REDIRECT_URI", "emerald-dev://auth/workos")]).await;
    let r = post(
        &h,
        "/api/auth/workos/native/start",
        json!({ "code_challenge": CHALLENGE }),
    )
    .await;
    assert_eq!(r.body["redirect_uri"], "emerald-dev://auth/workos");
}

#[tokio::test]
async fn native_start_rejects_a_malformed_challenge() {
    let h = harness(&[]).await;
    for body in [
        json!({ "code_challenge": "short" }),
        json!({ "code_challenge": format!("{CHALLENGE}b") }),
        json!({ "code_challenge": format!("{}+", &CHALLENGE[..42]) }),
        json!({ "code_challenge": 43 }),
        json!({}),
    ] {
        let r = post(&h, "/api/auth/workos/native/start", body.clone()).await;
        assert_eq!(r.status, 400, "{body}");
        assert_eq!(r.body, json!({ "error": "invalid_code_challenge" }));
    }
}

#[tokio::test]
async fn native_start_caps_the_body_and_503s_when_not_configured() {
    let h = harness(&[]).await;
    let big = json!({ "code_challenge": CHALLENGE, "pad": "x".repeat(1100) });
    let r = post(&h, "/api/auth/workos/native/start", big).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.body, json!({ "error": "body_too_large" }));

    let h = harness(&[("WORKOS_REDIRECT_URI", "")]).await;
    for path in ["/api/auth/workos/native/start", "/api/auth/workos/native"] {
        let r = post(&h, path, json!({ "code_challenge": CHALLENGE })).await;
        assert_eq!(r.status, 503, "{path}");
        assert_eq!(r.body, json!({ "error": "workos_not_configured" }));
    }
}

// ── workosNative.test.ts: POST /api/auth/workos/native ──

async fn native_state(h: &Harness) -> String {
    let r = post(
        h,
        "/api/auth/workos/native/start",
        json!({ "code_challenge": CHALLENGE }),
    )
    .await;
    r.body["state"].as_str().unwrap().to_string()
}

fn exchange_body(state: &str) -> Value {
    with_device(json!({ "code": "code_123", "code_verifier": VERIFIER, "state": state }))
}

#[tokio::test]
async fn native_exchanges_code_and_verifier_and_mints_a_device_token() {
    let h = harness(&[]).await;
    member(&h).await;
    let state = native_state(&h).await;
    let r = post(&h, "/api/auth/workos/native", exchange_body(&state)).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.body["status"], "authorized");
    assert_eq!(r.body["user"]["sub"], SUB);
    assert_eq!(r.body["user"]["username"], "Ana");
    assert!(r.body["token"].as_str().unwrap().len() > 100);
    assert!(r.cookies.is_empty());
    let calls = h.fake.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1["grant_type"], "authorization_code");
    assert_eq!(calls[0].1["code"], "code_123");
    assert_eq!(calls[0].1["code_verifier"], VERIFIER);

    // The token is a working Bearer for this member.
    let bearer = format!("Bearer {}", r.body["token"].as_str().unwrap());
    let me = send(
        &h.app(),
        "GET",
        "/api/me",
        &[("authorization", &bearer)],
        None,
    )
    .await;
    assert_eq!(me.status, 200);
    assert_eq!(me.body["user"]["auth_mode"], "workos");
}

#[tokio::test]
async fn native_refuses_a_replayed_unknown_or_expired_state() {
    let h = harness(&[]).await;
    member(&h).await;
    let state = native_state(&h).await;
    assert_eq!(
        post(&h, "/api/auth/workos/native", exchange_body(&state))
            .await
            .status,
        200
    );
    for state in [state.as_str(), "nope", ""] {
        let r = post(&h, "/api/auth/workos/native", exchange_body(state)).await;
        assert_eq!(r.status, 400, "{state}");
        assert_eq!(r.body, json!({ "error": "invalid_request" }));
    }
    let expired =
        h.st.workos
            .native_states
            .issue_at(Instant::now() - Duration::from_secs(601));
    let r = post(&h, "/api/auth/workos/native", exchange_body(&expired)).await;
    assert_eq!(r.status, 400);
    assert_eq!(h.fake.calls().len(), 1);
}

#[tokio::test]
async fn native_burns_the_state_on_a_malformed_request() {
    let h = harness(&[]).await;
    member(&h).await;
    for bad in [
        json!({ "code_verifier": "a".repeat(42) }),
        json!({ "code_verifier": "a".repeat(129) }),
        json!({ "code_verifier": format!("{}=", "a".repeat(42)) }),
        json!({ "code": "" }),
        json!({ "code": 5 }),
    ] {
        let state = native_state(&h).await;
        let mut body = exchange_body(&state);
        for (k, v) in bad.as_object().unwrap() {
            body[k] = v.clone();
        }
        let r = post(&h, "/api/auth/workos/native", body).await;
        assert_eq!(r.status, 400, "{bad}");
        assert_eq!(r.body, json!({ "error": "invalid_request" }));
        let retry = post(&h, "/api/auth/workos/native", exchange_body(&state)).await;
        assert_eq!(retry.status, 400, "{bad}: the state was single use");
    }
    // 128 is the longest verifier allowed.
    let state = native_state(&h).await;
    let mut body = exchange_body(&state);
    body["code_verifier"] = "a".repeat(128).into();
    assert_eq!(post(&h, "/api/auth/workos/native", body).await.status, 200);
    assert_eq!(h.fake.calls().len(), 1);
}

#[tokio::test]
async fn native_denies_a_non_member_without_an_invite() {
    let h = harness(&[]).await;
    let state = native_state(&h).await;
    let r = post(&h, "/api/auth/workos/native", exchange_body(&state)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body, json!({ "status": "denied", "reason": "no_invite" }));
}

#[tokio::test]
async fn native_redeems_an_invite_for_a_new_member() {
    let h = harness(&[]).await;
    let code = invite(&h).await;
    let state = native_state(&h).await;
    let mut body = exchange_body(&state);
    body["inviteCode"] = code.into();
    let r = post(&h, "/api/auth/workos/native", body).await;
    assert_eq!(r.status, 200, "{}", r.body);
    let mode: String = sqlx::query_scalar("SELECT auth_mode FROM members WHERE sub = ?")
        .bind(SUB)
        .fetch_one(&*h.db)
        .await
        .unwrap();
    assert_eq!(mode, "workos");
}

#[tokio::test]
async fn native_requires_the_device_fields() {
    let h = harness(&[]).await;
    member(&h).await;
    let state = native_state(&h).await;
    let r = post(
        &h,
        "/api/auth/workos/native",
        json!({ "code": "c", "code_verifier": VERIFIER, "state": state }),
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body, json!({ "error": "missing_device_fields" }));
    assert!(r.cookies.is_empty());

    let state = native_state(&h).await;
    let mut body = exchange_body(&state);
    body["device_platform"] = " ".into();
    let r = post(&h, "/api/auth/workos/native", body).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body, json!({ "error": "incomplete_device_fields" }));
    let tokens: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_tokens")
        .fetch_one(&*h.db)
        .await
        .unwrap();
    assert_eq!(tokens, 0);
}

#[tokio::test]
async fn native_maps_exchange_failures_to_503_and_401() {
    let h = harness(&[]).await;
    member(&h).await;
    for (status, want_status, want) in [
        (503, 503, "workos_unavailable"),
        (401, 401, "workos_code_invalid"),
    ] {
        h.fake.reply(status, json!({}));
        let state = native_state(&h).await;
        let r = post(&h, "/api/auth/workos/native", exchange_body(&state)).await;
        assert_eq!(r.status, want_status);
        assert_eq!(r.body, json!({ "error": want }));
    }
}

#[tokio::test]
async fn native_caps_the_body_at_8_kb() {
    let h = harness(&[]).await;
    let state = native_state(&h).await;
    let mut body = exchange_body(&state);
    body["pad"] = "x".repeat(8200).into();
    let r = post(&h, "/api/auth/workos/native", body).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.body, json!({ "error": "body_too_large" }));
}

// ── POST /api/auth/logout ──

#[tokio::test]
async fn logout_clears_the_session_cookie_without_needing_a_session() {
    let (_db, st) = state().await;
    let r = send(&crate::router(st), "POST", "/api/auth/logout", &[], None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, json!({ "ok": true }));
    assert_eq!(r.cookies, vec!["eex.session=; Max-Age=0; Path=/"]);
}
