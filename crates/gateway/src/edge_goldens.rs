//! Replays tests/fixtures/edge-goldens.json through [`crate::router`]. The
//! generator (gen-gateway-goldens.ts) ran the untouched TS app (server/app.ts)
//! under the same env; here every scenario must give the same status, the
//! same body text, the same edge headers and the same request log lines.
//!
//! Documented deltas, applied to the TS side before comparing:
//!   - /api/version: no `plex` in auth_modes (Plex is dropped).
//!   - An unknown /api path is a JSON 404 `{"error":"not_found"}`; Hono
//!     answered `404 Not Found` as text/plain.
//!   - The 413: Hono's bodyLimit ran before its header, logger and CORS
//!     middleware, so its 413 had no frame headers, CORS headers or log
//!     lines. Here the limit sits inside them (after CSRF); status, body and
//!     Content-Type compare, and the frame headers and both log lines must
//!     be present.
//!   - CORS list headers compare as case-insensitive sets; X-Anthropic-Api-Key
//!     is gone from Allow-Headers (no sender left, ponytail-findings), and a
//!     preflight carries no Expose-Headers (tower-http sends it on the actual
//!     response, the only place a browser reads it). Vary is not compared.
//!   - Content-Type compares by media type: Hono added `; charset=utf-8` to
//!     static files.

use std::collections::BTreeSet;

use axum::body::Body;
use axum::http::Request;
use serde_json::Value;

use crate::AppState;
use crate::testutil::*;

fn goldens() -> &'static Value {
    static G: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    G.get_or_init(|| {
        serde_json::from_str(include_str!("../tests/fixtures/edge-goldens.json")).unwrap()
    })
}

/// The golden env plus per-run paths: exchange.db and media.db as the
/// generator seeded them, the SPA files under `dir/dist`.
async fn golden_state(dir: &tempfile::TempDir) -> AppState {
    let g = goldens();
    let path = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
    let exchange = sqlx_exec(
        &path("exchange.db"),
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)",
    )
    .await;
    for v in g["exchange_versions"].as_array().unwrap() {
        sqlx::query("INSERT INTO schema_migrations VALUES (?)")
            .bind(v.as_i64().unwrap())
            .execute(&exchange)
            .await
            .unwrap();
    }
    exchange.close().await;
    sqlx_exec(&path("media.db"), "CREATE TABLE t (x)")
        .await
        .close()
        .await;
    std::fs::create_dir_all(dir.path().join("dist/assets")).unwrap();
    std::fs::write(
        dir.path().join("dist/index.html"),
        g["spa"]["index"].as_str().unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("dist/assets/app.js"),
        g["spa"]["asset"].as_str().unwrap(),
    )
    .unwrap();

    let (exchange, media) = (path("exchange.db"), path("media.db"));
    let mut env: Vec<(&str, &str)> = g["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str().unwrap()))
        .collect();
    env.push(("RECOMMENDER_DB_PATH", &exchange));
    env.push(("MEDIA_DB_PATH", &media));
    let mut st = state_in(dir, &env).await;
    st.spa_dir = Some(dir.path().join("dist"));
    st
}

async fn sqlx_exec(path: &str, sql: &'static str) -> sqlx::SqlitePool {
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
    sqlx::query(sql).execute(&pool).await.unwrap();
    pool
}

fn member_cookie(st: &AppState) -> String {
    let session = auth::session::Session {
        sub: goldens()["member"].as_str().unwrap().into(),
        username: "Mom".into(),
        role: auth::Role::User,
        auth_mode: auth::AuthMode::Apple,
    };
    let token = auth::session::mint(
        &st.auth.session_key,
        &session,
        chrono::Utc::now().timestamp(),
    );
    format!("eex.session={token}")
}

fn request(s: &Value, cookie: &str) -> Request<Body> {
    let mut b = Request::builder()
        .method(s["method"].as_str().unwrap_or("GET"))
        .uri(s["path"].as_str().unwrap());
    for (k, v) in s["request_headers"].as_object().into_iter().flatten() {
        b = b.header(k, v.as_str().unwrap());
    }
    if s["cookie"] == true {
        b = b.header("cookie", cookie);
    }
    if let Some(n) = s["body_bytes"].as_u64() {
        return b.body(Body::from("x".repeat(n as usize))).unwrap();
    }
    if let Some(n) = s["chunked_bytes"].as_u64() {
        // 64 KiB chunks and no Content-Length, as the generator streamed it.
        let chunks: Vec<Result<Vec<u8>, std::io::Error>> = (0..n as usize)
            .step_by(64 * 1024)
            .map(|at| Ok(vec![b'x'; (n as usize - at).min(64 * 1024)]))
            .collect();
        return b
            .body(Body::from_stream(futures_util::stream::iter(chunks)))
            .unwrap();
    }
    b.body(Body::empty()).unwrap()
}

