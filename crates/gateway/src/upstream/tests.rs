//! Carried over from services/upstream.test.ts (fetchWithTimeout), arr.test.ts
//! (arrFetch) and sab.test.ts, against a local axum fake.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Request, State};
use axum::routing::any;

use super::*;
use crate::testutil::config;

#[derive(Clone, Debug, Default)]
struct Seen {
    method: String,
    uri: String,
    api_key: Option<String>,
    accept: Option<String>,
    content_type: Option<String>,
    body: String,
}

type Log = Arc<Mutex<Vec<Seen>>>;

/// Records each request; `/status/<n>` answers n, `/slow` sleeps 2 s.
async fn fake() -> (String, Log) {
    async fn handle(State(log): State<Log>, req: Request) -> Response {
        let (parts, body) = req.into_parts();
        let h = |n: &str| {
            parts
                .headers
                .get(n)
                .map(|v| v.to_str().unwrap().to_string())
        };
        let mut seen = Seen {
            method: parts.method.to_string(),
            uri: parts.uri.to_string(),
            api_key: h("x-api-key"),
            accept: h("accept"),
            content_type: h("content-type"),
            body: String::new(),
        };
        let path = parts.uri.path().to_string();
        let body = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        seen.body = String::from_utf8(body.to_vec()).unwrap();
        log.lock().unwrap().push(seen);
        if path == "/slow" {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let status = path
            .strip_prefix("/status/")
            .and_then(|s| s.split('/').next()?.parse().ok())
            .unwrap_or(200);
        (
            StatusCode::from_u16(status).unwrap(),
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"ok":true}"#,
        )
            .into_response()
    }
    let log = Log::default();
    let app = Router::new().fallback(any(handle)).with_state(log.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), log)
}

fn json(reply: &Reply) -> serde_json::Value {
    serde_json::from_slice(&reply.body).unwrap()
}

/// A port nothing listens on.
async fn closed_port() -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    format!("http://{addr}")
}

