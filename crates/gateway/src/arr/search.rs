//! Discover search (GET /series/lookup, /movie/lookup), ranked the way Plex
//! and Jellyfin rank: titles already in the library first, then the *arr's
//! own lookup. The lookup alone stops at about 20 rows in metadata order, so
//! owned titles fell below junk or off the list ("scooby doo" showed 3 of the
//! 9 Scooby-Doo movies on disk), and its posterless stubs led the grid.
//! Matching is by words, so punctuation never decides a hit: "scooby doo"
//! finds "Scooby-Doo!", "spiderman" finds "Spider-Man".

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::http::{Method, Uri};
use axum::response::IntoResponse;
use serde_json::Value;

use super::shared::{Res, arr_get, call, pairs_ref, query_pairs, relay_reply};
use crate::AppState;
use crate::upstream::{Arr, LAN_TIMEOUT};

/// A new library title shows up in the owned section within this long; the
/// *arr's own lookup still lists it meanwhile.
const LIBRARY_TTL: Duration = Duration::from_secs(5 * 60);
/// ponytail: a one-letter search would otherwise return most of the library.
const MAX_OWNED: usize = 50;

type Rows = Arc<Vec<Value>>;

/// The Sonarr and Radarr library lists, each fetched at most once per TTL.
#[derive(Default)]
pub struct Libraries {
    sonarr: tokio::sync::Mutex<Option<(Instant, Rows)>>,
    radarr: tokio::sync::Mutex<Option<(Instant, Rows)>>,
}

pub async fn lookup(st: &AppState, svc: Arr, uri: &Uri) -> Res {
    let (path, list, key) = match svc {
        Arr::Sonarr => ("/api/v3/series/lookup", "/api/v3/series", "tvdbId"),
        Arr::Radarr => ("/api/v3/movie/lookup", "/api/v3/movie", "tmdbId"),
    };
    let pairs = query_pairs(uri);
    // The last `term` is the one the *arr reads.
    let term = pairs
        .iter()
        .rev()
        .find(|(k, _)| k == "term")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    let query = pairs_ref(&pairs);
    let found = call(st, svc, Method::GET, path, &query, None, LAN_TIMEOUT);
    // An id term (tvdb:N, tmdb:N, imdb:tt...) names one title: nothing to rank.
    if is_id_term(term) {
        return Ok(relay_reply(found.await?));
    }
    let (found, library) = tokio::join!(found, library(st, svc, list));
    let found = found?;
    let rows = match serde_json::from_slice::<Vec<Value>>(&found.body) {
        Ok(rows) if found.is_success() => rows,
        _ => return Ok(relay_reply(found)),
    };
    Ok(Json(rank(term, rows, &library, key)).into_response())
}

fn is_id_term(term: &str) -> bool {
    term.split_once(':')
        .is_some_and(|(p, _)| matches!(p.trim().to_lowercase().as_str(), "tvdb" | "tmdb" | "imdb"))
}

/// The cached list, else a fresh one; a failed fetch serves the stale copy,
/// or none, and the search still answers with the lookup alone.
async fn library(st: &AppState, svc: Arr, path: &str) -> Rows {
    let slot = match svc {
        Arr::Sonarr => &st.arr.libraries.sonarr,
        Arr::Radarr => &st.arr.libraries.radarr,
    };
    let mut cached = slot.lock().await;
    if let Some((at, rows)) = cached.as_ref()
        && at.elapsed() < LIBRARY_TTL
    {
        return rows.clone();
    }
    let fresh = match arr_get(st, svc, path, &[]).await {
        Ok(r) if r.is_success() => serde_json::from_slice::<Vec<Value>>(&r.body).ok(),
        Ok(r) => {
            tracing::warn!(
                svc = svc.as_str(),
                status = r.status.as_u16(),
                "library list for search failed"
            );
            None
        }
        Err(e) => {
            tracing::warn!(svc = svc.as_str(), error = %e, "library list for search failed");
            None
        }
    };
    match fresh {
        Some(rows) => {
            let rows = Arc::new(rows);
            *cached = Some((Instant::now(), rows.clone()));
            rows
        }
        None => cached
            .as_ref()
            .map(|(_, rows)| rows.clone())
            .unwrap_or_default(),
    }
}

/// Owned matches (best match first), then the lookup's other owned rows,
/// then its remaining rows with matches ahead of near-misses. A row with no
/// poster that is not owned is dropped: it is a metadata stub.
fn rank(term: &str, found: Vec<Value>, library: &[Value], key: &str) -> Vec<Value> {
    let q = words(term);
    if q.is_empty() {
        return found;
    }
    let id = |v: &Value| v.get(key).and_then(Value::as_i64).filter(|n| *n > 0);
    let mut owned: Vec<(u8, i64, &Value)> = library
        .iter()
        .filter_map(|v| {
            Some((
                score(&q, v)?,
                v.get("year").and_then(Value::as_i64).unwrap_or(0),
                v,
            ))
        })
        .collect();
    owned.sort_by_key(|(s, year, _)| (*s, *year));
    owned.truncate(MAX_OWNED);
    let mut seen: HashSet<i64> = owned.iter().filter_map(|(_, _, v)| id(v)).collect();
    let in_library: HashSet<i64> = library.iter().filter_map(id).collect();
    let mut out: Vec<Value> = owned.into_iter().map(|(_, _, v)| v.clone()).collect();
    let mut rest: Vec<(u8, Value)> = Vec::new();
    for v in found {
        let vid = id(&v);
        if vid.is_some_and(|n| !seen.insert(n)) {
            continue;
        }
        if vid.is_some_and(|n| in_library.contains(&n)) {
            out.push(v);
        } else if has_poster(&v) {
            rest.push((score(&q, &v).unwrap_or(3), v));
        }
    }
    rest.sort_by_key(|(s, _)| *s);
    out.extend(rest.into_iter().map(|(_, v)| v));
    out
}

/// Lowercase alphanumeric words; apostrophes join ("What's" is "whats").
fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .replace(['\'', '\u{2019}'], "")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// 0 the title is the query, 1 it starts with it, 2 it holds every query
/// word as a word prefix, or holds the query run together ("scoobydoo",
/// "spiderman"); None no match. The best of title, original and alternate
/// titles counts.
fn score(q: &[String], v: &Value) -> Option<u8> {
    let alternates = v
        .get("alternateTitles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    [v.get("title"), v.get("originalTitle")]
        .into_iter()
        .flatten()
        .chain(alternates.filter_map(|a| a.get("title")))
        .filter_map(Value::as_str)
        .filter_map(|t| {
            let t = words(t);
            if t == q {
                Some(0)
            } else if t.starts_with(q) {
                Some(1)
            } else if q
                .iter()
                .all(|w| t.iter().any(|x| x.starts_with(w.as_str())))
                || t.concat().contains(&q.concat())
            {
                Some(2)
            } else {
                None
            }
        })
        .min()
}

fn has_poster(v: &Value) -> bool {
    v.get("remotePoster")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
        || v.get("images")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|i| i.get("coverType").and_then(Value::as_str) == Some("poster"))
}

#[cfg(test)]
mod tests;
