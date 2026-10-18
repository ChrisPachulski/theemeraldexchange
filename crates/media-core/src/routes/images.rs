//! Resized WebP artwork: GET /images/{kind}/{id}?w= with kind `album`
//! (albums.art_path), `audiobook` (audiobooks.art_path), `photo`
//! (photos.path) or `tmdb` (id = a TMDB file name, fetched once from the
//! origin). The width snaps up to the artwork ladder; variants are cached
//! under `<data>/images/cache/{kind}/{id}/{w}.webp`.

use super::*;
use crate::artwork::{self, ArtworkError};

/// Width when `?w=` is absent (album `art_url`s carry none until the SPA
/// sends srcset widths).
const DEFAULT_WIDTH: u32 = 500;
const LOCAL_CACHE: &str = "private, max-age=86400";
/// TMDB file names are content-addressed: a name never changes its bytes.
const TMDB_CACHE: &str = "private, max-age=31536000, immutable";

enum Source {
    Local(String),
    Tmdb,
}

#[derive(Debug, Deserialize)]
pub(super) struct ImageQuery {
    w: Option<u32>,
}

pub(super) async fn get_image(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<ImageQuery>,
) -> AppResult<axum::response::Response> {
    let (id, source, cache_control) = if kind == "tmdb" {
        if !artwork::valid_tmdb_name(&id) {
            return Err(AppError::BadRequest("invalid tmdb image name".into()));
        }
        (id, Source::Tmdb, TMDB_CACHE)
    } else {
        let (id, path) = local_source(&state, &kind, &id).await?;
        (id, Source::Local(path), LOCAL_CACHE)
    };

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
            let original = match source {
                Source::Local(path) => tokio::fs::read(&path)
                    .await
                    .map_err(|_| AppError::NotFound)?,
                Source::Tmdb => artwork::tmdb_original(
                    &state.db,
                    &state.artwork,
                    &state.config.tmdb_image_base,
                    &id,
                )
                .await
                .map_err(|e| match e {
                    artwork::FetchError::NotFound => AppError::NotFound,
                    artwork::FetchError::Upstream(m) => AppError::Upstream(m),
                    artwork::FetchError::Db(e) => AppError::Db(e),
                    artwork::FetchError::Artwork(e) => AppError::Internal(e.to_string()),
                })?,
            };
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
            (axum::http::header::CACHE_CONTROL, cache_control),
        ],
        bytes,
    )
        .into_response())
}

