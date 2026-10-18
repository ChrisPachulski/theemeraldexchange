//! The `available_on` tags (services/iptvAvailability.ts, localAvailability.ts,
//! mediaLibraryDb*.ts). Both are decorations: a failed or slow lookup leaves
//! the items untagged, and an item can carry both 'iptv' and 'local'.

use std::collections::HashSet;
use std::time::Duration;

use axum::http::header;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use super::{Item, normalize_title};
use crate::AppState;
use crate::stores::Kind;

/// A suggestions response never waits long on a decoration.
const IPTV_TIMEOUT: Duration = Duration::from_secs(2);

fn tag(items: Vec<Item>, hit: impl Fn(usize, &Item) -> bool, label: &str) -> Vec<Item> {
    items
        .into_iter()
        .enumerate()
        .map(|(i, mut it)| {
            if hit(i, &it) {
                let on = it.available_on.get_or_insert_with(Vec::new);
                if !on.iter().any(|s| s == label) {
                    on.push(label.to_string());
                }
            }
            it
        })
        .collect()
}

fn unique_ids(items: &[Item]) -> Vec<i64> {
    let mut seen = HashSet::new();
    items
        .iter()
        .map(|it| it.id)
        .filter(|id| seen.insert(*id))
        .collect()
}

/// 'iptv' on items whose TMDB id a live catalog title links to, asked of the
/// iptv service (POST /internal/availability under an admin principal for
/// `sub`).
pub async fn tag_iptv(st: &AppState, items: Vec<Item>, sub: &str) -> Vec<Item> {
    let ids = unique_ids(&items);
    if ids.is_empty() || st.config.auth.iptv_disabled {
        return items;
    }
    let linked = match linked_ids(st, sub, &ids).await {
        Ok(linked) => linked,
        Err(e) => {
            tracing::warn!(event = "suggestions", error = %e, "iptv availability lookup failed");
            return items;
        }
    };
    if linked.is_empty() {
        return items;
    }
    tag(items, |_, it| linked.contains(&it.id), "iptv")
}

async fn linked_ids(st: &AppState, sub: &str, ids: &[i64]) -> Result<HashSet<i64>, String> {
    let mut req = st
        .upstream
        .client()
        .post(format!(
            "{}/internal/availability",
            st.config.auth.iptv_service_url
        ))
        .header(header::CONTENT_TYPE, "application/json")
        .body(json!({ "tmdb_ids": ids }).to_string());
    let secret = st.config.auth.internal_principal_secret.as_deref();
    if secret.is_some()
        && let Some(server_id) = crate::recommender::server_id(st).await
    {
        let caller = crate::principal::Caller {
            sub,
            role: "admin",
            auth_mode: sub.split(':').next().unwrap_or_default(),
            device_id: None,
        };
        let token =
            crate::principal::mint(secret, &caller, &server_id, None).map_err(|e| e.to_string())?;
        req = req.bearer_auth(token);
    }
    let call = async {
        let res = req.send().await.map_err(|e| e.without_url().to_string())?;
        // No path in the message: logs never carry the member sub.
        if !res.status().is_success() {
            return Err(format!(
                "iptv internal POST answered {}",
                res.status().as_u16()
            ));
        }
        res.json::<Value>()
            .await
            .map_err(|e| e.without_url().to_string())
    };
    let body = tokio::time::timeout(IPTV_TIMEOUT, call)
        .await
        .map_err(|_| "The operation was aborted due to timeout".to_string())??;
    Ok(body["tmdb_ids"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_f64)
                .filter(|f| f.fract() == 0.0)
                .map(|f| f as i64)
                .collect()
        })
        .unwrap_or_default())
}

/// media-core's media.db, opened read-only on first use and never created
/// (media-core owns every write and migration). A failed open is remembered:
/// local tagging stays off instead of re-trying the file per request.
#[derive(Default)]
pub struct MediaDb(tokio::sync::OnceCell<Option<SqlitePool>>);

impl MediaDb {
    pub async fn get(&self, path: &str) -> Option<SqlitePool> {
        self.0
            .get_or_init(|| async {
                open_media_db(path)
                    .await
                    .inspect_err(|e| {
                        tracing::warn!(event = "mediaLibraryDb", path, error = %e, "media.db unavailable; local availability tagging disabled");
                    })
                    .ok()
            })
            .await
            .clone()
    }
}

/// No WAL pragma (that would be a write) and no migrations.
pub async fn open_media_db(path: &str) -> Result<SqlitePool, sqlx::Error> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(opts)
        .await
}

/// 'local' on items already on disk. Primary: the tmdb_id join. Fallback,
/// for items unmatched by id that carry a year: normalized title plus the
/// EXACT year, skipping normalized titles under 5 characters (media.db
/// titles are dirty; a false "you own this" is worse than a miss). Only
/// movies or shows are read, never episodes.
pub async fn tag_local(st: &AppState, items: Vec<Item>, kind: Kind) -> Vec<Item> {
    if !st.config.use_media_core || items.is_empty() {
        return items;
    }
    let Some(db) = st.suggestions.media_db.get(&st.config.media_db_path).await else {
        return items;
    };
    match local_hits(&db, &items, kind).await {
        Ok(hits) if hits.is_empty() => items,
        Ok(hits) => tag(items, |i, _| hits.contains(&i), "local"),
        Err(e) => {
            tracing::warn!(event = "suggestions", error = %e, "local availability lookup failed");
            items
        }
    }
}

/// Indices of the items found locally.
pub async fn local_hits(
    db: &SqlitePool,
    items: &[Item],
    kind: Kind,
) -> Result<HashSet<usize>, sqlx::Error> {
    let table = match kind {
        Kind::Tv => "shows",
        Kind::Movie => "movies",
    };
    let ids = unique_ids(items);
    let placeholders = vec!["?"; ids.len()].join(",");
    // The table is one of two literals; the list holds only placeholders.
    let sql = format!("SELECT DISTINCT tmdb_id FROM {table} WHERE tmdb_id IN ({placeholders})");
    let mut q = sqlx::query_scalar::<_, Option<i64>>(sqlx::AssertSqlSafe(sql));
    for id in &ids {
        q = q.bind(id);
    }
    let by_id: HashSet<i64> = q.fetch_all(db).await?.into_iter().flatten().collect();
    let mut hits: HashSet<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, it)| by_id.contains(&it.id))
        .map(|(i, _)| i)
        .collect();
    let unmatched: Vec<usize> = (0..items.len())
        .filter(|i| !hits.contains(i) && items[*i].year.is_some())
        .collect();
    if unmatched.is_empty() {
        return Ok(hits);
    }
    let sql = format!("SELECT title, year FROM {table} WHERE year IS NOT NULL");
    let rows: Vec<(Option<String>, Option<i64>)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .fetch_all(db)
        .await?;
    let keys: HashSet<String> = rows
        .into_iter()
        .filter_map(|(title, year)| {
            let (norm, year) = (normalize_title(&title?), year?);
            (norm.len() >= 5).then(|| format!("{norm}|{year}"))
        })
        .collect();
    for i in unmatched {
        let it = &items[i];
        let norm = normalize_title(&it.title);
        if norm.len() >= 5 && keys.contains(&format!("{norm}|{}", it.year.unwrap_or_default())) {
            hits.insert(i);
        }
    }
    Ok(hits)
}
