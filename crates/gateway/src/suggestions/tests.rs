//! The suggestions*.test.ts, tagLocalAvailability.test.ts,
//! localAvailability.bench.test.ts and mediaLibraryDb*.test.ts cases that are
//! not route goldens (gen-suggestions-goldens.ts carries the rest), plus the
//! Rust-only edges: the 529/503 retry without the SDK's hidden retries, the
//! un-ported X-Anthropic-Api-Key header, the expired stale library, the
//! iptv principal.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::fake::{Call, Fake, Route};
use super::*;
use crate::testutil::{ALICE, add_member, cookie, state_in};

// --- mapLimit (suggestions.maplimit.test.ts) -------------------------------------------

#[tokio::test]
async fn map_limit_preserves_input_order() {
    let out = map_limit(vec![30u64, 5, 15, 1], 4, |(_, ms)| async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        ms
    })
    .await;
    assert_eq!(out, [30, 5, 15, 1]);
}

#[tokio::test]
async fn map_limit_never_exceeds_the_limit_or_the_item_count() {
    for (n, limit, peak_max) in [(10usize, 3usize, 3usize), (2, 10, 2)] {
        let (live, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        map_limit((0..n).collect(), limit, |(_, _)| {
            let (live, peak) = (live.clone(), peak.clone());
            async move {
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
                live.fetch_sub(1, Ordering::SeqCst);
            }
        })
        .await;
        assert!(
            peak.load(Ordering::SeqCst) <= peak_max,
            "n={n} limit={limit}"
        );
    }
}

#[tokio::test]
async fn map_limit_passes_the_index_and_handles_empty_input() {
    let out = map_limit(
        vec!["a", "b", "c"],
        2,
        |(i, s)| async move { format!("{s}{i}") },
    )
    .await;
    assert_eq!(out, ["a0", "b1", "c2"]);
    let calls = AtomicUsize::new(0);
    let none: Vec<()> = map_limit(Vec::<u8>::new(), 3, |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        async {}
    })
    .await;
    assert!(none.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

// --- a suggestions app against the fake ------------------------------------------------

struct T {
    _dir: tempfile::TempDir,
    st: AppState,
    app: Router,
    fake: Fake,
    cookie: String,
}

const KEY: &str = "sk-ant-placeholder-test-key";

fn radarr_eleven() -> Route {
    let rows: Vec<Value> = (0..11)
        .map(|i| json!({ "title": format!("Lib Film {i}"), "year": 2010 + i, "tmdbId": 7100 + i, "genres": ["Drama"] }))
        .collect();
    Route::json("GET", "/radarr/api/v3/movie", 200, &Value::Array(rows))
}

fn message(picks: Value) -> Value {
    json!({
        "id": "msg", "type": "message", "role": "assistant", "model": "m",
        "content": [{ "type": "tool_use", "id": "tu", "name": "submit_recommendations", "input": { "picks": picks } }],
        "stop_reason": "tool_use", "usage": { "input_tokens": 1, "output_tokens": 1 },
    })
}

fn tmdb_empty() -> Route {
    Route {
        prefix: true,
        ..Route::json("GET", "/tmdb/3/", 200, &json!({ "results": [] }))
    }
}

async fn setup(
    mut routes: Vec<Route>,
    extra: &[(&str, &str)],
    timings: Timings,
    stored_key: bool,
) -> T {
    let fake = Fake::start().await;
    routes.push(tmdb_empty());
    routes.push(Route::json(
        "POST",
        "/anthropic/v1/messages",
        200,
        &message(json!([])),
    ));
    routes.push(Route::json(
        "POST",
        "/iptv/internal/availability",
        200,
        &json!({ "tmdb_ids": [] }),
    ));
    fake.set_routes(routes);
    let dir = tempfile::tempdir().unwrap();
    let p = |f: &str| dir.path().join(f).to_str().unwrap().to_string();
    let urls: Vec<(String, String)> = [
        ("RADARR_URL", "radarr"),
        ("SONARR_URL", "sonarr"),
        ("IPTV_SERVICE_URL", "iptv"),
        ("RECOMMENDER_URL", "rec"),
    ]
    .iter()
    .map(|(k, s)| (k.to_string(), format!("{}/{s}", fake.url)))
    .collect();
    let paths = [
        ("USER_FEEDBACK_PATH", p("feedback.json")),
        ("REJECTIONS_PATH", p("rejections.json")),
        ("USAGE_LOG_PATH", p("usage.jsonl")),
    ];
    let mut env: Vec<(&str, &str)> = vec![
        ("RADARR_API_KEY", "placeholder-radarr"),
        ("SONARR_API_KEY", "placeholder-sonarr"),
        ("TMDB_API_KEY", "placeholder-tmdb"),
    ];
    env.extend(urls.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    env.extend(paths.iter().map(|(k, v)| (*k, v.as_str())));
    env.extend_from_slice(extra);
    let mut st = state_in(&dir, &env).await;
    {
        let cfg = Arc::get_mut(&mut st.config).unwrap();
        cfg.ext.tmdb_base = format!("{}/tmdb/3", fake.url);
        cfg.ext.anthropic_base = format!("{}/anthropic", fake.url);
    }
    st.suggestions = Arc::new(Suggestions::new(timings));
    add_member(&st, ALICE, "alice", "user").await;
    if stored_key {
        crate::stores::set_api_key(&st.auth.pool, &st.config.auth.session_secret, ALICE, KEY)
            .await
            .unwrap();
    }
    let cookie = cookie(&st, ALICE, "alice");
    let app = crate::router(st.clone());
    T {
        _dir: dir,
        st,
        app,
        fake,
        cookie,
    }
}

fn fast() -> Timings {
    Timings {
        claude_timeout: Duration::from_secs(5),
        anthropic_retry_delay: Duration::ZERO,
        ..Timings::default()
    }
}

impl T {
    async fn get(&self, path: &str, headers: &[(&str, &str)]) -> (u16, Value) {
        let mut req = Request::get(path).header("cookie", &self.cookie);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = self
            .app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    async fn calls(&self, prefix: &str) -> Vec<Call> {
        self.fake
            .settle()
            .await
            .into_iter()
            .filter(|c| c.path.starts_with(prefix))
            .collect()
    }
}

/// The CANDIDATE POOL lines of an Anthropic request, in order.
fn pool_order(body: &Value) -> Vec<String> {
    body["system"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|b| b["text"].as_str())
        .find(|t| t.starts_with("CANDIDATE POOL"))
        .map(|t| {
            t.split_once("\n\n")
                .unwrap()
                .1
                .lines()
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn the_candidate_pool_is_shuffled_per_request() {
    let pool: Vec<Value> = (1..=5)
        .map(|i| json!({ "id": 8_900_000 + i, "title": format!("Pool Film {i}"), "release_date": "2020-01-01" }))
        .collect();
    let t = setup(
        vec![
            radarr_eleven(),
            Route::json(
                "GET",
                "/tmdb/3/discover/movie",
                200,
                &json!({ "results": pool }),
            ),
        ],
        &[],
        fast(),
        true,
    )
    .await;
    let mut orders = HashSet::new();
    for _ in 0..5 {
        assert_eq!(t.get("/api/suggestions/movie", &[]).await.0, 200);
        for c in t.calls("/anthropic").await {
            orders.insert(pool_order(&c.body).join("|"));
        }
    }
    assert!(
        orders.len() > 1,
        "five identical shuffles of five items: {orders:?}"
    );
}

#[tokio::test]
async fn each_request_gets_a_fresh_16_hex_salt() {
    let t = setup(vec![radarr_eleven()], &[], fast(), true).await;
    let salt = regex::Regex::new(r"^\[Request salt: ([0-9a-f]{16})\]").unwrap();
    let mut salts = vec![];
    for _ in 0..2 {
        t.get("/api/suggestions/movie", &[]).await;
        let calls = t.calls("/anthropic").await;
        let ask = calls[0].body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        salts.push(salt.captures(&ask).unwrap()[1].to_string());
        // The retry reuses the request's salt.
        let retry = calls[1].body["messages"][0]["content"].as_str().unwrap();
        assert!(retry.starts_with(&format!("[Request salt: {}]", salts.last().unwrap())));
    }
    assert_ne!(salts[0], salts[1]);
}

#[tokio::test]
async fn a_stale_library_past_its_max_age_fails_closed() {
    let timings = Timings {
        library_stale_max_age: Duration::ZERO,
        ..fast()
    };
    let ok = Route::json(
        "GET",
        "/radarr/api/v3/movie",
        200,
        &json!([{ "title": "Lib", "year": 2020, "tmdbId": 1 }]),
    )
    .times(1);
    let down = Route::json("GET", "/radarr/api/v3/movie", 502, &json!("boom"));
    let t = setup(vec![ok, down], &[], timings, true).await;
    assert_eq!(
        t.get("/api/suggestions/movie?force=trending", &[]).await.0,
        200
    );
    t.st.suggestions.drop_library_ttl();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let (status, body) = t.get("/api/suggestions/movie?force=trending", &[]).await;
    assert_eq!(
        (status, body),
        (
            502,
            json!({ "error": "library_unavailable", "kind": "movie" })
        )
    );
}

#[tokio::test]
async fn an_always_overloaded_api_is_retried_once() {
    let overloaded = json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } });
    let t = setup(
        vec![
            radarr_eleven(),
            Route::json("POST", "/anthropic/v1/messages", 529, &overloaded),
        ],
        &[],
        fast(),
        true,
    )
    .await;
    let (status, body) = t.get("/api/suggestions/movie", &[]).await;
    assert_eq!(status, 200);
    assert_eq!(body["source"], "trending_fallback");
    assert_eq!(body["_diag"]["claudeStatus"], 529);
    assert_eq!(body["_diag"]["claudeError"], format!("529 {overloaded}"));
    let calls = t.calls("/anthropic").await;
    assert_eq!(calls.len(), 2, "initial plus one retry");
    assert_eq!(calls[0].key.as_deref(), Some(KEY));
    let log = std::fs::read_to_string(t.st.usage.path()).unwrap();
    let line: Value = serde_json::from_str(log.trim()).unwrap();
    assert_eq!(
        (line["type"].as_str(), line["error"].as_str()),
        (Some("claude_error"), body["_diag"]["claudeError"].as_str())
    );
}

#[tokio::test]
async fn a_503_is_retried_and_a_400_is_not() {
    let t = setup(
        vec![
            radarr_eleven(),
            Route::json(
                "POST",
                "/anthropic/v1/messages",
                503,
                &json!({ "message": "busy" }),
            )
            .times(1),
        ],
        &[],
        fast(),
        true,
    )
    .await;
    let (_, body) = t.get("/api/suggestions/movie", &[]).await;
    // 503, then the default empty reply, then the retry for the empty list.
    assert_eq!(t.calls("/anthropic").await.len(), 3);
    assert_eq!(body["_diag"]["callCount"], 2);

    let t = setup(
        vec![
            radarr_eleven(),
            Route::json(
                "POST",
                "/anthropic/v1/messages",
                400,
                &json!({ "message": "bad prompt" }),
            ),
        ],
        &[],
        fast(),
        true,
    )
    .await;
    let (_, body) = t.get("/api/suggestions/movie", &[]).await;
    assert_eq!(t.calls("/anthropic").await.len(), 1);
    assert_eq!(
        (
            body["_diag"]["claudeStatus"].as_u64(),
            body["_diag"]["claudeError"].as_str()
        ),
        (Some(400), Some("400 bad prompt"))
    );
}

#[tokio::test]
async fn the_anthropic_key_header_is_ignored() {
    let t = setup(vec![radarr_eleven()], &[], fast(), false).await;
    let (status, body) = t
        .get("/api/suggestions/movie", &[("x-anthropic-api-key", KEY)])
        .await;
    assert_eq!(
        (status, body),
        (
            402,
            json!({ "error": "api_key_required", "hint": "set your key in the user menu" })
        )
    );
    assert!(t.calls("/anthropic").await.is_empty());
}

fn trending_one() -> Route {
    Route::json(
        "GET",
        "/tmdb/3/trending/movie/week",
        200,
        &json!({ "results": [{ "id": 5999, "title": "Linked", "poster_path": null, "release_date": "2025-01-01" }] }),
    )
}

#[tokio::test]
async fn a_failed_iptv_lookup_leaves_items_untagged() {
    let t = setup(
        vec![
            Route::json("GET", "/radarr/api/v3/movie", 200, &json!([])),
            trending_one(),
            Route::json("POST", "/iptv/internal/availability", 500, &json!({})),
        ],
        &[],
        fast(),
        true,
    )
    .await;
    let (status, body) = t.get("/api/suggestions/movie?force=trending", &[]).await;
    assert_eq!(status, 200);
    assert_eq!(body["items"][0]["id"], 5999);
    assert!(body["items"][0].get("available_on").is_none());
}

#[tokio::test]
async fn iptv_disabled_asks_nothing() {
    let t = setup(
        vec![
            Route::json("GET", "/radarr/api/v3/movie", 200, &json!([])),
            trending_one(),
        ],
        &[("IPTV_DISABLED", "1")],
        fast(),
        true,
    )
    .await;
    assert_eq!(
        t.get("/api/suggestions/movie?force=trending", &[]).await.0,
        200
    );
    assert!(t.calls("/iptv").await.is_empty());
}

#[tokio::test]
async fn the_iptv_lookup_carries_an_admin_principal_for_the_member() {
    let t = setup(
        vec![
            Route::json("GET", "/radarr/api/v3/movie", 200, &json!([])),
            trending_one(),
            Route::json(
                "POST",
                "/iptv/internal/availability",
                200,
                &json!({ "tmdb_ids": [5999] }),
            ),
        ],
        &[],
        fast(),
        true,
    )
    .await;
    let (_, body) = t.get("/api/suggestions/movie?force=trending", &[]).await;
    assert_eq!(body["items"][0]["available_on"], json!(["iptv"]));
    let call = t.calls("/iptv").await.remove(0);
    assert_eq!(call.body, json!({ "tmdb_ids": [5999] }));
    let token = call
        .authorization
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap()
        .to_string();
    let key = emerald_contracts::hkdf::derive_key(
        t.st.config
            .auth
            .internal_principal_secret
            .as_deref()
            .unwrap()
            .as_bytes(),
        emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL,
    );
    let keys = std::collections::HashMap::from([(
        emerald_contracts::internal_principal::DEFAULT_KID.to_string(),
        key,
    )]);
    let claims = emerald_contracts::internal_principal::decrypt(&keys, &token).unwrap();
    assert_eq!(
        (
            claims.sub.as_str(),
            claims.role.as_str(),
            claims.auth_mode.as_str()
        ),
        (ALICE, "admin", "apple")
    );
}

// --- local availability ----------------------------------------------------------------

type Row = (Option<i64>, &'static str, Option<i64>);

async fn media_db(path: &std::path::Path, movies: &[Row], shows: &[Row]) {
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
    for (table, rows) in [("movies", movies), ("shows", shows)] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TABLE {table} (id INTEGER PRIMARY KEY AUTOINCREMENT, tmdb_id INTEGER UNIQUE, title TEXT NOT NULL, year INTEGER, added_at TEXT NOT NULL DEFAULT 'now')"
        )))
        .execute(&pool)
        .await
        .unwrap();
        for (id, title, year) in rows {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO {table} (tmdb_id, title, year) VALUES (?, ?, ?)"
            )))
            .bind(id)
            .bind(title)
            .bind(year)
            .execute(&pool)
            .await
            .unwrap();
        }
    }
    pool.close().await;
}

