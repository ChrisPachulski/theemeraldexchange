//! recommender/tests/test_scoring_path.py, the cases for the code ported so
//! far (retrieval, user context, baseline_cosine, mmr_diverse,
//! cold_start_trending, fused, ranker; the pure ranker/fused helper cases sit
//! beside their modules). item_knn is not ported; the optimizer and
//! featurize cases come with S7/S5.

use std::collections::HashSet;

use serde_json::Value;
use sqlx::SqlitePool;

use super::*;
use crate::config::Config;
use crate::context::{
    TitleRow, load_user_context, select_model_config_for_context, title_key_variants,
};
use crate::db::{EMBED_DIM, encode_vec_rowid, serialize_f32};
use crate::http::validate::{LibraryItem, Score};
use crate::retrieval::{VEC_KNN_MAX_K, bounded_exclusions, cold_start_pool};

const SUB: &str = "plex:494190801";

const LIB_A1: i64 = 101; // "Emerald Heist", action cluster, in library
const LIB_A2: i64 = 102; // action cluster, in library
const CAND_NEAR: i64 = 201; // action cluster: ranks high
const CAND_NEAR2: i64 = 202; // action cluster, slightly farther
const CAND_FAR: i64 = 301; // comedy cluster: ranks low
const VETOED: i64 = 401; // household_rejections; the closest match, never surfaces
const DISLIKED: i64 = 402;
const SHOWN: i64 = 403; // recently_shown
const FRANCHISE: i64 = 404; // "Emerald Heist: Part Two"
const LOW_VOTE: i64 = 405;
const UNRELEASED: i64 = 406;
const CAST_RARE: i64 = 601;
const CAST_COMMON: i64 = 602;
const RARE_PERSON: i64 = 9001;
const COMMON_PERSON: i64 = 9002;

fn axis_vec(weights: &[(usize, f32)]) -> Vec<f32> {
    let mut v = vec![0f32; EMBED_DIM];
    for &(i, w) in weights {
        v[i] = w;
    }
    crate::context::normalize(v)
}

#[derive(Clone, Copy)]
struct T {
    popularity: f64,
    vote_count: i64,
    genres: &'static [i64],
    release_date: &'static str,
    status: &'static str,
    cast: &'static [i64],
    crew: &'static [(i64, &'static str)],
}

const DEF: T = T {
    popularity: 10.0,
    vote_count: 500,
    genres: &[28],
    release_date: "2020-01-01",
    status: "Released",
    cast: &[],
    crew: &[],
};
const COMMON: T = T {
    cast: &[COMMON_PERSON],
    ..DEF
};

async fn add_title(pool: &SqlitePool, tmdb_id: i64, title: &str, vec: &[f32], t: T) {
    sqlx::query(
        "INSERT INTO titles(tmdb_id, kind, title, year, release_date, overview, poster_path,
                            vote_average, vote_count, popularity, status, adult, fetched_at)
         VALUES (?, 'movie', ?, 2020, ?, 'synthetic', NULL, 7.0, ?, ?, ?, 0, datetime('now'))",
    )
    .bind(tmdb_id)
    .bind(title)
    .bind(t.release_date)
    .bind(t.vote_count)
    .bind(t.popularity)
    .bind(t.status)
    .execute(pool)
    .await
    .unwrap();
    for g in t.genres {
        sqlx::query("INSERT INTO title_genres VALUES (?, 'movie', ?)")
            .bind(tmdb_id)
            .bind(g)
            .execute(pool)
            .await
            .unwrap();
    }
    for (order_idx, person) in t.cast.iter().enumerate() {
        sqlx::query("INSERT INTO title_cast VALUES (?, 'movie', ?, ?, ?)")
            .bind(tmdb_id)
            .bind(person)
            .bind(format!("person-{person}"))
            .bind(order_idx as i64)
            .execute(pool)
            .await
            .unwrap();
    }
    for (person, job) in t.crew {
        sqlx::query("INSERT INTO title_crew VALUES (?, 'movie', ?, ?, ?)")
            .bind(tmdb_id)
            .bind(person)
            .bind(format!("person-{person}"))
            .bind(job)
            .execute(pool)
            .await
            .unwrap();
    }
    let blob = serialize_f32(vec);
    sqlx::query("INSERT INTO title_features VALUES (?, 'movie', '{}', ?, ?, datetime('now'))")
        .bind(tmdb_id)
        .bind(&blob)
        .bind(EMBED_DIM as i64)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, 'movie', ?)")
        .bind(encode_vec_rowid("movie", tmdb_id).unwrap())
        .bind(&blob)
        .execute(pool)
        .await
        .unwrap();
}

