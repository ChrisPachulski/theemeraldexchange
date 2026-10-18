//! The Sonarr/Radarr add pipeline pieces both apps share (services/arrGrab.ts,
//! arrAdd.ts, arrAdvanced.ts): the in-flight disk reservation ledger, the
//! grab-event log, profile picking, the non-admin body materialization and
//! honoured-body validation, the root-folder free-space gate, and the
//! admin "Advanced options" helpers (release projection, the command
//! allowlist, the edit allowlist, history mapping, the interactive grab).
//!
//! Upstream records are handled as `serde_json::Value` with JS semantics
//! where the TS read them loosely: a missing field is skipped, a value
//! copied through keeps its JSON form.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use axum::Json;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tokio::time::Instant;

use crate::AppState;
use crate::jsonl::JsonlLog;
use crate::routes::truthy;
use crate::upstream::{self, Arr, LAN_TIMEOUT, Reply};

pub const GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Waits the add pipeline makes, so tests run them in milliseconds.
#[derive(Clone, Copy, Debug)]
pub struct Timings {
    /// After the add, before the release search: lets the *arr finish
    /// wiring the new record.
    pub settle: Duration,
    /// Interactive search and grab POSTs (live indexer queries).
    pub search: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            settle: Duration::from_millis(1500),
            search: upstream::SEARCH_TIMEOUT,
        }
    }
}

// --- JS value helpers ------------------------------------------------------------

/// A JSON number for an f64 the way JSON.stringify writes it (10, not 10.0;
/// null for NaN/Infinity).
pub fn num(n: f64) -> Value {
    if n.is_finite() {
        Value::Number(crate::app::js_number(n))
    } else {
        Value::Null
    }
}

/// `typeof v === 'number'` (JSON numbers are always finite).
pub fn as_num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// A numeric field, NaN when absent or not a number.
pub fn field_f64(v: &Value, k: &str) -> f64 {
    as_num(v.get(k)).unwrap_or(f64::NAN)
}

/// `${v}` for the ids the TS interpolated into upstream paths.
pub fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => {
                (f as i64).to_string()
            }
            _ => n.to_string(),
        },
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// `Math.round(n * 100) / 100`.
pub fn round2(n: f64) -> f64 {
    let v = n * 100.0;
    let f = v.floor();
    (if v - f >= 0.5 { f + 1.0 } else { f }) / 100.0
}

/// `Number(x.toFixed(2))` for a byte count over GB: the nearest hundredth,
/// a tie going up (toFixed picks the larger n), computed exactly for whole
/// byte counts.
pub fn gb_2dp(bytes: f64) -> f64 {
    if bytes >= 0.0 && bytes.fract() == 0.0 && bytes < 9_007_199_254_740_992.0 {
        let n = (bytes as u128 * 200 + (1 << 30)) >> 31;
        return n as f64 / 100.0;
    }
    format!("{:.2}", bytes / GB).parse().unwrap_or(f64::NAN)
}

