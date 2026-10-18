//! tmdb.test.ts's cases are goldens (tmdb/goldens.rs: auth gate,
//! not_configured, api key vs read token, credits movie/tv/find failures,
//! malformed queries, trending, videos ranking and tv lookup, related cap and
//! /similar fallback, person header, cap and failures, the credits-only
//! variant). Here: the muxed-trailer stream on ServeFile (206, suffix, 416,
//! full, HEAD, multi-range), its token gate, publicBaseUrl.test.ts, and the
//! loopback-only default every test config starts from.

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Request};
use serde_json::json;

use super::*;
use crate::testutil::Reply;
use crate::testutil::*;

const ID: &str = "muxAAAAAAAA";

struct T {
    _dir: tempfile::TempDir,
    st: AppState,
    app: Router,
    cookie: String,
}

/// A state whose mux dir holds a 2000-byte trailer for [`ID`].
async fn setup() -> T {
    let dir = tempfile::tempdir().unwrap();
    let mut st = state_in(&dir, &[]).await;
    let mut config = (*st.config).clone();
    config.ext.mux_dir = dir.path().join("mux");
    std::fs::create_dir(&config.ext.mux_dir).unwrap();
    let bytes: Vec<u8> = (0..2000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(muxed_path(&config.ext.mux_dir, ID), bytes).unwrap();
    st.config = std::sync::Arc::new(config);
    let cookie = member(&st, ALICE, "alice", "user").await;
    let app = crate::router(st.clone());
    T {
        _dir: dir,
        st,
        app,
        cookie,
    }
}

impl T {
    fn token(
        &self,
        sub: &str,
        id: &str,
        kind: emerald_contracts::stream_token::StreamKind,
    ) -> String {
        media_token::sign(
            &self.st.config.auth.stream_token_secret,
            sub,
            &media_token::resource_id("trailer", id),
            kind,
            600,
        )
    }

    async fn get(&self, path: &str, headers: &[(&str, &str)]) -> Reply {
        let mut req = Request::get(path);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        send(&self.app, req.body(Body::empty()).unwrap()).await
    }

    async fn stream(&self, range: Option<&str>) -> Reply {
        let t = self.token(ALICE, ID, media_token::DIRECT);
        let path = format!("/api/tmdb/trailer/{ID}/stream.mp4?t={t}");
        match range {
            Some(r) => self.get(&path, &[("range", r)]).await,
            None => self.get(&path, &[]).await,
        }
    }
}

fn h<'a>(r: &'a Reply, k: &str) -> Option<&'a str> {
    r.headers.get(k).map(|v| v.to_str().unwrap())
}

#[tokio::test]
async fn the_full_file_is_served_with_its_headers() {
    let t = setup().await;
    let r = t.stream(None).await;
    assert_eq!(r.status, 200);
    assert_eq!(h(&r, "content-type"), Some("video/mp4"));
    assert_eq!(h(&r, "content-length"), Some("2000"));
    assert_eq!(h(&r, "accept-ranges"), Some("bytes"));
    assert_eq!(h(&r, "cache-control"), Some("private, max-age=3600"));
}

#[tokio::test]
async fn ranges_answer_206_and_past_the_end_416() {
    let t = setup().await;
    let r = t.stream(Some("bytes=10-19")).await;
    assert_eq!(r.status, 206);
    assert_eq!(h(&r, "content-range"), Some("bytes 10-19/2000"));
    assert_eq!(h(&r, "content-length"), Some("10"));
    let want: String = (10..20u32).map(|i| char::from((i % 251) as u8)).collect();
    assert_eq!(r.body, want);

    let suffix = t.stream(Some("bytes=-10")).await;
    assert_eq!(suffix.status, 206);
    assert_eq!(h(&suffix, "content-range"), Some("bytes 1990-1999/2000"));

    let open = t.stream(Some("bytes=1990-")).await;
    assert_eq!(open.status, 206);
    assert_eq!(h(&open, "content-range"), Some("bytes 1990-1999/2000"));

    let past = t.stream(Some("bytes=5000-")).await;
    assert_eq!(past.status, 416);
    assert_eq!(h(&past, "content-range"), Some("bytes */2000"));
}

/// TS ignored a range it could not parse (multi-range included) and sent the
/// whole file; ServeFile refuses multipart ranges with 416.
#[tokio::test]
async fn a_multi_range_request_is_416() {
    let t = setup().await;
    let r = t.stream(Some("bytes=0-1,5-6")).await;
    assert_eq!(r.status, 416);
}

#[tokio::test]
async fn head_answers_the_headers_without_a_body() {
    let t = setup().await;
    let tok = t.token(ALICE, ID, media_token::DIRECT);
    let req = Request::head(format!("/api/tmdb/trailer/{ID}/stream.mp4?t={tok}"))
        .body(Body::empty())
        .unwrap();
    let r = send(&t.app, req).await;
    assert_eq!(r.status, 200);
    assert_eq!(h(&r, "content-length"), Some("2000"));
    assert!(r.body.is_empty());
}

