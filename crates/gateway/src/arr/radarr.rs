//! /api/radarr (routes/radarr.ts): an allowlist of Radarr endpoints. Reads
//! are forwarded; the add runs the size-capped grab itself; the admin
//! "Advanced options" (R1-R6) each own their request fields and response
//! shape. Nothing is blanket-proxied.
//!
//! The add forces `searchForMovie:false` and, when the caller wanted a
//! search, `monitored:false`, then awaits its own release search filtered to
//! MAX_MOVIE_SIZE_GB and the free-space floor. Nothing grabbable keeps the
//! movie monitored (no releases, every release Radarr-rejected, a timed-out
//! grab); every release over the cap, or a failed search/grab, rolls it
//! back with a 424. The recommender hears 'added' only on the keep paths.

#![allow(clippy::result_large_err)]

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::{Map, Value, json};

use super::gate;
use super::shared::*;
use crate::AppState;
use crate::recommender::{self, Caller};
use crate::routes::{safe_positive, truthy};
use crate::stores::Section;
use crate::upstream::{Arr, LAN_TIMEOUT, Reply};

const RADARR: Arr = Arr::Radarr;
const ARR: (Section, bool) = (Section::Arr, true);
/// A Radarr lookup record with images and alternate titles is a few KB;
/// Hono read these bodies unbounded.
const BODY_LIMIT: usize = 1024 * 1024;

/// R1: RefreshMovie/MoviesSearch take movie ids; RenameMovie may name files.
const COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        name: "RefreshMovie",
        requires: &["movieIds"],
        passthrough: &["movieIds"],
    },
    CommandSpec {
        name: "MoviesSearch",
        requires: &["movieIds"],
        passthrough: &["movieIds"],
    },
    CommandSpec {
        name: "RenameMovie",
        requires: &["movieIds"],
        passthrough: &["movieIds", "files"],
    },
];

/// The identifying metadata a policy-free add keeps: no profile, folder,
/// monitor flag or tags, so a direct POST cannot pick a looser policy.
const NON_ADMIN_ALLOW: &[&str] = &[
    "title",
    "year",
    "tmdbId",
    "imdbId",
    "images",
    "titleSlug",
    "overview",
    "genres",
    "runtime",
    "status",
    "originalTitle",
    "originalLanguage",
];

/// A member's own picks: the metadata plus the controls the Add dialog shows
/// everyone (folder and profile are validated separately; tags stay admin).
const HONORED_ALLOW: &[&str] = &[
    "title",
    "year",
    "tmdbId",
    "imdbId",
    "images",
    "titleSlug",
    "overview",
    "genres",
    "runtime",
    "status",
    "originalTitle",
    "originalLanguage",
    "monitored",
    "addOptions",
];

pub fn router() -> Router<AppState> {
    let read = || get(read);
    Router::new()
        .route("/api/radarr/api/v3/system/status", read())
        .route("/api/radarr/api/v3/qualityprofile", read())
        .route("/api/radarr/api/v3/rootfolder", read())
        .route("/api/radarr/api/v3/movie", read().post(add_movie))
        .route("/api/radarr/api/v3/movie/lookup", read())
        // The Downloads tab's movie pending states.
        .route("/api/radarr/api/v3/queue", read())
        .route(
            "/api/radarr/api/v3/queue/clear-stuck",
            post(clear_stuck_route),
        )
        .route("/api/radarr/api/v3/command", post(command_route))
        .route(
            "/api/radarr/api/v3/release",
            get(release_search).post(release_grab),
        )
        .route("/api/radarr/api/v3/rename", get(rename_preview))
        .route("/api/radarr/api/v3/history/movie", get(history_route))
        .route(
            "/api/radarr/api/v3/movie/{id}",
            put(edit_movie).delete(delete_movie),
        )
        .route("/api/radarr/api/v3/movie/{id}/upgrade", post(upgrade))
}

fn max_movie_bytes(st: &AppState) -> f64 {
    st.config.max_movie_gb * GB
}

fn min_free(st: &AppState) -> f64 {
    st.config.min_free_gb * GB
}

async fn fetch(
    st: &AppState,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
    timeout: std::time::Duration,
) -> Result<Reply, Response> {
    call(st, RADARR, method, path, query, body, timeout).await
}