fn item(id: i64, title: &str, year: Option<i64>, on: Option<&[&str]>) -> Item {
    Item {
        id,
        title: title.into(),
        year,
        available_on: on.map(|o| o.iter().map(|s| s.to_string()).collect()),
        ..Item::default()
    }
}

/// tag_local over a fresh media.db (None: no file at all).
async fn local(
    db: Option<(&[Row], &[Row])>,
    items: Vec<Item>,
    kind: Kind,
    media_core: bool,
) -> Vec<Item> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("media.db");
    if let Some((movies, shows)) = db {
        media_db(&path, movies, shows).await;
    }
    let p = path.to_str().unwrap().to_string();
    let flag = if media_core { "1" } else { "0" };
    let st = state_in(&dir, &[("USE_MEDIA_CORE", flag), ("MEDIA_DB_PATH", &p)]).await;
    availability::tag_local(&st, items, kind).await
}

fn has_local(it: &Item) -> bool {
    it.available_on
        .as_ref()
        .is_some_and(|o| o.iter().any(|s| s == "local"))
}

#[tokio::test]
async fn local_tagging_cases() {
    let m = |rows: &'static [Row]| Some((rows, &[][..]));
    // Primary: the tmdb_id join wins whatever the title.
    let out = local(
        m(&[(Some(603), "junk reversed title", Some(1999))]),
        vec![item(603, "The Matrix", Some(1999), None)],
        Kind::Movie,
        true,
    )
    .await;
    assert!(has_local(&out[0]));
    // Fallback: normalized title plus the exact year.
    let out = local(
        m(&[(None, "The Matrix", Some(1999))]),
        vec![item(603, "Matrix", Some(1999), None)],
        Kind::Movie,
        true,
    )
    .await;
    assert!(has_local(&out[0]));
    let out = local(
        m(&[(None, "The Matrix", Some(2003))]),
        vec![item(603, "The Matrix", Some(1999), None)],
        Kind::Movie,
        true,
    )
    .await;
    assert!(!has_local(&out[0]), "a different year");
    let out = local(
        m(&[(None, "Up", Some(2009))]),
        vec![item(999, "Up", Some(2009), None)],
        Kind::Movie,
        true,
    )
    .await;
    assert!(!has_local(&out[0]), "a normalized title under 5 characters");
    // Composes with iptv, never duplicates.
    let out = local(
        m(&[(Some(603), "x", Some(1999))]),
        vec![item(603, "The Matrix", Some(1999), Some(&["iptv"]))],
        Kind::Movie,
        true,
    )
    .await;
    assert_eq!(
        out[0].available_on.as_deref(),
        Some(&["iptv".to_string(), "local".to_string()][..])
    );
    let out = local(
        m(&[(Some(603), "x", Some(1999))]),
        vec![item(603, "The Matrix", Some(1999), Some(&["local"]))],
        Kind::Movie,
        true,
    )
    .await;
    assert_eq!(
        out[0].available_on.as_deref(),
        Some(&["local".to_string()][..])
    );
    // TV reads shows.
    let shows: &[Row] = &[(Some(1396), "Breaking Bad", Some(2008))];
    let out = local(
        Some((&[], shows)),
        vec![item(1396, "Breaking Bad", Some(2008), None)],
        Kind::Tv,
        true,
    )
    .await;
    assert!(has_local(&out[0]));
    let out = local(
        Some((shows, &[])),
        vec![item(1396, "Breaking Bad", Some(2008), None)],
        Kind::Tv,
        true,
    )
    .await;
    assert!(!has_local(&out[0]), "movies is not read for tv");
    // Off, or no media.db: untouched.
    let input = vec![item(603, "The Matrix", Some(1999), None)];
    assert_eq!(
        local(
            m(&[(Some(603), "The Matrix", Some(1999))]),
            input.clone(),
            Kind::Movie,
            false
        )
        .await,
        input
    );
    assert_eq!(local(None, input.clone(), Kind::Movie, true).await, input);
}

