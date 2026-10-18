//! Replays tests/fixtures/ranker-goldens.json, recorded from the untouched
//! Python ranker and fused recipes by gen_ranker_goldens.py over the /score
//! golden's synthetic catalog plus synthetic credits, keywords, languages,
//! collections and air dates. Floats match within 1e-6 relative to
//! max(1, |value|) (numpy's float32 BLAS sums in an order Rust cannot see);
//! ids, rows and item order match exactly.

use std::sync::Arc;

use serde_json::Value;
use sqlx::SqlitePool;

use super::*;
use crate::context::load_user_context;
use crate::http::validate::{self, Body};
use crate::recipes::{Param, Params};

const YEAR: i32 = 2026;

fn close(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || (a - b).abs() <= 1e-6 * a.abs().max(b.abs()).max(1.0)
}

/// Model scores sum 18 standardized features: float32 noise in a
/// low-variance similarity feature (~1e-7) grows by w / std, and a weak
/// ridge (< 1) grows it again through the weights.
fn close_score(a: f64, b: f64, ridge: f64) -> bool {
    let tol = if ridge < 1.0 { 1e-4 } else { 1e-5 };
    (a - b).abs() <= tol * a.abs().max(b.abs()).max(1.0)
}

/// A golden number; null stands for NaN.
fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn assert_floats(got: impl IntoIterator<Item = f64>, want: &Value, what: &str) {
    let want = want.as_array().unwrap();
    let got: Vec<f64> = got.into_iter().collect();
    assert_eq!(got.len(), want.len(), "{what}: length");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!(close(*g, num(w)), "{what}[{i}]: {g} vs {w}");
    }
}

fn assert_rows(got: &[[f64; NF]], want: &Value, what: &str) {
    let want = want.as_array().unwrap();
    assert_eq!(got.len(), want.len(), "{what}: rows");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert_floats(g.iter().copied(), w, &format!("{what} row {i}"));
    }
}

fn ints(v: &Value) -> Vec<i64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_i64().unwrap())
        .collect()
}

fn usizes(v: &Value) -> Vec<usize> {
    ints(v).into_iter().map(|x| x as usize).collect()
}

fn assert_sparse(got: &Sparse, want: &Value, what: &str) {
    let want = want.as_array().unwrap();
    assert_eq!(got.rows.len(), want.len(), "{what}: rows");
    for (r, (g, w)) in got.rows.iter().zip(want).enumerate() {
        let w = w.as_array().unwrap();
        let cols: Vec<usize> = w.iter().map(|e| e[0].as_u64().unwrap() as usize).collect();
        assert_eq!(
            g.iter().map(|e| e.0).collect::<Vec<_>>(),
            cols,
            "{what} row {r}: cols"
        );
        for (e, x) in g.iter().zip(w) {
            assert!(
                close(f64::from(e.1), num(&x[1])),
                "{what} row {r}: {} vs {}",
                e.1,
                x[1]
            );
        }
    }
}

async fn seed(pool: &SqlitePool, g: &Value) {
    crate::http::tests::seed_score_golden(pool, g).await;
    for e in g["extras"].as_array().unwrap() {
        let (kind, id) = (e["kind"].as_str().unwrap(), e["tmdb_id"].as_i64().unwrap());
        sqlx::query(
            "UPDATE titles SET year = ?, original_language = ?, raw_json = ? WHERE kind = ? AND tmdb_id = ?",
        )
        .bind(e["year"].as_i64())
        .bind(e["original_language"].as_str())
        .bind(e["raw_json"].as_str())
        .bind(kind)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
        for c in e["cast"].as_array().unwrap() {
            sqlx::query("INSERT INTO title_cast VALUES (?, ?, ?, ?, ?)")
                .bind(id)
                .bind(kind)
                .bind(c[0].as_i64())
                .bind(format!("p{}", c[0]))
                .bind(c[1].as_i64())
                .execute(pool)
                .await
                .unwrap();
        }
        for c in e["crew"].as_array().unwrap() {
            sqlx::query("INSERT INTO title_crew VALUES (?, ?, ?, ?, ?)")
                .bind(id)
                .bind(kind)
                .bind(c[0].as_i64())
                .bind(format!("p{}", c[0]))
                .bind(c[1].as_str())
                .execute(pool)
                .await
                .unwrap();
        }
        for k in e["keywords"].as_array().unwrap() {
            sqlx::query("INSERT INTO title_keywords VALUES (?, ?, ?, ?)")
                .bind(id)
                .bind(kind)
                .bind(k.as_i64())
                .bind(format!("k{k}"))
                .execute(pool)
                .await
                .unwrap();
        }
    }
}

