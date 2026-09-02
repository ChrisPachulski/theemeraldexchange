//! Podcasts.

use super::stores::unique_to_bad_request;
use super::*;

/// `(id, feed_url, title, description, image_url, added_at, refreshed_at,
/// episode_count)` from `podcasts`.
pub(super) type PodcastListRow = (
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    i64,
);
/// `(id, title, audio_url, published_at, duration_secs, description)` from
/// `podcast_episodes`.
pub(super) type PodcastEpisodeRow = (
    i64,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);

#[derive(Debug, Deserialize)]
pub struct PodcastAddBody {
    pub feed_url: String,
}

pub(super) async fn list_podcasts(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let rows: Vec<PodcastListRow> = sqlx::query_as(
        "SELECT p.id, p.feed_url, p.title, p.description, p.image_url, p.added_at, \
         p.refreshed_at, \
         (SELECT COUNT(*) FROM podcast_episodes e WHERE e.podcast_id = p.id) \
         FROM podcasts p ORDER BY p.title COLLATE NOCASE",
    )
    .fetch_all(&state.db.pool)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(
            |(id, feed_url, title, description, image_url, added_at, refreshed_at, count)| {
                json!({
                    "id": id,
                    "feed_url": feed_url,
                    "title": title,
                    "description": description,
                    "image_url": image_url,
                    "added_at": added_at,
                    "refreshed_at": refreshed_at,
                    "episode_count": count,
                })
            },
        )
        .collect();
    Ok(Json(json!({ "items": items })))
}

pub(super) async fn add_podcast(
    State(state): State<AppState>,
    Json(body): Json<PodcastAddBody>,
) -> AppResult<Json<Value>> {
    let feed_url = body.feed_url.trim().to_string();
    if !(feed_url.starts_with("http://") || feed_url.starts_with("https://")) {
        return Err(AppError::BadRequest("feed_url must be http(s)".into()));
    }
    // Fetch first: a subscription that never parsed is not worth storing.
    let feed = crate::podcasts::fetch_feed(&feed_url)
        .await
        .map_err(AppError::BadRequest)?;

    let id = sqlx::query("INSERT INTO podcasts (feed_url, title, added_at) VALUES (?, ?, ?)")
        .bind(&feed_url)
        .bind(&feed.title)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&state.db.pool)
        .await
        .map_err(|e| unique_to_bad_request(e, "already subscribed to that feed"))?
        .last_insert_rowid();
    let episodes = crate::podcasts::store_feed(&state.db, id, &feed).await?;

    Ok(Json(json!({
        "id": id,
        "title": feed.title,
        "episodes": episodes,
    })))
}

pub(super) async fn refresh_podcast_route(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let episodes = crate::podcasts::refresh_podcast(&state.db, id).await?;
    Ok(Json(json!({ "ok": true, "episodes": episodes })))
}

pub(super) async fn delete_podcast(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    // Episodes cascade via their FK (foreign_keys is ON for this pool).
    let affected = sqlx::query("DELETE FROM podcasts WHERE id = ?")
        .bind(id)
        .execute(&state.db.pool)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

pub(super) async fn list_podcast_episodes(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM podcasts WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db.pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows: Vec<PodcastEpisodeRow> = sqlx::query_as(
        "SELECT id, title, audio_url, published_at, duration_secs, description \
         FROM podcast_episodes WHERE podcast_id = ? \
         ORDER BY published_at IS NULL, published_at DESC LIMIT ? OFFSET ?",
    )
    .bind(id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM podcast_episodes WHERE podcast_id = ?")
            .bind(id)
            .fetch_one(&state.db.pool)
            .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(
            |(id, title, audio_url, published_at, duration_secs, description)| {
                json!({
                    "id": id,
                    "title": title,
                    "audio_url": audio_url,
                    "published_at": published_at,
                    "duration_secs": duration_secs,
                    "description": description,
                })
            },
        )
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use std::sync::Arc;
    use tower::ServiceExt;

    #[tokio::test]
    async fn podcast_endpoints_validate_without_network() {
        let state = test_state().await;
        let app = crate::build_router(state);

        // Empty list to start.
        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/podcasts?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["items"].as_array().unwrap().len(), 0);

        // Non-http(s) scheme is rejected before any fetch.
        let bad = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/podcasts?sub=plex:1",
                json!({ "feed_url": "file:///etc/passwd" }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);

        // Episodes of an unknown podcast → 404; deleting one → 404.
        let eps = app
            .clone()
            .oneshot(req("GET", "/api/media/podcasts/42/episodes?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(eps.status(), StatusCode::NOT_FOUND);
        let del = app
            .oneshot(req("DELETE", "/api/media/podcasts/42?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(del.status(), StatusCode::NOT_FOUND);
    }

    /// SSRF: `feed_url` is typed in by any household member, so an internal
    /// address must be refused BEFORE a socket is opened.
    ///
    /// The gate is the connection counter on a real loopback listener, not the
    /// status code — an UNGUARDED media-core also 400s here (a refused or
    /// timed-out fetch is still a fetch error), so `accepted == 0` is the only
    /// assertion that actually distinguishes "blocked" from "tried and failed".
    /// The listener accepts and never replies, so an unguarded run additionally
    /// blows the elapsed bound waiting out the 15s client timeout.
    #[tokio::test]
    async fn podcast_feed_url_cannot_reach_internal_addresses() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let state = test_state().await;
        let app = crate::build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                held.push(stream); // hold it open; never answer
            }
        });

        let started = std::time::Instant::now();
        for feed_url in [
            format!("http://127.0.0.1:{port}/feed.xml"), // loopback, listening
            "http://169.254.169.254/latest/meta-data/".to_string(), // cloud metadata
            "http://[::1]:8080/feed.xml".to_string(),    // v6 loopback literal
            "http://10.0.0.7/feed.xml".to_string(),      // RFC-1918
            "http://theemeraldexchange.local/feed.xml".to_string(), // LAN suffix
            "http://media-core/feed.xml".to_string(),    // compose service DNS
        ] {
            let res = app
                .clone()
                .oneshot(json_req(
                    "POST",
                    "/api/media/podcasts?sub=plex:1",
                    json!({ "feed_url": feed_url }).to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(
                res.status(),
                StatusCode::BAD_REQUEST,
                "{feed_url} should be rejected"
            );
        }

        assert_eq!(
            accepted.load(Ordering::SeqCst),
            0,
            "guard must reject from the URL alone — no connection attempt"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "rejection must be immediate, not a connect/read timeout (took {:?})",
            started.elapsed()
        );

        // And none of them got stored.
        let list = body_json(
            app.oneshot(req("GET", "/api/media/podcasts?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["items"].as_array().unwrap().len(), 0);
    }
}
