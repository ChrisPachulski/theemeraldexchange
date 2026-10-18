//! Audiobooks.

use super::*;

pub(super) async fn list_audiobooks(
    State(state): State<AppState>,
    Query(q): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    type BookListRow = (i64, String, String, Option<i64>, bool, Option<String>);
    let rows: Vec<BookListRow> = sqlx::query_as(
        "SELECT a.id, author, title, duration_secs, art_path IS NOT NULL, img.blurhash \
         FROM audiobooks a LEFT JOIN images img ON img.key = 'audiobook/' || a.id \
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
        .map(|(id, author, title, duration_secs, has_art, blurhash)| {
            json!({
                "id": id,
                "author": author,
                "title": title,
                "duration_secs": duration_secs,
                "art_url": art_url(id, has_art),
                "art_blurhash": blurhash,
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
    type BookRow = (String, String, Option<i64>, String, bool, Option<String>);
    let row: Option<BookRow> = sqlx::query_as(
        "SELECT author, title, duration_secs, chapters_json, art_path IS NOT NULL, img.blurhash \
         FROM audiobooks a LEFT JOIN images img ON img.key = 'audiobook/' || a.id \
         WHERE a.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?;
    let (author, title, duration_secs, chapters_json, has_art, blurhash) =
        row.ok_or(AppError::NotFound)?;
    let chapters: Value = serde_json::from_str(&chapters_json).unwrap_or_else(|_| json!([]));
    Ok(Json(json!({
        "id": id,
        "author": author,
        "title": title,
        "duration_secs": duration_secs,
        "chapters": chapters,
        "art_url": art_url(id, has_art),
        "art_blurhash": blurhash,
        "streamUrl": format!("/api/media/stream/audiobook/{id}"),
    })))
}

/// The resized cover route for a book with art, else null.
fn art_url(id: i64, has_art: bool) -> Option<String> {
    has_art.then(|| format!("/api/media/images/audiobook/{id}"))
}

#[cfg(test)]
mod tests {

    use crate::routes::testsupport::*;
    use serde_json::Value;

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
        let app = crate::build_router(state.clone());

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
        assert_eq!(list["items"][0]["art_url"], Value::Null);

        let detail = body_json(
            app.clone()
                .oneshot(req("GET", format!("/api/media/audiobooks/{id}?sub=plex:1")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(detail["chapters"][0]["title"], "Chapter 1");
        assert_eq!(detail["art_url"], Value::Null);

        sqlx::query("UPDATE audiobooks SET art_path = '/art/audiobook_1.png'")
            .execute(&state.db.pool)
            .await
            .unwrap();
        let url = format!("/api/media/images/audiobook/{id}");
        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/audiobooks?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["items"][0]["art_url"], url.as_str());
        let detail = body_json(
            app.clone()
                .oneshot(req("GET", format!("/api/media/audiobooks/{id}?sub=plex:1")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(detail["art_url"], url.as_str());
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
