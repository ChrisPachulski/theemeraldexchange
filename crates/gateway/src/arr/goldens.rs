//! Replays tests/fixtures/arr-goldens.json through [`crate::router`]. The
//! generator (gen-arr-goldens.ts) ran the untouched TS radarr/sab/grabs
//! routes against a fixture-driven fake; here each scenario runs on a fresh
//! state against the Rust copy of that fake, and every step must give the
//! same status, Content-Type, Retry-After and body (JSON compared as values,
//! numbers as JS numbers; anything else byte for byte), the same ordered
//! upstream requests, and the same grabs.jsonl lines byte for byte (the "ts"
//! normalized to <ts> on both sides).
//!
//! Known edge deltas (implementation-notes Deviations): Hono's text 404 for an
//! unknown path or a known path's wrong method is the gateway's JSON
//! `{"error":"not_found"}`. The folder and profile lists are fetched together
//! on both sides, so that adjacent pair is compared in a fixed order.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use regex::Regex;
use serde_json::Value;

use super::fake::{Call, Fake, Route};
use super::shared::Timings;
use crate::testutil::*;

fn goldens() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/arr-goldens.json")).unwrap()
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

fn ct(v: Option<&str>) -> Option<String> {
    v.map(|s| s.split(';').next().unwrap().trim().to_ascii_lowercase())
}

fn golden_call(c: &Value) -> Call {
    let s = |k: &str| c[k].as_str().map(String::from);
    Call {
        method: s("method").unwrap(),
        path: s("path").unwrap(),
        query: s("query").unwrap(),
        body: norm(&c["body"]),
        key_header: s("key_header"),
        secret: s("secret"),
        bearer: c["bearer"].as_bool().unwrap(),
    }
}

/// The folder and profile lookups race each other on both sides.
fn canonical(mut calls: Vec<Call>) -> Vec<Call> {
    for c in &mut calls {
        c.body = norm(&c.body);
    }
    for i in 1..calls.len() {
        let (a, b) = (&calls[i - 1].path, &calls[i].path);
        if a.ends_with("/qualityprofile") && b.ends_with("/rootfolder") {
            calls.swap(i - 1, i);
        }
    }
    calls
}

