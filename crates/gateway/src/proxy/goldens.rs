//! Replays proxy-goldens.json (gen-proxy-goldens.ts: the untouched TS
//! /api/media, /api/transcode, /api/iptv, /api/dvr, /api/account and
//! /api/telemetry routes against a local fake media-core, transcoder, iptv
//! service, Radarr, Sonarr, recommender and Glitchtip) through
//! [`crate::router`] against the Rust copy of the fake. Each scenario gets a
//! fresh state and fake; every step must give the same status, proxy
//! headers, body (JSON compared as values; binary bodies by length and byte
//! sum) and the same ordered requests at the fake: method, path, query,
//! decrypted principal, forwarded headers and body. Abort steps compare the
//! fake's open-socket count during and after a client hang-up; account
//! scenarios compare server.db and the JSON stores afterwards.
//!
//! Documented deltas: a 504's `message` (the runtime's own error text) is not
//! compared, nor a 429's `retry_after_ms` and Retry-After value (timing);
//! Hono's text 404 is the gateway's JSON 404; undici's own Accept-Encoding
//! is dropped unless the client sent one.

use std::collections::BTreeMap;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use regex::Regex;
use serde_json::{Value, json};
use sqlx::ConnectOptions;
use sqlx::sqlite::SqliteConnectOptions;
use tower::ServiceExt;

use super::fake::{Call, Fake, Route};
use crate::AppState;
use crate::testutil::cookie;

fn goldens() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/proxy-goldens.json")).unwrap()
}

/// Numbers as JS numbers, so 10 and 10.0 compare equal.
fn norm_json(v: &Value) -> Value {
    match v {
        Value::Number(n) => serde_json::Number::from_f64(n.as_f64().unwrap())
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Value::Array(a) => Value::Array(a.iter().map(norm_json).collect()),
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), norm_json(v))).collect())
        }
        other => other.clone(),
    }
}

fn same_text(want: &str, got: &str) -> bool {
    match (
        serde_json::from_str::<Value>(want),
        serde_json::from_str::<Value>(got),
    ) {
        (Ok(a), Ok(b)) => norm_json(&a) == norm_json(&b),
        _ => want == got,
    }
}

const KEPT: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
    "x-accel-buffering",
    "content-encoding",
    "set-cookie",
    "retry-after",
    "x-secret",
];

struct Norm {
    fake: String,
    token: Regex,
    loopback: Regex,
}

impl Norm {
    fn s(&self, s: &str) -> String {
        let s = s.replace(&self.fake, "{FAKE}");
        let s = self.token.replace_all(&s, "${1}<token>");
        self.loopback.replace_all(&s, "<loopback>").into_owned()
    }

    fn call(&self, c: &Call, sent_accept_encoding: bool) -> Value {
        let mut headers: BTreeMap<String, String> = c
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), self.s(v)))
            .collect();
        if !sent_accept_encoding {
            headers.remove("accept-encoding");
        }
        let body = String::from_utf8_lossy(&c.body).into_owned();
        let mut v = json!({
            "method": c.method,
            "path": self.s(&c.path),
            "query": self.s(&format!("?{}", c.query))[1..],
            "principal": c.principal,
            "headers": headers,
        });
        if body.len() > 4096 {
            v["body"] = Value::Null;
            v["body_len"] = c.body.len().into();
            v["body_sum"] = sum(&c.body).into();
        } else {
            v["body"] = self.s(&body).into();
        }
        v
    }
}

fn sum(b: &[u8]) -> u64 {
    b.iter()
        .fold(0u64, |a, x| (a + u64::from(*x)) % 4_294_967_296)
}

/// A golden call, comparable with [`Norm::call`] (bodies as JSON values).
fn same_call(want: &Value, got: &Value) -> bool {
    let mut w = want.clone();
    let mut g = got.clone();
    let (wb, gb) = (w["body"].take(), g["body"].take());
    let bodies = match (wb.as_str(), gb.as_str()) {
        (Some(a), Some(b)) => same_text(a, b),
        _ => wb == gb,
    };
    bodies && norm_json(&w) == norm_json(&g)
}

