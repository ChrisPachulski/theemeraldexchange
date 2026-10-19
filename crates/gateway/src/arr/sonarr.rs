//! /api/sonarr (routes/sonarr.ts): an allowlist of Sonarr endpoints. Reads
//! are forwarded; the admin "Advanced options" (S1-S7) each own their
//! request fields and response shape. Nothing is blanket-proxied.
//!
//! The add forces search-on-add off, so the per-episode size cap is the only
//! thing that starts a download: after the add it works out which seasons
//! Sonarr monitored (one re-read when the 201 echoed none), repairs the
//! `monitor:'none'` wipe of an explicit season pick, and spawns the capped
//! grab. Unlike Radarr's, the TV grab is never awaited: it runs one indexer
//! search per season after multi-second settles, and the series is kept
//! whatever it finds. The SPA polls /api/grabs/by-item for the outcome.
//!
//! The cap covers the add and the season-monitor route. Sonarr's own RSS
//! sweep of monitored series is held back by the quality profile ("Choose
//! Me" excludes 2160p), not by this cap.

#![allow(clippy::result_large_err)]

use std::cmp::Ordering;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::{Map, Value, json};

use super::shared::*;
use super::{Busy, gate};
use crate::AppState;
use crate::recommender::{self, Caller};
use crate::routes::{js_str_number, safe_positive, truthy};
use crate::stores::{MAX_SAFE, Section};
use crate::upstream::{Arr, LAN_TIMEOUT, Reply};

const SONARR: Arr = Arr::Sonarr;
const ARR: (Section, bool) = (Section::Arr, true);
/// A Sonarr lookup record with seasons and images is a few KB; Hono read
/// these bodies unbounded.
const BODY_LIMIT: usize = 1024 * 1024;

/// S1: RefreshSeries/SeriesSearch act on the whole series; EpisodeSearch
/// needs the episode ids; RenameFiles the series and its file ids.
const COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        name: "RefreshSeries",
        requires: &[],
        passthrough: &["seriesId"],
    },
    CommandSpec {
        name: "SeriesSearch",
        requires: &[],
        passthrough: &["seriesId"],
    },
    CommandSpec {
        name: "EpisodeSearch",
        requires: &["episodeIds"],
        passthrough: &["episodeIds"],
    },
    CommandSpec {
        name: "RenameFiles",
        requires: &["seriesId", "files"],
        passthrough: &["seriesId", "files"],
    },
];

/// The identifying metadata a policy-free add keeps: no profile, folder,
/// monitor mode, season picks or tags, so a direct POST cannot pick a
/// looser policy.
const NON_ADMIN_ALLOW: &[&str] = &[
    "title",
    "year",
    "tvdbId",
    "imdbId",
    "tmdbId",
    "images",
    "titleSlug",
    "overview",
    "genres",
    "runtime",
    "status",
    "originalLanguage",
];

/// A member's own picks: the metadata plus the controls the Add dialog shows
/// everyone (folder and profile are validated separately; tags stay admin).
const HONORED_ALLOW: &[&str] = &[
    "title",
    "year",
    "tvdbId",
    "imdbId",
    "tmdbId",
    "images",
    "titleSlug",
    "overview",
    "genres",
    "runtime",
    "status",
    "originalLanguage",
    "monitored",
    "addOptions",
    "seasons",
    "seasonFolder",
];

pub fn router() -> Router<AppState> {
    let read = || get(read);
    Router::new()
        .route("/api/sonarr/api/v3/system/status", read())
        .route("/api/sonarr/api/v3/qualityprofile", read())
        .route("/api/sonarr/api/v3/rootfolder", read())
        .route("/api/sonarr/api/v3/series", read().post(add_series))
        .route("/api/sonarr/api/v3/series/lookup", get(lookup))
        // DetailModal's per-season episode air dates (?seriesId=N).
        .route("/api/sonarr/api/v3/episode", read())
        // The Downloads tab's season clusters.
        .route("/api/sonarr/api/v3/queue", read())
        .route(
            "/api/sonarr/api/v3/queue/clear-stuck",
            post(clear_stuck_route),
        )
        .route("/api/sonarr/api/v3/command", post(command_route))
        .route(
            "/api/sonarr/api/v3/release",
            get(release_search).post(release_grab),
        )
        .route("/api/sonarr/api/v3/rename", get(rename_preview))
        .route("/api/sonarr/api/v3/episode/monitor", put(episode_monitor))
        .route("/api/sonarr/api/v3/history/series", get(history_route))
        .route(
            "/api/sonarr/api/v3/series/{id}",
            put(edit_series).delete(delete_series),
        )
        .route(
            "/api/sonarr/api/v3/series/{id}/seasons/{n}/monitor",
            post(monitor_season),
        )
}

/// The admin gate, with or without the per-session bucket.
async fn admin(
    st: &AppState,
    p: &auth::Principal,
    method: &Method,
    limited: bool,
) -> Result<(), Response> {
    let limit = limited.then_some(&st.arr.sonarr_limit);
    gate(st, p, method, ARR, true, limit).await
}

fn min_free(st: &AppState) -> f64 {
    st.config.min_free_gb * GB
}