struct Fx {
    _dir: tempfile::TempDir,
    pool: SqlitePool,
}

async fn fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("exchange.db"))
        .await
        .unwrap();
    let p = &pool;
    let action = axis_vec(&[(0, 1.0)]);
    let lib_a1 = T {
        cast: &[RARE_PERSON, COMMON_PERSON],
        crew: &[(7001, "Director")],
        ..DEF
    };
    add_title(p, LIB_A1, "Emerald Heist", &action, lib_a1).await;
    add_title(
        p,
        LIB_A2,
        "Steel Vengeance",
        &axis_vec(&[(0, 0.95), (2, 0.05)]),
        DEF,
    )
    .await;
    add_title(
        p,
        CAND_NEAR,
        "Crimson Strike",
        &axis_vec(&[(0, 0.95), (3, 0.05)]),
        COMMON,
    )
    .await;
    add_title(
        p,
        CAND_NEAR2,
        "Night Convoy",
        &axis_vec(&[(0, 0.85), (3, 0.15)]),
        COMMON,
    )
    .await;
    let comedy = T {
        genres: &[35],
        ..COMMON
    };
    add_title(
        p,
        CAND_FAR,
        "Giggle Factory",
        &axis_vec(&[(1, 1.0)]),
        comedy,
    )
    .await;
    add_title(p, VETOED, "Forbidden Sequel", &action, DEF).await;
    add_title(p, DISLIKED, "Hated One", &action, DEF).await;
    add_title(p, SHOWN, "Seen It", &action, COMMON).await;
    add_title(p, FRANCHISE, "Emerald Heist: Part Two", &action, DEF).await;
    let low = T {
        vote_count: 5,
        ..COMMON
    };
    add_title(p, LOW_VOTE, "Obscure Gem", &action, low).await;
    let future = T {
        release_date: "2030-01-01",
        status: "In Production",
        ..COMMON
    };
    add_title(p, UNRELEASED, "Coming Soon", &action, future).await;
    let pair = axis_vec(&[(0, 0.6), (4, 0.4)]);
    let rare = T {
        cast: &[RARE_PERSON],
        ..DEF
    };
    add_title(p, CAST_RARE, "Quiet Partner", &pair, rare).await;
    add_title(p, CAST_COMMON, "Familiar Face", &pair, COMMON).await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "INSERT INTO library_items(kind, tmdb_id, source, added_at) VALUES
           ('movie', {LIB_A1}, 'radarr', datetime('now')), ('movie', {LIB_A2}, 'radarr', datetime('now'));
         INSERT INTO household_rejections VALUES ('movie', {VETOED}, datetime('now'));
         INSERT INTO user_feedback VALUES ('{SUB}', 'movie', {DISLIKED}, 'dislike', datetime('now'));
         INSERT INTO recently_shown VALUES ('{SUB}', 'movie', {SHOWN}, datetime('now'));"
    )))
    .execute(p)
    .await
    .unwrap();
    Fx { _dir: dir, pool }
}

fn req() -> Score {
    Score {
        sub: SUB.into(),
        kind: "movie",
        n: 20,
        exclude_recently_shown: true,
        library: None,
        feedback: None,
        household_rejections: None,
    }
}

fn lib(items: &[(i64, &str)]) -> Option<Vec<LibraryItem>> {
    Some(
        items
            .iter()
            .map(|&(id, t)| LibraryItem {
                tmdb_id: Some(id),
                title: Some(t.into()),
            })
            .collect(),
    )
}

async fn ctx_with(pool: &SqlitePool, r: Score) -> UserContext {
    load_user_context(pool, &r, true).await.unwrap()
}

async fn ctx(pool: &SqlitePool) -> UserContext {
    ctx_with(pool, req()).await
}

fn cold(mut r: Score) -> Score {
    r.library = Some(vec![]);
    r.feedback = Some(vec![]);
    r.household_rejections = Some(vec![]);
    r
}

async fn retrieved(
    pool: &SqlitePool,
    c: &UserContext,
    pool_size: usize,
    min_votes: i64,
) -> (Vec<i64>, Vec<f64>) {
    let b = crate::retrieval::retrieve_candidates(
        pool,
        "movie",
        &c.positive_centroid().unwrap(),
        c,
        pool_size,
        min_votes,
    )
    .await
    .unwrap();
    (
        b.candidates.iter().map(|c| c.title.tmdb_id).collect(),
        b.distances,
    )
}

fn pos(ids: &[i64], id: i64) -> usize {
    ids.iter()
        .position(|x| *x == id)
        .unwrap_or_else(|| panic!("{id} not in {ids:?}"))
}

