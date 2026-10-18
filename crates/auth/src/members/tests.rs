//! Carried over from membership.test.ts, members.test.ts and the store half of
//! routes/account.test.ts (self-revocation).

use super::*;
use crate::testutil::{add_member, add_named_member, pool, set_revoked};

const ADMIN: &str = "plex:42";
const ALICE: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";
const BOB: &str = "plex:7";
const OWNER: &str = "apple:000000.0123456789abcdef0123456789abcdef.0000";

fn subs(s: &[&str]) -> Vec<String> {
    s.iter().map(|s| s.to_string()).collect()
}

async fn revoke_for_test(pool: &SqlitePool, sub: &str) {
    assert_eq!(
        revoke_safely(pool, &subs(&[ADMIN]), sub, ADMIN)
            .await
            .unwrap(),
        SafeRevocation::Revoked
    );
}

// ---- member_status (membership.test.ts) ----

#[tokio::test]
async fn malformed_sub_fails_closed_to_not_member() {
    let db = pool().await;
    for s in ["garbage", "not-a-sub", " plex:42", "plex:42\n"] {
        assert_eq!(
            member_status(&db, &subs(&[ADMIN]), s).await.unwrap(),
            MemberStatus::NotMember
        );
    }
}

#[tokio::test]
async fn admin_subs_sub_is_allowed_before_any_members_row_exists() {
    let db = pool().await;
    let admins = subs(&[ADMIN]);
    assert_eq!(
        member_status(&db, &admins, ADMIN).await.unwrap(),
        MemberStatus::Allowed
    );
    assert_eq!(
        member_status(&db, &admins, BOB).await.unwrap(),
        MemberStatus::NotMember
    );
}

#[tokio::test]
async fn active_row_is_allowed_and_revoked_row_is_revoked_not_not_member() {
    let db = pool().await;
    let admins = subs(&[ADMIN]);
    add_member(&db, ALICE, "user", "apple").await;
    assert_eq!(
        member_status(&db, &admins, ALICE).await.unwrap(),
        MemberStatus::Allowed
    );
    revoke_for_test(&db, ALICE).await;
    assert_eq!(
        member_status(&db, &admins, ALICE).await.unwrap(),
        MemberStatus::Revoked
    );
}

#[tokio::test]
async fn fresh_install_denies_an_unknown_valid_sub() {
    let db = pool().await;
    assert_eq!(
        member_status(&db, &[], BOB).await.unwrap(),
        MemberStatus::NotMember
    );
}

#[tokio::test]
async fn an_active_row_allows_only_that_member() {
    let db = pool().await;
    add_member(&db, ALICE, "user", "apple").await;
    assert_eq!(
        member_status(&db, &[], BOB).await.unwrap(),
        MemberStatus::NotMember
    );
    assert_eq!(
        member_status(&db, &[], ALICE).await.unwrap(),
        MemberStatus::Allowed
    );
}

// ---- is_member / list / effective_role (members.test.ts) ----

#[tokio::test]
async fn is_member_returns_the_active_row_and_none_otherwise() {
    let db = pool().await;
    assert_eq!(is_member(&db, BOB).await.unwrap(), None);
    assert_eq!(is_member(&db, "garbage").await.unwrap(), None);
    add_named_member(&db, ALICE, Some("Alice"), "user", "apple").await;
    let m = is_member(&db, ALICE).await.unwrap().unwrap();
    assert_eq!(m.display_name.as_deref(), Some("Alice"));
    assert_eq!(m.role, Role::User);
    assert_eq!(m.auth_mode, "apple");
    assert_eq!(m.revoked_at, None);
    revoke_for_test(&db, ALICE).await;
    assert_eq!(is_member(&db, ALICE).await.unwrap(), None);
}

#[tokio::test]
async fn list_returns_active_and_revoked_rows_newest_first() {
    let db = pool().await;
    add_member(&db, BOB, "user", "plex").await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    add_member(&db, ALICE, "user", "apple").await;
    revoke_for_test(&db, BOB).await;
    let all = list(&db).await.unwrap();
    assert_eq!(
        all.iter().map(|m| m.sub.as_str()).collect::<Vec<_>>(),
        [ALICE, BOB]
    );
    assert!(all[1].revoked_at.is_some());
}

#[tokio::test]
async fn effective_role_is_admin_subs_or_an_active_admin_row() {
    let db = pool().await;
    let admins = subs(&[ADMIN]);
    let local = "local:01ARZ3NDEKTSV4RRFFQ69G5FAV";
    assert_eq!(
        effective_role(&db, &admins, ADMIN).await.unwrap(),
        Role::Admin
    );
    assert_eq!(effective_role(&db, &admins, BOB).await.unwrap(), Role::User);

    add_member(&db, local, "admin", "local").await;
    assert_eq!(
        effective_role(&db, &admins, local).await.unwrap(),
        Role::Admin
    );
    sqlx::query("UPDATE members SET role = 'user' WHERE sub = ?")
        .bind(local)
        .execute(&*db)
        .await
        .unwrap();
    assert_eq!(
        effective_role(&db, &admins, local).await.unwrap(),
        Role::User
    );

    // A revoked admin row grants nothing.
    add_member(&db, ALICE, "admin", "apple").await;
    set_revoked(&db, ALICE).await;
    assert_eq!(
        effective_role(&db, &admins, ALICE).await.unwrap(),
        Role::User
    );
}