/// `movieId` from the query: a positive safe integer.
fn movie_id(uri: &Uri) -> Result<u64, Response> {
    query_id(uri, "movieId", "bad_movieId")
}

// --- reads ---------------------------------------------------------------------------

async fn read(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    gate(&st, &p, &method, ARR, false, None).await?;
    forward_read(&st, RADARR, &uri).await
}

// --- admin: clear stuck imports -----------------------------------------------------

/// Downloads jammed in the import stage (importPending/importBlocked): removed
/// from the client and blocklisted so Radarr searches for a replacement.
async fn clear_stuck_route(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
) -> Res {
    gate(&st, &p, &method, ARR, true, Some(&st.arr.radarr_limit)).await?;
    clear_stuck(&st, RADARR).await
}

// --- advanced options (R1-R6) -------------------------------------------------------

/// R1: fire an allowlisted command.
async fn command_route(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    body: Body,
) -> Res {
    gate(&st, &p, &method, ARR, true, Some(&st.arr.radarr_limit)).await?;
    let raw = auth::json_body(body, BODY_LIMIT).await?;
    command(&st, RADARR, &raw, COMMANDS).await
}

/// The flat per-release movie ceiling.
fn movie_cap(st: &AppState) -> impl Fn(&Value) -> Option<f64> + use<> {
    let cap = max_movie_bytes(st);
    move |_| Some(cap)
}

/// R2: interactive search, projected.
async fn release_search(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    gate(&st, &p, &method, ARR, true, Some(&st.arr.radarr_limit)).await?;
    let id = movie_id(&uri)?.to_string();
    let r = fetch(
        &st,
        Method::GET,
        "/api/v3/release",
        &[("movieId", &id)],
        None,
        st.arr.timings.search,
    )
    .await?;
    if !r.is_success() {
        return Ok(with_status("release_search_failed", r.status));
    }
    let cap = movie_cap(&st);
    let rows: Vec<Value> = parse_body(&r.body)
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|rel| project_release(rel, cap(rel)))
        .collect();
    Ok(Json(rows).into_response())
}

/// R3: grab a hand-picked release.
async fn release_grab(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
    body: Body,
) -> Res {
    gate(&st, &p, &method, ARR, true, Some(&st.arr.radarr_limit)).await?;
    let raw = auth::json_body(body, BODY_LIMIT).await?;
    let pick = parse_interactive_grab(&raw)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, json!({ "error": "invalid_body" })))?;
    let id = movie_id(&uri)?;
    let id_text = id.to_string();
    let search = st.arr.timings.search;
    let result = execute_interactive_grab(
        &st.arr.grabs,
        GrabRequest {
            app: RADARR,
            item_id: id,
            sub: &p.session.sub,
            pick: &pick,
            cap_gb: st.config.max_movie_gb,
            reserve: None,
        },
        movie_cap(&st),
        async || {
            let r = st
                .upstream
                .arr_fetch(
                    &st.config,
                    RADARR,
                    Method::GET,
                    "/api/v3/release",
                    &[("movieId", &id_text)],
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
                    RADARR,
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

/// R4: the rename preview.
async fn rename_preview(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    gate(&st, &p, &method, ARR, true, None).await?;
    let id = movie_id(&uri)?.to_string();
    let r = fetch(
        &st,
        Method::GET,
        "/api/v3/rename",
        &[("movieId", &id)],
        None,
        LAN_TIMEOUT,
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
            for k in ["movieFileId", "existingPath", "newPath"] {
                if let Some(v) = row.get(k) {
                    m.insert(k.into(), v.clone());
                }
            }
            Value::Object(m)
        })
        .collect();
    Ok(Json(rows).into_response())
}

/// R5: newest-first history.
async fn history_route(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    uri: Uri,
) -> Res {
    gate(&st, &p, &method, ARR, true, None).await?;
    history(&st, RADARR, "movie", "movieId", movie_id(&uri)?).await
}

/// R6: edit monitored/qualityProfileId/rootFolderPath only.
async fn edit_movie(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path(raw_id): Path<String>,
    body: Body,
) -> Res {
    gate(&st, &p, &method, ARR, true, Some(&st.arr.radarr_limit)).await?;
    let id = path_id(&raw_id)?;
    let patch = extract_edit_patch(&auth::json_body(body, BODY_LIMIT).await?);
    edit(&st, RADARR, "movie", id, patch).await
}

async fn delete_movie(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path(raw_id): Path<String>,
    uri: Uri,
) -> Res {
    gate(&st, &p, &method, ARR, true, Some(&st.arr.radarr_limit)).await?;
    delete(&st, RADARR, "movie", path_id(&raw_id)?, &uri).await
}

// --- the space gate ----------------------------------------------------------------

/// The free-space gate against Radarr's live folder list (502 when the list
/// cannot be read).
async fn space_gate(st: &AppState, root_folder_path: Option<&Value>) -> Result<Folder, Response> {
    let Some(folders) = root_folders(st, RADARR).await else {
        return Err(err(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "rootfolder_unreachable" }),
        ));
    };
    gate_root_folder_space(
        root_folder_path,
        &folders,
        &st.arr.radarr_ledger,
        min_free(st),
    )
    .map(|(folder, _)| folder)
    .map_err(|(status, body)| err(status, body))
}

