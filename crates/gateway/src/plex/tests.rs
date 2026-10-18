//! plex-links.test.ts (13), plex-admin.test.ts (8) and users.test.ts (7)
//! through the whole router, against one local fake standing in for both
//! plex.tv and the PMS. Nothing leaves the machine.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use serde_json::{Value, json};

use crate::AppState;
use crate::testutil::*;

/// One request the fake saw: path and query, X-Plex-Token.
type Call = (String, Option<String>);

/// Every request: path and query, X-Plex-Token. Answers by path (a
/// `path#token` stub wins over a bare `path`), else 404 "not stubbed".
#[derive(Clone, Default)]
struct Fake {
    url: String,
    calls: Arc<Mutex<Vec<Call>>>,
    stubs: Arc<Mutex<HashMap<String, (u16, String)>>>,
    /// While set, /library/sections waits for one notify before answering.
    hold: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>>,
}

impl Fake {
    async fn start() -> Fake {
        let fake = Fake::default();
        let state = fake.clone();
        let app = Router::new().fallback(move |req: Request<Body>| {
            let state = state.clone();
            async move { state.handle(req).await }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Fake { url, ..fake }
    }

    async fn handle(&self, req: Request<Body>) -> axum::response::Response {
        use axum::response::IntoResponse;
        let path = req.uri().path().to_string();
        let token = req
            .headers()
            .get("x-plex-token")
            .map(|v| v.to_str().unwrap().to_string());
        self.calls
            .lock()
            .unwrap()
            .push((req.uri().to_string(), token.clone()));
        let hold = self.hold.lock().unwrap().clone();
        if path == "/library/sections"
            && let Some(n) = hold
        {
            n.notified().await;
        }
        let stub = {
            let stubs = self.stubs.lock().unwrap();
            let keyed = token.map(|t| format!("{path}#{t}"));
            keyed
                .and_then(|k| stubs.get(&k).cloned())
                .or_else(|| stubs.get(&path).cloned())
        };
        let (status, body) = stub.unwrap_or((404, format!("not stubbed: {path}")));
        let ct = if body.starts_with(['{', '[']) {
            "application/json"
        } else {
            "application/xml"
        };
        (
            axum::http::StatusCode::from_u16(status).unwrap(),
            [("content-type", ct)],
            body,
        )
            .into_response()
    }

    fn stub(&self, path: &str, status: u16, body: impl Into<String>) {
        self.stubs
            .lock()
            .unwrap()
            .insert(path.to_string(), (status, body.into()));
    }

    fn json(&self, path: &str, body: Value) {
        self.stub(path, 200, body.to_string());
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    fn count(&self, path: &str) -> usize {
        self.calls().iter().filter(|(p, _)| p == path).count()
    }
}

struct T {
    _dir: tempfile::TempDir,
    st: AppState,
    app: Router,
    fake: Fake,
}

/// Plex configured, plex.tv and the PMS both at the fake; `extra` wins.
async fn setup(extra: &[(&str, &str)]) -> T {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut env = vec![
        ("PLEX_CLIENT_ID", "gateway-test-plex-client"),
        ("PLEX_SERVER_URL", fake.url.as_str()),
    ];
    env.extend_from_slice(extra);
    let mut st = state_in(&dir, &env).await;
    st.auth.plex = Arc::new(auth::plex::Plex::at(&fake.url));
    T {
        app: crate::router(st.clone()),
        _dir: dir,
        st,
        fake,
    }
}

impl T {
    /// A member row for `sub` and a Plex cookie, with the plex.tv token.
    async fn plex_cookie(&self, sub: &str, role: &str, token: Option<&str>) -> String {
        add_member(&self.st, sub, "guest", role).await;
        let session = auth::session::Session {
            sub: sub.into(),
            username: "guest".into(),
            role: auth::Role::User,
            auth_mode: auth::AuthMode::Plex,
            plex_auth_token: token.map(String::from),
        };
        let token = auth::session::mint(
            &self.st.auth.session_key,
            &session,
            chrono::Utc::now().timestamp(),
        );
        format!("eex.session={token}")
    }

    async fn get(&self, path: &str, cookie: Option<&str>) -> (u16, Value) {
        let r = send(&self.app, json_req("GET", path, cookie, None)).await;
        let body = serde_json::from_str(&r.body).unwrap_or(Value::String(r.body));
        (r.status.as_u16(), body)
    }
}

const LINKS: &str = "/api/plex/library-links";

// ── plex-links.test.ts ──

/// Sections 1 (movie) and 2 (show) unless `sections` says otherwise.
fn stub_library(fake: &Fake, sections: Option<Value>, items: &[(&str, Value)]) {
    let dirs = sections.unwrap_or_else(|| {
        json!([
            { "key": "1", "type": "movie", "title": "Movies" },
            { "key": "2", "type": "show", "title": "TV Shows" },
        ])
    });
    fake.json(
        "/library/sections",
        json!({ "MediaContainer": { "Directory": dirs } }),
    );
    for (key, metadata) in items {
        fake.json(
            &format!("/library/sections/{key}/all"),
            json!({ "MediaContainer": { "Metadata": metadata } }),
        );
    }
}

fn empty_kind() -> Value {
    json!({ "byTmdb": {}, "byTvdb": {}, "byImdb": {} })
}

#[tokio::test]
async fn links_401_for_unauthenticated_callers() {
    let t = setup(&[]).await;
    assert_eq!(t.get(LINKS, None).await.0, 401);
}

#[tokio::test]
async fn links_409_no_plex_token_when_the_session_lacks_one() {
    let t = setup(&[]).await;
    let cookie = t.plex_cookie("plex:1", "user", None).await;
    assert_eq!(
        t.get(LINKS, Some(&cookie)).await,
        (409, json!({ "error": "no_plex_token" }))
    );
    assert!(t.fake.calls().is_empty());
}

#[tokio::test]
async fn links_index_items_by_every_external_id() {
    let t = setup(&[]).await;
    stub_library(
        &t.fake,
        None,
        &[
            (
                "1",
                json!([
                    { "ratingKey": "101", "title": "Inception", "Guid": [{ "id": "tmdb://27205" }, { "id": "imdb://tt1375666" }] },
                    { "ratingKey": "102", "title": "Arrival", "Guid": [{ "id": "tmdb://329865" }] },
                    { "ratingKey": "103", "title": "Imdb-only", "Guid": [{ "id": "imdb://tt9999999" }] },
                ]),
            ),
            (
                "2",
                json!([
                    // The legacy TVDB agent emits only tvdb://.
                    { "ratingKey": "201", "title": "The 100", "Guid": [{ "id": "tvdb://121361" }] },
                    { "ratingKey": "202", "title": "Severance", "Guid": [{ "id": "tmdb://95396" }, { "id": "tvdb://371980" }] },
                ]),
            ),
        ],
    );
    let cookie = t
        .plex_cookie("plex:1", "user", Some("plex-test-token"))
        .await;
    let (status, body) = t.get(LINKS, Some(&cookie)).await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({
            "movie": {
                "byTmdb": { "27205": "101", "329865": "102" },
                "byTvdb": {},
                "byImdb": { "tt1375666": "101", "tt9999999": "103" },
            },
            "tv": {
                "byTmdb": { "95396": "202" },
                "byTvdb": { "121361": "201", "371980": "202" },
                "byImdb": {},
            },
        })
    );
    // Every PMS call carried the session's token, never in the URL.
    let calls = t.fake.calls();
    assert_eq!(calls.len(), 3);
    for (url, token) in calls {
        assert_eq!(token.as_deref(), Some("plex-test-token"));
        assert!(!url.contains("plex-test-token"));
    }
    assert_eq!(t.fake.count("/library/sections/1/all?includeGuids=1"), 1);
}

#[tokio::test]
async fn links_strip_query_suffixes_from_guids() {
    let t = setup(&[]).await;
    stub_library(
        &t.fake,
        None,
        &[
            (
                "1",
                json!([{ "ratingKey": "999", "Guid": [{ "id": "tmdb://12345?lang=en" }] }]),
            ),
            (
                "2",
                json!([{ "ratingKey": "888", "Guid": [{ "id": "tvdb://77777?lang=en" }] }]),
            ),
        ],
    );
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    let (_, body) = t.get(LINKS, Some(&cookie)).await;
    assert_eq!(body["movie"]["byTmdb"], json!({ "12345": "999" }));
    assert_eq!(body["tv"]["byTvdb"], json!({ "77777": "888" }));
}

#[tokio::test]
async fn links_are_empty_without_movie_or_show_sections() {
    let t = setup(&[]).await;
    stub_library(
        &t.fake,
        Some(json!([{ "key": "3", "type": "artist", "title": "Music" }])),
        &[],
    );
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    assert_eq!(
        t.get(LINKS, Some(&cookie)).await,
        (200, json!({ "movie": empty_kind(), "tv": empty_kind() }))
    );
    assert_eq!(t.fake.calls().len(), 1, "no section walked");
}

#[tokio::test]
async fn links_502_plex_unreachable_when_sections_errors() {
    let t = setup(&[]).await;
    t.fake.stub("/library/sections", 500, "boom");
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    assert_eq!(
        t.get(LINKS, Some(&cookie)).await,
        (
            502,
            json!({ "error": "plex_unreachable", "detail": "Error: plex 500: boom" })
        )
    );
}

#[tokio::test]
async fn links_survive_a_single_section_failing() {
    let t = setup(&[]).await;
    stub_library(
        &t.fake,
        Some(json!([{ "key": "1", "type": "movie" }, { "key": "2", "type": "show" }])),
        &[(
            "2",
            json!([{ "ratingKey": "201", "Guid": [{ "id": "tmdb://95396" }] }]),
        )],
    );
    t.fake.stub("/library/sections/1/all", 500, "boom");
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    let (status, body) = t.get(LINKS, Some(&cookie)).await;
    assert_eq!(status, 200);
    assert_eq!(body["movie"], empty_kind());
    assert_eq!(body["tv"]["byTmdb"], json!({ "95396": "201" }));
    assert_eq!(t.fake.count("/library/sections/1/all?includeGuids=1"), 1);
}

#[tokio::test]
async fn links_are_cached_so_a_second_hit_does_not_call_plex() {
    let t = setup(&[]).await;
    stub_library(
        &t.fake,
        None,
        &[
            (
                "1",
                json!([{ "ratingKey": "101", "Guid": [{ "id": "tmdb://27205" }] }]),
            ),
            (
                "2",
                json!([{ "ratingKey": "201", "Guid": [{ "id": "tmdb://95396" }] }]),
            ),
        ],
    );
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    let first = t.get(LINKS, Some(&cookie)).await;
    assert_eq!(first.0, 200);
    let calls = t.fake.calls().len();
    assert_eq!(t.get(LINKS, Some(&cookie)).await, first);
    assert_eq!(t.fake.calls().len(), calls);
}

#[tokio::test]
async fn links_coalesce_concurrent_requests_into_one_build() {
    let t = Arc::new(setup(&[]).await);
    stub_library(&t.fake, Some(json!([])), &[]);
    let hold = Arc::new(tokio::sync::Notify::new());
    *t.fake.hold.lock().unwrap() = Some(hold.clone());
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    let call = |t: Arc<T>, c: String| tokio::spawn(async move { t.get(LINKS, Some(&c)).await });
    let p1 = call(t.clone(), cookie.clone());
    let p2 = call(t.clone(), cookie);
    // Both requests are in while /library/sections is held.
    while t.fake.count("/library/sections") == 0 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    *t.fake.hold.lock().unwrap() = None;
    hold.notify_waiters();
    let (r1, r2) = (p1.await.unwrap(), p2.await.unwrap());
    assert_eq!((r1.0, r2.0), (200, 200));
    assert_eq!(t.fake.count("/library/sections"), 1);
}

#[tokio::test]
async fn links_are_cached_per_sub() {
    let t = setup(&[]).await;
    t.fake.json(
        "/library/sections#token-A",
        json!({ "MediaContainer": { "Directory": [{ "key": "1", "type": "movie" }] } }),
    );
    t.fake.json(
        "/library/sections#token-B",
        json!({ "MediaContainer": { "Directory": [{ "key": "2", "type": "show" }] } }),
    );
    stub_library(
        &t.fake,
        Some(json!([])),
        &[
            (
                "1",
                json!([{ "ratingKey": "101", "Guid": [{ "id": "tmdb://27205" }] }]),
            ),
            (
                "2",
                json!([{ "ratingKey": "201", "Guid": [{ "id": "tmdb://95396" }] }]),
            ),
        ],
    );
    let a = t.plex_cookie("plex:100", "user", Some("token-A")).await;
    let b = t.plex_cookie("plex:200", "user", Some("token-B")).await;

    let (_, body_a) = t.get(LINKS, Some(&a)).await;
    assert_eq!(body_a["movie"]["byTmdb"], json!({ "27205": "101" }));
    assert_eq!(body_a["tv"]["byTmdb"], json!({}));
    // B builds with B's token instead of reading A's cached map.
    let (_, body_b) = t.get(LINKS, Some(&b)).await;
    assert_eq!(body_b["tv"]["byTmdb"], json!({ "95396": "201" }));
    assert_eq!(body_b["movie"]["byTmdb"], json!({}));
    let tokens: Vec<_> = t
        .fake
        .calls()
        .into_iter()
        .filter(|(p, _)| p == "/library/sections")
        .map(|(_, tok)| tok.unwrap())
        .collect();
    assert_eq!(tokens, ["token-A", "token-B"]);
}

#[tokio::test]
async fn links_retry_after_a_failed_build() {
    let t = setup(&[]).await;
    t.fake.stub("/library/sections", 500, "boom");
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    assert_eq!(t.get(LINKS, Some(&cookie)).await.0, 502);
    assert_eq!(t.get(LINKS, Some(&cookie)).await.0, 502);
    assert_eq!(
        t.fake.count("/library/sections"),
        2,
        "the failure is not shared"
    );

    // A PMS that refuses connections fails the build too, and is retried.
    let dead = setup(&[("PLEX_SERVER_URL", "http://127.0.0.1:9")]).await;
    let cookie = dead.plex_cookie("plex:1", "user", Some("tok")).await;
    for _ in 0..2 {
        let (status, body) = dead.get(LINKS, Some(&cookie)).await;
        assert_eq!((status, &body["error"]), (502, &json!("plex_unreachable")));
        assert!(
            body["detail"]
                .as_str()
                .unwrap()
                .starts_with("Error: plex 504: ")
        );
    }
}

#[tokio::test]
async fn server_id_returns_the_configured_plex_server_id_or_null() {
    let t = setup(&[]).await;
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    assert_eq!(
        t.get("/api/plex/server-id", Some(&cookie)).await,
        (200, json!({ "serverId": null }))
    );
    let t = setup(&[("PLEX_SERVER_ID", "srv-golden")]).await;
    // A non-Plex member: the session gate never calls plex.tv for it.
    let cookie = member(&t.st, ALICE, "Alice", "user").await;
    assert_eq!(
        t.get("/api/plex/server-id", Some(&cookie)).await,
        (200, json!({ "serverId": "srv-golden" }))
    );
    assert!(t.fake.calls().is_empty());
}

#[tokio::test]
async fn server_id_requires_auth() {
    let t = setup(&[]).await;
    assert_eq!(t.get("/api/plex/server-id", None).await.0, 401);
}

// ── plex-admin.test.ts ──

const PREFS: &str = "/api/plex/remote-access";

const PREFS_XML_HAPPY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="11">
  <Setting id="PublishServerOnPlexOnlineKey" value="1" />
  <Setting id="ManualPortMappingMode" value="1" />
  <Setting id="ManualPortMappingPort" value="32400" />
  <Setting id="secureConnections" value="2" />
  <Setting id="customConnections" value="https://example.lan:32400" />
  <Setting id="allowedNetworks" value="192.168.1.0/24" />
  <Setting id="lanNetworksBandwidth" value="0" />
  <Setting id="WanPerStreamMaxUploadRate" value="0" />
  <Setting id="certificateUUID" value="abc-123" />
  <Setting id="PublicPort" value="32400" />
  <Setting id="PublicAddress" value="203.0.113.10" />
</MediaContainer>"#;

async fn admin(t: &T, token: Option<&str>) -> String {
    t.plex_cookie("plex:1", "admin", token).await
}

#[tokio::test]
async fn remote_access_401_unauthenticated_without_calling_the_pms() {
    let t = setup(&[]).await;
    assert_eq!(t.get(PREFS, None).await.0, 401);
    assert!(t.fake.calls().is_empty());
}

#[tokio::test]
async fn remote_access_403_admin_only_for_a_user_without_calling_the_pms() {
    let t = setup(&[]).await;
    let cookie = t
        .plex_cookie("plex:2", "user", Some("plex-user-token"))
        .await;
    assert_eq!(
        t.get(PREFS, Some(&cookie)).await,
        (403, json!({ "error": "forbidden", "reason": "admin_only" }))
    );
    assert!(t.fake.calls().is_empty());
}

#[tokio::test]
async fn remote_access_409_no_plex_token_for_an_admin_without_one() {
    let t = setup(&[]).await;
    let cookie = admin(&t, None).await;
    assert_eq!(
        t.get(PREFS, Some(&cookie)).await,
        (409, json!({ "error": "no_plex_token" }))
    );
    assert!(t.fake.calls().is_empty());
}

#[tokio::test]
async fn remote_access_parses_the_prefs_into_the_summary() {
    let t = setup(&[]).await;
    t.fake.stub("/:/prefs", 200, PREFS_XML_HAPPY);
    let cookie = admin(&t, Some("plex-admin-token")).await;
    let r = send(&t.app, json_req("GET", PREFS, Some(&cookie), None)).await;
    assert_eq!(r.status, 200);
    let body: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        body,
        json!({
            "summary": {
                "remoteAccessEnabled": true,
                "manualPortMappingEnabled": true,
                "manualPort": "32400",
                "publicAddressDetected": true,
                "detectedPublicPort": "32400",
                "hasCustomConnections": true,
                "secureConnectionsMode": "2",
                "hasCertificate": true,
                "wanUploadCapBytes": "0",
                "allowedNetworks": "192.168.1.0/24",
                "lanNetworksBandwidth": "0",
            },
            "interpretation": {
                "remoteAccess": "Server is advertising itself to plex.tv as remotely accessible.",
                "portMapping": "Plex is asking your router to forward TCP 32400 to the Plex server on the LAN. Router must be configured to honor this.",
                "publicReachability": "Plex has detected a public address on port 32400. The literal IP is intentionally not returned here; read it in Plex's own web UI if you need it. If reachability is wrong (e.g. your ISP rotated the IP), hit Retry there.",
            },
        })
    );
    // The TS key order, and no raw IP, internal host or customConnections.
    assert!(r.body.starts_with(
        r#"{"summary":{"remoteAccessEnabled":true,"manualPortMappingEnabled":true,"manualPort":"32400","#
    ));
    for leak in ["203.0.113.10", "example.lan", "theemeraldexchange.local"] {
        assert!(!r.body.contains(leak), "{leak}");
    }
}

#[tokio::test]
async fn remote_access_threads_the_session_token_into_the_header() {
    let t = setup(&[]).await;
    t.fake.stub("/:/prefs", 200, PREFS_XML_HAPPY);
    let cookie = admin(&t, Some("plex-admin-token")).await;
    t.get(PREFS, Some(&cookie)).await;
    assert_eq!(
        t.fake.calls(),
        [("/:/prefs".to_string(), Some("plex-admin-token".to_string()))]
    );
}

#[tokio::test]
async fn remote_access_off_when_publish_is_missing() {
    let t = setup(&[]).await;
    t.fake.stub(
        "/:/prefs",
        200,
        "<?xml version=\"1.0\"?>\n<MediaContainer>\n  <Setting id=\"ManualPortMappingMode\" value=\"0\" />\n</MediaContainer>",
    );
    let cookie = admin(&t, Some("tok")).await;
    let (status, body) = t.get(PREFS, Some(&cookie)).await;
    assert_eq!(status, 200);
    assert_eq!(body["summary"]["remoteAccessEnabled"], false);
    assert_eq!(body["summary"]["manualPortMappingEnabled"], false);
    assert_eq!(body["summary"]["manualPort"], Value::Null);
    assert_eq!(body["summary"]["allowedNetworks"], Value::Null);
    assert_eq!(
        body["interpretation"],
        json!({
            "remoteAccess": "Server is NOT advertising to plex.tv. Settings \u{2192} Remote Access in Plex web UI is the toggle.",
            "portMapping": "Plex is using UPnP to auto-map the port. If your router has UPnP disabled or broken (common on UGREEN/ISP routers), this will silently fail. Switch to manual.",
            "publicReachability": "Plex has not detected a public address \u{2014} strong signal that remote access is broken end-to-end.",
        })
    );
}

#[tokio::test]
async fn remote_access_502_prefs_failed_with_the_upstream_status() {
    let t = setup(&[]).await;
    t.fake.stub("/:/prefs", 500, "boom");
    let cookie = admin(&t, Some("tok")).await;
    assert_eq!(
        t.get(PREFS, Some(&cookie)).await,
        (
            502,
            json!({ "error": "prefs_failed", "status": 500, "body": "boom" })
        )
    );
}

#[tokio::test]
async fn remote_access_502_prefs_failed_504_when_the_pms_is_unreachable() {
    let t = setup(&[("PLEX_SERVER_URL", "http://127.0.0.1:9")]).await;
    let cookie = admin(&t, Some("tok")).await;
    let (status, body) = t.get(PREFS, Some(&cookie)).await;
    assert_eq!((status, &body["error"]), (502, &json!("prefs_failed")));
    assert_eq!(body["status"], 504);
    let inner: Value = serde_json::from_str(body["body"].as_str().unwrap()).unwrap();
    assert_eq!(inner["error"], "upstream_unreachable");
    assert_eq!(inner["service"], "plex.remoteAccess");
}

// ── users.test.ts ──

fn owner_body() -> Value {
    json!({
        "id": 1,
        "uuid": "owner-uuid",
        "username": "admin-user",
        "email": "admin@example.com",
        "thumb": "https://example.com/me.jpg",
    })
}

fn stub_all_happy(fake: &Fake) {
    fake.json("/api/v2/user", owner_body());
    fake.stub(
        "/api/users",
        200,
        r#"<MediaContainer>
      <User id="10" username="alice" title="Alice" email="alice@example.com" thumb="t" />
      <User id="11" username="bob" title="Bob" email="bob@example.com" />
    </MediaContainer>"#,
    );
    // No PLEX_SERVER_ID: the server-share list makes no request.
    fake.stub("/api/home/users", 200, "<MediaContainer></MediaContainer>");
    fake.stub("/accounts", 200, "<MediaContainer></MediaContainer>");
    fake.json(
        "/api/v2/friends/requested",
        json!([{ "id": 99, "username": "carol", "title": "Carol", "email": "carol@example.com" }]),
    );
}

const OWNER_ENV: &[(&str, &str)] = &[("ADMIN_SUBS", "plex:1")];

#[tokio::test]
async fn users_401_unauthenticated_without_calling_plex() {
    let t = setup(OWNER_ENV).await;
    assert_eq!(t.get("/api/users", None).await.0, 401);
    assert!(t.fake.calls().is_empty());
}

#[tokio::test]
async fn users_403_admin_only_for_a_user() {
    let t = setup(OWNER_ENV).await;
    let cookie = t.plex_cookie("plex:2", "user", None).await;
    assert_eq!(
        t.get("/api/users", Some(&cookie)).await,
        (403, json!({ "error": "forbidden", "reason": "admin_only" }))
    );
    assert!(t.fake.calls().is_empty());
}

#[tokio::test]
async fn users_409_no_plex_token_for_an_admin_without_one() {
    let t = setup(OWNER_ENV).await;
    let cookie = t.plex_cookie("plex:1", "user", None).await;
    let r = send(&t.app, json_req("GET", "/api/users", Some(&cookie), None)).await;
    assert_eq!(r.status, 409);
    assert_eq!(
        r.body,
        r#"{"error":"no_plex_token","message":"Re-authenticate to refresh your Plex token."}"#
    );
    assert!(t.fake.calls().is_empty());
}

#[tokio::test]
async fn users_debug_query_returns_the_normal_shape() {
    let t = setup(OWNER_ENV).await;
    stub_all_happy(&t.fake);
    let cookie = t
        .plex_cookie("plex:1", "user", Some("plex-owner-token"))
        .await;
    let (status, body) = t.get("/api/users?debug=1", Some(&cookie)).await;
    assert_eq!(status, 200);
    assert!(body.get("sources").is_none());
    assert_eq!(body["users"][0]["username"], "admin-user");
    assert_eq!(body["users"][0]["relation"], "owner");
}

#[tokio::test]
async fn users_lists_the_owner_first_then_the_merged_friends() {
    let t = setup(OWNER_ENV).await;
    stub_all_happy(&t.fake);
    let cookie = t
        .plex_cookie("plex:1", "user", Some("plex-owner-token"))
        .await;
    let r = send(&t.app, json_req("GET", "/api/users", Some(&cookie), None)).await;
    assert_eq!(r.status, 200);
    // The TS key order.
    assert!(r.body.starts_with(
        r#"{"users":[{"id":1,"username":"admin-user","title":"admin-user","email":"admin@example.com","thumb":"https://example.com/me.jpg","role":"admin","relation":"owner","status":"accepted"}"#
    ), "{}", r.body);
    let body: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        body["users"],
        json!([
            { "id": 1, "username": "admin-user", "title": "admin-user", "email": "admin@example.com", "thumb": "https://example.com/me.jpg", "role": "admin", "relation": "owner", "status": "accepted" },
            { "id": 10, "username": "alice", "title": "Alice", "email": "alice@example.com", "thumb": "t", "role": "user", "relation": "friend", "status": "accepted" },
            { "id": 11, "username": "bob", "title": "Bob", "email": "bob@example.com", "thumb": null, "role": "user", "relation": "friend", "status": "accepted" },
            { "id": 99, "username": "carol", "title": "Carol", "email": "carol@example.com", "thumb": null, "role": "user", "relation": "friend", "status": "pending" },
        ])
    );
    for (_, token) in t.fake.calls() {
        assert_eq!(token.as_deref(), Some("plex-owner-token"));
    }
}