#[tokio::test]
async fn replays_the_ts_arr_goldens() {
    let g = goldens();
    let fake = Fake::start(vec![]).await;
    let ts = Regex::new(r#""ts":"[^"]*""#).unwrap();
    let ms = Regex::new(r#""retry_after_ms":\d+"#).unwrap();
    let mut failures = vec![];

    for sc in g["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let routes: Vec<Route> = serde_json::from_value(sc["upstream"].clone()).unwrap();
        fake.set_routes(routes);
        let dir = tempfile::tempdir().unwrap();
        let p = |f: &str| dir.path().join(f).to_str().unwrap().to_string();
        std::fs::write(p("policies.json"), g["policies"].as_str().unwrap()).unwrap();
        let grab_path = p("grabs.jsonl");
        if let Some(seed) = sc["grabs_seed"].as_str() {
            std::fs::write(&grab_path, seed).unwrap();
        }
        let urls = [
            ("RADARR_URL", format!("{}/radarr", fake.url)),
            ("SAB_URL", format!("{}/sab", fake.url)),
            ("RECOMMENDER_URL", format!("{}/rec", fake.url)),
            ("USER_POLICIES_PATH", p("policies.json")),
            ("USER_FEEDBACK_PATH", p("feedback.json")),
            ("REJECTIONS_PATH", p("rejections.json")),
            ("USER_WATCHLIST_PATH", p("watchlist.json")),
            ("GRAB_LOG_PATH", grab_path.clone()),
        ];
        let mut env: Vec<(&str, &str)> = g["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str().unwrap()))
            .collect();
        env.extend(urls.iter().map(|(k, v)| (*k, v.as_str())));
        env.extend(
            sc["env"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str().unwrap())),
        );
        let mut st = state_in(&dir, &env).await;
        let timings = Timings {
            settle: Duration::ZERO,
            ..Timings::default()
        };
        st.arr = Arc::new(super::ArrState::new(&st.config, timings));
        let app = crate::router(st.clone());
        let mut cookies = std::collections::HashMap::new();
        for (who, m) in g["members"].as_object().unwrap() {
            let (sub, user, role) = (
                m["sub"].as_str().unwrap(),
                m["username"].as_str().unwrap(),
                m["role"].as_str().unwrap(),
            );
            cookies.insert(who.clone(), member(&st, sub, user, role).await);
        }

        for s in sc["steps"].as_array().unwrap() {
            let step = format!("{name} / {}", s["name"].as_str().unwrap());
            let method = s["method"].as_str().unwrap_or("GET");
            let path = s["path"].as_str().unwrap();
            let before = std::fs::read_to_string(&grab_path).unwrap_or_default();
            let mut statuses = vec![];
            let mut reply = None;
            for _ in 0..s["repeat"].as_u64().unwrap_or(1) {
                let mut b = Request::builder().method(method).uri(path);
                if let Some(who) = s["as"].as_str() {
                    b = b.header("cookie", &cookies[who]);
                }
                if method != "GET" {
                    b = b.header("origin", "https://app.example");
                }
                let req = match s["request_body"].as_str() {
                    Some(text) => b
                        .header("content-type", "application/json")
                        .body(Body::from(text.to_string())),
                    None => b.body(Body::empty()),
                };
                let r = send(&app, req.unwrap()).await;
                statuses.push(r.status.as_u16());
                reply = Some(r);
            }
            let r = reply.unwrap();
            if method == "POST" && path == "/api/radarr/api/v3/movie" {
                fake.quiet().await;
            }
            let after = std::fs::read_to_string(&grab_path).unwrap_or_default();
            let got_grabs: Vec<String> = after[before.len()..]
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| ts.replace(l, r#""ts":"<ts>""#).into_owned())
                .collect();
            let got_body = ms
                .replace_all(&r.body, r#""retry_after_ms":"<ms>""#)
                .into_owned();
            let got_ct = r
                .headers
                .get("content-type")
                .map(|v| v.to_str().unwrap().to_string());
            let got_retry = r
                .headers
                .get("retry-after")
                .map(|v| v.to_str().unwrap().to_string());

            let want_status = s["status"].as_u64().unwrap() as u16;
            let mut want_body = s["body"].as_str().unwrap().to_string();
            let mut want_ct = s["content_type"].as_str().map(String::from);
            if want_status == 404 && want_body == "404 Not Found" {
                want_body = r#"{"error":"not_found"}"#.into();
                want_ct = Some("application/json".into());
            }
            let mut problems = vec![];
            if r.status.as_u16() != want_status {
                problems.push(format!("status {} != {want_status}", r.status));
            }
            if let Some(want) = s["statuses"].as_array() {
                let want: Vec<u16> = want.iter().map(|v| v.as_u64().unwrap() as u16).collect();
                if statuses != want {
                    problems.push(format!("statuses {statuses:?} != {want:?}"));
                }
            }
            if ct(got_ct.as_deref()) != ct(want_ct.as_deref()) {
                problems.push(format!("content-type {got_ct:?} != {want_ct:?}"));
            }
            if got_retry.as_deref() != s["retry_after"].as_str() {
                problems.push(format!(
                    "retry-after {got_retry:?} != {:?}",
                    s["retry_after"]
                ));
            }
            if !same_body(&want_body, &got_body) {
                problems.push(format!("body\n    got  {got_body}\n    want {want_body}"));
            }
            let want_calls = canonical(
                s["calls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(golden_call)
                    .collect(),
            );
            let got_calls = canonical(fake.take());
            if got_calls != want_calls {
                problems.push(format!(
                    "calls\n    got  {got_calls:#?}\n    want {want_calls:#?}"
                ));
            }
            let want_grabs: Vec<String> = s["grabs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            if got_grabs != want_grabs {
                problems.push(format!(
                    "grabs\n    got  {got_grabs:#?}\n    want {want_grabs:#?}"
                ));
            }
            if !problems.is_empty() {
                failures.push(format!("{step}:\n  {}", problems.join("\n  ")));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} steps differ:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
