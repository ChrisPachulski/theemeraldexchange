//! Replays tests/fixtures/stores-goldens.json through [`crate::router`]. The
//! generator (gen-stores-goldens.ts) ran the untouched TS app over the same
//! seeded store files with a local fake recommender; here every step must
//! give the same status, the same raw body, the same store file contents
//! (only the stores the step changed are recorded; the rest must not move),
//! the same recommender calls (as a sorted multiset: the mirrors race) and,
//! for settings, the same decrypted stored key. A step that makes a store's
//! directory read-only exercises the rollback paths on both sides.
//!
//! Per-run values are normalized on both sides: a syncplay group id becomes
//! <g1>, <g2>... in order of appearance, and an ISO timestamp from 2026 on
//! (a fresh watchlist added_at) becomes <now>.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use axum::body::Body;
use axum::http::Request;
use regex::Regex;
use serde_json::Value;

use crate::testutil::*;

fn goldens() -> Value {
    serde_json::from_str(include_str!("../tests/fixtures/stores-goldens.json")).unwrap()
}

struct Normalizer {
    groups: Vec<String>,
    now: Regex,
    uuid: Regex,
}

impl Normalizer {
    fn new() -> Normalizer {
        Normalizer {
            groups: vec![],
            now: Regex::new(r"\b20(2[6-9]|[3-9]\d)-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z").unwrap(),
            uuid: Regex::new(
                r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            )
            .unwrap(),
        }
    }

    fn apply(&mut self, text: &str) -> String {
        let mut out = self.now.replace_all(text, "<now>").into_owned();
        for m in self.uuid.find_iter(&out.clone()) {
            if !self.groups.iter().any(|g| g == m.as_str()) {
                self.groups.push(m.as_str().to_string());
            }
        }
        for (i, id) in self.groups.iter().enumerate() {
            out = out.replace(id, &format!("<g{}>", i + 1));
        }
        out
    }

    fn resolve(&self, path: &str) -> String {
        let re = Regex::new(r"\{g(\d+)\}").unwrap();
        re.replace_all(path, |c: &regex::Captures| {
            self.groups[c[1].parse::<usize>().unwrap() - 1].clone()
        })
        .into_owned()
    }
}

/// A call as the golden recorded it, in a canonical order.
fn call_key(method: &str, path: &str, secret: Option<&str>, bearer: bool, body: &Value) -> String {
    format!("{method} {path} secret={secret:?} bearer={bearer} {body}")
}

fn chmod(dir: &std::path::Path, mode: u32) {
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[tokio::test]
async fn replays_the_ts_store_goldens() {
    let g = goldens();
    let rec = FakeRecommender::start().await;
    let dir = tempfile::tempdir().unwrap();
    let files: HashMap<String, PathBuf> = g["files"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), dir.path().join(v.as_str().unwrap())))
        .collect();
    let mut last: HashMap<String, String> = HashMap::new();
    for (store, path) in &files {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let seed = g["seeds"][store].as_str().unwrap();
        std::fs::write(path, seed).unwrap();
        last.insert(store.clone(), seed.to_string());
    }
    // Root ignores directory permissions: the rollback steps would pass for
    // the wrong reason, so they are refused instead.
    let probe = files["feedback"].parent().unwrap();
    chmod(probe, 0o555);
    let root = std::fs::write(probe.join("probe"), "").is_ok();
    chmod(probe, 0o755);
    assert!(
        !root,
        "run as a non-root user: the rollback steps need EACCES"
    );

    let path_of = |k: &str| files[k].to_str().unwrap().to_string();
    let (fb, rej, wl, pol) = (
        path_of("feedback"),
        path_of("rejections"),
        path_of("watchlist"),
        path_of("policies"),
    );
    let mut env: Vec<(&str, &str)> = g["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str().unwrap()))
        .collect();
    env.extend([
        ("RECOMMENDER_URL", rec.url.as_str()),
        ("USER_FEEDBACK_PATH", fb.as_str()),
        ("REJECTIONS_PATH", rej.as_str()),
        ("USER_WATCHLIST_PATH", wl.as_str()),
        ("USER_POLICIES_PATH", pol.as_str()),
    ]);
    let st = state_in(&dir, &env).await;
    let app = crate::router(st.clone());

    let mut cookies = HashMap::new();
    for (who, m) in g["members"].as_object().unwrap() {
        let sub = m["sub"].as_str().unwrap();
        let username = m["username"].as_str().unwrap();
        cookies.insert(
            who.clone(),
            member(&st, sub, username, m["role"].as_str().unwrap()).await,
        );
    }

    let mut norm = Normalizer::new();
    for s in g["steps"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let method = s["method"].as_str().unwrap_or("GET");
        let mut b = Request::builder()
            .method(method)
            .uri(norm.resolve(s["path"].as_str().unwrap()));
        if let Some(who) = s["as"].as_str() {
            b = b.header("cookie", &cookies[who]);
        }
        if method != "GET" {
            b = b.header("origin", "https://app.example");
        }
        for (k, v) in s["headers"].as_object().into_iter().flatten() {
            b = b.header(k, v.as_str().unwrap());
        }
        let body = match s["request_body"].as_str() {
            Some(text) => {
                b = b.header("content-type", "application/json");
                Body::from(text.to_string())
            }
            None => Body::empty(),
        };
        if let Some(f) = s["rec_fail"].as_array() {
            rec.fail(
                f[0].as_str().unwrap(),
                f[1].as_u64().unwrap() as u16,
                f[2].as_str().unwrap(),
            );
        }
        let readonly: Vec<&str> = s["readonly"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| v.as_str().unwrap())
            .collect();
        for store in &readonly {
            chmod(files[*store].parent().unwrap(), 0o555);
        }
        let r = send(&app, b.body(body).unwrap()).await;
        for store in &readonly {
            chmod(files[*store].parent().unwrap(), 0o755);
        }

        assert_eq!(
            r.status.as_u16() as u64,
            s["status"].as_u64().unwrap(),
            "{name}: status"
        );
        assert_eq!(
            norm.apply(&r.body),
            s["body"].as_str().unwrap(),
            "{name}: body"
        );

        for (store, path) in &files {
            let text = norm.apply(&std::fs::read_to_string(path).unwrap());
            let want = match s["files"][store].as_str() {
                Some(changed) => {
                    last.insert(store.clone(), changed.to_string());
                    changed
                }
                None => &last[store],
            };
            assert_eq!(&text, want, "{name}: {store} file");
        }

        let mut got: Vec<String> = rec
            .settle()
            .await
            .iter()
            .map(|c| {
                call_key(
                    &c.method,
                    &c.path,
                    c.secret.as_deref(),
                    c.bearer.is_some(),
                    &c.body,
                )
            })
            .collect();
        let mut want: Vec<String> = s["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                call_key(
                    c["method"].as_str().unwrap(),
                    c["path"].as_str().unwrap(),
                    c["secret"].as_str(),
                    c["bearer"].as_bool().unwrap(),
                    &c["body"],
                )
            })
            .collect();
        got.sort();
        want.sort();
        assert_eq!(got, want, "{name}: recommender calls");

        if let Some(who) = s["key_of"].as_str() {
            let sub = g["members"][who]["sub"].as_str().unwrap();
            let key = crate::stores::api_key(&st.auth.pool, &st.config.auth.session_secret, sub)
                .await
                .unwrap();
            assert_eq!(
                key.as_deref(),
                s["stored_key"].as_str(),
                "{name}: stored key"
            );
        }
    }
}
