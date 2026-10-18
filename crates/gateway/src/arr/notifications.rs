//! /api/notifications/discord (routes/notifications.ts): admin-only setup of
//! one "Emerald Exchange Discord" connector on both Sonarr and Radarr, so
//! the household gets one channel ping on grabs, imports, upgrades and
//! manual-interaction requests (health and update chatter stays off).
//!
//! Every mutation starts from a fresh list: a failed list read is a hard
//! 502, never "none exists", or each retry during an outage would stack a
//! duplicate connector. A POST that fails partway undoes its earlier
//! mutations (newest first) and reports what could not be undone.
//!
//! The webhook URL is only handed to the *arrs, which make the outbound
//! call; this process never requests it, so the Discord host allowlist is
//! the whole guard. If this ever accepts generic hosts, or starts calling
//! the URL itself, it needs the SSRF guard first.

#![allow(clippy::result_large_err)]

use std::future::Future;

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};

use super::shared::{arr_get, call, err, internal, js_str, parse_body};
use crate::AppState;
use crate::upstream::{Arr, LAN_TIMEOUT, Reply};

const EMERALD: &str = "Emerald Exchange Discord";
const APPS: [Arr; 2] = [Arr::Sonarr, Arr::Radarr];
/// `{webhookUrl}`; Hono read it unbounded.
const BODY_LIMIT: usize = 64 * 1024;
const PARTIAL_DELETE: &str =
    "one or more upstream notification deletes failed; the connector may still be active";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/notifications/discord",
            get(status).post(configure).delete(remove),
        )
        .route("/api/notifications/discord/test", post(test))
}

/// The connector as Sonarr/Radarr's Discord schema takes it. The grab,
/// import and manual-interaction field lists 0..9 (overview through fanart)
/// give the richest card.
fn connector(webhook: &str, app: Arr) -> Value {
    let all: Vec<u8> = (0..10).collect();
    json!({
        "name": EMERALD,
        "onGrab": true,
        "onDownload": true,
        "onUpgrade": true,
        "onImportComplete": true,
        "onManualInteractionRequired": true,
        "onRename": false,
        "onSeriesAdd": false,
        "onSeriesDelete": false,
        "onEpisodeFileDelete": false,
        "onEpisodeFileDeleteForUpgrade": false,
        "onMovieAdded": false,
        "onMovieDelete": false,
        "onMovieFileDelete": false,
        "onMovieFileDeleteForUpgrade": false,
        "onHealthIssue": false,
        "onHealthRestored": false,
        "onApplicationUpdate": false,
        "includeHealthWarnings": false,
        "supportsOnGrab": true,
        "supportsOnDownload": true,
        "supportsOnUpgrade": true,
        "supportsOnManualInteractionRequired": true,
        "implementation": "Discord",
        "implementationName": "Discord",
        "configContract": "DiscordSettings",
        "tags": [],
        "fields": [
            { "name": "webHookUrl", "value": webhook },
            { "name": "username", "value": "Emerald Exchange" },
            { "name": "avatar", "value": "" },
            { "name": "author", "value": if app == Arr::Sonarr { "Sonarr" } else { "Radarr" } },
            { "name": "grabFields", "value": all },
            { "name": "importFields", "value": all },
            { "name": "manualInteractionFields", "value": all },
        ],
    })
}

fn bad_gateway(body: Value) -> Response {
    err(StatusCode::BAD_GATEWAY, body)
}

/// A refused list read: `{error: <app>_list_failed, status}`.
fn list_failed(app: Arr, status: u16) -> Value {
    json!({ "error": format!("{}_list_failed", app.as_str()), "status": status })
}

/// Our connectors on `app`. Ok(Err(status)) when the list was refused.
async fn emerald(st: &AppState, app: Arr) -> Result<Result<Vec<Value>, u16>, Response> {
    let r = arr_get(st, app, "/api/v3/notification", &[]).await?;
    if !r.is_success() {
        return Ok(Err(r.status.as_u16()));
    }
    let Some(Value::Array(list)) = parse_body(&r.body) else {
        return Err(internal("notification list is not a JSON array"));
    };
    Ok(Ok(list
        .into_iter()
        .filter(|n| {
            n.get("name").and_then(Value::as_str) == Some(EMERALD)
                && n.get("implementation").and_then(Value::as_str) == Some("Discord")
                && n.get("id").is_some_and(Value::is_number)
        })
        .collect()))
}

/// Both lists, read together; the first refusal (Sonarr's before Radarr's)
/// is Err.
async fn both(st: &AppState) -> Result<Result<[Vec<Value>; 2], Value>, Response> {
    let (s, r) = tokio::join!(emerald(st, Arr::Sonarr), emerald(st, Arr::Radarr));
    Ok(match (s?, r?) {
        (Err(status), _) => Err(list_failed(Arr::Sonarr, status)),
        (_, Err(status)) => Err(list_failed(Arr::Radarr, status)),
        (Ok(s), Ok(r)) => Ok([s, r]),
    })
}

