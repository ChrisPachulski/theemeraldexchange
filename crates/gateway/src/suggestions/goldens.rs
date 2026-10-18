//! Replays suggestions-goldens.json (gen-suggestions-goldens.ts):
//!
//! * the prompt builders and title/genre helpers against the TS text, exactly;
//! * every route scenario through [`crate::router`] against the Rust copy of
//!   the fake, each with a fresh state: per step the same status,
//!   Content-Type, Server-Timing phase names and body (JSON as values,
//!   numbers as JS numbers), the same requests at the fake (a multiset: TMDB
//!   pages and lookups run concurrently on both sides), the same usage.jsonl
//!   lines (minus ts) and the same rejections/feedback files.
//!
//! Normalized on both sides: today's date, the salt, a principal Bearer, and
//! the shuffled CANDIDATE POOL lines (sorted, unnumbered). The Claude
//! deadline runs as 1.5 s and the transient-retry wait as 0, as in the
//! generator.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use futures_util::future::join_all;
use regex::Regex;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::fake::{Call, Fake, Route};
use super::prompt;
use super::{Item, LibItem, Suggestions, Timings};
use crate::AppState;
use crate::stores::{IdTitle, Kind};
use crate::testutil::{add_member, config, cookie};

fn goldens() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/suggestions-goldens.json"
    ))
    .unwrap()
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

fn libs(v: &Value) -> Vec<LibItem> {
    v.as_array()
        .unwrap()
        .iter()
        .map(LibItem::from_value)
        .collect()
}

fn entries(v: &Value) -> Vec<IdTitle> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|e| IdTitle {
            id: e["id"].as_u64().unwrap(),
            title: e["title"].as_str().unwrap().into(),
        })
        .collect()
}

fn kind(v: &Value) -> Kind {
    Kind::parse(v.as_str().unwrap()).unwrap()
}