// --- upgrade --------------------------------------------------------------------------

/// Grab the best non-rejected release under the cap for an existing movie
/// (Radarr marks equal-or-worse releases rejected, so only upgrades are
/// left); Radarr's import decides whether it replaces the file.
async fn upgrade(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    Path(raw_id): Path<String>,
) -> Res {
    gate(&st, &p, &method, ARR, true, Some(&st.arr.radarr_limit)).await?;
    let id = path_id(&raw_id)?;
    let got = fetch(
        &st,
        Method::GET,
        &format!("/api/v3/movie/{id}"),
        &[],
        None,
        LAN_TIMEOUT,
    )
    .await?;
    if !got.is_success() {
        return Ok(with_status("movie_lookup_failed", got.status));
    }
    let movie = parse_body(&got.body).ok_or_else(|| internal("movie body is not JSON"))?;
    let root = movie.get("rootFolderPath").filter(|v| v.is_string());
    let folder = space_gate(&st, root).await?;
    let search = fetch(
        &st,
        Method::GET,
        &format!("/api/v3/release?movieId={id}"),
        &[],
        None,
        LAN_TIMEOUT,
    )
    .await?;
    if !search.is_success() {
        return Ok(with_status("release_search_failed", search.status));
    }
    let all: Vec<Value> = serde_json::from_slice(&search.body)
        .map_err(|_| internal("release body is not a JSON array"))?;
    if all.is_empty() {
        return Ok(Json(json!({ "status": "no_releases_found" })).into_response());
    }
    let ledger = &st.arr.radarr_ledger;
    let available = ledger.available_bytes(&folder);
    let (cap, floor) = (max_movie_bytes(&st), min_free(&st));
    let eligible = by_quality(
        all.iter()
            .filter(|r| {
                let size = field_f64(r, "size");
                arr_accepted(r) && size <= cap && available - size >= floor
            })
            .collect(),
    );
    let none = || {
        Json(json!({
            "status": "no_upgrade_available",
            "scanned": all.len(),
            "capGb": num(st.config.max_movie_gb),
        }))
        .into_response()
    };
    let Some(best) = eligible.first() else {
        return Ok(none());
    };
    let size = field_f64(best, "size");
    if !ledger.reserve(&folder, size) {
        return Ok(none());
    }
    let grab = fetch(
        &st,
        Method::POST,
        "/api/v3/release",
        &[],
        Some(&grab_body(best)),
        st.arr.timings.search,
    )
    .await;
    ledger.release(&folder, size);
    let grab = grab?;
    if !grab.is_success() {
        return Ok(with_status("grab_failed", grab.status));
    }
    tracing::info!(event = "movie-upgrade", title = %js_str(best.get("title").unwrap_or(&serde_json::Value::Null)), size_gb = gb_2dp(size), movie_id = id, "grabbed");
    let mut body = json!({ "status": "grabbing", "sizeGb": num(gb_2dp(size)) });
    for k in ["title", "qualityWeight"] {
        if let Some(v) = best.get(k) {
            body[k] = v.clone();
        }
    }
    Ok(Json(body).into_response())
}

// --- the add --------------------------------------------------------------------------

