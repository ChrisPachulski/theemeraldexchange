//! plex.test.ts, case for case. The TS suite stubbed fetch with a needle map;
//! here every request goes to a local fake (an axum server on 127.0.0.1)
//! standing in for both plex.tv and the PMS. Nothing leaves the machine.
//! listResources is gone (probe_resources replaced it), so its two cases run
//! against probe_resources.

use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::IntoResponse;
use serde_json::json;

use super::*;
use crate::testutil::{capture_logs, config, logs};

const TOKEN: &str = "plex-token-abc";

pub(crate) struct Stub {
    needle: String,
    status: u16,
    body: String,
    headers: Vec<(String, String)>,
}

/// One request the fake saw: method, path and query, headers.
#[derive(Clone)]
pub(crate) struct Call {
    pub(crate) method: Method,
    pub(crate) url: String,
    pub(crate) headers: HeaderMap,
}

#[derive(Clone)]
pub(crate) struct Fake {
    pub(crate) url: String,
    pub(crate) stubs: Arc<Mutex<Vec<Stub>>>,
    pub(crate) calls: Arc<Mutex<Vec<Call>>>,
}

impl Fake {
    pub(crate) fn stub(&self, needle: &str, status: u16, body: &str, headers: &[(&str, &str)]) {
        let mut stubs = self.stubs.lock().unwrap();
        stubs.retain(|s| s.needle != needle);
        stubs.push(Stub {
            needle: needle.into(),
            status,
            body: body.into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        });
    }

    pub(crate) fn json(&self, needle: &str, body: Value) {
        self.stub(
            needle,
            200,
            &body.to_string(),
            &[("content-type", "application/json")],
        );
    }

    pub(crate) fn text(&self, needle: &str, body: &str, status: u16) {
        self.stub(needle, status, body, &[]);
    }

    fn xml(&self, needle: &str, body: &str) {
        self.stub(needle, 200, body, &[("content-type", "application/xml")]);
    }

    /// Forget every stub and every recorded call.
    pub(crate) fn reset(&self) {
        self.stubs.lock().unwrap().clear();
        self.calls.lock().unwrap().clear();
    }

    /// `METHOD path?query` of every call so far.
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| format!("{} {}", c.method, c.url))
            .collect()
    }

    pub(crate) fn call(&self, i: usize) -> Call {
        self.calls.lock().unwrap()[i].clone()
    }

    pub(crate) fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    /// The fake as both plex.tv and the PMS.
    pub(crate) fn plex(&self) -> Plex {
        Plex::at(&self.url)
    }

    pub(crate) fn config(&self, extra: &[(&str, &str)]) -> Config {
        let mut env = vec![
            ("PLEX_CLIENT_ID", "test-client"),
            ("PLEX_SERVER_URL", self.url.as_str()),
        ];
        env.extend_from_slice(extra);
        config(&env)
    }
}

pub(crate) async fn fake() -> Fake {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake = Fake {
        url: format!("http://{}", listener.local_addr().unwrap()),
        stubs: Arc::default(),
        calls: Arc::default(),
    };
    let served = fake.clone();
    let app = axum::Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
        let f = served.clone();
        async move {
            let url = uri
                .path_and_query()
                .map(|p| p.to_string())
                .unwrap_or_default();
            f.calls.lock().unwrap().push(Call {
                method,
                url: url.clone(),
                headers,
            });
            let stubs = f.stubs.lock().unwrap();
            match stubs.iter().find(|s| url.contains(&s.needle)) {
                Some(s) => {
                    let mut res =
                        (StatusCode::from_u16(s.status).unwrap(), s.body.clone()).into_response();
                    for (k, v) in &s.headers {
                        res.headers_mut().insert(
                            axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                            v.parse().unwrap(),
                        );
                    }
                    res
                }
                None => (
                    StatusCode::from_u16(599).unwrap(),
                    format!("not stubbed: {url}"),
                )
                    .into_response(),
            }
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fake
}

fn header<'a>(call: &'a Call, name: &str) -> Option<&'a str> {
    call.headers.get(name).and_then(|v| v.to_str().ok())
}

