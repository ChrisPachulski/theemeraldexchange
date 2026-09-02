//! Photos.

use super::*;

/// `(id, width, height, taken_at, mtime)` from `photos`.
pub(super) type PhotoListRow = (i64, Option<i64>, Option<i64>, Option<String>, String);

pub(super) async fn list_photos(
    State(state): State<AppState>,
    Query(q): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    // Timeline order: EXIF taken-at when present, file mtime otherwise (both
    // stored in lexicographically-chronological shapes).
    let rows: Vec<PhotoListRow> = sqlx::query_as(
        "SELECT id, width, height, taken_at, mtime FROM photos \
         ORDER BY COALESCE(taken_at, mtime) DESC LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM photos")
        .fetch_one(&state.db.pool)
        .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, width, height, taken_at, mtime)| {
            json!({
                "id": id,
                "width": width,
                "height": height,
                "taken_at": taken_at,
                "mtime": mtime,
                "url": format!("/api/media/photos/{id}/file"),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

pub(super) async fn photo_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    let path: Option<String> = sqlx::query_scalar("SELECT path FROM photos WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db.pool)
        .await?;
    let path = path.ok_or(AppError::NotFound)?;
    // Same defense-in-depth as stream_file: only serve inside the photo roots.
    if !path_within_roots(std::path::Path::new(&path), &state.config.photo_roots).await {
        tracing::warn!(path = %path, "refusing to serve photo outside photo roots");
        return Err(AppError::NotFound);
    }
    // ponytail: originals only, read fully (photos are MBs, not GBs). Add an
    // ffmpeg-scaled thumbnail cache when the grid UI needs one.
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, image_content_type(&path)),
            (axum::http::header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use tower::ServiceExt;

    #[tokio::test]
    async fn photos_list_and_file_round_trip() {
        let state = test_state().await;
        let tmp = tempfile::tempdir().unwrap();
        let photo_path = tmp.path().join("sunset.jpg");
        std::fs::write(&photo_path, b"jpegish-bytes").unwrap();
        sqlx::query(
            "INSERT INTO photos (path, size_bytes, mtime, width, height, taken_at, scanned_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(photo_path.to_str().unwrap())
        .bind(13_i64)
        .bind("2026-01-01T00:00:00Z")
        .bind(4032_i64)
        .bind(3024_i64)
        .bind("2025-12-25T10:00:00")
        .bind("2026-01-01T00:00:00Z")
        .execute(&state.db.pool)
        .await
        .unwrap();
        let app = crate::build_router(state);

        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/photos?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["total"], 1);
        let id = list["items"][0]["id"].as_i64().unwrap();
        assert_eq!(list["items"][0]["taken_at"], "2025-12-25T10:00:00");

        // photo_roots is empty in tests → containment skipped → file serves.
        let file = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/photos/{id}/file?sub=plex:1"),
            ))
            .await
            .unwrap();
        assert_eq!(file.status(), StatusCode::OK);
        assert_eq!(
            file.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "image/jpeg"
        );

        let missing = app
            .oneshot(req("GET", "/api/media/photos/9999/file?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }
}
