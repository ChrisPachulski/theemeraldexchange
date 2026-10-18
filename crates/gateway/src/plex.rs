//! Plex in the gateway (routes/plex-links.ts, plex-admin.ts, users.ts): the
//! "Play in Plex" library links and the server id for any signed-in member,
//! the PMS remote-access diagnostic and the Users tab for admins. Each calls
//! Plex as the caller, with the session cookie's plex.tv token; a Bearer
//! (device) request and a non-Plex cookie carry none and get 409
//! no_plex_token. Nothing here runs unless someone signed in with Plex.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use auth::plex::{FriendStatus, PlexError, PlexFriend};
use auth::{RequireAdmin, RequireAuth, Role};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::future::join_all;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::suggestions::SingleFlight;
use crate::upstream::LAN_TIMEOUT;

/// How long a member's link map is served before it is rebuilt.
const LINKS_TTL: Duration = Duration::from_secs(5 * 60);
/// Every PMS fetch the link resolver makes: a hung PMS must fail the shared
/// build, or every later caller would join a build that never ends.
const LINKS_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/plex/library-links", get(library_links))
        .route("/api/plex/server-id", get(server_id))
        .route("/api/plex/remote-access", get(remote_access))
        .route("/api/users", get(users))
}

fn no_plex_token() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": "no_plex_token" })),
    )
        .into_response()
}

/// 502 `{error, detail}`, in the TS key order.
fn bad_gateway(error: &'static str, detail: String) -> Response {
    #[derive(Serialize)]
    struct Body {
        error: &'static str,
        detail: String,
    }
    (StatusCode::BAD_GATEWAY, Json(Body { error, detail })).into_response()
}

// ── /api/plex/library-links ──

/// External id -> Plex ratingKey, per id system.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindMap {
    by_tmdb: Map<String, Value>,
    by_tvdb: Map<String, Value>,
    by_imdb: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct LinkMap {
    movie: KindMap,
    tv: KindMap,
}

/// Per sub, not process-wide: Plex Home profiles and managed users can see
/// different libraries, so one member's map must never answer another.
#[derive(Default)]
pub struct Links {
    cache: Mutex<HashMap<String, (Instant, Arc<LinkMap>)>>,
    flights: SingleFlight<String, Result<Arc<LinkMap>, String>>,
}

/// GET /api/plex/library-links: tmdb/tvdb/imdb ids -> ratingKeys for every
/// movie and show the caller can see in Plex, so the SPA can deep-link a
/// card into Plex web. Indexed by all three id systems because the legacy
/// TVDB agent emits only tvdb:// GUIDs.
async fn library_links(State(st): State<AppState>, RequireAuth(p): RequireAuth) -> Response {
    let Some(token) = p.session.plex_auth_token else {
        return no_plex_token();
    };
    match link_map(&st, &p.session.sub, &token).await {
        Ok(map) => Json(&*map).into_response(),
        Err(detail) => {
            tracing::error!(event = "plex_links", err = %detail, "resolver failed");
            bad_gateway("plex_unreachable", detail)
        }
    }
}

/// The cached map, else one build shared by every concurrent caller with
/// the same sub. A failed build is not cached, so the next request retries.
async fn link_map(st: &AppState, sub: &str, token: &str) -> Result<Arc<LinkMap>, String> {
    if let Some((at, map)) = st.plex_links.cache.lock().unwrap().get(sub)
        && at.elapsed() < LINKS_TTL
    {
        return Ok(map.clone());
    }
    let (st2, sub2, token) = (st.clone(), sub.to_string(), token.to_string());
    st.plex_links
        .flights
        .run(sub.to_string(), move || async move {
            let map = Arc::new(build_map(&st2, &token).await?);
            st2.plex_links
                .cache
                .lock()
                .unwrap()
                .insert(sub2, (Instant::now(), map.clone()));
            Ok(map)
        })
        .await
}

/// One PMS JSON read. The error text is what TS's `String(e)` showed.
async fn pms_json(st: &AppState, path: &str, token: &str) -> Result<Value, String> {
    let req = st
        .auth
        .plex
        .pms_get(&st.config.auth, path, token, "application/json");
    let reply = st
        .upstream
        .fetch(req, LINKS_FETCH_TIMEOUT, "plex-links")
        .await;
    if !reply.is_success() {
        let body: String = String::from_utf8_lossy(&reply.body)
            .chars()
            .take(200)
            .collect();
        return Err(format!("Error: plex {}: {body}", reply.status.as_u16()));
    }
    serde_json::from_slice(&reply.body).map_err(|e| format!("SyntaxError: {e}"))
}

