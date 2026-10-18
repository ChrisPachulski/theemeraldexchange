//! The Rust copy of gen-suggestions-goldens.ts's fake: one loopback server
//! standing in for Radarr, Sonarr, TMDB, Anthropic, the recommender and the
//! iptv service, answering from fixture routes (first match with answers
//! left) and recording every request.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderName, HeaderValue, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::arr::shared::{query_first, query_pairs};

#[derive(Clone, Debug, Deserialize)]
pub struct Route {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub prefix: bool,
    #[serde(default)]
    pub query: Option<serde_json::Map<String, Value>>,
    pub status: u16,
    pub text: String,
    pub ct: String,
    #[serde(default)]
    pub headers: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub delay_ms: u64,
    #[serde(default)]
    pub times: Option<u32>,
}

impl Route {
    pub fn json(method: &str, path: &str, status: u16, body: &Value) -> Route {
        Route {
            method: method.into(),
            path: path.into(),
            prefix: false,
            query: None,
            status,
            text: body.to_string(),
            ct: "application/json".into(),
            headers: None,
            delay_ms: 0,
            times: None,
        }
    }

    pub fn times(mut self, n: u32) -> Route {
        self.times = Some(n);
        self
    }
}

/// One request, in the golden's shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Value,
    pub key: Option<String>,
    pub authorization: Option<String>,
    pub secret: Option<String>,
}

type Remaining = (Route, Option<u32>);

#[derive(Clone)]
pub struct Fake {
    pub url: String,
    /// Each route with its answers left.
    routes: Arc<Mutex<Vec<Remaining>>>,
    calls: Arc<Mutex<Vec<Call>>>,
}

impl Fake {
    pub async fn start() -> Fake {
        let fake = Fake {
            url: String::new(),
            routes: Default::default(),
            calls: Default::default(),
        };
        let state = fake.clone();
        let app = Router::new().fallback(move |req: Request<Body>| {
            let state = state.clone();
            async move { state.handle(req).await }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Fake { url, ..fake }
    }

    pub fn set_routes(&self, routes: Vec<Route>) {
        *self.routes.lock().unwrap() = routes.into_iter().map(|r| (r.clone(), r.times)).collect();
    }

    async fn handle(&self, req: Request<Body>) -> Response {
        let (parts, body) = req.into_parts();
        let get = |k: &str| {
            parts
                .headers
                .get(k)
                .map(|v| v.to_str().unwrap().to_string())
        };
        let (key, authorization, secret) = (
            get("x-api-key"),
            get("authorization"),
            get("x-recommender-secret"),
        );
        let method = parts.method.to_string();
        let path = parts.uri.path().to_string();
        let query = parts.uri.query().unwrap_or_default().to_string();
        let pairs = query_pairs(&parts.uri);
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        self.calls.lock().unwrap().push(Call {
            method: method.clone(),
            path: path.clone(),
            query,
            body,
            key,
            authorization,
            secret,
        });
        let hit = {
            let mut routes = self.routes.lock().unwrap();
            let found = routes.iter_mut().find(|(r, left)| {
                *left != Some(0)
                    && r.method == method
                    && if r.prefix {
                        path.starts_with(&r.path)
                    } else {
                        r.path == path
                    }
                    && r.query
                        .iter()
                        .flatten()
                        .all(|(k, v)| query_first(&pairs, k) == v.as_str())
            });
            found.map(|(r, left)| {
                if let Some(n) = left {
                    *n -= 1;
                }
                r.clone()
            })
        };
        let Some(hit) = hit else {
            return (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "application/json")],
                r#"{"error":"no fixture"}"#,
            )
                .into_response();
        };
        if hit.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(hit.delay_ms)).await;
        }
        let mut res = (StatusCode::from_u16(hit.status).unwrap(), hit.text).into_response();
        let h = res.headers_mut();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&hit.ct).unwrap(),
        );
        for (k, v) in hit.headers.iter().flatten() {
            h.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
            );
        }
        res
    }

    /// Wait out requests still in flight (no new call for 150 ms), then
    /// take what arrived.
    pub async fn settle(&self) -> Vec<Call> {
        let mut seen = usize::MAX;
        loop {
            let n = self.calls.lock().unwrap().len();
            if n == seen {
                break;
            }
            seen = n;
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
}
