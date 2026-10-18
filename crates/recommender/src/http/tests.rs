use super::*;
use axum::body::Body as HttpBody;
use axum::http::Request;
use emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL;
use emerald_contracts::internal_principal::{DEFAULT_KID, encrypt};
use tower::ServiceExt;

const EVENT: &str = "test-event-secret-xxxxxxxxxxxxxxxxxxxxxxxx";
const SECRET: &str = "test-internal-principal-secret-zzzzzzzzzzzzzzzzzzzz";
const SUB: &str = "plex:494190801";

fn config(pairs: &[(&str, &str)]) -> Config {
    let pairs: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Config::from_lookup(move |k| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
        .unwrap()
}

fn claims(sub: &str, now: i64, ttl: i64) -> InternalClaims {
    InternalClaims {
        iss: "eex".into(),
        sub: sub.into(),
        role: "user".into(),
        auth_mode: "plex".into(),
        server_id: "srv-uuid-1".into(),
        device_id: None,
        req_id: "req-test".into(),
        iat: now,
        exp: now + ttl,
    }
}

fn mint_with(secret: &str, sub: &str, ttl: i64, kid: &str) -> String {
    let key = emerald_contracts::derive_key(secret.as_bytes(), INFO_INTERNAL_PRINCIPAL);
    encrypt(&key, kid, &claims(sub, chrono::Utc::now().timestamp(), ttl))
}

fn mint(sub: &str) -> String {
    mint_with(SECRET, sub, 60, DEFAULT_KID)
}

fn auth(value: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(header::AUTHORIZATION, value.parse().unwrap());
    h
}

fn mode(m: &str, secret: Option<&str>) -> Config {
    let mut pairs = vec![("RECOMMENDER_INTERNAL_PRINCIPAL_MODE", m)];
    if let Some(s) = secret {
        pairs.push(("INTERNAL_PRINCIPAL_SECRET", s));
    }
    config(&pairs)
}

fn status(r: Result<Option<InternalClaims>, ApiError>) -> u16 {
    match r {
        Err(ApiError::Detail(s, _)) => s.as_u16(),
        other => panic!("expected an HTTP error, got {other:?}"),
    }
}

// recommender/tests/test_internal_principal.py, case for case (the log-mode
// cases assert the outcome; their log lines are not captured here).
#[test]
fn off_mode_never_inspects_the_header() {
    let c = mode("off", None);
    assert!(principal(&c, &HeaderMap::new()).unwrap().is_none());
    assert!(principal(&c, &auth("Bearer not-a-jwe")).unwrap().is_none());
    let c = mode("off", Some(SECRET));
    assert!(
        principal(&c, &auth(&format!("Bearer {}", mint("plex:12345"))))
            .unwrap()
            .is_none()
    );
}

#[test]
fn log_mode_verifies_but_never_blocks() {
    let c = mode("log", Some(SECRET));
    let got = principal(&c, &auth(&format!("Bearer {}", mint("plex:12345"))))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            got.sub.as_str(),
            got.role.as_str(),
            got.auth_mode.as_str(),
            got.server_id.as_str()
        ),
        ("plex:12345", "user", "plex", "srv-uuid-1")
    );
    assert_eq!((got.device_id, got.iss.as_str()), (None, "eex"));
    assert!(principal(&c, &HeaderMap::new()).unwrap().is_none());
    assert!(
        principal(&c, &auth("Basic dXNlcjpwYXNz"))
            .unwrap()
            .is_none()
    );
    assert!(
        principal(&c, &auth("Bearer not.a.real.jwe.token"))
            .unwrap()
            .is_none()
    );
    let expired = mint_with(SECRET, "plex:12345", -300, DEFAULT_KID);
    assert!(
        principal(&c, &auth(&format!("Bearer {expired}")))
            .unwrap()
            .is_none()
    );
    let c = mode("log", None);
    assert!(
        principal(&c, &auth(&format!("Bearer {}", mint("plex:12345"))))
            .unwrap()
            .is_none()
    );
}

