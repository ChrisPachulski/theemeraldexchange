//! A local fake TMDB for the ingest goldens and the client tests. It serves a
//! scenario's canned responses and logs every request: the path, the decoded
//! query (api_key shown as `<redacted>` when it is the fixture credential,
//! `<wrong>` otherwise) and whether an Authorization header came. Fixtures
//! only: nothing here talks to TMDB.
//!
//! A scenario is `{"routes": [{"path", "query": {k: v}, "responses":
//! [{"status", "body"}]}]}`. The first route whose path matches and whose
//! query pairs are all present answers; its responses are served in order and
//! the last one repeats. Anything else is TMDB's 404.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

/// The api_key / bearer token every fixture uses.
pub const FIXTURE_CREDENTIAL: &str = "fixture-credential-0001";

struct Shared {
    routes: Vec<Value>,
    served: Vec<usize>,
    log: Vec<Value>,
}

pub struct Fake {
    /// `http://127.0.0.1:<port>`; TMDB's `/3` prefix is the caller's.
    pub base: String,
    shared: Arc<Mutex<Shared>>,
}

impl Fake {
    pub fn log(&self) -> Vec<Value> {
        self.shared.lock().unwrap().log.clone()
    }
}

pub async fn start(scenario: &Value) -> Fake {
    let routes = scenario["routes"].as_array().cloned().unwrap_or_default();
    let shared = Arc::new(Mutex::new(Shared {
        served: vec![0; routes.len()],
        routes,
        log: Vec::new(),
    }));
    let app = Router::new().fallback(serve).with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fake { base, shared }
}

async fn serve(State(s): State<Arc<Mutex<Shared>>>, uri: Uri, headers: HeaderMap) -> Response {
    let query: Vec<(String, String)> = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .collect();
    let logged: Vec<Value> = query
        .iter()
        .map(|(k, v)| {
            let v = match (k.as_str(), v.as_str()) {
                ("api_key", FIXTURE_CREDENTIAL) => "<redacted>",
                ("api_key", _) => "<wrong>",
                (_, v) => v,
            };
            json!([k, v])
        })
        .collect();
    let auth = headers.get("authorization").map(|h| h.as_bytes());
    let bearer = format!("Bearer {FIXTURE_CREDENTIAL}");
    let mut s = s.lock().unwrap();
    s.log.push(json!({
        "path": uri.path(),
        "query": logged,
        "auth": auth.map(|a| if a == bearer.as_bytes() { "bearer" } else { "<wrong>" }),
    }));
    let hit = s.routes.iter().position(|r| {
        r["path"] == uri.path()
            && r["query"].as_object().is_none_or(|want| {
                want.iter()
                    .all(|(k, v)| query.iter().any(|(qk, qv)| qk == k && v == qv.as_str()))
            })
    });
    let Some(i) = hit else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"success": false, "status_code": 34,
                "status_message": "The resource you requested could not be found."})),
        )
            .into_response();
    };
    let responses = s.routes[i]["responses"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let n = s.served[i];
    s.served[i] += 1;
    let r = &responses[n.min(responses.len() - 1)];
    let status = StatusCode::from_u16(r["status"].as_u64().unwrap_or(200) as u16).unwrap();
    (status, axum::Json(r["body"].clone())).into_response()
}