fn params(v: &Value) -> Params {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, x)| {
            let p = match x.as_i64() {
                Some(i) if x.is_i64() => Param::Int(i),
                _ => Param::Float(x.as_f64().unwrap()),
            };
            (k.clone(), p)
        })
        .collect()
}

fn check_catalog(cat: &Catalog, want: &Value, kind: &str) {
    assert_eq!(cat.ids, ints(&want["ids"]), "{kind}: catalog row order");
    for (name, got) in [
        ("rating", &cat.rating),
        ("log_votes", &cat.log_votes),
        ("log_vote_rate", &cat.log_vote_rate),
        ("log_pop", &cat.log_pop),
        ("age", &cat.age),
        ("vote_count", &cat.vote_count),
    ] {
        assert_floats(got.iter().copied(), &want[name], &format!("{kind} {name}"));
    }
    let bools = |v: &Value| -> Vec<bool> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_bool().unwrap())
            .collect()
    };
    assert_eq!(cat.fresh, bools(&want["fresh"]), "{kind} fresh");
    assert_eq!(cat.available, bools(&want["available"]), "{kind} available");
    assert_eq!(
        cat.collection,
        ints(&want["collection"]),
        "{kind} collection"
    );
    let keys: Vec<Option<String>> = want["key"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().map(String::from))
        .collect();
    assert_eq!(cat.key, keys, "{kind} key");
    let genres: Vec<Vec<i64>> = want["genres"]
        .as_array()
        .unwrap()
        .iter()
        .map(ints)
        .collect();
    assert_eq!(cat.genres, genres, "{kind} genres");
    for (name, m) in [
        ("genre", &cat.genre),
        ("lang", &cat.lang),
        ("decade", &cat.decade),
        ("cast", &cat.cast),
        ("crew", &cat.crew),
        ("kw", &cat.kw),
    ] {
        assert_sparse(m, &want[name], &format!("{kind} {name}"));
    }
}

