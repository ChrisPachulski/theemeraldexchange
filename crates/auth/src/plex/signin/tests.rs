//! auth.test.ts's /plex/config, /plex/check and Plex /me + /logout cases and
//! the Plex row of "structured browser login outcomes". The TS suite stubbed
//! fetch and mocked the allowlist; here plex.tv is a local fake and authZ runs
//! on a real server.db. Not carried over: the ADMINS username cases (ADMINS is
//! retired; the admin case uses ADMIN_SUBS) and the ownership-seal cases
//! (setupState is not ported).

use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
use crate::invites::IssueOptions;
use crate::plex::tests::{Fake, fake};
use crate::testutil::*;

const CHECK: &str = "/api/auth/plex/check";
const JSON: (&str, &str) = ("content-type", "application/json");
const SUB: &str = "plex:999";
const SERVER: &str = "home-server-id";

struct H {
    db: TestDb,
    st: AuthState,
    f: Fake,
}

impl H {
    fn app(&self) -> axum::Router {
        crate::router(self.st.clone())
    }

    async fn post(&self, headers: &[(&str, &str)], body: Option<&str>) -> Reply {
        let mut h = vec![JSON];
        h.extend_from_slice(headers);
        call(&self.app(), "POST", CHECK, &h, body).await
    }

    async fn pin(&self, pin: i64) -> Reply {
        self.post(&[], Some(&json!({ "pinId": pin }).to_string()))
            .await
    }

    /// stubPlex: the PIN (with `token` or pending), user 999, resources.
    fn stub(&self, token: Option<&str>, username: &str, resources: Value, resources_status: u16) {
        self.f.reset();
        self.f.json(
            "/api/v2/pins/",
            json!({ "id": 12345, "code": "abc", "authToken": token }),
        );
        self.f.json(
            "/api/v2/user",
            json!({
                "id": 999, "uuid": "uuid-999", "username": username,
                "email": format!("{username}@example.com"), "thumb": null,
            }),
        );
        self.f.stub(
            "/api/v2/resources",
            resources_status,
            &resources.to_string(),
            &[JSON],
        );
        self.f.text("/api/v2/signout", "", 204);
    }

    fn signed_in(&self, username: &str) {
        self.stub(Some("real-token"), username, json!([]), 200);
    }

    fn shared(&self, username: &str, server: &str) {
        self.stub(
            Some("real-token"),
            username,
            json!([{ "name": "Home", "clientIdentifier": server, "owned": false, "provides": "server" }]),
            200,
        );
    }

    async fn member_row(
        &self,
        sub: &str,
    ) -> Option<(Option<String>, String, String, Option<String>, bool)> {
        sqlx::query_as(
            "SELECT display_name, role, auth_mode, invited_by, revoked_at IS NOT NULL \
             FROM members WHERE sub = ?",
        )
        .bind(sub)
        .fetch_optional(&*self.db)
        .await
        .unwrap()
    }
}

async fn h(extra: &[(&str, &str)]) -> H {
    let f = fake().await;
    let db = pool().await;
    let mut st = AuthState::new((*db).clone(), f.config(extra));
    st.plex = Arc::new(f.plex());
    H { db, st, f }
}

/// The share-admission harness: PLEX_SERVER_ID set.
async fn scoped() -> H {
    h(&[("PLEX_SERVER_ID", SERVER)]).await
}

fn outcome_lines() -> Vec<String> {
    logs()
        .lines()
        .filter(|l| l.contains("event=\"auth_outcome\""))
        .map(String::from)
        .collect()
}

fn assert_fields(line: &str, fields: &[&str]) {
    for f in fields {
        assert!(line.contains(f), "{f} missing: {line}");
    }
}

fn retry_after(r: &Reply) -> u64 {
    r.headers["retry-after"].to_str().unwrap().parse().unwrap()
}

// ── GET /api/auth/plex/config ──