/// An object whose keys serialize in insertion order (the grab log is
/// compared byte for byte with the TS JSON.stringify output). Values are
/// stored already serialized.
#[derive(Clone, Debug, Default)]
pub struct Obj(Vec<(&'static str, String)>);

impl Obj {
    pub fn new() -> Obj {
        Obj::default()
    }

    /// Set `k` (in place when already present, as an object spread does).
    pub fn put(mut self, k: &'static str, v: impl Serialize) -> Obj {
        let text = serde_json::to_string(&v).expect("serializable");
        match self.0.iter_mut().find(|(key, _)| *key == k) {
            Some(slot) => slot.1 = text,
            None => self.0.push((k, text)),
        }
        self
    }

    /// Set `k` only when present (JSON.stringify drops undefined).
    pub fn opt(self, k: &'static str, v: Option<impl Serialize>) -> Obj {
        match v {
            Some(v) => self.put(k, v),
            None => self,
        }
    }

    pub fn json(&self) -> String {
        let fields: Vec<String> = self
            .0
            .iter()
            .map(|(k, v)| format!("{}:{v}", serde_json::to_string(k).expect("str")))
            .collect();
        format!("{{{}}}", fields.join(","))
    }
}

impl Serialize for Obj {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        RawValue::from_string(self.json())
            .map_err(serde::ser::Error::custom)?
            .serialize(s)
    }
}

/// The query's pairs, decoded the way URLSearchParams reads them.
pub fn query_pairs(uri: &axum::http::Uri) -> Vec<(String, String)> {
    let Some(q) = uri.query() else {
        return vec![];
    };
    reqwest::Url::parse(&format!("http://q/?{q}"))
        .map(|u| {
            u.query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

/// The first value for `key` (Hono's `c.req.query(key)`).
pub fn query_first<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

// --- reservation ledger ------------------------------------------------------------

/// A root folder's free space as the *arr reported it.
#[derive(Clone, Debug, PartialEq)]
pub struct Folder {
    pub path: String,
    pub free_space: f64,
}

/// A reservation only spans one grab's planning + POST (seconds); anything
/// older is a release that never fired, so it expires instead of wedging the
/// free-space gate until a restart.
pub const RESERVATION_TTL: Duration = Duration::from_secs(15 * 60);

struct Entry {
    bytes: f64,
    expires: Instant,
}

/// In-flight disk reservations per root-folder path, one ledger per app.
/// Two near-simultaneous adds would otherwise both pass the free-space floor
/// against the same stale snapshot. In-process and dropped on restart.
pub struct Ledger {
    app: &'static str,
    min_free: f64,
    ttl: Duration,
    pending: Mutex<HashMap<String, Vec<Entry>>>,
}

impl Ledger {
    pub fn new(app: &'static str, min_free_bytes: f64) -> Ledger {
        Ledger::with_ttl(app, min_free_bytes, RESERVATION_TTL)
    }

    pub fn with_ttl(app: &'static str, min_free_bytes: f64, ttl: Duration) -> Ledger {
        Ledger {
            app,
            min_free: min_free_bytes,
            ttl,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// The live entries for `path`, expired ones dropped (loudly: an expiry
    /// means a grab skipped its release).
    fn live(&self, map: &mut HashMap<String, Vec<Entry>>, path: &str) -> f64 {
        let Some(entries) = map.get_mut(path) else {
            return 0.0;
        };
        let now = Instant::now();
        let before: f64 = entries.iter().map(|e| e.bytes).sum();
        entries.retain(|e| e.expires > now);
        let kept: f64 = entries.iter().map(|e| e.bytes).sum();
        if before - kept > 0.0 {
            tracing::warn!(
                event = self.app,
                pruned_gb = gb_2dp(before - kept),
                path,
                held_over_minutes = self.ttl.as_secs() / 60,
                "pruned stale disk reservation; a cap grab likely missed its release; self-healing the free-space gate"
            );
        }
        if entries.is_empty() {
            map.remove(path);
        }
        kept
    }

    pub fn pending_bytes(&self, f: &Folder) -> f64 {
        let mut map = self.pending.lock().unwrap();
        self.live(&mut map, &f.path)
    }

    /// Free space minus in-flight reservations.
    pub fn available_bytes(&self, f: &Folder) -> f64 {
        f.free_space - self.pending_bytes(f)
    }

    /// Reserve `bytes` when that keeps the folder above the floor; the check
    /// and the reservation happen under one lock. Refuses non-finite and
    /// non-positive amounts.
    pub fn reserve(&self, f: &Folder, bytes: f64) -> bool {
        if !bytes.is_finite() || bytes <= 0.0 {
            return false;
        }
        let mut map = self.pending.lock().unwrap();
        let reserved = self.live(&mut map, &f.path);
        if f.free_space - reserved - bytes < self.min_free {
            return false;
        }
        map.entry(f.path.clone()).or_default().push(Entry {
            bytes,
            expires: Instant::now() + self.ttl,
        });
        true
    }

    /// Release up to `bytes`: the entry of exactly that size, else the oldest
    /// entries until `bytes` is used up (floored at zero). Non-finite and
    /// non-positive amounts are ignored.
    pub fn release(&self, f: &Folder, bytes: f64) {
        if !bytes.is_finite() || bytes <= 0.0 {
            return;
        }
        let mut map = self.pending.lock().unwrap();
        self.live(&mut map, &f.path);
        let Some(entries) = map.get_mut(&f.path) else {
            return;
        };
        if let Some(i) = entries.iter().position(|e| e.bytes == bytes) {
            entries.remove(i);
        } else {
            let mut remaining = bytes;
            while remaining > 0.0 && !entries.is_empty() {
                if entries[0].bytes <= remaining {
                    remaining -= entries.remove(0).bytes;
                } else {
                    entries[0].bytes -= remaining;
                    remaining = 0.0;
                }
            }
        }
        if entries.is_empty() {
            map.remove(&f.path);
        }
    }
}

// --- grab log ------------------------------------------------------------------------

/// Every grab-event type the pipelines write (src/lib/api/grabs.ts mirrors
/// this list; a test keeps the two in step).
pub const GRAB_EVENT_TYPES: &[&str] = &[
    "grab_started",
    "search_failed",
    "no_releases",
    "no_matching_releases",
    "all_rejected_by_cap",
    "all_rejected_by_profile",
    "planned_size_exceeds_free_space",
    "grab_succeeded",
    "grab_failed",
    "grab_unconfirmed",
];

/// The grab-log type for a grab POST: a 504 is the synthesized timeout (or an
/// unreachable *arr), so the release may still have been queued.
pub fn grab_event_type(reply: &Reply) -> &'static str {
    if reply.is_success() {
        "grab_succeeded"
    } else if reply.status == StatusCode::GATEWAY_TIMEOUT {
        "grab_unconfirmed"
    } else {
        "grab_failed"
    }
}

/// The persistent grab-event log (grabs.jsonl), read by the admin panel.
pub struct GrabLog(pub JsonlLog);

impl GrabLog {
    /// Append `{ts, app, ...event}`. Best effort: an audit write never fails
    /// a user-facing add.
    pub async fn record(&self, app: Arr, event: Obj) {
        let mut line = Obj::new()
            .put("ts", auth::now_iso())
            .put("app", app.as_str());
        line.0.extend(event.0);
        if let Err(e) = self.0.append(&line.json()).await {
            tracing::error!(event = app.as_str(), error = %e, "grab log write failed");
        }
    }

    /// The newest `limit` parseable events, topped up from the rotated file.
    pub async fn recent(&self, limit: usize) -> Vec<Box<RawValue>> {
        let mut out = parse(self.0.tail(self.0.path().into(), limit).await);
        if out.len() < limit {
            out.extend(parse(
                self.0.tail(self.0.rotated(), limit - out.len()).await,
            ));
        }
        out
    }

    /// Events for one item, scoped to `sub` (legacy rows without a sub stay
    /// visible to everyone), newest first.
    pub async fn for_item(
        &self,
        app: Arr,
        item_id: u64,
        limit: usize,
        sub: &str,
    ) -> Vec<Box<RawValue>> {
        // Events for one item are a small slice of the stream.
        let window = 500.max(limit * 50);
        let mut all = parse(self.0.tail(self.0.path().into(), window).await);
        if all.len() < window {
            let rest = window - all.len();
            all.extend(parse(self.0.tail(self.0.rotated(), rest).await));
        }
        all.into_iter()
            .filter(|raw| {
                let Ok(Value::Object(e)) = serde_json::from_str::<Value>(raw.get()) else {
                    return false;
                };
                e.get("app").and_then(Value::as_str) == Some(app.as_str())
                    && as_num(e.get("itemId")) == Some(item_id as f64)
                    && e.get("sub").is_none_or(|s| s.as_str() == Some(sub))
            })
            .take(limit)
            .collect()
    }
}

/// Malformed lines (a partial write, a manual edit) are dropped.
fn parse(lines: Vec<String>) -> Vec<Box<RawValue>> {
    lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Box<RawValue>>(l).ok())
        .collect()
}

/// A JSON array of raw events.
pub fn events_response(events: &[Box<RawValue>]) -> Response {
    Json(events).into_response()
}

// --- add pipeline ----------------------------------------------------------------

/// Trailing separators dropped, lowercased: how folder paths are compared.
pub fn normalize_path(p: &str) -> String {
    p.trim_end_matches(['/', '\\']).to_lowercase()
}

fn name_of(p: &Value) -> String {
    p.get("name")
        .and_then(Value::as_str)
        .map(|n| auth::js_trim(n).to_lowercase())
        .unwrap_or_default()
}

/// The quality profile for a policy-free add: the configured name, else a
/// "1080p" profile, else an "HD..." one, else anything but the uncapped
/// "Any", else the first.
pub fn pick_profile<'a>(profiles: &'a [Value], default_name: &str) -> Option<&'a Value> {
    profiles
        .iter()
        .find(|p| name_of(p) == default_name)
        .or_else(|| profiles.iter().find(|p| name_of(p).contains("1080p")))
        .or_else(|| profiles.iter().find(|p| name_of(p).starts_with("hd")))
        .or_else(|| profiles.iter().find(|p| name_of(p) != "any"))
        .or_else(|| profiles.first())
}

fn path_str(f: &Value) -> &str {
    f.get("path").and_then(Value::as_str).unwrap_or_default()
}

fn profile_names(profiles: &[Value]) -> Vec<Value> {
    profiles
        .iter()
        .filter_map(|p| p.get("name").filter(|n| n.is_string()).cloned())
        .collect()
}

fn folder_paths(folders: &[Value]) -> Vec<Value> {
    folders
        .iter()
        .map(|f| f.get("path").cloned().unwrap_or(Value::Null))
        .collect()
}

/// Why an add body could not be resolved; `payload()` is the response body.
#[derive(Debug, Default, PartialEq)]
pub struct Unresolved {
    pub reason: &'static str,
    pub expected_name: Option<String>,
    pub available_names: Option<Vec<Value>>,
    pub expected_path: Option<String>,
    pub available_paths: Option<Vec<Value>>,
}

impl Unresolved {
    fn new(reason: &'static str) -> Unresolved {
        Unresolved {
            reason,
            ..Default::default()
        }
    }

    /// materializeFailurePayload: empty strings are left out.
    pub fn payload(&self) -> Value {
        let mut p = json!({ "error": self.reason });
        if let Some(n) = self.expected_name.as_ref().filter(|s| !s.is_empty()) {
            p["expected_name"] = n.clone().into();
        }
        if let Some(n) = &self.available_names {
            p["available_names"] = n.clone().into();
        }
        if let Some(n) = self.expected_path.as_ref().filter(|s| !s.is_empty()) {
            p["expected_path"] = n.clone().into();
        }
        if let Some(n) = &self.available_paths {
            p["available_paths"] = n.clone().into();
        }
        p
    }

    /// An unknown caller-supplied folder/profile is the client's error; an
    /// unreachable upstream or a missing server default is a 503.
    pub fn status(&self) -> StatusCode {
        if self.reason.starts_with("unknown_") {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

pub fn internal(what: &str) -> Response {
    tracing::error!(event = "unhandled", detail = what, "unhandled error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal" })),
    )
        .into_response()
}

impl From<upstream::Error> for Response {
    fn from(e: upstream::Error) -> Response {
        e.into_response()
    }
}

/// GET `path` on the *arr with the LAN timeout.
pub async fn arr_get(
    st: &AppState,
    svc: Arr,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Reply, upstream::Error> {
    st.upstream
        .arr_fetch(&st.config, svc, Method::GET, path, query, None, LAN_TIMEOUT)
        .await
}

/// The root folders, or None when the lookup failed in any way (unset key,
/// non-2xx, unparseable body).
pub async fn root_folders(st: &AppState, svc: Arr) -> Option<Vec<Value>> {
    match arr_get(st, svc, "/api/v3/rootfolder", &[]).await {
        Ok(r) if r.is_success() => serde_json::from_slice::<Vec<Value>>(&r.body).ok(),
        Ok(r) => {
            tracing::error!(
                event = "arr-add",
                svc = svc.as_str(),
                status = r.status.as_u16(),
                "rootfolder lookup failed"
            );
            None
        }
        Err(e) => {
            tracing::error!(event = "arr-add", svc = svc.as_str(), error = %e, "rootfolder lookup failed");
            None
        }
    }
}

/// The folder and profile lists, fetched together. Err is the response to
/// send as is (an unconfigured *arr, an unparseable profile list).
async fn lists(
    st: &AppState,
    svc: Arr,
) -> Result<Result<(Vec<Value>, Vec<Value>), Unresolved>, Response> {
    let (folders, profiles) = tokio::join!(
        root_folders(st, svc),
        arr_get(st, svc, "/api/v3/qualityprofile", &[])
    );
    let profiles = profiles?;
    let Some(folders) = folders else {
        return Ok(Err(Unresolved::new("rootfolder_unreachable")));
    };
    if !profiles.is_success() {
        return Ok(Err(Unresolved::new("qualityprofile_unreachable")));
    }
    let profiles = serde_json::from_slice::<Vec<Value>>(&profiles.body)
        .map_err(|_| internal("qualityprofile body is not a JSON array"))?;
    Ok(Ok((folders, profiles)))
}

fn allowlisted(raw: &Map<String, Value>, allow: &[&str]) -> Map<String, Value> {
    allow
        .iter()
        .filter_map(|k| raw.get(*k).map(|v| (k.to_string(), v.clone())))
        .collect()
}

/// The folder a policy-free add lands in: the configured default (compared
/// normalized), else the first.
fn default_folder<'a>(
    folders: &'a [Value],
    configured: Option<&str>,
) -> Result<&'a Value, Unresolved> {
    let found = match configured {
        Some(c) => folders
            .iter()
            .find(|f| normalize_path(path_str(f)) == normalize_path(c)),
        None => folders.first(),
    };
    found.ok_or_else(|| Unresolved {
        expected_path: configured.map(String::from),
        available_paths: Some(folder_paths(folders)),
        ..Unresolved::new(if configured.is_some() {
            "default_root_folder_missing"
        } else {
            "admin_must_configure_upstream"
        })
    })
}

fn default_profile<'a>(profiles: &'a [Value], name: &str) -> Result<&'a Value, Unresolved> {
    pick_profile(profiles, name).ok_or_else(|| Unresolved {
        expected_name: Some(name.to_string()),
        available_names: Some(profile_names(profiles)),
        ..Unresolved::new("default_quality_profile_missing")
    })
}