// ---- revoke_safely ----

async fn row(pool: &SqlitePool, sub: &str) -> Option<Member> {
    sqlx::query_as(
        "SELECT sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at \
         FROM members WHERE sub = ?",
    )
    .bind(sub)
    .fetch_optional(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn protects_an_immutable_configured_owner_before_touching_its_row() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    let before = row(&db, ADMIN).await;
    assert_eq!(
        revoke_safely(&db, &subs(&[ADMIN]), ADMIN, BOB)
            .await
            .unwrap(),
        SafeRevocation::Owner
    );
    assert_eq!(row(&db, ADMIN).await, before);
}

#[tokio::test]
async fn protects_a_db_backed_administrator_from_self_revocation() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    assert_eq!(
        revoke_safely(&db, &[], ADMIN, ADMIN).await.unwrap(),
        SafeRevocation::OwnSub
    );
    assert_eq!(
        is_member(&db, ADMIN).await.unwrap().unwrap().role,
        Role::Admin
    );
}

#[tokio::test]
async fn revalidates_a_pre_authorized_actor_before_touching_the_final_administrator() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    assert_eq!(
        revoke_safely(&db, &[], ADMIN, BOB).await.unwrap(),
        SafeRevocation::ActorNotAdmin
    );
    assert_eq!(
        is_member(&db, ADMIN).await.unwrap().unwrap().role,
        Role::Admin
    );
}

#[tokio::test]
async fn revalidates_a_second_pre_authorized_actor_after_the_first_revocation_commits() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    add_member(&db, BOB, "admin", "plex").await;
    assert_eq!(
        revoke_safely(&db, &[], ADMIN, BOB).await.unwrap(),
        SafeRevocation::Revoked
    );
    assert_eq!(
        revoke_safely(&db, &[], BOB, ADMIN).await.unwrap(),
        SafeRevocation::ActorNotAdmin
    );
    assert_eq!(is_member(&db, ADMIN).await.unwrap(), None);
    assert_eq!(
        is_member(&db, BOB).await.unwrap().unwrap().role,
        Role::Admin
    );
}

#[tokio::test]
async fn concurrent_mutual_revocations_leave_one_administrator() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    add_member(&db, BOB, "admin", "plex").await;
    let (a, b) = tokio::join!(
        revoke_safely(&db, &[], ADMIN, BOB),
        revoke_safely(&db, &[], BOB, ADMIN)
    );
    let mut got = [a.unwrap(), b.unwrap()];
    got.sort_by_key(|r| *r == SafeRevocation::Revoked);
    assert_eq!(
        got,
        [SafeRevocation::ActorNotAdmin, SafeRevocation::Revoked]
    );
    let active = list(&db)
        .await
        .unwrap()
        .iter()
        .filter(|m| m.revoked_at.is_none())
        .count();
    assert_eq!(active, 1);
}

#[tokio::test]
async fn revocation_waits_for_the_write_lock_and_rereads_the_actor() {
    // Another writer demotes the actor and holds the lock: the revocation must
    // wait for it and see the demotion (a deferred BEGIN would read the stale
    // snapshot, then fail its write with SQLITE_BUSY).
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    add_member(&db, BOB, "admin", "plex").await;
    let mut hold = db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("UPDATE members SET role = 'user' WHERE sub = ?")
        .bind(BOB)
        .execute(&mut *hold)
        .await
        .unwrap();
    let p = (*db).clone();
    let task = tokio::spawn(async move { revoke_safely(&p, &[], ADMIN, BOB).await });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    hold.commit().await.unwrap();
    assert_eq!(task.await.unwrap().unwrap(), SafeRevocation::ActorNotAdmin);
    assert!(is_member(&db, ADMIN).await.unwrap().is_some());
}

#[tokio::test]
async fn ordinary_members_cannot_revoke_each_other() {
    // TS: mutually pre-authorized legacy Plex admins (ADMINS usernames). ADMINS
    // is gone, so a role-user row is never an authority.
    let db = pool().await;
    add_named_member(&db, ADMIN, Some("legacy-a"), "user", "plex").await;
    add_named_member(&db, ALICE, Some("legacy-b"), "user", "apple").await;
    assert_eq!(
        revoke_safely(&db, &[], ALICE, ADMIN).await.unwrap(),
        SafeRevocation::ActorNotAdmin
    );
    assert!(is_member(&db, ALICE).await.unwrap().is_some());
}

#[tokio::test]
async fn does_not_count_malformed_database_rows_as_usable_admin_authorities() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    add_member(&db, "garbage", "admin", "plex").await;
    assert_eq!(
        revoke_safely(&db, &[], ADMIN, BOB).await.unwrap(),
        SafeRevocation::ActorNotAdmin
    );
    // Nor may the malformed row act, though it reads role admin.
    assert_eq!(
        revoke_safely(&db, &[], ADMIN, "garbage").await.unwrap(),
        SafeRevocation::ActorNotAdmin
    );
    assert_eq!(
        is_member(&db, ADMIN).await.unwrap().unwrap().role,
        Role::Admin
    );
    assert_eq!(is_member(&db, "garbage").await.unwrap(), None);
}

