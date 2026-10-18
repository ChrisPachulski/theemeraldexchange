//! The per-Claude-call usage log (services/usageLog.ts) and /api/usage
//! (routes/usage.ts): one data/usage.jsonl line per Anthropic call, success
//! or error, with tokens and estimated cost, behind the API-key card's own
//! summary and the admin dashboard.
//!
//! GET /api/usage/me     the caller's last-30-day summary (zeros if none)
//! GET /api/usage/admin  every user's (admin)
//! GET /api/usage/log    the newest raw events, ?limit=1..200 (admin)

use axum::Router;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::AppState;
use crate::app::js_number;
use crate::jsonl::JsonlLog;
use crate::routes::js_str_number;
use crate::stores::Kind;
use crate::suggestions::prompt::Usage;

const THIRTY_DAYS_MS: f64 = 30.0 * 24.0 * 3600.0 * 1000.0;
/// Bounds a summary scan (~30 MB) if a clock jump hides the cutoff.
const SUMMARY_HARD_CAP: usize = 100_000;

/// One line, in the TS key order; absent fields are left out.
#[derive(Debug, Serialize)]
pub struct Event<'a> {
    pub ts: String,
    pub sub: &'a str,
    pub username: &'a str,
    #[serde(rename = "type")]
    pub event: &'static str,
    pub model: &'a str,
    pub kind: Kind,
    #[serde(rename = "callCount", skip_serializing_if = "Option::is_none")]
    pub call_count: Option<u32>,
    #[serde(rename = "inputTokens", skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(rename = "outputTokens", skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(
        rename = "cacheCreationInputTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(
        rename = "cacheReadInputTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(rename = "costCents", skip_serializing_if = "Option::is_none")]
    pub cost_cents: Option<serde_json::Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'a str>,
}

impl<'a> Event<'a> {
    fn new(
        sub: &'a str,
        username: &'a str,
        event: &'static str,
        model: &'a str,
        kind: Kind,
    ) -> Event<'a> {
        Event {
            ts: auth::now_iso(),
            sub,
            username,
            event,
            model,
            kind,
            call_count: None,
            input_tokens: None,
            output_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            cost_cents: None,
            error: None,
        }
    }

    pub fn call(
        sub: &'a str,
        username: &'a str,
        model: &'a str,
        kind: Kind,
        calls: u32,
        u: &Usage,
        cost: f64,
    ) -> Event<'a> {
        Event {
            call_count: Some(calls),
            input_tokens: u.input,
            output_tokens: u.output,
            cache_creation_input_tokens: u.cache_creation,
            cache_read_input_tokens: u.cache_read,
            cost_cents: Some(js_number(cost)),
            ..Event::new(sub, username, "claude_call", model, kind)
        }
    }

    pub fn error(
        sub: &'a str,
        username: &'a str,
        model: &'a str,
        kind: Kind,
        error: &'a str,
    ) -> Event<'a> {
        Event {
            error: Some(error),
            ..Event::new(sub, username, "claude_error", model, kind)
        }
    }
}

pub async fn append(log: &JsonlLog, ev: &Event<'_>) -> std::io::Result<()> {
    log.append(&serde_json::to_string(ev)?).await
}

/// Haiku 4.5 per million tokens: input $1, output $5, cache write $1.25,
/// cache read $0.10. Cents, to 4 decimals.
pub fn compute_cost_cents(u: &Usage) -> f64 {
    let n = |x: Option<u64>| x.unwrap_or(0) as f64;
    let cents = n(u.input) * (100.0 / 1_000_000.0)
        + n(u.output) * (500.0 / 1_000_000.0)
        + n(u.cache_creation) * (125.0 / 1_000_000.0)
        + n(u.cache_read) * (10.0 / 1_000_000.0);
    (cents * 10000.0).round() / 10000.0
}

/// The newest `limit` events (each line that parses, served as written),
/// spilling into the rotated file.
pub async fn recent(log: &JsonlLog, limit: usize) -> Vec<Box<RawValue>> {
    let parse = |lines: Vec<String>| -> Vec<Box<RawValue>> {
        lines
            .into_iter()
            .filter_map(|l| RawValue::from_string(l).ok())
            .collect()
    };
    let mut out = parse(log.tail(log.path().into(), limit).await);
    if out.len() < limit {
        out.extend(parse(log.tail(log.rotated(), limit - out.len()).await));
    }
    out
}