fn message<T: std::fmt::Debug>(r: Result<T>) -> String {
    r.unwrap_err().to_string()
}

// ── checkPin ──

#[tokio::test]
async fn check_pin_returns_the_pin_json_and_gets_pins_id() {
    let f = fake().await;
    f.json(
        "/pins/5",
        json!({ "id": 5, "code": "X", "authToken": "tok" }),
    );
    let pin = f.plex().check_pin(&f.config(&[]), 5).await.unwrap();
    assert_eq!(
        pin,
        Pin {
            id: 5,
            code: "X".into(),
            auth_token: Some("tok".into())
        }
    );
    let call = f.call(0);
    assert_eq!(call.method, Method::GET);
    assert_eq!(call.url, "/api/v2/pins/5");
    // The X-Plex-* set, under our product name.
    assert_eq!(header(&call, "x-plex-product"), Some(PLEX_PRODUCT));
    assert_eq!(
        header(&call, "x-plex-client-identifier"),
        Some("test-client")
    );
    assert_eq!(header(&call, "x-plex-device"), Some(PLEX_PRODUCT));
    assert_eq!(header(&call, "x-plex-platform"), Some("Web"));
    assert_eq!(header(&call, "x-plex-version"), Some("0.1.0"));
    assert_eq!(header(&call, "accept"), Some("application/json"));
    assert_eq!(header(&call, "x-plex-token"), None);
}

#[tokio::test]
async fn check_pin_throws_on_a_non_ok_status() {
    let f = fake().await;
    f.text("/pins/5", "boom", 500);
    let r = f.plex().check_pin(&f.config(&[]), 5).await;
    assert_eq!(message(r), "plex.checkPin failed: 500");
}

#[tokio::test]
async fn check_pin_throws_a_typed_429_with_a_safe_retry_after() {
    let f = fake().await;
    let cases: &[(&str, Option<&str>, &str, u64)] = &[
        ("numeric", Some("17"), "17", 17),
        (
            "HTTP-date",
            Some("Sat, 18 Jul 2026 23:59:59 GMT"),
            "Sat, 18 Jul 2026 23:59:59 GMT",
            // In the past by the time this runs: no wait.
            0,
        ),
        ("malformed", Some("eventually"), "5", 5),
        ("non-HTTP date", Some("January 1 2027"), "5", 5),
        ("signed delay", Some("-1"), "5", 5),
        ("decimal delay", Some("1.5"), "5", 5),
        ("absent", None, "5", 5),
        // Beyond plex.test.ts: the other two date forms, the log clamp.
        (
            "RFC 850",
            Some("Sunday, 06-Nov-94 08:49:37 GMT"),
            "Sunday, 06-Nov-94 08:49:37 GMT",
            0,
        ),
        (
            "asctime",
            Some("Sun Nov  6 08:49:37 1994"),
            "Sun Nov  6 08:49:37 1994",
            0,
        ),
        (
            "far future",
            Some("Fri, 01 Jan 2100 00:00:00 GMT"),
            "Fri, 01 Jan 2100 00:00:00 GMT",
            30,
        ),
        (
            "huge",
            Some("99999999999999999999"),
            "99999999999999999999",
            30,
        ),
    ];
    for (label, upstream, expected, seconds) in cases {
        let headers: Vec<(&str, &str)> = upstream.map(|v| ("retry-after", v)).into_iter().collect();
        f.stub("/pins/987654321", 429, "UPSTREAM-BODY-SECRET", &headers);
        match f.plex().check_pin(&f.config(&[]), 987654321).await {
            Err(PlexError::RateLimited {
                retry_after,
                retry_after_seconds,
            }) => {
                assert_eq!(retry_after, *expected, "{label}");
                assert_eq!(retry_after_seconds, *seconds, "{label}");
            }
            other => panic!("{label}: {other:?}"),
        }
    }
}

