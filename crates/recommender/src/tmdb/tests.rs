use serde_json::{Value, json};

use super::*;
use crate::fake_tmdb::{self, FIXTURE_CREDENTIAL};

fn route(path: &str, responses: Value) -> Value {
    json!({"routes": [{"path": path, "responses": responses}]})
}

/// A query-auth client on the fake with no pacing and a 1 ms backoff base.
fn client(base: &str, auth: Auth) -> TmdbClient {
    let mut c = TmdbClient::new(auth, &format!("{base}/3")).unwrap();
    c.limiter = RateLimit::new(10_000, Duration::from_secs(1));
    c.backoff_base = Duration::from_millis(1);
    c
}

fn key() -> Auth {
    Auth::Query(FIXTURE_CREDENTIAL.into())
}

#[tokio::test]
async fn retries_429_and_5xx_until_success() {
    let fake = fake_tmdb::start(&route(
        "/3/movie/1",
        json!([{"status": 429, "body": {}}, {"status": 500, "body": {}},
               {"status": 503, "body": {}}, {"status": 200, "body": {"id": 1}}]),
    ))
    .await;
    let got = client(&fake.base, key()).detail("movie", 1).await.unwrap();
    assert_eq!(got, json!({"id": 1}));
    assert_eq!(fake.log().len(), 4);
}

#[tokio::test]
async fn gives_up_after_five_attempts() {
    let fake = fake_tmdb::start(&route("/3/movie/1", json!([{"status": 502, "body": {}}]))).await;
    let err = client(&fake.base, key())
        .detail("movie", 1)
        .await
        .unwrap_err();
    assert_eq!(fake.log().len(), 5);
    assert_eq!(
        err.to_string(),
        format!(
            "HTTP 502 Bad Gateway for GET {}/3/movie/1?append_to_response=keywords%2Ccredits\
             &api_key=%3Credacted%3E",
            fake.base
        )
    );
}

#[tokio::test]
async fn client_errors_are_not_retried() {
    let fake = fake_tmdb::start(&json!({"routes": []})).await;
    let err = client(&fake.base, key())
        .detail("movie", 9)
        .await
        .unwrap_err();
    assert_eq!(fake.log().len(), 1);
    assert!(
        err.to_string().starts_with("HTTP 404 Not Found for GET "),
        "{err}"
    );
    // A redirect is a failed call too, never followed.
    let fake = fake_tmdb::start(&route("/3/movie/9", json!([{"status": 301, "body": {}}]))).await;
    let err = client(&fake.base, key())
        .detail("movie", 9)
        .await
        .unwrap_err();
    assert_eq!(fake.log().len(), 1);
    assert!(
        err.to_string().starts_with("HTTP 301 Moved Permanently"),
        "{err}"
    );
}

#[tokio::test]
async fn transport_errors_retry_then_fail_without_the_key() {
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let started = std::time::Instant::now();
    let c = client(&base, key());
    let err = c.detail("movie", 1).await.unwrap_err().to_string();
    assert!(!err.contains(FIXTURE_CREDENTIAL), "{err}");
    // Four backoffs of 1, 2, 4 and 8 ms ran between the five attempts.
    assert!(started.elapsed() >= Duration::from_millis(15));
}

#[test]
fn backoff_doubles_from_half_a_second_and_caps_at_eight() {
    let base = Duration::from_millis(500);
    let waits: Vec<f64> = (1..=7).map(|n| backoff(base, n).as_secs_f64()).collect();
    assert_eq!(waits, [0.5, 1.0, 2.0, 4.0, 8.0, 8.0, 8.0]);
}

thread_local! {
    static LOGS: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

struct ThreadLogs;

impl std::io::Write for ThreadLogs {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        LOGS.with(|l| l.borrow_mut().extend_from_slice(b));
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// One global subscriber writing to a per-thread buffer (a current-thread
/// tokio test logs on its own thread); a scoped one loses callsites that
/// parallel tests cached first.
fn capture_logs() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_writer(|| ThreadLogs)
            .with_ansi(false)
            .finish();
        tracing::subscriber::set_global_default(subscriber).unwrap();
    });
    LOGS.with(|l| l.borrow_mut().clear());
}

