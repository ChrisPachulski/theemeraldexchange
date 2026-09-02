use super::catalog::{fetch_episode_meta, fetch_movie_meta};
use super::stores::*;
use super::*;

pub(super) async fn list_playlists(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_list(&state, &PLAYLIST_STORE, &sub).await
}

pub(super) async fn create_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_create(&state, &PLAYLIST_STORE, &sub, &body.name).await
}

pub(super) async fn get_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    let (name, created_at, updated_at) = store_meta(&state, &PLAYLIST_STORE, id, &sub).await?;
    let rows: Vec<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT media_kind, media_id, position, added_at FROM playlist_items \
         WHERE playlist_id = ? ORDER BY position",
    )
    .bind(id)
    .fetch_all(&state.db.pool)
    .await?;

    let movie_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.0 == "movie")
        .map(|r| r.1)
        .collect();
    let episode_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.0 == "episode")
        .map(|r| r.1)
        .collect();
    let movie_meta = fetch_movie_meta(&state, &movie_ids).await?;
    let episode_meta = fetch_episode_meta(&state, &episode_ids).await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|(media_kind, media_id, position, added_at)| {
            let mut v = json!({
                "media_kind": media_kind,
                "media_id": media_id,
                "position": position,
                "added_at": added_at,
            });
            let obj = v.as_object_mut().expect("json object");
            match media_kind.as_str() {
                "movie" => {
                    if let Some((title, poster)) = movie_meta.get(media_id) {
                        obj.insert("title".into(), json!(title));
                        obj.insert("poster_path".into(), json!(poster));
                    }
                }
                "episode" => {
                    if let Some(e) = episode_meta.get(media_id) {
                        obj.insert("title".into(), json!(e.episode_title));
                        obj.insert("show_title".into(), json!(e.show_title));
                        obj.insert("poster_path".into(), json!(e.poster_path));
                        obj.insert("season".into(), json!(e.season));
                        obj.insert("episode".into(), json!(e.episode));
                    }
                }
                _ => {}
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

pub(super) async fn rename_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_rename(&state, &PLAYLIST_STORE, id, &sub, &body.name).await
}

pub(super) async fn delete_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_delete(&state, &PLAYLIST_STORE, id, &sub).await
}

pub(super) async fn add_playlist_item(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<ListItemBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_add_item(&state, &PLAYLIST_STORE, id, &sub, &body).await
}

pub(super) async fn delete_playlist_item(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<ListItemQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_remove_item(&state, &PLAYLIST_STORE, id, &sub, &q.media_kind, q.media_id).await
}

