//! Carried over from middleware/auth.test.ts, middleware/deviceTokenAuth.test.ts,
//! services/sessionGate.test.ts (non-Plex cases) and the reconcile cases of
//! services/reconcileDeviceToken.test.ts. The golden replay runs the requests
//! gen-auth-goldens.ts sent through the untouched TS middleware.

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use axum::routing::get;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::device_tokens::{Keys, MintInput};
use crate::testutil::{add_member, capture_logs, goldens, insert_rows, logs, set_revoked, state};

const OWNER: &str = "workos:user_01E4ZCR3C56J083X43JQXF3JK5";
const MEMBER: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";
const LOCAL: &str = "local:01ARZ3NDEKTSV4RRFFQ69G5FAV";

async fn echo(RequireAuth(p): RequireAuth) -> axum::Json<Value> {
    axum::Json(json!({ "user": p.session }))
}

async fn echo_admin(RequireAdmin(p): RequireAdmin) -> axum::Json<Value> {
    axum::Json(json!({ "user": p.session }))
}

/// The goldens' app: requireAuth / requireAdmin echo routes plus /api/me.
fn app(state: AuthState) -> Router {
    Router::new()
        .route("/needs-auth", get(echo))
        .route("/needs-admin", get(echo_admin))
        .with_state(state.clone())
        .merge(crate::router(state))
}

async fn send(app: &Router, path: &str, headers: &[(&str, &str)]) -> (u16, Value, Option<String>) {
    let mut req = Request::get(path);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let cookie = res
        .headers()
        .get(header::SET_COOKIE)
        .map(|v| v.to_str().unwrap().to_string());
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap(), cookie)
}

#[tokio::test]
async fn replays_the_ts_middleware_goldens() {
    let g = goldens();
    let (db, mut st) = state().await;
    st.fixed_now = g["minted_at"].as_i64();
    insert_rows(&db, "members", &g["seed"]["members"]).await;
    insert_rows(&db, "device_tokens", &g["seed"]["device_tokens"]).await;
    let app = app(st);

    for s in g["scenarios"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let headers: Vec<(&str, &str)> = s["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str().unwrap()))
            .collect();
        let (status, body, cookie) = send(&app, s["path"].as_str().unwrap(), &headers).await;
        assert_eq!(status, s["status"].as_u64().unwrap() as u16, "{name}");
        assert_eq!(body, s["body"], "{name}");
        assert_eq!(json!(cookie), s["set_cookie"], "{name}");
    }

    let revocations: Vec<(String, String)> =
        sqlx::query_as("SELECT jti, reason FROM device_token_revocations ORDER BY jti")
            .fetch_all(&*db)
            .await
            .unwrap();
    let tokens: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT jti, last_seen_version, last_seen_at IS NOT NULL FROM device_tokens ORDER BY jti",
    )
    .fetch_all(&*db)
    .await
    .unwrap();
    let revocations: Vec<Value> = revocations
        .into_iter()
        .map(|(jti, reason)| json!({ "jti": jti, "reason": reason }))
        .collect();
    let tokens: Vec<Value> = tokens
        .into_iter()
        .map(|(jti, v, seen)| json!({ "jti": jti, "last_seen_version": v, "seen": seen }))
        .collect();
    assert_eq!(json!(revocations), g["final"]["revocations"]);
    assert_eq!(json!(tokens), g["final"]["device_tokens"]);
}

fn mint_input<'a>(sub: &'a str, auth_mode: AuthMode, name: &'a str) -> MintInput<'a> {
    MintInput {
        sub,
        role: Role::User,
        auth_mode,
        device_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        device_platform: "tvos",
        device_name: name,
        username: None,
        server_id: "srv",
    }
}

async fn device(
    st: &AuthState,
    sub: &str,
    auth_mode: AuthMode,
    name: &str,
) -> (String, DeviceClaims) {
    let keys: &Keys = st.device_keys.as_deref().unwrap();
    let token = device_tokens::mint(&st.pool, keys, &mint_input(sub, auth_mode, name))
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let claims = device_tokens::verify(&st.pool, keys, &token, now)
        .await
        .unwrap()
        .unwrap();
    (token, claims)
}