/// What the caller's add resolves to: the body to forward, or why not.
pub type Resolved = Result<Result<Map<String, Value>, Unresolved>, Response>;

/// A policy-free (non-admin or slim) add: only the identifying allowlist
/// survives, and `apply` stamps the server-chosen folder path and profile id.
pub async fn materialize(
    st: &AppState,
    svc: Arr,
    raw: &Map<String, Value>,
    allow: &[&str],
    configured: Option<&str>,
    apply: impl FnOnce(&mut Map<String, Value>, Value, Value),
) -> Resolved {
    let (folders, profiles) = match lists(st, svc).await? {
        Ok(l) => l,
        Err(u) => return Ok(Err(u)),
    };
    let picked = default_folder(&folders, configured).and_then(|f| {
        Ok((
            f,
            default_profile(&profiles, &st.config.default_profile_name)?,
        ))
    });
    let (folder, profile) = match picked {
        Ok(p) => p,
        Err(u) => return Ok(Err(u)),
    };
    let mut safe = allowlisted(raw, allow);
    apply(
        &mut safe,
        folder.get("path").cloned().unwrap_or(Value::Null),
        profile.get("id").cloned().unwrap_or(Value::Null),
    );
    Ok(Ok(safe))
}

/// A non-admin's own folder/profile picks, honoured once each matches the
/// live upstream lists (an omitted one falls back to the curated default).
/// Only `allow` survives besides them; tags are forced empty.
pub async fn validate_honored(
    st: &AppState,
    svc: Arr,
    raw: &Map<String, Value>,
    allow: &[&str],
    configured: Option<&str>,
) -> Resolved {
    let (folders, profiles) = match lists(st, svc).await? {
        Ok(l) => l,
        Err(u) => return Ok(Err(u)),
    };
    let folder = match raw.get("rootFolderPath").and_then(Value::as_str) {
        Some(want) if !want.is_empty() => folders
            .iter()
            .find(|f| normalize_path(path_str(f)) == normalize_path(want))
            .ok_or_else(|| Unresolved {
                expected_path: Some(want.to_string()),
                available_paths: Some(folder_paths(&folders)),
                ..Unresolved::new("unknown_root_folder")
            }),
        _ => default_folder(&folders, configured),
    };
    let folder = match folder {
        Ok(f) => f,
        Err(u) => return Ok(Err(u)),
    };
    let profile = match as_num(raw.get("qualityProfileId")) {
        Some(want) => profiles
            .iter()
            .find(|p| as_num(p.get("id")) == Some(want))
            .ok_or_else(|| Unresolved {
                available_names: Some(profile_names(&profiles)),
                ..Unresolved::new("unknown_quality_profile")
            }),
        None => default_profile(&profiles, &st.config.default_profile_name),
    };
    let profile = match profile {
        Ok(p) => p,
        Err(u) => return Ok(Err(u)),
    };
    let mut safe = allowlisted(raw, allow);
    safe.insert(
        "rootFolderPath".into(),
        folder.get("path").cloned().unwrap_or(Value::Null),
    );
    safe.insert(
        "qualityProfileId".into(),
        profile.get("id").cloned().unwrap_or(Value::Null),
    );
    safe.insert("tags".into(), json!([]));
    Ok(Ok(safe))
}

