//! devices.test.ts carried over: self list / revoke / logout-everywhere /
//! rename and the admin list / revoke / rename, through the full router with
//! real device tokens. TS used plex subs and the ADMINS username list; here
//! the user is an Apple member and the admin a DB-admin Google member.

use super::*;
use crate::Role;
use crate::testutil::*;

const USER: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";
const OTHER: &str = "google:99999";
const ADMIN: &str = "google:22222";

struct H {
    _db: TestDb,
    st: AuthState,
    app: Router,
}

async fn h() -> H {
    let (db, st) = state().await;
    add_member(&st.pool, USER, "user", "apple").await;
    add_member(&st.pool, OTHER, "user", "google").await;
    add_member(&st.pool, ADMIN, "admin", "google").await;
    let app = crate::router(st.clone());
    H { _db: db, st, app }
}

impl H {
    async fn token(&self, sub: &str, device_id: &str, name: &str) -> (String, String) {
        let token = device_token(&self.st, sub, device_id, name).await;
        let claims = device_tokens::verify(
            &self.st.pool,
            self.st.device_keys.as_deref().unwrap(),
            &token,
            unix_now(),
        )
        .await
        .unwrap()
        .unwrap();
        (format!("Bearer {token}"), claims.jti)
    }

    async fn send(&self, method: &str, path: &str, auth: &str, body: Option<&str>) -> Reply {
        call(
            &self.app,
            method,
            path,
            &[
                ("authorization", auth),
                ("content-type", "application/json"),
            ],
            body,
        )
        .await
    }

    async fn verifies(&self, jti: &str) -> bool {
        let revoked: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM device_token_revocations WHERE jti = ?")
                .bind(jti)
                .fetch_optional(&self.st.pool)
                .await
                .unwrap();
        revoked.is_none()
    }