/// The normalised id and source path of a local image, checked to sit inside
/// its kind's roots (on hits too, so a removed row or file stops serving its
/// cache).
async fn local_source(state: &AppState, kind: &str, id: &str) -> AppResult<(String, String)> {
    let (sql, mut roots) = match kind {
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
    if !path_within_roots(std::path::Path::new(&source), &roots).await {
        tracing::warn!(kind, path = %source, "refusing to serve image outside roots");
        return Err(AppError::NotFound);
    }
    Ok((id.to_string(), source))
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

    /// Status, content type, body.
    type Answer = (u16, &'static str, Vec<u8>);

    /// Loopback stand-in for image.tmdb.org: answers `/{file}` from a route
    /// table (status, content type, body; 3xx carries `Location: /good.jpg`)
    /// after `delay`, and counts every hit per file.
    #[derive(Clone, Default)]
    struct FakeOrigin {
        routes: Arc<std::sync::Mutex<HashMap<String, Answer>>>,
        hits: Arc<std::sync::Mutex<HashMap<String, usize>>>,
        delay: Duration,
    }

    use std::collections::HashMap;

    impl FakeOrigin {
        fn route(&self, file: &str, status: u16, ct: &'static str, body: Vec<u8>) {
            self.routes
                .lock()
                .unwrap()
                .insert(file.into(), (status, ct, body));
        }

        fn hits(&self, file: &str) -> usize {
            self.hits.lock().unwrap().get(file).copied().unwrap_or(0)
        }

        fn total(&self) -> usize {
            self.hits.lock().unwrap().values().sum()
        }

        /// Serve on 127.0.0.1 and return the base URL.
        async fn start(&self) -> String {
            async fn answer(
                State(fake): State<FakeOrigin>,
                Path(file): Path<String>,
            ) -> axum::response::Response {
                *fake.hits.lock().unwrap().entry(file.clone()).or_default() += 1;
                tokio::time::sleep(fake.delay).await;
                let route = fake.routes.lock().unwrap().get(&file).cloned();
                let (status, ct, body) = route.unwrap_or((404, "text/plain", Vec::new()));
                axum::response::Response::builder()
                    .status(status)
                    .header(axum::http::header::CONTENT_TYPE, ct)
                    .header(axum::http::header::LOCATION, "/good.jpg")
                    .body(axum::body::Body::from(body))
                    .unwrap()
            }
            let app = axum::Router::new()
                .route("/{file}", axum::routing::get(answer))
                .with_state(self.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            format!("http://{addr}")
        }
    }

    /// [`state_in`] with the TMDB origin at `base` and a `cap_bytes` store.
    async fn tmdb_state(tmp: &std::path::Path, base: String, cap_bytes: u64) -> AppState {
        let state = state_in(tmp).await;
        let mut config = (*state.config).clone();
        config.tmdb_image_base = base;
        config.image_cache_bytes = cap_bytes;
        AppState {
            artwork: Arc::new(artwork::Store::open(config.images_dir.clone(), cap_bytes)),
            config: Arc::new(config),
            ..state
        }
    }

    async fn get_tmdb(app: &axum::Router, file: &str, w: u32) -> StatusCode {
        let uri = format!("/api/media/images/tmdb/{file}?w={w}");
        let resp = app.clone().oneshot(req("GET", uri)).await.unwrap();
        let status = resp.status();
        if status == StatusCode::OK {
            assert_eq!(
                resp.headers()[axum::http::header::CACHE_CONTROL],
                "private, max-age=31536000, immutable"
            );
            let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(&body[8..12], b"WEBP");
        }
        status
    }

    async fn image_row(
        state: &AppState,
        key: &str,
    ) -> Option<(Option<String>, Option<String>, i64)> {
        sqlx::query_as("SELECT fetched_at, failed_at, attempts FROM images WHERE key = ?")
            .bind(key)
            .fetch_optional(&state.db.pool)
            .await
            .unwrap()
    }

    fn files_under(dir: &std::path::Path) -> usize {
        walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .count()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn tmdb_concurrent_and_later_requests_make_one_origin_hit() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeOrigin {
            delay: Duration::from_millis(300),
            ..Default::default()
        };
        fake.route("abc123.jpg", 200, "image/jpeg", png(600, 900));
        let state = tmdb_state(tmp.path(), fake.start().await, u64::MAX).await;
        let app = crate::build_router(state.clone());

        let (a, b, c) = tokio::join!(
            get_tmdb(&app, "abc123.jpg", 342),
            get_tmdb(&app, "abc123.jpg", 342),
            get_tmdb(&app, "abc123.jpg", 500),
        );
        assert_eq!([a, b, c], [StatusCode::OK; 3]);
        assert_eq!(get_tmdb(&app, "abc123.jpg", 342).await, StatusCode::OK);
        assert_eq!(get_tmdb(&app, "abc123.jpg", 780).await, StatusCode::OK);
        assert_eq!(fake.hits("abc123.jpg"), 1);
        assert!(tmp.path().join("images/orig/tmdb/abc123.jpg").is_file());
        let (fetched, failed, _) = image_row(&state, "tmdb/abc123.jpg").await.unwrap();
        assert!(fetched.is_some() && failed.is_none());
    }

    #[tokio::test]
    async fn tmdb_404_is_negative_cached_and_503_is_not() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeOrigin::default();
        fake.route("flaky.jpg", 503, "text/plain", Vec::new());
        let state = tmdb_state(tmp.path(), fake.start().await, u64::MAX).await;
        let app = crate::build_router(state.clone());

        assert_eq!(get_tmdb(&app, "gone.jpg", 92).await, StatusCode::NOT_FOUND);
        assert_eq!(get_tmdb(&app, "gone.jpg", 342).await, StatusCode::NOT_FOUND);
        assert_eq!(fake.hits("gone.jpg"), 1, "inside the cooldown");
        let (_, failed, attempts) = image_row(&state, "tmdb/gone.jpg").await.unwrap();
        assert!(failed.is_some());
        assert_eq!(attempts, 1);
        // Past the 7-day cooldown the origin is asked again.
        sqlx::query("UPDATE images SET failed_at = ? WHERE key = 'tmdb/gone.jpg'")
            .bind(
                (chrono::Utc::now() - chrono::Duration::days(8))
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            )
            .execute(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(get_tmdb(&app, "gone.jpg", 92).await, StatusCode::NOT_FOUND);
        assert_eq!(fake.hits("gone.jpg"), 2);

        assert_eq!(
            get_tmdb(&app, "flaky.jpg", 92).await,
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            get_tmdb(&app, "flaky.jpg", 92).await,
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(fake.hits("flaky.jpg"), 2, "a transient error is not cached");
        assert!(image_row(&state, "tmdb/flaky.jpg").await.is_none());
    }

    #[tokio::test]
    async fn tmdb_bad_names_are_400_before_any_fetch() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeOrigin::default();
        let state = tmdb_state(tmp.path(), fake.start().await, u64::MAX).await;
        let app = crate::build_router(state);
        let long = format!("{}.jpg", "a".repeat(65));
        for name in [
            "a.gif",
            "a.b.jpg",
            "ab_c.jpg",
            "x.JPG",
            ".jpg",
            "abc",
            "%2E%2E%2Fx.jpg",
            "x.jpg%00",
            long.as_str(),
        ] {
            assert_eq!(
                get_tmdb(&app, name, 92).await,
                StatusCode::BAD_REQUEST,
                "{name}"
            );
        }
        assert!(artwork::valid_tmdb_name(&format!(
            "{}.png",
            "Z9".repeat(32)
        )));
        assert_eq!(fake.total(), 0);
    }

    #[tokio::test]
    async fn tmdb_oversize_wrong_type_and_redirect_are_rejected_and_nothing_written() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeOrigin::default();
        fake.route(
            "big.jpg",
            200,
            "image/jpeg",
            vec![0; artwork::MAX_ORIGINAL_BYTES + 1],
        );
        fake.route("page.jpg", 200, "text/html", png(100, 150));
        fake.route("moved.jpg", 302, "text/plain", Vec::new());
        fake.route("good.jpg", 200, "image/png", png(100, 150));
        let state = tmdb_state(tmp.path(), fake.start().await, u64::MAX).await;
        let app = crate::build_router(state.clone());

        for name in ["big.jpg", "page.jpg", "moved.jpg"] {
            assert_eq!(
                get_tmdb(&app, name, 92).await,
                StatusCode::BAD_GATEWAY,
                "{name}"
            );
            assert_eq!(fake.hits(name), 1);
        }
        assert_eq!(fake.hits("good.jpg"), 0, "the redirect is not followed");
        assert_eq!(files_under(&tmp.path().join("images")), 0);
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM images")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[tokio::test]
    async fn tmdb_original_evicted_from_the_cap_is_fetched_again() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeOrigin::default();
        fake.route("evict1.jpg", 200, "image/jpeg", png(400, 600));
        // A 1-byte cap: each write evicts everything but itself, so the
        // variant write pushes the original out.
        let state = tmdb_state(tmp.path(), fake.start().await, 1).await;
        let app = crate::build_router(state.clone());

        assert_eq!(get_tmdb(&app, "evict1.jpg", 92).await, StatusCode::OK);
        assert_eq!(fake.hits("evict1.jpg"), 1);
        assert!(!tmp.path().join("images/orig/tmdb/evict1.jpg").exists());
        assert_eq!(files_under(&tmp.path().join("images")), 1);
        assert_eq!(get_tmdb(&app, "evict1.jpg", 92).await, StatusCode::OK);
        assert_eq!(fake.hits("evict1.jpg"), 1, "the variant is still cached");
        assert_eq!(get_tmdb(&app, "evict1.jpg", 185).await, StatusCode::OK);
        assert_eq!(fake.hits("evict1.jpg"), 2);
    }

    async fn json_at(app: &axum::Router, uri: &str) -> serde_json::Value {
        let resp = app.clone().oneshot(req("GET", uri)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{uri}");
        body_json(resp).await
    }

    async fn post_json(
        app: &axum::Router,
        uri: &str,
        body: serde_json::Value,
    ) -> serde_json::Value {
        let resp = app
            .clone()
            .oneshot(json_req("POST", uri, body.to_string()))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{uri}");
        body_json(resp).await
    }

    /// Every blurhash field the catalog rows carry, labelled by where it sits.
    async fn blurhash_fields(app: &axum::Router, ids: &Ids) -> Vec<(String, serde_json::Value)> {
        let mut out = Vec::new();
        let mut take =
            |label: &str, v: &serde_json::Value| out.push((label.to_string(), v.clone()));
        let movies = json_at(app, "/api/media/movies").await;
        take("movies list", &movies["items"][0]["poster_blurhash"]);
        let movies = json_at(app, "/api/media/movies?q=Heat").await;
        take("movies search", &movies["items"][0]["poster_blurhash"]);
        let movie = json_at(app, &format!("/api/media/movies/{}", ids.movie)).await;
        take("movie detail", &movie["poster_blurhash"]);
        let shows = json_at(app, "/api/media/shows").await;
        take("shows list", &shows["items"][0]["poster_blurhash"]);
        let shows = json_at(app, "/api/media/shows?q=Lost").await;
        take("shows search", &shows["items"][0]["poster_blurhash"]);
        let show = json_at(app, &format!("/api/media/shows/{}", ids.show)).await;
        take("show detail", &show["poster_blurhash"]);
        let watch = json_at(app, "/api/media/watch?sub=local:1").await;
        for item in watch["items"].as_array().unwrap() {
            take(
                &format!("watch {}", item["media_kind"]),
                &item["poster_blurhash"],
            );
        }
        let playlist = json_at(
            app,
            &format!("/api/media/playlists/{}?sub=local:1", ids.playlist),
        )
        .await;
        for item in playlist["items"].as_array().unwrap() {
            take(
                &format!("playlist {}", item["media_kind"]),
                &item["poster_blurhash"],
            );
        }
        let collection = json_at(
            app,
            &format!("/api/media/collections/{}?sub=local:1", ids.collection),
        )
        .await;
        for item in collection["items"].as_array().unwrap() {
            take(
                &format!("collection {}", item["media_kind"]),
                &item["poster_blurhash"],
            );
        }
        let albums = json_at(app, "/api/media/music/albums").await;
        take("albums list", &albums["items"][0]["art_blurhash"]);
        let books = json_at(app, "/api/media/audiobooks").await;
        take("audiobooks list", &books["items"][0]["art_blurhash"]);
        let book = json_at(app, &format!("/api/media/audiobooks/{}", ids.book)).await;
        take("audiobook detail", &book["art_blurhash"]);
        let photos = json_at(app, "/api/media/photos").await;
        for item in photos["items"].as_array().unwrap() {
            take(&format!("photo {}", item["id"]), &item["blurhash"]);
        }
        out
    }

    struct Ids {
        movie: i64,
        show: i64,
        book: i64,
        playlist: i64,
        collection: i64,
    }

    fn decodable(hash: &serde_json::Value) -> bool {
        hash.as_str()
            .is_some_and(|h| blurhash::decode(h, 8, 8, 1.0).is_ok_and(|px| px.len() == 8 * 8 * 4))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn blurhash_fields_are_null_until_the_backfill_then_decodable() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeOrigin::default();
        fake.route("heat.jpg", 200, "image/png", png(200, 300));
        fake.route("lost.jpg", 200, "image/png", png(300, 200));
        let state = tmdb_state(tmp.path(), fake.start().await, u64::MAX).await;

        let file_id = seed_media_file(&state, "/lib/heat.mkv").await;
        let movie: i64 = sqlx::query(
            "INSERT INTO movies (title, added_at, file_id, poster_path) VALUES ('Heat', '2026-01-01', ?, '/heat.jpg')",
        )
        .bind(file_id)
        .execute(&state.db.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        let show: i64 = sqlx::query(
            "INSERT INTO shows (title, added_at, poster_path) VALUES ('Lost', '2026-01-01', '/lost.jpg')",
        )
        .execute(&state.db.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        let ep_file = seed_media_file(&state, "/lib/lost-s01e01.mkv").await;
        let episode: i64 = sqlx::query(
            "INSERT INTO episodes (show_id, season, episode, title, file_id) VALUES (?, 1, 1, 'Pilot', ?)",
        )
        .bind(show)
        .bind(ep_file)
        .execute(&state.db.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        let cover = tmp.path().join("music/cover.png");
        std::fs::write(&cover, png(400, 400)).unwrap();
        album_with_art(&state, "LP", Some(&cover)).await;
        let book_art = tmp.path().join("artwork/book.png");
        std::fs::write(&book_art, png(300, 450)).unwrap();
        let book = audiobook(&state, &book_art).await;
        // Large enough that decodes overlap, so the pool is actually contended.
        for n in 0..6 {
            std::fs::write(tmp.path().join(format!("photos/p{n}.png")), png(1600, 1200)).unwrap();
        }
        crate::scanner::scan_photos_once(&state.db, &state.config.photo_roots, &state.artwork)
            .await
            .unwrap();

        let probe = state.artwork.pool.probe.clone();
        let app = crate::build_router(state.clone());
        for (kind, id) in [("movie", movie), ("episode", episode)] {
            post_json(
                &app,
                "/api/media/watch?sub=local:1",
                serde_json::json!({ "media_kind": kind, "media_id": id, "position_secs": 60 }),
            )
            .await;
        }
        let playlist = post_json(
            &app,
            "/api/media/playlists?sub=local:1",
            serde_json::json!({ "name": "P" }),
        )
        .await["id"]
            .as_i64()
            .unwrap();
        for (kind, id) in [("movie", movie), ("episode", episode)] {
            post_json(
                &app,
                &format!("/api/media/playlists/{playlist}/items?sub=local:1"),
                serde_json::json!({ "media_kind": kind, "media_id": id }),
            )
            .await;
        }
        let collection = post_json(
            &app,
            "/api/media/collections?sub=local:1",
            serde_json::json!({ "name": "C" }),
        )
        .await["id"]
            .as_i64()
            .unwrap();
        for (kind, id) in [("movie", movie), ("show", show)] {
            post_json(
                &app,
                &format!("/api/media/collections/{collection}/items?sub=local:1"),
                serde_json::json!({ "media_kind": kind, "media_id": id }),
            )
            .await;
        }
        let ids = Ids {
            movie,
            show,
            book,
            playlist,
            collection,
        };

        let before = blurhash_fields(&app, &ids).await;
        // 6 movie/show rows + 2 watch + 2 playlist + 2 collection + 3 local
        // rows + 6 photos.
        assert_eq!(before.len(), 21, "{before:?}");
        for (label, v) in &before {
            assert!(v.is_null(), "{label} before the backfill: {v}");
        }

        crate::run_extra_passes(&state, "test").await;
        for (label, v) in blurhash_fields(&app, &ids).await {
            assert!(decodable(&v), "{label} after the backfill: {v}");
        }
        let dims: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT key, width, height FROM images WHERE key IN ('tmdb/lost.jpg', 'photo/1')",
        )
        .fetch_all(&state.db.pool)
        .await
        .unwrap();
        assert_eq!(
            dims,
            [
                ("photo/1".into(), 1600, 1200),
                ("tmdb/lost.jpg".into(), 300, 200)
            ]
        );
        // 2 posters + album + audiobook + 6 photos, never more than 2 at once.
        let runs = probe.runs.load(std::sync::atomic::Ordering::SeqCst);
        let peak = probe.peak.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(runs, 10);
        assert!(
            (1..=artwork::POOL_PERMITS as u64).contains(&peak),
            "peak {peak}"
        );

        // A second pass describes nothing again.
        crate::run_extra_passes(&state, "test").await;
        assert_eq!(probe.runs.load(std::sync::atomic::Ordering::SeqCst), 10);
    }

    #[tokio::test]
    async fn a_changed_photo_clears_and_recomputes_its_blurhash_and_variants() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(tmp.path()).await;
        let shot = tmp.path().join("photos/shot.png");
        std::fs::write(&shot, png(300, 200)).unwrap();
        let scan = || {
            crate::scanner::scan_photos_once(&state.db, &state.config.photo_roots, &state.artwork)
        };
        scan().await.unwrap();
        crate::artwork::backfill(&state).await;
        let app = crate::build_router(state.clone());
        let blurhash =
            || async { json_at(&app, "/api/media/photos").await["items"][0]["blurhash"].clone() };
        let old = blurhash().await;
        assert!(decodable(&old));
        let id = json_at(&app, "/api/media/photos").await["items"][0]["id"]
            .as_i64()
            .unwrap();
        assert_eq!(
            get(&app, format!("/api/media/images/photo/{id}?w=92"))
                .await
                .0,
            StatusCode::OK
        );
        let variants = tmp.path().join(format!("images/cache/photo/{id}"));
        assert!(variants.is_dir());

        // Same name, new picture, new mtime.
        let solid = image::RgbImage::from_pixel(300, 200, image::Rgb([200, 10, 10]));
        std::fs::write(
            &shot,
            encode(&DynamicImage::ImageRgb8(solid), ImageFormat::Png),
        )
        .unwrap();
        std::fs::File::options()
            .append(true)
            .open(&shot)
            .unwrap()
            .set_modified(std::time::SystemTime::now() + Duration::from_secs(3600))
            .unwrap();
        assert_eq!(scan().await.unwrap().files_updated, 1);
        assert!(
            blurhash().await.is_null(),
            "the stale placeholder is dropped"
        );
        assert!(!variants.exists(), "the stale variants are dropped");

        crate::artwork::backfill(&state).await;
        let new = blurhash().await;
        assert!(decodable(&new));
        assert_ne!(new, old);
    }

    #[tokio::test]
    async fn prefetch_after_a_scan_stores_every_library_poster_once() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = FakeOrigin::default();
        for file in ["lib1.jpg", "lib2.png", "show1.jpg", "trend1.jpg"] {
            fake.route(file, 200, "image/jpeg", png(20, 30));
        }
        let state = tmdb_state(tmp.path(), fake.start().await, u64::MAX).await;
        for (n, poster) in [
            Some("/lib1.jpg"),
            Some("/lib2.png"),
            Some("/lib1.jpg"),
            None,
            Some("/bad_name.jpg"),
        ]
        .into_iter()
        .enumerate()
        {
            let file_id = seed_media_file(&state, &format!("/lib/m{n}.mkv")).await;
            sqlx::query(
                "INSERT INTO movies (title, added_at, file_id, poster_path) VALUES ('M', '2026-01-01', ?, ?)",
            )
            .bind(file_id)
            .bind(poster)
            .execute(&state.db.pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO shows (title, added_at, poster_path) VALUES ('S', '2026-01-01', '/show1.jpg')",
        )
        .execute(&state.db.pool)
        .await
        .unwrap();

        crate::run_extra_passes(&state, "test").await;
        for file in ["lib1.jpg", "lib2.png", "show1.jpg"] {
            assert_eq!(fake.hits(file), 1, "{file}");
            assert!(
                tmp.path()
                    .join(format!("images/orig/tmdb/{file}"))
                    .is_file()
            );
        }
        assert_eq!(
            fake.hits("trend1.jpg"),
            0,
            "non-library paths wait for a request"
        );
        assert_eq!(fake.total(), 3);

        crate::run_extra_passes(&state, "test").await;
        assert_eq!(fake.total(), 3, "a second pass fetches nothing");
    }
}
