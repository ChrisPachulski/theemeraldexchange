use serde_json::Value;

use super::*;

fn goldens() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/featurize-goldens.json")).unwrap()
}

fn ids(v: &Value) -> Vec<i64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_i64().unwrap())
        .collect()
}

/// tests/fixtures/featurize-goldens.json, recorded by gen_featurize_goldens.py.
#[test]
fn perturbations_match_numpy_exactly() {
    let g = goldens();
    for (kind, f) in [
        ("genre", genre_perturbation as fn(&[i64]) -> Vec<f32>),
        ("keyword", keyword_perturbation),
    ] {
        for case in g["perturbations"][kind].as_array().unwrap() {
            let mut want = vec![0f32; EMBED_DIM];
            for p in case["out"].as_array().unwrap() {
                want[p[0].as_u64().unwrap() as usize] = p[1].as_f64().unwrap() as f32;
            }
            assert_eq!(f(&ids(&case["ids"])), want, "{kind} {}", case["ids"]);
        }
    }
}

#[test]
fn text_joins_present_parts() {
    let row = |title: &str, overview: Option<&str>| Pending {
        tmdb_id: 1,
        kind: "movie".into(),
        title: title.into(),
        overview: overview.map(Into::into),
        genres: None,
        keywords: None,
    };
    assert_eq!(text(&row("A", Some("b"))), "A — b");
    assert_eq!(text(&row("A", None)), "A");
    assert_eq!(text(&row("", Some("b"))), "b");
    assert_eq!(text(&row("A", Some(""))), "A");
}

async fn seeded(g: &Value) -> (tempfile::TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("exchange.db"))
        .await
        .unwrap();
    for t in g["titles"].as_array().unwrap() {
        let (id, kind) = (t[0].as_i64().unwrap(), t[1].as_str().unwrap());
        sqlx::query(
            "INSERT INTO titles(tmdb_id, kind, title, overview, fetched_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(kind)
        .bind(t[2].as_str())
        .bind(t[3].as_str())
        .bind(t[4].as_str())
        .execute(&pool)
        .await
        .unwrap();
        for (table, col, list) in [
            ("title_genres", "genre_id", &t[5]),
            ("title_keywords", "keyword_id", &t[6]),
        ] {
            for v in ids(list) {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "INSERT INTO {table}(tmdb_id, kind, {col}) VALUES (?, ?, ?)"
                )))
                .bind(id)
                .bind(kind)
                .bind(v)
                .execute(&pool)
                .await
                .unwrap();
            }
        }
    }
    (dir, pool)
}

async fn apply(pool: &SqlitePool, stage: &Value) {
    for sql in stage["sql"].as_array().unwrap() {
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str().unwrap().to_string()))
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn identity(pool: &SqlitePool) -> String {
    sqlx::query_scalar("SELECT value FROM ingest_state WHERE key = 'embed_model'")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn vec_rows(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM title_vec")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Pending selection, the identity reconcile and stale rebuilds follow the
/// Python stage for stage; this half needs no model (fixed unit vectors).
#[tokio::test]
async fn stages_match_python_without_model() {
    let g = goldens();
    assert_eq!(g["identity"], model_identity());
    let (_dir, pool) = seeded(&g).await;
    for stage in g["stages"].as_array().unwrap() {
        let name = stage["name"].as_str().unwrap();
        apply(&pool, stage).await;
        reconcile_model_identity(&pool, &model_identity())
            .await
            .unwrap();
        let pending = load_pending(&pool, stage["limit"].as_i64()).await.unwrap();
        let got: Vec<Value> = pending
            .iter()
            .map(|p| serde_json::json!([p.kind, p.tmdb_id]))
            .collect();
        assert_eq!(Value::from(got), stage["pending"], "{name}: pending");
        let mut unit = vec![0f32; EMBED_DIM];
        unit[0] = 1.0;
        let embs = vec![unit; pending.len()];
        // A fixed clock past every fixture fetched_at.
        persist(&pool, &pending, &embs, "2030-01-01T00:00:00+00:00")
            .await
            .unwrap();
        assert_eq!(
            pending.len() as u64,
            stage["processed"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(identity(&pool).await, stage["identity"], "{name}: identity");
        assert_eq!(
            vec_rows(&pool).await,
            stage["title_vec_rows"],
            "{name}: title_vec rows"
        );
    }
    // Every title_vec row carries its title_features vector under the kind-encoded rowid.
    let rows: Vec<(i64, String, Vec<u8>)> =
        sqlx::query_as("SELECT tmdb_id, kind, embedding FROM title_features")
            .fetch_all(&pool)
            .await
            .unwrap();
    for (id, kind, blob) in rows {
        let vec: Vec<u8> = sqlx::query_scalar("SELECT embedding FROM title_vec WHERE rowid = ?")
            .bind(encode_vec_rowid(&kind, id).unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(vec, blob, "{kind} {id}");
    }
}

/// The real run against the Python one: vectors within 1e-4, the same feature
/// JSON, processed counts and identity row. Skips without EEX_MINILM_DIR.
#[tokio::test]
async fn stages_match_python_with_model() {
    let Some(dir) = crate::embed::test_model_dir() else {
        return;
    };
    let embedder = Arc::new(Embedder::load(&dir).unwrap());
    let g = goldens();
    let (_dir, pool) = seeded(&g).await;
    for stage in g["stages"].as_array().unwrap() {
        let name = stage["name"].as_str().unwrap();
        apply(&pool, stage).await;
        let n = run(&pool, embedder.clone(), stage["limit"].as_i64())
            .await
            .unwrap();
        assert_eq!(n as u64, stage["processed"].as_u64().unwrap(), "{name}");
        assert_eq!(identity(&pool).await, stage["identity"], "{name}: identity");
        assert_eq!(
            vec_rows(&pool).await,
            stage["title_vec_rows"],
            "{name}: title_vec rows"
        );
        let Some(want) = stage["rows"].as_array() else {
            continue;
        };
        let got: Vec<(i64, String, String, Vec<u8>, i64)> = sqlx::query_as(
            "SELECT tmdb_id, kind, feature_json, embedding, dim FROM title_features ORDER BY kind, tmdb_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(got.len(), want.len(), "{name}: rows");
        for ((id, kind, fj, blob, dim), w) in got.iter().zip(want) {
            assert_eq!(
                (*id, kind.as_str(), *dim),
                (
                    w["tmdb_id"].as_i64().unwrap(),
                    w["kind"].as_str().unwrap(),
                    384
                )
            );
            let (fj, wfj): (Value, Value) = (
                serde_json::from_str(fj).unwrap(),
                serde_json::from_str(w["feature_json"].as_str().unwrap()).unwrap(),
            );
            assert_eq!(
                (&fj["genres"], &fj["keywords"]),
                (&wfj["genres"], &wfj["keywords"])
            );
            let tn = (fj["text_norm"].as_f64().unwrap() - wfj["text_norm"].as_f64().unwrap()).abs();
            assert!(tn <= 1e-5, "{name} {kind} {id}: text_norm off by {tn}");
            let v = crate::db::deserialize_f32(blob, Some(EMBED_DIM)).unwrap();
            let max = v
                .iter()
                .zip(w["embedding"].as_array().unwrap())
                .map(|(a, b)| (f64::from(*a) - b.as_f64().unwrap()).abs())
                .fold(0f64, f64::max);
            assert!(max <= 1e-4, "{name} {kind} {id}: max delta {max}");
        }
    }
}
