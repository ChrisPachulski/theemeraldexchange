//! Grant, byte-route and sessions cases carried over from
//! server/routes/iptv.test.ts, against local axum fakes only: a fake panel
//! (account probe, live .ts, VOD/series files, timeshift), a fake CDN, and an
//! "internal" server a redirect must never reach.

use super::*;
use crate::api::router;
use crate::catalog::tests::{channel, exec, pool};
use crate::config::test_config;
use crate::xtream::test_public;
use axum::body::Bytes;
use axum::http::Request;
use emerald_contracts::internal_principal::{self, InternalClaims};
use emerald_contracts::stream_token;
use futures_util::StreamExt;
use std::sync::atomic::AtomicUsize;
use tower::ServiceExt;

const PRINCIPAL_SECRET: &str = "pppppppppppppppppppppppppppppppppppppppp";
const SECRET: &str = "ssssssssssssssssssssssssssssssssssssssss";

type Hits = Arc<Mutex<Vec<String>>>;

async fn spawn(app: Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    base
}

/// A loopback server the tests register as a public host (a CDN).
async fn public(app: Router) -> String {
    let base = spawn(app).await;
    test_public(&base);
    base
}

/// Records `path?query` plus the Range and User-Agent it was sent.
fn recorder(hits: &Hits, req: &Request<Body>) {
    let h = |k: header::HeaderName| {
        req.headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    hits.lock().unwrap().push(format!(
        "{} range={} ua={}",
        req.uri(),
        h(header::RANGE),
        h(header::USER_AGENT)
    ));
}

/// One chunk, then open forever (a live feed).
fn endless() -> Body {
    Body::from_stream(
        futures_util::stream::once(async {
            Ok::<_, std::io::Error>(Bytes::from_static(b"\x47\x40"))
        })
        .chain(futures_util::stream::pending()),
    )
}

struct T {
    app: Router,
    state: AppState,
    panel: String,
    hits: Hits,
    probes: Arc<AtomicUsize>,
    panel_down: Arc<std::sync::atomic::AtomicBool>,
    _dir: tempfile::TempDir,
}

struct Res {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {:?}", self.body))
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// `files` serves the panel's /live, /movie, /series and timeshift paths; the
/// account probe is built in. Enforce posture, the iptv.test.ts catalog.
async fn setup_with(files: Router<Hits>, pairs: &[(&str, &str)]) -> T {
    let hits: Hits = Arc::default();
    let probes = Arc::new(AtomicUsize::new(0));
    let panel_down = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (p, d) = (probes.clone(), panel_down.clone());
    let panel_app = files
        .route(
            "/player_api.php",
            get(move || {
                p.fetch_add(1, Ordering::SeqCst);
                let down = d.load(Ordering::SeqCst);
                async move {
                    if down {
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                    axum::Json(json!({"user_info": {"status": "Active", "max_connections": "4", "active_cons": "1"}}))
                        .into_response()
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            hits.clone(),
            |State(h): State<Hits>, req: Request<Body>, next: axum::middleware::Next| async move {
                if req.uri().path() != "/player_api.php" {
                    recorder(&h, &req);
                }
                next.run(req).await
            },
        ))
        .with_state(hits.clone());
    let panel = public(panel_app).await;
    let mut all = vec![
        ("MEDIA_INTERNAL_PRINCIPAL_MODE", "enforce"),
        ("INTERNAL_PRINCIPAL_SECRET", PRINCIPAL_SECRET),
        ("XTREAM_HOST", panel.as_str()),
        ("XTREAM_USERNAME", "u"),
        ("XTREAM_PASSWORD", "p"),
    ];
    all.extend_from_slice(pairs);
    let (pool, dir) = pool().await;
    exec(
        &pool,
        "INSERT INTO categories (category_id, kind, name, parent_id) VALUES (1, 'live', 'News', 0);
         INSERT INTO vod (stream_id, name, container_extension, fetched_at) VALUES (20, 'Matrix', 'mp4', 'x');
         INSERT INTO series (series_id, name, fetched_at) VALUES (30, 'GoT', 'x');
         INSERT INTO series_episodes (episode_id, series_id, season, episode_num, title, container_extension)
           VALUES ('ep-1', 30, 1, 1, 'Pilot', 'mkv');",
    )
    .await;
    channel(&pool, 10, 1, "CNN", None, Some("cnn.us"), 1).await;
    let state = AppState::new(pool, Arc::new(test_config(&all)));
    T {
        app: router(state.clone()),
        state,
        panel,
        hits,
        probes,
        panel_down,
        _dir: dir,
    }
}

async fn setup() -> T {
    setup_with(Router::new(), &[]).await
}

fn bearer(sub: &str, role: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = InternalClaims {
        iss: "eex".into(),
        sub: sub.into(),
        role: role.into(),
        auth_mode: "plex".into(),
        server_id: "srv".into(),
        device_id: None,
        req_id: "r1".into(),
        iat: now,
        exp: now + 60,
    };
    format!(
        "Bearer {}",
        internal_principal::encrypt_with_secret(PRINCIPAL_SECRET.as_bytes(), &claims)
    )
}

fn token(kind: StreamKind, rid: &str, sub: &str) -> String {
    playlist::sign(SECRET, kind, rid, sub, 300, None)
}

/// (kind, rid, ttl) of a minted token.
fn claims_of(t: &str) -> (StreamKind, String, i64) {
    let c = stream_token::verify(SECRET.as_bytes(), t).unwrap();
    (c.k, c.rid, c.exp - c.iat)
}

/// The `t=` / `u=` value in a minted URL.
fn query_token(url: &str, key: &str) -> String {
    url.split(['?', '&'])
        .find_map(|p| p.strip_prefix(&format!("{key}=")))
        .unwrap()
        .to_string()
}

impl T {
    async fn raw(
        &self,
        method: &str,
        uri: &str,
        who: (&str, &str),
        headers: &[(&str, &str)],
    ) -> Response {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, bearer(who.0, who.1));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        self.app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }
    async fn call(
        &self,
        method: &str,
        uri: &str,
        who: (&str, &str),
        headers: &[(&str, &str)],
    ) -> Res {
        let res = self.raw(method, uri, who, headers).await;
        let status = res.status();
        let headers = res.headers().clone();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap_or_default();
        Res {
            status,
            headers,
            body,
        }
    }
    /// As the admin plex:42 (iptv.test.ts's default session).
    async fn get(&self, uri: &str) -> Res {
        self.call("GET", uri, ("plex:42", "admin"), &[]).await
    }
    async fn post(&self, uri: &str) -> Res {
        self.call("POST", uri, ("plex:42", "admin"), &[]).await
    }
    fn tracker(&self) -> &Tracker {
        &self.state.streams.tracker
    }
    fn seed(
        &self,
        id: &str,
        sub: &str,
        kind: Kind,
        rid: &str,
        title: Option<&str>,
        ip: Option<&str>,
    ) {
        self.tracker()
            .try_acquire(Acquire {
                sub: sub.into(),
                session_id: id.into(),
                kind,
                resource_id: rid.into(),
                ip: ip.map(String::from),
                title: title.map(String::from),
                kind_cap: None,
                replace_live: false,
            })
            .unwrap();
    }
    fn ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .tracker()
            .list()
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        v.sort();
        v
    }
    fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}

/// Reads the next body frame, or None at the end; panics after 5 s.
async fn next_chunk(body: &mut axum::body::BodyDataStream) -> Option<Result<Bytes, axum::Error>> {
    tokio::time::timeout(Duration::from_secs(5), body.next())
        .await
        .expect("body stalled")
}

// ---- sessions ----------------------------------------------------------------------

#[tokio::test]
async fn sessions_are_scoped_to_the_caller_for_a_non_admin() {
    let t = setup().await;
    t.seed(
        "own-session",
        "plex:42",
        Kind::Live,
        "10",
        Some("CNN"),
        Some("10.0.0.7"),
    );
    t.seed(
        "other-session",
        "plex:other",
        Kind::Vod,
        "20",
        None,
        Some("10.0.0.9"),
    );
    let r = t
        .call("GET", "/api/iptv/sessions", ("plex:42", "user"), &[])
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let body = r.json();
    let ids: Vec<&str> = body["ours"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["own-session"]);
    assert!(!r.text().contains("plex:other"));
    assert_eq!(body["self"], "plex:42");
    assert_eq!(
        body["upstream"],
        json!({"activeConnections": 1, "maxConnections": 4, "status": "Active"})
    );
    assert_eq!(body["ours"][0]["resolvedTitle"], "CNN");

    let r = t
        .call("GET", "/api/iptv/sessions", ("plex:99", "user"), &[])
        .await;
    assert_eq!(r.json()["self"], "plex:99");
    assert_eq!(r.json()["ours"], json!([]));

    let r = t.get("/api/iptv/sessions").await;
    assert_eq!(r.json()["ours"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn the_429_redacts_other_members_but_keeps_the_callers_row_and_the_field_set() {
    let t = setup_with(Router::new(), &[("IPTV_MAX_CONCURRENT_STREAMS", "2")]).await;
    t.seed(
        "own-session",
        "plex:42",
        Kind::Vod,
        "20",
        Some("Matrix"),
        Some("10.0.0.7"),
    );
    t.seed(
        "other-session",
        "plex:other",
        Kind::Live,
        "20",
        Some("ESPN"),
        Some("10.0.0.9"),
    );
    let r = t
        .call(
            "POST",
            "/api/iptv/stream/live/10/grant",
            ("plex:42", "user"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    let body = r.json();
    assert_eq!(
        (body["ok"].clone(), body["reason"].clone()),
        (json!(false), json!("iptv_concurrency_limit"))
    );
    assert_eq!(
        (body["limit"].clone(), body["current"].clone()),
        (json!(2), json!(2))
    );
    let row = |id: &str| {
        body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["sessionId"] == id)
            .unwrap()
            .clone()
    };
    let (own, other) = (row("own-session"), row("other-session"));
    assert_eq!(
        (own["sub"].clone(), own["ip"].clone(), own["title"].clone()),
        (json!("plex:42"), json!("10.0.0.7"), json!("Matrix"))
    );
    assert_eq!(other["sub"], Value::Null);
    assert_eq!(other["ip"], Value::Null);
    assert_eq!(other["title"], REDACTED);
    assert_eq!(other["resolvedTitle"], REDACTED);
    for leak in ["plex:other", "10.0.0.9", "ESPN"] {
        assert!(!r.text().contains(leak), "{leak}");
    }
    for s in body["sessions"].as_array().unwrap() {
        for k in [
            "sub",
            "ip",
            "title",
            "resolvedTitle",
            "sessionId",
            "kind",
            "resourceId",
            "startedAt",
            "lastSeen",
        ] {
            assert!(s.get(k).is_some(), "{k}");
        }
    }
    // An admin sees every row in full.
    let r = t.post("/api/iptv/stream/live/10/grant").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(r.text().contains("ESPN") && r.text().contains("10.0.0.9"));
}

#[tokio::test]
async fn delete_session_owner_admin_and_dvr_rules() {
    let t = setup().await;
    t.seed("other-session", "plex:other", Kind::Live, "10", None, None);
    let r = t
        .call(
            "DELETE",
            "/api/iptv/sessions/other-session",
            ("plex:42", "user"),
            &[],
        )
        .await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::FORBIDDEN, json!({"error": "forbidden"}))
    );
    let r = t
        .call(
            "DELETE",
            "/api/iptv/sessions/other-session",
            ("plex:42", "admin"),
            &[],
        )
        .await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::OK,
            json!({"ok": true, "released": "other-session"})
        )
    );
    assert!(t.ids().is_empty());

    t.seed("own-session", "plex:42", Kind::Live, "10", None, None);
    let r = t
        .call(
            "DELETE",
            "/api/iptv/sessions/own-session",
            ("plex:42", "user"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        t.get("/api/iptv/sessions/nope").await.status,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let r = t
        .call(
            "DELETE",
            "/api/iptv/sessions/nope",
            ("plex:42", "admin"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    t.seed("record:01ABC", "dvr:01ABC", Kind::Live, "10", None, None);
    let r = t
        .call(
            "DELETE",
            "/api/iptv/sessions/record:01ABC",
            ("plex:42", "admin"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(
        r.json(),
        json!({"error": "dvr_recording_session", "message": "stop this recording from the DVR panel (DELETE /api/dvr/recordings/:id), not the sessions widget"})
    );
    let r = t
        .call(
            "DELETE",
            "/api/iptv/sessions/record:01ABC",
            ("plex:42", "user"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(t.ids(), ["record:01ABC"]);

    t.seed("plex-session", "plex:dvr:42", Kind::Live, "11", None, None);
    let r = t
        .call(
            "DELETE",
            "/api/iptv/sessions/plex-session",
            ("plex:42", "admin"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
}

// ---- grants ------------------------------------------------------------------------

#[tokio::test]
async fn live_grants_mint_long_live_tokens_for_both_deliveries() {
    let t = setup().await;
    let r = t.post("/api/iptv/stream/live/10/grant").await;
    assert_eq!(r.status, StatusCode::OK);
    let b = r.json();
    let url = b["url"].as_str().unwrap();
    assert!(url.starts_with("/api/iptv/stream/live/10.ts?t="), "{url}");
    assert_eq!(b["delivery"], "mpegts");
    assert!(
        b["sessionId"]
            .as_str()
            .unwrap()
            .starts_with("live:10:plex:42:")
    );
    assert_eq!(
        claims_of(&query_token(url, "t")),
        (StreamKind::Live, "10".into(), 43_200)
    );

    let b = t
        .post("/api/iptv/stream/live/10/grant?client=avplayer")
        .await
        .json();
    let url = b["url"].as_str().unwrap();
    assert!(
        url.starts_with("/api/iptv/stream/live/10/remux/index.m3u8?t="),
        "{url}"
    );
    assert_eq!(b["delivery"], "hls");
    assert_eq!(
        claims_of(&query_token(url, "t")),
        (StreamKind::Remux, "10".into(), 43_200)
    );
    assert_eq!(
        t.post("/api/iptv/stream/live/1x/grant").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn every_grant_is_503_source_unavailable_when_the_panel_is_down() {
    let t = setup().await;
    t.panel_down.store(true, Ordering::SeqCst);
    let start =
        encode_uri_component(&(chrono::Utc::now() - chrono::TimeDelta::hours(1)).to_rfc3339());
    for uri in [
        "/api/iptv/stream/live/10/grant".to_string(),
        format!("/api/iptv/stream/catchup/10/grant?startUtc={start}&durationMin=30"),
        "/api/iptv/stream/vod/20/grant".to_string(),
        "/api/iptv/stream/series/ep-1/grant".to_string(),
    ] {
        let r = t.post(&uri).await;
        assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(
            r.json(),
            json!({"ok": false, "reason": "source_unavailable", "available_alternatives": []})
        );
    }
    assert!(t.ids().is_empty());
}

#[tokio::test]
async fn the_panel_probe_is_shared_and_cached_up_but_never_cached_down() {
    let t = setup().await;
    let grants = (0..5).map(|_| t.post("/api/iptv/stream/vod/20/grant"));
    for r in futures_util::future::join_all(grants).await {
        assert_eq!(r.status, StatusCode::OK);
    }
    t.post("/api/iptv/stream/vod/20/grant").await;
    assert_eq!(
        t.probes.load(Ordering::SeqCst),
        1,
        "one probe for six tunes"
    );

    let t = setup().await;
    t.panel_down.store(true, Ordering::SeqCst);
    t.post("/api/iptv/stream/vod/20/grant").await;
    t.post("/api/iptv/stream/vod/20/grant").await;
    assert_eq!(
        t.probes.load(Ordering::SeqCst),
        2,
        "a down panel is re-probed"
    );
    t.panel_down.store(false, Ordering::SeqCst);
    assert_eq!(
        t.post("/api/iptv/stream/vod/20/grant").await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn missing_creds_are_source_unavailable_without_a_probe() {
    let t = setup_with(Router::new(), &[("XTREAM_PASSWORD", "")]).await;
    assert_eq!(
        t.post("/api/iptv/stream/live/10/grant").await.status,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(t.probes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn catchup_grant_validates_the_archive_and_mints_an_on_demand_token() {
    let t = setup().await;
    let start = (chrono::Utc::now() - chrono::TimeDelta::hours(1)).to_rfc3339();
    let enc = encode_uri_component(&start);
    let r = t
        .post(&format!(
            "/api/iptv/stream/catchup/10/grant?startUtc={enc}&durationMin=30"
        ))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let url = r.json()["url"].as_str().unwrap().to_string();
    assert!(
        url.starts_with(&format!("/api/iptv/stream/catchup/10/{enc}/30.ts?t=")),
        "{url}"
    );
    assert_eq!(r.json()["delivery"], "mpegts");
    assert_eq!(
        claims_of(&query_token(&url, "t")),
        (StreamKind::Catchup, format!("10|{start}|30"), 21_600)
    );

    let old = encode_uri_component(&(chrono::Utc::now() - chrono::TimeDelta::days(8)).to_rfc3339());
    channel(&t.state.pool, 11, 2, "Fox", None, None, 1).await;
    for (uri, status, error) in [
        (
            format!("/api/iptv/stream/catchup/10/grant?startUtc={old}&durationMin=30"),
            400,
            "beyond_archive_window",
        ),
        (
            format!("/api/iptv/stream/catchup/11/grant?startUtc={enc}&durationMin=30"),
            400,
            "catchup_unavailable",
        ),
        (
            format!("/api/iptv/stream/catchup/99/grant?startUtc={enc}&durationMin=30"),
            404,
            "not_found",
        ),
        (
            "/api/iptv/stream/catchup/10/grant?startUtc=nope&durationMin=30".to_string(),
            400,
            "invalid_params",
        ),
        (
            format!("/api/iptv/stream/catchup/10/grant?startUtc={enc}&durationMin=0"),
            400,
            "invalid_params",
        ),
        (
            format!("/api/iptv/stream/catchup/10/grant?startUtc={enc}%7C1&durationMin=30"),
            400,
            "invalid_params",
        ),
    ] {
        let r = t.post(&uri).await;
        assert_eq!(
            (r.status.as_u16(), r.json()["error"].clone()),
            (status, json!(error)),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn vod_and_series_grants_carry_ext_delivery_and_mime() {
    let t = setup().await;
    let b = t.post("/api/iptv/stream/vod/20/grant").await.json();
    let url = b["url"].as_str().unwrap();
    assert!(url.starts_with("/api/iptv/stream/vod/20/mp4?t="), "{url}");
    assert_eq!(
        (b["delivery"].clone(), b["mime"].clone()),
        (json!("progressive"), json!("video/mp4"))
    );
    assert_eq!(
        claims_of(&query_token(url, "t")),
        (StreamKind::Vod, "20".into(), 21_600)
    );

    let b = t.post("/api/iptv/stream/series/ep-1/grant").await.json();
    let url = b["url"].as_str().unwrap();
    assert!(
        url.starts_with("/api/iptv/stream/series/ep-1/mkv?t="),
        "{url}"
    );
    assert_eq!(b["mime"], "video/x-matroska");
    assert_eq!(
        claims_of(&query_token(url, "t")),
        (StreamKind::Series, "ep-1".into(), 21_600)
    );
    let titles: Vec<_> = t.tracker().list().into_iter().map(|s| s.title).collect();
    assert!(
        titles.contains(&Some("GoT \u{2014} Pilot".into()))
            && titles.contains(&Some("Matrix".into()))
    );

    exec(&t.state.pool, "INSERT INTO vod (stream_id, name, container_extension, fetched_at) VALUES (21, 'H', 'M3U8', 'x');").await;
    let b = t.post("/api/iptv/stream/vod/21/grant").await.json();
    assert_eq!(
        (b["delivery"].clone(), b["mime"].clone()),
        (json!("hls"), json!("application/vnd.apple.mpegurl"))
    );
    assert_eq!(
        t.post("/api/iptv/stream/vod/99/grant").await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.post("/api/iptv/stream/series/nope/grant").await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.post("/api/iptv/stream/series/a%20b/grant").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn dvr_plus_a_viewer_exhaust_the_live_upstream_budget_for_both_clients() {
    for client in ["avplayer", "web"] {
        let t = setup().await;
        t.seed("recording", "dvr:1", Kind::Live, "11", None, None);
        t.seed("other", "plex:43", Kind::Remux, "12", None, None);
        let r = t
            .post(&format!("/api/iptv/stream/live/10/grant?client={client}"))
            .await;
        assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{client}");
        assert_eq!(t.ids(), ["other", "recording"]);
    }
}

#[tokio::test]
async fn a_preview_borrows_or_coexists_and_a_watch_replaces() {
    let t = setup().await;
    t.post("/api/iptv/stream/live/10/grant?client=avplayer")
        .await;
    let original = t.ids();
    let r = t
        .post("/api/iptv/stream/live/10/grant?client=avplayer&intent=preview")
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json().get("sessionId").is_none());
    assert_eq!(t.ids(), original);

    t.post("/api/iptv/stream/live/20/grant?client=avplayer&intent=preview")
        .await;
    let rids = |t: &T| {
        let mut v: Vec<String> = t
            .tracker()
            .list()
            .into_iter()
            .map(|s| s.resource_id)
            .collect();
        v.sort();
        v
    };
    assert_eq!(rids(&t), ["10", "20"], "a preview never evicts the watch");
    t.post("/api/iptv/stream/live/30/grant?client=avplayer")
        .await;
    assert_eq!(
        rids(&t),
        ["30"],
        "a watch replaces the account's other tuners"
    );
}

#[tokio::test]
async fn a_full_cap_switch_replaces_only_the_caller() {
    let t = setup().await;
    t.post("/api/iptv/stream/live/10/grant?client=avplayer")
        .await;
    t.seed("other", "plex:43", Kind::Remux, "11", None, None);
    assert_eq!(
        t.post("/api/iptv/stream/live/20/grant?client=avplayer")
            .await
            .status,
        StatusCode::OK
    );
    let mut rids: Vec<String> = t
        .tracker()
        .list()
        .into_iter()
        .map(|s| s.resource_id)
        .collect();
    rids.sort();
    assert_eq!(rids, ["11", "20"]);
}

// ---- raw live ----------------------------------------------------------------------

fn live_files(
    handler: impl Fn(String) -> Response + Clone + Send + Sync + 'static,
) -> Router<Hits> {
    Router::new().route(
        "/live/u/p/{file}",
        get(move |Path(file): Path<String>| {
            let h = handler.clone();
            async move { h(file) }
        }),
    )
}

#[tokio::test]
async fn bad_tokens_and_foreign_subs_are_refused_before_any_dial() {
    let t = setup_with(live_files(|_| endless().into_response()), &[]).await;
    assert_eq!(
        t.get("/api/iptv/stream/live/10.ts?t=bogus").await.status,
        StatusCode::UNAUTHORIZED
    );
    let r = t
        .get(&format!(
            "/api/iptv/stream/live/10.ts?t={}",
            token(StreamKind::Live, "11", "plex:42")
        ))
        .await;
    assert_eq!(r.json(), json!({"error": "token_mismatch"}));
    let r = t
        .get(&format!(
            "/api/iptv/stream/live/10.ts?t={}",
            token(StreamKind::Live, "10", "plex:7")
        ))
        .await;
    assert_eq!(
        r.json(),
        json!({"error": "invalid_token", "detail": "sub_mismatch"})
    );
    let bare = token(StreamKind::Live, "10", "42");
    let r = t
        .call(
            "GET",
            &format!("/api/iptv/stream/live/10.ts?t={bare}"),
            ("42", "user"),
            &[],
        )
        .await;
    assert_eq!(
        r.json(),
        json!({"error": "invalid_token", "detail": "sub_invalid_format"})
    );
    assert!(t.hits().is_empty());
    assert!(t.ids().is_empty());
}

#[tokio::test]
async fn direct_playlist_byte_requests_take_the_upstream_budget_before_dialing() {
    let t = setup_with(
        live_files(|_| endless().into_response()),
        &[("IPTV_MAX_CONCURRENT_STREAMS", "2")],
    )
    .await;
    let mut open = Vec::new();
    for i in 0..2 {
        let sub = format!("plex:{}", 42 + i);
        let id = (10 + i).to_string();
        let uri = format!(
            "/api/iptv/stream/live/{id}.ts?t={}",
            token(StreamKind::Live, &id, &sub)
        );
        let res = t.raw("GET", &uri, (&sub, "user"), &[]).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "video/mp2t");
        assert_eq!(
            res.headers()[header::CACHE_CONTROL],
            "no-store, no-transform"
        );
        assert_eq!(res.headers()["x-accel-buffering"], "no");
        open.push(res);
    }
    assert_eq!(t.tracker().size(), 2);
    let uri = format!(
        "/api/iptv/stream/live/12.ts?t={}",
        token(StreamKind::Live, "12", "plex:44")
    );
    let denied = t.call("GET", &uri, ("plex:44", "user"), &[]).await;
    assert_eq!(denied.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(t.hits().len(), 2);
    for h in t.hits() {
        assert!(h.ends_with("ua=IPTVSmarters"), "{h}");
    }
    drop(open);
    assert_eq!(t.tracker().size(), 0, "dropped bodies release their slots");
}

#[tokio::test]
async fn a_replaced_raw_request_stops_and_its_late_abort_keeps_the_new_stream() {
    let t = setup_with(live_files(|_| endless().into_response()), &[]).await;
    let uri = format!(
        "/api/iptv/stream/live/10.ts?t={}",
        token(StreamKind::Live, "10", "plex:42")
    );
    let old = t.raw("GET", &uri, ("plex:42", "admin"), &[]).await;
    let owner = t.ids();
    let new = t.raw("GET", &uri, ("plex:42", "admin"), &[]).await;
    let mut old_body = old.into_body().into_data_stream();
    // The old proxy was stopped: whatever it buffered, then the end.
    while let Some(c) = next_chunk(&mut old_body).await {
        c.unwrap();
    }
    drop(old_body);
    assert_eq!(
        t.ids(),
        owner,
        "the late teardown did not release the new stream"
    );
    let mut new_body = new.into_body().into_data_stream();
    assert!(next_chunk(&mut new_body).await.unwrap().is_ok());

    // A sessions-widget release stops the stream too.
    let r = t
        .call(
            "DELETE",
            &format!("/api/iptv/sessions/{}", owner[0]),
            ("plex:42", "admin"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(next_chunk(&mut new_body).await.is_none());
}

#[tokio::test]
async fn a_provider_body_error_releases_the_reservation() {
    let files = live_files(|_| Body::from_stream(async_stream_error()).into_response());
    let t = setup_with(files, &[]).await;
    let uri = format!(
        "/api/iptv/stream/live/10.ts?t={}",
        token(StreamKind::Live, "10", "plex:42")
    );
    let mut body = t
        .raw("GET", &uri, ("plex:42", "admin"), &[])
        .await
        .into_body()
        .into_data_stream();
    assert!(next_chunk(&mut body).await.unwrap().is_ok());
    assert_eq!(t.tracker().size(), 1);
    assert!(next_chunk(&mut body).await.unwrap().is_err());
    drop(body);
    assert_eq!(t.tracker().size(), 0);
}

#[tokio::test]
async fn a_retune_drops_the_superseded_dial_before_its_headers_arrive() {
    // A panel that accepts the live dial and never answers: (open, accepted).
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", l.local_addr().unwrap());
    test_public(&host);
    let open = Arc::new(AtomicUsize::new(0));
    let accepted = Arc::new(AtomicUsize::new(0));
    let (o, a) = (open.clone(), accepted.clone());
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = l.accept().await.unwrap();
            o.fetch_add(1, Ordering::SeqCst);
            a.fetch_add(1, Ordering::SeqCst);
            let o = o.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buf = [0u8; 1024];
                while matches!(sock.read(&mut buf).await, Ok(n) if n > 0) {}
                o.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    let t = setup_with(
        Router::new(),
        &[
            ("XTREAM_HOST", host.as_str()),
            ("IPTV_MAX_UPSTREAM_CONNECTIONS", "1"),
        ],
    )
    .await;
    let uri = format!(
        "/api/iptv/stream/live/10.ts?t={}",
        token(StreamKind::Live, "10", "plex:42")
    );
    let mut reqs = Vec::new();
    for n in 1..=3 {
        let (app, uri) = (t.app.clone(), uri.clone());
        reqs.push(tokio::spawn(async move {
            let req = Request::builder()
                .uri(uri)
                .header(header::AUTHORIZATION, bearer("plex:42", "admin"))
                .body(Body::empty())
                .unwrap();
            app.oneshot(req).await.unwrap()
        }));
        until("the dial", || accepted.load(Ordering::SeqCst) == n).await;
    }
    until("one provider socket", || open.load(Ordering::SeqCst) == 1).await;
    for r in reqs.drain(..2) {
        let res = r.await.unwrap();
        assert_eq!(res.status(), StatusCode::GONE);
    }
    assert_eq!(t.tracker().size(), 1, "the live retune keeps its one slot");
    reqs[0].abort();
}

#[tokio::test]
async fn a_stop_closes_the_provider_socket_while_the_client_has_stopped_reading() {
    // A panel that answers each live dial with one chunk and keeps the socket
    // open; `open` counts provider sockets the service has not closed.
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", l.local_addr().unwrap());
    test_public(&host);
    let open = Arc::new(AtomicUsize::new(0));
    let o = open.clone();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = l.accept().await.unwrap();
            o.fetch_add(1, Ordering::SeqCst);
            let o = o.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: video/mp2t\r\n\
                          transfer-encoding: chunked\r\n\r\n2\r\nG@\r\n",
                    )
                    .await;
                while matches!(sock.read(&mut buf).await, Ok(n) if n > 0) {}
                o.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    let t = setup_with(Router::new(), &[("XTREAM_HOST", host.as_str())]).await;
    let uri = format!(
        "/api/iptv/stream/live/10.ts?t={}",
        token(StreamKind::Live, "10", "plex:42")
    );
    // Neither body is ever polled: a stalled player.
    let old = t.raw("GET", &uri, ("plex:42", "admin"), &[]).await;
    assert_eq!(old.status(), StatusCode::OK);
    let new = t.raw("GET", &uri, ("plex:42", "admin"), &[]).await;
    assert_eq!(new.status(), StatusCode::OK);
    until("the retune to close the old socket", || {
        open.load(Ordering::SeqCst) == 1
    })
    .await;
    assert_eq!(t.tracker().size(), 1, "the retune keeps its one slot");

    // A sessions-widget release closes the remaining socket the same way.
    let id = t.ids().remove(0);
    let r = t
        .call(
            "DELETE",
            &format!("/api/iptv/sessions/{id}"),
            ("plex:42", "admin"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    until("the kick to close the socket", || {
        open.load(Ordering::SeqCst) == 0
    })
    .await;
    drop((old, new));
}

/// One chunk, a beat, then a transport error.
fn async_stream_error() -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::unfold(0, |n| async move {
        match n {
            0 => Some((Ok(Bytes::from_static(b"\x47\x40")), 1)),
            1 => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Some((Err(std::io::Error::other("provider disconnected")), 2))
            }
            _ => None,
        }
    })
}

async fn gate95(t: &T) {
    channel(
        &t.state.pool,
        900,
        900,
        "Gate95 Sports",
        None,
        Some("gate95.us"),
        9,
    )
    .await;
    channel(
        &t.state.pool,
        901,
        901,
        "Gate95 Sports",
        None,
        Some("gate95.us"),
        9,
    )
    .await;
}

fn gate_uri() -> String {
    format!(
        "/api/iptv/stream/live/900.ts?t={}",
        token(StreamKind::Live, "900", "plex:42")
    )
}

fn dialed(t: &T) -> Vec<String> {
    t.hits()
        .iter()
        .map(|h| h.split(' ').next().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_hard_down_feed_fails_over_to_a_live_sibling() {
    let files = live_files(|f| match f.as_str() {
        "900.ts" => StatusCode::NOT_FOUND.into_response(),
        _ => "sibling-bytes".into_response(),
    });
    let t = setup_with(files, &[]).await;
    gate95(&t).await;
    let r = t.get(&gate_uri()).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.text(), "sibling-bytes");
    assert_eq!(dialed(&t), ["/live/u/p/900.ts", "/live/u/p/901.ts"]);
}

#[tokio::test]
async fn every_candidate_down_is_503_channel_offline_and_frees_the_slot() {
    let t = setup_with(live_files(|_| StatusCode::NOT_FOUND.into_response()), &[]).await;
    gate95(&t).await;
    let r = t.get(&gate_uri()).await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "channel_offline_upstream"})
        )
    );
    assert!(t.ids().is_empty());
}

#[tokio::test]
async fn two_clean_fast_eofs_tag_a_feed_dead_and_the_next_tune_skips_it() {
    let files = live_files(|f| match f.as_str() {
        "900.ts" => "slate".into_response(),
        _ => endless().into_response(),
    });
    let t = setup_with(files, &[]).await;
    gate95(&t).await;
    assert_eq!(t.get(&gate_uri()).await.text(), "slate");
    assert!(
        !t.state.streams.dead.is_dead("900"),
        "one strike is a possible cap kick"
    );
    assert_eq!(t.get(&gate_uri()).await.text(), "slate");
    assert!(t.state.streams.dead.is_dead("900"));
    let mut body = t
        .raw("GET", &gate_uri(), ("plex:42", "admin"), &[])
        .await
        .into_body()
        .into_data_stream();
    assert!(next_chunk(&mut body).await.unwrap().is_ok());
    assert_eq!(
        dialed(&t),
        ["/live/u/p/900.ts", "/live/u/p/900.ts", "/live/u/p/901.ts"]
    );
}

#[tokio::test]
async fn a_redirect_into_a_private_address_is_skipped_for_the_next_sibling() {
    let internal_hits = Arc::new(AtomicUsize::new(0));
    let ih = internal_hits.clone();
    let internal = spawn(Router::new().fallback(move || {
        ih.fetch_add(1, Ordering::SeqCst);
        async { "secret" }
    }))
    .await;
    let files = live_files(move |f| match f.as_str() {
        "900.ts" => (
            StatusCode::FOUND,
            [(header::LOCATION, format!("{internal}/x.ts"))],
        )
            .into_response(),
        _ => "sibling-bytes".into_response(),
    });
    let t = setup_with(files, &[]).await;
    gate95(&t).await;
    assert_eq!(t.get(&gate_uri()).await.text(), "sibling-bytes");
    assert_eq!(internal_hits.load(Ordering::SeqCst), 0);
}

// ---- catch-up and on-demand ---------------------------------------------------------

#[tokio::test]
async fn catchup_proxies_the_xtream_timeshift_endpoint() {
    let files = Router::new().route("/streaming/timeshift.php", get(|| async { "ts" }));
    let t = setup_with(files, &[]).await;
    let start = "2026-05-24T12:00:00Z";
    let tok = token(StreamKind::Catchup, &format!("10|{start}|30"), "plex:42");
    let r = t
        .get(&format!(
            "/api/iptv/stream/catchup/10/{}/30.ts?t={tok}",
            encode_uri_component(start)
        ))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers[header::CONTENT_TYPE], "video/mp2t");
    assert_eq!(r.text(), "ts");
    assert_eq!(
        dialed(&t),
        [
            "/streaming/timeshift.php?username=u&password=p&stream=10&start=2026-05-24:12-00&duration=30"
        ]
    );
    let r = t
        .get(&format!(
            "/api/iptv/stream/catchup/10/{}/0.ts?t={tok}",
            encode_uri_component(start)
        ))
        .await;
    assert_eq!(r.json()["error"], "invalid_params");
}

fn file_routes(
    handler: impl Fn(String) -> Response + Clone + Send + Sync + 'static,
) -> Router<Hits> {
    let h2 = handler.clone();
    Router::new()
        .route(
            "/movie/u/p/{file}",
            get(move |Path(f): Path<String>| {
                let h = handler.clone();
                async move { h(f) }
            }),
        )
        .route(
            "/series/u/p/{file}",
            get(move |Path(f): Path<String>| {
                let h = h2.clone();
                async move { h(f) }
            }),
        )
}

#[tokio::test]
async fn vod_range_requests_pass_through() {
    let files = file_routes(|_| {
        (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_RANGE, "bytes 0-2/10"),
                (header::ACCEPT_RANGES, "bytes"),
            ],
            "abc",
        )
            .into_response()
    });
    let t = setup_with(files, &[]).await;
    let tok = token(StreamKind::Vod, "20", "plex:42");
    let r = t
        .call(
            "GET",
            &format!("/api/iptv/stream/vod/20/mp4?t={tok}"),
            ("plex:42", "admin"),
            &[("range", "bytes=0-2")],
        )
        .await;
    assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.headers[header::CONTENT_RANGE], "bytes 0-2/10");
    assert_eq!(r.headers[header::CONTENT_LENGTH], "3");
    assert_eq!(r.headers[header::CONTENT_TYPE], "video/mp4");
    assert_eq!(
        t.hits(),
        ["/movie/u/p/20.mp4 range=bytes=0-2 ua=IPTVSmarters"]
    );
}

#[tokio::test]
async fn a_client_abort_mid_fetch_releases_the_on_demand_slot() {
    for (path, kind, rid) in [
        ("vod/20/mp4", StreamKind::Vod, "20"),
        ("series/ep-1/mkv", StreamKind::Series, "ep-1"),
    ] {
        let hang = Router::new()
            .route(
                "/movie/u/p/{f}",
                get(futures_util::future::pending::<&'static str>),
            )
            .route(
                "/series/u/p/{f}",
                get(futures_util::future::pending::<&'static str>),
            );
        let t = setup_with(hang, &[]).await;
        let uri = format!("/api/iptv/stream/{path}?t={}", token(kind, rid, "plex:42"));
        let app = t.app.clone();
        let req = Request::get(uri)
            .header(header::AUTHORIZATION, bearer("plex:42", "admin"))
            .body(Body::empty())
            .unwrap();
        let task = tokio::spawn(app.oneshot(req));
        for _ in 0..100 {
            if !t.hits().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            t.tracker().size(),
            1,
            "{path}: the slot is held while the dial is pending"
        );
        task.abort();
        let _ = task.await;
        assert_eq!(t.tracker().size(), 0, "{path}");
    }
}

#[tokio::test]
async fn an_injected_query_in_the_ext_is_refused_before_any_fetch() {
    let t = setup_with(file_routes(|_| "x".into_response()), &[]).await;
    let tok = token(StreamKind::Series, "ep-1", "plex:42");
    let r = t
        .get(&format!(
            "/api/iptv/stream/series/ep-1/mp4%3Fdel%3D1?t={tok}"
        ))
        .await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_id"))
    );
    assert!(t.hits().is_empty());
}

const MASTER: &str = "#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"en\",URI=\"subs/en.m3u8\"\n\
                      #EXT-X-STREAM-INF:BANDWIDTH=1280000\nlevel1.m3u8\n#EXTINF:6.0,\nseg-001.ts";

fn segment_lines(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| l.contains(hls::SEGMENT_PATH))
        .map(String::from)
        .collect()
}

/// The upstream URL a rewritten segment line points at.
fn segment_rid(line: &str) -> (String, i64) {
    let start = line.find("u=").unwrap() + 2;
    let tok: String = line[start..]
        .chars()
        .take_while(|c| *c != '&' && *c != '"')
        .collect();
    let (k, rid, ttl) = claims_of(&tok);
    assert_eq!(k, StreamKind::Segment);
    (rid, ttl)
}

#[tokio::test]
async fn hls_vod_playlists_are_rewritten_and_tagged_with_their_grant() {
    let t = setup_with(file_routes(|_| MASTER.into_response()), &[]).await;
    let r = t
        .get(&format!(
            "/api/iptv/stream/vod/20/m3u8?t={}",
            token(StreamKind::Vod, "20", "plex:42")
        ))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.headers[header::CONTENT_TYPE],
        "application/vnd.apple.mpegurl"
    );
    let lines = segment_lines(&r.text());
    assert_eq!(lines.len(), 3);
    for l in &lines {
        assert!(l.contains("&ok=vod&oid=20"), "{l}");
    }
    assert_eq!(
        segment_rid(lines.last().unwrap()),
        (format!("{}/movie/u/p/seg-001.ts", t.panel), 21_600)
    );

    let r = t
        .get(&format!(
            "/api/iptv/stream/series/ep-1/m3u8?t={}",
            token(StreamKind::Series, "ep-1", "plex:42")
        ))
        .await;
    for l in segment_lines(&r.text()) {
        assert!(l.contains("&ok=series&oid=ep-1"), "{l}");
    }
}

#[tokio::test]
async fn relative_uris_resolve_against_the_post_redirect_url() {
    let cdn = public(Router::new().route(
        "/hls/abc/index.m3u8",
        get(|| async {
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg_1.ts\n#EXT-X-ENDLIST\n"
        }),
    ))
    .await;
    let files = file_routes(move |_| {
        (
            StatusCode::FOUND,
            [(header::LOCATION, format!("{cdn}/hls/abc/index.m3u8"))],
        )
            .into_response()
    });
    let t = setup_with(files, &[]).await;
    exec(&t.state.pool, "INSERT INTO vod (stream_id, name, container_extension, fetched_at) VALUES (42, 'X', 'm3u8', 'x');").await;
    let r = t
        .get(&format!(
            "/api/iptv/stream/vod/42/m3u8?t={}",
            token(StreamKind::Vod, "42", "plex:42")
        ))
        .await;
    let line = segment_lines(&r.text()).pop().unwrap();
    let cdn_base = t.hits().len(); // the panel saw only its own request
    assert_eq!(cdn_base, 1);
    assert!(segment_rid(&line).0.ends_with("/hls/abc/seg_1.ts"));
    assert!(!segment_rid(&line).0.starts_with(&t.panel));
}

#[tokio::test]
async fn a_manifest_is_bounded_in_time_and_size() {
    let hang = Router::new().route(
        "/movie/u/p/{f}",
        get(futures_util::future::pending::<&'static str>),
    );
    let t = setup_with(hang, &[("IPTV_MANIFEST_FETCH_TIMEOUT_MS", "50")]).await;
    let r = t
        .get(&format!(
            "/api/iptv/stream/vod/20/m3u8?t={}",
            token(StreamKind::Vod, "20", "plex:42")
        ))
        .await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (StatusCode::GATEWAY_TIMEOUT, json!("upstream_timeout"))
    );

    let big = Router::new().route(
        "/movie/u/p/{f}",
        get(|| async { format!("#EXTM3U\n{}", "X".repeat(1024)) }),
    );
    let t = setup_with(big, &[("IPTV_MANIFEST_MAX_BYTES", "64")]).await;
    let r = t
        .get(&format!(
            "/api/iptv/stream/vod/20/m3u8?t={}",
            token(StreamKind::Vod, "20", "plex:42")
        ))
        .await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (StatusCode::BAD_GATEWAY, json!("manifest_too_large"))
    );
}

// ---- segment proxy -----------------------------------------------------------------

async fn cdn(hits: &Hits) -> String {
    let h = hits.clone();
    public(
        Router::new()
            .route(
                "/foo/level1.m3u8",
                get(|| async { "#EXTM3U\n#EXTINF:6.0,\nseg.ts" }),
            )
            .fallback(move |req: Request<Body>| {
                recorder(&h, &req);
                async {
                    (
                        StatusCode::PARTIAL_CONTENT,
                        [
                            (header::CONTENT_TYPE, "video/mp2t"),
                            (header::CONTENT_RANGE, "bytes 0-2/12"),
                        ],
                        "seg",
                    )
                }
            }),
    )
    .await
}

fn seg_uri(rid: &str, sub: &str, owner: &str) -> String {
    format!(
        "/api/iptv/stream/segment?u={}{owner}",
        token(StreamKind::Segment, rid, sub)
    )
}

#[tokio::test]
async fn segments_pass_through_with_range() {
    let t = setup().await;
    let hits: Hits = Arc::default();
    let cdn = cdn(&hits).await;
    let r = t
        .call(
            "GET",
            &seg_uri(&format!("{cdn}/foo/seg.ts"), "plex:42", ""),
            ("plex:42", "admin"),
            &[("range", "bytes=0-2")],
        )
        .await;
    assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.headers[header::CONTENT_TYPE], "video/mp2t");
    assert_eq!(r.headers[header::CONTENT_RANGE], "bytes 0-2/12");
    assert_eq!(r.text(), "seg");
    assert_eq!(
        hits.lock().unwrap()[0],
        "/foo/seg.ts range=bytes=0-2 ua=IPTVSmarters"
    );
    assert!(t.ids().is_empty(), "an untagged segment holds no slot");
}

#[tokio::test]
async fn internal_segment_targets_are_refused_before_any_fetch() {
    let t = setup().await;
    for evil in [
        "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "https://10.0.0.1/seg.ts",
        "https://recommender:8000/internal",
        "http://169.254.169.254/latest/meta-data/",
        "http://recommender:8000/internal",
        "file:///etc/passwd",
        "not a valid url",
    ] {
        let r = t.get(&seg_uri(evil, "plex:42", "")).await;
        assert_eq!(
            (r.status, r.json()["error"].clone()),
            (StatusCode::BAD_REQUEST, json!("bad_upstream")),
            "{evil}"
        );
    }
}

#[tokio::test]
async fn a_segment_redirect_into_a_private_address_is_refused() {
    let t = setup().await;
    let internal_hits = Arc::new(AtomicUsize::new(0));
    let ih = internal_hits.clone();
    let internal = spawn(Router::new().fallback(move || {
        ih.fetch_add(1, Ordering::SeqCst);
        async { "internal-secret" }
    }))
    .await;
    let cdn = public(Router::new().fallback(move || {
        let to = format!("{internal}/latest/meta-data/");
        async move { (StatusCode::FOUND, [(header::LOCATION, to)]) }
    }))
    .await;
    let r = t
        .get(&seg_uri(&format!("{cdn}/seg.ts"), "plex:42", ""))
        .await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (StatusCode::BAD_REQUEST, json!("bad_upstream"))
    );
    assert_eq!(internal_hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn segment_token_kind_and_transport_failures() {
    let t = setup().await;
    let r = t
        .get(&format!(
            "/api/iptv/stream/segment?u={}",
            token(
                StreamKind::Live,
                "https://cdn.example.com/seg.ts",
                "plex:42"
            )
        ))
        .await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::UNAUTHORIZED,
            json!({"error": "invalid_token", "detail": "kind_mismatch"})
        )
    );
    let r = t
        .get("/api/iptv/stream/segment?u=bogus&ok=vod&oid=20")
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert!(t.ids().is_empty());
    // A public host with nothing listening: a transport error, not bad_upstream.
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", dead.local_addr().unwrap());
    drop(dead);
    test_public(&base);
    let r = t
        .get(&seg_uri(&format!("{base}/net-fail.ts"), "plex:42", ""))
        .await;
    assert_eq!(r.status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn sub_playlists_recurse_and_carry_the_owner_and_its_heartbeat() {
    let t = setup().await;
    let hits: Hits = Arc::default();
    let cdn = cdn(&hits).await;
    let r = t
        .get(&seg_uri(
            &format!("{cdn}/foo/level1.m3u8"),
            "plex:42",
            "&ok=series&oid=ep-1",
        ))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let lines = segment_lines(&r.text());
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("&ok=series&oid=ep-1"));
    assert_eq!(segment_rid(&lines[0]).0, format!("{cdn}/foo/seg.ts"));
    let s = t.tracker().list();
    assert_eq!(
        (s.len(), s[0].kind, s[0].resource_id.as_str()),
        (1, Kind::Series, "ep-1")
    );
}

#[tokio::test]
async fn every_tagged_segment_fetch_keeps_the_grant_and_bad_tags_are_ignored() {
    let t = setup().await;
    let hits: Hits = Arc::default();
    let cdn = cdn(&hits).await;
    for i in 0..3 {
        let r = t
            .get(&seg_uri(
                &format!("{cdn}/foo/seg-00{i}.ts"),
                "plex:42",
                "&ok=vod&oid=20",
            ))
            .await;
        assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    }
    let s = t.tracker().list();
    assert_eq!(
        (s.len(), s[0].sub.as_str(), s[0].kind),
        (1, "plex:42", Kind::Vod)
    );

    let t = setup().await;
    for q in [
        "",
        "&ok=vod",
        "&oid=20",
        "&ok=live&oid=10",
        "&ok=remux&oid=10",
        "&ok=catchup&oid=10",
        "&ok=vod&oid=..%2F..%2Fetc%2Fpasswd",
        "&ok=vod&oid=20'%20OR%201%3D1",
    ] {
        let r = t
            .get(&seg_uri(&format!("{cdn}/foo/seg.ts"), "plex:42", q))
            .await;
        assert_eq!(r.status, StatusCode::PARTIAL_CONTENT, "{q}");
    }
    assert!(t.ids().is_empty());

    // The heartbeat belongs to the signed sub, never a client-supplied one.
    let r = t
        .call(
            "GET",
            &seg_uri(
                &format!("{cdn}/foo/seg.ts"),
                "plex:99",
                "&ok=vod&oid=20&sub=plex%3A42",
            ),
            ("plex:99", "user"),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(t.tracker().list()[0].sub, "plex:99");
}

// ---- held slots ----------------------------------------------------------------------

#[tokio::test]
async fn on_demand_byte_routes_retake_a_swept_slot_or_429_when_full() {
    let start = "2026-05-24T10:00:00.000Z";
    let catchup_rid = format!("10|{start}|30");
    let routes = |cdn: &str| {
        vec![
            (
                Kind::Vod,
                "20".to_string(),
                format!(
                    "/api/iptv/stream/vod/20/mp4?t={}",
                    token(StreamKind::Vod, "20", "plex:42")
                ),
            ),
            (
                Kind::Series,
                "ep-1".to_string(),
                format!(
                    "/api/iptv/stream/series/ep-1/mkv?t={}",
                    token(StreamKind::Series, "ep-1", "plex:42")
                ),
            ),
            (
                Kind::Vod,
                "20".to_string(),
                seg_uri(&format!("{cdn}/seg.ts"), "plex:42", "&ok=vod&oid=20"),
            ),
            (
                Kind::Catchup,
                catchup_rid.clone(),
                format!(
                    "/api/iptv/stream/catchup/10/{}/30.ts?t={}",
                    encode_uri_component(start),
                    token(StreamKind::Catchup, &catchup_rid, "plex:42")
                ),
            ),
        ]
    };
    let files = || {
        file_routes(|_| "abc".into_response())
            .route("/streaming/timeshift.php", get(|| async { "abc" }))
    };
    let hits: Hits = Arc::default();
    let cdn = cdn(&hits).await;
    for (kind, rid, uri) in routes(&cdn) {
        let t = setup_with(files(), &[("IPTV_MAX_CONCURRENT_STREAMS", "2")]).await;
        assert!(t.get(&uri).await.status.is_success(), "{uri}");
        let s = t.tracker().list();
        assert_eq!(
            (
                s.len(),
                s[0].sub.as_str(),
                s[0].kind,
                s[0].resource_id.clone()
            ),
            (1, "plex:42", kind, rid)
        );
    }
    let before = hits.lock().unwrap().len();
    for (_, _, uri) in routes(&cdn) {
        let t = setup_with(files(), &[("IPTV_MAX_CONCURRENT_STREAMS", "1")]).await;
        t.seed("other", "plex:7", Kind::Live, "99", None, None);
        assert_eq!(
            t.get(&uri).await.status,
            StatusCode::TOO_MANY_REQUESTS,
            "{uri}"
        );
        assert!(t.hits().is_empty());
    }
    assert_eq!(hits.lock().unwrap().len(), before);
}

#[tokio::test]
async fn session_titles_join_series_and_episode_with_fallbacks() {
    let t = setup().await;
    exec(
        &t.state.pool,
        "INSERT INTO series_episodes (episode_id, series_id, season, episode_num, title, container_extension)
           VALUES ('ep-null-title', 30, 1, 2, NULL, 'mkv');
         INSERT INTO series (series_id, name, fetched_at) VALUES (31, 'DoomedShow', 'x');
         INSERT INTO series_episodes (episode_id, series_id, season, episode_num, title, container_extension)
           VALUES ('ep-orphan', 31, 1, 1, 'Orphan Ep', 'mkv');
         PRAGMA foreign_keys = OFF; DELETE FROM series WHERE series_id = 31; PRAGMA foreign_keys = ON;",
    )
    .await;
    let title = |id: &'static str| session_title(&t.state, Kind::Series, id);
    assert_eq!(title("ep-1").await.as_deref(), Some("GoT \u{2014} Pilot"));
    assert_eq!(title("ep-null-title").await.as_deref(), Some("GoT"));
    assert_eq!(title("ep-orphan").await.as_deref(), Some("Orphan Ep"));
    assert_eq!(title("no-such-episode").await, None);
    assert_eq!(
        session_title(&t.state, Kind::Catchup, "10|x|30")
            .await
            .as_deref(),
        Some("CNN")
    );
}

// ---- live remux (AVPlayer) ---------------------------------------------------------

use crate::remux::tests::{Fake, LIVE, SEGS, until};

async fn remux_setup(run: &str) -> (T, Fake) {
    let fake = Fake::new(run);
    let pairs = fake.pairs();
    let p: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    (setup_with(Router::new(), &p).await, fake)
}

fn manifest_uri(id: &str, sub: &str) -> String {
    format!(
        "/api/iptv/stream/live/{id}/remux/index.m3u8?t={}",
        token(StreamKind::Remux, id, sub)
    )
}

fn seg_uri_for(id: &str, rid: &str, kind: StreamKind) -> String {
    format!(
        "/api/iptv/stream/live/{id}/remux/seg?t={}",
        token(kind, rid, "plex:42")
    )
}

impl T {
    async fn watch(&self, id: &str) -> Res {
        let g = self
            .post(&format!("/api/iptv/stream/live/{id}/grant?client=avplayer"))
            .await;
        assert_eq!(g.status, StatusCode::OK, "{}", g.text());
        self.get(&manifest_uri(id, "plex:42")).await
    }
    fn remux_session(&self, id: &str) -> Option<String> {
        self.state
            .streams
            .live
            .get_active(id, "plex:42")
            .map(|e| e.session_id)
    }
}

#[tokio::test]
async fn the_manifest_refuses_a_bad_id_or_token() {
    let (t, fake) = remux_setup(SEGS).await;
    let r = t.get(&manifest_uri("abc", "plex:42")).await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_id"))
    );
    let r = t
        .get("/api/iptv/stream/live/10/remux/index.m3u8?t=bogus")
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t.get(&manifest_uri("10", "plex:42")).await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::GONE, json!({"error": "session_gone"})),
        "no reservation"
    );
    assert!(fake.pids().is_empty());
}

#[tokio::test]
async fn the_manifest_starts_a_remux_and_serves_stable_signed_segment_urls() {
    let (t, fake) = remux_setup(&format!("{SEGS}{LIVE}")).await;
    let r = t.watch("10").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        r.headers[header::CONTENT_TYPE],
        "application/vnd.apple.mpegurl"
    );
    assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
    let text = r.text();
    assert!(text.starts_with("#EXTM3U\n"), "{text}");
    assert!(text.contains("#EXTINF:2.0,"));
    assert!(
        !text.contains("#EXT-X-DISCONTINUITY"),
        "the pre-segment tag is dropped"
    );
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| l.contains("/remux/seg?t="))
        .collect();
    assert_eq!(lines.len(), 4);
    assert!(!text.lines().any(|l| l.starts_with("seg_")));
    let session = t.remux_session("10").unwrap();
    let (kind, rid, ttl) = claims_of(&query_token(lines[0], "t"));
    assert_eq!(
        (kind, rid, ttl),
        (StreamKind::Remux, format!("{session}/seg_00000.ts"), 300)
    );
    let argv = &fake.argvs()[0];
    let i = argv.iter().position(|a| a == "-i").unwrap();
    assert_eq!(argv[i + 1], format!("{}/live/u/p/10.ts", t.panel));
    // A reload keeps every URL (AVPlayer -12312 otherwise).
    let again = t.get(&manifest_uri("10", "plex:42")).await;
    assert_eq!(again.text(), text);
    assert_eq!(fake.pids().len(), 1);

    let seg = t
        .get(&format!(
            "/api/iptv/stream/live/10/remux/seg?t={}",
            query_token(lines[0], "t")
        ))
        .await;
    assert_eq!(seg.status, StatusCode::OK);
    assert_eq!(seg.headers[header::CONTENT_TYPE], "video/mp2t");
    assert_eq!(&seg.body[..], b"seg0");
}

#[tokio::test]
async fn a_feed_that_dies_before_its_window_is_503_remux_warming_with_retry_after() {
    let (t, fake) = remux_setup("exit 255\n").await;
    let r = t.watch("10").await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "remux_warming"})
        )
    );
    assert_eq!(r.headers[header::RETRY_AFTER], "3");
    // The reconnect throttle held the redial back.
    assert_eq!(fake.pids().len(), 1);
}

#[tokio::test]
async fn a_dead_feed_is_terminal_channel_offline_without_a_dial() {
    let (t, fake) = remux_setup(SEGS).await;
    t.state.streams.dead.strike("10");
    t.state.streams.dead.strike("10");
    let r = t.watch("10").await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "channel_offline_upstream"})
        )
    );
    assert!(r.headers.get(header::RETRY_AFTER).is_none());
    assert!(fake.pids().is_empty());
}

#[tokio::test]
async fn the_segment_route_checks_id_kind_resource_session_and_file() {
    let (t, _fake) = remux_setup(&format!("{SEGS}{LIVE}")).await;
    let err = |r: &Res| (r.status, r.json()["error"].clone());
    let r = t
        .get(&seg_uri_for("x", "sess-1/seg_00000.ts", StreamKind::Remux))
        .await;
    assert_eq!(err(&r), (StatusCode::BAD_REQUEST, json!("invalid_id")));
    let r = t
        .get(&seg_uri_for(
            "10",
            "sess-1/seg_00000.ts",
            StreamKind::Segment,
        ))
        .await;
    assert_eq!(err(&r), (StatusCode::UNAUTHORIZED, json!("invalid_token")));
    let r = t
        .get(&seg_uri_for("10", "sess-1/notaseg.ts", StreamKind::Remux))
        .await;
    assert_eq!(err(&r), (StatusCode::BAD_REQUEST, json!("bad_resource")));
    let g = t
        .post("/api/iptv/stream/live/10/grant?client=avplayer")
        .await;
    assert_eq!(g.status, StatusCode::OK);
    let r = t
        .get(&seg_uri_for("10", "sess-1/seg_00000.ts", StreamKind::Remux))
        .await;
    assert_eq!(
        err(&r),
        (StatusCode::GONE, json!("session_gone")),
        "no index entry"
    );
    assert_eq!(
        t.get(&manifest_uri("10", "plex:42")).await.status,
        StatusCode::OK
    );
    let session = t.remux_session("10").unwrap();
    let r = t
        .get(&seg_uri_for("10", "sess-1/seg_00000.ts", StreamKind::Remux))
        .await;
    assert_eq!(
        err(&r),
        (StatusCode::GONE, json!("session_gone")),
        "another session"
    );
    let r = t
        .get(&seg_uri_for(
            "10",
            &format!("{session}/seg_00009.ts"),
            StreamKind::Remux,
        ))
        .await;
    assert_eq!(err(&r), (StatusCode::NOT_FOUND, json!("segment_gone")));
    let r = t
        .get(&seg_uri_for(
            "10",
            &format!("{session}/seg_00003.ts"),
            StreamKind::Remux,
        ))
        .await;
    assert_eq!((r.status, &r.body[..]), (StatusCode::OK, &b"seg3"[..]));
}

#[tokio::test]
async fn a_watch_grant_stops_the_viewers_other_remux_and_a_preview_does_not() {
    let (t, _fake) = remux_setup(&format!("{SEGS}{LIVE}")).await;
    assert_eq!(t.watch("10").await.status, StatusCode::OK);
    let s10 = t.remux_session("10").unwrap();
    let preview = t
        .post("/api/iptv/stream/live/20/grant?client=avplayer&intent=preview")
        .await;
    assert_eq!(preview.status, StatusCode::OK);
    assert!(t.state.streams.live.remux.is_active(&s10));
    let watch = t
        .post("/api/iptv/stream/live/20/grant?client=avplayer")
        .await;
    assert_eq!(watch.status, StatusCode::OK);
    assert!(!t.state.streams.live.remux.is_active(&s10));
}

#[tokio::test]
async fn deleting_a_remux_slot_stops_its_ffmpeg_and_its_token_cannot_reopen_it() {
    let (t, fake) = remux_setup(&format!("{SEGS}{LIVE}")).await;
    assert_eq!(t.watch("10").await.status, StatusCode::OK);
    let s10 = t.remux_session("10").unwrap();
    let slot = t
        .tracker()
        .find("plex:42", Kind::Remux, "10")
        .unwrap()
        .session_id;
    let d = t
        .call(
            "DELETE",
            &format!("/api/iptv/sessions/{slot}"),
            ("plex:42", "admin"),
            &[],
        )
        .await;
    assert_eq!(d.status, StatusCode::OK);
    assert!(!t.state.streams.live.remux.is_active(&s10));
    let stale = t.get(&manifest_uri("10", "plex:42")).await;
    assert_eq!(stale.status, StatusCode::GONE);
    assert_eq!(fake.pids().len(), 1);
}

#[tokio::test]
async fn deleting_the_grant_while_the_manifest_warms_cannot_respawn_its_child() {
    let (t, fake) = remux_setup(LIVE).await;
    let g = t
        .post("/api/iptv/stream/live/10/grant?client=avplayer")
        .await;
    let slot = g.json()["sessionId"].as_str().unwrap().to_string();
    let req = Request::builder()
        .uri(manifest_uri("10", "plex:42"))
        .header(header::AUTHORIZATION, bearer("plex:42", "admin"))
        .body(Body::empty())
        .unwrap();
    let warming = tokio::spawn(t.app.clone().oneshot(req));
    until("the first dial", || fake.pids().len() == 1).await;
    let d = t
        .call(
            "DELETE",
            &format!("/api/iptv/sessions/{slot}"),
            ("plex:42", "admin"),
            &[],
        )
        .await;
    assert_eq!(d.status, StatusCode::OK);
    let res = tokio::time::timeout(Duration::from_secs(2), warming)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(res.status(), StatusCode::GONE);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fake.pids().len(), 1);
}
