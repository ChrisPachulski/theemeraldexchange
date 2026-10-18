//! parentalRating.test.ts, against a media.db file and a fake Radarr/Sonarr.

use std::sync::Arc;

use serde_json::json;
use sqlx::ConnectOptions;
use sqlx::sqlite::SqliteConnectOptions;

use super::*;
use crate::proxy::fake::{Fake, Route};
use crate::stores::Policy;
use crate::testutil::{ADMIN, ALICE, state_in};

#[test]
fn no_cap_allows_everything_including_unrated() {
    assert!(rating_allowed(Some("NC-17"), None));
    assert!(rating_allowed(None, None));
}

#[test]
fn unrated_and_unknown_fail_closed_under_any_cap() {
    assert!(!rating_allowed(None, Some("R")));
    assert!(!rating_allowed(Some(""), Some("NC-17")));
    assert!(!rating_allowed(Some("Unrated"), Some("NC-17")));
    assert!(
        rating_allowed(Some("R"), Some("X-not-a-cap")),
        "an unenforceable cap allows"
    );
}

#[test]
fn caps_compare_on_one_scale_across_ladders() {
    assert!(rating_allowed(Some("TV-PG"), Some("PG")));
    assert!(rating_allowed(Some("PG"), Some("TV-14")));
    assert!(!rating_allowed(Some("TV-MA"), Some("PG-13")));
    assert!(rating_allowed(Some("TV-Y"), Some("G")));
    assert!(!rating_allowed(Some("PG-13"), Some("PG")));
    assert!(rating_allowed(Some("R"), Some("TV-MA")));
}

#[test]
fn certification_is_case_and_whitespace_insensitive() {
    assert!(rating_allowed(Some("  pg-13 "), Some("PG-13")));
    assert!(rating_allowed(Some("tv-y7"), Some("pg")));
}

#[test]
fn a_kid_profile_without_a_cap_is_held_to_pg() {
    let kid = Policy {
        kid: true,
        ..Policy::default()
    };
    assert_eq!(effective_cap(&kid), Some("PG"));
    let capped = Policy {
        kid: true,
        max_content_rating: Some("PG-13".into()),
        ..Policy::default()
    };
    assert_eq!(effective_cap(&capped), Some("PG-13"));
    assert_eq!(effective_cap(&Policy::default()), None);
}

struct Env {
    st: AppState,
    fake: Fake,
    _dir: tempfile::TempDir,
}