/// localAvailability.bench.test.ts: precision must stay 1.0; recall is
/// pinned at what the fixtures reach (1.0).
#[tokio::test]
async fn local_matcher_precision_and_recall() {
    let movies: &[Row] = &[
        (Some(603), "zzz reversed junk title", Some(2099)),
        (None, "The Matrix", Some(1999)),
        (None, "WALL\u{b7}E", Some(2008)),
        (None, "Spider-Man", Some(2002)),
        (None, "The Lord of the Rings", Some(2001)),
        (None, "Up", Some(2009)),
        (None, "Blade Runner", Some(1982)),
    ];
    let movie_cases: &[(&str, i64, &str, Option<i64>, bool)] = &[
        (
            "primary-id-hit (title+year mismatch, id wins)",
            603,
            "Completely Different Name",
            Some(1234),
            true,
        ),
        ("fallback-article-strip", 700001, "Matrix", Some(1999), true),
        (
            "variance-unicode (WALL\u{b7}E == WALLE)",
            700002,
            "WALLE",
            Some(2008),
            true,
        ),
        (
            "variance-hyphen+case",
            700003,
            "spiderman",
            Some(2002),
            true,
        ),
        (
            "variance-article+spacing",
            700004,
            "lord of the rings",
            Some(2001),
            true,
        ),
        (
            "neg-year-off-by-one",
            700005,
            "Blade Runner",
            Some(1983),
            false,
        ),
        ("neg-remake-year", 700006, "Blade Runner", Some(2049), false),
        ("neg-missing-year", 700007, "The Matrix", None, false),
        ("neg-short-norm-title", 700008, "Up", Some(2009), false),
        (
            "neg-true-nonmatch",
            700009,
            "Some Film Nobody Owns",
            Some(2015),
            false,
        ),
    ];
    let shows: &[Row] = &[
        (Some(1396), "reversed junk show title", Some(2099)),
        (None, "The Expanse", Some(2015)),
        (None, "Breaking Bad", Some(2008)),
    ];
    let show_cases: &[(&str, i64, &str, Option<i64>, bool)] = &[
        (
            "tv-primary-id-hit",
            1396,
            "Different Show Title",
            Some(1000),
            true,
        ),
        (
            "tv-fallback-article-strip",
            800001,
            "Expanse",
            Some(2015),
            true,
        ),
        (
            "tv-fallback-exact",
            800002,
            "breaking bad",
            Some(2008),
            true,
        ),
        (
            "tv-neg-year-mismatch",
            800003,
            "Breaking Bad",
            Some(2009),
            false,
        ),
        (
            "tv-neg-true-nonmatch",
            800004,
            "A Show That Does Not Exist",
            Some(2020),
            false,
        ),
    ];
    for (kind, db, cases) in [
        (Kind::Movie, (movies, &[][..]), movie_cases),
        (Kind::Tv, (&[][..], shows), show_cases),
    ] {
        let items: Vec<Item> = cases
            .iter()
            .map(|(_, id, t, y, _)| item(*id, t, *y, None))
            .collect();
        let out = local(Some(db), items, kind, true).await;
        let (mut tp, mut fp, mut fneg) = (0, 0, 0);
        for ((klass, .., want), got) in cases.iter().zip(&out) {
            match (has_local(got), *want) {
                (true, true) => tp += 1,
                (true, false) => fp += 1,
                (false, true) => fneg += 1,
                _ => {}
            }
            assert_eq!(has_local(got), *want, "{klass}");
        }
        assert_eq!(fp, 0, "precision must stay 1.0");
        assert_eq!(fneg, 0, "recall 1.0 ({tp} positives)");
    }
    // The year is a hard gate, not a tiebreak.
    let twins: &[Row] = &[
        (None, "Blade Runner", Some(1982)),
        (None, "Blade Runner", Some(1983)),
    ];
    for (year, want) in [(1982, true), (1983, true), (1984, false)] {
        let out = local(
            Some((twins, &[])),
            vec![item(900_000 + year, "Blade Runner", Some(year), None)],
            Kind::Movie,
            true,
        )
        .await;
        assert_eq!(has_local(&out[0]), want, "{year}");
    }
}

#[tokio::test]
async fn media_db_opens_read_only_and_never_creates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("media.db");
    let p = path.to_str().unwrap();
    assert!(
        availability::open_media_db(p).await.is_err(),
        "missing file"
    );
    assert!(!path.exists(), "never created");
    media_db(&path, &[(Some(1), "A Film", Some(2000))], &[]).await;
    let db = availability::open_media_db(p).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM movies")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(n, 1);
    assert!(
        sqlx::query("INSERT INTO movies (title) VALUES ('x')")
            .execute(&db)
            .await
            .is_err(),
        "read-only"
    );

    // The handle: None while missing (remembered), cached once open.
    let missing = availability::MediaDb::default();
    assert!(
        missing
            .get(dir.path().join("nope.db").to_str().unwrap())
            .await
            .is_none()
    );
    let cached = availability::MediaDb::default();
    assert!(cached.get(p).await.is_some());
    db.close().await;
    std::fs::remove_file(&path).unwrap();
    assert!(cached.get(p).await.is_some(), "cached");
}