#[tokio::test]
async fn ranker_and_fused_match_python_goldens() {
    let g: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/ranker-goldens.json")).unwrap();
    assert_eq!(g["this_year"], YEAR);
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("exchange.db"))
        .await
        .unwrap();
    seed(&pool, &g).await;
    for kind in ["movie", "tv"] {
        let cat = build_catalog(&pool, kind, YEAR).await.unwrap();
        check_catalog(&cat, &g["catalogs"][kind], kind);
    }

    for sc in g["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let recipe = sc["recipe"].as_str().unwrap();
        let req = validate::score(&Body::Json(sc["body"].clone())).unwrap();
        let ctx = load_user_context(&pool, &req, true).await.unwrap();
        let params = params(&sc["params"]);
        let p = P {
            defaults: DEFAULTS,
            params: &params,
        };
        let caches = Arc::new(Caches {
            this_year: Some(YEAR),
            ..Default::default()
        });
        if let Some(want) = sc.get("refs") {
            let cat = caches.catalog(&pool, ctx.kind, false).await.unwrap();
            let sig = Signals::from(&ctx);
            let refs = sig.refs(&cat);
            assert_eq!(refs.pos, usizes(&want["pos"]), "{name}: pos");
            assert_eq!(refs.neg, usizes(&want["neg"]), "{name}: neg");
            for (lo, key) in [
                (&refs.lo_genre, "lo_genre"),
                (&refs.lo_lang, "lo_lang"),
                (&refs.lo_decade, "lo_decade"),
            ] {
                for v in 0..3 {
                    assert_floats(
                        lo[v].iter().map(|x| f64::from(*x)),
                        &want[key][v],
                        &format!("{name} {key}[{v}]"),
                    );
                }
            }
            let wm = &sc["model"];
            let train: Vec<usize> = refs.pos.iter().chain(&refs.neg).copied().collect();
            assert_rows(
                &features(&cat, &refs, &train).0,
                &wm["x"],
                &format!("{name}: train x"),
            );
            let ridge = p.num("ridge");
            // The Newton fit itself, on numpy's own feature matrix: tight.
            let (n_pos, n_neg) = (refs.pos.len(), refs.neg.len());
            if n_pos > 0 && n_neg > 0 {
                let mean: Vec<f64> = wm["mean"].as_array().unwrap().iter().map(num).collect();
                let std: Vec<f64> = wm["std"].as_array().unwrap().iter().map(num).collect();
                let xs: Vec<[f64; NF]> = wm["x"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| std::array::from_fn(|c| (num(&r[c]) - mean[c]) / std[c]))
                    .collect();
                let y: Vec<f64> = (0..xs.len())
                    .map(|i| f64::from(u8::from(i < n_pos)))
                    .collect();
                let w = fit_logistic(&xs, &y, ridge);
                for (i, (g, e)) in w.iter().zip(wm["w"].as_array().unwrap()).enumerate() {
                    assert!(
                        (g - num(e)).abs() <= 1e-9 * g.abs().max(1.0),
                        "{name}: fit w[{i}] {g} vs {e}"
                    );
                }
            }
            // End to end from our own features: a weak ridge (< 1) leaves the
            // fit ill-conditioned enough to grow float32 feature noise ~100x.
            let model = fit_model(&ctx.sub, &cat, &refs, ridge);
            let tol = if ridge < 1.0 { 1e-4 } else { 1e-6 };
            for (i, (g, e)) in model.w.iter().zip(wm["w"].as_array().unwrap()).enumerate() {
                assert!(
                    (g - num(e)).abs() <= tol * g.abs().max(1.0),
                    "{name}: w[{i}] {g} vs {e}"
                );
            }
            assert_floats(model.mean, &wm["mean"], &format!("{name}: mean"));
            assert_floats(model.std, &wm["std"], &format!("{name}: std"));
            assert!(
                close(model.train_auc, num(&wm["train_auc"])),
                "{name}: train_auc"
            );
            assert_eq!(model.n_pos as u64, wm["n_pos"].as_u64().unwrap());
            assert_eq!(model.n_neg as u64, wm["n_neg"].as_u64().unwrap());

            let wc = &sc["candidates"];
            let ok = eligible(&sig, &cat, p.int("min_vote_count"));
            assert_eq!(
                ok.iter().filter(|b| **b).count() as u64,
                wc["eligible"].as_u64().unwrap()
            );
            let (rows, src) = candidates(
                &cat,
                &refs,
                &model,
                &ok,
                p.int("pool_size") as usize,
                p.int("interest_clusters") as usize,
            );
            assert_eq!(Value::Object(src), wc["src"], "{name}: src");
            assert_eq!(rows, usizes(&wc["rows"]), "{name}: candidate rows");
            let (x, _) = features(&cat, &refs, &rows);
            assert_rows(&x, &wc["x"], &format!("{name}: candidate x"));
            let wz = wc["z"].as_array().unwrap();
            for (i, x) in x.iter().enumerate() {
                let (g, w) = (model.z(x), num(&wz[i]));
                assert!(close_score(g, w, ridge), "{name}: z[{i}] {g} vs {w}");
            }

            let ids = ints(&sc["score_ids"]["ids"]);
            let got = score_ids(&pool, &caches, &ctx, &ids, &params)
                .await
                .unwrap();
            let want = sc["score_ids"]["scores"].as_object().unwrap();
            assert_eq!(got.len(), want.len(), "{name}: score_ids");
            for (id, s) in want {
                let g = got[&id.parse::<i64>().unwrap()];
                assert!(
                    close_score(g, num(s), ridge),
                    "{name}: score_ids {id}: {g} vs {s}"
                );
            }
        }

        let result = crate::recipes::score(recipe, &pool, &caches, &ctx, req.n as usize, &params)
            .await
            .unwrap()
            .unwrap();
        let got: Vec<Value> = result
            .items
            .iter()
            .map(|i| serde_json::to_value(i).unwrap())
            .collect();
        let want = sc["items"].as_array().unwrap();
        let ids = |v: &[Value]| {
            v.iter()
                .map(|i| i["tmdb_id"].as_i64().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&got), ids(want), "{name}: item order");
        for (x, y) in got.iter().zip(want) {
            assert!(
                close_score(num(&x["score"]), num(&y["score"]), p.num("ridge")),
                "{name}: score {x} vs {y}"
            );
            let strip = |v: &Value| {
                let mut v = v.clone();
                v.as_object_mut().unwrap().remove("score");
                v
            };
            assert_eq!(strip(x), strip(y), "{name}: item");
        }
        let mut d = result.diag;
        d.remove("model_age_s");
        assert_eq!(Value::Object(d), sc["diag"], "{name}: diag");
    }
}