fn max_episode_bytes(st: &AppState) -> f64 {
    st.config.max_tv_gb_per_episode * GB
}

async fn fetch(
    st: &AppState,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
) -> Result<Reply, Response> {
    call(st, SONARR, method, path, query, body, LAN_TIMEOUT).await
}

fn series_id(uri: &Uri) -> Result<u64, Response> {
    query_id(uri, "seriesId", "bad_seriesId")
}

/// `Number.isSafeInteger(n) && n >= 0` (season 0 is Specials).
fn safe_index(n: f64) -> Option<u64> {
    (n.fract() == 0.0 && (0.0..=MAX_SAFE).contains(&n)).then_some(n as u64)
}

/// `seriesId` plus `seasonNumber` when one is given; the flag says it was
/// given but is not a season number.
fn release_query(id: u64, uri: &Uri) -> (Vec<(&'static str, String)>, bool) {
    let mut q = vec![("seriesId", id.to_string())];
    let pairs = query_pairs(uri);
    let season = query_first(&pairs, "seasonNumber").filter(|s| !s.is_empty());
    let bad = match season.map(|s| safe_index(js_str_number(s))) {
        Some(Some(n)) => {
            q.push(("seasonNumber", n.to_string()));
            false
        }
        Some(None) => true,
        None => false,
    };
    (q, bad)
}

fn as_pairs<'a>(q: &'a [(&'static str, String)]) -> Vec<(&'a str, &'a str)> {
    q.iter().map(|(k, v)| (*k, v.as_str())).collect()
}

/// A failed series GET/PUT relayed as its status and text (Hono's bare
/// `new Response(text, {status})`).
fn text_reply(r: Reply) -> Response {
    (r.status, String::from_utf8_lossy(&r.body).into_owned()).into_response()
}

// --- seasons and episode counts ----------------------------------------------------

/// SameValueZero over optional JSON values (None is `undefined`): how a JS
/// Map or Set compares the season and episode keys.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn season(r: &Value) -> Option<&Value> {
    r.get("seasonNumber")
}

fn episodes(r: &Value) -> &[Value] {
    r.get("episodeNumbers")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn is_true(r: &Value, k: &str) -> bool {
    r.get(k).is_some_and(truthy)
}

/// Episodes per season.
#[derive(Default)]
struct Counts(Vec<(Option<Value>, usize)>);

impl Counts {
    fn add(&mut self, season: Option<&Value>) {
        match self.0.iter_mut().find(|(k, _)| same(k.as_ref(), season)) {
            Some(slot) => slot.1 += 1,
            None => self.0.push((season.cloned(), 1)),
        }
    }

    fn get(&self, season: Option<&Value>) -> Option<usize> {
        self.0
            .iter()
            .find(|(k, _)| same(k.as_ref(), season))
            .map(|(_, n)| *n)
    }
}

/// Episodes per (numeric) season for the advanced browser's cap; empty when
/// the list cannot be read, so the cap fails open.
async fn season_counts(st: &AppState, id: u64) -> Result<Counts, Response> {
    let path = format!("/api/v3/episode?seriesId={id}");
    let r = fetch(st, Method::GET, &path, &[], None).await?;
    let mut counts = Counts::default();
    if r.is_success() {
        let list = parse_body(&r.body);
        for e in list
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(n) = e.get("seasonNumber").filter(|v| v.is_number()) {
                counts.add(Some(n));
            }
        }
    }
    Ok(counts)
}

/// The advanced browser's per-release ceiling: MAX_TV_GB_PER_EPISODE times
/// the release's episodes (a full-season pack counts its season). None (not
/// over the cap) when the pack's season count is unknown.
fn tv_cap(st: &AppState, r: &Value, counts: &Counts) -> Option<f64> {
    let n = if is_true(r, "fullSeason") && season(r).is_some_and(Value::is_number) {
        counts.get(season(r))?
    } else {
        episodes(r).len().max(1)
    };
    Some(max_episode_bytes(st) * n as f64)
}

/// The capped grab's episode count: a pack whose season has no known
/// episodes is None and never grabbed.
fn episode_count(r: &Value, counts: &Counts) -> Option<usize> {
    if is_true(r, "fullSeason") && season(r).is_some() {
        counts.get(season(r))
    } else {
        Some(episodes(r).len().max(1))
    }
}

// --- reads, clear-stuck, advanced options (S1-S7) -----------------------------------

async fn read(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    gate(&st, &p, &method, ARR, false, None).await?;
    forward_read(&st, SONARR, &uri).await
}

/// Discover search, owned titles first (see arr/search.rs).
async fn lookup(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    gate(&st, &p, &method, ARR, false, None).await?;
    super::search::lookup(&st, SONARR, &uri).await
}

async fn clear_stuck_route(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
) -> Res {
    admin(&st, &p, &method, true).await?;
    clear_stuck(&st, SONARR).await
}

/// S1: fire an allowlisted command.
async fn command_route(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    body: Body,
) -> Res {
    admin(&st, &p, &method, true).await?;
    let raw = auth::json_body(body, BODY_LIMIT).await?;
    command(&st, SONARR, &raw, COMMANDS).await
}

/// S2: interactive search, projected with the per-episode cap.
async fn release_search(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    admin(&st, &p, &method, true).await?;
    let id = series_id(&uri)?;
    let (q, bad) = release_query(id, &uri);
    if bad {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "bad_seasonNumber" }),
        ));
    }
    let search = st.arr.timings.search;
    let q = as_pairs(&q);
    let (rel, counts) = tokio::join!(
        call(
            &st,
            SONARR,
            Method::GET,
            "/api/v3/release",
            &q,
            None,
            search
        ),
        season_counts(&st, id),
    );
    let (rel, counts) = (rel?, counts?);
    if !rel.is_success() {
        return Ok(with_status("release_search_failed", rel.status));
    }
    let rows: Vec<Value> = parse_body(&rel.body)
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|r| project_release(r, tv_cap(&st, r, &counts)))
        .collect();
    Ok(Json(rows).into_response())
}

