//! device.route.test.ts. The TS suite mocked plex.ts, the authZ gate, the
//! limiter and the mint; here plex.tv is a local fake, authZ and the limiter
//! run for real on a server.db, and the minted token is verified back.
//! device.test.ts's mint/verify cases live in device_tokens/tests.rs.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::invites::IssueOptions;
use crate::plex::tests::{Fake, fake};
use crate::testutil::*;
use crate::{AuthState, Role};

const POLL: &str = "/api/auth/device/poll";
const JSON: (&str, &str) = ("content-type", "application/json");

struct H {
    db: TestDb,
    st: AuthState,
    f: Fake,
}

impl H {
    async fn post(&self, headers: &[(&str, &str)], body: &Value) -> Reply {
        let mut h = vec![JSON];
        h.extend_from_slice(headers);
        let app = crate::router(self.st.clone());
        call(&app, "POST", POLL, &h, Some(&body.to_string())).await
    }

    /// The PIN (authorized with `token`, or pending) and plex.tv user 12345.
    fn stub(&self, token: Option<&str>) {
        self.f.reset();
        self.f.json(
            "/api/v2/pins/",
            json!({ "id": 7, "code": "abc", "authToken": token }),
        );
        self.f.json(
            "/api/v2/user",
            json!({ "id": 12345, "uuid": "u", "username": "chris", "email": "c@example.com", "thumb": null }),
        );
        // A share on the home server, which must NOT admit a device.
        self.f.json(
            "/api/v2/resources",
            json!([{ "name": "Home", "clientIdentifier": "home", "owned": false, "provides": "server" }]),
        );
    }