// ---- test_scoring_path.py's pure ranker cases --------------------------------

fn onehot(cats: &[usize], ncols: usize) -> Sparse {
    Sparse::from_entries(cats.len(), cats.iter().copied().enumerate(), ncols)
}

#[test]
fn logodds_finite_with_zero_or_one_negative() {
    // rows [[1,0],[1,0],[0,1],[1,1]]
    let m = Sparse::from_entries(4, [(0, 0), (1, 0), (2, 1), (3, 0), (3, 1)].into_iter(), 2);
    for neg in [vec![], vec![2]] {
        for lo in logodds(&m, &[0, 1], &neg) {
            assert!(lo.iter().all(|x| x.is_finite()), "{neg:?} {lo:?}");
        }
    }
}

#[test]
fn logodds_neutral_for_unjudged_category() {
    // cat 0 only in positives, cat 1 only in negatives, cat 2 never judged;
    // unequal class sizes (2 vs 6) used to push the unjudged one positive.
    let m = onehot(&[0, 0, 1, 1, 1, 1, 1, 1, 2, 2], 3);
    let lo = &logodds(&m, &[0, 1], &[2, 3, 4, 5, 6, 7])[0];
    assert!(lo[0] > 0.0 && 0.0 > lo[1]);
    assert_eq!(lo[2], 0.0);
}

fn eye(n: usize) -> Vec<Vec<f32>> {
    (0..n)
        .map(|i| {
            let mut v = vec![0f32; crate::db::EMBED_DIM];
            v[i] = 1.0;
            v
        })
        .collect()
}

#[test]
fn slate_running_constraints() {
    // 8 inputs, best first. 0-3 kids; 4 and 5 share a collection; 7 is the
    // only fresh title. Slot 1 can't be a kid -> 4; slot 2 admits a kid -> 0;
    // slot 3 can't, and 5 repeats 4's collection -> 6; slot 4 owes the fresh
    // floor (int(0.25 * 4) = 1) -> 7.
    let z = [8.0, 7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0];
    let emb = eye(8);
    let emb: Vec<&[f32]> = emb.iter().map(Vec::as_slice).collect();
    let gdist: Vec<Vec<f64>> = (0..8)
        .map(|i| (0..8).map(|j| f64::from(u8::from(i == j))).collect())
        .collect();
    let kids: Vec<bool> = (0..8).map(|i| i < 4).collect();
    let fresh: Vec<bool> = (0..8).map(|i| i == 7).collect();
    let p = SlateParams {
        calibration: 0.0,
        redundancy: 0.0,
        kids_genre_cap: 0.5,
        fresh_share: 0.25,
    };
    let chosen = slate(
        &z,
        &emb,
        &gdist,
        &[1.0 / 8.0; 8],
        &[0, 0, 0, 0, 9, 9, 0, 0],
        &kids,
        &fresh,
        4,
        &p,
    );
    assert_eq!(chosen, [4, 0, 6, 7]);
}

#[test]
fn slate_calibration_pulls_in_underrepresented_genre() {
    // Taste is half genre A, half B; the three best inputs are all A.
    let z = [3.0, 2.9, 2.8, 1.0];
    let emb = eye(4);
    let emb: Vec<&[f32]> = emb.iter().map(Vec::as_slice).collect();
    let gdist = vec![
        vec![1.0, 0.0],
        vec![1.0, 0.0],
        vec![1.0, 0.0],
        vec![0.0, 1.0],
    ];
    let run = |calibration| {
        let p = SlateParams {
            calibration,
            redundancy: 0.0,
            kids_genre_cap: 1.0,
            fresh_share: 0.0,
        };
        slate(
            &z,
            &emb,
            &gdist,
            &[0.5, 0.5],
            &[0; 4],
            &[false; 4],
            &[false; 4],
            3,
            &p,
        )
    };
    assert_eq!(run(0.0), [0, 1, 2]);
    assert!(run(0.5)[..2].contains(&3));
}

#[test]
fn solve_matches_a_known_system() {
    let a = [[2.0, 1.0, -1.0], [-3.0, -1.0, 2.0], [-2.0, 1.0, 2.0]];
    let x = solve(a, [8.0, -11.0, -3.0]);
    for (g, w) in x.iter().zip([2.0, 3.0, -1.0]) {
        assert!((g - w).abs() < 1e-12, "{x:?}");
    }
}