#[test]
fn enforce_mode_rejects_every_failure() {
    let c = mode("enforce", Some(SECRET));
    assert_eq!(
        principal(&c, &auth(&format!("Bearer {}", mint("plex:12345"))))
            .unwrap()
            .unwrap()
            .sub,
        "plex:12345"
    );
    match principal(&c, &HeaderMap::new()) {
        Err(ApiError::Detail(s, d)) => assert!(s == 401 && d.contains("required"), "{d}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(status(principal(&c, &auth("Basic dXNlcjpwYXNz"))), 401);
    match principal(&c, &auth("Bearer not.a.real.jwe.token")) {
        Err(ApiError::Detail(s, d)) => assert!(s == 401 && d.contains("invalid"), "{d}"),
        other => panic!("{other:?}"),
    }
    let expired = mint_with(SECRET, "plex:12345", -300, DEFAULT_KID);
    assert_eq!(
        status(principal(&c, &auth(&format!("Bearer {expired}")))),
        401
    );
    // A kid outside the single-entry keymap (internal-v1).
    let v2 = mint_with(SECRET, "plex:12345", 60, "internal-v2");
    assert_eq!(status(principal(&c, &auth(&format!("Bearer {v2}")))), 401);
    let other = mint_with(
        "different-secret-also-32-chars-zzzzzzzzzzzz",
        "plex:12345",
        60,
        DEFAULT_KID,
    );
    assert_eq!(
        status(principal(&c, &auth(&format!("Bearer {other}")))),
        401
    );
    // Misconfigured: 503.
    let c = mode("enforce", None);
    assert_eq!(
        status(principal(
            &c,
            &auth(&format!("Bearer {}", mint("plex:12345")))
        )),
        503
    );
}

// recommender/tests/test_main_principal.py: the verified principal is
// authoritative over the body sub.
#[test]
fn authoritative_sub_by_mode() {
    let now = 0;
    let real = claims("plex:real", now, 0);
    assert_eq!(
        authoritative_sub(&mode("off", None), None, "plex:body").unwrap(),
        "plex:body"
    );
    assert_eq!(
        authoritative_sub(&mode("log", None), Some(&real), "plex:other").unwrap(),
        "plex:real"
    );
    match authoritative_sub(&mode("enforce", None), Some(&real), "plex:other") {
        Err(ApiError::Detail(s, _)) => assert_eq!(s, 403),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        authoritative_sub(&mode("enforce", None), Some(&real), "plex:real").unwrap(),
        "plex:real"
    );
}

struct App {
    _dir: tempfile::TempDir,
    pool: SqlitePool,
    router: Router,
    db_path: String,
}

async fn app(pairs: &[(&str, &str)]) -> App {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("exchange.db");
    let absent = dir.path().join("absent-holdout.jsonl");
    let (db_s, absent_s) = (db.display().to_string(), absent.display().to_string());
    let mut all = vec![
        ("RECOMMENDER_DB_PATH", db_s.as_str()),
        ("RECOMMENDER_HOLDOUT_PATH", absent_s.as_str()),
    ];
    all.extend_from_slice(pairs);
    let config = config(&all);
    let pool = crate::db::open(&config.db_path).await.unwrap();
    let router = router(AppState {
        pool: pool.clone(),
        config: Arc::new(config),
    });
    App {
        _dir: dir,
        pool,
        router,
        db_path: db_s,
    }
}

impl App {
    async fn send(&self, req: Request<HttpBody>) -> (u16, Value) {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&bytes).replace(&self.db_path, "<DB_PATH>");
        let body = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        (status, body)
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let req = Request::post(path)
            .header("x-recommender-secret", EVENT)
            .header("content-type", "application/json")
            .body(HttpBody::from(body.to_string()))
            .unwrap();
        self.send(req).await
    }

    async fn signals(&self, tmdb_id: i64) -> Vec<String> {
        sqlx::query_scalar("SELECT signal FROM user_feedback WHERE tmdb_id = ? ORDER BY signal")
            .bind(tmdb_id)
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }

    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

async fn events_app() -> App {
    app(&[("RECOMMENDER_EVENT_SECRET", EVENT)]).await
}

async fn post_signal(a: &App, signal: &str) {
    let (status, body) = a
        .post(
            "/events/feedback",
            json!({"sub": SUB, "kind": "movie", "tmdb_id": 555, "signal": signal}),
        )
        .await;
    assert_eq!((status, body), (200, json!({"ok": true})), "{signal}");
}

// recommender/tests/test_feedback_signals.py.
#[tokio::test]
async fn real_signals_are_stored() {
    for signal in ["like", "dislike", "reject", "clicked", "added", "watched"] {
        let a = events_app().await;
        post_signal(&a, signal).await;
        assert_eq!(a.signals(555).await, [signal]);
    }
}

#[tokio::test]
async fn reject_clears_all_opposing_signals() {
    let a = events_app().await;
    for s in ["like", "clicked", "added", "watched"] {
        post_signal(&a, s).await;
    }
    assert_eq!(
        a.signals(555).await,
        ["added", "clicked", "like", "watched"]
    );
    post_signal(&a, "reject").await;
    assert_eq!(a.signals(555).await, ["reject"]);
}

#[tokio::test]
async fn positive_clears_dislike_and_reject() {
    let a = events_app().await;
    for s in ["dislike", "reject", "like"] {
        post_signal(&a, s).await;
    }
    assert_eq!(a.signals(555).await, ["like"]);
}

/// The Python 'shown' signal wrote recently_shown only and had no caller: it
/// is a 422 now, and nothing is written.
#[tokio::test]
async fn shown_signal_is_gone() {
    let a = events_app().await;
    let (status, _) = a
        .post(
            "/events/feedback",
            json!({"sub": SUB, "kind": "movie", "tmdb_id": 555, "signal": "shown"}),
        )
        .await;
    assert_eq!(status, 422);
    assert_eq!(
        (
            a.count("user_feedback").await,
            a.count("recently_shown").await
        ),
        (0, 0)
    );
}

// test_watched_feedback.py: watched is stored and clears an opposing dislike.
#[tokio::test]
async fn watched_is_stored_and_clears_dislike() {
    let a = events_app().await;
    post_signal(&a, "dislike").await;
    assert_eq!(a.signals(555).await, ["dislike"]);
    post_signal(&a, "watched").await;
    assert_eq!(a.signals(555).await, ["watched"]);
    assert_eq!(a.count("rec_outcomes").await, 0);
}

// test_schema_positive_ids.py: every event endpoint 422s a non-positive id
// and writes nothing (library/sync is not ported: no caller).
#[tokio::test]
async fn event_endpoints_422_on_bad_ids_and_write_nothing() {
    let a = events_app().await;
    for bad in [json!(0), json!(-1), json!("42")] {
        let (status, body) = a
            .post(
                "/events/rejection",
                json!({"kind": "movie", "tmdb_id": bad}),
            )
            .await;
        assert_eq!(status, 422, "{body}");
    }
    assert_eq!(a.count("household_rejections").await, 0);
    let item = json!({"tmdb_id": 0, "rank": 0, "score": 0.1, "provenance": "discover", "model_version": "v0"});
    for (path, body) in [
        (
            "/events/feedback",
            json!({"sub": SUB, "kind": "movie", "tmdb_id": 0, "signal": "like"}),
        ),
        (
            "/events/feedback/clear",
            json!({"sub": SUB, "kind": "movie", "tmdb_id": -5}),
        ),
        (
            "/events/shown",
            json!({"sub": SUB, "kind": "movie", "tmdb_ids": [0]}),
        ),
        (
            "/events/impressions",
            json!({"sub": SUB, "kind": "movie", "items": [item]}),
        ),
    ] {
        let (status, got) = a.post(path, body).await;
        assert_eq!(status, 422, "{path}: {got}");
    }
    for t in ["user_feedback", "recently_shown", "rec_log"] {
        assert_eq!(a.count(t).await, 0, "{t}");
    }
}

#[tokio::test]
async fn library_sync_is_not_served() {
    let a = events_app().await;
    let (status, body) = a
        .post(
            "/events/library/sync",
            json!({"kind": "movie", "items": []}),
        )
        .await;
    assert_eq!((status, body), (404, json!({"detail": "Not Found"})));
}

// test_main_principal.py's /health cases.
#[tokio::test]
async fn health_gates_the_internal_fields() {
    let a = app(&[("RECOMMENDER_EVENT_SECRET", &"s".repeat(32))]).await;
    let get = |secret: Option<&str>| {
        let mut req = Request::get("/health");
        if let Some(s) = secret {
            req = req.header("X-Recommender-Secret", s);
        }
        req.body(HttpBody::empty()).unwrap()
    };
    for secret in [None, Some("wrong")] {
        let (status, body) = a.send(get(secret)).await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        assert!(body["db_path"].is_null() && body["internal_principal_mode"].is_null());
        assert!(body["optimizer"].is_null());
    }
    let (_, body) = a.send(get(Some(&"s".repeat(32)))).await;
    assert_eq!(body["db_path"], "<DB_PATH>");
    assert_eq!(body["internal_principal_mode"], "off");
    assert!(
        ["active", "record-only", "unknown"].contains(&body["optimizer"]["mode"].as_str().unwrap())
    );
}

#[tokio::test]
async fn retention_sweep_keeps_attributed_and_recent_rows() {
    let a = events_app().await;
    sqlx::raw_sql(
        "INSERT INTO rec_log(id, sub, kind, tmdb_id, rank, score, provenance, model_version, ts) VALUES
           (1, 'plex:1', 'movie', 1, 0, 0.5, 'discover', 'v', datetime('now', '-100 days')),
           (2, 'plex:1', 'movie', 2, 0, 0.5, 'discover', 'v', datetime('now', '-100 days')),
           (3, 'plex:1', 'movie', 3, 0, 0.5, 'discover', 'v', datetime('now', '-1 days'));
         INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES (2, 'added', datetime('now', '-99 days'));
         INSERT INTO recently_shown(sub, kind, tmdb_id, ts) VALUES
           ('plex:1', 'movie', 1, datetime('now', '-31 days')),
           ('plex:1', 'movie', 2, datetime('now', '-29 days'));",
    )
    .execute(&a.pool)
    .await
    .unwrap();
    events::sweep_retention_once(&a.pool, 90).await.unwrap();
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM rec_log ORDER BY id")
        .fetch_all(&a.pool)
        .await
        .unwrap();
    assert_eq!(ids, [2, 3]);
    let shown: Vec<i64> = sqlx::query_scalar("SELECT tmdb_id FROM recently_shown")
        .fetch_all(&a.pool)
        .await
        .unwrap();
    assert_eq!(shown, [2]);
}

// ---- Python goldens --------------------------------------------------------

/// Deltas from the Python app the goldens were recorded on, applied to both
/// sides before comparing:
/// - json_invalid: Python's decoder message and character offset are its own;
///   only type, msg and loc[0] are compared.
/// - /events/feedback no longer accepts 'shown', so its literal_error lists
///   one signal fewer.
fn normalize(path: &str, body: &Value) -> Value {
    let mut body = body.clone();
    if let Some(details) = body.get_mut("detail").and_then(Value::as_array_mut) {
        for d in details {
            if d["type"] == "json_invalid" {
                *d = json!({ "type": d["type"], "msg": d["msg"], "loc0": d["loc"][0] });
            }
            if path == "/events/feedback"
                && d["type"] == "literal_error"
                && d["loc"] == json!(["body", "signal"])
            {
                for key in ["msg", "/ctx/expected"] {
                    let slot = if key == "msg" {
                        d.get_mut("msg")
                    } else {
                        d.pointer_mut(key)
                    };
                    if let Some(Value::String(s)) = slot {
                        *s = s.replace("'shown', ", "");
                    }
                }
            }
        }
    }
    body
}

fn golden_bearer(spec: &Value, principal_secret: &str) -> String {
    if let Some(raw) = spec.as_str() {
        return format!("Bearer {raw}");
    }
    let secret = spec["secret"].as_str().unwrap_or(principal_secret);
    let ttl = if spec["expired"] == true { -300 } else { 60 };
    let token = mint_with(
        secret,
        spec["sub"].as_str().unwrap(),
        ttl,
        spec["kid"].as_str().unwrap_or(DEFAULT_KID),
    );
    let scheme = spec["scheme"].as_str().unwrap_or("Bearer");
    let pad = spec["pad"].as_str();
    format!("{scheme}{}{token}{}", pad.unwrap_or(" "), pad.unwrap_or(""))
}

async fn dump(pool: &SqlitePool, sql: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for (table, q) in sql.as_object().unwrap() {
        let text: String = sqlx::query_scalar(sqlx::AssertSqlSafe(q.as_str().unwrap().to_string()))
            .fetch_one(pool)
            .await
            .unwrap();
        out.insert(table.clone(), serde_json::from_str(&text).unwrap());
    }
    Value::Object(out)
}

/// Replays tests/fixtures/http-goldens.json (recorded from the untouched
/// FastAPI app by gen_http_goldens.py): status, body and household tables
/// after every step.
#[tokio::test]
async fn python_goldens() {
    let g: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/http-goldens.json")).unwrap();
    let principal_secret = g["principal_secret"].as_str().unwrap();
    let mut steps_run = 0;
    for sc in g["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let c = &sc["config"];
        let mut pairs = vec![(
            "RECOMMENDER_INTERNAL_PRINCIPAL_MODE",
            c["mode"].as_str().unwrap(),
        )];
        if let Some(s) = c["event_secret"].as_str() {
            pairs.push(("RECOMMENDER_EVENT_SECRET", s));
        }
        if let Some(s) = c["principal_secret"].as_str() {
            pairs.push(("INTERNAL_PRINCIPAL_SECRET", s));
        }
        let a = app(&pairs).await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(
            g["seed_sql"].as_str().unwrap().to_string(),
        ))
        .execute(&a.pool)
        .await
        .unwrap();
        let mut tables = dump(&a.pool, &g["dump_sql"]).await;
        assert_eq!(tables, g["seed_tables"], "{name}: seed");
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let expect = &step["expect"];
            let path = step["path"].as_str().unwrap_or("");
            let ctx = format!(
                "{name}#{i} {} {path}",
                step["method"].as_str().unwrap_or("sweep")
            );
            if step["sweep"] == true {
                events::sweep_retention_once(&a.pool, 90).await.unwrap();
            } else {
                let mut req = Request::builder()
                    .method(step["method"].as_str().unwrap())
                    .uri(path);
                for (k, v) in step["headers"].as_object().unwrap() {
                    req = req.header(k.as_str(), v.as_str().unwrap());
                }
                if let Some(spec) = step.get("bearer") {
                    req = req.header("authorization", golden_bearer(spec, principal_secret));
                }
                let body = step["raw"]
                    .as_str()
                    .map_or(HttpBody::empty(), |r| HttpBody::from(r.to_string()));
                let (status, got) = a.send(req.body(body).unwrap()).await;
                assert_eq!(
                    status,
                    expect["status"].as_u64().unwrap() as u16,
                    "{ctx}: {got}"
                );
                assert_eq!(
                    normalize(path, &got),
                    normalize(path, &expect["body"]),
                    "{ctx}"
                );
            }
            if let Some(t) = expect.get("tables") {
                tables = t.clone();
            }
            assert_eq!(dump(&a.pool, &g["dump_sql"]).await, tables, "{ctx}: tables");
            steps_run += 1;
        }
    }
    assert!(steps_run > 200, "{steps_run}");
}