/// `new Date(ts).getTime()`: NaN when unparsable (and NaN is never "older").
fn ts_ms(ev: &Value) -> f64 {
    match &ev["ts"] {
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map_or(f64::NAN, |d| d.timestamp_millis() as f64),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// Newest-first events of `path` until the first one older than the cutoff.
async fn until_cutoff(
    log: &JsonlLog,
    path: std::path::PathBuf,
    cutoff: f64,
    cap: usize,
) -> Vec<Value> {
    log.tail(path, cap)
        .await
        .into_iter()
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
        .take_while(|ev| ts_ms(ev).partial_cmp(&cutoff) != Some(std::cmp::Ordering::Less))
        .take(cap)
        .collect()
}

#[derive(Debug, Default, PartialEq)]
pub struct Summary {
    pub sub: String,
    pub username: Value,
    pub calls: f64,
    pub errors: f64,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_creation_input_tokens: f64,
    pub cache_read_input_tokens: f64,
    pub cost_cents: f64,
}

impl Summary {
    pub fn json(&self) -> Value {
        let n = |f: f64| Value::Number(js_number(f));
        json!({
            "sub": self.sub,
            "username": self.username,
            "calls": n(self.calls),
            "errors": n(self.errors),
            "inputTokens": n(self.input_tokens),
            "outputTokens": n(self.output_tokens),
            "cacheCreationInputTokens": n(self.cache_creation_input_tokens),
            "cacheReadInputTokens": n(self.cache_read_input_tokens),
            "costCents": n(self.cost_cents),
        })
    }
}

/// Per-user totals since `since_ms`, most expensive first; spans the rotated
/// file when the window crosses a rotation.
pub async fn summarize(log: &JsonlLog, since_ms: f64) -> Vec<Summary> {
    let mut events = until_cutoff(log, log.path().into(), since_ms, SUMMARY_HARD_CAP).await;
    let remaining = SUMMARY_HARD_CAP.saturating_sub(events.len());
    if remaining > 0 {
        events.extend(until_cutoff(log, log.rotated(), since_ms, remaining).await);
    }
    let mut by_user: IndexMap<String, Summary> = IndexMap::new();
    let num = |ev: &Value, k: &str| ev[k].as_f64().unwrap_or(0.0);
    for ev in &events {
        let Some(sub) = ev["sub"].as_str() else {
            continue;
        };
        let row = by_user.entry(sub.to_string()).or_insert_with(|| Summary {
            sub: sub.to_string(),
            username: ev.get("username").cloned().unwrap_or(Value::Null),
            ..Summary::default()
        });
        match ev["type"].as_str() {
            Some("claude_call") => row.calls += ev["callCount"].as_f64().unwrap_or(1.0),
            Some("claude_error") => row.errors += 1.0,
            _ => {}
        }
        row.input_tokens += num(ev, "inputTokens");
        row.output_tokens += num(ev, "outputTokens");
        row.cache_creation_input_tokens += num(ev, "cacheCreationInputTokens");
        row.cache_read_input_tokens += num(ev, "cacheReadInputTokens");
        row.cost_cents += num(ev, "costCents");
    }
    let mut rows: Vec<Summary> = by_user.into_values().collect();
    rows.sort_by(|a, b| b.cost_cents.total_cmp(&a.cost_cents));
    rows
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/usage/me", get(me))
        .route("/api/usage/admin", get(admin))
        .route("/api/usage/log", get(log))
}

fn since() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64 - THIRTY_DAYS_MS
}

/// Always a row, so the SPA has no cold path.
async fn me(State(st): State<AppState>, auth::RequireAuth(p): auth::RequireAuth) -> Response {
    let s = &p.session;
    let row = summarize(&st.usage, since())
        .await
        .into_iter()
        .find(|r| r.sub == s.sub)
        .unwrap_or_else(|| Summary {
            sub: s.sub.clone(),
            username: s.username.clone().into(),
            ..Summary::default()
        });
    axum::Json(row.json()).into_response()
}

async fn admin(State(st): State<AppState>, _admin: auth::RequireAdmin) -> Response {
    let rows: Vec<Value> = summarize(&st.usage, since())
        .await
        .iter()
        .map(Summary::json)
        .collect();
    axum::Json(rows).into_response()
}

async fn log(
    State(st): State<AppState>,
    _admin: auth::RequireAdmin,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let n = q
        .iter()
        .find(|(k, _)| k == "limit")
        .map_or(f64::NAN, |(_, v)| js_str_number(v));
    let limit = if n.is_finite() && n > 0.0 {
        (n.floor() as usize).min(200)
    } else {
        50
    };
    axum::Json(recent(&st.usage, limit).await).into_response()
}

#[cfg(test)]
mod tests;