/// Parse + policy. An admin who sent policy fields is trusted verbatim; a
/// member who sent them has each validated against the live lists; a body
/// with no policy (a member's slim body, or an admin previewing as one) gets
/// the curated defaults.
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
    let configured = st.config.default_radarr_root_folder_path.as_deref();
    if has_policy {
        return match validate_honored(st, RADARR, &raw, HONORED_ALLOW, configured).await? {
            Ok(body) => Ok(body),
            Err(u) => Err(err(u.status(), u.payload())),
        };
    }
    let materialized = materialize(
        st,
        RADARR,
        &raw,
        NON_ADMIN_ALLOW,
        configured,
        |safe, folder, profile| {
            safe.insert("rootFolderPath".into(), folder);
            safe.insert("qualityProfileId".into(), profile);
            safe.insert("monitored".into(), true.into());
            // Gates the capped grab; the upstream call still gets
            // searchForMovie:false, so the grab is the only download trigger.
            safe.insert("addOptions".into(), json!({ "searchForMovie": true }));
            safe.insert("tags".into(), json!([]));
        },
    )
    .await?;
    materialized.map_err(|u| err(StatusCode::SERVICE_UNAVAILABLE, u.payload()))
}

async fn add_movie(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Res {
    gate(&st, &p, &method, ARR, false, Some(&st.arr.radarr_limit)).await?;
    let raw = auth::json_body(body, BODY_LIMIT).await?;
    let body = resolve_add_body(&st, &p.session, raw).await?;
    // Fail closed whenever free space cannot actually be measured.
    let folder = space_gate(&st, body.get("rootFolderPath")).await?;

    // "Start search now" (the default): the capped grab below is the only
    // download trigger, so the movie goes in unmonitored (RSS would grab
    // uncapped). "Just monitor": monitored stays, no grab.
    let wanted_search =
        body.get("addOptions").and_then(|o| o.get("searchForMovie")) != Some(&Value::Bool(false));
    let mut capped = body.clone();
    // The gate matched by normalization; forward Radarr's own spelling.
    capped.insert("rootFolderPath".into(), folder.path.clone().into());
    if wanted_search {
        capped.insert("monitored".into(), false.into());
    }
    let mut options = match body.get("addOptions") {
        Some(Value::Object(o)) => o.clone(),
        _ => Map::new(),
    };
    options.insert("searchForMovie".into(), false.into());
    capped.insert("addOptions".into(), Value::Object(options));
    let r = fetch(
        &st,
        Method::POST,
        "/api/v3/movie",
        &[],
        Some(&Value::Object(capped)),
        LAN_TIMEOUT,
    )
    .await?;

    // The conversion signal, only where the movie is kept.
    let caller = Caller::new(&p, &headers);
    let signal_added = || {
        if !(r.is_success() && st.config.use_local_recommender) {
            return;
        }
        if let Some(tmdb) = body.get("tmdbId").filter(|v| v.is_number()) {
            let ev = json!({ "sub": p.session.sub, "kind": "movie", "tmdb_id": tmdb, "signal": "added" });
            recommender::spawn_mirror(
                &st,
                "/events/feedback",
                ev,
                "recommender.postFeedback",
                Some(&caller),
            );
        }
    };

    let mut keep_body = r.body.clone();
    let mut keep_ct = r.headers.get(header::CONTENT_TYPE).cloned();
    if r.is_success() && wanted_search {
        let (created, refetched) = recover_created(&st, &r.body, body.get("tmdbId")).await;
        if let Some(text) = refetched {
            keep_body = text.into();
            keep_ct = None;
        }
        let created = match created {
            Some(c) if usable(&c) => c,
            other => {
                return Ok(reject_unverified(&st, other, body.get("title"), &p.session.sub).await);
            }
        };
        if let Some(res) =
            settle_capped_grab(&st, &created, &folder, &p.session.sub, &signal_added).await
        {
            return Ok(res);
        }
    }
    signal_added();
    Ok(relay(r.status, keep_ct.as_ref(), keep_body))
}

/// `m?.id && typeof m.title === 'string' && m.title.trim()`.
fn usable(m: &Value) -> bool {
    m.get("id").is_some_and(truthy)
        && m.get("title")
            .and_then(Value::as_str)
            .is_some_and(|t| !auth::js_trim(t).is_empty())
}

/// The created record from the 201, or (when that body is unusable) the
/// canonical record looked up by tmdbId, whose JSON then replaces the body
/// the SPA receives. The movie exists upstream either way.
async fn recover_created(
    st: &AppState,
    out: &Bytes,
    tmdb_id: Option<&Value>,
) -> (Option<Value>, Option<String>) {
    let created = parse_body(out);
    if created.as_ref().is_some_and(usable) {
        return (created, None);
    }
    match lookup_by_tmdb(st, tmdb_id).await {
        Some(m) => {
            let text = m.to_string();
            (Some(m), Some(text))
        }
        None => (created, None),
    }
}

async fn lookup_by_tmdb(st: &AppState, tmdb_id: Option<&Value>) -> Option<Value> {
    let id = as_num(tmdb_id).and_then(safe_positive)?;
    let r = fetch(
        st,
        Method::GET,
        &format!("/api/v3/movie?tmdbId={id}"),
        &[],
        None,
        LAN_TIMEOUT,
    )
    .await
    .ok()?;
    if !r.is_success() {
        return None;
    }
    let list = parse_body(&r.body)?;
    let first = list.as_array()?.first()?.clone();
    first.get("id").is_some_and(truthy).then_some(first)
}

/// DELETE the just-added movie: Err(status) when it failed (0: no id).
async fn rollback(st: &AppState, movie: &Value) -> Result<(), u16> {
    let Some(id) = movie.get("id").filter(|v| truthy(v)) else {
        return Err(0);
    };
    let r = fetch(
        st,
        Method::DELETE,
        &format!("/api/v3/movie/{}", js_str(id)),
        &[],
        None,
        LAN_TIMEOUT,
    )
    .await
    .map_err(|_| 0u16)?;
    if !r.is_success() {
        tracing::error!(event = "movie-cap", movie_id = %js_str(id), status = r.status.as_u16(), "failed to roll back movie");
        return Err(r.status.as_u16());
    }
    Ok(())
}

/// `rollback.ok ? undefined : rollback.status || undefined`.
fn rollback_status(r: Result<(), u16>) -> Option<u16> {
    r.err().filter(|s| *s != 0)
}

/// Flip the kept movie to monitored (PUT the whole record back) so RSS grabs
/// it once a usable release appears. Ok, or the failing status (0: no id).
async fn set_monitored(st: &AppState, movie: &Value) -> Result<(), u16> {
    let Some(id) = movie.get("id").filter(|v| truthy(v)) else {
        return Err(0);
    };
    let mut body = movie.clone();
    body["monitored"] = true.into();
    let r = fetch(
        st,
        Method::PUT,
        &format!("/api/v3/movie/{}", js_str(id)),
        &[],
        Some(&body),
        LAN_TIMEOUT,
    )
    .await
    .map_err(|_| 0u16)?;
    if !r.is_success() {
        tracing::error!(event = "movie-cap", movie_id = %js_str(id), status = r.status.as_u16(), "failed to set monitored on movie");
        return Err(r.status.as_u16());
    }
    Ok(())
}

/// The 201 was unusable and the tmdbId lookup could not identify the movie:
/// no grab and no monitor fallback is possible, so roll back what can be,
/// record why, and say so.
async fn reject_unverified(
    st: &AppState,
    created: Option<Value>,
    title: Option<&Value>,
    sub: &str,
) -> Response {
    let rolled = match created.as_ref().filter(|c| c.get("id").is_some_and(truthy)) {
        Some(c) => Some(rollback(st, c).await),
        None => None,
    };
    let item = created
        .as_ref()
        .and_then(|c| c.get("id"))
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| 0.into());
    st.arr
        .grabs
        .record(
            RADARR,
            Obj::new()
                .put("itemId", item)
                .opt("title", title.filter(|t| t.is_string()))
                .put("sub", sub)
                .put("type", "grab_failed")
                .put(
                    "error",
                    "Radarr add returned success but the created movie could not be identified \
                     (unparseable/untitled response body and tmdbId re-fetch failed); cap-aware grab skipped",
                ),
        )
        .await;
    let mut body = json!({
        "error": "add_unverified",
        "message": "Radarr accepted the add but did not identify the created movie, so no download was started. \
                    Check Radarr directly, then retry.",
    });
    if let Some(s) = rolled.and_then(rollback_status) {
        body["rollbackStatus"] = s.into();
    }
    err(StatusCode::BAD_GATEWAY, body)
}

