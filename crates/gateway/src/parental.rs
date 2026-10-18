//! Grant-time rating enforcement (services/parentalRating.ts): the server
//! half of parental controls. A capped, non-admin caller gets no playback
//! grant, stream, subtitles or chapters for a title above the cap, even with
//! a hand-made request.
//!
//! The certification is resolved per request: media.db (read-only, opened
//! per call) gives the title's TMDB/TVDB id, Radarr/Sonarr give its
//! certification. Both lists are cached for 10 minutes, and a failed refresh
//! serves the stale copy. Fail closed: under a cap an unrated, unknown or
//! unresolvable title is blocked. Admins are never blocked; music has no
//! certification and is exempt; a YouTube video is an unrated catalog and is
//! blocked under any cap.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::http::Method;
use serde_json::Value;
use sqlx::ConnectOptions;
use sqlx::sqlite::SqliteConnectOptions;

use crate::AppState;
use crate::stores::effective_cap;
use crate::upstream::{Arr, LAN_TIMEOUT};

const CERT_TTL: Duration = Duration::from_secs(10 * 60);

/// One 0-4 scale for the movie and TV ladders (the Swift ParentalGate's).
fn severity(rating: &str) -> Option<u8> {
    Some(match auth::js_trim(rating).to_uppercase().as_str() {
        "G" | "TV-Y" | "TV-G" => 0,
        "PG" | "TV-Y7" | "TV-PG" => 1,
        "PG-13" | "TV-14" => 2,
        "R" | "TV-MA" => 3,
        "NC-17" => 4,
        _ => return None,
    })
}

/// No cap allows all; under a cap anything off the scale is blocked. A cap
/// off the scale cannot be enforced and allows (the policy PUT refuses one).
pub fn rating_allowed(certification: Option<&str>, cap: Option<&str>) -> bool {
    let Some(cap) = cap else { return true };
    let Some(cap) = severity(cap) else {
        return true;
    };
    severity(certification.unwrap_or_default()).is_some_and(|s| s <= cap)
}

type CertMap = HashMap<i64, Option<String>>;

/// The Radarr and Sonarr certification maps, by TMDB and TVDB id.
#[derive(Default)]
pub struct Certs {
    radarr: tokio::sync::Mutex<Option<(Instant, CertMap)>>,
    sonarr: tokio::sync::Mutex<Option<(Instant, CertMap)>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Title {
    Movie,
    Episode,
    Track,
    Video,
}

impl Title {
    pub fn parse(kind: &str) -> Option<Title> {
        Some(match kind {
            "movie" => Title::Movie,
            "episode" => Title::Episode,
            "track" => Title::Track,
            "video" => Title::Video,
            _ => return None,
        })
    }
}

/// True when the caller's cap forbids this media-core title. `id` is the
/// path segment as `Number()` reads it.
pub async fn rating_blocked(
    st: &AppState,
    session: &auth::session::Session,
    kind: Title,
    id: f64,
) -> Result<bool, crate::stores::StoreError> {
    if session.role == auth::Role::Admin || kind == Title::Track {
        return Ok(false);
    }
    let policy = st.stores.policies.policy(&session.sub).await?;
    let Some(cap) = effective_cap(&policy) else {
        return Ok(false);
    };
    if kind == Title::Video {
        return Ok(true);
    }
    Ok(match certification(st, kind, id).await {
        Ok(cert) => !rating_allowed(cert.as_deref(), Some(cap)),
        Err(e) => {
            tracing::warn!(event = "parental", error = %e, "certification unresolved; blocking");
            true
        }
    })
}

/// The library certification for a movie or episode, None when unknown.
async fn certification(st: &AppState, kind: Title, id: f64) -> Result<Option<String>, String> {
    let (sql, svc, path, key) = if kind == Title::Movie {
        (
            "SELECT tmdb_id FROM movies WHERE id = ?",
            Arr::Radarr,
            "/api/v3/movie",
            "tmdbId",
        )
    } else {
        (
            "SELECT s.tvdb_id FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.id = ?",
            Arr::Sonarr,
            "/api/v3/series",
            "tvdbId",
        )
    };
    let Some(ext_id) = media_identity(&st.config.media_db_path, sql, id).await? else {
        return Ok(None);
    };
    let cache = match svc {
        Arr::Radarr => &st.certs.radarr,
        Arr::Sonarr => &st.certs.sonarr,
    };
    let mut cached = cache.lock().await;
    if let Some((at, map)) = cached.as_ref()
        && at.elapsed() < CERT_TTL
    {
        return Ok(map.get(&ext_id).cloned().flatten());
    }
    match fetch_certs(st, svc, path, key).await {
        Ok(map) => {
            let cert = map.get(&ext_id).cloned().flatten();
            *cached = Some((Instant::now(), map));
            Ok(cert)
        }
        // Stale beats failing every grant on a blipped upstream.
        Err(e) => match cached.as_ref() {
            Some((_, map)) => Ok(map.get(&ext_id).cloned().flatten()),
            None => Err(e),
        },
    }
}

async fn fetch_certs(st: &AppState, svc: Arr, path: &str, key: &str) -> Result<CertMap, String> {
    let reply = st
        .upstream
        .arr_fetch(&st.config, svc, Method::GET, path, &[], None, LAN_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    if !reply.is_success() {
        return Err(format!("arr list {}", reply.status.as_u16()));
    }
    let rows: Value = serde_json::from_slice(&reply.body).map_err(|e| e.to_string())?;
    let rows = rows.as_array().ok_or("arr list is not an array")?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = row.get(key)?.as_f64().filter(|f| f.fract() == 0.0)?;
            let cert = row
                .get("certification")
                .and_then(Value::as_str)
                .map(String::from);
            Some((id as i64, cert))
        })
        .collect())
}

/// media.db's external id for `id`, opened read-only per call (media-core
/// owns the file). A missing file or failed query is an error.
async fn media_identity(path: &str, sql: &'static str, id: f64) -> Result<Option<i64>, String> {
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await
        .map_err(|e| format!("open media.db: {e}"))?;
    // NaN binds as NULL in SQLite: no row.
    let row = if id.is_finite() {
        sqlx::query_scalar::<_, Option<i64>>(sql)
            .bind(id)
            .fetch_optional(&mut conn)
            .await
            .map_err(|e| e.to_string())?
    } else {
        None
    };
    let _ = sqlx::Connection::close(conn).await;
    Ok(row.flatten())
}

#[cfg(test)]
mod tests;