fn media_type(v: &str) -> String {
    v.split(';').next().unwrap().trim().to_ascii_lowercase()
}

fn header_set(v: &str) -> BTreeSet<String> {
    v.split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// A uuid v4, as the generated request id must be.
fn is_uuid(v: &str) -> bool {
    uuid::Uuid::parse_str(v).is_ok_and(|u| u.get_version_num() == 4) && v.len() == 36
}

/// The request-log lines, from the `<--`/`-->` marker on.
fn request_lines(logs: &str) -> Vec<String> {
    logs.lines()
        .filter_map(|l| {
            ["<-- ", "--> "]
                .iter()
                .find_map(|m| l.find(m).map(|i| l[i..].to_string()))
        })
        .map(|l| {
            let re = regex::Regex::new(r" \d+ms ").unwrap();
            re.replace(&l, " <ms>ms ").into_owned()
        })
        .collect()
}

#[tokio::test]
async fn replays_the_ts_edge_goldens() {
    let dir = tempfile::tempdir().unwrap();
    let st = golden_state(&dir).await;
    let app = crate::router(st.clone());
    let cookie = member_cookie(&st);
    let server_id = auth::ensure_server_id(&st.auth.pool).await.unwrap();

    for s in goldens()["scenarios"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        capture_logs();
        let r = send(&app, request(s, &cookie)).await;
        let logs = logs();

        // Per-run values become the generator's placeholders.
        let id = r.headers["x-request-id"].to_str().unwrap().to_string();
        let generated = s["request_id_generated"] == true;
        if generated {
            assert!(is_uuid(&id), "{name}: {id}");
        }
        let scrub = |t: &str| {
            let t = t.replace(&server_id, "<server_id>");
            if generated {
                t.replace(&id, "<request-id>")
            } else {
                t
            }
        };

        let ts_status = s["status"].as_u64().unwrap();
        let ts_body = s["body"].as_str().unwrap();
        let ts_headers = s["headers"].as_object().unwrap();
        let ts_header = |h: &str| ts_headers.get(h).map(|v| v.as_str().unwrap());
        let header = |h: &str| r.headers.get(h).map(|v| scrub(v.to_str().unwrap()));
        let not_found = ts_body == "404 Not Found";
        let too_large = ts_status == 413;

        assert_eq!(r.status.as_u16() as u64, ts_status, "{name}: status");
        let expected_body = if not_found {
            r#"{"error":"not_found"}"#.to_string()
        } else {
            ts_body.replace(r#""auth_modes":["plex","#, r#""auth_modes":["#)
        };
        assert_eq!(scrub(&r.body), expected_body, "{name}: body");

        // Content-Type by media type.
        let ts_ct = if not_found {
            Some("application/json")
        } else {
            ts_header("content-type")
        };
        assert_eq!(
            header("content-type").map(|v| media_type(&v)),
            ts_ct.map(media_type),
            "{name}: content-type"
        );
        assert_eq!(
            header("x-request-id").as_deref(),
            ts_header("x-request-id"),
            "{name}: request id"
        );
        for h in ["content-security-policy", "x-frame-options"] {
            if too_large {
                assert!(header(h).is_some(), "{name}: {h}");
            } else {
                assert_eq!(header(h).as_deref(), ts_header(h), "{name}: {h}");
            }
        }

        // CORS: every list header as a case-insensitive set.
        let preflight = s["method"] == "OPTIONS";
        for h in [
            "access-control-allow-origin",
            "access-control-allow-credentials",
            "access-control-allow-methods",
            "access-control-allow-headers",
            "access-control-expose-headers",
        ] {
            let mut want = ts_header(h).map(header_set);
            if h == "access-control-allow-headers"
                && let Some(w) = want.as_mut()
            {
                assert!(w.remove("x-anthropic-api-key"), "{name}");
            }
            if preflight && h == "access-control-expose-headers" {
                want = None;
            }
            if too_large {
                // Hono's 413 had none; here the request crossed CORS.
                continue;
            }
            assert_eq!(header(h).map(|v| header_set(&v)), want, "{name}: {h}");
        }

        // The request log.
        let ts_logs: Vec<String> = s["logs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| {
                l.as_str()
                    .unwrap()
                    .strip_prefix("[app] ")
                    .unwrap()
                    .to_string()
            })
            .collect();
        let lines: Vec<String> = request_lines(&logs).iter().map(|l| scrub(l)).collect();
        if too_large {
            assert_eq!(lines.len(), 2, "{name}: logged here");
        } else {
            assert_eq!(lines, ts_logs, "{name}: logs");
        }
    }
}