#[test]
fn prompt_builders_match_the_ts_text() {
    let g = goldens();
    let p = &g["prompts"];
    let mut failures = vec![];
    let mut check = |what: &str, got: Value, want: &Value| {
        if &got != want {
            failures.push(format!("{what}:\n  got  {got}\n  want {want}"));
        }
    };
    for c in p["genre_distribution"].as_array().unwrap() {
        let n = c["n"].as_u64().unwrap() as usize;
        check(
            "genre_distribution",
            json!(prompt::compute_genre_distribution(&libs(&c["library"]), n)),
            &c["out"],
        );
    }
    for c in p["library_block"].as_array().unwrap() {
        let got = prompt::build_library_block(
            kind(&c["kind"]),
            &libs(&c["library"]),
            &entries(&c["rejections"]),
        );
        check("library_block", got.into(), &c["out"]);
    }
    for c in p["likes_block"].as_array().unwrap() {
        check(
            "likes_block",
            prompt::build_user_likes_block(&entries(&c["liked"])).into(),
            &c["out"],
        );
    }
    for c in p["priority_block"].as_array().unwrap() {
        check(
            "priority_block",
            prompt::build_priority_taste_block(&libs(&c["library"])).into(),
            &c["out"],
        );
    }
    for c in p["pool_block"].as_array().unwrap() {
        let items: Vec<Item> = c["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| Item {
                id: v["id"].as_i64().unwrap(),
                title: v["title"].as_str().unwrap().into(),
                year: v["year"].as_i64(),
                ..Item::default()
            })
            .collect();
        check(
            "pool_block",
            prompt::build_candidate_pool_block(&items).into(),
            &c["out"],
        );
    }
    for c in p["recently_shown_block"].as_array().unwrap() {
        check(
            "recently_shown_block",
            prompt::build_recently_shown_block(&entries(&c["items"])).into(),
            &c["out"],
        );
    }
    for c in p["titles"].as_array().unwrap() {
        let t = c["title"].as_str().unwrap();
        let got = json!({ "title": t, "normalized": super::normalize_title(t), "base": super::normalize_title_base(t) });
        check("titles", got, c);
    }
    for c in p["title_matches"].as_array().unwrap() {
        let set_titles: Vec<&str> = c["set"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
            .collect();
        let set = super::title_set(set_titles, c["include_base"].as_bool().unwrap());
        let pick = c["pick"].as_str().unwrap();
        check(
            &format!("title_matches {pick:?} in {}", c["set"]),
            super::title_matches(pick, &set).into(),
            &c["out"],
        );
    }
    for c in p["top_genres"].as_array().unwrap() {
        check(
            "top_genres",
            json!(super::tmdb::top_genre_names(&libs(&c["library"]), 5)),
            &c["out"],
        );
    }
    for c in p["genre_ids"].as_array().unwrap() {
        let names: Vec<String> = c["names"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().into())
            .collect();
        check(
            "genre_ids",
            json!(super::tmdb::genre_ids(kind(&c["kind"]), &names)),
            &c["out"],
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The CANDIDATE POOL list sorted without numbers, the salt masked.
fn norm_anthropic(body: &Value, salt: &Regex) -> Value {
    let mut b = body.clone();
    let num = Regex::new(r"^\d+\. ").unwrap();
    if let Some(system) = b["system"].as_array_mut() {
        for block in system {
            let text = block["text"].as_str().unwrap_or_default().to_string();
            if text.starts_with("CANDIDATE POOL") {
                let (head, list) = text.split_once("\n\n").unwrap_or((&text, ""));
                let mut lines: Vec<String> = list
                    .split('\n')
                    .map(|l| num.replace(l, "").into_owned())
                    .collect();
                lines.sort();
                block["text"] = format!("{head}\n\n{}", lines.join("\n")).into();
            }
        }
    }
    if let Some(messages) = b["messages"].as_array_mut() {
        for m in messages {
            if let Some(s) = m["content"].as_str() {
                m["content"] = salt
                    .replace_all(s, "[Request salt: <salt>]")
                    .into_owned()
                    .into();
            }
        }
    }
    b
}

#[tokio::test]
async fn replays_the_ts_suggestions_goldens() {
    let g = goldens();
    let fake = Fake::start().await;
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let salt = Regex::new(r"\[Request salt: [0-9a-f]{16}\]").unwrap();
    let iso = Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$").unwrap();
    let norm_text = |s: &str| s.replace(&fake.url, "{FAKE}").replace(&today, "<today>");
    let norm_call = |c: &Call| -> String {
        let body = if c.path.starts_with("/anthropic") {
            norm_anthropic(&c.body, &salt)
        } else {
            c.body.clone()
        };
        let auth = c.authorization.as_deref().map(|a| {
            if a.starts_with("Bearer ey") {
                "Bearer <principal>".to_string()
            } else {
                a.to_string()
            }
        });
        let c = json!({
            "method": c.method, "path": c.path, "query": norm_text(&c.query), "body": body,
            "key": c.key, "authorization": auth, "secret": c.secret,
        });
        norm(&c).to_string()
    };
    let mut failures = vec![];

    for sc in g["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = |f: &str| dir.path().join(f).to_str().unwrap().to_string();
        let media_db = path("media.db");
        {
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&media_db)
                .create_if_missing(true);
            let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
            for t in ["movies", "shows"] {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "CREATE TABLE {t} (id INTEGER PRIMARY KEY AUTOINCREMENT, tmdb_id INTEGER UNIQUE, title TEXT NOT NULL, year INTEGER)"
                )))
                .execute(&pool)
                .await
                .unwrap();
                for r in g["media_db"][t].as_array().unwrap() {
                    sqlx::query(sqlx::AssertSqlSafe(format!(
                        "INSERT INTO {t} (tmdb_id, title, year) VALUES (?, ?, ?)"
                    )))
                    .bind(r["tmdb_id"].as_i64())
                    .bind(r["title"].as_str())
                    .bind(r["year"].as_i64())
                    .execute(&pool)
                    .await
                    .unwrap();
                }
            }
            pool.close().await;
        }
        let mut env: Vec<(String, String)> = g["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
            .collect();
        for (k, f) in [
            ("SERVER_DB_PATH", "server.db"),
            ("USER_FEEDBACK_PATH", "feedback.json"),
            ("REJECTIONS_PATH", "rejections.json"),
            ("USER_WATCHLIST_PATH", "watchlist.json"),
            ("USER_POLICIES_PATH", "policies.json"),
            ("USAGE_LOG_PATH", "usage.jsonl"),
        ] {
            env.push((k.into(), path(f)));
        }
        env.push(("MEDIA_DB_PATH".into(), media_db.clone()));
        for (k, p) in [
            ("SONARR_URL", "sonarr"),
            ("RADARR_URL", "radarr"),
            ("RECOMMENDER_URL", "rec"),
            ("IPTV_SERVICE_URL", "iptv"),
        ] {
            env.push((k.into(), format!("{}/{p}", fake.url)));
        }
        if sc["recommender"] == true {
            env.push(("USE_LOCAL_RECOMMENDER".into(), "1".into()));
        }
        match sc["tmdb"].as_str().unwrap_or("key") {
            "key" => env.push((
                "TMDB_API_KEY".into(),
                g["tmdb_key"].as_str().unwrap().into(),
            )),
            "token" => env.push((
                "TMDB_READ_ACCESS_TOKEN".into(),
                g["tmdb_token"].as_str().unwrap().into(),
            )),
            _ => {}
        }
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let mut cfg = config(&env);
        cfg.ext.tmdb_base = format!("{}/tmdb/3", fake.url);
        cfg.ext.anthropic_base = format!("{}/anthropic", fake.url);
        let pool = auth::db::open(&cfg.auth.server_db_path).await.unwrap();
        let mut st = AppState::new(pool, cfg);
        st.suggestions = Arc::new(Suggestions::new(Timings {
            claude_timeout: Duration::from_millis(1500),
            anthropic_retry_delay: Duration::ZERO,
            ..Timings::default()
        }));
        let mut cookies = HashMap::new();
        let mut subs = HashMap::new();
        for (who, m) in g["members"].as_object().unwrap() {
            let (sub, user) = (m["sub"].as_str().unwrap(), m["username"].as_str().unwrap());
            add_member(&st, sub, user, m["role"].as_str().unwrap()).await;
            cookies.insert(who.clone(), cookie(&st, sub, user));
            subs.insert(who.clone(), sub.to_string());
        }
        if let Some(r) = sc.get("rejections") {
            let file = json!({ "movie": r.get("movie").cloned().unwrap_or(json!([])), "tv": r.get("tv").cloned().unwrap_or(json!([])) });
            std::fs::write(path("rejections.json"), file.to_string()).unwrap();
        }
        if let Some(f) = sc.get("feedback") {
            let file: serde_json::Map<String, Value> = f
                .as_object()
                .unwrap()
                .iter()
                .map(|(who, v)| (subs[who].clone(), v.clone()))
                .collect();
            std::fs::write(path("feedback.json"), Value::Object(file).to_string()).unwrap();
        }
        let keys: Vec<String> = match sc.get("keys") {
            Some(k) => k
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_str().unwrap().into())
                .collect(),
            None => vec!["alice".into()],
        };
        for who in keys {
            let key = g["anthropic_key"].as_str().unwrap().replace("0001", &who);
            crate::stores::set_api_key(
                &st.auth.pool,
                &st.config.auth.session_secret,
                &subs[&who],
                &key,
            )
            .await
            .unwrap();
        }
        let routes: Vec<Route> = serde_json::from_value(sc["upstream"].clone()).unwrap();
        fake.set_routes(routes);
        fake.settle().await;
        let suggestions = st.suggestions.clone();
        let app = crate::router(st);
        let mut usage_seen = 0;

        for step in sc["steps"].as_array().unwrap() {
            let sname = step["name"].as_str().unwrap();
            if step["reset_library_cache"] == true {
                suggestions.drop_library_ttl();
            }
            let n = step["concurrent"].as_u64().unwrap_or(1) as usize;
            let reqs = (0..n).map(|_| {
                let mut req = Request::get(step["path"].as_str().unwrap());
                if let Some(who) = step["as"].as_str() {
                    req = req.header("cookie", &cookies[who]);
                }
                if let Some(o) = step["origin"].as_str() {
                    req = req.header("origin", o);
                }
                app.clone().oneshot(req.body(Body::empty()).unwrap())
            });
            let mut replies = vec![];
            for res in join_all(reqs).await {
                let res = res.unwrap();
                let header = |k: &str| {
                    res.headers()
                        .get(k)
                        .map(|v| v.to_str().unwrap().to_string())
                };
                let timing = header("server-timing").map(|h| {
                    h.split(", ")
                        .map(|e| e.split(';').next().unwrap().to_string())
                        .collect::<Vec<_>>()
                });
                let status = res.status().as_u16();
                let ct = header("content-type");
                let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                    .await
                    .unwrap();
                replies.push((
                    status,
                    ct,
                    timing,
                    norm_text(&String::from_utf8_lossy(&body)),
                ));
            }
            let got_calls = fake.settle().await;

            let mut diffs = vec![];
            for (i, want) in step["replies"].as_array().unwrap().iter().enumerate() {
                let (status, ct, timing, body) = &replies[i];
                if *status != want["status"].as_u64().unwrap() as u16 {
                    diffs.push(format!("status {status} != {}", want["status"]));
                }
                if ct.as_deref() != want["content_type"].as_str() {
                    diffs.push(format!("content-type {ct:?} != {}", want["content_type"]));
                }
                if json!(timing) != want["server_timing"] {
                    diffs.push(format!(
                        "server-timing {timing:?} != {}",
                        want["server_timing"]
                    ));
                }
                let (w, b) = (want["body"].as_str().unwrap(), body.as_str());
                let same = match (
                    serde_json::from_str::<Value>(w),
                    serde_json::from_str::<Value>(b),
                ) {
                    (Ok(a), Ok(b)) => norm(&a) == norm(&b),
                    _ => w == b,
                };
                if !same {
                    diffs.push(format!("body\n    got  {b}\n    want {w}"));
                }
            }
            let mut want_calls: Vec<String> = step["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| norm(c).to_string())
                .collect();
            let mut got: Vec<String> = got_calls.iter().map(norm_call).collect();
            want_calls.sort();
            got.sort();
            if got != want_calls {
                let missing: Vec<&String> =
                    want_calls.iter().filter(|c| !got.contains(c)).collect();
                let extra: Vec<&String> = got.iter().filter(|c| !want_calls.contains(c)).collect();
                diffs.push(format!(
                    "calls ({} vs {} want)\n    missing {missing:#?}\n    extra {extra:#?}",
                    got.len(),
                    want_calls.len()
                ));
            }
            let lines: Vec<String> = std::fs::read_to_string(path("usage.jsonl"))
                .unwrap_or_default()
                .lines()
                .map(String::from)
                .collect();
            let fresh: Vec<Value> = lines[usage_seen..]
                .iter()
                .map(|l| {
                    let mut v: Value = serde_json::from_str(l).unwrap();
                    let ts = v.as_object_mut().unwrap().remove("ts").unwrap();
                    assert!(iso.is_match(ts.as_str().unwrap()), "usage ts {ts}");
                    norm(&v)
                })
                .collect();
            usage_seen = lines.len();
            if json!(fresh) != norm(&step["usage"]) {
                diffs.push(format!("usage {} != {}", json!(fresh), step["usage"]));
            }
            for (store, file) in [
                ("rejections", "rejections.json"),
                ("feedback", "feedback.json"),
            ] {
                let got = std::fs::read_to_string(path(file))
                    .ok()
                    .map_or(Value::Null, |t| serde_json::from_str(&t).unwrap());
                if norm(&got) != norm(&step["stores"][store]) {
                    diffs.push(format!("{store} store {got} != {}", step["stores"][store]));
                }
            }
            if !diffs.is_empty() {
                failures.push(format!("[{name}] {sname}:\n  {}", diffs.join("\n  ")));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} failing steps:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