#[tokio::test]
async fn check_pin_never_logs_pin_client_response_body_or_token_artifacts() {
    let f = fake().await;
    let config = f.config(&[("PLEX_CLIENT_ID", "CLIENT-ID-SECRET")]);
    capture_logs();

    f.text("/pins/987654321", "UPSTREAM-BODY-SECRET", 500);
    assert!(f.plex().check_pin(&config, 987654321).await.is_err());
    f.json(
        "/pins/123456789",
        json!({ "id": 123456789, "code": "PIN-CODE-SECRET", "authToken": "PLEX-TOKEN-SECRET" }),
    );
    f.plex().check_pin(&config, 123456789).await.unwrap();
    // And an unreachable plex.tv (reqwest's error text carries the URL).
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", l.local_addr().unwrap())
    };
    assert!(
        Plex::at(&closed)
            .check_pin(&config, 987654321)
            .await
            .is_err()
    );

    let logs = logs();
    assert!(logs.contains("status=500"), "{logs}");
    assert!(logs.contains("token_present=true"), "{logs}");
    for secret in [
        "987654321",
        "123456789",
        "CLIENT-ID-SECRET",
        "UPSTREAM-BODY-SECRET",
        "PIN-CODE-SECRET",
        "PLEX-TOKEN-SECRET",
    ] {
        assert!(!logs.contains(secret), "{secret} logged: {logs}");
    }
}

// ── getUser ──

#[tokio::test]
async fn get_user_returns_the_user_json_and_sends_x_plex_token() {
    let f = fake().await;
    f.json(
        "/user",
        json!({ "id": 1, "uuid": "u", "username": "me", "email": "me@x.com", "thumb": null }),
    );
    let got = f.plex().get_user(&f.config(&[]), TOKEN).await.unwrap();
    assert_eq!(
        got,
        PlexUser {
            id: 1,
            uuid: "u".into(),
            username: "me".into(),
            email: Some("me@x.com".into()),
            thumb: None,
        }
    );
    let call = f.call(0);
    assert_eq!(call.url, "/api/v2/user");
    assert_eq!(header(&call, "x-plex-token"), Some(TOKEN));
}

#[tokio::test]
async fn get_user_throws_on_401() {
    let f = fake().await;
    f.text("/user", "denied", 401);
    let r = f.plex().get_user(&f.config(&[]), TOKEN).await;
    assert_eq!(message(r), "plex.getUser failed: 401");
}

// ── listResources (now probe_resources) ──

fn resource(owned: bool) -> (Value, PlexResource) {
    (
        json!([{ "name": "home", "clientIdentifier": "cid", "owned": owned, "home": false, "provides": "server" }]),
        PlexResource {
            name: "home".into(),
            client_identifier: "cid".into(),
            owned,
            home: false,
            provides: "server".into(),
        },
    )
}

#[tokio::test]
async fn list_resources_returns_the_resource_array_and_hits_resources_include_https() {
    let f = fake().await;
    let (body, want) = resource(true);
    f.json("/resources?includeHttps=1", body);
    let probe = f.plex().probe_resources(&f.config(&[]), TOKEN).await;
    assert_eq!(probe, Probe::Ok(vec![want]));
    let call = f.call(0);
    assert_eq!(call.url, "/api/v2/resources?includeHttps=1");
    assert_eq!(header(&call, "x-plex-token"), Some(TOKEN));
}

#[tokio::test]
async fn list_resources_reports_503() {
    let f = fake().await;
    f.text("/resources?includeHttps=1", "down", 503);
    let probe = f.plex().probe_resources(&f.config(&[]), TOKEN).await;
    assert_eq!(probe, Probe::HttpError(503));
}

// ── probeResources ──