#[tokio::test]
async fn config_returns_the_public_client_id_and_product() {
    let h = h(&[]).await;
    let r = call(&h.app(), "GET", "/api/auth/plex/config", &[], None).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.text,
        r#"{"clientId":"test-client","product":"The Emerald Exchange"}"#
    );
    // No PIN is created server-side.
    assert_eq!(h.f.call_count(), 0);
}

#[tokio::test]
async fn config_and_check_answer_503_without_a_client_id() {
    let db = pool().await;
    let st = AuthState::new((*db).clone(), config(&[]));
    let app = crate::router(st);
    let r = call(&app, "GET", "/api/auth/plex/config", &[], None).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (503, r#"{"error":"plex_not_configured"}"#)
    );
    let r = call(&app, "POST", CHECK, &[JSON], Some(r#"{"pinId":1}"#)).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (503, r#"{"error":"plex_not_configured"}"#)
    );
}

// ── POST /api/auth/plex/check ──

#[tokio::test]
async fn returns_pending_while_plex_has_no_token_yet() {
    capture_logs();
    let h = h(&[]).await;
    h.stub(None, "test-user", json!([]), 200);
    let r = h.pin(12345).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (200, r#"{"status":"pending"}"#)
    );
    assert_eq!(h.f.calls(), ["GET /api/v2/pins/12345"]);
    assert!(outcome_lines().is_empty());
}

#[tokio::test]
async fn returns_a_provider_429_for_plex_backpressure() {
    let h = h(&[]).await;
    let cases: &[(&str, Option<&str>, &str)] = &[
        ("numeric", Some("17"), "17"),
        (
            "HTTP-date",
            Some("Sat, 18 Jul 2026 23:59:59 GMT"),
            "Sat, 18 Jul 2026 23:59:59 GMT",
        ),
        ("malformed", Some("eventually"), "5"),
        ("absent", None, "5"),
    ];
    for (label, upstream, expected) in cases {
        capture_logs();
        let headers: Vec<(&str, &str)> = upstream.map(|v| ("retry-after", v)).into_iter().collect();
        h.f.reset();
        h.f.stub("/api/v2/pins/", 429, "UPSTREAM-BODY-SECRET", &headers);
        let r = h
            .post(
                &[
                    ("x-request-id", "plex-upstream-rate-limit"),
                    ("authorization", "Bearer AUTHORIZATION-SECRET"),
                    ("cookie", "eex.session=COOKIE-SECRET"),
                ],
                Some(r#"{"pinId":987654321,"inviteCode":"INVITE-CODE-SECRET"}"#),
            )
            .await;
        assert_eq!(r.status, 429, "{label}");
        assert_eq!(r.headers["retry-after"], *expected, "{label}");
        assert_eq!(r.text, r#"{"error":"plex_rate_limited"}"#, "{label}");
        let lines = outcome_lines();
        assert_eq!(lines.len(), 1, "{label}: {lines:?}");
        assert!(lines[0].contains(" WARN "), "{}", lines[0]);
        assert_fields(
            &lines[0],
            &[
                "provider=\"plex\"",
                "phase=\"check\"",
                "outcome=\"rate_limited\"",
                "reason=\"provider_rate_limit\"",
                "scope=\"upstream\"",
                "retryAfterSeconds=",
                "requestId=\"plex-upstream-rate-limit\"",
            ],
        );
        let all = logs();
        for secret in [
            "987654321",
            "UPSTREAM-BODY-SECRET",
            "AUTHORIZATION-SECRET",
            "COOKIE-SECRET",
            "INVITE-CODE-SECRET",
        ] {
            assert!(!all.contains(secret), "{label}: {secret} logged");
        }
    }
}

#[tokio::test]
async fn allows_two_pin_flows_from_one_trusted_client_past_60_checks() {
    let h = h(&[("TRUST_CLIENT_IP_HEADERS", "1")]).await;
    h.stub(None, "test-user", json!([]), 200);
    for i in 0..62 {
        let xff = format!("203.0.113.{i}");
        let body = json!({ "pinId": 12345 + i % 2 }).to_string();
        let r = h
            .post(
                &[
                    ("cf-connecting-ip", "198.51.100.20"),
                    ("x-forwarded-for", &xff),
                ],
                Some(&body),
            )
            .await;
        assert_eq!(r.status, 200, "request {i}");
    }
}

#[tokio::test]
async fn limits_one_pin_to_60_checks_with_a_redacted_warning() {
    let h = h(&[]).await;
    h.stub(None, "test-user", json!([]), 200);
    for i in 0..60 {
        assert_eq!(h.pin(12345).await.status, 200, "request {i}");
    }
    capture_logs();
    let r = h
        .post(
            &[
                ("x-request-id", "plex-pin-rate-limit"),
                ("cf-connecting-ip", "198.51.100.20"),
                ("authorization", "Bearer SECRET-TOKEN"),
                ("cookie", "eex.session=SECRET-COOKIE"),
            ],
            Some(r#"{"pinId":12345,"inviteCode":"SECRET-INVITE","identity":"SECRET-IDENTITY"}"#),
        )
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (429, r#"{"error":"rate_limited"}"#)
    );
    let secs = retry_after(&r);
    assert!(secs > 0);
    let lines = outcome_lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    let line = &lines[0];
    assert!(
        line.contains(" WARN ") && line.contains("terminal"),
        "{line}"
    );
    assert_fields(
        line,
        &[
            "provider=\"plex\"",
            "phase=\"check\"",
            "outcome=\"rate_limited\"",
            "reason=\"local_rate_limit\"",
            "scope=\"pin\"",
            "requestId=\"plex-pin-rate-limit\"",
            &format!("retryAfterSeconds={secs}"),
        ],
    );
    let elapsed: u64 = line
        .split("elapsedMs=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(elapsed % 100, 0);
    for secret in [
        "198.51.100.20",
        "12345",
        "SECRET-INVITE",
        "SECRET-TOKEN",
        "SECRET-COOKIE",
        "SECRET-IDENTITY",
    ] {
        assert!(!line.contains(secret), "{secret}: {line}");
    }
    // The refused poll never reached plex.tv.
    assert_eq!(h.f.call_count(), 60);
}

#[tokio::test]
async fn keeps_the_60_check_pin_ceiling_while_other_pin_buckets_churn() {
    let h = h(&[]).await;
    h.stub(None, "test-user", json!([]), 200);
    for _ in 0..59 {
        assert_eq!(h.pin(12345).await.status, 200);
    }
    for i in 0..255 {
        assert_eq!(h.pin(30_000 + i).await.status, 200);
    }
    assert_eq!(h.pin(12345).await.status, 200);
    assert_eq!(h.pin(12345).await.status, 429);
}

#[tokio::test]
async fn caps_a_trusted_client_at_300_checks_while_it_rotates_pins() {
    let h = h(&[("TRUST_CLIENT_IP_HEADERS", "1")]).await;
    h.stub(None, "test-user", json!([]), 200);
    for i in 0..300 {
        let xff = format!("203.0.113.{}", i % 256);
        let body = json!({ "pinId": 20_000 + i }).to_string();
        let r = h
            .post(
                &[
                    ("cf-connecting-ip", "198.51.100.20"),
                    ("x-forwarded-for", &xff),
                ],
                Some(&body),
            )
            .await;
        assert_eq!(r.status, 200, "request {i}");
    }
    let r = h
        .post(
            &[
                ("cf-connecting-ip", "198.51.100.20"),
                ("x-forwarded-for", "203.0.113.250"),
            ],
            Some(r#"{"pinId":99999}"#),
        )
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (429, r#"{"error":"rate_limited"}"#)
    );
    assert!(retry_after(&r) > 0);
}

#[tokio::test]
async fn malformed_bodies_count_against_the_client_but_consume_no_pin_bucket() {
    let h = h(&[("TRUST_CLIENT_IP_HEADERS", "1")]).await;
    h.stub(None, "test-user", json!([]), 200);
    let ip20 = [("cf-connecting-ip", "198.51.100.20")];
    let ip21 = [("cf-connecting-ip", "198.51.100.21")];
    for i in 0..300 {
        assert_eq!(h.post(&ip20, Some("{")).await.status, 400, "request {i}");
    }
    let r = h.post(&ip20, Some("{")).await;
    assert_eq!(r.status, 429);
    assert!(retry_after(&r) > 0);
    for i in 0..60 {
        let r = h.post(&ip21, Some(r#"{"pinId":12345}"#)).await;
        assert_eq!(r.status, 200, "request {i}");
    }
    assert_eq!(h.post(&ip21, Some(r#"{"pinId":12345}"#)).await.status, 429);
}

#[tokio::test]
async fn answers_413_for_an_oversized_body() {
    let h = h(&[("TRUST_CLIENT_IP_HEADERS", "1")]).await;
    let body = json!({ "pinId": 12345, "padding": "x".repeat(1024) }).to_string();
    let r = h
        .post(&[("cf-connecting-ip", "198.51.100.20")], Some(&body))
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (413, r#"{"error":"body_too_large"}"#)
    );
    assert_eq!(h.f.call_count(), 0);
}

#[tokio::test]
async fn answers_400_for_a_missing_non_numeric_or_query_string_pin_id() {
    let h = h(&[]).await;
    let r = call(&h.app(), "POST", CHECK, &[], None).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (400, r#"{"error":"missing pinId"}"#)
    );
    let r = h.post(&[], Some(r#"{"pinId":"foo"}"#)).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (400, r#"{"error":"bad pinId"}"#)
    );
    let r = call(&h.app(), "POST", &format!("{CHECK}?pinId=12345"), &[], None).await;
    assert_eq!(r.status, 400);
    for body in [
        r#"{"pinId":""}"#,
        r#"{"pinId":null}"#,
        r#"{"pinId":[1]}"#,
        "[]",
    ] {
        assert_eq!(
            h.post(&[], Some(body)).await.text,
            r#"{"error":"missing pinId"}"#,
            "{body}"
        );
    }
    assert_eq!(
        h.post(&[], Some(r#"{"pinId":1.5}"#)).await.text,
        r#"{"error":"bad pinId"}"#
    );
    assert_eq!(h.f.call_count(), 0);
}

#[test]
fn pin_ids_read_the_way_js_number_reads_them() {
    let id = |v: Value| pin_id(&json!({ "pinId": v }));
    assert_eq!(id(json!(12345)), (true, Some(12345)));
    assert_eq!(id(json!(0)), (true, Some(0)));
    assert_eq!(id(json!(-5)), (true, Some(-5)));
    assert_eq!(id(json!(2.0)), (true, Some(2)));
    assert_eq!(id(json!(1.5)), (true, None));
    assert_eq!(id(json!("17")), (true, Some(17)));
    assert_eq!(id(json!(" 17\n")), (true, Some(17)));
    assert_eq!(id(json!("  ")), (true, Some(0)));
    assert_eq!(id(json!("1e3")), (true, Some(1000)));
    assert_eq!(id(json!("0x1A")), (true, Some(26)));
    assert_eq!(id(json!("0b101")), (true, Some(5)));
    assert_eq!(id(json!("0x+1A")), (true, None));
    assert_eq!(id(json!("12abc")), (true, None));
    assert_eq!(id(json!("inf")), (true, None));
    assert_eq!(id(json!("")), (false, None));
    assert_eq!(id(json!(true)), (false, None));
    assert_eq!(pin_id(&json!({})), (false, None));
}

#[tokio::test]
async fn an_admin_subs_plex_identity_signs_in_as_admin_with_its_plex_token() {
    let h = h(&[("ADMIN_SUBS", SUB)]).await;
    h.signed_in("admin-user");
    let r = h.pin(12345).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.text,
        r#"{"status":"authorized","user":{"sub":"plex:999","username":"admin-user","email":"admin-user@example.com","thumb":null,"role":"admin"}}"#
    );
    let set = r.headers["set-cookie"].to_str().unwrap();
    assert!(set.starts_with("eex.session="), "{set}");
    let token = set
        .split(';')
        .next()
        .unwrap()
        .trim_start_matches("eex.session=");
    let s = crate::session::verify(&h.st.session_key, token, unix_now()).unwrap();
    assert_eq!(
        (s.sub.as_str(), s.username.as_str(), s.role, s.auth_mode),
        (SUB, "admin-user", Role::Admin, AuthMode::Plex)
    );
    assert_eq!(s.plex_auth_token.as_deref(), Some("real-token"));
    assert_eq!(
        h.f.calls(),
        [
            "GET /api/v2/pins/12345",
            "GET /api/v2/user",
            "GET /api/v2/resources?includeHttps=1"
        ]
    );
}

#[tokio::test]
async fn a_member_row_signs_in_with_its_role() {
    let h = h(&[]).await;
    add_member(&h.db, SUB, "user", "plex").await;
    h.signed_in("random-guest");
    let r = h.pin(12345).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["status"], "authorized");
    assert_eq!(r.json()["user"]["role"], "user");
}

#[tokio::test]
async fn denies_a_plex_identity_without_a_membership_or_invite() {
    let h = h(&[]).await;
    h.signed_in("random-guest");
    let r = h.pin(12345).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (403, r#"{"status":"denied","reason":"no_invite"}"#)
    );
    assert!(r.headers.get("set-cookie").is_none());
    // No PLEX_SERVER_ID, so no share probe and no row.
    assert_eq!(h.f.calls(), ["GET /api/v2/pins/12345", "GET /api/v2/user"]);
    assert_eq!(h.member_row(SUB).await, None);
}

#[tokio::test]
async fn auto_admits_a_plex_identity_shared_on_the_owner_server() {
    let h = scoped().await;
    h.shared("shared-friend", SERVER);
    let r = h.pin(12345).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["status"], "authorized");
    // Sharing grants membership, never the admin role.
    assert_eq!(r.json()["user"]["role"], "user");
    assert_eq!(r.json().get("discoveredServers"), None);
    assert_eq!(
        h.member_row(SUB).await,
        Some((
            Some("shared-friend".into()),
            "user".into(),
            "plex".into(),
            Some("plex:server-share".into()),
            false
        ))
    );
}

#[tokio::test]
async fn does_not_auto_admit_an_identity_not_on_the_owner_server() {
    let h = scoped().await;
    h.shared("stranger", "other-server");
    let r = h.pin(12345).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (403, r#"{"status":"denied","reason":"no_invite"}"#)
    );
    assert_eq!(h.member_row(SUB).await, None);
}

#[tokio::test]
async fn a_share_probe_outage_is_transient_and_fails_closed() {
    capture_logs();
    let h = scoped().await;
    h.stub(Some("real-token"), "stranger", json!([]), 503);
    let r = h
        .post(
            &[("x-request-id", "plex-membership-outage")],
            Some(r#"{"pinId":12345}"#),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(h.member_row(SUB).await, None);
    let lines = outcome_lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_fields(
        &lines[0],
        &[
            "provider=\"plex\"",
            "phase=\"check\"",
            "outcome=\"transient\"",
            "reason=\"provider_unavailable\"",
            "requestId=\"plex-membership-outage\"",
        ],
    );
}

#[tokio::test]
async fn does_not_auto_admit_a_revoked_member_still_shared_on_the_server() {
    let h = scoped().await;
    add_member(&h.db, SUB, "user", "plex").await;
    set_revoked(&h.db, SUB).await;
    h.shared("kicked", SERVER);
    let r = h.pin(12345).await;
    assert_eq!(r.status, 403);
    assert!(h.member_row(SUB).await.unwrap().4);
    // An explicit revoke wins without asking plex.tv.
    assert!(!h.f.calls().iter().any(|c| c.contains("/resources")));
}

#[tokio::test]
async fn admits_an_existing_member_without_an_invite() {
    let h = scoped().await;
    add_member(&h.db, SUB, "user", "plex").await;
    h.signed_in("random-guest");
    let r = h
        .post(&[], Some(r#"{"pinId":12345,"inviteCode":"unused"}"#))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["status"], "authorized");
    // Member hit: no share probe, no discovery (PLEX_SERVER_ID is set).
    assert_eq!(h.f.calls(), ["GET /api/v2/pins/12345", "GET /api/v2/user"]);
}

#[tokio::test]
async fn admits_a_new_identity_that_redeems_a_valid_invite() {
    let h = h(&[]).await;
    let code = crate::invites::issue(
        &h.db,
        "workos:user_01E4ZCR3C56J083X43JQXF3JK5",
        IssueOptions {
            label: None,
            role: Role::User,
            expires_in_days: None,
            max_uses: 1,
        },
    )
    .await
    .unwrap()
    .code;
    h.signed_in("random-guest");
    let body = json!({ "pinId": 12345, "inviteCode": code }).to_string();
    let r = h.post(&[], Some(&body)).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["status"], "authorized");
    let row = h.member_row(SUB).await.unwrap();
    assert_eq!(
        (row.0.as_deref(), row.2.as_str(), row.3.as_deref()),
        (
            Some("random-guest"),
            "plex",
            Some("workos:user_01E4ZCR3C56J083X43JQXF3JK5")
        )
    );
}

#[tokio::test]
async fn denies_a_new_identity_with_an_invalid_invite() {
    let h = h(&[]).await;
    h.signed_in("random-guest");
    let r = h
        .post(&[], Some(r#"{"pinId":12345,"inviteCode":"WRONG"}"#))
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (403, r#"{"status":"denied","reason":"no_invite"}"#)
    );
}

#[tokio::test]
async fn lists_discovered_servers_when_plex_server_id_is_unset() {
    let h = h(&[]).await;
    add_member(&h.db, SUB, "user", "plex").await;
    h.stub(
        Some("real-token"),
        "admin-user",
        json!([
            { "name": "My NAS", "clientIdentifier": "nas-id", "owned": true, "provides": "server" },
            { "name": "Friend's", "clientIdentifier": "friend-id", "owned": false, "provides": "server" },
            { "name": "Some Player", "clientIdentifier": "player-id", "owned": false, "provides": "player" },
        ]),
        200,
    );
    let r = h.pin(12345).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.json()["discoveredServers"],
        json!([
            { "name": "My NAS", "id": "nas-id", "owned": true },
            { "name": "Friend's", "id": "friend-id", "owned": false },
        ])
    );
}

#[tokio::test]
async fn a_failing_plex_user_lookup_is_one_transient_server_error() {
    capture_logs();
    let h = h(&[]).await;
    h.signed_in("x");
    h.f.text("/api/v2/user", "nope", 401);
    let r = h.pin(12345).await;
    assert_eq!(r.status, 500);
    assert!(r.headers.get("set-cookie").is_none());
    let lines = outcome_lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_fields(
        &lines[0],
        &["outcome=\"transient\"", "reason=\"server_error\""],
    );
    assert!(!logs().contains("real-token"));
}

// ── structured browser login outcomes ──

#[tokio::test]
async fn records_one_redacted_plex_cookie_authorization() {
    capture_logs();
    let h = h(&[]).await;
    add_member(&h.db, SUB, "user", "plex").await;
    h.stub(
        Some("PLEX-TOKEN-SENTINEL"),
        "USERNAME-SENTINEL",
        json!([]),
        200,
    );
    let r = h
        .post(
            &[("x-request-id", "plex-cookie-outcome")],
            Some(r#"{"pinId":12345,"inviteCode":"INVITE-SENTINEL"}"#),
        )
        .await;
    assert_eq!(r.status, 200);
    let lines = outcome_lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].contains(" INFO "), "{}", lines[0]);
    assert_fields(
        &lines[0],
        &[
            "provider=\"plex\"",
            "phase=\"check\"",
            "outcome=\"authorized\"",
            "reason=\"cookie\"",
            "requestId=\"plex-cookie-outcome\"",
        ],
    );
    let all = logs();
    for secret in [
        "PLEX-TOKEN-SENTINEL",
        "USERNAME-SENTINEL",
        "12345",
        "INVITE-SENTINEL",
    ] {
        assert!(!all.contains(secret), "{secret} logged");
    }
}

// ── GET /api/me + POST /api/auth/logout ──

#[tokio::test]
async fn me_returns_the_user_after_a_pin_check() {
    let h = h(&[("ADMIN_SUBS", SUB)]).await;
    h.signed_in("admin-user");
    let r1 = h.pin(12345).await;
    let cookie = r1.headers["set-cookie"].to_str().unwrap();
    let cookie = cookie.split(';').next().unwrap();
    let r2 = call(&h.app(), "GET", "/api/me", &[("cookie", cookie)], None).await;
    assert_eq!(r2.status, 200);
    assert_eq!(
        r2.json(),
        json!({ "user": { "sub": SUB, "username": "admin-user", "role": "admin", "auth_mode": "plex" } })
    );
    // /api/me never shows the Plex token.
    assert!(!r2.text.contains("real-token"));
}

fn plex_cookie(st: &AuthState, token: Option<&str>) -> String {
    let s = Session {
        sub: SUB.into(),
        username: "P".into(),
        role: Role::User,
        auth_mode: AuthMode::Plex,
        plex_auth_token: token.map(String::from),
    };
    format!(
        "eex.session={}",
        crate::session::mint(&st.session_key, &s, unix_now())
    )
}

#[tokio::test]
async fn logout_signs_the_plex_token_out_then_clears_the_cookie() {
    let h = h(&[]).await;
    h.f.text("/api/v2/signout", "", 204);
    let cookie = plex_cookie(&h.st, Some("logout-token"));
    let r = call(
        &h.app(),
        "POST",
        "/api/auth/logout",
        &[("cookie", &cookie)],
        None,
    )
    .await;
    assert_eq!((r.status, r.text.as_str()), (200, r#"{"ok":true}"#));
    assert_eq!(r.headers["set-cookie"], "eex.session=; Max-Age=0; Path=/");
    assert_eq!(h.f.calls(), ["POST /api/v2/signout"]);
    let call0 = h.f.call(0);
    assert_eq!(call0.headers.get("x-plex-token").unwrap(), "logout-token");
}

#[tokio::test]
async fn logout_still_clears_the_cookie_when_plex_signout_fails() {
    capture_logs();
    let h = h(&[]).await;
    h.f.text("/api/v2/signout", "boom", 500);
    let cookie = plex_cookie(&h.st, Some("logout-token"));
    let r = call(
        &h.app(),
        "POST",
        "/api/auth/logout",
        &[("cookie", &cookie)],
        None,
    )
    .await;
    assert_eq!((r.status, r.text.as_str()), (200, r#"{"ok":true}"#));
    assert_eq!(r.headers["set-cookie"], "eex.session=; Max-Age=0; Path=/");
    let all = logs();
    assert!(
        all.contains("plex signout failed") && all.contains(" WARN "),
        "{all}"
    );
    assert!(!all.contains("logout-token"));
}

#[tokio::test]
async fn logout_without_a_plex_token_never_calls_plex() {
    let h = h(&[]).await;
    for cookie in [
        plex_cookie(&h.st, None),
        "eex.session=garbage".into(),
        String::new(),
    ] {
        let headers: Vec<(&str, &str)> = if cookie.is_empty() {
            vec![]
        } else {
            vec![("cookie", &cookie)]
        };
        let r = call(&h.app(), "POST", "/api/auth/logout", &headers, None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.headers["set-cookie"], "eex.session=; Max-Age=0; Path=/");
    }
    assert_eq!(h.f.call_count(), 0);
}
