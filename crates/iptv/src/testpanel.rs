//! Local mock Xtream panel for tests: serves fixture JSON per `action` on
//! 127.0.0.1. No test ever dials the real provider.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;

use crate::config::{Config, test_config};
use crate::xtream::{Client, Creds};

#[derive(Clone)]
enum Reply {
    Json(Value),
    Status(u16),
    Redirect(String),
}

#[derive(Default)]
struct Inner {
    replies: Mutex<HashMap<String, Reply>>,
    hits: AtomicUsize,
}

pub struct Panel {
    pub base: String,
    inner: Arc<Inner>,
}

async fn serve(
    State(inner): State<Arc<Inner>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    inner.hits.fetch_add(1, Ordering::SeqCst);
    let action = q.get("action").cloned().unwrap_or_default();
    let replies = inner.replies.lock().unwrap();
    let reply = q
        .get("series_id")
        .and_then(|id| replies.get(&format!("{action}:{id}")))
        .or_else(|| replies.get(&action))
        .cloned();
    drop(replies);
    match reply {
        Some(Reply::Json(v)) => axum::Json(v).into_response(),
        Some(Reply::Status(s)) => StatusCode::from_u16(s).unwrap().into_response(),
        Some(Reply::Redirect(to)) => (StatusCode::FOUND, [(header::LOCATION, to)]).into_response(),
        None => axum::Json(Value::Array(vec![])).into_response(),
    }
}

impl Panel {
    pub async fn start() -> Self {
        let inner = Arc::new(Inner::default());
        let app = axum::Router::new()
            .route("/player_api.php", axum::routing::get(serve))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Panel { base, inner }
    }

    fn put(&self, key: &str, r: Reply) {
        self.inner
            .replies
            .lock()
            .unwrap()
            .insert(key.to_string(), r);
    }
    /// `key` is an action, `get_series_info:<id>` for one series, or "" for the
    /// bare account probe.
    pub fn set(&self, key: &str, body: Value) {
        self.put(key, Reply::Json(body));
    }
    pub fn set_status(&self, key: &str, status: u16) {
        self.put(key, Reply::Status(status));
    }
    pub fn set_redirect(&self, key: &str, to: &str) {
        self.put(key, Reply::Redirect(to.to_string()));
    }
    pub fn hits(&self) -> usize {
        self.inner.hits.load(Ordering::SeqCst)
    }

    pub fn config(&self) -> Config {
        test_config(&[
            ("XTREAM_HOST", &self.base),
            ("XTREAM_USERNAME", "u"),
            ("XTREAM_PASSWORD", "p"),
        ])
    }
    pub fn client(&self) -> Client {
        Client::new(Creds::from_config(&self.config()).unwrap(), 5_000).unwrap()
    }
}