async fn last_seen(pool: &SqlitePool, jti: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as("SELECT last_seen_at, last_seen_version FROM device_tokens WHERE jti = ?")
        .bind(jti)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn revocations(pool: &SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as("SELECT jti, reason FROM device_token_revocations ORDER BY jti")
        .fetch_all(pool)
        .await
        .unwrap()
}

fn subs(st: &AuthState) -> &[String] {
    &st.config.admin_subs
}

#[tokio::test]
async fn bearer_reconcile_touches_the_row_and_coalesces_the_app_version() {
    let (db, st) = state().await;
    // OWNER is in ADMIN_SUBS: allowed with no members row, admin role.
    let (_, claims) = device(&st, OWNER, AuthMode::Workos, "Chris iPhone").await;
    let s = reconcile_bearer(&db, subs(&st), &claims, Some("app-1.2.3"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (s.sub.as_str(), s.username.as_str(), s.role),
        (OWNER, "Chris iPhone", Role::Admin)
    );
    let (seen, version) = last_seen(&db, &claims.jti).await;
    assert!(seen.is_some());
    assert_eq!(version.as_deref(), Some("app-1.2.3"));

    // A request without X-App-Version keeps the prior version.
    reconcile_bearer(&db, subs(&st), &claims, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        last_seen(&db, &claims.jti).await.1.as_deref(),
        Some("app-1.2.3")
    );
    assert!(revocations(&db).await.is_empty());
}

#[tokio::test]
async fn bearer_role_follows_the_members_row_not_the_token_claim() {
    let (db, st) = state().await;
    add_member(&db, LOCAL, "admin", "local").await;
    let (_, claims) = device(&st, LOCAL, AuthMode::Local, "Owner phone").await;
    let role = |db: &SqlitePool| {
        let (db, claims, st) = (db.clone(), claims.clone(), st.clone());
        async move {
            reconcile_bearer(&db, subs(&st), &claims, None)
                .await
                .unwrap()
                .unwrap()
                .role
        }
    };
    assert_eq!(role(&db).await, Role::Admin);
    sqlx::query("UPDATE members SET role = 'user' WHERE sub = ?")
        .bind(LOCAL)
        .execute(&*db)
        .await
        .unwrap();
    assert_eq!(role(&db).await, Role::User);
}

#[tokio::test]
async fn bearer_with_no_row_is_rejected_without_a_revocation() {
    let (db, st) = state().await;
    let (_, mut claims) = device(&st, OWNER, AuthMode::Workos, "TV").await;
    claims.jti = "jti-missing".into();
    assert_eq!(
        reconcile_bearer(&db, subs(&st), &claims, Some("app-9"))
            .await
            .unwrap(),
        None
    );
    assert!(revocations(&db).await.is_empty());
}

#[tokio::test]
async fn bearer_of_a_revoked_or_unknown_sub_cascades() {
    let (db, st) = state().await;
    add_member(&db, MEMBER, "user", "apple").await;
    set_revoked(&db, MEMBER).await;
    let (_, c1) = device(&st, MEMBER, AuthMode::Apple, "TV").await;
    let (_, c2) = device(&st, MEMBER, AuthMode::Apple, "Phone").await;
    assert_eq!(
        reconcile_bearer(&db, subs(&st), &c1, None).await.unwrap(),
        None
    );
    let mut expected = vec![
        (c1.jti.clone(), "member_revoked".to_string()),
        (c2.jti.clone(), "member_revoked".to_string()),
    ];
    expected.sort();
    assert_eq!(revocations(&db).await, expected);

    let (_, stranger) = device(&st, LOCAL, AuthMode::Local, "TV").await;
    assert_eq!(
        reconcile_bearer(&db, subs(&st), &stranger, None)
            .await
            .unwrap(),
        None
    );
    assert!(
        revocations(&db)
            .await
            .contains(&(stranger.jti.clone(), "not_member".into()))
    );
}

fn cookie_session(sub: &str, auth_mode: AuthMode, role: Role) -> Session {
    Session {
        sub: sub.into(),
        username: "Owner".into(),
        role,
        auth_mode,
        plex_auth_token: None,
    }
}

#[tokio::test]
async fn cookie_role_is_recomputed_from_the_members_row() {
    let (db, st) = state().await;
    add_member(&db, LOCAL, "admin", "local").await;
    let s = reconcile_cookie(
        &db,
        subs(&st),
        cookie_session(LOCAL, AuthMode::Local, Role::User),
    )
    .await
    .unwrap();
    assert_eq!(s.map(|s| s.role), Some(Role::Admin));

    // A user row never escalates, whatever the cookie claims.
    sqlx::query("UPDATE members SET role = 'user' WHERE sub = ?")
        .bind(LOCAL)
        .execute(&*db)
        .await
        .unwrap();
    let s = reconcile_cookie(
        &db,
        subs(&st),
        cookie_session(LOCAL, AuthMode::Local, Role::Admin),
    )
    .await
    .unwrap();
    assert_eq!(s.map(|s| s.role), Some(Role::User));
}

#[tokio::test]
async fn cookie_of_a_denied_sub_signs_out_and_cascades() {
    let (db, st) = state().await;
    // Not a member: denied, its devices revoked as not_member.
    let (_, stranger) = device(&st, LOCAL, AuthMode::Local, "TV").await;
    let s = cookie_session(LOCAL, AuthMode::Local, Role::User);
    assert_eq!(reconcile_cookie(&db, subs(&st), s).await.unwrap(), None);
    assert_eq!(
        revocations(&db).await,
        [(stranger.jti.clone(), "not_member".into())]
    );

    // Revoked: member_revoked.
    add_member(&db, MEMBER, "user", "apple").await;
    let (_, d) = device(&st, MEMBER, AuthMode::Apple, "TV").await;
    set_revoked(&db, MEMBER).await;
    let s = cookie_session(MEMBER, AuthMode::Apple, Role::User);
    assert_eq!(reconcile_cookie(&db, subs(&st), s).await.unwrap(), None);
    assert!(
        revocations(&db)
            .await
            .contains(&(d.jti.clone(), "member_revoked".into()))
    );
}

#[tokio::test]
async fn cookie_of_an_allowed_member_does_not_cascade() {
    let (db, st) = state().await;
    add_member(&db, MEMBER, "user", "apple").await;
    device(&st, MEMBER, AuthMode::Apple, "TV").await;
    let s = cookie_session(MEMBER, AuthMode::Apple, Role::User);
    assert!(reconcile_cookie(&db, subs(&st), s).await.unwrap().is_some());
    assert!(revocations(&db).await.is_empty());
}

#[tokio::test]
async fn cascade_logs_never_carry_the_sub() {
    let (db, st) = state().await;
    capture_logs();

    // Success: a warn with the count, no sub.
    let (_, d) = device(&st, LOCAL, AuthMode::Local, "TV").await;
    let s = cookie_session(LOCAL, AuthMode::Local, Role::User);
    assert_eq!(reconcile_cookie(&db, subs(&st), s).await.unwrap(), None);
    assert!(logs().contains("revoked_count=1"), "{}", logs());

    // Failure: the denial still stands, the error is logged without the sub.
    sqlx::query(
        "CREATE TRIGGER fail_revocation BEFORE INSERT ON device_token_revocations \
         BEGIN SELECT RAISE(ABORT, 'forced cascade failure'); END",
    )
    .execute(&*db)
    .await
    .unwrap();
    let (_, other) = device(&st, MEMBER, AuthMode::Apple, "TV").await;
    assert_eq!(
        reconcile_bearer(&db, subs(&st), &other, None)
            .await
            .unwrap(),
        None
    );
    let text = logs();
    assert!(text.contains("bookkeeping_failed"), "{text}");
    assert!(!text.contains(LOCAL) && !text.contains(MEMBER), "{text}");
    assert!(!text.contains(&d.jti));
}

fn with_bearer(token: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    h
}

#[tokio::test]
async fn bearer_time_window_has_30s_nbf_and_5s_exp_skew() {
    let (_db, mut st) = state().await;
    let (token, c) = device(&st, OWNER, AuthMode::Workos, "TV").await;
    let at = |st: &mut AuthState, t: i64| {
        st.fixed_now = Some(t);
        st.clone()
    };
    let h = with_bearer(&token);
    let s = at(&mut st, c.nbf - 60);
    assert_eq!(
        authenticate(&s, &h).await.err(),
        Some(Rejection::InvalidBearer)
    );
    let s = at(&mut st, c.nbf - 10);
    assert!(authenticate(&s, &h).await.is_ok());
    let s = at(&mut st, c.exp + 60);
    assert_eq!(
        authenticate(&s, &h).await.err(),
        Some(Rejection::InvalidBearer)
    );
}

#[tokio::test]
async fn inner_whitespace_after_the_scheme_is_skipped_and_a_bad_token_is_invalid() {
    let (_db, st) = state().await;
    // Fetch Headers trims only the ends, so the inner run is the token.
    let mut h = HeaderMap::new();
    h.insert(header::AUTHORIZATION, "Bearer \t x".parse().unwrap());
    assert_eq!(
        authenticate(&st, &h).await.err(),
        Some(Rejection::InvalidBearer)
    );
}

#[tokio::test]
async fn without_a_device_secret_every_bearer_is_invalid() {
    let (_db, mut st) = state().await;
    let (token, _) = device(&st, OWNER, AuthMode::Workos, "TV").await;
    st.device_keys = None;
    assert_eq!(
        authenticate(&st, &with_bearer(&token)).await.err(),
        Some(Rejection::InvalidBearer)
    );
}

#[tokio::test]
async fn api_me_over_a_bearer_reports_the_device_name() {
    let (_db, st) = state().await;
    let (token, _) = device(&st, OWNER, AuthMode::Workos, "Living Room Apple TV").await;
    let auth = format!("Bearer {token}");
    let (status, body, _) = send(&app(st), "/api/me", &[("Authorization", &auth)]).await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({ "user": { "sub": OWNER, "username": "Living Room Apple TV",
                          "role": "admin", "auth_mode": "workos" } })
    );
}

#[tokio::test]
async fn a_plex_cookie_keeps_its_token_through_reconcile_but_api_me_never_shows_it() {
    let (db, st) = state().await;
    const PLEX: &str = "plex:12345";
    add_member(&db, PLEX, "user", "plex").await;
    let session = Session {
        plex_auth_token: Some("plex-token-secret".into()),
        ..cookie_session(PLEX, AuthMode::Plex, Role::User)
    };
    let s = reconcile_cookie(&db, subs(&st), session.clone())
        .await
        .unwrap();
    assert_eq!(
        s.unwrap().plex_auth_token.as_deref(),
        Some("plex-token-secret")
    );

    let cookie = format!(
        "eex.session={}",
        session::mint(&st.session_key, &session, chrono::Utc::now().timestamp())
    );
    let (status, body, _) = send(&app(st), "/api/me", &[("Cookie", &cookie)]).await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({ "user": { "sub": PLEX, "username": "Owner", "role": "user", "auth_mode": "plex" } })
    );
    assert!(!body.to_string().contains("plex-token-secret"));
}