    async fn name(&self, jti: &str) -> String {
        sqlx::query_scalar("SELECT device_name FROM device_tokens WHERE jti = ?")
            .bind(jti)
            .fetch_one(&self.st.pool)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn a_revoked_member_bearer_is_rejected_on_the_next_request() {
    let h = h().await;
    let (auth, _) = h
        .token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Living Room")
        .await;
    assert_eq!(
        h.send("GET", "/api/devices/self", &auth, None).await.status,
        200
    );
    set_revoked(&h.st.pool, USER).await;
    assert_eq!(
        h.send("GET", "/api/devices/self", &auth, None).await.status,
        401
    );
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_token_revocations")
        .fetch_one(&h.st.pool)
        .await
        .unwrap();
    assert!(n > 0);
}

#[tokio::test]
async fn a_never_member_bearer_is_rejected() {
    let h = h().await;
    let (auth, _) = h
        .token("google:404", "01HABCDEFGHJKMNPQRSTVWXYZ0", "TV")
        .await;
    assert_eq!(
        h.send("GET", "/api/devices/self", &auth, None).await.status,
        401
    );
}

#[tokio::test]
async fn self_lists_only_the_callers_devices_and_marks_the_current_one() {
    let h = h().await;
    let (auth, jti) = h
        .token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Living Room Apple TV")
        .await;
    h.token(OTHER, "01HOTHERDEVICEOTHERDEVICE0", "Other user's TV")
        .await;
    let r = h.send("GET", "/api/devices/self", &auth, None).await;
    assert_eq!(r.status, 200);
    let devices = r.json()["devices"].as_array().unwrap().clone();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["device_name"], "Living Room Apple TV");
    assert_eq!(devices[0]["jti"], jti.as_str());
    assert_eq!(devices[0]["is_current"], true);
    assert!(devices[0].get("sub").is_none() && devices[0].get("kid").is_none());
    // The TS field order, with is_current last.
    let mut at = 0;
    for key in [
        "jti",
        "device_id",
        "device_name",
        "platform",
        "server_id",
        "issued_at",
        "expires_at",
        "last_seen_at",
        "last_seen_version",
        "revoked",
        "revoked_at",
        "revoked_reason",
        "is_current",
    ] {
        at += r.text[at..]
            .find(&format!("\"{key}\":"))
            .unwrap_or_else(|| panic!("{key} out of order in {}", r.text));
    }

    // A cookie caller carries no jti: no is_current at all.
    let cookie = cookie(&h.st, USER, "u", Role::User);
    let r = call(
        &h.app,
        "GET",
        "/api/devices/self",
        &[("cookie", &cookie)],
        None,
    )
    .await;
    assert!(!r.text.contains("is_current"), "{}", r.text);
}

#[tokio::test]
async fn self_excludes_revoked_devices() {
    let h = h().await;
    let (_, jti_a) = h
        .token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Apple TV")
        .await;
    let (auth_b, _) = h.token(USER, "01HSECONDDEVICESECONDDEVIC", "iPhone").await;
    device_tokens::revoke(&h.st.pool, &jti_a, "test")
        .await
        .unwrap();
    let r = h.send("GET", "/api/devices/self", &auth_b, None).await;
    let names: Vec<String> = r.json()["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["device_name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["iPhone"]);
}

#[tokio::test]
async fn self_revokes_my_own_device_but_not_someone_elses() {
    let h = h().await;
    let (auth, jti) = h
        .token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Apple TV")
        .await;
    let (_, theirs) = h
        .token(OTHER, "01HOTHERDEVICEOTHERDEVICE0", "Their TV")
        .await;

    let r = h
        .send(
            "DELETE",
            &format!("/api/devices/self/{theirs}"),
            &auth,
            None,
        )
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (404, r#"{"error":"not_found"}"#)
    );
    assert!(h.verifies(&theirs).await);

    let r = h
        .send("DELETE", &format!("/api/devices/self/{jti}"), &auth, None)
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text, format!(r#"{{"ok":true,"revoked":"{jti}"}}"#));
    assert!(!h.verifies(&jti).await);
    let reason: String =
        sqlx::query_scalar("SELECT reason FROM device_token_revocations WHERE jti = ?")
            .bind(&jti)
            .fetch_one(&h.st.pool)
            .await
            .unwrap();
    assert_eq!(reason, "self_revoke");
    // The next request on the revoked token is a 401.
    assert_eq!(
        h.send("GET", "/api/devices/self", &auth, None).await.status,
        401
    );
}

#[tokio::test]
async fn logout_everywhere_revokes_every_device_and_reports_the_count() {
    let h = h().await;
    let (auth, _) = h
        .token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Apple TV")
        .await;
    let (_, already) = h.token(USER, "01HSECONDDEVICESECONDDEVIC", "iPhone").await;
    h.token(USER, "01HTHIRDDEVICETHIRDDEVICE0", "iPad").await;
    h.token(USER, "01HFOURTHDEVICEFOURTHDEVIC", "Mac").await;
    let (_, theirs) = h
        .token(OTHER, "01HOTHERDEVICEOTHERDEVICE0", "Their TV")
        .await;
    device_tokens::revoke(&h.st.pool, &already, "test")
        .await
        .unwrap();

    let r = h.send("DELETE", "/api/devices/self", &auth, None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text, r#"{"ok":true,"revoked_count":3}"#);
    let reasons: Vec<String> = sqlx::query_scalar(
        "SELECT r.reason FROM device_token_revocations r JOIN device_tokens d ON d.jti = r.jti \
         WHERE d.sub = ? ORDER BY r.reason",
    )
    .bind(USER)
    .fetch_all(&h.st.pool)
    .await
    .unwrap();
    assert_eq!(
        reasons,
        [
            "self_logout_everywhere",
            "self_logout_everywhere",
            "self_logout_everywhere",
            "test"
        ]
    );
    assert!(h.verifies(&theirs).await);
}

#[tokio::test]
async fn self_renames_my_device_with_the_ts_validation() {
    let h = h().await;
    let (auth, jti) = h
        .token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Apple TV")
        .await;
    let (_, theirs) = h
        .token(OTHER, "01HOTHERDEVICEOTHERDEVICE0", "Their TV")
        .await;
    let path = format!("/api/devices/self/{jti}/name");

    let r = h
        .send(
            "PATCH",
            &path,
            &auth,
            Some(r#"{"device_name":"  Bedroom Apple TV "}"#),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text, r#"{"ok":true,"device_name":"Bedroom Apple TV"}"#);
    assert_eq!(h.name(&jti).await, "Bedroom Apple TV");

    let required = r#"{"error":"invalid_body","message":"device_name (string) required"}"#;
    let length = r#"{"error":"invalid_body","message":"device_name must be 1-128 chars"}"#;
    for (body, want) in [
        (r#"{"device_name":"   "}"#.to_string(), length),
        (
            json!({ "device_name": "x".repeat(129) }).to_string(),
            length,
        ),
        (r#"{"device_name":42}"#.to_string(), required),
        ("{}".to_string(), required),
        ("not json".to_string(), required),
    ] {
        let r = h.send("PATCH", &path, &auth, Some(&body)).await;
        assert_eq!((r.status, r.text.as_str()), (400, want), "{body}");
    }
    // 128 UTF-16 units is the cap: 64 astral chars fit, 65 do not.
    let ok = json!({ "device_name": "\u{1F4FA}".repeat(64) }).to_string();
    assert_eq!(h.send("PATCH", &path, &auth, Some(&ok)).await.status, 200);
    let over = json!({ "device_name": "\u{1F4FA}".repeat(65) }).to_string();
    assert_eq!(h.send("PATCH", &path, &auth, Some(&over)).await.status, 400);

    let r = h
        .send(
            "PATCH",
            &format!("/api/devices/self/{theirs}/name"),
            &auth,
            Some(r#"{"device_name":"Hijacked"}"#),
        )
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(h.name(&theirs).await, "Their TV");
}

#[tokio::test]
async fn self_without_credentials_is_401() {
    let h = h().await;
    for (method, path) in [
        ("GET", "/api/devices/self"),
        ("DELETE", "/api/devices/self"),
        ("DELETE", "/api/devices/self/x"),
        ("PATCH", "/api/devices/self/x/name"),
    ] {
        assert_eq!(
            call(&h.app, method, path, &[], None).await.status,
            401,
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn admin_lists_every_device_with_its_sub_including_revoked() {
    let h = h().await;
    let (admin, _) = h
        .token(ADMIN, "01HADMINDEVICEADMINDEVICE0", "Admin's Mac")
        .await;
    let (_, user_jti) = h
        .token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Living Room Apple TV")
        .await;
    device_tokens::revoke(&h.st.pool, &user_jti, "test")
        .await
        .unwrap();

    let r = h.send("GET", "/api/admin/devices", &admin, None).await;
    assert_eq!(r.status, 200);
    let devices = r.json()["devices"].as_array().unwrap().clone();
    assert_eq!(devices.len(), 2);
    let subs: Vec<&str> = devices.iter().map(|d| d["sub"].as_str().unwrap()).collect();
    assert!(subs.contains(&ADMIN) && subs.contains(&USER));
    let user = devices.iter().find(|d| d["sub"] == USER).unwrap();
    assert_eq!(user["revoked"], true);
    assert_eq!(user["revoked_reason"], "test");
    assert!(devices.iter().all(|d| d.get("is_current").is_none()));
    // sub comes last, after revoked_reason.
    assert!(
        r.text
            .contains(&format!(r#""revoked_reason":"test","sub":"{USER}""#))
    );
}

#[tokio::test]
async fn admin_routes_refuse_non_admins_and_anonymous_callers() {
    let h = h().await;
    let (user, _) = h.token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "TV").await;
    let (_, target) = h
        .token(OTHER, "01HOTHERDEVICEOTHERDEVICE0", "Target TV")
        .await;
    let forbidden = r#"{"error":"forbidden","reason":"admin_only"}"#;
    for (method, path, body) in [
        ("GET", "/api/admin/devices".to_string(), None),
        ("DELETE", format!("/api/admin/devices/{target}"), None),
        (
            "PATCH",
            format!("/api/admin/devices/{target}/name"),
            Some(r#"{"device_name":"Should Not Apply"}"#),
        ),
    ] {
        let r = h.send(method, &path, &user, body).await;
        assert_eq!(
            (r.status, r.text.as_str()),
            (403, forbidden),
            "{method} {path}"
        );
        assert_eq!(call(&h.app, method, &path, &[], body).await.status, 401);
    }
    assert!(h.verifies(&target).await);
    assert_eq!(h.name(&target).await, "Target TV");
}

#[tokio::test]
async fn admin_revokes_and_renames_any_device() {
    let h = h().await;
    let (admin, admin_jti) = h
        .token(ADMIN, "01HADMINDEVICEADMINDEVICE0", "Admin's Mac")
        .await;
    let (_, jti) = h
        .token(USER, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Apple TV")
        .await;

    let r = h
        .send(
            "PATCH",
            &format!("/api/admin/devices/{jti}/name"),
            &admin,
            Some(r#"{"device_name":"Renamed By Admin"}"#),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(h.name(&jti).await, "Renamed By Admin");
    let r = h
        .send(
            "PATCH",
            &format!("/api/admin/devices/{admin_jti}/name"),
            &admin,
            Some(r#"{"device_name":"   "}"#),
        )
        .await;
    assert_eq!(r.status, 400);
    let r = h
        .send(
            "PATCH",
            "/api/admin/devices/01HNONEXISTENTNONEXISTENT0/name",
            &admin,
            Some(r#"{"device_name":"X"}"#),
        )
        .await;
    assert_eq!(r.status, 404);

    let r = h
        .send("DELETE", &format!("/api/admin/devices/{jti}"), &admin, None)
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["revoked"], jti.as_str());
    assert!(!h.verifies(&jti).await);
    let reason: String =
        sqlx::query_scalar("SELECT reason FROM device_token_revocations WHERE jti = ?")
            .bind(&jti)
            .fetch_one(&h.st.pool)
            .await
            .unwrap();
    assert_eq!(reason, "admin_revoke");
    let r = h
        .send(
            "DELETE",
            "/api/admin/devices/01HNONEXISTENTNONEXISTENT0",
            &admin,
            None,
        )
        .await;
    assert_eq!(r.status, 404);
}
