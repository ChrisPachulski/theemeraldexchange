//! Replays tests/fixtures/optimizer-goldens.json, recorded by
//! gen_optimizer_goldens.py from the untouched Python optimizer.run() against
//! a local fake Anthropic server. Each scenario rebuilds the same seed here,
//! runs optimizer::run against a Rust copy of the fake, and must match the
//! return value, every request (path, auth headers, body; the prompt's
//! timestamps compared as a placeholder), the eval scores and the
//! model_config rows (versions and created_at by shape).

use std::sync::Mutex;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;

use super::*;

type Replies = Arc<Mutex<(Vec<(u16, Value)>, Vec<Value>)>>;

/// The fake Messages endpoint: records each request, answers from the queue.
async fn fake(
    State(st): State<Replies>,
    headers: HeaderMap,
    body: String,
) -> axum::response::Response {
    let h = |k: &str| {
        headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(String::from)
    };
    let mut s = st.lock().unwrap();
    s.1.push(json!({
        "method": "POST", "path": "/v1/messages",
        "x-api-key": h("x-api-key"), "anthropic-version": h("anthropic-version"),
        "body": serde_json::from_str::<Value>(&body).unwrap(),
    }));
    let (status, payload) = if s.0.is_empty() {
        (500, json!({"error": "no reply queued"}))
    } else {
        s.0.remove(0)
    };
    (
        axum::http::StatusCode::from_u16(status).unwrap(),
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        payload.to_string(),
    )
        .into_response()
}

use axum::response::IntoResponse;

async fn serve_fake(replies: Vec<(u16, Value)>) -> (String, Replies) {
    let st: Replies = Arc::new(Mutex::new((replies, Vec::new())));
    let app = axum::Router::new()
        .route("/v1/messages", post(fake))
        .with_state(st.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), st)
}

fn config(pairs: Vec<(&str, String)>) -> Config {
    let pairs: Vec<(String, String)> = pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    Config::from_lookup(move |k| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
        .unwrap()
}

/// Each `"rec_ts": "..."` value (relative to now at seed time) as a placeholder.
fn normalize(prompt: &str) -> String {
    prompt
        .lines()
        .map(|l| match l.find("\"rec_ts\": \"") {
            Some(i) => format!("{}\"rec_ts\": \"<ts>\"", &l[..i]),
            None => l.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn seed_recs(pool: &SqlitePool, rows: &Value) {
    let ts = "strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', ?)";
    for r in rows.as_array().unwrap() {
        let id: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "INSERT INTO rec_log(sub, kind, tmdb_id, rank, score, provenance, model_version, ts)
             VALUES (?, ?, ?, ?, ?, ?, 'v-golden', {ts}) RETURNING id"
        )))
        .bind(r["sub"].as_str())
        .bind(r["kind"].as_str())
        .bind(r["tmdb_id"].as_i64())
        .bind(r["rank"].as_i64())
        .bind(r["score"].as_f64())
        .bind(r["provenance"].as_str())
        .bind(format!("-{} minutes", r["rec_min"]))
        .fetch_one(pool)
        .await
        .unwrap();
        for o in r["outcomes"].as_array().unwrap() {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES (?, ?, {ts})"
            )))
            .bind(id)
            .bind(o[0].as_str())
            .bind(format!("-{} minutes", o[1]))
            .execute(pool)
            .await
            .unwrap();
        }
    }
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// v-YYYYMMDD-HHMMSS-xxxxxx / proposed-YYYYMMDD-HHMMSS
fn version_shape(want: &str, got: &str) -> bool {
    let parts = |s: &str| s.split('-').map(String::from).collect::<Vec<_>>();
    let g = parts(got);
    if want.starts_with("v-20") {
        g.len() == 4
            && g[0] == "v"
            && digits(&g[1], 8)
            && digits(&g[2], 6)
            && g[3].len() == 6
            && g[3]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    } else if want.starts_with("proposed-") {
        g.len() == 3 && g[0] == "proposed" && digits(&g[1], 8) && digits(&g[2], 6)
    } else {
        want == got
    }
}