#[tokio::test]
async fn a_session_also_opens_the_stream() {
    let t = setup().await;
    let path = format!("/api/tmdb/trailer/{ID}/stream.mp4");
    assert_eq!(t.get(&path, &[]).await.status, 401);
    let r = t.get(&path, &[("cookie", &t.cookie)]).await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn the_token_gate() {
    let t = setup().await;
    let path = |tok: &str| format!("/api/tmdb/trailer/{ID}/stream.mp4?t={tok}");
    let body = |r: &Reply| serde_json::from_str::<serde_json::Value>(&r.body).unwrap();

    let hls = t.token(ALICE, ID, media_token::HLS);
    let r = t.get(&path(&hls), &[]).await;
    assert_eq!(
        (r.status.as_u16(), body(&r)),
        (401, json!({ "error": "token_kind" }))
    );

    let other = t.token(ALICE, "proAAAAAAAA", media_token::DIRECT);
    let r = t.get(&path(&other), &[]).await;
    assert_eq!(
        (r.status.as_u16(), body(&r)),
        (401, json!({ "error": "token_mismatch" }))
    );

    // A token outlives nothing: a revoked member's token stops working.
    let tok = t.token(ALICE, ID, media_token::DIRECT);
    sqlx::query("UPDATE members SET revoked_at = ? WHERE sub = ?")
        .bind(auth::now_iso())
        .bind(ALICE)
        .execute(&t.st.auth.pool)
        .await
        .unwrap();
    let r = t.get(&path(&tok), &[]).await;
    assert_eq!(
        (r.status.as_u16(), body(&r)),
        (401, json!({ "error": "access_revoked" }))
    );

    let stranger = t.token(BOB, ID, media_token::DIRECT);
    assert_eq!(t.get(&path(&stranger), &[]).await.status, 401);
}

#[tokio::test]
async fn a_missing_file_is_trailer_not_ready_and_a_bad_key_400() {
    let t = setup().await;
    let tok = t.token(ALICE, "proAAAAAAAA", media_token::DIRECT);
    let r = t
        .get(
            &format!("/api/tmdb/trailer/proAAAAAAAA/stream.mp4?t={tok}"),
            &[],
        )
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.body, r#"{"error":"trailer_not_ready"}"#);
    let r = t
        .get(
            "/api/tmdb/trailer/..%2F..%2Fx/stream.mp4",
            &[("cookie", &t.cookie)],
        )
        .await;
    assert_eq!(r.status, 400);
}

/// Every test config's TMDB base is a refusing loopback port: a forgotten
/// override fails as the synthesized 504, never reaching TMDB.
#[tokio::test]
async fn the_test_default_never_leaves_loopback() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, &[("TMDB_API_KEY", "k")]).await;
    assert!(st.config.ext.tmdb_base.starts_with("http://127.0.0.1:9/"));
    let cookie = member(&st, ALICE, "alice", "user").await;
    let app = crate::router(st);
    let r = send(
        &app,
        json_req("GET", "/api/tmdb/trending/movie", Some(&cookie), None),
    )
    .await;
    assert_eq!(r.status, 502);
    assert_eq!(r.body, r#"{"error":"tmdb_trending_failed","status":504}"#);
}

// --- publicBaseUrl.test.ts -------------------------------------------------------------

fn base_for(forwarded_host: &str, allowed: &[&str]) -> String {
    let mut headers = HeaderMap::new();
    headers.insert("host", HeaderValue::from_static("internal.local:3001"));
    headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
    headers.insert(
        "x-forwarded-host",
        HeaderValue::from_str(forwarded_host).unwrap(),
    );
    let allowed: Vec<String> = allowed.iter().map(|s| s.to_string()).collect();
    public_base_url(&headers, &allowed)
}

const SITE: &str = "https://theemeraldexchange.example";

#[test]
fn accepts_a_forwarded_host_matching_an_allowed_origin() {
    assert_eq!(base_for("theemeraldexchange.example", &[SITE]), SITE);
}

#[test]
fn accepts_a_subdomain_of_an_allowed_origin() {
    assert_eq!(
        base_for("api.theemeraldexchange.example", &[SITE]),
        "https://api.theemeraldexchange.example"
    );
    assert_eq!(
        base_for("API.TheEmeraldExchange.example:8443", &[SITE]),
        "https://API.TheEmeraldExchange.example:8443"
    );
}

#[test]
fn falls_back_to_the_first_allowed_origin_for_a_foreign_host() {
    for evil in [
        "evil.example.com",
        "eviltheemeraldexchange.example",
        "theemeraldexchange.example.evil.com",
    ] {
        assert_eq!(base_for(evil, &[SITE]), SITE, "{evil}");
    }
    // A malformed entry never matches and is skipped as the fallback.
    assert_eq!(base_for("evil.example.com", &["not a url", SITE]), SITE);
    assert_eq!(
        base_for("evil.example.com", &["not a url"]),
        "https://internal.local:3001"
    );
}

#[test]
fn passes_the_forwarded_host_through_without_an_allowlist() {
    assert_eq!(base_for("api.example.com", &[]), "https://api.example.com");
    // A host with a path or space falls back to the request's own Host.
    assert_eq!(base_for("evil.com/x", &[]), "https://internal.local:3001");
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-proto", HeaderValue::from_static("gopher"));
    assert_eq!(public_base_url(&headers, &[]), "http://localhost");
}