/// The hard free-space gate over a loaded folder list. Fails closed when the
/// space cannot be measured (no path, unknown path, no numeric freeSpace).
/// The match is exact first, then normalized (slash/case); the snapshot
/// carries the upstream's own spelling of the path.
pub fn gate_root_folder_space(
    root_folder_path: Option<&Value>,
    folders: &[Value],
    ledger: &Ledger,
    min_free: f64,
) -> Result<(Folder, f64), (StatusCode, Value)> {
    let want = match root_folder_path {
        Some(v) if truthy(v) => v,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                json!({ "error": "rootFolderPath_required" }),
            ));
        }
    };
    let found = want.as_str().and_then(|w| {
        folders.iter().find(|f| path_str(f) == w).or_else(|| {
            folders
                .iter()
                .find(|f| normalize_path(path_str(f)) == normalize_path(w))
        })
    });
    let Some(folder) = found else {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({ "error": "unknown_root_folder", "path": want }),
        ));
    };
    let path = folder.get("path").cloned().unwrap_or(Value::Null);
    let Some(free) = as_num(folder.get("freeSpace")) else {
        return Err((
            StatusCode::INSUFFICIENT_STORAGE,
            json!({ "error": "free_space_unknown", "path": path }),
        ));
    };
    let snapshot = Folder {
        path: path_str(folder).to_string(),
        free_space: free,
    };
    let available = ledger.available_bytes(&snapshot);
    if available < min_free {
        return Err((
            StatusCode::INSUFFICIENT_STORAGE,
            json!({
                "error": "insufficient_disk_space",
                "free_bytes": num(available),
                "threshold_bytes": num(min_free),
                "path": snapshot.path,
            }),
        ));
    }
    Ok((snapshot, available))
}

