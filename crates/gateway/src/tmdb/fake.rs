//! The Rust copy of gen-tmdb-goldens.ts's fake: one loopback server standing
//! in for TMDB (/tmdb/3), OMDb (/omdb/), Wikidata (/wikidata/sparql), Rotten
//! Tomatoes (/rt/) and googlevideo (/gv/), answering from fixture routes and
//! recording every request. A googlevideo route serves byte
//! `(i + seed) & 0xff` of a `bytes`-long stream per `range=a-b` window. A
//! route may delay its answer or hold it until the test releases it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::arr::shared::{query_first, query_pairs};

#[derive(Clone, Debug, Deserialize)]
pub struct Route {
    pub method: String,
    /// May carry `?k=v` pairs that must match too.
    pub path: String,
    #[serde(default)]
    pub query: Option<serde_json::Map<String, Value>>,
    pub status: u16,
    pub text: String,
    pub ct: String,
    #[serde(default)]
    pub delay_ms: u64,
    #[serde(default)]
    pub bytes: Option<usize>,
    #[serde(default)]
    pub seed: Option<usize>,
    /// Answer only once the test calls [`Fake::release`].
    #[serde(default)]
    pub hold: bool,
}

impl Route {
    pub fn json(path: &str, status: u16, body: &Value) -> Route {
        Route {
            method: "GET".into(),
            path: path.into(),
            query: None,
            status,
            text: body.to_string(),
            ct: "application/json".into(),
            delay_ms: 0,
            bytes: None,
            seed: None,
            hold: false,
        }
    }

    pub fn html(path: &str, status: u16, text: &str) -> Route {
        Route {
            text: text.into(),
            ct: "text/html".into(),
            ..Route::json(path, status, &Value::Null)
        }
    }

    pub fn stream(path: &str, bytes: usize, seed: usize, status: u16) -> Route {
        Route {
            bytes: Some(bytes),
            seed: Some(seed),
            ct: "video/mp4".into(),
            text: String::new(),
            ..Route::json(path, status, &Value::Null)
        }
    }

    pub fn query(mut self, k: &str, v: &str) -> Route {
        self.query
            .get_or_insert_with(Default::default)
            .insert(k.into(), v.into());
        self
    }

    pub fn held(mut self) -> Route {
        self.hold = true;
        self
    }
}

/// One request the fake saw, in the golden's shape. The runtime's own
/// defaults (no User-Agent, Accept `*/*`) read as None.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub query: String,
    pub authorization: Option<String>,
    pub user_agent: Option<String>,
    pub accept: Option<String>,
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
        let h = req.headers();
        let get = |k: header::HeaderName| h.get(k).map(|v| v.to_str().unwrap().to_string());
        let pairs = query_pairs(req.uri());
        let call = Call {
            method: req.method().to_string(),
            path: req.uri().path().to_string(),
            query: req.uri().query().unwrap_or_default().to_string(),
            authorization: get(header::AUTHORIZATION),
            user_agent: get(header::USER_AGENT),
            accept: get(header::ACCEPT).filter(|a| a != "*/*"),
        };
        self.calls.lock().unwrap().push(call.clone());
        let hit = self
            .routes
            .lock()
            .unwrap()
            .iter()
            .find(|r| {
                let (path, extra) = r.path.split_once('?').unwrap_or((&r.path, ""));
                let extra = query_pairs(&format!("/?{extra}").parse().unwrap());
                r.method == call.method
                    && path == call.path
                    && extra
                        .iter()
                        .all(|(k, v)| query_first(&pairs, k) == Some(v.as_str()))
                    && r.query
                        .iter()
                        .flatten()
                        .all(|(k, v)| query_first(&pairs, k) == v.as_str())
            })
            .cloned();
        let Some(hit) = hit else {
            return (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "application/json")],
                r#"{"error":"no fixture"}"#,
            )
                .into_response();
        };
        if hit.hold {
            self.held.acquire().await.unwrap().forget();
        }
        if hit.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(hit.delay_ms)).await;
        }
        if let Some(len) = hit.bytes
            && hit.status == 200
        {
            let window = query_first(&pairs, "range").and_then(|r| {
                let (a, b) = r.split_once('-')?;
                Some((a.parse::<usize>().ok()?, b.parse::<usize>().ok()? + 1))
            });
            let (start, end) = window.unwrap_or((0, len));
            let seed = hit.seed.unwrap_or(0);
            let body: Vec<u8> = (start..end.min(len))
                .map(|i| ((i + seed) & 0xff) as u8)
                .collect();
            return ([(header::CONTENT_TYPE, hit.ct)], body).into_response();
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
    pub fn release(&self, n: usize) {
        self.held.add_permits(n);
    }

    pub fn take(&self) -> Vec<Call> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }

    pub fn count(&self, path: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.path == path)
            .count()
    }

    /// Wait out requests still in flight (no new call for 100 ms).
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

    /// Poll until `f` holds (5 s at most).
    pub async fn until(&self, f: impl Fn(&Fake) -> bool) {
        for _ in 0..500 {
            if f(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition never held");
    }
}

/// A temp dir holding symlinks to the committed stubs (tests/fixtures/stubs)
/// and their per-video answers. Nothing executable is written at test time,
/// so a concurrent fork can never hold one open (ETXTBSY).
pub struct Stubs {
    pub dir: tempfile::TempDir,
}

impl Stubs {
    pub fn new() -> Stubs {
        let dir = tempfile::tempdir().unwrap();
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stubs");
        for name in ["eex-ytresolve", "yt-dlp", "ffmpeg", "ffprobe"] {
            std::os::unix::fs::symlink(src.join(name), dir.path().join(name)).unwrap();
        }
        std::fs::create_dir(dir.path().join("resolve")).unwrap();
        std::fs::create_dir(dir.path().join("ytdlp")).unwrap();
        Stubs { dir }
    }

    pub fn bin(&self, name: &str) -> String {
        self.dir.path().join(name).to_str().unwrap().to_string()
    }

    pub fn mux_dir(&self) -> std::path::PathBuf {
        self.dir.path().join("tmp").join("eex-ytmux")
    }

    /// Point `ext` at these stubs and `fake`'s bases.
    pub fn wire(&self, ext: &mut crate::config::External, fake: &str) {
        ext.tmdb_base = format!("{fake}/tmdb/3");
        ext.omdb_base = format!("{fake}/omdb/");
        ext.wikidata_sparql = format!("{fake}/wikidata/sparql");
        ext.rt_base = format!("{fake}/rt/");
        ext.ytresolve_bin = self.bin("eex-ytresolve");
        ext.ytdlp_bin = self.bin("yt-dlp");
        ext.ffmpeg_bin = self.bin("ffmpeg");
        ext.ffprobe_bin = self.bin("ffprobe");
        ext.mux_dir = self.mux_dir();
    }

    pub fn resolve(&self, id: &str, json: &str) {
        std::fs::write(self.dir.path().join(format!("resolve/{id}.json")), json).unwrap();
    }

    pub fn ytdlp(&self, id: &str, text: &str) {
        std::fs::write(self.dir.path().join(format!("ytdlp/{id}")), text).unwrap();
    }

    pub fn write(&self, name: &str, text: &str) {
        std::fs::write(self.dir.path().join(name), text).unwrap();
    }

    /// The argv lines `stub` logged since the last take.
    pub fn take(&self, stub: &str) -> Vec<String> {
        let p = self.dir.path().join(format!("{stub}.calls"));
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        let _ = std::fs::remove_file(&p);
        text.lines().map(String::from).collect()
    }
}