#[tokio::test]
async fn fetch_forwards_the_upstream_response_in_time() {
    let (base, _) = fake().await;
    let up = Upstream::default();
    let r = up
        .fetch(
            up.client.get(format!("{base}/status/201")),
            LAN_TIMEOUT,
            "x",
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(&r.body[..], br#"{"ok":true}"#);
    assert!(r.is_success());
}

#[tokio::test]
async fn fetch_synthesizes_a_504_on_timeout() {
    let (base, _) = fake().await;
    let up = Upstream::default();
    let r = up
        .fetch(
            up.client.get(format!("{base}/slow")),
            Duration::from_millis(100),
            "sonarr",
        )
        .await;
    assert_eq!(r.status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(r.headers[header::CONTENT_TYPE], "application/json");
    assert_eq!(
        json(&r),
        serde_json::json!({"error": "upstream_timeout", "service": "sonarr", "message": "This operation was aborted"})
    );
}

#[tokio::test]
async fn fetch_synthesizes_a_504_when_unreachable_without_the_url() {
    let base = closed_port().await;
    let up = Upstream::default();
    let r = up
        .fetch(
            up.client.get(format!("{base}/api?apikey=leaky-key")),
            LAN_TIMEOUT,
            "sab",
        )
        .await;
    assert_eq!(r.status, StatusCode::GATEWAY_TIMEOUT);
    let body = json(&r);
    assert_eq!(body["error"], "upstream_unreachable");
    assert_eq!(body["service"], "sab");
    let text = String::from_utf8(r.body.to_vec()).unwrap();
    assert!(
        !text.contains("leaky-key") && !text.contains(&base),
        "{text}"
    );
}

#[tokio::test]
async fn arr_fetch_injects_the_key_and_merges_the_query() {
    let (base, log) = fake().await;
    let c = config(&[
        ("SONARR_URL", &format!("{base}/tv")),
        ("SONARR_API_KEY", "sk"),
    ]);
    let r = Upstream::default()
        .arr_fetch(
            &c,
            Arr::Sonarr,
            Method::GET,
            "/api/v3/episode?seriesId=1&term=old",
            &[("term", "a b&c"), ("page", "2")],
            None,
            LAN_TIMEOUT,
        )
        .await
        .unwrap();
    assert_eq!(r.status, StatusCode::OK);
    let seen = log.lock().unwrap()[0].clone();
    assert_eq!(seen.method, "GET");
    assert_eq!(
        seen.uri,
        "/tv/api/v3/episode?seriesId=1&term=a+b%26c&page=2"
    );
    assert_eq!(seen.api_key.as_deref(), Some("sk"));
    assert_eq!(seen.accept.as_deref(), Some("application/json"));
}

#[tokio::test]
async fn arr_fetch_keeps_the_method_and_sends_a_json_body() {
    let (base, log) = fake().await;
    let c = config(&[("RADARR_URL", &base), ("RADARR_API_KEY", "rk")]);
    let body = serde_json::json!({"guid": "g", "indexerId": 3});
    Upstream::default()
        .arr_fetch(
            &c,
            Arr::Radarr,
            Method::POST,
            "/api/v3/release",
            &[],
            Some(&body),
            SEARCH_TIMEOUT,
        )
        .await
        .unwrap();
    let seen = log.lock().unwrap()[0].clone();
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.api_key.as_deref(), Some("rk"));
    assert_eq!(seen.content_type.as_deref(), Some("application/json"));
    assert_eq!(seen.body, r#"{"guid":"g","indexerId":3}"#);
}

#[tokio::test]
async fn arr_fetch_normalizes_an_upstream_401() {
    let (base, _) = fake().await;
    let c = config(&[("SONARR_URL", &base), ("SONARR_API_KEY", "bad")]);
    let up = Upstream::default();
    let r = up
        .arr_fetch(
            &c,
            Arr::Sonarr,
            Method::GET,
            "/status/401",
            &[],
            None,
            LAN_TIMEOUT,
        )
        .await
        .unwrap();
    assert_eq!(r.status, StatusCode::BAD_GATEWAY);
    assert_eq!(json(&r), serde_json::json!({"error": "sonarr_auth_failed"}));
    // Other statuses pass through.
    let r = up
        .arr_fetch(
            &c,
            Arr::Sonarr,
            Method::GET,
            "/status/404",
            &[],
            None,
            LAN_TIMEOUT,
        )
        .await
        .unwrap();
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn arr_fetch_honours_a_custom_timeout() {
    let (base, _) = fake().await;
    let c = config(&[("RADARR_URL", &base), ("RADARR_API_KEY", "k")]);
    let r = Upstream::default()
        .arr_fetch(
            &c,
            Arr::Radarr,
            Method::GET,
            "/slow",
            &[],
            None,
            Duration::from_millis(100),
        )
        .await
        .unwrap();
    assert_eq!(r.status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(json(&r)["service"], "radarr");
}

#[tokio::test]
async fn unconfigured_integrations_are_a_typed_503() {
    let c = config(&[]);
    let up = Upstream::default();
    for (svc, err) in [
        (Arr::Sonarr, "sonarr_not_configured"),
        (Arr::Radarr, "radarr_not_configured"),
    ] {
        let e = up
            .arr_fetch(
                &c,
                svc,
                Method::GET,
                "/api/v3/series",
                &[],
                None,
                LAN_TIMEOUT,
            )
            .await
            .unwrap_err();
        let res = e.into_response();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], format!(r#"{{"error":"{err}"}}"#).as_bytes());
    }
    let e = up.sab_call(&c, "queue", &[]).await.unwrap_err();
    assert!(matches!(e, Error::NotConfigured("sab")));
}

#[tokio::test]
async fn sab_call_puts_the_key_in_the_query_never_a_header() {
    let (base, log) = fake().await;
    let c = config(&[("SAB_URL", &base), ("SAB_API_KEY", "sabkey")]);
    let up = Upstream::default();
    let r = up
        .sab_call(
            &c,
            "queue",
            &[("name", "delete"), ("value", "SABnzbd nzo 1")],
        )
        .await
        .unwrap();
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(&r.body[..], br#"{"ok":true}"#);
    // Reserved params stay present; an extra cannot drop them, only replace.
    up.sab_call(&c, "history", &[("output", "xml")])
        .await
        .unwrap();
    let log = log.lock().unwrap();
    assert_eq!(
        log[0].uri,
        "/api?mode=queue&output=json&apikey=sabkey&name=delete&value=SABnzbd+nzo+1"
    );
    assert_eq!(log[0].api_key, None);
    assert_eq!(log[1].uri, "/api?mode=history&apikey=sabkey&output=xml");
}

#[tokio::test]
async fn sab_call_is_a_504_not_an_error_when_unreachable() {
    let c = config(&[("SAB_URL", &closed_port().await), ("SAB_API_KEY", "k")]);
    let r = Upstream::default()
        .sab_call(&c, "queue", &[])
        .await
        .unwrap();
    assert_eq!(r.status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(json(&r)["service"], "sab");
}

#[tokio::test]
async fn a_reply_forwards_status_content_type_and_body() {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    headers.insert("x-internal", HeaderValue::from_static("1"));
    let res = Reply {
        status: StatusCode::IM_A_TEAPOT,
        headers,
        body: Bytes::from_static(b"hi"),
    }
    .into_response();
    assert_eq!(res.status(), StatusCode::IM_A_TEAPOT);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "text/plain");
    assert!(res.headers().get("x-internal").is_none());
}