const SECRET_KEY: &str = "INTERNAL_PRINCIPAL_SECRET";

async fn state_for(g: &Value, sc: &Value, fake: &Fake, dir: &tempfile::TempDir) -> AppState {
    let p = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
    let media_db = p("media.db");
    {
        let mut c = SqliteConnectOptions::new()
            .filename(&media_db)
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        for sql in g["media_sql"].as_array().unwrap() {
            sqlx::query(sqlx::AssertSqlSafe(sql.as_str().unwrap().to_string()))
                .execute(&mut c)
                .await
                .unwrap();
        }
    }
    let fake_dsn = format!(
        "http://pubkey@{}/42",
        fake.url.trim_start_matches("http://")
    );
    let mut env: BTreeMap<String, String> = g["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect();
    for (k, v) in [
        ("SERVER_DB_PATH", p("server.db")),
        ("MEDIA_DB_PATH", media_db.clone()),
        ("USER_POLICIES_PATH", p("policies.json")),
        ("USER_FEEDBACK_PATH", p("feedback.json")),
        ("USER_WATCHLIST_PATH", p("watchlist.json")),
        ("REJECTIONS_PATH", p("rejections.json")),
        ("MEDIA_CORE_URL", format!("{}/mc", fake.url)),
        ("MEDIA_TRANSCODER_URL", format!("{}/tc", fake.url)),
        ("IPTV_SERVICE_URL", format!("{}/iptv", fake.url)),
        ("RADARR_URL", format!("{}/radarr", fake.url)),
        ("SONARR_URL", format!("{}/sonarr", fake.url)),
        ("RECOMMENDER_URL", format!("{}/rec", fake.url)),
    ] {
        env.insert(k.into(), v);
    }
    for (k, v) in sc["env"].as_object().unwrap() {
        let v = v.as_str().unwrap();
        env.insert(
            k.clone(),
            if v == "{FAKE_DSN}" {
                fake_dsn.clone()
            } else {
                v.into()
            },
        );
    }
    let pairs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let config = crate::testutil::config(&pairs);
    let pool = auth::db::open(&config.auth.server_db_path).await.unwrap();
    let st = AppState::new(pool, config);
    for m in g["members"].as_object().unwrap().values() {
        let sub = m["sub"].as_str().unwrap();
        sqlx::query(
            "INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at) \
             VALUES (?, ?, ?, ?, NULL, '2026-01-01T00:00:00.000Z', NULL)",
        )
        .bind(sub)
        .bind(m["username"].as_str().unwrap())
        .bind(m["role"].as_str().unwrap())
        .bind(sub.split(':').next().unwrap())
        .execute(&st.auth.pool)
        .await
        .unwrap();
    }
    for sql in sc["seed_sql"].as_array().unwrap() {
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str().unwrap().to_string()))
            .execute(&st.auth.pool)
            .await
            .unwrap();
    }
    if !sc["seed_sql"].as_array().unwrap().is_empty() {
        for name in ["policies", "feedback", "watchlist"] {
            std::fs::write(
                p(&format!("{name}.json")),
                g["account_stores"][name].to_string(),
            )
            .unwrap();
        }
    } else if !sc["policies"].as_object().unwrap().is_empty() {
        std::fs::write(p("policies.json"), sc["policies"].to_string()).unwrap();
    }
    st
}

fn mint(g: &Value, spec: &Value) -> String {
    let who = spec["who"].as_str().unwrap();
    let sub = g["members"][who]["sub"].as_str().unwrap_or(who);
    let kind =
        emerald_contracts::stream_token::StreamKind::from_wire(spec["kind"].as_str().unwrap())
            .unwrap();
    crate::media_token::sign(
        g["env"]["STREAM_TOKEN_SECRET"].as_str().unwrap(),
        sub,
        spec["rid"].as_str().unwrap(),
        kind,
        300,
    )
}