/// Releases the *arr itself accepts (parsed, matched, wanted quality).
pub fn arr_accepted(r: &Value) -> bool {
    !r.get("rejected").is_some_and(truthy)
        && !r.get("temporarilyRejected").is_some_and(truthy)
        && field_f64(r, "size") > 0.0
}

/// Highest qualityWeight first; a stable sort, ties (and missing weights)
/// keep their order.
pub fn by_quality(mut v: Vec<&Value>) -> Vec<&Value> {
    v.sort_by(|a, b| {
        field_f64(b, "qualityWeight")
            .partial_cmp(&field_f64(a, "qualityWeight"))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    v
}

/// `{guid, indexerId}` from a release, for the grab POST.
pub fn grab_body(r: &Value) -> Value {
    let mut m = Map::new();
    for k in ["guid", "indexerId"] {
        if let Some(v) = r.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    Value::Object(m)
}

// --- advanced options ------------------------------------------------------------

/// One release row for the interactive browser: the fields it shows plus
/// `sizeGb` (size/1e9, 2dp) and `overCap` against `cap` (None: not over).
pub fn project_release(r: &Value, cap: Option<f64>) -> Value {
    let size = as_num(r.get("size")).unwrap_or(0.0);
    let mut m = Map::new();
    let copy = |k: &str, m: &mut Map<String, Value>| {
        if let Some(v) = r.get(k) {
            m.insert(k.into(), v.clone());
        }
    };
    copy("guid", &mut m);
    copy("indexerId", &mut m);
    copy("title", &mut m);
    m.insert("size".into(), num(size));
    m.insert("sizeGb".into(), num(round2(size / 1e9)));
    if let Some(s) = r.get("seeders").filter(|v| v.is_number()) {
        m.insert("seeders".into(), s.clone());
    }
    m.insert(
        "protocol".into(),
        r.get("protocol")
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
    );
    if let Some(s) = r.get("indexer").filter(|v| v.is_string()) {
        m.insert("indexer".into(), s.clone());
    }
    let age = match (
        r.get("ageHours").filter(|v| v.is_number()),
        as_num(r.get("age")),
    ) {
        (Some(h), _) => Some(h.clone()),
        (None, Some(d)) => Some(num(d * 24.0)),
        _ => None,
    };
    if let Some(a) = age {
        m.insert("ageHours".into(), a);
    }
    m.insert("quality".into(), quality_name(r));
    m.insert(
        "qualityWeight".into(),
        r.get("qualityWeight")
            .filter(|v| v.is_number())
            .cloned()
            .unwrap_or_else(|| 0.into()),
    );
    m.insert(
        "languages".into(),
        strings(r.get("languages"), |l| l.get("name")),
    );
    copy("fullSeason", &mut m);
    copy("seasonNumber", &mut m);
    let strict = |k: &str| r.get(k) == Some(&Value::Bool(true));
    m.insert(
        "rejected".into(),
        (strict("rejected") || strict("temporarilyRejected")).into(),
    );
    m.insert(
        "rejections".into(),
        strings(r.get("rejections"), |v| Some(v)),
    );
    m.insert("overCap".into(), cap.is_some_and(|c| size > c).into());
    Value::Object(m)
}

/// The string values `pick` finds in an array field ([] when not an array).
fn strings(arr: Option<&Value>, pick: impl Fn(&Value) -> Option<&Value>) -> Value {
    arr.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(&pick)
                .filter(|v| v.is_string())
                .cloned()
                .collect()
        })
        .unwrap_or_else(|| Value::Array(vec![]))
}

/// `r.quality?.quality?.name ?? 'Unknown'`.
fn quality_name(r: &Value) -> Value {
    r.get("quality")
        .and_then(|q| q.get("quality"))
        .and_then(|q| q.get("name"))
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| "Unknown".into())
}

