//! Watch state.

use super::catalog::{fetch_episode_meta, fetch_movie_meta, media_exists};
use super::*;

#[derive(Debug, Deserialize)]
pub struct WatchQuery {
    pub sub: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WatchUpsert {
    pub media_kind: String,
    pub media_id: i64,
    pub position_secs: i64,
    #[serde(default)]
    pub duration_secs: Option<i64>,
    #[serde(default)]
    pub completed: bool,
}

pub(super) async fn get_watch(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;
    let rows = sqlx::query_as::<_, WatchStateRow>(
        "SELECT sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed \
         FROM media_watch_state WHERE sub = ? ORDER BY watched_at DESC",
    )
    .bind(&sub)
    .fetch_all(&state.db.pool)
    .await?;

    // Enrich each row with display metadata (title / poster / season / episode)
    // so the client's "continue watching" shelf renders a real title and poster
    // without a second round-trip or a local library join — the Home tab has
    // neither the show nor episode catalogs loaded, so an un-enriched episode row
    // could only show a generic "Episode" with no art. Extra fields are additive;
    // existing consumers ignore them.
    let movie_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.media_kind == "movie")
        .map(|r| r.media_id)
        .collect();
    let episode_ids: Vec<i64> = rows
        .iter()
        .filter(|r| r.media_kind == "episode")
        .map(|r| r.media_id)
        .collect();
    let movie_meta = fetch_movie_meta(&state, &movie_ids).await?;
    let episode_meta = fetch_episode_meta(&state, &episode_ids).await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut v = json!({
                "sub": r.sub,
                "media_kind": r.media_kind,
                "media_id": r.media_id,
                "position_secs": r.position_secs,
                "duration_secs": r.duration_secs,
                "watched_at": r.watched_at,
                "completed": r.completed,
            });
            let obj = v.as_object_mut().expect("json object");
            match r.media_kind.as_str() {
                "movie" => {
                    if let Some((title, poster)) = movie_meta.get(&r.media_id) {
                        obj.insert("title".into(), json!(title));
                        obj.insert("poster_path".into(), json!(poster));
                    }
                }
                "episode" => {
                    if let Some(e) = episode_meta.get(&r.media_id) {
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

    Ok(Json(json!({ "items": items })))
}

pub(super) async fn post_watch(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<WatchQuery>,
    Json(body): Json<WatchUpsert>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    let sub = acting_sub(&claims, q.sub, &state.config.principal_mode)?;

    // §7-8: validate (media_kind, media_id) against a real title before writing.
    // Without this an arbitrary/stale id silently creates an orphan or forgeable
    // watch row (no SQL FK can guard a polymorphic id). Unknown kind → 400;
    // known kind but absent id → 404. (The schema CHECK already constrains the
    // stored kind, but rejecting early gives the client a clear, non-500 error.)
    match media_exists(&state, &body.media_kind, body.media_id).await? {
        Some(true) => {}
        Some(false) => return Err(AppError::NotFound),
        None => {
            return Err(AppError::BadRequest(
                "media_kind must be one of movie, episode, track, audiobook, podcast_episode"
                    .into(),
            ));
        }
    }

    let watched_at = chrono::Utc::now().to_rfc3339();
    let completed = i64::from(body.completed);

    sqlx::query(
        "INSERT INTO media_watch_state \
         (sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(sub, media_kind, media_id) DO UPDATE SET \
         position_secs = excluded.position_secs, \
         duration_secs = excluded.duration_secs, \
         watched_at = excluded.watched_at, \
         completed = excluded.completed",
    )
    .bind(&sub)
    .bind(&body.media_kind)
    .bind(body.media_id)
    .bind(body.position_secs)
    .bind(body.duration_secs)
    .bind(&watched_at)
    .bind(completed)
    .execute(&state.db.pool)
    .await?;

    Ok(Json(json!({ "ok": true, "watched_at": watched_at })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use tower::ServiceExt;

    #[tokio::test]
    async fn watch_state_round_trips() {
        let state = test_state().await;
        // §7-8: watch-state now requires the title to exist, so seed a movie.
        let file_id = seed_media_file(&state, "/lib/watch.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        let app = crate::build_router(state);

        let post = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                json!({
                    "media_kind": "movie",
                    "media_id": movie_id,
                    "position_secs": 120,
                    "duration_secs": 3600,
                    "completed": false
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(post.status(), StatusCode::OK);

        let get = app
            .oneshot(req("GET", "/api/media/watch?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        let v = body_json(get).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["sub"], "plex:1");
        assert_eq!(items[0]["media_id"], movie_id);
        assert_eq!(items[0]["position_secs"], 120);
    }

    #[tokio::test]
    async fn watch_state_accepts_track_kind() {
        // Migration 0007 widened the kind CHECK; per-track resume must round-trip.
        let state = test_state().await;
        let (_, _, track_id) =
            seed_track(&state, "Artist", "Album", "Song", 1, "/music/a.flac").await;
        let app = crate::build_router(state);
        let post = app
            .clone()
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                json!({
                    "media_kind": "track",
                    "media_id": track_id,
                    "position_secs": 42,
                    "duration_secs": 200,
                    "completed": false
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(post.status(), StatusCode::OK);
        let v = body_json(
            app.oneshot(req("GET", "/api/media/watch?sub=plex:1"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(v["items"][0]["media_kind"], "track");
        assert_eq!(v["items"][0]["position_secs"], 42);
    }

    #[tokio::test]
    async fn post_watch_rejects_unknown_media_id() {
        // §7-8: posting watch-state for a nonexistent title must 404, not
        // silently create an orphan row.
        let state = test_state().await;
        let app = crate::build_router(state.clone());
        let resp = app
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                json!({
                    "media_kind": "movie",
                    "media_id": 9999,
                    "position_secs": 10,
                    "completed": false
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_watch_state")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "rejected watch must not create a row");
    }

    #[tokio::test]
    async fn post_watch_rejects_unknown_kind() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(json_req(
                "POST",
                "/api/media/watch?sub=plex:1",
                json!({
                    "media_kind": "playlist",
                    "media_id": 1,
                    "position_secs": 10,
                    "completed": false
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn gc_removes_orphaned_watch_rows() {
        // §7-8: the GC reaps watch rows whose (kind,id) no longer resolves
        // (title deleted / pre-validation forged rows) and keeps valid ones.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/gc.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        // A valid row (via the validated handler) + a forged orphan (direct).
        let _ = post_watch(
            State(state.clone()),
            None,
            Query(WatchQuery {
                sub: Some("plex:1".into()),
            }),
            Json(WatchUpsert {
                media_kind: "movie".into(),
                media_id: movie_id,
                position_secs: 5,
                duration_secs: None,
                completed: false,
            }),
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO media_watch_state \
             (sub, media_kind, media_id, position_secs, watched_at, completed) \
             VALUES ('plex:1', 'movie', 4242, 0, '0', 0)",
        )
        .execute(&state.db.pool)
        .await
        .unwrap();

        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_watch_state")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(before, 2);

        let removed = crate::scanner::gc_orphan_watch_state(&state.db)
            .await
            .unwrap();
        assert_eq!(removed, 1, "exactly the orphan row is reaped");
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_watch_state")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(after, 1, "the valid watch row survives GC");
    }

    /// Cross-platform continue-watching contract (M3 crit 4/5): resume position
    /// is scoped to the ACCOUNT (`sub`), never the device. Two device tokens for
    /// the same account — e.g. the web SPA and the native tvOS client — both
    /// resolve to the same `sub`, so progress written from one device is the
    /// resume point on the other; a different account sees none of it. This is
    /// the backend half of the sync the Apple client (sibling repo, native
    /// continue-watching) consumes over `/api/media/watch`.
    #[tokio::test]
    async fn resume_state_is_account_scoped_across_devices() {
        use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims};

        let now = 1_748_000_000;
        let device = |sub: &str, device_id: &str| {
            Some(InternalClaims {
                iss: "eex".into(),
                sub: sub.into(),
                role: "user".into(),
                auth_mode: "plex".into(),
                server_id: "srv".into(),
                device_id: Some(device_id.into()),
                req_id: "r1".into(),
                iat: now,
                exp: now + DEFAULT_TTL_SECS,
            })
        };

        // (1) Auth layer: the SAME account on two DIFFERENT devices resolves to
        // one identity; a different account is isolated. Device id is irrelevant
        // to the resume key by construction.
        let web = device("plex:42", "web-session-A");
        let tv = device("plex:42", "appletv-B");
        let other = device("plex:99", "web-session-C");
        assert_eq!(
            acting_sub(&web, None, &PrincipalMode::Enforce).unwrap(),
            acting_sub(&tv, None, &PrincipalMode::Enforce).unwrap(),
            "same account, different device → same resume identity"
        );
        assert_eq!(
            acting_sub(&tv, None, &PrincipalMode::Enforce).unwrap(),
            "plex:42"
        );
        assert_ne!(
            acting_sub(&other, None, &PrincipalMode::Enforce).unwrap(),
            "plex:42",
            "a different account must not share the resume identity"
        );

        // (2) Store layer: write progress as the resolved sub (web), read it back
        // as the same sub (tvOS) → same position. A different account reads none.
        // This is exactly the SQL the get/post_watch handlers run, keyed only on
        // `sub` — there is no device column in media_watch_state.
        let state = test_state().await;
        let watched_at = "2026-06-17T00:00:00Z";
        sqlx::query(
            "INSERT INTO media_watch_state \
             (sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed) \
             VALUES (?, 'movie', 7, 1800, 5400, ?, 0)",
        )
        .bind("plex:42")
        .bind(watched_at)
        .execute(&state.db.pool)
        .await
        .unwrap();

        let resume_on_tv: Option<i64> = sqlx::query_scalar(
            "SELECT position_secs FROM media_watch_state WHERE sub = ? AND media_id = 7",
        )
        .bind("plex:42")
        .fetch_optional(&state.db.pool)
        .await
        .unwrap();
        assert_eq!(
            resume_on_tv,
            Some(1800),
            "progress written by web is the resume point on tvOS (same account)"
        );

        let leak: Option<i64> = sqlx::query_scalar(
            "SELECT position_secs FROM media_watch_state WHERE sub = ? AND media_id = 7",
        )
        .bind("plex:99")
        .fetch_optional(&state.db.pool)
        .await
        .unwrap();
        assert_eq!(leak, None, "a different account sees no resume state");
    }
}