async fn build_map(st: &AppState, token: &str) -> Result<LinkMap, String> {
    let sections = pms_json(st, "/library/sections", token).await?;
    let container = sections
        .get("MediaContainer")
        .filter(|c| !c.is_null())
        .ok_or("TypeError: no MediaContainer in /library/sections")?;
    let dirs = match container.get("Directory") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(_) => return Err("TypeError: Directory is not an array".into()),
    };
    // A key that is neither a string nor a number names no section TS could
    // walk (it fetched /sections/undefined/all and counted it empty).
    let keys = |kind: &str| -> Vec<String> {
        dirs.iter()
            .filter(|d| d.get("type").and_then(Value::as_str) == Some(kind))
            .filter_map(|d| match d.get("key")? {
                Value::String(k) => Some(k.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect()
    };
    let mut map = LinkMap::default();
    for (kind, out) in [("movie", &mut map.movie), ("show", &mut map.tv)] {
        // A section that fails or answers junk counts as empty.
        let walks = keys(kind).into_iter().map(|key| async move {
            let path = format!("/library/sections/{key}/all?includeGuids=1");
            pms_json(st, &path, token).await.unwrap_or(Value::Null)
        });
        for body in join_all(walks).await {
            let items = body.pointer("/MediaContainer/Metadata");
            for item in items.and_then(Value::as_array).into_iter().flatten() {
                index_item(out, item);
            }
        }
    }
    Ok(map)
}

/// Every tmdb://, tvdb:// and imdb:// GUID of `item`, query suffix
/// (`?lang=en`) stripped, pointing at its ratingKey. A later item with the
/// same id wins; one without a ratingKey drops the entry, as TS's
/// `map[id] = undefined` did once serialized.
fn index_item(out: &mut KindMap, item: &Value) {
    let guids = item.get("Guid").and_then(Value::as_array);
    let mut ids: [Option<&str>; 3] = [None; 3];
    for id in guids
        .into_iter()
        .flatten()
        .filter_map(|g| g.get("id")?.as_str())
    {
        for (slot, scheme) in ids.iter_mut().zip(["tmdb://", "tvdb://", "imdb://"]) {
            if let Some(rest) = id.strip_prefix(scheme) {
                *slot = Some(rest.split('?').next().unwrap_or_default());
            }
        }
    }
    let targets = [&mut out.by_tmdb, &mut out.by_tvdb, &mut out.by_imdb];
    for (id, target) in ids.into_iter().zip(targets) {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            continue;
        };
        match item.get("ratingKey") {
            Some(key) => target.insert(id.to_string(), key.clone()),
            None => target.remove(id),
        };
    }
}

/// GET /api/plex/server-id: PLEX_SERVER_ID, or null.
async fn server_id(State(st): State<AppState>, _auth: RequireAuth) -> Response {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
        server_id: Option<&'a str>,
    }
    Json(Body {
        server_id: st.config.auth.plex_server_id.as_deref(),
    })
    .into_response()
}

// ── /api/plex/remote-access ──

