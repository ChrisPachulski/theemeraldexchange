//! Replays tests/fixtures/replay-goldens.json, recorded by
//! gen_replay_goldens.py from the untouched research/household_eval.py over
//! a synthetic snapshot (the ranker golden's catalog plus a synthetic owner's
//! judgments and Radarr/Sonarr-shaped JSON files). The same snapshot is
//! rebuilt here, opened read-only/immutable, and every output value must
//! match to 4 decimals.

use serde_json::Value;

use super::*;

const YEAR: i32 = 2026;

fn close(got: &Value, want: &Value, path: &str) {
    match (got, want) {
        (Value::Number(g), Value::Number(w)) => {
            let (g, w) = (g.as_f64().unwrap(), w.as_f64().unwrap());
            assert!((g - w).abs() <= 5e-5, "{path}: {g} vs {w}");
        }
        (Value::Array(g), Value::Array(w)) => {
            assert_eq!(g.len(), w.len(), "{path}: length");
            for (i, (a, b)) in g.iter().zip(w).enumerate() {
                close(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(g), Value::Object(w)) => {
            let mut gk: Vec<_> = g.keys().collect();
            let mut wk: Vec<_> = w.keys().collect();
            gk.sort();
            wk.sort();
            assert_eq!(gk, wk, "{path}: keys");
            for (k, b) in w {
                close(&g[k], b, &format!("{path}.{k}"));
            }
        }
        _ => assert_eq!(got, want, "{path}"),
    }
}

async fn build_snapshot(dir: &std::path::Path, snap: &Value) {
    let ranker: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/ranker-goldens.json")).unwrap();
    let pool = crate::db::open(&dir.join("exchange.db")).await.unwrap();
    crate::recipes::ranker::tests::seed(&pool, &ranker).await;
    for r in snap["user_feedback"].as_array().unwrap() {
        sqlx::query(
            "INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(r[0].as_str())
        .bind(r[1].as_str())
        .bind(r[2].as_i64())
        .bind(r[3].as_str())
        .bind(r[4].as_str())
        .execute(&pool)
        .await
        .unwrap();
    }
    for (n, r) in snap["rec_log"].as_array().unwrap().iter().enumerate() {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO rec_log(sub, kind, tmdb_id, rank, score, provenance, model_version, ts)
             VALUES (?, ?, ?, ?, 0.5, 'discover', 'v', ?) RETURNING id",
        )
        .bind(r[0].as_str())
        .bind(r[1].as_str())
        .bind(r[2].as_i64())
        .bind((n % 20) as i64)
        .bind(r[3].as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
        if let Some(outcome) = r[4].as_str() {
            sqlx::query("INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES (?, ?, ?)")
                .bind(id)
                .bind(outcome)
                .bind(r[3].as_str())
                .execute(&pool)
                .await
                .unwrap();
        }
    }
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    for (file, key) in [
        ("library.json", "library"),
        ("user-feedback.json", "user_feedback_json"),
        ("rejections.json", "rejections"),
    ] {
        std::fs::write(dir.join(file), snap[key].to_string()).unwrap();
    }
}

#[tokio::test]
async fn replay_goldens() {
    let g: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/replay-goldens.json")).unwrap();
    assert_eq!(g["this_year"], YEAR);
    let dir = tempfile::tempdir().unwrap();
    build_snapshot(dir.path(), &g["snapshot"]).await;
    let pool = crate::db::open_snapshot(&dir.path().join("exchange.db"))
        .await
        .unwrap();
    let snap = Snapshot {
        dir: dir.path().to_path_buf(),
        owner: g["snapshot"]["owner"].as_str().unwrap().into(),
    };
    for case in g["cases"].as_array().unwrap() {
        let (recipe, cutoff) = (
            case["recipe"].as_str().unwrap(),
            case["cutoff"].as_str().unwrap(),
        );
        let kind = if case["kind"] == "movie" {
            "movie"
        } else {
            "tv"
        };
        let params = parse_params(&case["params"].to_string()).unwrap();
        let caches = Arc::new(Caches::with_year(YEAR));
        let r = evaluate(&pool, &snap, &caches, recipe, kind, cutoff, &params, 3)
            .await
            .unwrap();
        assert_eq!(r.shown.len(), 3);
        let got = serde_json::to_value(&r).unwrap();
        close(&got, &case["out"], &format!("{recipe}/{kind}/{cutoff}"));
    }
}

#[tokio::test]
async fn snapshot_with_a_live_wal_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("exchange.db");
    std::fs::write(&db, b"").unwrap();
    std::fs::write(dir.path().join("exchange.db-wal"), b"pages").unwrap();
    assert!(crate::db::open_snapshot(&db).await.is_err());
}

#[test]
fn auc_averages_ties() {
    let scores: HashMap<i64, f64> = [(1, 0.9), (2, 0.5), (3, 0.5), (4, 0.1), (5, 0.7)].into();
    let pos: HashSet<i64> = [1, 2].into();
    let neg: HashSet<i64> = [3, 4, 99].into();
    // Pairs: (1>3) (1>4) (2=3 counts half) (2>4) -> 3.5 / 4.
    assert_eq!(auc(&scores, &pos, &neg), (0.875, 2, 2));
    assert!(auc(&scores, &pos, &HashSet::new()).0.is_nan());
    let se = auc_se(0.875, 2, 2);
    assert!((se - 0.2077_f64).abs() < 1e-3, "{se}");
}

#[test]
fn opts_defaults_and_flags() {
    let env = |k: &str| (k == "HOME").then(|| "/home/x".to_string());
    let o = Opts::parse(&[], env).unwrap();
    assert_eq!(o.snap, PathBuf::from("/home/x/eex-recsys-snap"));
    assert_eq!(
        (o.cutoff.as_str(), o.recipe.as_str()),
        ("2026-07-01", "fused")
    );
    assert_eq!(o.kinds, ["movie", "tv"]);
    let args: Vec<String> = [
        "--recipe",
        "ranker",
        "--kind",
        "tv",
        "--params",
        "{\"kids_genre_cap\":0.15}",
        "--cutoff",
        "2026-06-15",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let o = Opts::parse(&args, env).unwrap();
    assert_eq!(o.kinds, ["tv"]);
    assert_eq!(o.params["kids_genre_cap"], Param::Float(0.15));
    assert!(Opts::parse(&["--kind".into(), "show".into()], env).is_err());
}
