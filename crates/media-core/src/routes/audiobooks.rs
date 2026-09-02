//! Audiobooks.

use super::*;

pub(super) async fn list_audiobooks(
    State(state): State<AppState>,
    Query(q): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows: Vec<(i64, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT id, author, title, duration_secs FROM audiobooks \
         ORDER BY author COLLATE NOCASE, title COLLATE NOCASE LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audiobooks")
        .fetch_one(&state.db.pool)
        .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, author, title, duration_secs)| {
            json!({
                "id": id,
                "author": author,
                "title": title,
                "duration_secs": duration_secs,
                "streamUrl": format!("/api/media/stream/audiobook/{id}"),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

pub(super) async fn get_audiobook(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let row: Option<(String, String, Option<i64>, String)> = sqlx::query_as(
        "SELECT author, title, duration_secs, chapters_json FROM audiobooks WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?;
    let (author, title, duration_secs, chapters_json) = row.ok_or(AppError::NotFound)?;
    let chapters: Value = serde_json::from_str(&chapters_json).unwrap_or_else(|_| json!([]));
    Ok(Json(json!({
        "id": id,
        "author": author,
        "title": title,
        "duration_secs": duration_secs,
        "chapters": chapters,
        "streamUrl": format!("/api/media/stream/audiobook/{id}"),
    })))
}

#[cfg(test)]
mod tests {

    use crate::routes::testsupport::*;

    use tower::ServiceExt;

    #[tokio::test]
    async fn audiobooks_list_and_detail_with_chapters() {
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/books/dispossessed.m4b").await;
        sqlx::query(
            "INSERT INTO audiobooks (media_file_id, author, title, duration_secs, chapters_json) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(file_id)
        .bind("Le Guin")
        .bind("The Dispossessed")
        .bind(41_000_i64)
        .bind(r#"[{"title":"Chapter 1","start_secs":0,"end_secs":1800}]"#)
        .execute(&state.db.pool)
        .await
        .unwrap();
        let app = crate::build_router(state);

        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/audiobooks?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["total"], 1);
        let id = list["items"][0]["id"].as_i64().unwrap();
        assert_eq!(list["items"][0]["author"], "Le Guin");

        let detail = body_json(
            app.clone()
                .oneshot(req("GET", format!("/api/media/audiobooks/{id}?sub=plex:1")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(detail["chapters"][0]["title"], "Chapter 1");
        assert_eq!(
            detail["streamUrl"],
            format!("/api/media/stream/audiobook/{id}")
        );

        // The grant path treats an audiobook as direct-play audio.
        let grant = body_json(
            app.oneshot(json_req(
                "POST",
                format!("/api/media/play/audiobook/{id}/grant?sub=plex:1"),
                "{}",
            ))
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(grant["directPlay"], true);
    }
}