// test_tmdb_key_not_logged: query auth puts the key in the URL, and no log
// line or error text may carry it.
#[tokio::test]
async fn api_key_never_reaches_a_log_line_or_error() {
    capture_logs();
    let fake = fake_tmdb::start(&json!({"routes": [
        {"path": "/3/movie/1", "responses": [{"status": 200, "body": {}}]},
        {"path": "/3/movie/2", "responses": [{"status": 500, "body": {}}]},
    ]}))
    .await;
    let c = client(&fake.base, key());
    c.get("/movie/1", &[]).await.unwrap();
    let errors = [
        c.get("/movie/2", &[]).await.unwrap_err().to_string(),
        c.get("/movie/3", &[]).await.unwrap_err().to_string(),
    ];
    let logs = LOGS.with(|l| String::from_utf8(l.borrow().clone()).unwrap());
    assert!(logs.contains("HTTP Request"), "{logs}");
    assert!(!logs.contains(FIXTURE_CREDENTIAL), "{logs}");
    for e in errors {
        assert!(
            !e.contains(FIXTURE_CREDENTIAL) && e.contains("api_key=%3Credacted%3E"),
            "{e}"
        );
    }
    // The key did reach TMDB, in the query and not a header.
    assert_eq!(
        fake.log()[0],
        json!({"path": "/3/movie/1", "query": [["api_key", "<redacted>"]], "auth": null})
    );
}

#[tokio::test]
async fn bearer_auth_rides_the_header() {
    let fake = fake_tmdb::start(&route(
        "/3/tv/changes",
        json!([{"status": 200, "body": {}}]),
    ))
    .await;
    client(&fake.base, Auth::Bearer(FIXTURE_CREDENTIAL.into()))
        .changes("tv", "2026-01-01", "2026-01-14", 2)
        .await
        .unwrap();
    assert_eq!(
        fake.log(),
        [json!({"path": "/3/tv/changes", "auth": "bearer",
                "query": [["start_date", "2026-01-01"], ["end_date", "2026-01-14"], ["page", "2"]]})]
    );
}

#[tokio::test]
async fn bad_kind_or_id_never_calls() {
    let c = client("http://127.0.0.1:9", key());
    assert_eq!(
        c.detail("person", 1).await.unwrap_err().to_string(),
        "unsupported TMDB kind: 'person'"
    );
    assert_eq!(
        c.detail("movie", 0).await.unwrap_err().to_string(),
        "unsupported TMDB id: 0"
    );
}

#[tokio::test(start_paused = true)]
async fn rate_limit_paces_forty_per_ten_seconds() {
    let limit = RateLimit::new(40, Duration::from_secs(10));
    let start = Instant::now();
    let mut at = Vec::new();
    for _ in 0..81 {
        limit.acquire().await;
        at.push((Instant::now() - start).as_secs_f64());
    }
    assert!(at[..40].iter().all(|&t| t == 0.0));
    assert!(
        at[40..80].iter().all(|&t| (10.0..10.1).contains(&t)),
        "{:?}",
        &at[40..80]
    );
    assert!((20.0..20.1).contains(&at[80]), "{}", at[80]);
}

#[test]
fn credentials_prefer_the_bearer_token() {
    let cfg = |pairs: &'static [(&'static str, &'static str)]| {
        Config::from_lookup(|k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        })
        .unwrap()
    };
    let both = TmdbClient::from_config(&cfg(&[
        ("TMDB_READ_ACCESS_TOKEN", "t"),
        ("TMDB_API_KEY", "k"),
    ]))
    .unwrap();
    assert!(both.api_key.is_none());
    let key = TmdbClient::from_config(&cfg(&[("TMDB_API_KEY", "k")])).unwrap();
    assert_eq!(key.api_key.as_deref(), Some("k"));
    assert_eq!(key.base, TMDB_BASE);
    let err = TmdbClient::from_config(&cfg(&[("TMDB_READ_ACCESS_TOKEN", "")]))
        .err()
        .unwrap();
    assert_eq!(
        err.to_string(),
        "TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY is required"
    );
}