fn id_of(n: &Value) -> Value {
    n.get("id").cloned().unwrap_or(Value::Null)
}

fn text(r: &Reply) -> String {
    let body = String::from_utf8_lossy(&r.body);
    auth::js_slice(&body, 400).to_string()
}

async fn send(
    st: &AppState,
    app: Arr,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Reply, Response> {
    call(st, app, method, path, &[], body, LAN_TIMEOUT).await
}

/// One serialized section on its own task: a client hang-up must not stop a
/// run of upstream mutations (or their rollback) halfway, and a DELETE
/// reading its ids while a POST creates would leave a connector the
/// operator was told was removed.
async fn locked<F>(st: &AppState, f: F) -> Response
where
    F: Future<Output = Response> + Send + 'static,
{
    let arr = st.arr.clone();
    let task = tokio::spawn(async move {
        let _lock = arr.discord.lock().await;
        f.await
    });
    task.await
        .unwrap_or_else(|_| internal("discord notification task failed"))
}

async fn status(State(st): State<AppState>, _: auth::RequireAdmin) -> Response {
    match both(&st).await {
        Err(res) => res,
        Ok(Err(body)) => bad_gateway(body),
        Ok(Ok([s, r])) => Json(json!({
            "sonarr": !s.is_empty(),
            "radarr": !r.is_empty(),
            "configured": !s.is_empty() && !r.is_empty(),
        }))
        .into_response(),
    }
}

async fn configure(State(st): State<AppState>, _: auth::RequireAdmin, body: Body) -> Response {
    let raw = match auth::json_body(body, BODY_LIMIT).await {
        Ok(v) => v,
        Err(res) => return res,
    };
    let url = raw
        .get("webhookUrl")
        .and_then(Value::as_str)
        .map(auth::js_trim)
        .filter(|u| !u.is_empty());
    let Some(url) = url else {
        return err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "webhookUrl_required" }),
        );
    };
    let discord = [
        "https://discord.com/api/webhooks/",
        "https://discordapp.com/api/webhooks/",
    ];
    if !discord.iter().any(|p| url.starts_with(p)) {
        return err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_discord_webhook" }),
        );
    }
    let url = url.to_string();
    let task_st = st.clone();
    locked(&st, async move {
        configure_locked(&task_st, &url)
            .await
            .unwrap_or_else(|res| res)
    })
    .await
}

/// A mutation that succeeded, kept for the rollback.
enum Done {
    Created(Arr, Value),
    Updated(Arr, Value, Value),
}

impl Done {
    fn json(&self) -> Value {
        match self {
            Done::Created(app, id) => json!({ "app": app.as_str(), "action": "create", "id": id }),
            Done::Updated(app, id, previous) => {
                json!({ "app": app.as_str(), "action": "update", "id": id, "previous": previous })
            }
        }
    }
}

fn done_json(done: &[Done]) -> Value {
    done.iter().map(Done::json).collect()
}

/// Undo `done` newest first: delete what was created, PUT back what was
/// updated. Returns what could not be undone.
async fn rollback(st: &AppState, done: &[Done]) -> Vec<Value> {
    let mut failures = vec![];
    for d in done.iter().rev() {
        let (app, id, previous) = match d {
            Done::Created(app, id) => (*app, id, None),
            Done::Updated(app, id, previous) => (*app, id, Some(previous)),
        };
        let path = format!("/api/v3/notification/{}", js_str(id));
        let method = if previous.is_some() {
            Method::PUT
        } else {
            Method::DELETE
        };
        let res = st
            .upstream
            .arr_fetch(&st.config, app, method, &path, &[], previous, LAN_TIMEOUT)
            .await;
        let (status, detail) = match res {
            Ok(r) if r.is_success() => continue,
            Ok(r) => (r.status.as_u16(), text(&r)),
            Err(e) => (0, e.to_string()),
        };
        failures.push(json!({ "app": app.as_str(), "id": id, "status": status, "detail": detail }));
    }
    failures
}

/// DELETE each id; the count removed and the refusals.
async fn delete_all(
    st: &AppState,
    app: Arr,
    ids: &[Value],
) -> Result<(usize, Vec<Value>), Response> {
    let (mut removed, mut failures) = (0, vec![]);
    for id in ids {
        let path = format!("/api/v3/notification/{}", js_str(id));
        let r = send(st, app, Method::DELETE, &path, None).await?;
        if r.is_success() {
            removed += 1;
        } else {
            failures.push(json!({ "app": app.as_str(), "id": id, "status": r.status.as_u16() }));
        }
    }
    Ok((removed, failures))
}

fn partial_delete(removed: usize, failures: Vec<Value>) -> Value {
    json!({
        "error": "partial_delete_failed",
        "removed": removed,
        "failures": failures,
        "message": PARTIAL_DELETE,
    })
}