/// Full reorder: the body must list every current item exactly once; each
/// item's new `position` is its index in the array. Partial reorders are
/// rejected so positions can never silently collide or gap.
pub(super) async fn reorder_playlist(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(id): Path<i64>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<ReorderBody>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    store_owned(&state, &PLAYLIST_STORE, id, &sub).await?;

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?")
            .bind(id)
            .fetch_one(&state.db.pool)
            .await?;
    let unique: std::collections::HashSet<(&str, i64)> = body
        .items
        .iter()
        .map(|i| (i.media_kind.as_str(), i.media_id))
        .collect();
    if body.items.len() as i64 != count || unique.len() != body.items.len() {
        return Err(AppError::BadRequest(
            "reorder must list every playlist item exactly once".into(),
        ));
    }

    let mut tx = state.db.pool.begin().await?;
    let mut updated: u64 = 0;
    for (position, item) in body.items.iter().enumerate() {
        let res = sqlx::query(
            "UPDATE playlist_items SET position = ? \
             WHERE playlist_id = ? AND media_kind = ? AND media_id = ?",
        )
        .bind(position as i64)
        .bind(id)
        .bind(&item.media_kind)
        .bind(item.media_id)
        .execute(&mut *tx)
        .await?;
        updated += res.rows_affected();
    }
    if updated != count as u64 {
        // Body named an item that is not in the playlist; tx drop = rollback.
        return Err(AppError::BadRequest(
            "reorder must list every playlist item exactly once".into(),
        ));
    }
    tx.commit().await?;
    store_touch(&state, &PLAYLIST_STORE, id).await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use tower::ServiceExt;

    #[tokio::test]
    async fn playlist_crud_ordering_and_reorder() {
        let state = test_state().await;
        let f1 = seed_media_file(&state, "/lib/p1.mp4").await;
        let f2 = seed_media_file(&state, "/lib/p2.mp4").await;
        let m1 = seed_movie_for_file(&state, f1).await;
        let m2 = seed_movie_for_file(&state, f2).await;
        let app = crate::build_router(state);

        let created = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/playlists?sub=plex:1",
                json!({ "name": "Friday Night" }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let pid = body_json(created).await["id"].as_i64().unwrap();

        for m in [m1, m2] {
            let add = app
                .clone()
                .oneshot(json_req(
                    "POST",
                    format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                    json!({ "media_kind": "movie", "media_id": m }).to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(add.status(), StatusCode::OK);
        }

        let detail = app
            .clone()
            .oneshot(req("GET", format!("/api/media/playlists/{pid}?sub=plex:1")))
            .await
            .unwrap();
        let v = body_json(detail).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        // Insertion order preserved, and enrichment carries the movie title.
        assert_eq!(items[0]["media_id"], m1);
        assert_eq!(items[1]["media_id"], m2);
        assert!(items[0]["title"].is_string());

        // Full reorder: reversed body order becomes the new positions.
        let reorder = app
            .clone()
            .oneshot(json_req(
                "PUT",
                format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                json!({ "items": [
                    { "media_kind": "movie", "media_id": m2 },
                    { "media_kind": "movie", "media_id": m1 },
                ]})
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(reorder.status(), StatusCode::OK);
        let v = body_json(
            app.clone()
                .oneshot(req("GET", format!("/api/media/playlists/{pid}?sub=plex:1")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(v["items"][0]["media_id"], m2);

        // Partial reorder must be rejected (positions could collide).
        let partial = app
            .clone()
            .oneshot(json_req(
                "PUT",
                format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                json!({ "items": [{ "media_kind": "movie", "media_id": m1 }] }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(partial.status(), StatusCode::BAD_REQUEST);

        // Remove one item, then delete the playlist entirely.
        let remove = app
            .clone()
            .oneshot(req(
                "DELETE",
                format!(
                    "/api/media/playlists/{pid}/items?sub=plex:1&media_kind=movie&media_id={m1}"
                ),
            ))
            .await
            .unwrap();
        assert_eq!(remove.status(), StatusCode::OK);
        let del = app
            .clone()
            .oneshot(req(
                "DELETE",
                format!("/api/media/playlists/{pid}?sub=plex:1"),
            ))
            .await
            .unwrap();
        assert_eq!(del.status(), StatusCode::OK);
        let gone = app
            .oneshot(req("GET", format!("/api/media/playlists/{pid}?sub=plex:1")))
            .await
            .unwrap();
        assert_eq!(gone.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn playlists_are_scoped_per_user() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let created = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/playlists?sub=plex:owner",
                json!({ "name": "Mine" }).to_string(),
            ))
            .await
            .unwrap();
        let pid = body_json(created).await["id"].as_i64().unwrap();

        // Another user neither lists nor reads nor deletes it.
        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/playlists?sub=plex:other"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["items"].as_array().unwrap().len(), 0);
        let read = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/playlists/{pid}?sub=plex:other"),
            ))
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::NOT_FOUND);
        let del = app
            .oneshot(req(
                "DELETE",
                format!("/api/media/playlists/{pid}?sub=plex:other"),
            ))
            .await
            .unwrap();
        assert_eq!(del.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn playlist_item_validation_rejects_bad_refs() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let pid = body_json(
            app.clone()
                .oneshot(json_req(
                    "POST",
                    "/api/media/playlists?sub=plex:1",
                    json!({ "name": "Checks" }).to_string(),
                ))
                .await
                .unwrap(),
        )
        .await["id"]
            .as_i64()
            .unwrap();

        // 'show' is a collection kind, not a playlist kind → 400.
        let bad_kind = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                json!({ "media_kind": "show", "media_id": 1 }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(bad_kind.status(), StatusCode::BAD_REQUEST);

        // Known kind, nonexistent id → 404.
        let bad_id = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/playlists/{pid}/items?sub=plex:1"),
                json!({ "media_kind": "movie", "media_id": 9999 }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(bad_id.status(), StatusCode::NOT_FOUND);

        // Duplicate playlist name for the same user → 400.
        let dup = app
            .oneshot(json_req(
                "POST",
                "/api/media/playlists?sub=plex:1",
                json!({ "name": "Checks" }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(dup.status(), StatusCode::BAD_REQUEST);
    }
}
