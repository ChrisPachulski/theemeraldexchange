//! Playlists & collections.

use super::*;

/// The two user-curated list stores share one shape: a named per-user parent
/// row plus polymorphic `(media_kind, media_id)` item rows. Playlists keep a
/// `position` column (ordered); collections are unordered. Table names come
/// only from these two consts (never user input), so the `format!`-built SQL
/// below is injection-safe; all values are still bound parameters.
pub(super) struct ListStore {
    /// Human noun for error messages ("playlist" / "collection").
    noun: &'static str,
    table: &'static str,
    items_table: &'static str,
    parent_fk: &'static str,
    /// `media_kind` → catalog table: the fixed allow-list for item validation
    /// (polymorphic ids can't be FK-enforced, same as media_watch_state).
    kinds: &'static [(&'static str, &'static str)],
    /// Ordered stores carry a `position` column on their item rows.
    ordered: bool,
}

pub(super) const PLAYLIST_STORE: ListStore = ListStore {
    noun: "playlist",
    table: "playlists",
    items_table: "playlist_items",
    parent_fk: "playlist_id",
    kinds: &[("movie", "movies"), ("episode", "episodes")],
    ordered: true,
};

pub(super) const COLLECTION_STORE: ListStore = ListStore {
    noun: "collection",
    table: "collections",
    items_table: "collection_items",
    parent_fk: "collection_id",
    kinds: &[("movie", "movies"), ("show", "shows")],
    ordered: false,
};

