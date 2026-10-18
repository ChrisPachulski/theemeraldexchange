//! Replays tmdb-goldens.json (gen-tmdb-goldens.ts: the untouched TS
//! /api/tmdb and /api/ratings routes against a local fake TMDB, OMDb,
//! Wikidata, RT and googlevideo, with the stub binaries) through
//! [`crate::router`] against the Rust copy of the fake and the same stubs.
//! Each scenario gets a fresh state; every step must give the same status,
//! Content-Type, Content-Range and body (JSON compared as values, numbers as
//! JS numbers; binary bodies by length and byte sum), the same requests at
//! the fake (as a multiset: the trailer's two streams and the ratings fills
//! run concurrently on both sides) and the same stub argv lines. The fake's
//! hit list is the proof that nothing else was contacted.
//!
//! The ratings synchronous wait runs as 400 ms on both sides (the generator
//! patches the TS 6 s timer).

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use regex::Regex;
use serde_json::Value;
use tower::ServiceExt;

use super::fake::{Call, Fake, Route, Stubs};
use crate::AppState;
use crate::testutil::{add_member, config, cookie};

fn goldens() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/tmdb-goldens.json")).unwrap()
}

/// Numbers as JS numbers, so 10 and 10.0 compare equal.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => serde_json::Number::from_f64(n.as_f64().unwrap())
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn same_body(want: &str, got: &str) -> bool {
    match (
        serde_json::from_str::<Value>(want),
        serde_json::from_str::<Value>(got),
    ) {
        (Ok(a), Ok(b)) => norm(&a) == norm(&b),
        _ => want == got,
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn replays_the_ts_tmdb_and_ratings_goldens() {
    let g = goldens();
    let fake = Fake::start(vec![]).await;
    let token = Regex::new(r"([?&]t=)[A-Za-z0-9_.-]+").unwrap();
    let trailer_id = Regex::new(r"/trailer/[^/]+/").unwrap();
    let mut failures = vec![];

    for sc in g["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let stubs = Stubs::new();
        let mux = stubs.mux_dir().to_str().unwrap().to_string();
        let normalize = |s: &str| {
            let s = s.replace(&fake.url, "{GV}").replace(&mux, "<mux>");
            token.replace_all(&s, "${1}<token>").into_owned()
        };
        for (id, body) in sc["resolve"].as_object().unwrap() {
            stubs.resolve(
                id,
                &format!("{}\n", body.to_string().replace("{GV}", &fake.url)),
            );
        }
        for (id, text) in sc["ytdlp"].as_object().unwrap() {
            stubs.ytdlp(id, text.as_str().unwrap());
        }
        let routes: Vec<Route> = serde_json::from_value(sc["upstream"].clone()).unwrap();
        fake.set_routes(routes);
        fake.take();

        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("server.db").to_str().unwrap().to_string();
        let mut env: Vec<(String, String)> = g["env"]
            .as_object()
            .unwrap()
            .iter()
            .chain(sc["env"].as_object().unwrap())
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
            .collect();
        // Blank counts as unset in Config.
        for k in strs(&sc["unset"]) {
            env.retain(|(key, _)| *key != k);
            env.push((k, String::new()));
        }
        env.push(("SERVER_DB_PATH".into(), db));
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let mut cfg = config(&env);
        stubs.wire(&mut cfg.ext, &fake.url);
        let pool = auth::db::open(&cfg.auth.server_db_path).await.unwrap();
        let mut st = AppState::new(pool, cfg);
        st.ratings = Arc::new(crate::ratings::Ratings::new(Duration::from_millis(400)));
        let mut cookies = std::collections::HashMap::new();
        for (who, m) in g["members"].as_object().unwrap() {
            let (sub, user) = (m["sub"].as_str().unwrap(), m["username"].as_str().unwrap());
            add_member(&st, sub, user, m["role"].as_str().unwrap()).await;
            cookies.insert(who.clone(), cookie(&st, sub, user));
        }
        let now = chrono::Utc::now().timestamp_millis();
        for s in sc["seed"].as_array().unwrap() {
            sqlx::query(
                "INSERT INTO title_ratings (imdb_id, imdb, rt, rt_audience, metacritic, rt_slug, fetched_at) \
                 VALUES (?, ?, ?, ?, ?, NULL, ?)",
            )
            .bind(s["imdb_id"].as_str())
            .bind(s["imdb"].as_f64())
            .bind(s["rt"].as_f64())
            .bind(s["rt_audience"].as_f64())
            .bind(s["metacritic"].as_f64())
            .bind(now - s["age_ms"].as_i64().unwrap())
            .execute(&st.auth.pool)
            .await
            .unwrap();
        }
        let app = crate::router(st);

        let mut last_url: Option<String> = None;
        for step in sc["steps"].as_array().unwrap() {
            let sname = step["name"].as_str().unwrap();
            if let Some(ms) = step["wait_ms"].as_u64() {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            let path = match step.get("from_url") {
                Some(from) => {
                    let mut u = reqwest::Url::parse(last_url.as_deref().unwrap()).unwrap();
                    if let Some(id) = from["id"].as_str() {
                        let p = trailer_id
                            .replace(u.path(), format!("/trailer/{id}/").as_str())
                            .into_owned();
                        u.set_path(&p);
                    }
                    if let Some(t) = from["token"].as_str() {
                        u.set_query(Some(&format!("t={t}")));
                    }
                    format!("{}?{}", u.path(), u.query().unwrap_or_default())
                }
                None => step["path"].as_str().unwrap().to_string(),
            };
            let mut req = Request::get(&path);
            if let Some(who) = step["as"].as_str() {
                req = req.header("cookie", &cookies[who]);
            }
            if let Some(range) = step["range"].as_str() {
                req = req.header("range", range);
            }
            let res = app
                .clone()
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            let status = res.status().as_u16();
            let header = |k: &str| {
                res.headers()
                    .get(k)
                    .map(|v| v.to_str().unwrap().to_string())
            };
            let (ct, cr) = (header("content-type"), header("content-range"));
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            fake.quiet().await;
            let text_ct = ct
                .as_deref()
                .is_none_or(|c| c.contains("json") || c.contains("text"));
            let text = text_ct.then(|| String::from_utf8_lossy(&bytes).into_owned());
            if let Some(t) = &text
                && status == 200
                && let Ok(v) = serde_json::from_str::<Value>(t)
                && let Some(u) = v["url"].as_str()
                && u.contains("/stream.mp4?t=")
            {
                last_url = Some(u.to_string());
            }
            let sum = bytes
                .iter()
                .fold(0u64, |a, b| (a + u64::from(*b)) % 4_294_967_296);
            let mut want_calls: Vec<Call> = serde_json::from_value(step["calls"].clone()).unwrap();
            let mut got_calls: Vec<Call> = fake
                .take()
                .into_iter()
                .map(|c| Call {
                    query: normalize(&c.query),
                    ..c
                })
                .collect();
            want_calls.sort();
            got_calls.sort();
            let bins = |stub: &str| -> Vec<String> {
                stubs.take(stub).iter().map(|l| normalize(l)).collect()
            };

            let mut diffs = vec![];
            if status != step["status"].as_u64().unwrap() as u16 {
                diffs.push(format!("status {} != {}", status, step["status"]));
            }
            if ct.as_deref() != step["content_type"].as_str() {
                diffs.push(format!("content-type {ct:?} != {}", step["content_type"]));
            }
            if cr.as_deref() != step["content_range"].as_str() {
                diffs.push(format!("content-range {cr:?} != {}", step["content_range"]));
            }
            match (step["body"].as_str(), &text) {
                (Some(want), Some(got)) if same_body(want, &normalize(got)) => {}
                (None, None) => {}
                (want, got) => diffs.push(format!("body {got:?} != {want:?}")),
            }
            if bytes.len() as u64 != step["body_len"].as_u64().unwrap() && text.is_none() {
                diffs.push(format!("body_len {} != {}", bytes.len(), step["body_len"]));
            }
            if sum != step["body_sum"].as_u64().unwrap() && text.is_none() {
                diffs.push(format!("body_sum {sum} != {}", step["body_sum"]));
            }
            if got_calls != want_calls {
                diffs.push(format!("calls {got_calls:#?} != {want_calls:#?}"));
            }
            for stub in ["ytresolve", "ytdlp", "ffmpeg"] {
                let (got, want) = (bins(stub), strs(&step[stub]));
                if got != want {
                    diffs.push(format!("{stub} {got:?} != {want:?}"));
                }
            }
            if !diffs.is_empty() {
                failures.push(format!("[{name}] {sname}:\n  {}", diffs.join("\n  ")));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
