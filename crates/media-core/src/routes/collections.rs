use super::catalog::{fetch_by_ids, fetch_movie_meta};
use super::stores::*;
use super::*;

pub(super) async fn list_collections(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_list(&state, &COLLECTION_STORE, &sub).await
}

pub(super) async fn create_collection(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_create(&state, &COLLECTION_STORE, &sub, &body.name).await
}

pub(super) async fn get_collection(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    let (name, created_at, updated_at) = store_meta(&state, &COLLECTION_STORE, id, &sub).await?;
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT media_kind, media_id, added_at FROM collection_items \
         WHERE collection_id = ? ORDER BY added_at",
    )
    .bind(id)
    .fetch_all(&state.db.pool)
    .await?;

    let movie_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.0 == "movie")
        .map(|r| r.1)
        .collect();
    let show_ids: Vec<i64> = rows.iter().filter(|r| r.0 == "show").map(|r| r.1).collect();
    let movie_meta = fetch_movie_meta(&state, &movie_ids).await?;
    let show_meta = fetch_show_meta(&state, &show_ids).await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|(media_kind, media_id, added_at)| {
            let mut v = json!({
                "media_kind": media_kind,
                "media_id": media_id,
                "added_at": added_at,
            });
            let obj = v.as_object_mut().expect("json object");
            let meta = match media_kind.as_str() {
                "movie" => movie_meta.get(media_id),
                "show" => show_meta.get(media_id),
                _ => None,
            };
            if let Some((title, poster)) = meta {
                obj.insert("title".into(), json!(title));
                obj.insert("poster_path".into(), json!(poster));
            }
            v
        })
        .collect();

    Ok(Json(json!({
        "id": id,
        "name": name,
        "created_at": created_at,
        "updated_at": updated_at,
        "items": items,
    })))
}

/// Batch-resolve `shows.id → (title, poster_path)` for collection detail.
pub(super) async fn fetch_show_meta(
    state: &AppState,
    ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, (String, Option<String>)>> {
    fetch_by_ids(
        state,
        ids,
        |ph| format!("SELECT id, title, poster_path FROM shows WHERE id IN ({ph})"),
        |(id, title, poster): (i64, String, Option<String>)| (id, (title, poster)),
    )
    .await
}

pub(super) async fn rename_collection(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_rename(&state, &COLLECTION_STORE, id, &sub, &body.name).await
}

pub(super) async fn delete_collection(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_delete(&state, &COLLECTION_STORE, id, &sub).await
}

pub(super) async fn add_collection_item(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<ListItemBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_add_item(&state, &COLLECTION_STORE, id, &sub, &body).await
}

pub(super) async fn delete_collection_item(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<ListItemQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_remove_item(
        &state,
        &COLLECTION_STORE,
        id,
        &sub,
        &q.media_kind,
        q.media_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use tower::ServiceExt;

    #[tokio::test]
    async fn collection_round_trips_with_show_enrichment() {
        let state = test_state().await;
        let f = seed_media_file(&state, "/lib/c1.mp4").await;
        let movie_id = seed_movie_for_file(&state, f).await;
        let show_id: i64 =
            sqlx::query("INSERT INTO shows (title, added_at, poster_path) VALUES (?, ?, ?)")
                .bind("Show Piece")
                .bind("2026-01-01T00:00:00Z")
                .bind("/poster.jpg")
                .execute(&state.db.pool)
                .await
                .unwrap()
                .last_insert_rowid();
        let app = crate::build_router(state);

        let cid = body_json(
            app.clone()
                .oneshot(json_req(
                    "POST",
                    "/api/media/collections?sub=plex:1",
                    json!({ "name": "Favorites" }).to_string(),
                ))
                .await
                .unwrap(),
        )
        .await["id"]
            .as_i64()
            .unwrap();

        for (kind, id) in [("movie", movie_id), ("show", show_id)] {
            let add = app
                .clone()
                .oneshot(json_req(
                    "POST",
                    format!("/api/media/collections/{cid}/items?sub=plex:1"),
                    json!({ "media_kind": kind, "media_id": id }).to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(add.status(), StatusCode::OK);
        }

        let v = body_json(
            app.clone()
                .oneshot(req(
                    "GET",
                    format!("/api/media/collections/{cid}?sub=plex:1"),
                ))
                .await
                .unwrap(),
        )
        .await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let show_item = items
            .iter()
            .find(|i| i["media_kind"] == "show")
            .expect("show item present");
        assert_eq!(show_item["title"], "Show Piece");
        assert_eq!(show_item["poster_path"], "/poster.jpg");

        // Episodes are not a collection kind → 400.
        let bad = app
            .oneshot(json_req(
                "POST",
                format!("/api/media/collections/{cid}/items?sub=plex:1"),
                json!({ "media_kind": "episode", "media_id": 1 }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    }
}
