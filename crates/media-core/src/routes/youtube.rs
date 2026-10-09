//! YouTube: ytdl-sub's channel folders (see `scanner::scan_youtube_once`).
//! Channels are folder names; the client builds their art URLs from the name.

use super::*;

#[derive(Debug, Deserialize)]
pub struct YoutubeVideosQuery {
    pub channel: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct YoutubeChannelArtQuery {
    pub channel: String,
    /// `poster` (default) or `fanart`.
    pub kind: Option<String>,
}

/// `(id, channel, title, upload_date, description, duration_secs, has_thumb)`.
type YoutubeVideoRow = (
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    bool,
);

/// Every channel, most recent upload first.
pub(super) async fn list_youtube_channels(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let rows: Vec<(String, i64, Option<String>)> = sqlx::query_as(
        "SELECT channel, COUNT(*), MAX(upload_date) FROM youtube_videos GROUP BY channel \
         ORDER BY MAX(upload_date) DESC, channel COLLATE NOCASE",
    )
    .fetch_all(&state.db.pool)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(name, video_count, latest_upload)| {
            json!({ "name": name, "video_count": video_count, "latest_upload": latest_upload })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// Videos newest first, optionally one channel's.
pub(super) async fn list_youtube_videos(
    State(state): State<AppState>,
    Query(q): Query<YoutubeVideosQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows: Vec<YoutubeVideoRow> = sqlx::query_as(
        "SELECT id, channel, title, upload_date, description, duration_secs, thumb_path IS NOT NULL \
         FROM youtube_videos WHERE (? IS NULL OR channel = ?) \
         ORDER BY upload_date DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(&q.channel)
    .bind(&q.channel)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM youtube_videos WHERE (? IS NULL OR channel = ?)")
            .bind(&q.channel)
            .bind(&q.channel)
            .fetch_one(&state.db.pool)
            .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(
            |(id, channel, title, upload_date, description, duration_secs, has_thumb)| {
                json!({
                    "id": id,
                    "channel": channel,
                    "title": title,
                    "upload_date": upload_date,
                    "description": description,
                    "duration_secs": duration_secs,
                    "thumbUrl": has_thumb.then(|| format!("/api/media/youtube/videos/{id}/thumb")),
                })
            },
        )
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

pub(super) async fn youtube_thumb(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    let path: Option<Option<String>> =
        sqlx::query_scalar("SELECT thumb_path FROM youtube_videos WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?;
    serve_youtube_image(&state, path.flatten().ok_or(AppError::NotFound)?).await
}

pub(super) async fn youtube_channel_art(
    State(state): State<AppState>,
    Query(q): Query<YoutubeChannelArtQuery>,
) -> AppResult<axum::response::Response> {
    let name = match q.kind.as_deref() {
        None | Some("poster") => "poster",
        Some("fanart") => "fanart",
        Some(other) => return Err(AppError::BadRequest(format!("unknown art kind: {other}"))),
    };
    let dir: Option<String> =
        sqlx::query_scalar("SELECT channel_dir FROM youtube_videos WHERE channel = ? LIMIT 1")
            .bind(&q.channel)
            .fetch_optional(&state.db.pool)
            .await?;
    let dir = std::path::PathBuf::from(dir.ok_or(AppError::NotFound)?);
    for ext in ["jpg", "png", "webp"] {
        let candidate = dir.join(format!("{name}.{ext}"));
        if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            let path = candidate.to_str().ok_or(AppError::NotFound)?.to_string();
            return serve_youtube_image(&state, path).await;
        }
    }
    Err(AppError::NotFound)
}

/// Serve an image that lives inside the YouTube roots (same containment as
/// `photo_file`).
async fn serve_youtube_image(
    state: &AppState,
    path: String,
) -> AppResult<axum::response::Response> {
    if !path_within_roots(std::path::Path::new(&path), &state.config.youtube_roots).await {
        tracing::warn!(path = %path, "refusing to serve youtube art outside youtube roots");
        return Err(AppError::NotFound);
    }
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

    async fn seed_video(
        state: &AppState,
        path: &str,
        channel: &str,
        channel_dir: &str,
        date: &str,
        thumb: Option<&str>,
    ) -> i64 {
        let file_id = seed_media_file(state, path).await;
        sqlx::query(
            "INSERT INTO youtube_videos (media_file_id, channel, channel_dir, title, upload_date, \
             duration_secs, thumb_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(file_id)
        .bind(channel)
        .bind(channel_dir)
        .bind(format!("{channel} {date}"))
        .bind(date)
        .bind(600_i64)
        .bind(thumb)
        .execute(&state.db.pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    #[tokio::test]
    async fn channels_videos_art_and_playback() {
        let state = test_state().await;
        let tmp = tempfile::tempdir().unwrap();
        let kurz = tmp.path().join("Kurzgesagt");
        std::fs::create_dir_all(&kurz).unwrap();
        std::fs::write(kurz.join("poster.jpg"), b"poster").unwrap();
        let thumb = kurz.join("a-thumb.jpg");
        std::fs::write(&thumb, b"thumb").unwrap();
        let kurz_dir = kurz.to_str().unwrap();
        let newest = seed_video(
            &state,
            "/yt/k1.mp4",
            "Kurzgesagt",
            kurz_dir,
            "2024-05-01",
            Some(thumb.to_str().unwrap()),
        )
        .await;
        seed_video(
            &state,
            "/yt/k2.mp4",
            "Kurzgesagt",
            kurz_dir,
            "2023-01-01",
            None,
        )
        .await;
        seed_video(&state, "/yt/p1.mp4", "PBS", "/yt/PBS", "2024-01-01", None).await;
        let app = crate::build_router(state);
        let get = |uri: String| app.clone().oneshot(req("GET", uri));

        let channels = body_json(
            get("/api/media/youtube/channels?sub=plex:1".into())
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            channels["items"][0]["name"], "Kurzgesagt",
            "latest upload first"
        );
        assert_eq!(channels["items"][0]["video_count"], 2);
        assert_eq!(channels["items"][1]["name"], "PBS");

        let all = body_json(
            get("/api/media/youtube/videos?sub=plex:1".into())
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(all["total"], 3);
        assert_eq!(all["items"][0]["id"], newest, "newest first");
        assert_eq!(
            all["items"][0]["thumbUrl"],
            format!("/api/media/youtube/videos/{newest}/thumb")
        );
        assert!(all["items"][1]["thumbUrl"].is_null());

        let pbs = body_json(
            get("/api/media/youtube/videos?channel=PBS&sub=plex:1".into())
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(pbs["total"], 1);
        assert_eq!(pbs["items"][0]["channel"], "PBS");

        let t = get(format!(
            "/api/media/youtube/videos/{newest}/thumb?sub=plex:1"
        ))
        .await
        .unwrap();
        assert_eq!(t.status(), StatusCode::OK);
        let art =
            get("/api/media/youtube/channel-art?channel=Kurzgesagt&kind=poster&sub=plex:1".into())
                .await
                .unwrap();
        assert_eq!(art.status(), StatusCode::OK);
        let missing = get("/api/media/youtube/channel-art?channel=PBS&sub=plex:1".into())
            .await
            .unwrap();
        assert_eq!(
            missing.status(),
            StatusCode::NOT_FOUND,
            "PBS has no poster on disk"
        );
        let bad = get("/api/media/youtube/channel-art?channel=PBS&kind=banner&sub=plex:1".into())
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);

        // A video plays through the shared grant path and records progress.
        let grant = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/play/video/{newest}/grant?sub=plex:1"),
                "{}",
            ))
            .await
            .unwrap();
        assert_eq!(grant.status(), StatusCode::OK);
        let watch = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                format!(r#"{{"media_kind":"video","media_id":{newest},"position_secs":30}}"#),
            ))
            .await
            .unwrap();
        assert!(
            watch.status().is_success(),
            "watch progress accepted: {}",
            watch.status()
        );
    }
}