/// A `<Setting id="key" ... value="...">` value from the PMS prefs XML.
fn pref(xml: &str, key: &str) -> Option<String> {
    let re = Regex::new(&format!(r#"id="{key}"[^/]*?value="([^"]*)""#)).expect("pref regex");
    re.captures(xml).map(|m| m[1].to_string())
}

/// GET /api/plex/remote-access (admin): whether the PMS is reachable from
/// outside the LAN, read from its /:/prefs with the admin's token. Only the
/// connection-relevant keys, and never the public IP or customConnections
/// values (the owner's home address), only whether they are set.
async fn remote_access(State(st): State<AppState>, RequireAdmin(p): RequireAdmin) -> Response {
    let Some(token) = p.session.plex_auth_token.as_deref() else {
        return no_plex_token();
    };
    let req = st
        .auth
        .plex
        .pms_get(&st.config.auth, "/:/prefs", token, "application/xml");
    let reply = st
        .upstream
        .fetch(req, LAN_TIMEOUT, "plex.remoteAccess")
        .await;
    if !reply.is_success() {
        #[derive(Serialize)]
        struct Failed {
            error: &'static str,
            status: u16,
            body: String,
        }
        let body = String::from_utf8_lossy(&reply.body)
            .chars()
            .take(400)
            .collect();
        let failed = Failed {
            error: "prefs_failed",
            status: reply.status.as_u16(),
            body,
        };
        return (StatusCode::BAD_GATEWAY, Json(failed)).into_response();
    }
    let xml = String::from_utf8_lossy(&reply.body);
    let get = |k: &str| pref(&xml, k);
    let set = |v: &Option<String>| v.as_deref().is_some_and(|v| !v.is_empty());

    let publish = get("PublishServerOnPlexOnlineKey").as_deref() == Some("1");
    let manual_port_mode = get("ManualPortMappingMode").as_deref() == Some("1");
    let manual_port = get("ManualPortMappingPort");
    let public_port = get("PublicPort");
    let public_address = get("PublicAddress");
    let allowed_networks = get("allowedNetworks").filter(|v| !v.is_empty());

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Summary {
        remote_access_enabled: bool,
        manual_port_mapping_enabled: bool,
        manual_port: Option<String>,
        public_address_detected: bool,
        detected_public_port: Option<String>,
        has_custom_connections: bool,
        /// 0 disabled, 1 preferred, 2 required.
        secure_connections_mode: Option<String>,
        has_certificate: bool,
        wan_upload_cap_bytes: Option<String>,
        allowed_networks: Option<String>,
        lan_networks_bandwidth: Option<String>,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Interpretation {
        remote_access: &'static str,
        port_mapping: String,
        public_reachability: String,
    }
    #[derive(Serialize)]
    struct Body {
        summary: Summary,
        interpretation: Interpretation,
    }

    let interpretation = Interpretation {
        remote_access: if publish {
            "Server is advertising itself to plex.tv as remotely accessible."
        } else {
            "Server is NOT advertising to plex.tv. Settings \u{2192} Remote Access in Plex web UI is the toggle."
        },
        port_mapping: if manual_port_mode {
            format!(
                "Plex is asking your router to forward TCP {} to the Plex server on the LAN. Router must be configured to honor this.",
                manual_port.as_deref().unwrap_or("?")
            )
        } else {
            "Plex is using UPnP to auto-map the port. If your router has UPnP disabled or broken (common on UGREEN/ISP routers), this will silently fail. Switch to manual.".into()
        },
        public_reachability: if set(&public_address) {
            let port = public_port
                .as_deref()
                .filter(|p| !p.is_empty())
                .map(|p| format!(" on port {p}"))
                .unwrap_or_default();
            format!(
                "Plex has detected a public address{port}. The literal IP is intentionally not returned here; read it in Plex's own web UI if you need it. If reachability is wrong (e.g. your ISP rotated the IP), hit Retry there."
            )
        } else {
            "Plex has not detected a public address \u{2014} strong signal that remote access is broken end-to-end.".into()
        },
    };
    Json(Body {
        summary: Summary {
            remote_access_enabled: publish,
            manual_port_mapping_enabled: manual_port_mode,
            manual_port,
            public_address_detected: set(&public_address),
            detected_public_port: public_port,
            has_custom_connections: set(&get("customConnections")),
            secure_connections_mode: get("secureConnections"),
            has_certificate: set(&get("certificateUUID")),
            wan_upload_cap_bytes: get("WanPerStreamMaxUploadRate"),
            allowed_networks,
            lan_networks_bandwidth: get("lanNetworksBandwidth"),
        },
        interpretation,
    })
    .into_response()
}

// ── /api/users ──

#[derive(Serialize)]
struct UserRow {
    id: i64,
    username: String,
    title: String,
    email: Option<String>,
    thumb: Option<String>,
    role: Role,
    relation: &'static str,
    status: FriendStatus,
}

/// GET /api/users (admin): who can reach the server through Plex. The
/// admin's own account first as the owner, then every share recipient
/// merged from accepted (legacy XML), server shares, Plex Home, the PMS's
/// own accounts (catches revoked shares) and pending invites, in that order.
/// The owner and accepted lists are required; the rest are best effort.
async fn users(State(st): State<AppState>, RequireAdmin(p): RequireAdmin) -> Response {
    let Some(token) = p.session.plex_auth_token.as_deref() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "no_plex_token",
                "message": "Re-authenticate to refresh your Plex token.",
            })),
        )
            .into_response();
    };
    let (plex, cfg) = (&st.auth.plex, &st.config.auth);
    let best_effort = |label: &'static str, r: Result<Vec<PlexFriend>, PlexError>| {
        r.unwrap_or_else(|err| {
            tracing::warn!(event = "users", %err, "{label} failed, omitting");
            Vec::new()
        })
    };
    let (me, accepted, shared, home, local, pending) = tokio::join!(
        plex.get_user(cfg, token),
        plex.list_accepted_users(cfg, token),
        plex.list_shared_server_invitees(cfg, token),
        plex.list_home_users(cfg, token),
        plex.list_local_server_accounts(cfg, token),
        plex.list_pending_invites(cfg, token),
    );
    let (me, accepted) = match (me, accepted) {
        (Ok(me), Ok(accepted)) => (me, accepted),
        (Err(PlexError::NotConfigured), _) | (_, Err(PlexError::NotConfigured)) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "plex_not_configured" })),
            )
                .into_response();
        }
        (Err(e), _) | (_, Err(e)) => {
            return bad_gateway("plex_lookup_failed", format!("Error: {e}"));
        }
    };
    let friends = merge_friends(
        &me,
        [
            accepted,
            best_effort("listSharedServerInvitees", shared),
            best_effort("listHomeUsers", home),
            best_effort("listLocalServerAccounts", local),
            best_effort("listPendingInvites", pending),
        ],
    );

    let role = |id: i64| {
        let (pool, admins) = (&st.auth.pool, &st.config.auth.admin_subs);
        async move { auth::effective_role(pool, admins, &format!("plex:{id}")).await }
    };
    let mut rows = Vec::with_capacity(friends.len() + 1);
    let owner_role = match role(me.id).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };
    rows.push(UserRow {
        id: me.id,
        username: me.username.clone(),
        title: me.username,
        email: me.email,
        thumb: me.thumb,
        role: owner_role,
        relation: "owner",
        status: FriendStatus::Accepted,
    });
    for u in friends {
        let role = match role(u.id).await {
            Ok(r) => r,
            Err(e) => return e.into_response(),
        };
        rows.push(UserRow {
            id: u.id,
            title: u.title.unwrap_or_else(|| u.username.clone()),
            username: u.username,
            email: u.email,
            thumb: u.thumb,
            role,
            relation: "friend",
            status: u.status,
        });
    }
    #[derive(Serialize)]
    struct Body {
        users: Vec<UserRow>,
    }
    Json(Body { users: rows }).into_response()
}

