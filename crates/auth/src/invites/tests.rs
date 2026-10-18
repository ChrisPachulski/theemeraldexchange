//! Carried over from invites.test.ts (plus membership.test.ts's redeem case).

use super::*;
use crate::members::{MemberStatus, SafeRevocation, is_member, member_status, revoke_safely};
use crate::testutil::{add_member, pool, set_revoked};

const ADMIN: &str = "plex:42";
const ALICE: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";
const BOB: &str = "workos:user_01E4ZCR3C56J083X43JQXF3JK5";
const CARL: &str = "google:104223294318414512345";
const GABRIEL: &str = "google:118234567890123456789";

async fn issue_default(pool: &SqlitePool) -> Issued {
    issue(pool, ADMIN, IssueOptions::default()).await.unwrap()
}

async fn issue_with(pool: &SqlitePool, f: impl FnOnce(&mut IssueOptions)) -> Issued {
    let mut o = IssueOptions::default();
    f(&mut o);
    issue(pool, ADMIN, o).await.unwrap()
}

async fn used_count(pool: &SqlitePool, prefix: &str) -> i64 {
    sqlx::query_scalar("SELECT used_count FROM invites WHERE code_hash LIKE ? || '%'")
        .bind(prefix)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn invited_by(pool: &SqlitePool, sub: &str) -> Option<String> {
    sqlx::query_scalar("SELECT invited_by FROM members WHERE sub = ?")
        .bind(sub)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn issue_returns_a_128_bit_code_once_and_stores_only_the_hash() {
    let db = pool().await;
    let res = issue_with(&db, |o| o.label = Some("Mom's iPad".into())).await;
    assert_eq!(res.code.len(), 22);
    assert!(
        res.code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
    assert_eq!(res.code_hash_prefix.len(), 8);
    assert_eq!(res.label.as_deref(), Some("Mom's iPad"));
    assert_eq!(res.max_uses, 1);
    assert!(res.expires_at.is_some());

    let stored: String = sqlx::query_scalar("SELECT code_hash FROM invites")
        .fetch_one(&*db)
        .await
        .unwrap();
    assert!(!stored.contains(&res.code));
    assert_eq!(stored.len(), 64);
    assert!(stored.starts_with(&res.code_hash_prefix));
    assert_eq!(stored, hash_code(&res.code));
}

#[tokio::test]
async fn issue_defaults_to_a_14_day_expiry_and_clamps_max_uses() {
    let db = pool().await;
    let res = issue_with(&db, |o| o.max_uses = 0).await;
    assert_eq!(res.max_uses, 1);
    let exp = chrono::DateTime::parse_from_rfc3339(res.expires_at.as_deref().unwrap()).unwrap();
    let days = (exp.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_hours() as f64 / 24.0;
    assert!((13.9..=14.0).contains(&days), "{days}");
    let never = issue_with(&db, |o| o.expires_in_days = None).await;
    assert_eq!(never.expires_at, None);
}

#[tokio::test]
async fn issue_generates_distinct_codes_each_call() {
    let db = pool().await;
    assert_ne!(issue_default(&db).await.code, issue_default(&db).await.code);
}

#[tokio::test]
async fn issue_fails_closed_on_a_malformed_admin_sub() {
    let db = pool().await;
    assert!(matches!(
        issue(&db, "garbage", IssueOptions::default()).await,
        Err(Error::InvalidSub)
    ));
}

#[tokio::test]
async fn redeem_of_a_valid_code_creates_a_member_attributed_to_the_issuer() {
    let db = pool().await;
    let code = issue_default(&db).await.code;
    assert_eq!(
        redeem(&db, &code, ALICE, Some("Alice"), AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Created
    );
    let m = is_member(&db, ALICE).await.unwrap().unwrap();
    assert_eq!(m.display_name.as_deref(), Some("Alice"));
    assert_eq!(m.auth_mode, "apple");
    assert_eq!(m.role, Role::User);
    assert_eq!(invited_by(&db, ALICE).await.as_deref(), Some(ADMIN));
    // The freshly minted member reads as allowed.
    assert_eq!(
        member_status(&db, &[ADMIN.to_string()], ALICE)
            .await
            .unwrap(),
        MemberStatus::Allowed
    );
}

#[tokio::test]
async fn an_owner_invite_makes_the_redeemer_an_admin_and_the_default_stays_user() {
    let db = pool().await;
    let owner = issue_with(&db, |o| {
        o.role = Role::Admin;
        o.label = Some("reviewer".into());
    })
    .await;
    assert_eq!(owner.role, Role::Admin);
    assert_eq!(
        redeem(&db, &owner.code, ALICE, Some("Alice"), AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Created
    );
    assert_eq!(
        is_member(&db, ALICE).await.unwrap().unwrap().role,
        Role::Admin
    );

    let plain = issue_default(&db).await;
    assert_eq!(plain.role, Role::User);
    let all = list(&db).await.unwrap();
    let role_of = |p: &str| all.iter().find(|i| i.code_hash_prefix == p).unwrap().role;
    assert_eq!(role_of(&owner.code_hash_prefix), Role::Admin);
    assert_eq!(role_of(&plain.code_hash_prefix), Role::User);
}

#[tokio::test]
async fn re_granting_a_revoked_member_through_an_owner_invite_restores_them_as_admin() {
    let db = pool().await;
    let code = issue_default(&db).await.code;
    redeem(&db, &code, ALICE, Some("Alice"), AuthMode::Apple)
        .await
        .unwrap();
    set_revoked(&db, ALICE).await;
    let owner = issue_with(&db, |o| o.role = Role::Admin).await;
    assert_eq!(
        redeem(&db, &owner.code, ALICE, Some("Alice"), AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Created
    );
    assert_eq!(
        is_member(&db, ALICE).await.unwrap().unwrap().role,
        Role::Admin
    );
}

#[tokio::test]
async fn redeems_for_a_google_identity_with_role_and_issuer_intact() {
    let db = pool().await;
    let code = issue_default(&db).await.code;
    assert_eq!(
        redeem(&db, &code, GABRIEL, Some("Gabriel"), AuthMode::Google)
            .await
            .unwrap(),
        Redeem::Created
    );
    let m = is_member(&db, GABRIEL).await.unwrap().unwrap();
    assert_eq!(
        (m.display_name.as_deref(), m.role, m.auth_mode.as_str()),
        (Some("Gabriel"), Role::User, "google")
    );
    assert_eq!(invited_by(&db, GABRIEL).await.as_deref(), Some(ADMIN));
}

#[tokio::test]
async fn redeem_of_an_unknown_code_is_invalid_and_creates_no_member() {
    let db = pool().await;
    assert_eq!(
        redeem(&db, "totally-bogus-code", BOB, None, AuthMode::Workos)
            .await
            .unwrap(),
        Redeem::Invalid
    );
    assert_eq!(is_member(&db, BOB).await.unwrap(), None);
}

#[tokio::test]
async fn single_use_code_is_exhausted_on_the_second_distinct_redeemer() {
    let db = pool().await;
    let inv = issue_default(&db).await;
    assert_eq!(
        redeem(&db, &inv.code, ALICE, None, AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Created
    );
    assert_eq!(
        redeem(&db, &inv.code, BOB, None, AuthMode::Workos)
            .await
            .unwrap(),
        Redeem::Exhausted
    );
    assert_eq!(is_member(&db, BOB).await.unwrap(), None);
    assert_eq!(used_count(&db, &inv.code_hash_prefix).await, 1);
}

#[tokio::test]
async fn re_presenting_a_code_as_an_active_member_is_idempotent_and_burns_no_use() {
    let db = pool().await;
    let inv = issue_default(&db).await;
    assert_eq!(
        redeem(&db, &inv.code, ALICE, None, AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Created
    );
    assert_eq!(
        redeem(&db, &inv.code, ALICE, None, AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::AlreadyMember
    );
    assert_eq!(used_count(&db, &inv.code_hash_prefix).await, 1);
}

#[tokio::test]
async fn multi_use_code_admits_up_to_max_uses_distinct_members() {
    let db = pool().await;
    let inv = issue_with(&db, |o| o.max_uses = 2).await;
    assert_eq!(
        redeem(&db, &inv.code, ALICE, None, AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Created
    );
    assert_eq!(
        redeem(&db, &inv.code, BOB, None, AuthMode::Workos)
            .await
            .unwrap(),
        Redeem::Created
    );
    assert_eq!(
        redeem(&db, &inv.code, CARL, None, AuthMode::Google)
            .await
            .unwrap(),
        Redeem::Exhausted
    );
    assert_eq!(used_count(&db, &inv.code_hash_prefix).await, 2);
    assert!(is_member(&db, ALICE).await.unwrap().is_some());
    assert!(is_member(&db, BOB).await.unwrap().is_some());
    assert_eq!(is_member(&db, CARL).await.unwrap(), None);
}

#[tokio::test]
async fn expired_code_is_rejected_and_creates_no_member() {
    let db = pool().await;
    let code = issue_with(&db, |o| o.expires_in_days = Some(-1.0))
        .await
        .code;
    assert_eq!(
        redeem(&db, &code, ALICE, None, AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Expired
    );
    assert_eq!(is_member(&db, ALICE).await.unwrap(), None);
}

#[tokio::test]
async fn revoked_invite_is_rejected() {
    let db = pool().await;
    let inv = issue_default(&db).await;
    assert!(revoke(&db, &inv.code_hash_prefix).await.unwrap());
    assert_eq!(
        redeem(&db, &inv.code, ALICE, None, AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Revoked
    );
    assert_eq!(is_member(&db, ALICE).await.unwrap(), None);
}

#[tokio::test]
async fn redeem_re_grants_a_previously_revoked_member() {
    let db = pool().await;
    let first = issue_default(&db).await;
    redeem(&db, &first.code, ALICE, Some("Alice"), AuthMode::Apple)
        .await
        .unwrap();
    set_revoked(&db, ALICE).await;
    assert_eq!(is_member(&db, ALICE).await.unwrap(), None);

    let second = issue_default(&db).await;
    assert_eq!(
        redeem(&db, &second.code, ALICE, Some("Alice"), AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Created
    );
    assert!(is_member(&db, ALICE).await.unwrap().is_some());
    assert_eq!(used_count(&db, &second.code_hash_prefix).await, 1);
}

#[tokio::test]
async fn redeem_rejects_a_malformed_sub_before_any_db_write() {
    let db = pool().await;
    let inv = issue_default(&db).await;
    assert_eq!(
        redeem(&db, &inv.code, "not-a-sub", None, AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Invalid
    );
    assert_eq!(used_count(&db, &inv.code_hash_prefix).await, 0);
}

#[tokio::test]
async fn a_lost_last_use_race_rolls_the_member_write_back() {
    let db = pool().await;
    let inv = issue_default(&db).await;
    // Another redeem spends the last use between the cap check and the burn.
    sqlx::raw_sql(
        "CREATE TRIGGER steal AFTER INSERT ON members BEGIN UPDATE invites SET used_count = max_uses; END;",
    )
    .execute(&*db)
    .await
    .unwrap();
    assert_eq!(
        redeem(&db, &inv.code, ALICE, None, AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Exhausted
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM members")
        .fetch_one(&*db)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    assert_eq!(used_count(&db, &inv.code_hash_prefix).await, 0);
}

#[tokio::test]
async fn concurrent_redeems_of_a_single_use_code_yield_exactly_one_member() {
    let db = pool().await;
    let inv = issue_default(&db).await;
    let (a, b) = tokio::join!(
        redeem(&db, &inv.code, ALICE, None, AuthMode::Apple),
        redeem(&db, &inv.code, BOB, None, AuthMode::Workos)
    );
    let created = [a.unwrap(), b.unwrap()]
        .iter()
        .filter(|r| **r == Redeem::Created)
        .count();
    assert_eq!(created, 1);
    assert_eq!(used_count(&db, &inv.code_hash_prefix).await, 1);
}

#[tokio::test]
async fn list_never_leaks_the_code_or_full_hash_and_derives_status() {
    let db = pool().await;
    let active = issue_with(&db, |o| o.label = Some("active".into())).await;
    issue_with(&db, |o| {
        o.label = Some("expired".into());
        o.expires_in_days = Some(-1.0);
    })
    .await;
    let revoked = issue_with(&db, |o| o.label = Some("revoked".into())).await;
    revoke(&db, &revoked.code_hash_prefix).await.unwrap();
    let exhausted = issue_with(&db, |o| o.label = Some("exhausted".into())).await;
    redeem(&db, &exhausted.code, ALICE, None, AuthMode::Apple)
        .await
        .unwrap();

    let all = list(&db).await.unwrap();
    let status_of = |l: &str| {
        all.iter()
            .find(|i| i.label.as_deref() == Some(l))
            .unwrap()
            .status
    };
    assert_eq!(status_of("active"), Status::Active);
    assert_eq!(status_of("expired"), Status::Expired);
    assert_eq!(status_of("revoked"), Status::Revoked);
    assert_eq!(status_of("exhausted"), Status::Exhausted);

    let json = serde_json::to_value(&all).unwrap();
    for i in json.as_array().unwrap() {
        assert_eq!(i["code_hash_prefix"].as_str().unwrap().len(), 8);
        assert!(i.get("code").is_none() && i.get("code_hash").is_none());
    }
    assert!(!json.to_string().contains(&active.code));
}

#[tokio::test]
async fn revoke_rejects_ambiguous_unknown_and_already_revoked_prefixes() {
    let db = pool().await;
    assert!(!revoke(&db, "deadbeef").await.unwrap());
    let inv = issue_default(&db).await;
    assert!(!revoke(&db, "").await.unwrap());
    assert!(!revoke(&db, "XYZ").await.unwrap());
    assert!(!revoke(&db, "%").await.unwrap());
    assert!(revoke(&db, &inv.code_hash_prefix).await.unwrap());
    assert!(!revoke(&db, &inv.code_hash_prefix).await.unwrap());

    // Two hashes sharing a prefix: the short prefix is ambiguous, the full one is not.
    for h in ["ab".repeat(32), format!("ab{}", "cd".repeat(31))] {
        sqlx::query(
            "INSERT INTO invites (code_hash, issued_by, max_uses, used_count, created_at) \
             VALUES (?, ?, 1, 0, datetime('now'))",
        )
        .bind(h)
        .bind(ADMIN)
        .execute(&*db)
        .await
        .unwrap();
    }
    assert!(!revoke(&db, "ab").await.unwrap());
    assert!(revoke(&db, &"ab".repeat(32)).await.unwrap());
}

const MALLORY: &str = "plex:666";

#[tokio::test]
async fn a_revoked_issuer_cannot_restore_their_own_access() {
    let db = pool().await;
    add_member(&db, MALLORY, "admin", "plex").await;
    let code = issue(
        &db,
        MALLORY,
        IssueOptions {
            role: Role::Admin,
            max_uses: 5,
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .code;
    assert_eq!(
        revoke_safely(&db, &[ADMIN.to_string()], MALLORY, ADMIN)
            .await
            .unwrap(),
        SafeRevocation::Revoked
    );
    assert_eq!(
        redeem(&db, &code, MALLORY, Some("Mallory"), AuthMode::Apple)
            .await
            .unwrap(),
        Redeem::Revoked
    );
    assert_eq!(is_member(&db, MALLORY).await.unwrap(), None);
}

#[tokio::test]
async fn a_revoked_issuers_invite_admits_no_one_whatever_revoked_them() {
    let db = pool().await;
    add_member(&db, MALLORY, "admin", "plex").await;
    let code = issue(&db, MALLORY, IssueOptions::default())
        .await
        .unwrap()
        .code;
    set_revoked(&db, MALLORY).await;
    assert_eq!(
        redeem(&db, &code, BOB, Some("Bob"), AuthMode::Workos)
            .await
            .unwrap(),
        Redeem::Revoked
    );
    assert_eq!(is_member(&db, BOB).await.unwrap(), None);
}