#[tokio::test]
async fn revokes_an_ordinary_member_and_reports_absent_or_already_revoked_uniformly() {
    let db = pool().await;
    add_member(&db, BOB, "user", "plex").await;
    let admins = subs(&[ADMIN]);
    assert_eq!(
        revoke_safely(&db, &admins, BOB, ADMIN).await.unwrap(),
        SafeRevocation::Revoked
    );
    assert_eq!(
        revoke_safely(&db, &admins, BOB, ADMIN).await.unwrap(),
        SafeRevocation::NotFound
    );
    assert_eq!(
        revoke_safely(&db, &admins, "plex:999", ADMIN)
            .await
            .unwrap(),
        SafeRevocation::NotFound
    );
    assert_eq!(
        revoke_safely(&db, &admins, "garbage", ADMIN).await.unwrap(),
        SafeRevocation::NotFound
    );
}

async fn insert_invite(pool: &SqlitePool, hash: &str, issued_by: &str) {
    sqlx::query(
        "INSERT INTO invites (code_hash, issued_by, label, expires_at, max_uses, used_count, created_at, revoked_at) \
         VALUES (?, ?, 'cousin', NULL, 1, 0, datetime('now'), NULL)",
    )
    .bind(hash)
    .bind(issued_by)
    .execute(pool)
    .await
    .unwrap();
}

async fn invite_revoked(pool: &SqlitePool, hash: &str) -> bool {
    sqlx::query_scalar::<_, Option<String>>("SELECT revoked_at FROM invites WHERE code_hash = ?")
        .bind(hash)
        .fetch_one(pool)
        .await
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn revoking_a_member_revokes_their_invites_only() {
    let db = pool().await;
    add_member(&db, BOB, "admin", "plex").await;
    insert_invite(&db, "hash-bob", BOB).await;
    insert_invite(&db, "hash-admin", ADMIN).await;
    revoke_for_test(&db, BOB).await;
    assert!(invite_revoked(&db, "hash-bob").await);
    assert!(!invite_revoked(&db, "hash-admin").await);
}

// ---- revoke_self (routes/account.test.ts, store half) ----

#[tokio::test]
async fn self_revocation_revokes_the_member_and_their_invites() {
    let db = pool().await;
    add_member(&db, BOB, "user", "plex").await;
    insert_invite(&db, "hash-1", BOB).await;
    assert_eq!(
        revoke_self(&db, &[], BOB).await.unwrap(),
        SelfRevocation::Revoked
    );
    assert_eq!(is_member(&db, BOB).await.unwrap(), None);
    assert!(invite_revoked(&db, "hash-1").await);
    assert_eq!(
        revoke_self(&db, &[], BOB).await.unwrap(),
        SelfRevocation::AlreadyRevoked
    );
    assert_eq!(
        revoke_self(&db, &[], "garbage").await.unwrap(),
        SelfRevocation::AlreadyRevoked
    );
}

#[tokio::test]
async fn self_revocation_refuses_the_only_administrator_leaving_everything_intact() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    add_member(&db, BOB, "user", "plex").await;
    insert_invite(&db, "hash-1", ADMIN).await;
    assert_eq!(
        revoke_self(&db, &[], ADMIN).await.unwrap(),
        SelfRevocation::LastAdmin
    );
    assert!(is_member(&db, ADMIN).await.unwrap().is_some());
    assert!(!invite_revoked(&db, "hash-1").await);
}

#[tokio::test]
async fn self_revocation_lets_an_admin_go_when_another_active_admin_remains() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    add_member(&db, "plex:33333", "admin", "plex").await;
    assert_eq!(
        revoke_self(&db, &[], ADMIN).await.unwrap(),
        SelfRevocation::Revoked
    );
}

#[tokio::test]
async fn self_revocation_does_not_count_a_revoked_admin_as_remaining() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    add_member(&db, "plex:33333", "admin", "plex").await;
    set_revoked(&db, "plex:33333").await;
    assert_eq!(
        revoke_self(&db, &[], ADMIN).await.unwrap(),
        SelfRevocation::LastAdmin
    );
}

#[tokio::test]
async fn self_revocation_counts_an_admin_subs_owner_who_has_never_signed_in() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    assert_eq!(
        revoke_self(&db, &subs(&[OWNER]), ADMIN).await.unwrap(),
        SelfRevocation::Revoked
    );
}

#[tokio::test]
async fn self_revocation_refuses_an_admin_subs_owner_outright() {
    let db = pool().await;
    add_member(&db, ADMIN, "admin", "plex").await;
    add_member(&db, "plex:33333", "admin", "plex").await;
    assert_eq!(
        revoke_self(&db, &subs(&[ADMIN]), ADMIN).await.unwrap(),
        SelfRevocation::LastAdmin
    );
    assert!(is_member(&db, ADMIN).await.unwrap().is_some());
}