fn ids_of(r: &RecipeResult) -> Vec<i64> {
    r.items.iter().map(|i| i.tmdb_id).collect()
}

async fn run(
    pool: &SqlitePool,
    recipe: &str,
    c: &UserContext,
    n: usize,
    params: &[(&str, Param)],
) -> RecipeResult {
    let params: Params = params
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    score(recipe, pool, &Default::default(), c, n, &params)
        .await
        .unwrap()
        .unwrap()
}

// ---- retrieval -------------------------------------------------------------

#[tokio::test]
async fn retrieval_anti_join_excludes_all_signal_classes() {
    let f = fixture().await;
    let (ids, _) = retrieved(&f.pool, &ctx(&f.pool).await, 50, 50).await;
    for banned in [LIB_A1, LIB_A2, VETOED, DISLIKED, SHOWN] {
        assert!(!ids.contains(&banned), "{banned}");
    }
    assert!(ids.contains(&CAND_NEAR) && ids.contains(&CAND_FAR));
}

#[tokio::test]
async fn retrieval_gates_vote_count_and_availability() {
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let (ids, _) = retrieved(&f.pool, &c, 50, 50).await;
    assert!(!ids.contains(&LOW_VOTE), "below min_vote_count");
    assert!(!ids.contains(&UNRELEASED), "future release_date");
    let (lenient, _) = retrieved(&f.pool, &c, 50, 0).await;
    assert!(lenient.contains(&LOW_VOTE));
}

#[tokio::test]
async fn retrieval_drops_franchise_title_key_collision() {
    let f = fixture().await;
    let a = title_key_variants(Some("Emerald Heist: Part Two"));
    let b = title_key_variants(Some("Emerald Heist"));
    assert!(a.intersection(&b).next().is_some());
    let (ids, _) = retrieved(&f.pool, &ctx(&f.pool).await, 50, 50).await;
    assert!(!ids.contains(&FRANCHISE));
}

#[tokio::test]
async fn retrieval_preserves_distance_order_and_pool_size() {
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let (ids, distances) = retrieved(&f.pool, &c, 50, 50).await;
    let mut sorted = distances.clone();
    sorted.sort_by(f64::total_cmp);
    assert_eq!(
        distances, sorted,
        "the re-fetch must keep KNN distance order"
    );
    assert!(pos(&ids, CAND_NEAR) < pos(&ids, CAND_FAR));
    let (small, _) = retrieved(&f.pool, &c, 2, 50).await;
    assert_eq!(small, ids[..2], "truncation keeps the closest");
}

#[tokio::test]
async fn retrieval_clamps_knn_k_to_sqlite_vec_limit() {
    // More than 4096 exclusions must clamp k, not raise "k value in knn
    // query too large".
    let f = fixture().await;
    let mut c = ctx(&f.pool).await;
    c.rejected_ids.extend(500_000..504_200);
    assert!(c.rejected_ids.len() > 4096);
    let (ids, _) = retrieved(&f.pool, &c, 50, 50).await;
    assert!(ids.contains(&CAND_NEAR));
}

#[test]
fn bounded_exclusions_trims_soft_recently_shown_to_fit_knn() {
    let shown_order: Vec<i64> = (100_000..103_768).collect(); // newest first
    let user = UserContext {
        library_ids: (0..858).collect(),
        disliked_ids: (10_000..10_751).collect(),
        rejected_ids: (20_000..20_050).collect(),
        recently_shown_ids: shown_order.iter().copied().collect(),
        recently_shown_order: shown_order.clone(),
        ..Default::default()
    };
    let pool_size = 500;
    let excluded = bounded_exclusions(&user, pool_size);
    let mut hard = user.library_ids.clone();
    hard.extend(&user.disliked_ids);
    hard.extend(&user.rejected_ids);
    assert!(
        hard.is_subset(&excluded),
        "hard exclusions are never dropped"
    );
    assert!(excluded.len() <= VEC_KNN_MAX_K - pool_size.max(200));
    assert!(excluded.len() < hard.len() + user.recently_shown_ids.len());
    let kept_soft = excluded.len() - hard.len();
    assert!(kept_soft > 1000, "a heavy household keeps enough to rotate");
    assert!(
        shown_order[..kept_soft]
            .iter()
            .all(|t| excluded.contains(t))
    );
}

