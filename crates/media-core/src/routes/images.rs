//! Resized WebP artwork for local sources: GET /images/{kind}/{id}?w= with
//! kind `album` (albums.art_path), `audiobook` (audiobooks.art_path) or
//! `photo` (photos.path). The width snaps up to the artwork ladder; variants
//! are cached under `<data>/images/cache/{kind}/{id}/{w}.webp`.

use super::*;
use crate::artwork::{self, ArtworkError};

/// Width when `?w=` is absent (album `art_url`s carry none until the SPA
/// sends srcset widths).
const DEFAULT_WIDTH: u32 = 500;

#[derive(Debug, Deserialize)]
pub(super) struct ImageQuery {
    w: Option<u32>,
}

pub(super) async fn get_image(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<ImageQuery>,
) -> AppResult<axum::response::Response> {
    let (sql, mut roots) = match kind.as_str() {
        "album" => (
            "SELECT art_path FROM albums WHERE id = ?",
            state.config.music_roots.clone(),
        ),
        "audiobook" => (
            "SELECT art_path FROM audiobooks WHERE id = ?",
            state.config.audiobook_roots.clone(),
        ),
        "photo" => (
            "SELECT path FROM photos WHERE id = ?",
            state.config.photo_roots.clone(),
        ),
        _ => return Err(AppError::NotFound),
    };
    // Extracted embedded covers live in the artwork dir; photos never do.
    if kind != "photo" {
        roots.push(state.config.artwork_dir.clone());
    }
    let id: i64 = id.parse().map_err(|_| AppError::NotFound)?;
    let source: Option<Option<String>> = sqlx::query_scalar(sql)
        .bind(id)
        .fetch_optional(&state.db.pool)
        .await?;
    let source = source.flatten().ok_or(AppError::NotFound)?;
    // Checked on hits too, so a removed row or file stops serving its cache.
    if !path_within_roots(std::path::Path::new(&source), &roots).await {
        tracing::warn!(kind, path = %source, "refusing to serve image outside roots");
        return Err(AppError::NotFound);
    }

    let w = artwork::snap_width(q.w.unwrap_or(DEFAULT_WIDTH));
    let key = format!("{kind}/{id}/{w}.webp");
    // A hit reads on the plain blocking pool, not the 2-permit CPU pool, so it
    // never queues behind builds.
    let hit = {
        let (store, key) = (state.artwork.clone(), key.clone());
        tokio::task::spawn_blocking(move || store.get(&key).and_then(|p| std::fs::read(p).ok()))
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?
    };
    let bytes = match hit {
        Some(bytes) => bytes,
        None => {
            let original = tokio::fs::read(&source)
                .await
                .map_err(|_| AppError::NotFound)?;
            let store = state.artwork.clone();
            // ponytail: concurrent misses on one variant each build it (the
            // pool caps that at 2 jobs; the last rename wins). Add a per-key
            // in-flight map if cold grids show the duplicate work mattering.
            state
                .artwork
                .pool
                .run(move || -> Result<Vec<u8>, ArtworkError> {
                    let webp = artwork::variant(&artwork::decode(&original)?, w)?;
                    if let Err(e) = store.put(&key, &webp) {
                        tracing::warn!(key, "image cache write failed: {e}");
                    }
                    Ok(webp)
                })
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?
                .map_err(|e| match e {
                    ArtworkError::Decode(_) => AppError::Unsupported(e.to_string()),
                    e => AppError::Internal(e.to_string()),
                })?
        }
    };
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "image/webp"),
            (axum::http::header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artwork::fixtures::{encode, gradient, jpeg_with_orientation_6};
    use crate::routes::testsupport::*;

    use image::{DynamicImage, ImageFormat};
    use std::os::unix::fs::MetadataExt;
    use std::sync::Arc;
    use std::time::Duration;
    use tower::ServiceExt;

    /// State whose roots, artwork dir and image store all live under `tmp`.
    async fn state_in(tmp: &std::path::Path) -> AppState {
        let base = test_state().await;
        let mut config = (*base.config).clone();
        config.music_roots = vec![tmp.join("music")];
        config.audiobook_roots = vec![tmp.join("books")];
        config.photo_roots = vec![tmp.join("photos")];
        config.artwork_dir = tmp.join("artwork");
        config.images_dir = tmp.join("images");
        for d in ["music", "books", "photos", "artwork", "elsewhere"] {
            std::fs::create_dir_all(tmp.join(d)).unwrap();
        }
        AppState {
            artwork: Arc::new(artwork::Store::open(
                config.images_dir.clone(),
                config.image_cache_bytes,
            )),
            config: Arc::new(config),
            ..base
        }
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        encode(&DynamicImage::ImageRgb8(gradient(w, h)), ImageFormat::Png)
    }

    async fn album_with_art(state: &AppState, title: &str, art: Option<&std::path::Path>) -> i64 {
        let (_, album_id, _) = seed_track(
            state,
            "Artist",
            title,
            "Track",
            1,
            &format!("/m/{title}.flac"),
        )
        .await;
        sqlx::query("UPDATE albums SET art_path = ? WHERE id = ?")
            .bind(art.map(|p| p.to_str().unwrap().to_string()))
            .bind(album_id)
            .execute(&state.db.pool)
            .await
            .unwrap();
        album_id
    }

    async fn photo(state: &AppState, path: &std::path::Path) -> i64 {
        sqlx::query("INSERT INTO photos (path, size_bytes, mtime, scanned_at) VALUES (?, 1, ?, ?)")
            .bind(path.to_str().unwrap())
            .bind("2026-01-01T00:00:00Z")
            .bind("2026-01-01T00:00:00Z")
            .execute(&state.db.pool)
            .await
            .unwrap()
            .last_insert_rowid()
    }

    async fn audiobook(state: &AppState, art: &std::path::Path) -> i64 {
        let file_id = seed_media_file(state, "/b/book.m4b").await;
        sqlx::query(
            "INSERT INTO audiobooks (media_file_id, author, title, art_path) VALUES (?, 'A', 'B', ?)",
        )
        .bind(file_id)
        .bind(art.to_str().unwrap())
        .execute(&state.db.pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    async fn get(app: &axum::Router, uri: String) -> (StatusCode, Vec<u8>) {
        let resp = app.clone().oneshot(req("GET", uri)).await.unwrap();
        let status = resp.status();
        if status == StatusCode::OK {
            let h = resp.headers();
            assert_eq!(h[axum::http::header::CONTENT_TYPE], "image/webp");
            assert_eq!(
                h[axum::http::header::CACHE_CONTROL],
                "private, max-age=86400"
            );
        }
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, body.to_vec())
    }

    fn webp_dims(bytes: &[u8]) -> (u32, u32) {
        assert_eq!(&bytes[12..16], b"VP8 ", "lossy WebP");
        let img = image::load_from_memory_with_format(bytes, ImageFormat::WebP).unwrap();
        (img.width(), img.height())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_art_is_snapped_webp_and_the_second_request_hits_the_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(tmp.path()).await;
        let cover = tmp.path().join("music/cover.png");
        std::fs::write(&cover, png(600, 600)).unwrap();
        let album = album_with_art(&state, "LP", Some(&cover)).await;
        // EXIF orientation 6: stored landscape, displayed portrait.
        let shot = tmp.path().join("photos/rotated.jpg");
        std::fs::write(&shot, jpeg_with_orientation_6(400, 200)).unwrap();
        let photo_id = photo(&state, &shot).await;
        // Extracted cover in the artwork dir (outside the audiobook roots).
        let book_art = tmp.path().join("artwork/book.png");
        std::fs::write(&book_art, png(800, 1200)).unwrap();
        let book = audiobook(&state, &book_art).await;
        let pool = state.artwork.pool.clone();
        let app = crate::build_router(state);

        let (s, album_webp) = get(&app, format!("/api/media/images/album/{album}?w=300")).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(webp_dims(&album_webp), (342, 342));
        let (s, b) = get(&app, format!("/api/media/images/photo/{photo_id}?w=150")).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(
            webp_dims(&b),
            (185, 370),
            "rotated photo comes back upright"
        );
        let (s, b) = get(&app, format!("/api/media/images/audiobook/{book}?w=500")).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(webp_dims(&b), (500, 750));

        let cached = tmp
            .path()
            .join(format!("images/cache/album/{album}/342.webp"));
        let inode = std::fs::metadata(&cached).unwrap().ino();

        // Hold both pool permits: a build now waits, a cache hit must not.
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
        let mut holders = Vec::new();
        for _ in 0..artwork::POOL_PERMITS {
            let (pool, rx, tx) = (pool.clone(), release_rx.clone(), entered_tx.clone());
            holders.push(tokio::spawn(async move {
                pool.run(move || {
                    tx.send(()).unwrap();
                    let _ = rx.lock().unwrap().recv();
                })
                .await
                .unwrap()
            }));
        }
        for _ in 0..artwork::POOL_PERMITS {
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }

        let (s, again) = tokio::time::timeout(
            Duration::from_secs(5),
            get(&app, format!("/api/media/images/album/{album}?w=300")),
        )
        .await
        .expect("a cache hit never waits for the pool");
        assert_eq!(s, StatusCode::OK);
        assert_eq!(again, album_webp);
        assert_eq!(
            std::fs::metadata(&cached).unwrap().ino(),
            inode,
            "served from the cache, not rebuilt"
        );
        // Another width is a miss, and a miss does wait for the pool.
        assert!(
            tokio::time::timeout(
                Duration::from_millis(300),
                get(&app, format!("/api/media/images/album/{album}?w=780")),
            )
            .await
            .is_err()
        );

        for _ in 0..artwork::POOL_PERMITS {
            release_tx.send(()).unwrap();
        }
        for h in holders {
            h.await.unwrap();
        }
    }

    #[tokio::test]
    async fn outside_roots_unknown_kind_missing_and_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(tmp.path()).await;
        let stray = tmp.path().join("elsewhere/cover.png");
        std::fs::write(&stray, png(100, 100)).unwrap();
        let outside_album = album_with_art(&state, "Stray", Some(&stray)).await;
        let outside_photo = photo(&state, &stray).await;
        let artless = album_with_art(&state, "Bare", None).await;
        let gone = album_with_art(&state, "Gone", Some(&tmp.path().join("music/gone.png"))).await;
        let corrupt_path = tmp.path().join("photos/broken.jpg");
        std::fs::write(&corrupt_path, b"not an image at all").unwrap();
        let corrupt = photo(&state, &corrupt_path).await;
        let app = crate::build_router(state);

        for uri in [
            format!("/api/media/images/album/{outside_album}"),
            format!("/api/media/images/photo/{outside_photo}"),
            format!("/api/media/images/album/{artless}"),
            format!("/api/media/images/album/{gone}"),
            "/api/media/images/album/9999".to_string(),
            "/api/media/images/album/abc".to_string(),
            "/api/media/images/poster/1".to_string(),
        ] {
            assert_eq!(
                get(&app, uri.clone()).await.0,
                StatusCode::NOT_FOUND,
                "{uri}"
            );
        }
        assert_eq!(
            get(&app, format!("/api/media/images/photo/{corrupt}?w=92"))
                .await
                .0,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }

    #[tokio::test]
    async fn album_list_points_at_the_image_route_and_the_old_art_route_is_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(tmp.path()).await;
        let cover = tmp.path().join("music/cover.png");
        std::fs::write(&cover, png(50, 50)).unwrap();
        let album = album_with_art(&state, "LP", Some(&cover)).await;
        let app = crate::build_router(state);

        let albums = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/music/albums"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            albums["items"][0]["art_url"],
            format!("/api/media/images/album/{album}")
        );
        let old = app
            .oneshot(req("GET", format!("/api/media/music/albums/{album}/art")))
            .await
            .unwrap();
        assert_eq!(old.status(), StatusCode::NOT_FOUND);
    }
}