#[tokio::test]
async fn optimizer_goldens() {
    let g: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/optimizer-goldens.json")).unwrap();
    let score: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/score-goldens.json")).unwrap();
    for sc in g["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let holdout = dir.path().join("holdout.jsonl");
        let lines: String = sc["holdout"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| format!("{r}\n"))
            .collect();
        std::fs::write(&holdout, lines).unwrap();
        let mut env = vec![
            (
                "RECOMMENDER_DB_PATH",
                dir.path().join("exchange.db").display().to_string(),
            ),
            (
                "RECOMMENDER_OPTIMIZER_MODEL",
                g["model"].as_str().unwrap().into(),
            ),
            (
                "RECOMMENDER_OPTIMIZER_MAX_TOKENS",
                g["max_tokens"].to_string(),
            ),
            ("RECOMMENDER_HOLDOUT_PATH", holdout.display().to_string()),
        ];
        if sc["api_key"].as_bool().unwrap() {
            env.push(("ANTHROPIC_API_KEY", g["api_key"].as_str().unwrap().into()));
        }
        let config = config(env);
        let pool = crate::db::open(&config.db_path).await.unwrap();
        crate::http::tests::seed_score_golden(&pool, &score).await;
        for r in sc["model_config"].as_array().unwrap() {
            sqlx::query(
                "INSERT INTO model_config(version, recipe, params_json, active, created_at, notes)
                 VALUES (?, ?, ?, ?, '2026-01-01 00:00:00', ?)",
            )
            .bind(r[0].as_str())
            .bind(r[1].as_str())
            .bind(r[2].as_str())
            .bind(r[3].as_i64())
            .bind(r[4].as_str())
            .execute(&pool)
            .await
            .unwrap();
        }
        seed_recs(&pool, &g["recs"][sc["recs"].to_string()]).await;
        let replies = sc["replies"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r[0].as_u64().unwrap() as u16, r[1].clone()))
            .collect();
        let (base, st) = serve_fake(replies).await;

        let report = run(&pool, &config, &base).await.unwrap();

        assert_eq!(
            i64::from(report.promoted.is_some()),
            sc["result"].as_i64().unwrap(),
            "{name}: result"
        );
        let got_requests = st.lock().unwrap().1.clone();
        let want_requests = sc["requests"].as_array().unwrap();
        assert_eq!(
            got_requests.len(),
            want_requests.len(),
            "{name}: request count"
        );
        for (got, want) in got_requests.iter().zip(want_requests) {
            for k in ["method", "path", "x-api-key", "anthropic-version"] {
                assert_eq!(got[k], want[k], "{name}: request {k}");
            }
            let (gb, wb) = (&got["body"], &want["body"]);
            let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
            assert_eq!(keys(gb), keys(wb), "{name}: body keys");
            for k in ["model", "max_tokens", "temperature", "system"] {
                assert_eq!(gb[k], wb[k], "{name}: body {k}");
            }
            let msgs = |v: &Value| v["messages"].as_array().unwrap().len();
            assert_eq!(msgs(gb), 1, "{name}: one message");
            assert_eq!(msgs(wb), 1);
            assert_eq!(gb["messages"][0]["role"], "user");
            assert_eq!(
                normalize(gb["messages"][0]["content"].as_str().unwrap()),
                normalize(wb["messages"][0]["content"].as_str().unwrap()),
                "{name}: prompt"
            );
        }
        match (&report.eval, sc["eval"].as_array()) {
            (None, None) => {}
            (Some((b, c, ok)), Some(w)) => {
                assert!(
                    (b - w[0].as_f64().unwrap()).abs() < 1e-12,
                    "{name}: baseline score"
                );
                assert!(
                    (c - w[1].as_f64().unwrap()).abs() < 1e-12,
                    "{name}: candidate score"
                );
                assert_eq!(*ok, w[2].as_bool().unwrap(), "{name}: ok to promote");
            }
            other => panic!("{name}: eval {other:?}"),
        }
        let rows: Vec<(i64, String, String, String, i64, String, String)> = sqlx::query_as(
            "SELECT id, version, recipe, params_json, active, created_at, notes FROM model_config ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let want_rows = sc["model_config_after"].as_array().unwrap();
        assert_eq!(rows.len(), want_rows.len(), "{name}: model_config rows");
        for (got, want) in rows.iter().zip(want_rows) {
            assert_eq!(got.0, want["id"].as_i64().unwrap(), "{name}: id");
            let wv = want["version"].as_str().unwrap();
            assert!(
                version_shape(wv, &got.1),
                "{name}: version {} vs {wv}",
                got.1
            );
            assert_eq!(got.2, want["recipe"].as_str().unwrap(), "{name}: recipe");
            assert_eq!(
                got.3,
                want["params_json"].as_str().unwrap(),
                "{name}: params_json"
            );
            assert_eq!(got.4, want["active"].as_i64().unwrap(), "{name}: active");
            let wc = want["created_at"].as_str().unwrap();
            assert!(
                got.5 == wc || (wc != "2026-01-01 00:00:00" && got.5.len() == 19),
                "{name}: created_at"
            );
            assert_eq!(got.6, want["notes"].as_str().unwrap(), "{name}: notes");
        }
        pool.close().await;
    }
}