    async fn tokens(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM device_tokens")
            .fetch_one(&*self.db)
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

fn valid() -> Value {
    json!({ "pinId": 7, "device_id": "dev-1", "device_name": "Living Room", "device_platform": "tvos" })
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

// ── validation ──

#[tokio::test]
async fn answers_400_for_each_missing_or_bad_field_without_calling_plex() {
    let h = h(&[]).await;
    h.stub(None);
    let cases = [
        (
            json!({ "device_id": "d", "device_name": "n", "device_platform": "p" }),
            "missing_pinId",
        ),
        (
            json!({ "pinId": "", "device_id": "d", "device_name": "n", "device_platform": "p" }),
            "missing_pinId",
        ),
        (
            json!({ "pinId": "abc", "device_id": "d", "device_name": "n", "device_platform": "p" }),
            "bad_pinId",
        ),
        (
            json!({ "pinId": 1.5, "device_id": "d", "device_name": "n", "device_platform": "p" }),
            "bad_pinId",
        ),
        (
            json!({ "pinId": 7, "device_name": "n", "device_platform": "p" }),
            "missing_device_id",
        ),
        (
            json!({ "pinId": 7, "device_id": "  ", "device_name": "n", "device_platform": "p" }),
            "missing_device_id",
        ),
        (
            json!({ "pinId": 7, "device_id": "d", "device_platform": "p" }),
            "missing_device_name",
        ),
        (
            json!({ "pinId": 7, "device_id": "d", "device_name": "n" }),
            "missing_device_platform",
        ),
        (
            json!({ "pinId": 7, "device_id": "d", "device_name": "n", "device_platform": 3 }),
            "missing_device_platform",
        ),
    ];
    for (body, error) in cases {
        let r = h.post(&[], &body).await;
        assert_eq!(r.status, 400, "{body}");
        assert_eq!(r.json(), json!({ "error": error }), "{body}");
    }
    assert_eq!(h.f.call_count(), 0);
}

#[tokio::test]
async fn answers_413_for_a_body_over_2_kb() {
    let h = h(&[]).await;
    let r = h
        .post(&[], &json!({ "pinId": 1, "x": "a".repeat(3000) }))
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (413, r#"{"error":"body_too_large"}"#)
    );
    assert_eq!(h.f.call_count(), 0);
}

// ── pin lifecycle ──

#[tokio::test]
async fn keeps_the_local_limiter_distinct_from_plex_backpressure() {
    let h = h(&[]).await;
    h.stub(None);
    for i in 0..60 {
        assert_eq!(h.post(&[], &valid()).await.status, 200, "request {i}");
    }
    let r = h.post(&[], &valid()).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (429, r#"{"error":"rate_limited"}"#)
    );
    assert!(
        r.headers["retry-after"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    // The refused poll never reached plex.tv.
    assert_eq!(h.f.call_count(), 60);
}

#[tokio::test]
async fn the_pin_bucket_runs_before_the_device_field_checks() {
    let h = h(&[]).await;
    h.stub(None);
    let no_device = json!({ "pinId": 7 });
    for _ in 0..60 {
        assert_eq!(h.post(&[], &no_device).await.status, 400);
    }
    assert_eq!(h.post(&[], &valid()).await.status, 429);
    assert_eq!(h.f.call_count(), 0);
}

#[tokio::test]
async fn answers_pending_while_the_pin_has_no_token() {
    let h = h(&[]).await;
    for token in [None, Some("")] {
        h.stub(token);
        let r = h.post(&[], &valid()).await;
        assert_eq!(
            (r.status, r.text.as_str()),
            (200, r#"{"status":"pending"}"#)
        );
        assert_eq!(h.f.calls(), ["GET /api/v2/pins/7"]);
    }
}

#[tokio::test]
async fn returns_plex_backpressure_as_a_provider_429_without_minting() {
    let h = h(&[]).await;
    capture_logs();
    let date = "Sat, 18 Jul 2026 23:59:59 GMT";
    h.f.stub("/api/v2/pins/", 429, "", &[("retry-after", date)]);
    let r = h
        .post(&[("x-request-id", "plex-device-backpressure")], &valid())
        .await;
    assert_eq!(r.status, 429);
    assert_eq!(r.headers["retry-after"], date);
    assert_eq!(r.text, r#"{"error":"plex_rate_limited"}"#);
    assert_eq!(h.f.calls(), ["GET /api/v2/pins/7"]);
    assert_eq!(h.tokens().await, 0);
    let lines = outcome_lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
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
            "requestId=\"plex-device-backpressure\"",
        ],
    );
}

#[tokio::test]
async fn denies_an_uninvited_plex_user_and_mints_no_token() {
    // PLEX_SERVER_ID matches the stubbed share: the device path still denies.
    let h = h(&[("PLEX_SERVER_ID", "home")]).await;
    h.stub(Some("tok"));
    let r = h.post(&[], &valid()).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (403, r#"{"status":"denied","reason":"no_invite"}"#)
    );
    assert_eq!(h.tokens().await, 0);
    assert!(!h.f.calls().iter().any(|c| c.contains("resources")));
    let members: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM members")
        .fetch_one(&*h.db)
        .await
        .unwrap();
    assert_eq!(members, 0);
}

#[tokio::test]
async fn denies_a_revoked_member() {
    let h = h(&[]).await;
    add_member(&h.db, "plex:12345", "user", "plex").await;
    set_revoked(&h.db, "plex:12345").await;
    h.stub(Some("tok"));
    assert_eq!(h.post(&[], &valid()).await.status, 403);
    assert_eq!(h.tokens().await, 0);
}

#[tokio::test]
async fn authorizes_through_an_invite_and_mints_a_plex_device_token() {
    let h = h(&[]).await;
    capture_logs();
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
    h.stub(Some("tok"));
    let mut body = valid();
    body["device_name"] = " Living Room ".into();
    body["invite_code"] = code.as_str().into();
    let r = h
        .post(&[("x-request-id", "plex-device-authorized")], &body)
        .await;
    assert_eq!(r.status, 200, "{}", r.text);
    let server_id = crate::ensure_server_id(&h.db).await.unwrap();
    let j = r.json();
    let token = j["token"].as_str().unwrap();
    assert_eq!(
        r.text,
        format!(
            r#"{{"status":"authorized","token":"{token}","server_id":"{server_id}","user":{{"sub":"plex:12345","username":"chris","role":"user"}}}}"#
        )
    );
    assert_eq!(h.f.calls(), ["GET /api/v2/pins/7", "GET /api/v2/user"]);

    let keys = h.st.device_keys.as_deref().unwrap();
    let c = crate::device_tokens::verify(&h.db, keys, token, unix_now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (c.sub.as_str(), c.auth_mode.as_str(), c.role.as_str()),
        ("plex:12345", "plex", "user")
    );
    assert_eq!(
        (c.device_id.as_str(), c.device_platform.as_str()),
        ("dev-1", "tvos")
    );
    assert_eq!(c.server_id, server_id);
    let row: (String, Option<String>) =
        sqlx::query_as("SELECT device_name, username FROM device_tokens WHERE jti = ?")
            .bind(&c.jti)
            .fetch_one(&*h.db)
            .await
            .unwrap();
    assert_eq!(row, ("Living Room".into(), Some("chris".into())));
    let member: (String, String) =
        sqlx::query_as("SELECT role, auth_mode FROM members WHERE sub = 'plex:12345'")
            .fetch_one(&*h.db)
            .await
            .unwrap();
    assert_eq!(member, ("user".into(), "plex".into()));

    let lines = outcome_lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_fields(
        &lines[0],
        &[
            "provider=\"plex\"",
            "phase=\"check\"",
            "outcome=\"authorized\"",
            "reason=\"device_pair\"",
            "requestId=\"plex-device-authorized\"",
        ],
    );
    for secret in ["dev-1", "Living Room", code.as_str(), token, "plex:12345"] {
        assert!(!lines[0].contains(secret), "{secret} logged");
    }
}

#[tokio::test]
async fn reads_the_invite_from_invite_code_or_invite_code_camel() {
    let h = h(&[]).await;
    let issue = || async {
        crate::invites::issue(
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
        .code
    };
    h.stub(Some("tok"));
    let mut body = valid();
    body["inviteCode"] = issue().await.into();
    assert_eq!(h.post(&[], &body).await.status, 200);

    // invite_code wins when both are strings, as in TS.
    sqlx::query("DELETE FROM members")
        .execute(&*h.db)
        .await
        .unwrap();
    let mut body = valid();
    body["invite_code"] = "not-a-code".into();
    body["inviteCode"] = issue().await.into();
    assert_eq!(h.post(&[], &body).await.status, 403);
}

#[tokio::test]
async fn an_admin_sub_pairs_as_admin_and_a_member_without_an_invite() {
    let h = h(&[("ADMIN_SUBS", "plex:12345")]).await;
    h.stub(Some("tok"));
    let r = h.post(&[], &valid()).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(r.json()["user"]["role"], "admin");

    let h = self::h(&[]).await;
    add_member(&h.db, "plex:12345", "user", "plex").await;
    h.stub(Some("tok"));
    let r = h.post(&[], &valid()).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(r.json()["user"]["role"], "user");
}

#[tokio::test]
async fn answers_503_without_a_plex_client_id() {
    let db = pool().await;
    let app = crate::router(AuthState::new((*db).clone(), config(&[])));
    let r = call(&app, "POST", POLL, &[JSON], Some(&valid().to_string())).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (503, r#"{"error":"plex_not_configured"}"#)
    );
}
