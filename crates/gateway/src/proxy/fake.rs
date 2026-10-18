//! A fixture-driven stand-in for media-core (/mc), the transcoder (/tc), the
//! iptv service (/iptv), Radarr, Sonarr, the recommender (/rec) and Glitchtip
//! (/api/<project>/...) on 127.0.0.1, the Rust copy of the fake in
//! gen-proxy-goldens.ts. It records every request (the internal principal
//! decrypted to sub/role/auth_mode) and counts its open sockets, so a test
//! can see the upstream connection close when a client hangs up.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug, Deserialize)]
pub struct Route {
    pub method: String,
    pub path: String,
    pub status: u16,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: String,
    pub bytes: Option<usize>,
    pub seed: Option<usize>,
    #[serde(default)]
    pub slow: bool,
}

impl Route {
    pub fn json(method: &str, path: &str, status: u16, body: Value) -> Route {
        Route {
            method: method.into(),
            path: path.into(),
            status,
            headers: [("content-type".to_string(), "application/json".to_string())].into(),
            body: body.to_string(),
            bytes: None,
            seed: None,
            slow: false,
        }
    }

    pub fn header(mut self, k: &str, v: &str) -> Route {
        self.headers.insert(k.into(), v.into());
        self
    }
}

#[derive(Clone, Debug)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub query: String,
    pub principal: Value,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

const RECORDED: &[&str] = &[
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
    "user-agent",
    "accept-encoding",
    "content-type",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-sentry-auth",
    "x-recommender-secret",
];

#[derive(Clone)]
pub struct Fake {
    pub url: String,
    routes: Arc<Mutex<Vec<Route>>>,
    calls: Arc<Mutex<Vec<Call>>>,
    open: Arc<AtomicUsize>,
    keys: Arc<HashMap<String, [u8; 32]>>,
}

impl Fake {
    /// `secret` decrypts the internal principals the gateway sends.
    pub async fn start(secret: &str) -> Fake {
        let key = emerald_contracts::hkdf::derive_key(
            secret.as_bytes(),
            emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL,
        );
        let fake = Fake {
            url: String::new(),
            routes: Arc::default(),
            calls: Arc::default(),
            open: Arc::default(),
            keys: Arc::new(HashMap::from([(
                emerald_contracts::internal_principal::DEFAULT_KID.to_string(),
                key,
            )])),
        };
        let state = fake.clone();
        let app = Router::new().fallback(move |req: Request| {
            let state = state.clone();
            async move { state.handle(req).await }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let counting = Counting {
            inner: listener,
            open: fake.open.clone(),
        };
        tokio::spawn(async move { axum::serve(counting, app).await.unwrap() });
        Fake { url, ..fake }
    }

    pub fn set_routes(&self, routes: Vec<Route>) {
        *self.routes.lock().unwrap() = routes;
    }

    pub fn open(&self) -> usize {
        self.open.load(Ordering::SeqCst)
    }

    /// Wait out requests still in flight (no new call for 75 ms), then take
    /// what arrived.
    pub async fn settle(&self) -> Vec<Call> {
        let mut seen = usize::MAX;
        loop {
            let n = self.calls.lock().unwrap().len();
            if n == seen {
                break;
            }
            seen = n;
            tokio::time::sleep(Duration::from_millis(75)).await;
        }
        std::mem::take(&mut *self.calls.lock().unwrap())
    }

    fn principal(&self, auth: Option<&str>) -> Value {
        let Some(auth) = auth else { return Value::Null };
        let Some(token) = auth
            .strip_prefix("Bearer ")
            .filter(|t| t.split('.').count() == 5)
        else {
            return Value::String(auth.into());
        };
        match emerald_contracts::internal_principal::decrypt(&self.keys, token) {
            Ok(c) => json!({ "sub": c.sub, "role": c.role, "auth_mode": c.auth_mode }),
            Err(_) => Value::String("undecryptable".into()),
        }
    }

    async fn handle(&self, req: Request) -> Response {
        let method = req.method().to_string();
        let path = req.uri().path().to_string();
        let query = req.uri().query().unwrap_or_default().to_string();
        let mut headers = BTreeMap::new();
        for k in RECORDED {
            if let Some(v) = req.headers().get(*k).and_then(|v| v.to_str().ok()) {
                headers.insert(k.to_string(), v.to_string());
            }
        }
        let principal = self.principal(
            req.headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok()),
        );
        let body = axum::body::to_bytes(req.into_body(), usize::MAX)
            .await
            .unwrap_or_default()
            .to_vec();
        self.calls.lock().unwrap().push(Call {
            method: method.clone(),
            path: path.clone(),
            query,
            principal,
            headers,
            body,
        });
        let hit = self
            .routes
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.method == method && r.path == path)
            .cloned();
        let Some(hit) = hit else {
            if path.starts_with("/rec/") {
                return ([("content-type", "application/json")], "{}").into_response();
            }
            return (
                StatusCode::NOT_FOUND,
                [("content-type", "application/json")],
                r#"{"error":"no fixture"}"#,
            )
                .into_response();
        };
        let body = if hit.slow {
            Body::from_stream(futures_util::stream::unfold((), |()| async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Some((Ok::<_, io::Error>(Bytes::from(vec![0x47u8; 1024])), ()))
            }))
        } else if let Some(total) = hit.bytes {
            let seed = hit.seed.unwrap_or(0);
            let chunks = (0..total).step_by(65536).map(move |at| {
                let n = 65536.min(total - at);
                Ok::<_, io::Error>(Bytes::from(
                    (0..n)
                        .map(|i| ((at + i + seed) & 0xff) as u8)
                        .collect::<Vec<u8>>(),
                ))
            });
            Body::from_stream(futures_util::stream::iter(chunks))
        } else {
            Body::from(hit.body.clone())
        };
        let mut res = Response::new(body);
        *res.status_mut() = StatusCode::from_u16(hit.status).unwrap();
        for (k, v) in &hit.headers {
            res.headers_mut().insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        res
    }
}

/// A listener whose sockets decrement `open` when they close.
struct Counting {
    inner: TcpListener,
    open: Arc<AtomicUsize>,
}

impl axum::serve::Listener for Counting {
    type Io = Counted;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Counted, std::net::SocketAddr) {
        loop {
            if let Ok((stream, addr)) = self.inner.accept().await {
                self.open.fetch_add(1, Ordering::SeqCst);
                let open = self.open.clone();
                return (Counted { stream, open }, addr);
            }
        }
    }

    fn local_addr(&self) -> io::Result<std::net::SocketAddr> {
        self.inner.local_addr()
    }
}

pub struct Counted {
    stream: TcpStream,
    open: Arc<AtomicUsize>,
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.open.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AsyncRead for Counted {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Counted {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