/// An allowlisted command: its required companion fields and the fields
/// that may be forwarded.
pub struct CommandSpec {
    pub name: &'static str,
    pub requires: &'static [&'static str],
    pub passthrough: &'static [&'static str],
}

/// The upstream /command body: only allowlisted names, with their required
/// fields present (a required array must be non-empty), carrying only the
/// passthrough fields.
pub fn build_command_body(raw: &Value, allow: &[CommandSpec]) -> Result<Value, &'static str> {
    let Value::Object(body) = raw else {
        return Err("invalid_body");
    };
    let Some(spec) = body
        .get("name")
        .and_then(Value::as_str)
        .and_then(|n| allow.iter().find(|s| s.name == n))
    else {
        return Err("command_not_allowed");
    };
    for field in spec.requires {
        match body.get(*field) {
            None | Some(Value::Null) => return Err("missing_required_field"),
            Some(Value::Array(a)) if a.is_empty() => return Err("missing_required_field"),
            _ => {}
        }
    }
    let mut out = Map::new();
    out.insert("name".into(), spec.name.into());
    for field in spec.passthrough {
        if let Some(v) = body.get(*field) {
            out.insert(field.to_string(), v.clone());
        }
    }
    Ok(Value::Object(out))
}

/// The edit allowlist, well-typed values only (never coerced).
pub fn extract_edit_patch(raw: &Value) -> Map<String, Value> {
    let mut patch = Map::new();
    let Value::Object(body) = raw else {
        return patch;
    };
    if let Some(v) = body.get("monitored").filter(|v| v.is_boolean()) {
        patch.insert("monitored".into(), v.clone());
    }
    if let Some(v) = body.get("qualityProfileId").filter(|v| v.is_number()) {
        patch.insert("qualityProfileId".into(), v.clone());
    }
    if let Some(v) = body
        .get("rootFolderPath")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    {
        patch.insert("rootFolderPath".into(), v.clone());
    }
    patch
}

