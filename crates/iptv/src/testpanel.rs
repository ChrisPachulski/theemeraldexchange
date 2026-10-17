//! Local mock Xtream panel for tests: serves fixture JSON per `action`, the
//! XMLTV feed and any external feed path on 127.0.0.1. No test ever dials the
//! real provider or an external EPG host.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;

use crate::config::{Config, test_config};
use crate::sync::{CatalogSync, SyncResult};
use crate::xtream::{Client, Creds};

#[derive(Clone)]
enum Reply {
    Json(Value),
    Status(u16),
    Redirect(String),
    Bytes(Vec<u8>),
}

#[derive(Default)]
struct Inner {
    replies: Mutex<HashMap<String, Reply>>,
    feeds: Mutex<HashMap<String, Reply>>,
    hits: AtomicUsize,
    feed_hits: Mutex<Vec<String>>,
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
    respond(reply)
}

/// Every other path: the provider's /xmltv.php (an empty feed unless set)
/// and external feeds.
async fn serve_feed(State(inner): State<Arc<Inner>>, uri: axum::http::Uri) -> Response {
    let path = uri.path().to_string();
    inner.feed_hits.lock().unwrap().push(path.clone());
    let reply = inner.feeds.lock().unwrap().get(&path).cloned();
    match reply {
        None if path == "/xmltv.php" => "<tv></tv>".into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
        r => respond(r),
    }
}

fn respond(reply: Option<Reply>) -> Response {
    match reply {
        Some(Reply::Bytes(b)) => b.into_response(),
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
            .fallback(serve_feed)
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
    /// Serve `body` at `path` ("/xmltv.php" or an external feed path).
    pub fn set_feed(&self, path: &str, body: impl Into<Vec<u8>>) {
        self.put_feed(path, Reply::Bytes(body.into()));
    }
    pub fn set_feed_status(&self, path: &str, status: u16) {
        self.put_feed(path, Reply::Status(status));
    }
    pub fn set_feed_redirect(&self, path: &str, to: &str) {
        self.put_feed(path, Reply::Redirect(to.to_string()));
    }
    fn put_feed(&self, path: &str, r: Reply) {
        self.inner.feeds.lock().unwrap().insert(path.to_string(), r);
    }
    /// Feed paths requested, in order.
    pub fn feed_hits(&self) -> Vec<String> {
        self.inner.feed_hits.lock().unwrap().clone()
    }
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
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

/// tests/fixtures/<name> as JSON.
pub fn json_fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The epg-sync-scenario.json run that gen-epg-goldens.ts replays on the TS
/// stack: a panel serving its catalog, and a sync wired to it and its feeds.
pub struct Scenario {
    pub panel: Panel,
    pub sync: Arc<CatalogSync>,
    json: Value,
    _dir: tempfile::TempDir,
}

impl Scenario {
    pub async fn start() -> Self {
        let json = json_fixture("epg-sync-scenario.json");
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        let panel = Panel::start().await;
        panel.set("get_live_categories", json["live_categories"].clone());
        panel.set("get_live_streams", json["live_streams"].clone());
        let urls: Vec<String> = Self::paths(&json).map(|p| panel.url(p)).collect();
        let config = test_config(&[
            ("XTREAM_HOST", &panel.base),
            ("XTREAM_USERNAME", "u"),
            ("XTREAM_PASSWORD", "p"),
            ("IPTV_EXTERNAL_EPG_URLS", &urls.join(",")),
        ]);
        let sync = CatalogSync::new(pool, Arc::new(config));
        Scenario {
            panel,
            sync,
            json,
            _dir: dir,
        }
    }

    fn paths(json: &Value) -> impl Iterator<Item = &str> {
        json["external_paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
    }

    pub fn steps(&self) -> usize {
        self.json["syncs"].as_array().unwrap().len()
    }

    /// Serve step `i`'s feeds (ext-b gzipped) and sync at the scenario's clock.
    pub async fn run_step(&self, i: usize) -> SyncResult {
        let step = &self.json["syncs"][i];
        self.panel
            .set_feed("/xmltv.php", step["provider_xml"].as_str().unwrap());
        for path in Self::paths(&self.json) {
            let xml = step["external"][path].as_str().unwrap();
            if path.ends_with(".gz") {
                let mut e =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                std::io::Write::write_all(&mut e, xml.as_bytes()).unwrap();
                self.panel.set_feed(path, e.finish().unwrap());
            } else {
                self.panel.set_feed(path, xml);
            }
        }
        let now = self.json["now"].as_str().unwrap().parse().unwrap();
        self.sync.sync_at(now).await.unwrap()
    }
}