/// The outcome of the capped grab.
enum Capped {
    Succeeded,
    SearchFailed(u16),
    NoReleases(usize),
    NoMatching(usize),
    AllRejectedByCap(usize),
    GrabFailed(u16),
    GrabUnconfirmed(usize),
}

/// Map the capped grab to a response; None keeps the movie with a grab
/// under way (the caller answers the ordinary success).
async fn settle_capped_grab(
    st: &AppState,
    created: &Value,
    folder: &Folder,
    sub: &str,
    signal_added: &(dyn Fn() + Sync),
) -> Option<Response> {
    let item = created.get("id").cloned().unwrap_or(Value::Null);
    let title = created.get("title").cloned().unwrap_or(Value::Null);
    let grab = match grab_best_under_cap(st, &item, folder, &title, sub).await {
        Ok(g) => g,
        Err(message) => {
            tracing::error!(event = "movie-cap", error = %message, "grab failed");
            st.arr
                .grabs
                .record(
                    RADARR,
                    Obj::new()
                        .put("itemId", &item)
                        .put("title", &title)
                        .put("sub", sub)
                        .put("type", "grab_failed")
                        .put("error", &message),
                )
                .await;
            let mut body =
                json!({ "error": "capped_grab_failed", "phase": "exception", "message": message });
            if let Some(s) = rollback_status(rollback(st, created).await) {
                body["rollbackStatus"] = s.into();
            }
            return Some(err(StatusCode::FAILED_DEPENDENCY, body));
        }
    };
    let (phase, scanned) = match grab {
        Capped::Succeeded => return None,
        Capped::SearchFailed(status) | Capped::GrabFailed(status) => {
            let phase = if matches!(grab, Capped::SearchFailed(_)) {
                "search"
            } else {
                "grab"
            };
            let mut body = json!({ "error": "capped_grab_failed", "status": status, "phase": phase, "movie": created });
            if let Some(s) = rollback_status(rollback(st, created).await) {
                body["rollbackStatus"] = s.into();
            }
            return Some(err(StatusCode::FAILED_DEPENDENCY, body));
        }
        Capped::AllRejectedByCap(scanned) => {
            // Honour the cap: a monitored movie would later be RSS-grabbed uncapped.
            let mut body = json!({
                "error": "capped_grab_not_started",
                "phase": "all_rejected_by_cap",
                "scanned": scanned,
                "capGb": num(st.config.max_movie_gb),
                "movie": created,
            });
            if let Some(s) = rollback_status(rollback(st, created).await) {
                body["rollbackStatus"] = s.into();
            }
            return Some(err(StatusCode::FAILED_DEPENDENCY, body));
        }
        Capped::NoReleases(n) => ("no_releases", n),
        Capped::NoMatching(n) => ("no_matching_releases", n),
        Capped::GrabUnconfirmed(n) => ("grab_unconfirmed", n),
    };
    // Nothing grabbable yet, or a grab Radarr was most likely still queuing:
    // the cap never applied, so keep the movie and let RSS take it.
    if let Err(status) = set_monitored(st, created).await {
        let mut body = json!({ "error": "monitor_enable_failed", "phase": phase, "scanned": scanned, "movie": created });
        if status != 0 {
            body["status"] = status.into();
        }
        return Some(err(StatusCode::BAD_GATEWAY, body));
    }
    signal_added();
    Some(
        Json(json!({
            "status": "monitoring",
            "phase": phase,
            "scanned": scanned,
            "monitored": true,
            "movie": created,
        }))
        .into_response(),
    )
}