/// The full upstream object with only the patch keys replaced.
pub fn merge_edit(full: Value, patch: Map<String, Value>) -> Value {
    let mut out = match full {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    out.extend(patch);
    Value::Object(out)
}

/// `Date.parse` for the forms the *arr history carries (RFC 3339, a bare
/// date as UTC midnight, a zoneless timestamp as UTC).
fn date_ms(s: &str) -> Option<i64> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(t.timestamp_millis());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(s, f) {
            return Some(t.and_utc().timestamp_millis());
        }
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
}

/// History as a bare array or a paged `{records}`, slimmed and sorted newest
/// first; unparseable dates sink to the bottom.
pub fn map_history(raw: &Value) -> Vec<Value> {
    let records = match raw {
        Value::Array(a) => a.as_slice(),
        Value::Object(m) => m
            .get("records")
            .and_then(Value::as_array)
            .map_or(&[][..], |a| a),
        _ => &[],
    };
    let str_or = |r: &Value, k: &str, d: &str| -> Value {
        r.get(k)
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or_else(|| d.into())
    };
    let mut rows: Vec<(Option<i64>, Value)> = records
        .iter()
        .map(|r| {
            let mut m = Map::new();
            let date = str_or(r, "date", "");
            let when = date.as_str().and_then(date_ms);
            m.insert("date".into(), date);
            m.insert("eventType".into(), str_or(r, "eventType", "unknown"));
            m.insert("sourceTitle".into(), str_or(r, "sourceTitle", ""));
            m.insert("quality".into(), quality_name(r));
            for k in ["seasonNumber", "episodeId"] {
                if let Some(v) = r.get(k).filter(|v| v.is_number()) {
                    m.insert(k.into(), v.clone());
                }
            }
            (when, Value::Object(m))
        })
        .collect();
    rows.sort_by(|(a, _), (b, _)| match (a, b) {
        (Some(a), Some(b)) => b.cmp(a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    rows.into_iter().map(|(_, v)| v).collect()
}

/// A hand-picked release to grab.
#[derive(Clone, Debug, PartialEq)]
pub struct GrabPick {
    pub guid: String,
    pub indexer_id: f64,
    pub allow_over_cap: bool,
}

pub fn parse_interactive_grab(raw: &Value) -> Option<GrabPick> {
    let guid = raw.get("guid")?.as_str().filter(|g| !g.is_empty())?;
    let indexer_id = raw.get("indexerId")?.as_f64()?;
    Some(GrabPick {
        guid: guid.to_string(),
        indexer_id,
        allow_over_cap: raw.get("allowOverCap") == Some(&Value::Bool(true)),
    })
}

#[derive(Debug, PartialEq)]
pub enum InteractiveGrab {
    OverCap,
    ReleaseNotFound,
    NoSpace,
    UpstreamError(u16),
    Grabbed { title: Option<Value>, size_gb: f64 },
}

/// What an interactive grab needs: who and what, the cap, and an optional
/// disk reservation around the POST.
pub struct GrabRequest<'a> {
    pub app: Arr,
    pub item_id: u64,
    pub sub: &'a str,
    pub pick: &'a GrabPick,
    pub cap_gb: f64,
    pub reserve: Option<(&'a Ledger, &'a Folder)>,
}

/// An admin's hand-picked grab. The release is located again by
/// guid+indexerId (the cap is judged against the upstream record, never the
/// client's size); over the cap it needs `allowOverCap`. Logged through the
/// same grab-event vocabulary as the automatic pipeline.
pub async fn execute_interactive_grab(
    log: &GrabLog,
    req: GrabRequest<'_>,
    cap_for: impl Fn(&Value) -> Option<f64>,
    list: impl AsyncFnOnce() -> Result<Option<Vec<Value>>, upstream::Error>,
    post: impl AsyncFnOnce(&str, f64) -> Result<Reply, upstream::Error>,
) -> Result<InteractiveGrab, upstream::Error> {
    let base = Obj::new()
        .put("itemId", req.item_id)
        .put("sub", req.sub)
        .put("capGb", num(req.cap_gb));
    let Some(releases) = list().await? else {
        return Ok(InteractiveGrab::UpstreamError(502));
    };
    let Some(picked) = releases.iter().find(|r| {
        r.get("guid").and_then(Value::as_str) == Some(req.pick.guid.as_str())
            && as_num(r.get("indexerId")) == Some(req.pick.indexer_id)
    }) else {
        return Ok(InteractiveGrab::ReleaseNotFound);
    };
    let size = as_num(picked.get("size")).unwrap_or(0.0);
    let title = picked.get("title").cloned();
    let release = Obj::new()
        .opt("title", title.clone())
        .put("sizeBytes", num(size))
        .put(
            "qualityWeight",
            picked
                .get("qualityWeight")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| 0.into()),
        );
    if cap_for(picked).is_some_and(|c| size > c) && !req.pick.allow_over_cap {
        let ev = base
            .clone()
            .opt("title", title.clone())
            .put("type", "all_rejected_by_cap")
            .put("eligible", 0)
            .put("release", release);
        log.record(req.app, ev).await;
        return Ok(InteractiveGrab::OverCap);
    }
    log.record(
        req.app,
        base.clone()
            .opt("title", title.clone())
            .put("type", "grab_started"),
    )
    .await;
    let reserved = match req.reserve {
        Some((ledger, folder)) if size > 0.0 => {
            if !ledger.reserve(folder, size) {
                return Ok(InteractiveGrab::NoSpace);
            }
            Some((ledger, folder))
        }
        _ => None,
    };
    let grab = post(&req.pick.guid, req.pick.indexer_id).await;
    if let Some((ledger, folder)) = reserved {
        ledger.release(folder, size);
    }
    let grab = grab?;
    log.record(
        req.app,
        base.opt("title", title.clone())
            .put("type", grab_event_type(&grab))
            .put("status", grab.status.as_u16())
            .put("release", release),
    )
    .await;
    if !grab.is_success() {
        return Ok(InteractiveGrab::UpstreamError(grab.status.as_u16()));
    }
    Ok(InteractiveGrab::Grabbed {
        title,
        size_gb: round2(size / 1e9),
    })
}

/// The shared HTTP contract for an interactive grab's outcome.
pub fn interactive_grab_response(result: InteractiveGrab) -> Response {
    let (status, body) = match result {
        InteractiveGrab::Grabbed { title, size_gb } => {
            let mut b = json!({ "status": "grabbed", "sizeGb": num(size_gb) });
            if let Some(t) = title {
                b["title"] = t;
            }
            (StatusCode::OK, b)
        }
        InteractiveGrab::OverCap => (
            StatusCode::FAILED_DEPENDENCY,
            json!({
                "error": "over_cap",
                "message": "Release exceeds the size cap; resend with allowOverCap to grab anyway.",
            }),
        ),
        InteractiveGrab::ReleaseNotFound => (
            StatusCode::NOT_FOUND,
            json!({ "error": "release_not_found" }),
        ),
        InteractiveGrab::NoSpace => (
            StatusCode::INSUFFICIENT_STORAGE,
            json!({ "error": "insufficient_disk_space" }),
        ),
        InteractiveGrab::UpstreamError(s) => (
            StatusCode::BAD_GATEWAY,
            json!({ "error": "grab_failed", "status": s }),
        ),
    };
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests;
