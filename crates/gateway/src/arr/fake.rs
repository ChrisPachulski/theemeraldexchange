//! The Rust copy of gen-arr-goldens.ts's fake: one local server for Radarr
//! (/radarr), SAB (/sab) and the recommender (/rec), answering from fixture
//! routes and recording every request. A route may hold its answer until the
//! test releases it, or answer after a delay.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Semaphore;

#[derive(Clone, Debug, Deserialize)]
pub struct Route {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: Option<serde_json::Map<String, Value>>,
    pub status: u16,
    pub text: String,
    pub ct: String,
    /// Answer only once the test calls [`Fake::release_held`].
    #[serde(default)]
    pub hold: bool,
    #[serde(default)]
    pub delay_ms: u64,
}

impl Route {
    pub fn new(method: &str, path: &str, status: u16, body: &Value) -> Route {
        Route {
            method: method.into(),
            path: path.into(),
            query: None,
            status,
            text: body.to_string(),
            ct: "application/json".into(),
            hold: false,
            delay_ms: 0,
        }
    }

    pub fn query(mut self, k: &str, v: &str) -> Route {
        self.query
            .get_or_insert_with(Default::default)
            .insert(k.into(), v.into());
        self
    }
}

/// One request the fake saw, in the golden's shape.
#[derive(Clone, Debug, PartialEq)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Value,
    pub key_header: Option<String>,
    pub secret: Option<String>,
    pub bearer: bool,
}

#[derive(Clone)]
pub struct Fake {
    pub url: String,
    routes: Arc<Mutex<Vec<Route>>>,
    calls: Arc<Mutex<Vec<Call>>>,
    held: Arc<Semaphore>,
}

impl Fake {
    pub async fn start(routes: Vec<Route>) -> Fake {
        let fake = Fake {
            url: String::new(),
            routes: Arc::new(Mutex::new(routes)),
            calls: Default::default(),
            held: Arc::new(Semaphore::new(0)),
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

    async fn handle(&self, req: Request<Body>) -> Response {
        let (key_header, secret, bearer) = {
            let h = req.headers();
            let get = |k: &str| h.get(k).map(|v| v.to_str().unwrap().to_string());
            (
                get("x-api-key"),
                get("x-recommender-secret"),
                h.contains_key(header::AUTHORIZATION),
            )
        };
        let method = req.method().to_string();
        let path = req.uri().path().to_string();
        let query = req.uri().query().unwrap_or_default().to_string();
        let pairs = super::shared::query_pairs(req.uri());
        let bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
            .await
            .unwrap();
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
            key_header,
            secret,
            bearer,
        });
        let hit = self
            .routes
            .lock()
            .unwrap()
            .iter()
            .find(|r| {
                r.method == method
                    && r.path == path
                    && r.query
                        .iter()
                        .flatten()
                        .all(|(k, v)| super::shared::query_first(&pairs, k) == v.as_str())
            })
            .cloned();
        let Some(hit) = hit else {
            let rec = path.starts_with("/rec/");
            let (status, text) = if rec {
                (StatusCode::OK, "{}")
            } else {
                (StatusCode::NOT_FOUND, r#"{"error":"no fixture"}"#)
            };
            return (status, [(header::CONTENT_TYPE, "application/json")], text).into_response();
        };
        if hit.hold {
            self.held.acquire().await.unwrap().forget();
        }
        if hit.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(hit.delay_ms)).await;
        }
        (
            StatusCode::from_u16(hit.status).unwrap(),
            [(header::CONTENT_TYPE, hit.ct)],
            hit.text,
        )
            .into_response()
    }

    pub fn set_routes(&self, routes: Vec<Route>) {
        *self.routes.lock().unwrap() = routes;
    }

    /// Let `n` held answers go.
    pub fn release_held(&self, n: usize) {
        self.held.add_permits(n);
    }

    pub fn take(&self) -> Vec<Call> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }

    pub fn count(&self, method: &str, path: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.method == method && c.path == path)
            .count()
    }

    /// Wait out fire-and-forget mirrors (no new call for 100 ms).
    pub async fn quiet(&self) {
        let mut seen = usize::MAX;
        loop {
            let n = self.calls.lock().unwrap().len();
            if n == seen {
                return;
            }
            seen = n;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Poll until `f` holds (2 s at most).
    pub async fn until(&self, f: impl Fn(&Fake) -> bool) {
        for _ in 0..200 {
            if f(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition never held");
    }
}