/// S3: grab a hand-picked release under (or, with allowOverCap, over) the
/// per-episode cap. A bad seasonNumber is dropped, not refused.
async fn release_grab(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
    body: Body,
) -> Res {
    admin(&st, &p, &method, true).await?;
    let raw = auth::json_body(body, BODY_LIMIT).await?;
    let pick = parse_interactive_grab(&raw)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, json!({ "error": "invalid_body" })))?;
    let id = series_id(&uri)?;
    let (q, _) = release_query(id, &uri);
    let counts = season_counts(&st, id).await?;
    let q = as_pairs(&q);
    let search = st.arr.timings.search;
    let result = execute_interactive_grab(
        &st.arr.grabs,
        GrabRequest {
            app: SONARR,
            item_id: id,
            sub: &p.session.sub,
            pick: &pick,
            cap_gb: st.config.max_tv_gb_per_episode,
            reserve: None,
        },
        |r| tv_cap(&st, r, &counts),
        async || {
            let r = st
                .upstream
                .arr_fetch(
                    &st.config,
                    SONARR,
                    Method::GET,
                    "/api/v3/release",
                    &q,
                    None,
                    search,
                )
                .await?;
            Ok(r.is_success().then(|| {
                parse_body(&r.body)
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default()
            }))
        },
        async |guid: &str, indexer_id: f64| {
            let body = json!({ "guid": guid, "indexerId": num(indexer_id) });
            st.upstream
                .arr_fetch(
                    &st.config,
                    SONARR,
                    Method::POST,
                    "/api/v3/release",
                    &[],
                    Some(&body),
                    search,
                )
                .await
        },
    )
    .await?;
    Ok(interactive_grab_response(result))
}

/// S4: the rename preview.
async fn rename_preview(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    admin(&st, &p, &method, false).await?;
    let id = series_id(&uri)?.to_string();
    let r = fetch(
        &st,
        Method::GET,
        "/api/v3/rename",
        &[("seriesId", &id)],
        None,
    )
    .await?;
    if !r.is_success() {
        return Ok(with_status("rename_preview_failed", r.status));
    }
    let rows: Vec<Value> = parse_body(&r.body)
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|row| {
            let mut m = Map::new();
            for k in ["episodeFileId", "seasonNumber", "existingPath", "newPath"] {
                if let Some(v) = row.get(k) {
                    m.insert(k.into(), v.clone());
                }
            }
            Value::Object(m)
        })
        .collect();
    Ok(Json(rows).into_response())
}

/// S5: the batch episode monitor toggle (safe-integer ids only).
async fn episode_monitor(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    body: Body,
) -> Res {
    admin(&st, &p, &method, true).await?;
    let raw = auth::json_body(body, BODY_LIMIT).await?;
    let ids: Vec<Value> = raw
        .get("episodeIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE)
        .map(num)
        .collect();
    let monitored = raw.get("monitored").filter(|v| v.is_boolean());
    let Some(monitored) = monitored.filter(|_| !ids.is_empty()) else {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_body" }),
        ));
    };
    let body = json!({ "episodeIds": ids, "monitored": monitored });
    let r = fetch(
        &st,
        Method::PUT,
        "/api/v3/episode/monitor",
        &[],
        Some(&body),
    )
    .await?;
    if !r.is_success() {
        return Ok(with_status("monitor_update_failed", r.status));
    }
    Ok(Json(json!({ "ok": true, "updated": ids.len() })).into_response())
}

/// S6: newest-first history.
async fn history_route(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    admin(&st, &p, &method, false).await?;
    history(&st, SONARR, "series", "seriesId", series_id(&uri)?).await
}

/// S7: edit monitored/qualityProfileId/rootFolderPath only.
async fn edit_series(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path(raw_id): Path<String>,
    body: Body,
) -> Res {
    admin(&st, &p, &method, true).await?;
    let id = path_id(&raw_id)?;
    let patch = extract_edit_patch(&auth::json_body(body, BODY_LIMIT).await?);
    edit(&st, SONARR, "series", id, patch).await
}

async fn delete_series(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path(raw_id): Path<String>,
    uri: Uri,
) -> Res {
    admin(&st, &p, &method, true).await?;
    delete(&st, SONARR, "series", path_id(&raw_id)?, &uri).await
}

