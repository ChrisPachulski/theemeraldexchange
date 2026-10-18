//! adminInvites.test.ts carried over: the RequireAdmin gates on both halves,
//! POST /invites validation and defaults, revoke by prefix, the ADMIN_SUBS
//! synthesis in GET /members, and DELETE /members owner/self protection with
//! the device-token and iptv playlist-token cascades (against a local stub).
//! The two legacy-ADMINS cases became DB-admin cases (ADMINS is not ported).

use std::collections::HashMap;

use super::*;
use crate::testutil::*;

const OWNER: &str = "workos:user_01E4ZCR3C56J083X43JQXF3JK5"; // ADMIN_SUBS in config()
const USER: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";
const ADMIN: &str = "google:42";
const SECOND_ADMIN: &str = "google:8";

struct H {
    _db: TestDb,
    st: AuthState,
    app: Router,
    iptv: IptvStub,
}

async fn h(extra: &[(&str, &str)]) -> H {
    let iptv = iptv_stub().await;
    let db = pool().await;
    let mut env = vec![("IPTV_SERVICE_URL", iptv.url.as_str())];
    env.extend_from_slice(extra);
    let st = AuthState::new((*db).clone(), config(&env));
    let app = crate::router(st.clone());
    H {
        _db: db,
        st,
        app,
        iptv,
    }
}

impl H {
    fn owner(&self) -> String {
        cookie(&self.st, OWNER, "owner", Role::Admin)
    }

    async fn send(&self, method: &str, path: &str, cookie: &str, body: Option<&str>) -> Reply {
        let mut headers = vec![("content-type", "application/json")];
        if !cookie.is_empty() {
            headers.push(("cookie", cookie));
        }
        call(&self.app, method, path, &headers, body).await
    }

    async fn issue(&self, body: Value) -> Value {
        let r = self
            .send(
                "POST",
                "/api/admin/invites",
                &self.owner(),
                Some(&body.to_string()),
            )
            .await;
        assert_eq!(r.status, 201, "{}", r.text);
        r.json()
    }

    async fn invites(&self) -> Vec<Value> {
        let r = self
            .send("GET", "/api/admin/invites", &self.owner(), None)
            .await;
        assert_eq!(r.status, 200);
        r.json()["invites"].as_array().unwrap().clone()
    }

    async fn members(&self) -> Vec<Value> {
        let r = self
            .send("GET", "/api/admin/members", &self.owner(), None)
            .await;
        assert_eq!(r.status, 200);
        r.json()["members"].as_array().unwrap().clone()
    }

    async fn insert_device(&self, jti: &str, sub: &str) {
        sqlx::query(
            "INSERT INTO device_tokens (jti, sub, device_id, device_name, username, platform, server_id, issued_at, expires_at) \
             VALUES (?, ?, ?, 'Test device', NULL, 'ios', 'server', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')",
        )
        .bind(jti)
        .bind(sub)
        .bind(format!("device-{jti}"))
        .execute(&self.st.pool)
        .await
        .unwrap();
    }

    /// The member row and the device's revocation, for before/after checks.
    async fn revocation_state(
        &self,
        sub: &str,
        jti: &str,
    ) -> (Option<Option<String>>, Option<String>) {
        let member: Option<Option<String>> =
            sqlx::query_scalar("SELECT revoked_at FROM members WHERE sub = ?")
                .bind(sub)
                .fetch_optional(&self.st.pool)
                .await
                .unwrap();
        let reason: Option<String> =
            sqlx::query_scalar("SELECT reason FROM device_token_revocations WHERE jti = ?")
                .bind(jti)
                .fetch_optional(&self.st.pool)
                .await
                .unwrap();
        (member, reason)
    }
}

fn revoke_call(sub: &str) -> String {
    format!(
        "POST /internal/members/{}/revoke-playlist-tokens",
        sub.replace(':', "%3A")
    )
}

// ── A) gates ──