#[tokio::test]
async fn probe_resources_returns_ok_on_200() {
    let f = fake().await;
    let (body, want) = resource(false);
    f.json("/resources?includeHttps=1", body);
    let probe = f.plex().probe_resources(&f.config(&[]), TOKEN).await;
    assert_eq!(probe, Probe::Ok(vec![want]));
}

#[tokio::test]
async fn probe_resources_returns_http_error_with_the_status_on_a_non_ok_response() {
    let f = fake().await;
    f.text("/resources?includeHttps=1", "forbidden", 403);
    let probe = f.plex().probe_resources(&f.config(&[]), TOKEN).await;
    assert_eq!(probe, Probe::HttpError(403));
}

#[tokio::test]
async fn probe_resources_returns_network_error_when_the_request_fails() {
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", l.local_addr().unwrap())
    };
    let f = fake().await;
    let probe = Plex::at(&closed)
        .probe_resources(&f.config(&[]), TOKEN)
        .await;
    assert_eq!(probe, Probe::NetworkError);
    // So does a body that is not JSON (TS: res.json() threw inside the try).
    f.text("/resources?includeHttps=1", "<html>", 200);
    let probe = f.plex().probe_resources(&f.config(&[]), TOKEN).await;
    assert_eq!(probe, Probe::NetworkError);
}

// ── signOut ──

#[tokio::test]
async fn sign_out_resolves_and_posts_to_signout_with_x_plex_token() {
    let f = fake().await;
    f.text("/signout", "", 200);
    f.plex().sign_out(&f.config(&[]), TOKEN).await.unwrap();
    let call = f.call(0);
    assert_eq!(call.url, "/api/v2/signout");
    assert_eq!(call.method, Method::POST);
    assert_eq!(header(&call, "x-plex-token"), Some(TOKEN));
}

#[tokio::test]
async fn sign_out_throws_on_500() {
    let f = fake().await;
    f.text("/signout", "err", 500);
    let r = f.plex().sign_out(&f.config(&[]), TOKEN).await;
    assert_eq!(message(r), "plex.signOut failed: 500");
}

// ── listAcceptedUsers ──