// --- the space gate ----------------------------------------------------------------

/// Sonarr's root folders. A failed lookup is 503 when Sonarr answered
/// 503/504 (a timeout included), else 502.
async fn folders(st: &AppState) -> Result<Vec<Value>, Response> {
    let status = match arr_get(st, SONARR, "/api/v3/rootfolder", &[]).await {
        Ok(r) if r.is_success() => match parse_body(&r.body) {
            Some(Value::Array(folders)) => return Ok(folders),
            _ => StatusCode::BAD_GATEWAY,
        },
        Ok(r) if matches!(r.status.as_u16(), 503 | 504) => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_GATEWAY,
    };
    tracing::error!(event = "sonarr", "rootfolder lookup failed");
    Err(err(status, json!({ "error": "rootfolder_unreachable" })))
}

/// The fail-closed free-space gate. With `refuse_in_flight` it also refuses
/// while another TV grab's planned bytes are reserved on the folder: the
/// grab is asynchronous, so a second search-bearing request waits for that
/// plan to settle instead of spending the same headroom twice.
async fn space_gate(
    st: &AppState,
    root: Option<&Value>,
    refuse_in_flight: bool,
) -> Result<Folder, Response> {
    if !root.is_some_and(truthy) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "rootFolderPath_required" }),
        ));
    }
    let folders = folders(st).await?;
    let ledger = &st.arr.sonarr_ledger;
    let (folder, available) = gate_root_folder_space(root, &folders, ledger, min_free(st))
        .map_err(|(status, body)| err(status, body))?;
    let reserved = ledger.pending_bytes(&folder);
    if refuse_in_flight && reserved > 0.0 {
        return Err(err(
            StatusCode::CONFLICT,
            json!({
                "error": "root_folder_reservation_in_flight",
                "reserved_bytes": num(reserved),
                "free_bytes": num(available),
                "path": folder.path,
            }),
        ));
    }
    Ok(folder)
}

// --- the add --------------------------------------------------------------------------

/// Parse + policy. An admin who sent policy fields is trusted verbatim; a
/// member who sent them has each validated against the live lists; a body
/// with no policy (a member's slim body, or an admin previewing as one) gets
/// the curated defaults, so a direct POST cannot bypass the quality profile
/// that also gates Sonarr's RSS sweep.
async fn resolve_add_body(
    st: &AppState,
    session: &auth::session::Session,
    raw: Value,
) -> Result<Map<String, Value>, Response> {
    let Value::Object(raw) = raw else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_body" }),
        ));
    };
    let has_policy = raw.contains_key("rootFolderPath");
    if session.role == auth::Role::Admin && has_policy {
        return Ok(raw);
    }
    let configured = st.config.default_sonarr_root_folder_path.as_deref();
    if has_policy {
        return match validate_honored(st, SONARR, &raw, HONORED_ALLOW, configured).await? {
            Ok(body) => Ok(body),
            Err(u) => Err(err(u.status(), u.payload())),
        };
    }
    let materialized = materialize(
        st,
        SONARR,
        &raw,
        NON_ADMIN_ALLOW,
        configured,
        |safe, folder, profile| {
            safe.insert("rootFolderPath".into(), folder);
            safe.insert("qualityProfileId".into(), profile);
            safe.insert("monitored".into(), true.into());
            safe.insert("seasonFolder".into(), true.into());
            // 'firstSeason' (Sonarr picks the lowest season when there is no
            // season 1): a completed show then has a season to grab, and the
            // Add copy promises "Season 1 by default".
            safe.insert(
                "addOptions".into(),
                json!({
                    "searchForMissingEpisodes": true,
                    "searchForCutoffUnmetEpisodes": false,
                    "monitor": "firstSeason",
                }),
            );
            safe.insert("tags".into(), json!([]));
        },
    )
    .await?;
    materialized.map_err(|u| err(StatusCode::SERVICE_UNAVAILABLE, u.payload()))
}