async fn env(radarr_ok: bool) -> Env {
    let fake = Fake::start("gateway-test-internal-secret-0123456789ab").await;
    let radarr = if radarr_ok {
        Route::json(
            "GET",
            "/radarr/api/v3/movie",
            200,
            json!([{ "tmdbId": 550, "certification": "R" }, { "tmdbId": 551, "certification": "PG" }, { "tmdbId": 552 }]),
        )
    } else {
        Route::json("GET", "/radarr/api/v3/movie", 500, json!({}))
    };
    fake.set_routes(vec![
        radarr,
        Route::json(
            "GET",
            "/sonarr/api/v3/series",
            200,
            json!([{ "tvdbId": 1, "certification": "TV-Y" }]),
        ),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let media = dir.path().join("media.db");
    let mut c = SqliteConnectOptions::new()
        .filename(&media)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    for sql in [
        "CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER)",
        "CREATE TABLE shows (id INTEGER PRIMARY KEY, tvdb_id INTEGER)",
        "CREATE TABLE episodes (id INTEGER PRIMARY KEY, show_id INTEGER)",
        "INSERT INTO movies VALUES (1, 550), (2, 551), (3, 552), (4, NULL)",
        "INSERT INTO shows VALUES (10, 1)",
        "INSERT INTO episodes VALUES (100, 10)",
    ] {
        sqlx::query(sql).execute(&mut c).await.unwrap();
    }
    let (r, s, m, p) = (
        format!("{}/radarr", fake.url),
        format!("{}/sonarr", fake.url),
        media.to_str().unwrap().to_string(),
        dir.path()
            .join("policies.json")
            .to_str()
            .unwrap()
            .to_string(),
    );
    let st = state_in(
        &dir,
        &[
            ("RADARR_URL", &r),
            ("RADARR_API_KEY", "placeholder-radarr-key"),
            ("SONARR_URL", &s),
            ("SONARR_API_KEY", "placeholder-sonarr-key"),
            ("MEDIA_DB_PATH", &m),
            ("USER_POLICIES_PATH", &p),
        ],
    )
    .await;
    Env {
        st,
        fake,
        _dir: dir,
    }
}

fn session(sub: &str, role: auth::Role) -> auth::session::Session {
    auth::session::Session {
        sub: sub.into(),
        username: String::new(),
        role,
        auth_mode: auth::AuthMode::parse(sub.split(':').next().unwrap()).unwrap(),
    }
}

async fn cap(st: &AppState, sub: &str, policy: Policy) {
    st.stores.policies.set(sub, policy).await.unwrap();
}

fn pg13() -> Policy {
    Policy {
        max_content_rating: Some("PG-13".into()),
        ..Policy::default()
    }
}

#[tokio::test]
async fn never_blocks_admins() {
    let e = env(true).await;
    cap(&e.st, ADMIN, pg13()).await;
    let admin = session(ADMIN, auth::Role::Admin);
    assert!(
        !rating_blocked(&e.st, &admin, Title::Movie, 1.0)
            .await
            .unwrap()
    );
    assert!(
        !rating_blocked(&e.st, &admin, Title::Video, 1.0)
            .await
            .unwrap()
    );
    assert!(e.fake.settle().await.is_empty(), "no lookup for an admin");
}

#[tokio::test]
async fn an_uncapped_user_costs_no_lookup() {
    let e = env(true).await;
    let alice = session(ALICE, auth::Role::User);
    assert!(
        !rating_blocked(&e.st, &alice, Title::Movie, 1.0)
            .await
            .unwrap()
    );
    assert!(e.fake.settle().await.is_empty());
}

#[tokio::test]
async fn blocks_above_the_cap_and_allows_at_or_below_it() {
    let e = env(true).await;
    cap(&e.st, ALICE, pg13()).await;
    let alice = session(ALICE, auth::Role::User);
    assert!(
        rating_blocked(&e.st, &alice, Title::Movie, 1.0)
            .await
            .unwrap(),
        "R"
    );
    assert!(
        !rating_blocked(&e.st, &alice, Title::Movie, 2.0)
            .await
            .unwrap(),
        "PG"
    );
    assert!(
        !rating_blocked(&e.st, &alice, Title::Episode, 100.0)
            .await
            .unwrap(),
        "TV-Y"
    );
    // One list fetch per service: the warm path costs no upstream call.
    let calls = e.fake.settle().await;
    let paths: Vec<&str> = calls.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, ["/radarr/api/v3/movie", "/sonarr/api/v3/series"]);
}

#[tokio::test]
async fn an_unresolvable_certification_blocks() {
    let e = env(true).await;
    cap(&e.st, ALICE, pg13()).await;
    let alice = session(ALICE, auth::Role::User);
    for id in [3.0, 4.0, 99.0, f64::NAN] {
        assert!(
            rating_blocked(&e.st, &alice, Title::Movie, id)
                .await
                .unwrap(),
            "{id}"
        );
    }
}

#[tokio::test]
async fn a_failed_resolution_blocks() {
    let e = env(false).await;
    cap(&e.st, ALICE, pg13()).await;
    let alice = session(ALICE, auth::Role::User);
    assert!(
        rating_blocked(&e.st, &alice, Title::Movie, 2.0)
            .await
            .unwrap(),
        "radarr down"
    );
    let mut gone = (*e.st.config).clone();
    gone.media_db_path = "/nonexistent/eex/media.db".into();
    let st = AppState {
        config: Arc::new(gone),
        ..e.st.clone()
    };
    assert!(
        rating_blocked(&st, &alice, Title::Episode, 100.0)
            .await
            .unwrap(),
        "no media.db"
    );
}

#[tokio::test]
async fn music_is_exempt_and_youtube_is_an_unrated_catalog() {
    let e = env(true).await;
    let alice = session(ALICE, auth::Role::User);
    cap(
        &e.st,
        ALICE,
        Policy {
            kid: true,
            ..Policy::default()
        },
    )
    .await;
    assert!(
        !rating_blocked(&e.st, &alice, Title::Track, 1.0)
            .await
            .unwrap()
    );
    assert!(
        rating_blocked(&e.st, &alice, Title::Video, 1.0)
            .await
            .unwrap()
    );
    assert!(
        rating_blocked(&e.st, &alice, Title::Movie, 1.0)
            .await
            .unwrap(),
        "kid: R above PG"
    );
    assert!(
        !rating_blocked(&e.st, &alice, Title::Movie, 2.0)
            .await
            .unwrap(),
        "kid: PG"
    );
    cap(&e.st, ALICE, Policy::default()).await;
    assert!(
        !rating_blocked(&e.st, &alice, Title::Video, 1.0)
            .await
            .unwrap(),
        "no cap"
    );
}

#[tokio::test]
async fn cap_blocks_unrated_for_any_cap_never_for_admins() {
    let e = env(true).await;
    let policies = &e.st.stores.policies;
    let alice = session(ALICE, auth::Role::User);
    assert!(!policies.cap_blocks_unrated(&alice).await.unwrap());
    cap(&e.st, ALICE, pg13()).await;
    assert!(policies.cap_blocks_unrated(&alice).await.unwrap());
    cap(
        &e.st,
        ALICE,
        Policy {
            kid: true,
            ..Policy::default()
        },
    )
    .await;
    assert!(policies.cap_blocks_unrated(&alice).await.unwrap());
    cap(&e.st, ADMIN, pg13()).await;
    assert!(
        !policies
            .cap_blocks_unrated(&session(ADMIN, auth::Role::Admin))
            .await
            .unwrap()
    );
}