/// The friend lists merged in order, the owner left out (Plex Home lists
/// the owner under another id, so username and email match it too). Rows
/// dedupe by id, email or username (lowercased); an earlier row keeps its
/// fields and is only upgraded from pending to accepted.
fn merge_friends<const N: usize>(
    me: &auth::plex::PlexUser,
    lists: [Vec<PlexFriend>; N],
) -> Vec<PlexFriend> {
    let me_username = me.username.to_lowercase();
    let me_email = me.email.as_deref().unwrap_or_default().to_lowercase();
    let is_owner = |u: &PlexFriend| {
        u.id == me.id
            || u.username.to_lowercase() == me_username
            || (!me_email.is_empty()
                && u.email.as_deref().unwrap_or_default().to_lowercase() == me_email)
    };
    let keys_for = |u: &PlexFriend| {
        let mut keys = Vec::new();
        if u.id > 0 {
            keys.push(format!("id:{}", u.id));
        }
        let email = u.email.as_deref().map(|e| auth::js_trim(e).to_lowercase());
        if let Some(email) = email.filter(|e| !e.is_empty()) {
            keys.push(format!("e:{email}"));
        }
        let username = auth::js_trim(&u.username).to_lowercase();
        if !username.is_empty() {
            keys.push(format!("u:{username}"));
        }
        keys
    };
    let mut rows: Vec<PlexFriend> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for u in lists.into_iter().flatten() {
        if is_owner(&u) || (u.username.is_empty() && u.title.as_deref().is_none_or(str::is_empty)) {
            continue;
        }
        let keys = keys_for(&u);
        match keys.iter().find_map(|k| index.get(k).copied()) {
            None => {
                for k in keys {
                    index.insert(k, rows.len());
                }
                rows.push(u);
            }
            Some(i) => {
                let old = &rows[i];
                let merged = PlexFriend {
                    id: if old.id > 0 { old.id } else { u.id },
                    username: if old.username.is_empty() {
                        u.username.clone()
                    } else {
                        old.username.clone()
                    },
                    title: old
                        .title
                        .clone()
                        .filter(|t| !t.is_empty())
                        .or_else(|| u.title.clone()),
                    email: old.email.clone().or_else(|| u.email.clone()),
                    thumb: old.thumb.clone().or_else(|| u.thumb.clone()),
                    status: if old.status == FriendStatus::Accepted
                        || u.status == FriendStatus::Accepted
                    {
                        FriendStatus::Accepted
                    } else {
                        FriendStatus::Pending
                    },
                };
                for k in keys_for(&merged).into_iter().chain(keys) {
                    index.insert(k, i);
                }
                rows[i] = merged;
            }
        }
    }
    rows
}

#[cfg(test)]
mod tests;