async fn add_series(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Res {
    gate(&st, &p, &method, ARR, false, Some(&st.arr.sonarr_limit)).await?;
    let raw = auth::json_body(body, BODY_LIMIT).await?;
    let body = resolve_add_body(&st, &p.session, raw).await?;
    let option = |k: &str| body.get("addOptions").and_then(|o| o.get(k));
    let wanted_search = option("searchForMissingEpisodes") != Some(&Value::Bool(false))
        || option("searchForCutoffUnmetEpisodes") == Some(&Value::Bool(true));
    let folder = space_gate(&st, body.get("rootFolderPath"), wanted_search).await?;

    // Search-on-add off: the capped grab is the only download trigger. The
    // gate matched by normalization; forward Sonarr's own spelling.
    let mut capped = body.clone();
    capped.insert("rootFolderPath".into(), folder.path.clone().into());
    let mut options = match body.get("addOptions") {
        Some(Value::Object(o)) => o.clone(),
        _ => Map::new(),
    };
    options.insert("searchForMissingEpisodes".into(), false.into());
    options.insert("searchForCutoffUnmetEpisodes".into(), false.into());
    capped.insert("addOptions".into(), Value::Object(options));

    // The add, the conversion signal and the reconcile run in their own task,
    // so a client hang-up (even while Sonarr is still committing the add)
    // cannot stop them halfway (Node never cancelled).
    let caller = Caller::new(&p, &headers);
    let sub = p.session.sub.clone();
    let task = async move {
        let capped = Value::Object(capped);
        let r = fetch(&st, Method::POST, "/api/v3/series", &[], Some(&capped)).await?;

        // The conversion signal; the recommender's catalog is keyed on tmdbId
        // (Sonarr's own id is tvdbId), so without one there is nothing to send.
        if r.is_success()
            && st.config.use_local_recommender
            && let Some(tmdb) = body.get("tmdbId").filter(|v| v.is_number())
        {
            let ev = json!({ "sub": sub, "kind": "tv", "tmdb_id": tmdb, "signal": "added" });
            recommender::spawn_mirror(
                &st,
                "/events/feedback",
                ev,
                "recommender.postFeedback",
                Some(&caller),
            );
        }
        if r.is_success() && wanted_search {
            // Never fails; its own task keeps a panic from costing the reply.
            let _ = tokio::spawn(reconcile_and_grab(
                st.clone(),
                r.body.clone(),
                body,
                folder,
                sub,
            ))
            .await;
        }
        Ok(relay_reply(r))
    };
    tokio::spawn(task)
        .await
        .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()))
}

/// Season numbers as the TS held them (None is `undefined`).
type Seasons = Vec<Option<Value>>;

/// `seasons.filter(s => s.monitored).map(s => s.seasonNumber)`; None where
/// the TS threw (not an array, a null entry).
fn monitored_of(seasons: &Value) -> Option<Seasons> {
    let mut out = vec![];
    for s in seasons.as_array()? {
        if s.is_null() {
            return None;
        }
        if is_true(s, "monitored") {
            out.push(season(s).cloned());
        }
    }
    Some(out)
}

fn nullish(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// GET the series again. Ok(None) for a non-2xx; Err where the TS threw.
async fn reread(st: &AppState, id: &Value) -> Result<Option<Value>, String> {
    let path = format!("/api/v3/series/{}", js_str(id));
    let r = st
        .upstream
        .arr_fetch(
            &st.config,
            SONARR,
            Method::GET,
            &path,
            &[],
            None,
            LAN_TIMEOUT,
        )
        .await
        .map_err(|e| e.to_string())?;
    if !r.is_success() {
        return Ok(None);
    }
    match parse_body(&r.body) {
        Some(v) if !v.is_null() => Ok(Some(v)),
        _ => Err("series body is not a JSON object".into()),
    }
}

/// The seasons to grab. `monitor:'all'` with explicit seasons takes them
/// all; otherwise the monitored ones the caller sent, else the ones the 201
/// echoed. A brand-new series can echo none before 'firstSeason' lands, so
/// with no explicit pick it is read once more (one GET, no retry loop: if
/// Sonarr still has nothing, skipping the grab beats looping here).
async fn monitored_seasons(
    st: &AppState,
    body: &Map<String, Value>,
    created: &Value,
    id: Option<&Value>,
) -> Option<Seasons> {
    let explicit = body.get("seasons").is_some_and(truthy);
    let monitor = body.get("addOptions").and_then(|o| o.get("monitor"));
    let mut monitored = if monitor.and_then(Value::as_str) == Some("all") && explicit {
        let mut all = vec![];
        for s in body["seasons"].as_array()? {
            if s.is_null() {
                return None;
            }
            all.push(season(s).cloned());
        }
        all
    } else {
        match nullish(body.get("seasons")).or(nullish(created.get("seasons"))) {
            Some(s) => monitored_of(s)?,
            None => vec![],
        }
    };
    if let Some(id) = id
        && monitored.is_empty()
        && !explicit
    {
        let fresh = reread(st, id).await.and_then(|fresh| {
            fresh.map_or(Ok(None), |f| {
                let seasons = nullish(f.get("seasons")).map_or(Some(vec![]), monitored_of);
                seasons
                    .map(Some)
                    .ok_or_else(|| "seasons is not a list".to_string())
            })
        });
        match fresh {
            Ok(Some(m)) => monitored = m,
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(event = "tv-monitor", series_id = %js_str(id), error = %e, "re-read series for monitored seasons failed");
            }
        }
    }
    Some(monitored)
}