#[derive(Debug, Deserialize)]
pub struct NameBody {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct ListItemBody {
    pub media_kind: String,
    pub media_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct ReorderBody {
    pub items: Vec<ListItemBody>,
}

#[derive(Debug, Deserialize)]
pub struct ListItemQuery {
    pub sub: Option<String>,
    pub media_kind: String,
    pub media_id: i64,
}

/// Map an sqlx error to 400 on UNIQUE violation (duplicate `(sub, name)`),
/// otherwise pass it through as a 500-class DB error.
pub(super) fn unique_to_bad_request(e: sqlx::Error, msg: &str) -> AppError {
    match &e {
        sqlx::Error::Database(db)
            if matches!(db.kind(), sqlx::error::ErrorKind::UniqueViolation) =>
        {
            AppError::BadRequest(msg.into())
        }
        _ => AppError::Db(e),
    }
}

/// 404 unless `id` names a parent row owned by `sub`. Scoping every statement
/// by owner keeps one user's playlist ids useless to another (no IDOR).
pub(super) async fn store_owned(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
) -> AppResult<()> {
    let sql = format!("SELECT 1 FROM {} WHERE id = ? AND sub = ?", store.table);
    let found: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(sub)
        .fetch_optional(&state.db.pool)
        .await?;
    if found.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub(super) async fn store_touch(state: &AppState, store: &ListStore, id: i64) -> AppResult<()> {
    let sql = format!("UPDATE {} SET updated_at = ? WHERE id = ?", store.table);
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&state.db.pool)
        .await?;
    Ok(())
}

pub(super) async fn store_list(
    state: &AppState,
    store: &ListStore,
    sub: &str,
) -> AppResult<Json<Value>> {
    let sql = format!(
        "SELECT p.id, p.name, p.created_at, p.updated_at, \
         (SELECT COUNT(*) FROM {items} i WHERE i.{fk} = p.id) \
         FROM {table} p WHERE p.sub = ? ORDER BY p.name COLLATE NOCASE",
        items = store.items_table,
        fk = store.parent_fk,
        table = store.table,
    );
    let rows: Vec<(i64, String, String, String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(sub)
        .fetch_all(&state.db.pool)
        .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, created_at, updated_at, item_count)| {
            json!({
                "id": id,
                "name": name,
                "created_at": created_at,
                "updated_at": updated_at,
                "item_count": item_count,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

pub(super) async fn store_create(
    state: &AppState,
    store: &ListStore,
    sub: &str,
    name: &str,
) -> AppResult<Json<Value>> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name required".into()));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let sql = format!(
        "INSERT INTO {} (sub, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        store.table
    );
    let id = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(sub)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&state.db.pool)
        .await
        .map_err(|e| {
            unique_to_bad_request(
                e,
                &format!("a {} with that name already exists", store.noun),
            )
        })?
        .last_insert_rowid();
    Ok(Json(json!({ "id": id, "name": name, "created_at": now })))
}

pub(super) async fn store_rename(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
    name: &str,
) -> AppResult<Json<Value>> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name required".into()));
    }
    store_owned(state, store, id, sub).await?;
    let sql = format!(
        "UPDATE {} SET name = ?, updated_at = ? WHERE id = ? AND sub = ?",
        store.table
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(name)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .bind(sub)
        .execute(&state.db.pool)
        .await
        .map_err(|e| {
            unique_to_bad_request(
                e,
                &format!("a {} with that name already exists", store.noun),
            )
        })?;
    Ok(Json(json!({ "ok": true })))
}

pub(super) async fn store_delete(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
) -> AppResult<Json<Value>> {
    store_owned(state, store, id, sub).await?;
    // Items first: the item tables carry no FK to the parent (polymorphic
    // store, see the migration header), so cascade by hand.
    let mut tx = state.db.pool.begin().await?;
    let del_items = format!(
        "DELETE FROM {} WHERE {} = ?",
        store.items_table, store.parent_fk
    );
    sqlx::query(sqlx::AssertSqlSafe(del_items))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let del_parent = format!("DELETE FROM {} WHERE id = ? AND sub = ?", store.table);
    sqlx::query(sqlx::AssertSqlSafe(del_parent))
        .bind(id)
        .bind(sub)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

/// Validate `(media_kind, media_id)` against the store's catalog allow-list.
/// Unknown kind → 400, known kind with absent id → 404 (same contract as
/// watch-state's `media_exists`).
pub(super) async fn store_item_valid(
    state: &AppState,
    store: &ListStore,
    media_kind: &str,
    media_id: i64,
) -> AppResult<()> {
    let Some((_, table)) = store.kinds.iter().find(|(k, _)| *k == media_kind) else {
        let allowed = store
            .kinds
            .iter()
            .map(|(k, _)| format!("'{k}'"))
            .collect::<Vec<_>>()
            .join(" or ");
        return Err(AppError::BadRequest(format!(
            "media_kind must be {allowed}"
        )));
    };
    let sql = format!("SELECT 1 FROM {table} WHERE id = ? LIMIT 1");
    let found: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(media_id)
        .fetch_optional(&state.db.pool)
        .await?;
    if found.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub(super) async fn store_add_item(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
    item: &ListItemBody,
) -> AppResult<Json<Value>> {
    store_owned(state, store, id, sub).await?;
    store_item_valid(state, store, &item.media_kind, item.media_id).await?;
    let now = chrono::Utc::now().to_rfc3339();
    // Re-adding an existing item is a no-op (idempotent), not an error.
    let sql = if store.ordered {
        format!(
            "INSERT INTO {items} ({fk}, media_kind, media_id, position, added_at) \
             VALUES (?, ?, ?, \
             (SELECT COALESCE(MAX(position) + 1, 0) FROM {items} WHERE {fk} = ?), ?) \
             ON CONFLICT DO NOTHING",
            items = store.items_table,
            fk = store.parent_fk,
        )
    } else {
        format!(
            "INSERT INTO {items} ({fk}, media_kind, media_id, added_at) \
             VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
            items = store.items_table,
            fk = store.parent_fk,
        )
    };
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(&item.media_kind)
        .bind(item.media_id);
    if store.ordered {
        query = query.bind(id);
    }
    query.bind(&now).execute(&state.db.pool).await?;
    store_touch(state, store, id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub(super) async fn store_remove_item(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
    media_kind: &str,
    media_id: i64,
) -> AppResult<Json<Value>> {
    store_owned(state, store, id, sub).await?;
    let sql = format!(
        "DELETE FROM {} WHERE {} = ? AND media_kind = ? AND media_id = ?",
        store.items_table, store.parent_fk
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(media_kind)
        .bind(media_id)
        .execute(&state.db.pool)
        .await?;
    store_touch(state, store, id).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Fetch the parent row `(name, created_at, updated_at)` for a detail view.
pub(super) async fn store_meta(
    state: &AppState,
    store: &ListStore,
    id: i64,
    sub: &str,
) -> AppResult<(String, String, String)> {
    let sql = format!(
        "SELECT name, created_at, updated_at FROM {} WHERE id = ? AND sub = ?",
        store.table
    );
    sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(sub)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or(AppError::NotFound)
}