#[tokio::test]
async fn list_accepted_users_parses_users_skips_non_numeric_ids_and_unescapes() {
    let f = fake().await;
    f.xml(
        "/api/users",
        r#"<MediaContainer>
        <User id="10" username="al &amp; ice" email="alice@x.com" thumb="t1" />
        <User id="11" username="bob" email="bob@x.com" thumb="t2" />
        <User id="abc" username="ghost" email="ghost@x.com" />
      </MediaContainer>"#,
    );
    let users = f
        .plex()
        .list_accepted_users(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert_eq!(users.len(), 2);
    assert_eq!(
        users[0],
        PlexFriend {
            id: 10,
            username: "al & ice".into(),
            title: Some("al & ice".into()),
            email: Some("alice@x.com".into()),
            thumb: Some("t1".into()),
            status: FriendStatus::Accepted,
        }
    );
    assert_eq!((users[1].id, users[1].username.as_str()), (11, "bob"));
    assert_eq!(users[1].email.as_deref(), Some("bob@x.com"));
    assert!(!users.iter().any(|u| u.username == "ghost"));
    let call = f.call(0);
    assert_eq!(call.url, "/api/users");
    assert_eq!(header(&call, "accept"), Some("application/xml"));
    assert_eq!(header(&call, "x-plex-token"), Some(TOKEN));
    assert_eq!(
        header(&call, "x-plex-client-identifier"),
        Some("test-client")
    );
}

#[tokio::test]
async fn list_accepted_users_throws_on_a_non_ok_status() {
    let f = fake().await;
    f.text("/api/users", "err", 500);
    let r = f.plex().list_accepted_users(&f.config(&[]), TOKEN).await;
    assert_eq!(message(r), "plex.listAcceptedUsers failed: 500");
}

// ── listPendingInvites ──

#[tokio::test]
async fn list_pending_invites_normalizes_a_raw_array() {
    let f = fake().await;
    f.json(
        "/friends/requested",
        json!([
            { "id": 50, "username": "carol", "email": "carol@x.com" },
            // Email-only: username/title fall back, the id is synthesized.
            { "email": "dave@x.com" },
            // Nothing to show: dropped.
            { "thumb": "orphan" },
        ]),
    );
    let invites = f
        .plex()
        .list_pending_invites(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert_eq!(invites.len(), 2);
    let carol = invites.iter().find(|u| u.username == "carol").unwrap();
    assert_eq!(carol.id, 50);
    assert_eq!(carol.status, FriendStatus::Pending);
    assert_eq!(carol.email.as_deref(), Some("carol@x.com"));
    let dave = invites
        .iter()
        .find(|u| u.email.as_deref() == Some("dave@x.com"))
        .unwrap();
    assert_eq!(dave.username, "dave@x.com");
    assert_eq!(dave.title.as_deref(), Some("dave@x.com"));
    // plex.ts's stableHash('dave@x.com'), computed by Node.
    assert_eq!(dave.id, -1_872_022_476_062_264);
    assert_eq!(f.call(0).url, "/api/v2/friends/requested");
}

#[tokio::test]
async fn list_pending_invites_parses_the_wrapped_friends_form() {
    let f = fake().await;
    f.json(
        "/friends/requested",
        json!({ "friends": [{ "id": 60, "username": "erin", "email": "erin@x.com" }] }),
    );
    let invites = f
        .plex()
        .list_pending_invites(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert_eq!(invites.len(), 1);
    assert_eq!((invites[0].id, invites[0].username.as_str()), (60, "erin"));
    assert_eq!(invites[0].status, FriendStatus::Pending);
}

#[tokio::test]
async fn list_pending_invites_returns_empty_on_404() {
    let f = fake().await;
    f.text("/friends/requested", "", 404);
    let invites = f
        .plex()
        .list_pending_invites(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert!(invites.is_empty());
}

#[tokio::test]
async fn list_pending_invites_throws_on_other_non_ok_statuses() {
    let f = fake().await;
    f.text("/friends/requested", "err", 500);
    let r = f.plex().list_pending_invites(&f.config(&[]), TOKEN).await;
    assert_eq!(message(r), "plex.listPendingInvites failed: 500");
}

// ── listSharedServerInvitees ──

#[tokio::test]
async fn list_shared_server_invitees_is_empty_without_a_server_id_and_calls_nothing() {
    let f = fake().await;
    let invitees = f
        .plex()
        .list_shared_server_invitees(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert!(invitees.is_empty());
    assert_eq!(f.call_count(), 0);
}

#[tokio::test]
async fn list_shared_server_invitees_maps_accepted_and_pending_by_user_id() {
    let f = fake().await;
    f.xml(
        "shared_servers",
        r#"<MediaContainer>
        <SharedServer userID="42" username="alice" email="a@x.com" accepted="1" />
        <SharedServer userID="43" username="bob" email="b@x.com" accepted="0" />
        <SharedServer username="ghost" email="ghost@x.com" />
      </MediaContainer>"#,
    );
    let config = f.config(&[("PLEX_SERVER_ID", "home-server-machine-id")]);
    let invitees = f
        .plex()
        .list_shared_server_invitees(&config, TOKEN)
        .await
        .unwrap();
    assert_eq!(invitees.len(), 2);
    assert_eq!(
        (
            invitees[0].id,
            invitees[0].username.as_str(),
            invitees[0].status
        ),
        (42, "alice", FriendStatus::Accepted)
    );
    assert_eq!(
        (
            invitees[1].id,
            invitees[1].username.as_str(),
            invitees[1].status
        ),
        (43, "bob", FriendStatus::Pending)
    );
    assert!(!invitees.iter().any(|u| u.username == "ghost"));
    assert_eq!(
        f.call(0).url,
        "/api/servers/home-server-machine-id/shared_servers"
    );
}

#[tokio::test]
async fn list_shared_server_invitees_returns_empty_on_404() {
    let f = fake().await;
    f.text("shared_servers", "", 404);
    let config = f.config(&[("PLEX_SERVER_ID", "home-server-machine-id")]);
    let invitees = f
        .plex()
        .list_shared_server_invitees(&config, TOKEN)
        .await
        .unwrap();
    assert!(invitees.is_empty());
}

// ── listLocalServerAccounts ──

#[tokio::test]
async fn list_local_server_accounts_skips_id_0_and_empty_names() {
    let f = fake().await;
    f.xml(
        "/accounts",
        r#"<MediaContainer>
        <Account id="0" name="Local" />
        <Account id="7" name="bob" thumb="t" />
        <Account id="9" name="" />
      </MediaContainer>"#,
    );
    let accounts = f
        .plex()
        .list_local_server_accounts(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(
        accounts[0],
        PlexFriend {
            id: 7,
            username: "bob".into(),
            title: Some("bob".into()),
            email: None,
            thumb: Some("t".into()),
            status: FriendStatus::Accepted,
        }
    );
    let call = f.call(0);
    assert_eq!(call.url, "/accounts");
    // The PMS gets the token alone, no plex.tv client identity.
    assert_eq!(header(&call, "x-plex-token"), Some(TOKEN));
    assert_eq!(header(&call, "x-plex-client-identifier"), None);
}

#[tokio::test]
async fn list_local_server_accounts_returns_empty_on_404() {
    let f = fake().await;
    f.text("/accounts", "", 404);
    let accounts = f
        .plex()
        .list_local_server_accounts(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert!(accounts.is_empty());
}

// ── listHomeUsers ──

#[tokio::test]
async fn list_home_users_parses_users_as_accepted_and_hits_api_home_users() {
    let f = fake().await;
    f.xml(
        "/api/home/users",
        r#"<MediaContainer>
        <User id="20" username="kid1" email="" />
        <User id="21" username="kid2" email="" />
      </MediaContainer>"#,
    );
    let users = f
        .plex()
        .list_home_users(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert_eq!(users.len(), 2);
    assert!(users.iter().all(|u| u.status == FriendStatus::Accepted));
    assert!(users.iter().all(|u| u.email.is_none()));
    assert_eq!(f.call(0).url, "/api/home/users");
}

#[tokio::test]
async fn list_home_users_returns_empty_on_404() {
    let f = fake().await;
    f.text("/api/home/users", "", 404);
    let users = f
        .plex()
        .list_home_users(&f.config(&[]), TOKEN)
        .await
        .unwrap();
    assert!(users.is_empty());
}

// ── Not configured (requirePlexClientId) ──

#[tokio::test]
async fn plex_tv_calls_need_a_client_id_and_the_pms_does_not() {
    let f = fake().await;
    let config = config(&[("PLEX_SERVER_URL", f.url.as_str())]);
    let plex = f.plex();
    assert!(matches!(
        plex.check_pin(&config, 5).await,
        Err(PlexError::NotConfigured)
    ));
    assert!(matches!(
        plex.list_home_users(&config, TOKEN).await,
        Err(PlexError::NotConfigured)
    ));
    assert_eq!(
        plex.probe_resources(&config, TOKEN).await,
        Probe::NetworkError
    );
    assert_eq!(f.call_count(), 0);
    f.text("/accounts", "", 404);
    assert!(
        plex.list_local_server_accounts(&config, TOKEN)
            .await
            .is_ok()
    );
}

#[test]
fn friends_serialize_like_the_ts_objects() {
    let friend = PlexFriend {
        id: -3,
        username: "a".into(),
        title: None,
        email: None,
        thumb: None,
        status: FriendStatus::Pending,
    };
    assert_eq!(
        serde_json::to_value(&friend).unwrap(),
        json!({ "id": -3, "username": "a", "email": null, "thumb": null, "status": "pending" })
    );
}
