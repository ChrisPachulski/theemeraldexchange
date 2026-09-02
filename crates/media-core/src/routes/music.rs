//! Music library.
//!
//! Browse endpoints mirroring the movie/episode list shape ({items, total} with
//! limit/offset pagination). Each query struct evaluates every field it accepts
//! (no accepted-but-ignored params — see the ListQuery note above); music does
//! not carry a `?q=` search box, so these deliberately omit it.

use super::*;

#[derive(Debug, Deserialize)]
pub(super) struct ArtistsQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AlbumsQuery {
    artist_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(super) struct TracksQuery {
    album_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// GET /music/artists → `{ items: [{id, name, album_count}], total }`.
pub(super) async fn list_artists(
    State(state): State<AppState>,
    Query(q): Query<ArtistsQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows = sqlx::query_as::<_, (i64, String, i64)>(
        "SELECT a.id, a.name, COUNT(al.id) AS album_count \
         FROM artists a LEFT JOIN albums al ON al.artist_id = a.id \
         GROUP BY a.id, a.name ORDER BY a.name LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artists")
        .fetch_one(&state.db.pool)
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(
            |(id, name, album_count)| json!({ "id": id, "name": name, "album_count": album_count }),
        )
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// GET /music/albums?artist_id= →
/// `{ items: [{id, artist_id, artist_name, title, year, track_count}], total }`.
/// `artist_id` optional (omit to list every album).
pub(super) async fn list_albums(
    State(state): State<AppState>,
    Query(q): Query<AlbumsQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    // One SQL shape; `artist_id IS NULL OR al.artist_id = ?` lets the same query
    // serve both the filtered and unfiltered listing without duplication.
    let rows = sqlx::query_as::<_, (i64, i64, String, String, Option<i64>, i64, i64)>(
        "SELECT al.id, al.artist_id, ar.name, al.title, al.year, COUNT(t.id) AS track_count, \
         al.art_path IS NOT NULL \
         FROM albums al JOIN artists ar ON ar.id = al.artist_id \
         LEFT JOIN tracks t ON t.album_id = al.id \
         WHERE (? IS NULL OR al.artist_id = ?) \
         GROUP BY al.id ORDER BY ar.name, al.title LIMIT ? OFFSET ?",
    )
    .bind(q.artist_id)
    .bind(q.artist_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM albums WHERE (? IS NULL OR artist_id = ?)")
            .bind(q.artist_id)
            .bind(q.artist_id)
            .fetch_one(&state.db.pool)
            .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(
            |(id, artist_id, artist_name, title, year, track_count, has_art)| {
                json!({
                    "id": id,
                    "artist_id": artist_id,
                    "artist_name": artist_name,
                    "title": title,
                    "year": year,
                    "track_count": track_count,
                    "art_url": (*has_art == 1).then(|| format!("/api/media/music/albums/{id}/art")),
                })
            },
        )
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// GET /music/albums/{id}/art — the album image the scan discovered (folder
/// art referenced in place under a music root, or an extracted embedded
/// cover in the artwork dir). Both locations are containment-checked.
pub(super) async fn album_art(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    let art_path: Option<Option<String>> =
        sqlx::query_scalar("SELECT art_path FROM albums WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?;
    let art_path = art_path.flatten().ok_or(AppError::NotFound)?;
    let mut allowed = state.config.music_roots.clone();
    allowed.push(state.config.artwork_dir.clone());
    if !path_within_roots(std::path::Path::new(&art_path), &allowed).await {
        tracing::warn!(path = %art_path, "refusing to serve album art outside roots");
        return Err(AppError::NotFound);
    }
    let bytes = tokio::fs::read(&art_path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                image_content_type(&art_path),
            ),
            (axum::http::header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}

/// GET /music/tracks?album_id= →
/// `{ items: [{id, album_id, title, track_no, duration_secs}], total }`.
/// `album_id` optional (omit to list every track).
pub(super) async fn list_tracks(
    State(state): State<AppState>,
    Query(q): Query<TracksQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);
    let rows = sqlx::query_as::<_, (i64, i64, String, Option<i64>, Option<i64>)>(
        "SELECT id, album_id, title, track_no, duration_secs FROM tracks \
         WHERE (? IS NULL OR album_id = ?) \
         ORDER BY track_no, title LIMIT ? OFFSET ?",
    )
    .bind(q.album_id)
    .bind(q.album_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db.pool)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tracks WHERE (? IS NULL OR album_id = ?)")
            .bind(q.album_id)
            .bind(q.album_id)
            .fetch_one(&state.db.pool)
            .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|(id, album_id, title, track_no, duration_secs)| {
            json!({
                "id": id,
                "album_id": album_id,
                "title": title,
                "track_no": track_no,
                "duration_secs": duration_secs,
            })
        })
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
    async fn album_art_lists_and_serves_within_roots() {
        let tmp = tempfile::tempdir().unwrap();
        // State whose artwork dir IS the temp dir, so containment passes.
        let base = test_state().await;
        let mut config = (*base.config).clone();
        config.artwork_dir = tmp.path().to_path_buf();
        let state = AppState {
            config: Arc::new(config),
            ..base
        };

        let (_, album_id, _) =
            seed_track(&state, "Ghost", "Haunt", "Intro", 1, "/music/haunt/01.flac").await;
        let art = tmp.path().join("album_art.jpg");
        std::fs::write(&art, b"jpeg-bytes").unwrap();
        sqlx::query("UPDATE albums SET art_path = ? WHERE id = ?")
            .bind(art.to_str().unwrap())
            .bind(album_id)
            .execute(&state.db.pool)
            .await
            .unwrap();
        let app = crate::build_router(state);

        // Listing carries the art_url for decorated albums.
        let albums = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/music/albums?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            albums["items"][0]["art_url"],
            format!("/api/media/music/albums/{album_id}/art")
        );

        let art_resp = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/music/albums/{album_id}/art?sub=plex:1"),
            ))
            .await
            .unwrap();
        assert_eq!(art_resp.status(), StatusCode::OK);
        assert_eq!(
            art_resp
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "image/jpeg"
        );

        // An artless album (or unknown id) → 404.
        let missing = app
            .oneshot(req("GET", "/api/media/music/albums/9999/art?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn music_list_endpoints_return_expected_shapes() {
        let state = test_state().await;
        let (artist_id, album_id, _t1) = seed_track(
            &state,
            "Miles Davis",
            "Kind of Blue",
            "So What",
            1,
            "/music/a1.flac",
        )
        .await;
        seed_track(
            &state,
            "Miles Davis",
            "Kind of Blue",
            "Freddie Freeloader",
            2,
            "/music/a2.flac",
        )
        .await;
        // A second artist, so artist filtering is exercised.
        seed_track(
            &state,
            "John Coltrane",
            "Giant Steps",
            "Giant Steps",
            1,
            "/music/b1.flac",
        )
        .await;

        let app = crate::build_router(state);

        // Artists: {id, name, album_count}, total.
        let resp = app
            .clone()
            .oneshot(req("GET", "/api/media/music/artists"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 2);
        let artists = v["items"].as_array().unwrap();
        assert_eq!(artists.len(), 2);
        // Ordered by name → Coltrane, then Davis.
        assert_eq!(artists[0]["name"], "John Coltrane");
        assert_eq!(artists[0]["album_count"], 1);
        assert_eq!(artists[1]["name"], "Miles Davis");
        assert_eq!(artists[1]["album_count"], 1);

        // Albums filtered by artist: {id, artist_id, artist_name, title, year, track_count}.
        let resp = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/music/albums?artist_id={artist_id}"),
            ))
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["total"], 1);
        let album = &v["items"][0];
        assert_eq!(album["id"], album_id);
        assert_eq!(album["artist_id"], artist_id);
        assert_eq!(album["artist_name"], "Miles Davis");
        assert_eq!(album["title"], "Kind of Blue");
        assert_eq!(album["year"], 2020);
        assert_eq!(album["track_count"], 2);

        // Tracks filtered by album: {id, album_id, title, track_no, duration_secs}, ordered by track_no.
        let resp = app
            .oneshot(req(
                "GET",
                format!("/api/media/music/tracks?album_id={album_id}"),
            ))
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["total"], 2);
        let tracks = v["items"].as_array().unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0]["track_no"], 1);
        assert_eq!(tracks[0]["title"], "So What");
        assert_eq!(tracks[0]["album_id"], album_id);
        assert_eq!(tracks[0]["duration_secs"], 200);
        assert_eq!(tracks[1]["track_no"], 2);
        assert_eq!(tracks[1]["title"], "Freddie Freeloader");
    }
}