#[test]
fn bounded_exclusions_keeps_most_recent_soft_when_trimming() {
    // keep_soft = 4096 - 200 - len(hard) = 5.
    let hard: HashSet<i64> = (0..(VEC_KNN_MAX_K - 200 - 5) as i64).collect();
    let recent = [900_001, 900_002, 900_003, 900_004, 900_005];
    let mut order = recent.to_vec();
    order.extend(800_000..800_050);
    let user = UserContext {
        library_ids: hard.clone(),
        recently_shown_ids: order.iter().copied().collect(),
        recently_shown_order: order,
        ..Default::default()
    };
    let kept: HashSet<i64> = bounded_exclusions(&user, 1)
        .difference(&hard)
        .copied()
        .collect();
    assert_eq!(kept, HashSet::from(recent));
}

#[test]
fn bounded_exclusions_keeps_everything_when_it_already_fits() {
    let user = UserContext {
        library_ids: HashSet::from([1, 2, 3]),
        disliked_ids: HashSet::from([4]),
        rejected_ids: HashSet::from([5]),
        recently_shown_ids: HashSet::from([6, 7, 8]),
        recently_shown_order: vec![6, 7, 8],
        ..Default::default()
    };
    assert_eq!(
        bounded_exclusions(&user, 50),
        (1..=8).collect::<HashSet<_>>()
    );
}

#[tokio::test]
async fn cold_start_pool_orders_by_popularity_and_excludes() {
    let f = fixture().await;
    sqlx::query("UPDATE titles SET popularity = 99 WHERE tmdb_id = ?")
        .bind(CAND_FAR)
        .execute(&f.pool)
        .await
        .unwrap();
    let c = ctx(&f.pool).await;
    let rows: Vec<TitleRow> = cold_start_pool(&f.pool, "movie", &c, 10, 50).await.unwrap();
    let ids: Vec<i64> = rows.iter().map(|r| r.tmdb_id).collect();
    assert_eq!(ids[0], CAND_FAR, "popularity order");
    for banned in [VETOED, LIB_A1, DISLIKED] {
        assert!(!ids.contains(&banned), "{banned}");
    }
}

// ---- user context precedence ------------------------------------------------

async fn insert_feedback(pool: &SqlitePool, tmdb_id: i64, signal: &str) {
    sqlx::query("INSERT INTO user_feedback VALUES (?, 'movie', ?, ?, datetime('now'))")
        .bind(SUB)
        .bind(tmdb_id)
        .bind(signal)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn stored_feedback_used_when_no_inline() {
    let f = fixture().await;
    insert_feedback(&f.pool, CAND_NEAR2, "like").await;
    let c = ctx(&f.pool).await;
    assert!(c.liked_ids.contains(&CAND_NEAR2));
    assert!(c.disliked_ids.contains(&DISLIKED));
}

#[tokio::test]
async fn inline_feedback_is_authoritative_over_stored_dots() {
    let f = fixture().await;
    insert_feedback(&f.pool, CAND_NEAR2, "like").await;
    let c = ctx_with(
        &f.pool,
        Score {
            feedback: Some(vec![]),
            ..req()
        },
    )
    .await;
    assert!(
        c.disliked_ids.is_empty(),
        "inline [] clears the stored dislike"
    );
    assert!(
        !c.liked_ids.contains(&CAND_NEAR2),
        "stored like does not survive inline []"
    );
}

#[tokio::test]
async fn stored_engagement_merges_into_inline_positives() {
    let f = fixture().await;
    insert_feedback(&f.pool, CAND_NEAR, "watched").await;
    let c = ctx_with(
        &f.pool,
        Score {
            feedback: Some(vec![]),
            ..req()
        },
    )
    .await;
    assert!(c.liked_ids.contains(&CAND_NEAR), "stored watched merges in");
    let c2 = ctx_with(
        &f.pool,
        Score {
            feedback: Some(vec![(CAND_NEAR, "dislike")]),
            ..req()
        },
    )
    .await;
    assert!(c2.disliked_ids.contains(&CAND_NEAR));
    assert!(
        !c2.liked_ids.contains(&CAND_NEAR),
        "an inline dislike beats stored engagement"
    );
    // Offline eval (stored_engagement = false) keeps live engagement out.
    let r = Score {
        feedback: Some(vec![]),
        ..req()
    };
    let c3 = load_user_context(&f.pool, &r, false).await.unwrap();
    assert!(!c3.liked_ids.contains(&CAND_NEAR));
}

#[tokio::test]
async fn inline_household_rejections_are_authoritative() {
    let f = fixture().await;
    let c = ctx_with(
        &f.pool,
        Score {
            household_rejections: Some(vec![CAND_FAR]),
            ..req()
        },
    )
    .await;
    assert!(c.rejected_ids.contains(&CAND_FAR));
    assert!(!c.rejected_ids.contains(&VETOED), "inline replaces stored");
    let c2 = ctx_with(
        &f.pool,
        Score {
            household_rejections: Some(vec![CAND_FAR]),
            feedback: Some(vec![(CAND_NEAR2, "reject")]),
            ..req()
        },
    )
    .await;
    assert!(c2.rejected_ids.contains(&CAND_FAR) && c2.rejected_ids.contains(&CAND_NEAR2));
}

#[tokio::test]
async fn inline_library_overrides_stored() {
    let f = fixture().await;
    let c = ctx_with(
        &f.pool,
        Score {
            library: lib(&[(CAND_FAR, "Giggle Factory")]),
            ..req()
        },
    )
    .await;
    assert_eq!(c.library_ids, HashSet::from([CAND_FAR]));
    assert_eq!(c.library_embeddings.ids, [CAND_FAR]);
    assert_eq!(
        ctx(&f.pool).await.library_ids,
        HashSet::from([LIB_A1, LIB_A2])
    );
}

#[tokio::test]
async fn recently_shown_is_newest_first_within_30_days() {
    let f = fixture().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "INSERT INTO recently_shown VALUES
           ('{SUB}', 'movie', 7, datetime('now', '-2 days')),
           ('{SUB}', 'movie', 8, datetime('now', '-40 days')),
           ('{SUB}', 'movie', 9, datetime('now', '-1 days'));"
    )))
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(ctx(&f.pool).await.recently_shown_order, [SHOWN, 9, 7]);
    let off = ctx_with(
        &f.pool,
        Score {
            exclude_recently_shown: false,
            ..req()
        },
    )
    .await;
    assert!(off.recently_shown_order.is_empty() && off.recently_shown_ids.is_empty());
}