/// The size-capped grab: search, keep what Radarr accepts, drop what is over
/// the cap or would breach the free-space floor (net of in-flight
/// reservations), reserve the best one's bytes, grab, release. Err is an
/// unusable release list (the TS threw).
async fn grab_best_under_cap(
    st: &AppState,
    item: &Value,
    folder: &Folder,
    title: &Value,
    sub: &str,
) -> Result<Capped, String> {
    let log = &st.arr.grabs;
    let base = Obj::new()
        .put("itemId", item)
        .opt("title", Some(title).filter(|t| !t.is_null()))
        .put("capGb", num(st.config.max_movie_gb))
        .put("sub", sub);
    log.record(RADARR, base.clone().put("type", "grab_started"))
        .await;
    tokio::time::sleep(st.arr.timings.settle).await;
    let search = st.arr.timings.search;
    let id = js_str(item);
    let res = fetch(
        st,
        Method::GET,
        &format!("/api/v3/release?movieId={id}"),
        &[],
        None,
        search,
    )
    .await
    .map_err(|_| "radarr is not configured".to_string())?;
    if !res.is_success() {
        let status = res.status.as_u16();
        tracing::error!(event = "movie-cap", status, movie_id = %id, "release search failed");
        log.record(
            RADARR,
            base.put("type", "search_failed").put("status", status),
        )
        .await;
        return Ok(Capped::SearchFailed(status));
    }
    let all: Value = serde_json::from_slice(&res.body).map_err(|e| e.to_string())?;
    let Value::Array(all) = all else {
        return Err("release list is not an array".into());
    };
    let ledger = &st.arr.radarr_ledger;
    let available = ledger.available_bytes(folder);
    let (cap, floor) = (max_movie_bytes(st), min_free(st));
    let accepted: Vec<&Value> = all.iter().filter(|r| arr_accepted(r)).collect();
    let eligible = by_quality(
        accepted
            .iter()
            .copied()
            .filter(|r| {
                let size = field_f64(r, "size");
                size <= cap && available - size >= floor
            })
            .collect(),
    );
    let Some(best) = eligible.first().copied() else {
        let (kind, out) = if all.is_empty() {
            ("no_releases", Capped::NoReleases(all.len()))
        } else if accepted.is_empty() {
            ("no_matching_releases", Capped::NoMatching(all.len()))
        } else {
            ("all_rejected_by_cap", Capped::AllRejectedByCap(all.len()))
        };
        tracing::info!(event = "movie-cap", movie_id = %id, scanned = all.len(), matched = accepted.len(), accepted = 0, cap_gb = st.config.max_movie_gb, "{kind}");
        log.record(
            RADARR,
            base.put("type", kind)
                .put("scanned", all.len())
                .put("eligible", 0),
        )
        .await;
        return Ok(out);
    };
    let size = field_f64(best, "size");
    // Reserve before the POST so a concurrent add sees the reduced headroom;
    // refuse rather than overcommit when another add took it meanwhile.
    if !ledger.reserve(folder, size) {
        log.record(
            RADARR,
            base.put("type", "all_rejected_by_cap")
                .put("scanned", all.len())
                .put("eligible", eligible.len())
                .put(
                    "error",
                    format!(
                        "planned movie grab would overcommit pending reservations for {}",
                        folder.path
                    ),
                ),
        )
        .await;
        return Ok(Capped::AllRejectedByCap(all.len()));
    }
    let grab = fetch(
        st,
        Method::POST,
        "/api/v3/release",
        &[],
        Some(&grab_body(best)),
        search,
    )
    .await;
    // Queued or failed, the bytes are no longer ours to hold.
    ledger.release(folder, size);
    let grab = grab.map_err(|_| "radarr is not configured".to_string())?;
    let kind = grab_event_type(&grab);
    tracing::info!(event = "movie-cap", title = %js_str(best.get("title").unwrap_or(&serde_json::Value::Null)), size_gb = gb_2dp(size), movie_id = %id, status = grab.status.as_u16(), "grab");
    let release = Obj::new()
        .opt("title", best.get("title"))
        .opt("sizeBytes", best.get("size"))
        .opt("qualityWeight", best.get("qualityWeight"));
    log.record(
        RADARR,
        base.put("type", kind)
            .put("status", grab.status.as_u16())
            .put("scanned", all.len())
            .put("eligible", eligible.len())
            .put("release", release),
    )
    .await;
    Ok(match kind {
        "grab_unconfirmed" => Capped::GrabUnconfirmed(all.len()),
        "grab_failed" => Capped::GrabFailed(grab.status.as_u16()),
        _ => Capped::Succeeded,
    })
}