#[tokio::test]
async fn users_tolerate_best_effort_failures() {
    let t = setup(OWNER_ENV).await;
    t.fake.json("/api/v2/user", owner_body());
    t.fake.stub(
        "/api/users",
        200,
        r#"<MediaContainer><User id="10" username="alice" title="Alice" /></MediaContainer>"#,
    );
    t.fake.stub("/api/home/users", 500, "home blew up");
    t.fake.stub("/accounts", 500, "pms refused");
    t.fake
        .stub("/api/v2/friends/requested", 500, "pending broke");
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    let (status, body) = t.get("/api/users", Some(&cookie)).await;
    assert_eq!(status, 200);
    let names: Vec<_> = body["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["username"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["admin-user", "alice"]);
}

#[tokio::test]
async fn users_502_plex_lookup_failed_when_a_required_call_fails() {
    let t = setup(OWNER_ENV).await;
    stub_all_happy(&t.fake);
    t.fake.stub("/api/v2/user", 500, r#"{"error":"down"}"#);
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    assert_eq!(
        t.get("/api/users", Some(&cookie)).await,
        (
            502,
            json!({ "error": "plex_lookup_failed", "detail": "Error: plex.getUser failed: 500" })
        )
    );

    // The accepted list is required too.
    stub_all_happy(&t.fake);
    t.fake.stub("/api/users", 503, "down");
    let (status, body) = t.get("/api/users", Some(&cookie)).await;
    assert_eq!(
        (status, &body["error"]),
        (502, &json!("plex_lookup_failed"))
    );
}

// ── beyond the TS suite ──

#[tokio::test]
async fn users_dedupe_across_sources_and_read_roles_from_server_state() {
    let t = setup(OWNER_ENV).await;
    // alice is an admin by her members row; bob only shares a username.
    add_member(&t.st, "plex:10", "alice", "admin").await;
    t.fake.json("/api/v2/user", owner_body());
    t.fake.stub(
        "/api/users",
        200,
        r#"<MediaContainer><User id="10" username="alice" title="" email="" /></MediaContainer>"#,
    );
    // The owner under a Home id, alice by email with a title, bob twice.
    t.fake.stub(
        "/api/home/users",
        200,
        r#"<MediaContainer>
          <User id="5000" username="Admin-User" title="Owner" />
          <User id="0" username="bob" title="Bob" email="Bob@Example.com " thumb="b.jpg" />
        </MediaContainer>"#,
    );
    t.fake.stub(
        "/accounts",
        200,
        r#"<MediaContainer><Account id="0" name="Anonymous" /><Account id="12" name="BOB" /></MediaContainer>"#,
    );
    t.fake.json(
        "/api/v2/friends/requested",
        json!([
            { "id": 10, "username": "alice", "title": "Alice", "email": "alice@example.com" },
            { "invitedEmail": "dave@example.com" },
        ]),
    );
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    let (status, body) = t.get("/api/users", Some(&cookie)).await;
    assert_eq!(status, 200);
    let users = body["users"].as_array().unwrap();
    assert_eq!(users.len(), 4, "{body}");
    assert_eq!(users[0]["relation"], "owner");
    // alice: accepted (first seen), the pending copy only fills blanks.
    assert_eq!(
        users[1],
        json!({ "id": 10, "username": "alice", "title": "alice", "email": "alice@example.com", "thumb": null, "role": "admin", "relation": "friend", "status": "accepted" })
    );
    // bob from Home (id 0) upgraded with the PMS account's id.
    assert_eq!(
        users[2],
        json!({ "id": 12, "username": "bob", "title": "Bob", "email": "Bob@Example.com ", "thumb": "b.jpg", "role": "user", "relation": "friend", "status": "accepted" })
    );
    assert_eq!(users[3]["username"], "dave@example.com");
    assert_eq!(users[3]["status"], "pending");
    assert!(users[3]["id"].as_i64().unwrap() < 0);
}

#[tokio::test]
async fn users_503_plex_not_configured_without_a_client_id() {
    let t = setup(&[("ADMIN_SUBS", "plex:1"), ("PLEX_CLIENT_ID", "")]).await;
    let cookie = t.plex_cookie("plex:1", "user", Some("tok")).await;
    assert_eq!(
        t.get("/api/users", Some(&cookie)).await,
        (503, json!({ "error": "plex_not_configured" }))
    );
    assert!(t.fake.calls().iter().all(|(p, _)| p == "/accounts"));
}