#[tokio::test]
async fn both_halves_are_admin_only() {
    let h = h(&[]).await;
    add_member(&h.st.pool, USER, "user", "apple").await;
    let user = cookie(&h.st, USER, "guest", Role::User);
    let forbidden = r#"{"error":"forbidden","reason":"admin_only"}"#;
    for (method, path, body) in [
        ("GET", "/api/admin/invites", None),
        ("POST", "/api/admin/invites", Some("{}")),
        ("DELETE", "/api/admin/invites/deadbeef", None),
        ("GET", "/api/admin/members", None),
        ("DELETE", "/api/admin/members/google:99", None),
    ] {
        let r = h.send(method, path, "", body).await;
        assert_eq!(
            (r.status, r.text.as_str()),
            (401, r#"{"error":"unauthenticated"}"#),
            "{method} {path}"
        );
        let r = h.send(method, path, &user, body).await;
        assert_eq!(
            (r.status, r.text.as_str()),
            (403, forbidden),
            "{method} {path}"
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invites")
        .fetch_one(&h.st.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

// ── B) POST /invites ──

#[tokio::test]
async fn an_empty_body_issues_a_single_use_14_day_invite() {
    let h = h(&[]).await;
    let created = h.issue(json!({})).await;
    let code = created["code"].as_str().unwrap();
    assert!(
        code.len() == 22
            && code
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "{code}"
    );
    let prefix = created["code_hash_prefix"].as_str().unwrap();
    assert!(prefix.len() == 8 && prefix.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(created["max_uses"], 1);
    assert_eq!(created["role"], "user");
    assert!(created["label"].is_null());
    let expires = chrono::DateTime::parse_from_rfc3339(created["expires_at"].as_str().unwrap())
        .unwrap()
        .timestamp();
    assert!((expires - unix_now() - 14 * 86_400).abs() < 60);

    let list = h.invites().await;
    let found = list
        .iter()
        .find(|i| i["code_hash_prefix"] == prefix)
        .unwrap();
    assert_eq!(found["status"], "active");
    assert_eq!(found["used_count"], 0);
    assert_eq!(found["issued_by"], OWNER);
}

#[tokio::test]
async fn a_full_body_trims_the_label_and_passes_max_uses_through() {
    let h = h(&[]).await;
    let created = h
        .issue(json!({ "label": "  Mom's iPad  ", "expiresInDays": 30, "maxUses": 3 }))
        .await;
    assert_eq!(created["label"], "Mom's iPad");
    assert_eq!(created["max_uses"], 3);
    assert!(created["expires_at"].is_string());
    // The response keeps the TS key order.
    let r = h
        .send("POST", "/api/admin/invites", &h.owner(), Some("{}"))
        .await;
    let keys = [
        "code",
        "code_hash_prefix",
        "label",
        "role",
        "expires_at",
        "max_uses",
    ];
    let mut at = 0;
    for k in keys {
        at += r.text[at..].find(&format!("\"{k}\":")).unwrap();
    }
}

#[tokio::test]
async fn role_admin_mints_an_owner_invite_and_other_roles_are_400() {
    let h = h(&[]).await;
    let created = h
        .issue(json!({ "role": "admin", "label": "App Review" }))
        .await;
    assert_eq!(created["role"], "admin");
    let listed = h.invites().await;
    assert_eq!(
        listed
            .iter()
            .find(|i| i["code_hash_prefix"] == created["code_hash_prefix"])
            .unwrap()["role"],
        "admin"
    );
    assert_eq!(h.issue(json!({})).await["role"], "user");
    for role in [json!("owner"), json!(null), json!(1)] {
        let r = h
            .send(
                "POST",
                "/api/admin/invites",
                &h.owner(),
                Some(&json!({ "role": role }).to_string()),
            )
            .await;
        assert_eq!(r.status, 400);
        assert_eq!(
            r.text,
            r#"{"error":"invalid_body","message":"role must be 'user' or 'admin'"}"#
        );
    }
}

#[tokio::test]
async fn wrong_field_types_are_400_and_nulls_are_their_own_branch() {
    let h = h(&[]).await;
    let bad = |field: &str, value: Value| json!({ field: value }).to_string();
    for (body, message) in [
        (bad("label", json!(123)), "label must be a string"),
        (
            bad("expiresInDays", json!("soon")),
            "expiresInDays must be a number or null",
        ),
        // Past JS Date's range TS threw (a 500); here it is the type 400.
        (
            bad("expiresInDays", json!(1e9)),
            "expiresInDays must be a number or null",
        ),
        (bad("maxUses", json!(0)), "maxUses must be an integer >= 1"),
        (
            bad("maxUses", json!(1.5)),
            "maxUses must be an integer >= 1",
        ),
        (
            bad("maxUses", json!(null)),
            "maxUses must be an integer >= 1",
        ),
        (
            bad("maxUses", json!("2")),
            "maxUses must be an integer >= 1",
        ),
    ] {
        let r = h
            .send("POST", "/api/admin/invites", &h.owner(), Some(&body))
            .await;
        assert_eq!(r.status, 400, "{body}");
        assert_eq!(
            r.json(),
            json!({ "error": "invalid_body", "message": message }),
            "{body}"
        );
    }
    assert!(h.issue(json!({ "expiresInDays": null })).await["expires_at"].is_null());
    assert!(h.issue(json!({ "label": null })).await["label"].is_null());
    assert!(h.issue(json!({ "label": "   " })).await["label"].is_null());
    assert_eq!(h.issue(json!({ "maxUses": 2.0 })).await["max_uses"], 2);
    let long = h.issue(json!({ "label": "x".repeat(200) })).await;
    assert_eq!(long["label"], "x".repeat(120));
    let past = h.issue(json!({ "expiresInDays": -1 })).await;
    let listed = h.invites().await;
    let row = listed
        .iter()
        .find(|i| i["code_hash_prefix"] == past["code_hash_prefix"])
        .unwrap();
    assert_eq!(row["status"], "expired");
    // An unparseable body reads as empty: defaults, not a 400.
    let r = h
        .send("POST", "/api/admin/invites", &h.owner(), Some("not json"))
        .await;
    assert_eq!(r.status, 201);
}

// ── C) DELETE /invites/:prefix ──

#[tokio::test]
async fn revoke_by_prefix_then_unknown_and_double_revoke_are_404() {
    let h = h(&[]).await;
    let created = h.issue(json!({})).await;
    let prefix = created["code_hash_prefix"].as_str().unwrap();
    let path = format!("/api/admin/invites/{prefix}");
    let r = h.send("DELETE", &path, &h.owner(), None).await;
    assert_eq!((r.status, r.text.as_str()), (200, r#"{"ok":true}"#));
    let listed = h.invites().await;
    assert_eq!(
        listed
            .iter()
            .find(|i| i["code_hash_prefix"] == prefix)
            .unwrap()["status"],
        "revoked"
    );
    let again = h.send("DELETE", &path, &h.owner(), None).await;
    assert_eq!(again.status, 404);
    let unknown = h
        .send("DELETE", "/api/admin/invites/deadbeef", &h.owner(), None)
        .await;
    assert_eq!(
        (unknown.status, unknown.text.as_str()),
        (404, r#"{"error":"not_found"}"#)
    );
}

// ── D) GET /members ──

#[tokio::test]
async fn the_admin_subs_owner_is_synthesized_once_with_its_provider() {
    let h = h(&[]).await;
    let members = h.members().await;
    assert_eq!(
        members,
        [json!({
            "sub": OWNER, "display_name": null, "role": "admin", "auth_mode": "workos",
            "invited_by": null, "joined_at": "", "revoked_at": null, "is_admin": true,
        })]
    );

    add_member(&h.st.pool, USER, "user", "apple").await;
    add_member(&h.st.pool, ADMIN, "admin", "google").await;
    let members = h.members().await;
    assert_eq!(members.len(), 3);
    assert_eq!(members[0]["sub"], OWNER, "synthesized rows go first");
    let flag = |sub: &str| members.iter().find(|m| m["sub"] == sub).unwrap()["is_admin"].clone();
    assert_eq!(flag(USER), false);
    assert_eq!(flag(ADMIN), true);

    // An owner with a row is listed once, from the row.
    add_member(&h.st.pool, OWNER, "user", "workos").await;
    let members = h.members().await;
    let owners: Vec<&Value> = members.iter().filter(|m| m["sub"] == OWNER).collect();
    assert_eq!(owners.len(), 1);
    assert_eq!(owners[0]["is_admin"], true);
    assert_ne!(owners[0]["joined_at"], "");
}

#[tokio::test]
async fn several_admin_subs_are_unshifted_in_reverse() {
    let h = h(&[("ADMIN_SUBS", "google:1,google:2")]).await;
    add_member(&h.st.pool, ADMIN, "admin", "google").await;
    let r = h
        .send(
            "GET",
            "/api/admin/members",
            &cookie(&h.st, ADMIN, "a", Role::Admin),
            None,
        )
        .await;
    let subs: Vec<String> = r.json()["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["sub"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(subs, ["google:2", "google:1", ADMIN]);
}

// ── E) DELETE /members/:sub ──

#[tokio::test]
async fn the_owner_cannot_be_revoked_and_nothing_cascades() {
    let h = h(&[]).await;
    h.insert_device("owner-device", OWNER).await;
    let r = h
        .send(
            "DELETE",
            &format!("/api/admin/members/{OWNER}"),
            &h.owner(),
            None,
        )
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (409, r#"{"error":"cannot_revoke_owner"}"#)
    );
    assert_eq!(
        h.revocation_state(OWNER, "owner-device").await,
        (None, None)
    );
    assert!(h.iptv.calls().is_empty());
}

#[tokio::test]
async fn a_db_admin_cannot_revoke_themselves() {
    let h = h(&[("ADMIN_SUBS", "")]).await;
    add_member(&h.st.pool, ADMIN, "admin", "google").await;
    h.insert_device("self-device", ADMIN).await;
    let r = h
        .send(
            "DELETE",
            &format!("/api/admin/members/{ADMIN}"),
            &cookie(&h.st, ADMIN, "db-owner", Role::Admin),
            None,
        )
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (409, r#"{"error":"cannot_revoke_self"}"#)
    );
    assert_eq!(
        h.revocation_state(ADMIN, "self-device").await,
        (Some(None), None)
    );
    assert!(h.iptv.calls().is_empty());
}

#[tokio::test]
async fn one_db_admin_revokes_a_second_admin_and_its_credentials_cascade() {
    let h = h(&[("ADMIN_SUBS", "")]).await;
    add_member(&h.st.pool, ADMIN, "admin", "google").await;
    add_member(&h.st.pool, SECOND_ADMIN, "admin", "google").await;
    h.insert_device("final-device", SECOND_ADMIN).await;
    let r = h
        .send(
            "DELETE",
            &format!("/api/admin/members/{SECOND_ADMIN}"),
            &cookie(&h.st, ADMIN, "first-admin", Role::Admin),
            None,
        )
        .await;
    assert_eq!((r.status, r.text.as_str()), (200, r#"{"ok":true}"#));
    let (member, reason) = h.revocation_state(SECOND_ADMIN, "final-device").await;
    assert!(matches!(member, Some(Some(_))));
    assert_eq!(reason.as_deref(), Some("member_revoked"));
    assert_eq!(h.iptv.calls(), [revoke_call(SECOND_ADMIN)]);
}

#[tokio::test]
async fn a_db_admin_bearer_can_revoke_a_member() {
    let h = h(&[("ADMIN_SUBS", "")]).await;
    add_member(&h.st.pool, ADMIN, "admin", "google").await;
    add_member(&h.st.pool, USER, "user", "apple").await;
    let token = device_token(&h.st, ADMIN, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Kitchen iPad").await;
    let r = call(
        &h.app,
        "DELETE",
        &format!("/api/admin/members/{USER}"),
        &[("authorization", &format!("Bearer {token}"))],
        None,
    )
    .await;
    assert_eq!((r.status, r.text.as_str()), (200, r#"{"ok":true}"#));
    assert!(
        crate::members::is_member(&h.st.pool, USER)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn revoking_a_member_keeps_the_row_and_calls_iptv_with_an_admin_principal() {
    let h = h(&[]).await;
    add_member(&h.st.pool, USER, "user", "apple").await;
    h.insert_device("device-user-sub", USER).await;
    // Percent-encoded in the path, as the SPA's encodeURIComponent sends it.
    let r = h
        .send(
            "DELETE",
            &format!("/api/admin/members/{}", USER.replace(':', "%3A")),
            &h.owner(),
            None,
        )
        .await;
    assert_eq!((r.status, r.text.as_str()), (200, r#"{"ok":true}"#));

    let members = h.members().await;
    let revoked = members.iter().find(|m| m["sub"] == USER).unwrap();
    assert!(revoked["revoked_at"].is_string(), "retained for audit");
    let (_, reason) = h.revocation_state(USER, "device-user-sub").await;
    assert_eq!(reason.as_deref(), Some("member_revoked"));

    assert_eq!(h.iptv.calls(), [revoke_call(USER)]);
    let auth = h.iptv.calls.lock().unwrap()[0].1.clone().unwrap();
    let token = auth.strip_prefix("Bearer ").unwrap();
    let secret = "auth-goldens-internal-secret-0123456789abcdef";
    let key = emerald_contracts::derive_key(
        secret.as_bytes(),
        emerald_contracts::INFO_INTERNAL_PRINCIPAL,
    );
    let claims = internal_principal::decrypt(
        &HashMap::from([(internal_principal::DEFAULT_KID.to_string(), key)]),
        token,
    )
    .unwrap();
    internal_principal::enforce_time_window(&claims, unix_now()).unwrap();
    assert_eq!(
        (
            claims.sub.as_str(),
            claims.role.as_str(),
            claims.auth_mode.as_str()
        ),
        (USER, "admin", "apple")
    );
    assert_eq!(
        claims.server_id,
        crate::ensure_server_id(&h.st.pool).await.unwrap()
    );
    assert_eq!(claims.exp - claims.iat, 60);
}

#[tokio::test]
async fn an_iptv_failure_is_logged_with_the_request_id_but_never_the_sub() {
    capture_logs();
    let h = h(&[]).await;
    add_member(&h.st.pool, USER, "user", "apple").await;
    h.iptv
        .status
        .store(500, std::sync::atomic::Ordering::SeqCst);
    let r = call(
        &h.app,
        "DELETE",
        &format!("/api/admin/members/{USER}"),
        &[
            ("cookie", &h.owner()),
            ("x-request-id", "member-revoke-request"),
        ],
        None,
    )
    .await;
    assert_eq!(r.status, 200);
    let logs = logs();
    let line = logs
        .lines()
        .find(|l| l.contains("playlist-token cascade revoke failed"))
        .unwrap_or_else(|| panic!("{logs}"));
    assert!(line.contains(" ERROR "), "{line}");
    assert!(line.contains("member-revoke-request"), "{line}");
    assert!(line.contains("iptv internal POST answered 500"), "{line}");
    assert!(
        !logs.contains(USER) && !logs.contains("000001.0123"),
        "{logs}"
    );
}

#[tokio::test]
async fn an_unreachable_iptv_service_still_answers_ok_and_logs_no_url() {
    capture_logs();
    let dead = dead_url().await;
    let base = dead.trim_end_matches("/keys");
    let h = h(&[("IPTV_SERVICE_URL", base)]).await;
    add_member(&h.st.pool, USER, "user", "apple").await;
    let r = h
        .send(
            "DELETE",
            &format!("/api/admin/members/{USER}"),
            &h.owner(),
            None,
        )
        .await;
    assert_eq!(r.status, 200);
    let logs = logs();
    assert!(logs.contains("iptv internal POST failed"), "{logs}");
    assert!(!logs.contains(USER) && !logs.contains("%3A"), "{logs}");
}

#[tokio::test]
async fn iptv_disabled_skips_the_call_and_no_secret_sends_no_principal() {
    let h1 = h(&[("IPTV_DISABLED", "1")]).await;
    add_member(&h1.st.pool, USER, "user", "apple").await;
    let path = format!("/api/admin/members/{USER}");
    assert_eq!(
        h1.send("DELETE", &path, &h1.owner(), None).await.status,
        200
    );
    assert!(h1.iptv.calls().is_empty());

    let h2 = h(&[("INTERNAL_PRINCIPAL_SECRET", "")]).await;
    add_member(&h2.st.pool, USER, "user", "apple").await;
    assert_eq!(
        h2.send("DELETE", &path, &h2.owner(), None).await.status,
        200
    );
    assert_eq!(h2.iptv.calls(), [revoke_call(USER)]);
    assert_eq!(h2.iptv.calls.lock().unwrap()[0].1, None);
}

#[tokio::test]
async fn revoking_an_unknown_member_is_404() {
    let h = h(&[]).await;
    let r = h
        .send("DELETE", "/api/admin/members/google:8", &h.owner(), None)
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (404, r#"{"error":"not_found"}"#)
    );
    assert!(h.iptv.calls().is_empty());
}

#[test]
fn encode_uri_component_matches_js() {
    assert_eq!(
        encode_uri_component("apple:0.a-b_c!~*'()/ ?#é"),
        "apple%3A0.a-b_c!~*'()%2F%20%3F%23%C3%A9"
    );
}