/// The modal's single-season pick sends `monitor:'none'` with only the
/// chosen season monitored, and Sonarr applies `monitor` after the seasons,
/// unmonitoring every one. Without this PUT-back the series drops out of the
/// RSS sweep: nothing is left to recover a failed first grab.
async fn reconcile_pick(st: &AppState, id: &Value, monitored: &Seasons, created: &Value) {
    let has = |v: &Value| {
        v.get("seasons")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
    };
    let mut series = created.clone();
    if !has(&series) {
        match reread(st, id).await {
            Ok(Some(fresh)) if has(&fresh) => series = fresh,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(event = "tv-monitor", series_id = %js_str(id), error = %e, "re-read series for season reconciliation failed");
            }
        }
    }
    let Value::Object(mut patched) = series else {
        return;
    };
    let Some(seasons) = patched
        .get("seasons")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    else {
        return;
    };
    let seasons: Vec<Value> = seasons
        .iter()
        .map(|s| {
            let mut s = s.as_object().cloned().unwrap_or_default();
            let on = monitored
                .iter()
                .any(|m| same(m.as_ref(), s.get("seasonNumber")));
            s.insert("monitored".into(), on.into());
            Value::Object(s)
        })
        .collect();
    patched.insert("monitored".into(), true.into());
    patched.insert("seasons".into(), seasons.into());
    let path = format!("/api/v3/series/{}", js_str(id));
    let put = st
        .upstream
        .arr_fetch(
            &st.config,
            SONARR,
            Method::PUT,
            &path,
            &[],
            Some(&Value::Object(patched)),
            LAN_TIMEOUT,
        )
        .await;
    match put {
        Ok(r) if r.is_success() => {}
        Ok(r) => {
            tracing::error!(event = "tv-monitor", series_id = %js_str(id), status = r.status.as_u16(), "PUT series failed");
        }
        Err(e) => {
            tracing::error!(event = "tv-monitor", series_id = %js_str(id), error = %e, "PUT series failed")
        }
    }
}

/// Which seasons ended up monitored, the explicit-pick repair, then the
/// background grab. Anything unusable in the 201 just skips the grab: the
/// series was added.
async fn reconcile_and_grab(
    st: AppState,
    out: Bytes,
    body: Map<String, Value>,
    folder: Folder,
    sub: String,
) {
    let Some(created) = parse_body(&out).filter(|c| !c.is_null()) else {
        return;
    };
    let id = created.get("id").filter(|v| truthy(v)).cloned();
    let Some(monitored) = monitored_seasons(&st, &body, &created, id.as_ref()).await else {
        return;
    };
    let Some(id) = id.filter(|_| !monitored.is_empty()) else {
        return;
    };
    let monitor = body.get("addOptions").and_then(|o| o.get("monitor"));
    if monitor.and_then(Value::as_str) == Some("none") {
        reconcile_pick(&st, &id, &monitored, &created).await;
    }
    let title = created.get("title").cloned();
    spawn_tv_grab(&st, id, monitored, title, folder, sub);
}

// --- season monitor ------------------------------------------------------------------

/// Flip one season of an existing series to monitored and grab it under the
/// cap. A refresh that discovers a new season usually lands it unmonitored,
/// and this is the targeted way to fetch it without the full edit surface.
async fn monitor_season(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path((raw_id, raw_n)): Path<(String, String)>,
) -> Res {
    admin(&st, &p, &method, true).await?;
    let id = safe_positive(js_str_number(&raw_id));
    let n = safe_index(js_str_number(&raw_n));
    let (Some(id), Some(n)) = (id, n) else {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "bad_params" }),
        ));
    };
    let path = format!("/api/v3/series/{id}");
    let got = fetch(&st, Method::GET, &path, &[], None).await?;
    if !got.is_success() {
        return Ok(text_reply(got));
    }
    let series = parse_body(&got.body).ok_or_else(|| internal("series body is not JSON"))?;
    let seasons = series
        .get("seasons")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let is_n = |s: &Value| as_num(s.get("seasonNumber")) == Some(n as f64);
    if !seasons.iter().any(is_n) {
        return Ok(err(
            StatusCode::NOT_FOUND,
            json!({ "error": "season_not_found" }),
        ));
    }
    let folder = space_gate(&st, series.get("rootFolderPath"), true).await?;
    let mut patched = series.as_object().cloned().unwrap_or_default();
    let seasons: Vec<Value> = seasons
        .into_iter()
        .map(|mut s| {
            if is_n(&s)
                && let Value::Object(m) = &mut s
            {
                m.insert("monitored".into(), true.into());
            }
            s
        })
        .collect();
    patched.insert("monitored".into(), true.into());
    patched.insert("seasons".into(), seasons.into());
    let put = fetch(&st, Method::PUT, &path, &[], Some(&Value::Object(patched))).await?;
    if !put.is_success() {
        return Ok(text_reply(put));
    }
    let title = series.get("title").cloned();
    spawn_tv_grab(
        &st,
        json!(id),
        vec![Some(json!(n))],
        title,
        folder,
        p.session.sub.clone(),
    );
    Ok(Json(json!({ "ok": true, "seriesId": id, "seasonNumber": n })).into_response())
}

// --- the capped TV grab ----------------------------------------------------------------

/// Run the capped grab in the background, counted by [`super::ArrState::idle`].
/// An error is logged and recorded as grab_failed.
fn spawn_tv_grab(
    st: &AppState,
    id: Value,
    seasons: Seasons,
    title: Option<Value>,
    folder: Folder,
    sub: String,
) {
    let busy = Busy::new(&st.arr);
    let st = st.clone();
    tokio::spawn(async move {
        let _busy = busy;
        if let Err(e) = grab_tv_under_cap(&st, &id, &seasons, title.as_ref(), &folder, &sub).await {
            tracing::error!(event = "tv-cap", error = %e, "grab failed");
            let ev = Obj::new()
                .put("itemId", &id)
                .opt("title", title.as_ref())
                .put("sub", &sub)
                .put("type", "grab_failed")
                .put("error", &e);
            st.arr.grabs.record(SONARR, ev).await;
        }
    });
}