/// Update the first connector in place (deleting extras) or create one, on
/// Sonarr then Radarr.
async fn configure_locked(st: &AppState, url: &str) -> Result<Response, Response> {
    let lists = match both(st).await? {
        Ok(lists) => lists,
        Err(mut body) => {
            body["message"] = "refusing to mutate notifications without a fresh list".into();
            return Ok(bad_gateway(body));
        }
    };
    let mut done: Vec<Done> = vec![];
    for (app, existing) in APPS.into_iter().zip(lists) {
        if let Some((previous, extras)) = existing.split_first() {
            let id = id_of(previous);
            let mut body = connector(url, app);
            body["id"] = id.clone();
            let path = format!("/api/v3/notification/{}", js_str(&id));
            let r = send(st, app, Method::PUT, &path, Some(&body)).await?;
            if !r.is_success() {
                let message = if done.is_empty() {
                    "existing connector was left unchanged; retry, or remove and re-add from the menu"
                } else {
                    "one or more earlier notification mutations succeeded before this update failed"
                };
                let cleanup = rollback(st, &done).await;
                return Ok(bad_gateway(json!({
                    "error": format!("{}_update_failed", app.as_str()),
                    "status": r.status.as_u16(),
                    "detail": text(&r),
                    "mutations": done_json(&done),
                    "cleanupFailures": cleanup,
                    "message": message,
                })));
            }
            done.push(Done::Updated(app, id, previous.clone()));
            let extras: Vec<Value> = extras.iter().map(id_of).collect();
            if !extras.is_empty() {
                let (removed, failures) = delete_all(st, app, &extras).await?;
                if !failures.is_empty() {
                    let mut body = partial_delete(removed, failures);
                    body["cleanupFailures"] = rollback(st, &done).await.into();
                    return Ok(bad_gateway(body));
                }
            }
            continue;
        }
        let r = send(
            st,
            app,
            Method::POST,
            "/api/v3/notification",
            Some(&connector(url, app)),
        )
        .await?;
        if !r.is_success() {
            let cleanup = rollback(st, &done).await;
            return Ok(bad_gateway(json!({
                "error": format!("{}_create_failed", app.as_str()),
                "status": r.status.as_u16(),
                "detail": text(&r),
                "mutations": done_json(&done),
                "cleanupFailures": cleanup,
            })));
        }
        // An ack without a numeric id: find the new connector by name.
        let id = match parse_body(&r.body)
            .and_then(|c| c.get("id").filter(|v| v.is_number()).cloned())
        {
            Some(id) => Some(id),
            None => match emerald(st, app).await {
                Ok(Ok(list)) => list.first().map(id_of),
                _ => None,
            },
        };
        if let Some(id) = id {
            done.push(Done::Created(app, id));
        }
    }
    Ok(Json(json!({ "ok": true, "configured": true })).into_response())
}

/// Remove our connectors from both apps; every delete is attempted before
/// answering, and any refusal is a 502 naming it.
async fn remove(State(st): State<AppState>, _: auth::RequireAdmin) -> Response {
    let task_st = st.clone();
    locked(&st, async move {
        remove_locked(&task_st).await.unwrap_or_else(|res| res)
    })
    .await
}

async fn remove_locked(st: &AppState) -> Result<Response, Response> {
    let lists = match both(st).await? {
        Ok(lists) => lists,
        Err(body) => return Ok(bad_gateway(body)),
    };
    let (mut removed, mut failures) = (0, vec![]);
    for (app, existing) in APPS.into_iter().zip(lists) {
        let ids: Vec<Value> = existing.iter().map(id_of).collect();
        let (n, f) = delete_all(st, app, &ids).await?;
        removed += n;
        failures.extend(f);
    }
    if !failures.is_empty() {
        return Ok(bad_gateway(partial_delete(removed, failures)));
    }
    Ok(Json(json!({ "ok": true, "removed": removed })).into_response())
}

/// Fire Sonarr's test embed at the configured webhook (the same payload a
/// real notification produces). Locked too: the id comes from a list read,
/// and a DELETE between the two would test a gone connector.
async fn test(State(st): State<AppState>, _: auth::RequireAdmin) -> Response {
    let task_st = st.clone();
    locked(&st, async move {
        test_locked(&task_st).await.unwrap_or_else(|res| res)
    })
    .await
}

async fn test_locked(st: &AppState) -> Result<Response, Response> {
    let list = match emerald(st, Arr::Sonarr).await? {
        Ok(list) => list,
        Err(status) => return Ok(bad_gateway(list_failed(Arr::Sonarr, status))),
    };
    let Some(first) = list.first() else {
        return Ok(err(
            StatusCode::CONFLICT,
            json!({ "error": "not_configured" }),
        ));
    };
    let path = format!("/api/v3/notification/{}/test", js_str(&id_of(first)));
    let r = send(st, Arr::Sonarr, Method::POST, &path, Some(&json!({}))).await?;
    if !r.is_success() {
        return Ok(bad_gateway(json!({
            "error": "test_failed",
            "status": r.status.as_u16(),
            "detail": text(&r),
        })));
    }
    Ok(Json(json!({ "ok": true })).into_response())
}

#[cfg(test)]
mod tests;