/// Serve the gateway on a socket, read one chunk, hang up; the fake's
/// open sockets during and after.
async fn abort_run(st: &AppState, fake: &Fake, path: &str, headers: &[(String, String)]) -> Value {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = crate::router(st.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let mut req = client.get(format!("http://{addr}{path}"));
    for (k, v) in headers {
        if !k.eq_ignore_ascii_case("host") {
            req = req.header(k, v);
        }
    }
    let mut res = req.send().await.unwrap();
    let status = res.status().as_u16();
    res.chunk().await.unwrap().expect("a first chunk");
    let during = fake.open();
    drop(res);
    drop(client);
    let mut waited = 0;
    while fake.open() > 0 && waited < 3000 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        waited += 50;
    }
    let after = fake.open();
    server.abort();
    json!({ "status": status, "open_during": during, "open_after": after })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replays_the_ts_proxy_goldens() {
    let g = goldens();
    let secret = g["env"][SECRET_KEY].as_str().unwrap().to_string();
    let mut failures = vec![];
    let token_re = Regex::new(r"([?&]t=|[?&]u=)[A-Za-z0-9_.-]{20,}").unwrap();
    let loopback_re = Regex::new(r"127\.0\.0\.1:\d+").unwrap();

    for sc in g["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let fake = Fake::start(&secret).await;
        let norm = Norm {
            fake: fake.url.clone(),
            token: token_re.clone(),
            loopback: loopback_re.clone(),
        };
        fake.set_routes(serde_json::from_value::<Vec<Route>>(sc["upstream"].clone()).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let st = state_for(&g, sc, &fake, &dir).await;
        let app = crate::router(st.clone());
        let mut last_url: Option<String> = None;

        for step in sc["steps"].as_array().unwrap() {
            let sname = step["name"].as_str().unwrap();
            let label = format!("{name} / {sname}");
            if let Some(who) = step["revoke"].as_str() {
                sqlx::query(
                    "UPDATE members SET revoked_at = '2026-01-02T00:00:00.000Z' WHERE sub = ?",
                )
                .bind(g["members"][who]["sub"].as_str().unwrap())
                .execute(&st.auth.pool)
                .await
                .unwrap();
            }
            let mut path = step["path"].as_str().unwrap_or_default().to_string();
            if step["token"].is_object() {
                path = path.replace("{token}", &mint(&g, &step["token"]));
            }
            if step["from_url"] == true {
                path = last_url.clone().expect("a previous url");
            }
            let mut headers: Vec<(String, String)> = vec![
                ("origin".into(), "https://app.example".into()),
                ("host".into(), "localhost".into()),
            ];
            let mut sent_ae = false;
            for (k, v) in step["headers_in"].as_object().into_iter().flatten() {
                sent_ae |= k.eq_ignore_ascii_case("accept-encoding");
                headers.retain(|(h, _)| !h.eq_ignore_ascii_case(k));
                headers.push((k.to_lowercase(), v.as_str().unwrap().into()));
            }
            if let Some(who) = step["as"].as_str() {
                let sub = g["members"][who]["sub"].as_str().unwrap();
                headers.push(("cookie".into(), cookie(&st, sub, who)));
            }
            let body: Option<String> = step["body_in"].as_str().map(String::from).or_else(|| {
                step["fill"].as_object().map(|f| {
                    let head = f["head"].as_str().unwrap();
                    let total = f["total"].as_u64().unwrap() as usize;
                    format!(
                        "{head}{}",
                        f["ch"].as_str().unwrap().repeat(total - head.len())
                    )
                })
            });
            // The Fetch Request constructor's default for a string body.
            if body.is_some() && !headers.iter().any(|(k, _)| k == "content-type") {
                headers.push(("content-type".into(), "text/plain;charset=UTF-8".into()));
            }

            if step["abort"].is_object() {
                let got = abort_run(&st, &fake, &path, &headers).await;
                let calls: Vec<Value> = fake
                    .settle()
                    .await
                    .iter()
                    .map(|c| norm.call(c, sent_ae))
                    .collect();
                if got != step["abort"] {
                    failures.push(format!("{label}: abort {got} != {}", step["abort"]));
                }
                compare_calls(&label, step, &calls, &mut failures);
                continue;
            }

            let method = step["method"].as_str().unwrap_or("GET");
            let mut b = Request::builder().method(method).uri(&path);
            for (k, v) in &headers {
                b = b.header(k, v);
            }
            let req = b.body(body.map_or_else(Body::empty, Body::from)).unwrap();
            let res = app.clone().oneshot(req).await.unwrap();
            let status = res.status().as_u16();
            let res_headers = res.headers().clone();
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            let calls: Vec<Value> = fake
                .settle()
                .await
                .iter()
                .map(|c| norm.call(c, sent_ae))
                .collect();

            if status != step["status"].as_u64().unwrap() as u16 {
                failures.push(format!("{label}: status {status} != {}", step["status"]));
            }
            let want_body = step["body"].as_str();
            let hono_404 = want_body == Some("404 Not Found");
            // Headers, both ways over the kept list.
            for h in KEPT {
                let want = step["headers"][*h].as_str().map(String::from);
                let got = res_headers.get(*h).map(|v| norm.s(v.to_str().unwrap()));
                let ok = match *h {
                    "retry-after" => want.is_some() == got.is_some(),
                    "content-type" if hono_404 => got.as_deref() == Some("application/json"),
                    "content-length" if want.is_none() => true,
                    _ => want == got,
                };
                if !ok {
                    failures.push(format!("{label}: header {h} {got:?} != {want:?}"));
                }
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            match want_body {
                Some(_) if hono_404 => {
                    if text != r#"{"error":"not_found"}"# {
                        failures.push(format!("{label}: body {text} != the JSON 404"));
                    }
                }
                Some(want) => {
                    let mut w: Value = serde_json::from_str(want).unwrap_or(Value::Null);
                    let mut gv: Value = serde_json::from_str(&norm.s(&text)).unwrap_or(Value::Null);
                    let ok = if w.is_null() {
                        norm.s(&text) == want
                    } else {
                        for v in [&mut w, &mut gv] {
                            if let Some(o) = v.as_object_mut() {
                                if status == 504 {
                                    o.remove("message");
                                }
                                o.remove("retry_after_ms");
                            }
                        }
                        norm_json(&w) == norm_json(&gv)
                    };
                    if !ok {
                        failures.push(format!("{label}: body {} != {want}", norm.s(&text)));
                    }
                    if status == 200
                        && let Some(u) = serde_json::from_str::<Value>(&text)
                            .ok()
                            .and_then(|v| v["url"].as_str().map(String::from))
                    {
                        last_url = Some(u);
                    }
                }
                None => {
                    let (len, s) = (bytes.len() as u64, sum(&bytes));
                    if len != step["body_len"].as_u64().unwrap()
                        || s != step["body_sum"].as_u64().unwrap()
                    {
                        failures.push(format!(
                            "{label}: body len/sum {len}/{s} != {}/{}",
                            step["body_len"], step["body_sum"]
                        ));
                    }
                }
            }
            compare_calls(&label, step, &calls, &mut failures);
        }

        if sc["state"].is_object() {
            let mut sql = vec![];
            for q in sc["state_sql"].as_array().unwrap() {
                let v: Option<String> =
                    sqlx::query_scalar(sqlx::AssertSqlSafe(q.as_str().unwrap().to_string()))
                        .fetch_one(&st.auth.pool)
                        .await
                        .unwrap();
                sql.push(v);
            }
            let read = |n: &str| {
                std::fs::read_to_string(dir.path().join(format!("{n}.json")))
                    .ok()
                    .map_or(Value::Null, |t| serde_json::from_str(&t).unwrap())
            };
            let got = json!({
                "sql": sql,
                "policies": read("policies"),
                "feedback": read("feedback"),
                "watchlist": read("watchlist"),
            });
            if norm_json(&got) != norm_json(&sc["state"]) {
                failures.push(format!("{name}: state {got} != {}", sc["state"]));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn compare_calls(label: &str, step: &Value, got: &[Value], failures: &mut Vec<String>) {
    let want = step["calls"].as_array().unwrap();
    if want.len() != got.len() || !want.iter().zip(got).all(|(w, g)| same_call(w, g)) {
        failures.push(format!(
            "{label}: calls\n  got  {}\n  want {}",
            Value::Array(got.to_vec()),
            Value::Array(want.clone())
        ));
    }
}