async fn tv_call(
    st: &AppState,
    method: Method,
    path: &str,
    body: Option<&Value>,
    timeout: std::time::Duration,
) -> Result<Reply, String> {
    st.upstream
        .arr_fetch(&st.config, SONARR, method, path, &[], body, timeout)
        .await
        .map_err(|e| e.to_string())
}

/// A JSON array body, else an error message.
fn array_body(r: &Reply, what: &str) -> Result<Vec<Value>, String> {
    match serde_json::from_slice(&r.body) {
        Ok(Value::Array(a)) => Ok(a),
        Ok(_) => Err(format!("{what} is not an array")),
        Err(e) => Err(format!("{what} is not JSON: {e}")),
    }
}

/// `S{season}-pack` or `S{season}E{episodes joined by -}`: one best
/// release per chunk, not five copies of one episode.
fn chunk_key(r: &Value) -> String {
    let sn = season(r);
    if is_true(r, "fullSeason")
        && let Some(sn) = sn
    {
        return format!("S{}-pack", js_str(sn));
    }
    let eps: Vec<String> = episodes(r)
        .iter()
        .map(|e| {
            if e.is_null() {
                String::new()
            } else {
                js_str(e)
            }
        })
        .collect();
    let sn = sn.map_or_else(|| "undefined".into(), js_str);
    format!("S{sn}E{}", eps.join("-"))
}