#[tokio::test]
async fn cold_start_routing_below_threshold() {
    let f = fixture().await;
    let c = ctx_with(&f.pool, cold(req())).await;
    let config = Config::from_lookup(|_| None).unwrap();
    let got = select_model_config_for_context(&f.pool, &config, &c, None)
        .await
        .unwrap();
    assert_eq!(
        got,
        (
            "cold-start".into(),
            "cold_start_trending".into(),
            Params::new()
        )
    );
}

// ---- model_config --------------------------------------------------------------

#[tokio::test]
async fn active_model_config_falls_back_and_sanitizes() {
    let f = fixture().await;
    let config = Config::from_lookup(|_| None).unwrap();
    let get = || crate::context::get_active_model_config(&f.pool, &config);
    let v0 = ("v0".to_string(), "mmr_diverse".to_string(), Params::new());
    assert_eq!(get().await.unwrap(), v0, "no row");
    let set = |recipe: &'static str, params: &'static str| {
        let pool = f.pool.clone();
        async move {
            sqlx::query("DELETE FROM model_config")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO model_config(version, recipe, params_json, active, created_at)
                 VALUES ('v1', ?, ?, 1, '2026-01-01')",
            )
            .bind(recipe)
            .bind(params)
            .execute(&pool)
            .await
            .unwrap();
        }
    };
    // NaN / Infinity / 1e400 parse in Python (non-finite: only that param is
    // dropped) but are not JSON to serde, so the row is unusable here.
    for (recipe, params) in [
        ("nope", "{}"),
        ("mmr_diverse", "{"),
        ("mmr_diverse", "[1]"),
        ("mmr_diverse", r#"{"mmr_lambda": NaN}"#),
        ("mmr_diverse", r#"{"mmr_lambda": 1e400}"#),
    ] {
        set(recipe, params).await;
        assert_eq!(get().await.unwrap(), v0, "{recipe} {params}");
    }
    set(
        "mmr_diverse",
        r#"{"pool_size": 2.5, "mmr_input_k": 3.5, "mmr_lambda": 7, "negative_weight": true,
            "min_vote_count": -5, "popularity_weight": "x", "personalized_threshold": null,
            "unknown": 1}"#,
    )
    .await;
    let (version, recipe, params) = get().await.unwrap();
    assert_eq!((version.as_str(), recipe.as_str()), ("v1", "mmr_diverse"));
    let want: Params = [
        ("pool_size", Param::Int(2)),
        ("mmr_input_k", Param::Int(4)),
        ("mmr_lambda", Param::Float(1.0)),
        ("min_vote_count", Param::Int(0)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    assert_eq!(params, want);
}

// ---- recipes ----------------------------------------------------------------------

fn cand(v: Vec<f32>) -> Candidate {
    Candidate {
        title: TitleRow {
            tmdb_id: 0,
            kind: "movie",
            title: "x".into(),
            year: None,
            poster_path: None,
            overview: None,
            popularity: 0.0,
            vote_average: None,
            genre_ids: vec![],
        },
        embedding: v,
    }
}

#[test]
fn mmr_selection_diversifies_vs_pure_relevance() {
    let cands: Vec<Candidate> = [
        axis_vec(&[(0, 1.0)]),
        axis_vec(&[(0, 0.999), (3, 0.001)]),
        axis_vec(&[(0, 0.998), (3, 0.002)]),
        axis_vec(&[(1, 1.0)]),
    ]
    .into_iter()
    .map(cand)
    .collect();
    let refs: Vec<&Candidate> = cands.iter().collect();
    let rel = [0.99, 0.98, 0.97, 0.60];
    assert_eq!(
        mmr_order(&refs, &rel, 1.0, 3),
        [0, 1, 2],
        "lambda 1 is pure relevance"
    );
    let diverse = mmr_order(&refs, &rel, 0.5, 3);
    assert!(diverse.contains(&3), "MMR pulls in the different item");
    assert_eq!(diverse[0], 0, "the most relevant goes first");
}

#[test]
fn mmr_skips_zero_and_non_finite_rows() {
    let cands = [
        cand(vec![0.0; 4]),
        cand(vec![f32::NAN, 1.0, 0.0, 0.0]),
        cand(vec![1.0, 0.0, 0.0, 0.0]),
    ];
    let refs: Vec<&Candidate> = cands.iter().collect();
    assert_eq!(mmr_order(&refs, &[0.9, 0.8, 0.1], 0.7, 3), [2]);
    assert!(mmr_order(&refs[..2], &[0.9, 0.8], 0.7, 3).is_empty());
}

#[tokio::test]
async fn mmr_recipe_end_to_end_diversity_and_exclusions() {
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let r = run(
        &f.pool,
        "mmr_diverse",
        &c,
        3,
        &[
            ("mmr_lambda", Param::Float(0.5)),
            ("min_vote_count", Param::Int(50)),
        ],
    )
    .await;
    let ids = ids_of(&r);
    for banned in [VETOED, DISLIKED, SHOWN] {
        assert!(!ids.contains(&banned), "{banned}");
    }
    assert!(
        ids.contains(&CAND_FAR),
        "lambda 0.5 surfaces the comedy outlier"
    );
}

#[tokio::test]
async fn baseline_cosine_orders_by_similarity_and_excludes() {
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let r = run(&f.pool, "baseline_cosine", &c, 10, &[]).await;
    let ids = ids_of(&r);
    assert!(!ids.contains(&VETOED) && !ids.contains(&DISLIKED));
    assert!(pos(&ids, CAND_NEAR) < pos(&ids, CAND_FAR));
    let scores: Vec<f64> = r.items.iter().map(|i| i.score).collect();
    assert!(scores.windows(2).all(|w| w[0] >= w[1]));
}

#[tokio::test]
async fn baseline_cosine_negative_centroid_pushes_disliked_cluster_away() {
    let f = fixture().await;
    let neutral_ctx = ctx_with(
        &f.pool,
        Score {
            feedback: Some(vec![]),
            ..req()
        },
    )
    .await;
    let anti_ctx = ctx_with(
        &f.pool,
        Score {
            feedback: Some(vec![(CAND_FAR, "dislike")]),
            ..req()
        },
    )
    .await;
    let comedy = T {
        genres: &[35],
        ..DEF
    };
    add_title(
        &f.pool,
        777,
        "Chuckle Town",
        &axis_vec(&[(1, 0.98), (5, 0.02)]),
        comedy,
    )
    .await;
    let score_of = |r: &RecipeResult| r.items.iter().find(|i| i.tmdb_id == 777).map(|i| i.score);
    let neutral = score_of(&run(&f.pool, "baseline_cosine", &neutral_ctx, 13, &[]).await).unwrap();
    let anti = score_of(&run(&f.pool, "baseline_cosine", &anti_ctx, 13, &[]).await).unwrap();
    assert!(anti < neutral);
}

#[tokio::test]
async fn cold_start_trending_recipe() {
    let f = fixture().await;
    let c = ctx_with(&f.pool, cold(req())).await;
    let r = run(&f.pool, "cold_start_trending", &c, 5, &[]).await;
    assert!(!r.items.is_empty(), "the trending fallback is never empty");
    assert!(r.items.iter().all(|i| i.provenance == "trending"));
    assert_eq!(r.diag["path"], Value::from("cold_start_trending"));
    // Inline [] rejections are authoritative, but the stored veto applies when
    // they are omitted.
    let with_veto = ctx_with(
        &f.pool,
        Score {
            library: Some(vec![]),
            feedback: Some(vec![]),
            ..req()
        },
    )
    .await;
    let r2 = run(
        &f.pool,
        "cold_start_trending",
        &with_veto,
        20,
        &[("min_vote_count", Param::Int(0))],
    )
    .await;
    assert!(!ids_of(&r2).contains(&VETOED));
}

#[tokio::test]
async fn recipe_without_positive_embedding_falls_back_to_cold_start() {
    // test_fused_cold_start_fallback and test_ranker_cold_start_fallback,
    // on every recipe with a positive-embedding gate.
    let f = fixture().await;
    let c = ctx_with(&f.pool, cold(req())).await;
    for recipe in ["baseline_cosine", "mmr_diverse", "fused", "ranker"] {
        let r = run(&f.pool, recipe, &c, 5, &[]).await;
        assert_eq!(r.diag["path"], Value::from("cold_start"), "{recipe}");
        assert!(!r.items.is_empty() && r.items.iter().all(|i| i.provenance == "trending"));
        let pops: Vec<f64> = r.items.iter().map(|i| i.score).collect();
        assert!(pops.windows(2).all(|w| w[0] >= w[1]), "popularity order");
    }
}

#[test]
fn registry_holds_only_ported_recipes() {
    let names: Vec<&str> = REGISTRY.iter().map(|r| r.name).collect();
    assert_eq!(
        names,
        [
            "baseline_cosine",
            "mmr_diverse",
            "cold_start_trending",
            "fused",
            "ranker"
        ]
    );
    assert!(get("item_knn").is_none());
}

// ---- fused ------------------------------------------------------------------

fn score_map(r: &RecipeResult) -> std::collections::HashMap<i64, f64> {
    r.items.iter().map(|i| (i.tmdb_id, i.score)).collect()
}

#[tokio::test]
async fn fused_veto_never_surfaces_even_as_best_match() {
    // VETOED is the single closest title to the library centroid.
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let ids = ids_of(&run(&f.pool, "fused", &c, 10, &[]).await);
    assert!(!ids.is_empty(), "fused returns items for a warm library");
    for banned in [VETOED, DISLIKED, SHOWN, LIB_A1] {
        assert!(!ids.contains(&banned), "{banned}");
    }
}

#[tokio::test]
async fn fused_prefers_similar_cluster() {
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let ids = ids_of(&run(&f.pool, "fused", &c, 10, &[]).await);
    assert!(pos(&ids, CAND_NEAR) < pos(&ids, CAND_FAR));
}

#[tokio::test]
async fn fused_idf_direction_rare_person_outranks_common() {
    // Identical content and popularity; only the shared LIB_A1 cast member
    // differs, and IDF must weigh the rare co-star above the ubiquitous one.
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let r = run(&f.pool, "fused", &c, 13, &[]).await;
    let ids = ids_of(&r);
    assert!(pos(&ids, CAST_RARE) < pos(&ids, CAST_COMMON));
    let s = score_map(&r);
    assert!(s[&CAST_RARE] > s[&CAST_COMMON]);
}

#[tokio::test]
async fn fused_cast_weight_direction() {
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let off = [("crew_weight", Param::Float(0.0))];
    let no_cast = score_map(
        &run(
            &f.pool,
            "fused",
            &c,
            13,
            &[("cast_weight", Param::Float(0.0)), off[0].clone()],
        )
        .await,
    );
    let with_cast = score_map(
        &run(
            &f.pool,
            "fused",
            &c,
            13,
            &[("cast_weight", Param::Float(0.7)), off[0].clone()],
        )
        .await,
    );
    assert!(
        (no_cast[&CAST_RARE] - no_cast[&CAST_COMMON]).abs() < 1e-6,
        "content-only scores tie for identical embeddings"
    );
    assert!(
        with_cast[&CAST_RARE] > no_cast[&CAST_RARE],
        "cast weight adds signal"
    );
}

#[tokio::test]
async fn fused_cast_topn_param_is_wired() {
    // LIB_A1 has COMMON_PERSON at order_idx 1: with cast_topn 1 the library
    // side of that overlap disappears while the rare pair keeps its boost.
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let caches = std::sync::Arc::new(Caches::default());
    let go = |params: Params| {
        let (pool, caches, c) = (&f.pool, &caches, &c);
        async move {
            score("fused", pool, caches, c, 13, &params)
                .await
                .unwrap()
                .unwrap()
        }
    };
    let default = score_map(&go(Params::new()).await);
    let topn1 = score_map(&go([("cast_topn".to_string(), Param::Int(1))].into()).await);
    assert!(topn1[&CAST_COMMON] < default[&CAST_COMMON]);
    assert!(topn1[&CAST_RARE] >= default[&CAST_RARE]);
    assert!(topn1[&CAST_RARE] - topn1[&CAST_COMMON] > default[&CAST_RARE] - default[&CAST_COMMON]);
    // The IDF cache keys on cast_topn.
    let idf = caches.idf.lock().unwrap();
    assert!(idf.contains_key(&("movie", "cast", 1)) && idf.contains_key(&("movie", "cast", 10)));
}

#[tokio::test]
async fn fused_scores_from_likes_alone() {
    let f = fixture().await;
    let c = ctx_with(
        &f.pool,
        Score {
            library: Some(vec![]),
            feedback: Some(vec![(LIB_A1, "like")]),
            household_rejections: Some(vec![]),
            ..req()
        },
    )
    .await;
    let r = run(&f.pool, "fused", &c, 10, &[]).await;
    assert_ne!(r.diag["path"], Value::from("no_library_embeddings"));
    assert!(!r.items.is_empty());
    assert!(!ids_of(&r).contains(&LIB_A1));
}

// ---- ranker -----------------------------------------------------------------

#[tokio::test]
async fn ranker_never_surfaces_excluded_titles() {
    let f = fixture().await;
    let c = ctx(&f.pool).await;
    let r = run(&f.pool, "ranker", &c, 20, &[]).await;
    let ids = ids_of(&r);
    assert_eq!(r.diag["path"], Value::from("ranker"));
    assert!(!ids.is_empty());
    for banned in [
        VETOED, DISLIKED, SHOWN, LIB_A1, LIB_A2, LOW_VOTE, UNRELEASED,
    ] {
        assert!(!ids.contains(&banned), "{banned}");
    }
    // Only an exact owned title blocks; owning a film must not block its sequel.
    assert!(ids.contains(&FRANCHISE));
}

#[tokio::test]
async fn ranker_drops_owned_title_under_another_tmdb_id() {
    let f = fixture().await;
    add_title(&f.pool, 901, "Steel Vengeance", &axis_vec(&[(1, 1.0)]), DEF).await;
    let c = ctx(&f.pool).await;
    let ids = ids_of(&run(&f.pool, "ranker", &c, 20, &[]).await);
    assert!(!ids.is_empty() && !ids.contains(&901));
}

#[tokio::test]
async fn ranker_learns_from_household_judgments() {
    // Red-dotting a run of comedies must push a comedy candidate down.
    let f = fixture().await;
    let caches = std::sync::Arc::new(Caches::default());
    let c = ctx(&f.pool).await;
    let probe = [CAND_FAR, CAND_NEAR];
    let neutral = ranker::score_ids(&f.pool, &caches, &c, &probe, &Params::new())
        .await
        .unwrap();
    let comedy = T {
        genres: &[35],
        ..DEF
    };
    for i in 0..8 {
        let v = axis_vec(&[(1, 1.0), (5 + i, 0.1)]);
        add_title(
            &f.pool,
            950 + i as i64,
            &format!("Laugh Track {i}"),
            &v,
            comedy,
        )
        .await;
    }
    // The request path never reloads the catalog; the background warm does.
    ranker::warm(&f.pool, &caches).await.unwrap();
    let soured = ctx_with(
        &f.pool,
        Score {
            feedback: Some((0..8).map(|i| (950 + i, "dislike")).collect()),
            ..req()
        },
    )
    .await;
    let after = ranker::score_ids(&f.pool, &caches, &soured, &probe, &Params::new())
        .await
        .unwrap();
    assert!(after[&CAND_FAR] < neutral[&CAND_FAR]);
    assert!(after[&CAND_NEAR] - after[&CAND_FAR] > neutral[&CAND_NEAR] - neutral[&CAND_FAR]);
}

#[tokio::test]
async fn ranker_scores_stay_finite_without_dislikes() {
    // An empty negative class once made the log-odds infinite and every
    // score null.
    let f = fixture().await;
    let comedy = T {
        genres: &[35],
        ..DEF
    };
    let mut library = Vec::new();
    for i in 0..10 {
        let v = axis_vec(&[(1, 1.0), (5 + i, 0.1)]);
        let name = format!("Owned Comedy {i}");
        add_title(&f.pool, 970 + i as i64, &name, &v, comedy).await;
        library.push(LibraryItem {
            tmdb_id: Some(970 + i as i64),
            title: Some(name),
        });
    }
    let c = ctx_with(
        &f.pool,
        Score {
            library: Some(library),
            ..cold(req())
        },
    )
    .await;
    let r = run(&f.pool, "ranker", &c, 20, &[]).await;
    assert_eq!(r.diag["path"], Value::from("ranker"));
    assert!(!r.items.is_empty() && r.items.iter().all(|i| i.score.is_finite()));
}