// recommender/tests/test_optimizer_eligibility.py
#[test]
fn eligibility_excludes_offline_and_orchestration_only() {
    let e = eligible_recipes();
    assert!(!e.contains(&"item_knn"));
    assert!(!e.contains(&"cold_start_trending"));
    for r in ["baseline_cosine", "mmr_diverse", "fused"] {
        assert!(e.contains(&r), "{r}");
    }
}

fn fused_defaults() -> Params {
    defaults_params(recipes::fused::DEFAULTS)
}

#[test]
fn validate_rejects_offline_only_recipe() {
    let p = json!({"recipe": "item_knn", "params": {"pool_size": 800}, "notes": "x"});
    assert!(validate_proposal(&p, "fused", &fused_defaults(), 0.2).is_none());
    let p = json!({"recipe": "item_knn", "params": {}, "notes": "x"});
    assert!(validate_proposal(&p, "fused", &fused_defaults(), 0.2).is_none());
}

#[test]
fn validate_accepts_serve_recipe() {
    let p = json!({"recipe": "fused", "params": {"cast_weight": 0.8}, "notes": "bump cast"});
    let (recipe, params, notes) = validate_proposal(&p, "fused", &fused_defaults(), 0.2).unwrap();
    assert_eq!(recipe, "fused");
    assert_eq!(params["cast_weight"], Param::Float(0.8));
    assert_eq!(notes, "bump cast");
}

// test_optimizer_holdout.py::test_min_candidate_score_is_above_epsilon
#[test]
fn min_candidate_score_is_above_epsilon() {
    const { assert!(MIN_CANDIDATE_SCORE > EVAL_EPSILON) };
}

// test_scoring_path.py::test_optimizer_eval_ignores_live_engagement: a live
// "added" on a held-out positive must not become an eval input.
#[tokio::test]
async fn eval_context_ignores_live_engagement() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("x.db")).await.unwrap();
    sqlx::query("INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES ('plex:1','movie',11,'added','t')")
        .execute(&pool)
        .await
        .unwrap();
    let e = HoldoutEntry {
        sub: "plex:1".into(),
        kind: "movie".into(),
        library: vec![],
        positives: vec![11],
        negatives: vec![],
    };
    let ctx = entry_context(&pool, &e).await.unwrap();
    assert!(!ctx.liked_ids.contains(&11));
}

// The vetted seed's subs ("plex:seed-m0", ...) are not valid plex subs, so
// with sub validation on (the prod image's EEX_REQUIRE_BINDING=1) every seed
// entry fails evaluation, as it does in the Python service.
#[tokio::test]
async fn seed_holdout_entries_fail_sub_validation() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("x.db")).await.unwrap();
    let seed = load_holdout(None).unwrap();
    for e in &seed {
        assert!(entry_context(&pool, e).await.is_err(), "{}", e.sub);
    }
}

#[test]
fn py_float_is_python_repr() {
    for (f, want) in [
        (0.3, "0.3"),
        (0.0, "0.0"),
        (500.0, "500.0"),
        (0.24000000000000002, "0.24000000000000002"),
        (1e-5, "1e-05"),
        (1.5e16, "1.5e+16"),
        (0.0001, "0.0001"),
        (-2.5, "-2.5"),
    ] {
        assert_eq!(py_float(f), want);
    }
}

#[test]
fn clamp_patch_cases() {
    let base: Params = [
        ("a".to_string(), Param::Int(500)),
        ("b".to_string(), Param::Float(0.3)),
        ("z".to_string(), Param::Int(0)),
        ("f".to_string(), Param::Float(0.0)),
        ("n".to_string(), Param::Float(-1.0)),
    ]
    .into();
    let out = clamp_patch(
        &base,
        &[
            ("a".into(), 9000.0),
            ("b".into(), 0.0),
            ("z".into(), -3.0),
            ("f".into(), 7.0),
            ("n".into(), -5.0),
            ("unknown".into(), 1.0),
        ],
        0.2,
    );
    assert_eq!(out["a"], Param::Int(600));
    assert_eq!(out["b"], Param::Float(0.3 * 0.8));
    assert_eq!(out["z"], Param::Int(-1));
    assert_eq!(out["f"], Param::Float(0.2));
    assert_eq!(out["n"], Param::Float(-1.2));
    assert!(!out.contains_key("unknown"));
}