/// Packs first, then the higher qualityWeight, then the smaller release (a
/// difference that is zero or NaN falls through, as in the TS comparator).
fn rank(a: &Value, b: &Value) -> Ordering {
    let (pa, pb) = (is_true(a, "fullSeason"), is_true(b, "fullSeason"));
    if pa != pb {
        return if pa {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let by = |d: f64| d.partial_cmp(&0.0).filter(|o| *o != Ordering::Equal);
    by(field_f64(b, "qualityWeight") - field_f64(a, "qualityWeight"))
        .or_else(|| by(field_f64(a, "size") - field_f64(b, "size")))
        .unwrap_or(Ordering::Equal)
}

/// The size-capped TV grab: search each season (Sonarr's /release without a
/// season is the RSS cache, not a search), keep what is under the
/// per-episode cap in a monitored season, prefer what Sonarr's profile
/// accepts, take the best release per chunk, prefer season packs and drop
/// overlapping partials, then reserve the planned bytes and grab.
async fn grab_tv_under_cap(
    st: &AppState,
    id: &Value,
    seasons: &Seasons,
    title: Option<&Value>,
    folder: &Folder,
    sub: &str,
) -> Result<(), String> {
    let log = &st.arr.grabs;
    let t = st.arr.timings;
    let base = Obj::new()
        .put("itemId", id)
        .opt("title", title)
        .put("capGb", num(st.config.max_tv_gb_per_episode))
        .put("sub", sub);
    log.record(SONARR, base.clone().put("type", "grab_started"))
        .await;
    // Let Sonarr finish wiring the new series.
    tokio::time::sleep(t.tv_settle).await;
    let id_text = js_str(id);

    // Sonarr fills /episode lazily after an add; poll briefly so packs are
    // judged against real season sizes.
    let mut counts = Counts::default();
    for _ in 0..5 {
        let path = format!("/api/v3/episode?seriesId={id_text}");
        let r = tv_call(st, Method::GET, &path, None, LAN_TIMEOUT).await?;
        if r.is_success() {
            counts = Counts::default();
            for e in array_body(&r, "episode list")?
                .iter()
                .filter(|e| !e.is_null())
            {
                counts.add(season(e));
            }
            if !counts.0.is_empty() {
                break;
            }
        }
        tokio::time::sleep(t.tv_poll).await;
    }

    let mut all = vec![];
    for sn in seasons {
        let sn_text = sn.as_ref().map_or_else(|| "undefined".into(), js_str);
        let path = format!("/api/v3/release?seriesId={id_text}&seasonNumber={sn_text}");
        let r = tv_call(st, Method::GET, &path, None, t.tv_search).await?;
        if !r.is_success() {
            let status = r.status.as_u16();
            tracing::error!(event = "tv-cap", status, season_number = %sn_text, series_id = %id_text, "release search failed");
            log.record(
                SONARR,
                base.clone()
                    .put("type", "search_failed")
                    .put("status", status),
            )
            .await;
            continue;
        }
        all.extend(array_body(&r, "release list")?);
    }

    let cap = max_episode_bytes(st);
    let in_monitored =
        |r: &Value| season(r).is_none() || seasons.iter().any(|m| same(m.as_ref(), season(r)));
    let within: Vec<&Value> = all
        .iter()
        .filter(|r| field_f64(r, "size") > 0.0)
        .filter(|r| in_monitored(r))
        .filter(|r| {
            episode_count(r, &counts).is_some_and(|n| field_f64(r, "size") / n as f64 <= cap)
        })
        .collect();
    // Prefer what Sonarr's profile accepts (curated to what the usenet
    // provider can deliver) and what is not temporarily rejected.
    let accepted: Vec<&Value> = within
        .iter()
        .copied()
        .filter(|r| !is_true(r, "rejected") && !is_true(r, "temporarilyRejected"))
        .collect();
    if !within.is_empty() && accepted.is_empty() {
        let ev = base
            .put("type", "all_rejected_by_profile")
            .put("scanned", all.len())
            .put("eligible", within.len());
        log.record(SONARR, ev).await;
        return Ok(());
    }

    // The best release per chunk; a qualityWeight tie goes to the smaller
    // one (intact articles are likelier than on the 50 GB 2160p copy).
    let weight = |r: &Value| as_num(r.get("qualityWeight"));
    let mut best: Vec<(String, &Value)> = vec![];
    for r in &accepted {
        let key = chunk_key(r);
        match best.iter_mut().find(|(k, _)| *k == key) {
            None => best.push((key, r)),
            Some(slot) => {
                let (w, e) = (weight(r), weight(slot.1));
                let heavier = matches!((w, e), (Some(a), Some(b)) if a > b);
                if heavier || (w == e && field_f64(r, "size") < field_f64(slot.1, "size")) {
                    slot.1 = r;
                }
            }
        }
    }
    if best.is_empty() {
        tracing::info!(event = "tv-cap", cap_gb_per_episode = st.config.max_tv_gb_per_episode, series_id = %id_text, scanned = all.len(), cap_eligible = within.len(), accepted = accepted.len(), "no releases within the per-episode cap");
        let kind = if all.is_empty() {
            "no_releases"
        } else {
            "all_rejected_by_cap"
        };
        let ev = base
            .put("type", kind)
            .put("scanned", all.len())
            .put("eligible", within.len());
        log.record(SONARR, ev).await;
        return Ok(());
    }

    let mut ranked: Vec<&Value> = best.into_iter().map(|(_, r)| r).collect();
    ranked.sort_by(|a, b| rank(a, b));
    // Season packs over episodes of the same season, then no overlapping
    // partial packs or episodes.
    let packs: Vec<&Value> = ranked
        .iter()
        .copied()
        .filter(|r| is_true(r, "fullSeason"))
        .collect();
    let mut picks = packs.clone();
    let mut covered: Vec<(&Value, Vec<&Value>)> = vec![];
    for r in &ranked {
        if is_true(r, "fullSeason") || packs.iter().any(|p| same(season(p), season(r))) {
            continue;
        }
        let eps = episodes(r);
        let Some(sn) = season(r).filter(|_| !eps.is_empty()) else {
            picks.push(r);
            continue;
        };
        let i = match covered.iter().position(|(s, _)| same(Some(s), Some(sn))) {
            Some(i) => i,
            None => {
                covered.push((sn, vec![]));
                covered.len() - 1
            }
        };
        if eps
            .iter()
            .any(|e| covered[i].1.iter().any(|c| same(Some(c), Some(e))))
        {
            continue;
        }
        picks.push(r);
        covered[i].1.extend(eps);
    }

    let planned: f64 = picks.iter().map(|r| field_f64(r, "size")).sum();
    let ledger = &st.arr.sonarr_ledger;
    let floor = min_free(st);
    let exceeds = |why: String| {
        base.clone()
            .put("type", "planned_size_exceeds_free_space")
            .put("scanned", all.len())
            .put("eligible", accepted.len())
            .put("plannedBytes", num(planned))
            .put("freeBytes", num(ledger.available_bytes(folder)))
            .put("thresholdBytes", num(floor))
            .put("error", why)
    };
    if ledger.available_bytes(folder) - planned < floor {
        let why = format!(
            "planned TV grab would leave {} below minimum free-space reserve",
            folder.path
        );
        log.record(SONARR, exceeds(why)).await;
        return Ok(());
    }
    if !ledger.reserve(folder, planned) {
        let why = format!(
            "planned TV grab would overcommit pending reservations for {}",
            folder.path
        );
        log.record(SONARR, exceeds(why)).await;
        return Ok(());
    }
    let _held = Held {
        ledger,
        folder,
        bytes: planned,
    };

    for pick in &picks {
        let grab = tv_call(
            st,
            Method::POST,
            "/api/v3/release",
            Some(&grab_body(pick)),
            t.tv_search,
        )
        .await?;
        let size = field_f64(pick, "size");
        let n = episode_count(pick, &counts).unwrap_or(1);
        let name = pick
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        tracing::info!(event = "tv-cap", title = %auth::js_slice(name, 80), size_gb = gb_2dp(size), size_gb_per_episode = gb_2dp(size / n as f64), episode_count = n, series_id = %id_text, status = grab.status.as_u16(), "grab");
        let release = Obj::new()
            .opt("title", pick.get("title"))
            .opt("sizeBytes", pick.get("size"))
            .opt("qualityWeight", pick.get("qualityWeight"))
            .opt("seasonNumber", season(pick));
        let ev = base
            .clone()
            .put("type", grab_event_type(&grab))
            .put("status", grab.status.as_u16())
            .put("release", release);
        log.record(SONARR, ev).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
