//! Library read APIs.

use super::stream::{mint_transcoder_principal, transcoder_http};
use super::*;

pub(super) async fn list_movies(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    // §7-7: case/diacritic-insensitive, index-backed search via FTS5 MATCH —
    // replaces the old leading-wildcard `LIKE '%'||?||'%'` (full table scan +
    // a second full-scan COUNT, and ASCII-case-only with no diacritic folding).
    // The FTS join also yields the count without a second scan.
    let (rows, total) = match q.q.as_deref().and_then(fts_query) {
        Some(expr) => {
            let rows = sqlx::query_as::<_, MovieRow>(
                "SELECT m.id, m.tmdb_id, m.imdb_id, m.title, m.year, m.added_at, m.file_id, \
                 m.overview, m.poster_path, m.content_rating \
                 FROM movies m JOIN movies_fts f ON f.rowid = m.id \
                 WHERE movies_fts MATCH ? ORDER BY m.title LIMIT ? OFFSET ?",
            )
            .bind(&expr)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM movies m JOIN movies_fts f ON f.rowid = m.id \
                 WHERE movies_fts MATCH ?",
            )
            .bind(&expr)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, MovieRow>(
                "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id, overview, \
                 poster_path, content_rating \
                 FROM movies ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM movies")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

pub(super) async fn get_movie(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, MovieRow>(
        "SELECT id, tmdb_id, imdb_id, title, year, added_at, file_id, overview, poster_path, \
         content_rating \
         FROM movies WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

pub(super) async fn list_shows(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    // §7-7: FTS5 MATCH instead of leading-wildcard LIKE (see list_movies).
    let (rows, total) = match q.q.as_deref().and_then(fts_query) {
        Some(expr) => {
            let rows = sqlx::query_as::<_, ShowRow>(
                "SELECT s.id, s.tmdb_id, s.tvdb_id, s.title, s.year, s.added_at, s.imdb_id, \
                 s.overview, s.poster_path, s.content_rating \
                 FROM shows s JOIN shows_fts f ON f.rowid = s.id \
                 WHERE shows_fts MATCH ? ORDER BY s.title LIMIT ? OFFSET ?",
            )
            .bind(&expr)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM shows s JOIN shows_fts f ON f.rowid = s.id \
                 WHERE shows_fts MATCH ?",
            )
            .bind(&expr)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, ShowRow>(
                "SELECT id, tmdb_id, tvdb_id, title, year, added_at, imdb_id, overview, \
                 poster_path, content_rating \
                 FROM shows ORDER BY title LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shows")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

pub(super) async fn get_show(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, ShowRow>(
        "SELECT id, tmdb_id, tvdb_id, title, year, added_at, imdb_id, overview, poster_path, \
         content_rating \
         FROM shows WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

pub(super) async fn list_episodes(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path(show_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, EpisodeRow>(
        "SELECT id, show_id, season, episode, title, air_date, file_id \
         FROM episodes WHERE show_id = ? ORDER BY season, episode",
    )
    .bind(show_id)
    .fetch_all(&state.db.pool)
    .await?;
    // Fire-and-forget: warm the continue episode's keyframes while the user reads
    // this detail page, so a copy-remux first play scrubs instead of showing the
    // LIVE badge — no latency on the play path. Best-effort; never blocks the list.
    tokio::spawn(prewarm_continue_episode(
        state.clone(),
        claims.map(|Extension(c)| c),
        show_id,
    ));
    Ok(Json(json!({ "items": rows })))
}

/// Index of the "continue" episode in a play-ordered episode list: the first the
/// user hasn't completed (a mid-episode resume AND the fresh next episode after
/// finishing one). Falls back to 0 (the first) when all are completed or there is
/// no watch history. `eps` tuples are `(id, season, episode, path)`.
pub(super) fn continue_episode_index(eps: &[(i64, i64, i64, String)], completed: &[i64]) -> usize {
    eps.iter()
        .position(|(id, ..)| !completed.contains(id))
        .unwrap_or(0)
}

/// Browse-time keyframe prewarm (best-effort, fire-and-forget). The client calls
/// `list_episodes` when a show's detail page opens; we use that as the signal to
/// warm the keyframe cache for the episode the user is most likely to play — the
/// "continue" episode: the first episode in play order they haven't completed
/// (covers both a mid-episode resume AND the fresh next episode after finishing
/// one — the common binge case), else the first downloaded (fresh start). This
/// mirrors the client's hero "continue episode". The ~17s probe runs while the
/// user reads the page, so by the time Play is pressed the copy-remux manifest is
/// a finite VOD (real scrubber) instead of AVPlayer's LIVE chrome — with NO added
/// latency on the play path. Any failure (no transcoder, no downloaded file,
/// DB/network error) is swallowed: this only ever makes the next play nicer. See
/// `POST /api/transcode/warm`.
pub(super) async fn prewarm_continue_episode(
    state: AppState,
    claims: Option<InternalClaims>,
    show_id: i64,
) {
    // Downloaded episodes for this show, in play order, with their backing path.
    let eps = sqlx::query_as::<_, (i64, i64, i64, String)>(
        "SELECT e.id, e.season, e.episode, m.path \
         FROM episodes e JOIN media_files m ON m.id = e.file_id \
         WHERE e.show_id = ? AND e.file_id IS NOT NULL \
         ORDER BY e.season, e.episode",
    )
    .bind(show_id)
    .fetch_all(&state.db.pool)
    .await
    .unwrap_or_default();
    if eps.is_empty() {
        return;
    }

    // The continue episode = the first in play order the user hasn't completed.
    // (`position_secs > 0` alone missed the just-finished-an-episode → next-fresh
    // case, the most common binge flow.) No claims → the first downloaded.
    let completed: Vec<i64> = if let Some(c) = claims.as_ref() {
        sqlx::query_scalar(
            "SELECT media_id FROM media_watch_state \
             WHERE sub = ? AND media_kind = 'episode' AND completed = 1",
        )
        .bind(&c.sub)
        .fetch_all(&state.db.pool)
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    let chosen = &eps[continue_episode_index(&eps, &completed)];
    warm_path(&state, &claims, &chosen.3).await;
}

/// On an episode play grant, warm the NEXT downloaded episode's keyframes so
/// autoplay-next also scrubs from its first play (same copy-remux EVENT-vs-VOD
/// reason as the browse prewarm). Best-effort, fire-and-forget; a no-op for the
/// last episode (or a movie, whose grant never calls this).
pub(super) async fn prewarm_next_episode(
    state: AppState,
    claims: Option<InternalClaims>,
    episode_id: i64,
) {
    let Ok(Some((show_id, season, episode))) = sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT show_id, season, episode FROM episodes WHERE id = ?",
    )
    .bind(episode_id)
    .fetch_optional(&state.db.pool)
    .await
    else {
        return;
    };
    // First downloaded episode strictly after this one in play order.
    let next = sqlx::query_as::<_, (String,)>(
        "SELECT m.path FROM episodes e JOIN media_files m ON m.id = e.file_id \
         WHERE e.show_id = ? AND e.file_id IS NOT NULL \
         AND (e.season > ? OR (e.season = ? AND e.episode > ?)) \
         ORDER BY e.season, e.episode LIMIT 1",
    )
    .bind(show_id)
    .bind(season)
    .bind(season)
    .bind(episode)
    .fetch_optional(&state.db.pool)
    .await
    .ok()
    .flatten();
    if let Some((path,)) = next {
        warm_path(&state, &claims, &path).await;
    }
}

/// Fire `POST /api/transcode/warm` for one file (best-effort). Shared by the
/// browse prewarm and the autoplay-next grant warm. Swallows every failure — a
/// warm only ever makes the next play nicer, it never blocks one.
pub(super) async fn warm_path(state: &AppState, claims: &Option<InternalClaims>, path: &str) {
    let Some(transcoder_url) = state.config.transcoder_url.as_deref() else {
        return;
    };
    let url = format!(
        "{}/api/transcode/warm",
        transcoder_url.trim_end_matches('/')
    );
    let mut request = transcoder_http().post(&url).json(&json!({ "path": path }));
    if let Some(bearer) = mint_transcoder_principal(state, claims) {
        request = request.bearer_auth(bearer);
    }
    if let Err(e) = request.send().await {
        tracing::debug!(error = %e, "keyframe warm request failed (best-effort)");
    }
}

/// Flat, paginated episodes feed (mirrors `list_movies`): returns
/// `{items, total}` with optional `?q=` title filter and `?limit`/`?offset`.
/// Fixes the empty-body `GET /api/media/episodes` (no collection route).
pub(super) async fn list_episodes_all(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let (limit, offset) = paginate(q.limit, q.offset);

    // §7-7: FTS5 MATCH instead of leading-wildcard LIKE (see list_movies). The
    // episodes_fts index is on title+overview; ordering stays show/season/episode.
    let (rows, total) = match q.q.as_deref().and_then(fts_query) {
        Some(expr) => {
            let rows = sqlx::query_as::<_, EpisodeRow>(
                "SELECT e.id, e.show_id, e.season, e.episode, e.title, e.air_date, e.file_id \
                 FROM episodes e JOIN episodes_fts f ON f.rowid = e.id \
                 WHERE episodes_fts MATCH ? ORDER BY e.show_id, e.season, e.episode \
                 LIMIT ? OFFSET ?",
            )
            .bind(&expr)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM episodes e JOIN episodes_fts f ON f.rowid = e.id \
                 WHERE episodes_fts MATCH ?",
            )
            .bind(&expr)
            .fetch_one(&state.db.pool)
            .await?;
            (rows, total)
        }
        _ => {
            let rows = sqlx::query_as::<_, EpisodeRow>(
                "SELECT id, show_id, season, episode, title, air_date, file_id \
                 FROM episodes ORDER BY show_id, season, episode LIMIT ? OFFSET ?",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db.pool)
            .await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM episodes")
                .fetch_one(&state.db.pool)
                .await?;
            (rows, total)
        }
    };

    Ok(Json(json!({ "items": rows, "total": total })))
}

pub(super) async fn get_episode(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, EpisodeRow>(
        "SELECT id, show_id, season, episode, title, air_date, file_id \
         FROM episodes WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!(row)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use tower::ServiceExt;

    fn ep(id: i64, season: i64, episode: i64) -> (i64, i64, i64, String) {
        (id, season, episode, format!("/lib/s{season}e{episode}.mkv"))
    }

    #[test]
    fn continue_episode_is_first_uncompleted_not_just_in_progress() {
        let eps = [ep(101, 1, 1), ep(102, 1, 2), ep(103, 1, 3)];
        // Regression: just finished E1 & E2 (completed), E3 fresh (no watch row).
        // The old `position_secs > 0` logic warmed E1; the continue episode is E3.
        assert_eq!(continue_episode_index(&eps, &[101, 102]), 2);
        // Mid-episode resume: E2 in progress (not completed) → E2.
        assert_eq!(continue_episode_index(&eps, &[101]), 1);
        // No history → the first downloaded.
        assert_eq!(continue_episode_index(&eps, &[]), 0);
        // Whole show completed → fall back to the first (rewatch from the top).
        assert_eq!(continue_episode_index(&eps, &[101, 102, 103]), 0);
    }

    #[tokio::test]
    async fn list_movies_returns_seeded_movie() {
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/a.mp4").await;
        sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
            .bind("The Matrix")
            .bind(1999_i64)
            .bind("2026-01-01T00:00:00Z")
            .bind(file_id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        let app = crate::build_router(state);
        let resp = app.oneshot(req("GET", "/api/media/movies")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 1);
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        assert_eq!(v["items"][0]["title"], "The Matrix");
    }

    #[tokio::test]
    async fn list_and_get_movie_expose_content_rating() {
        // S2 item S3: the /api/media movie payloads must carry the US
        // certification the Apple parental gate filters on. Red on origin/main
        // (no content_rating column, so the seed INSERT fails and the field is
        // absent from the response); green once migration 0010 + the SELECT
        // projection land.
        let state = test_state().await;
        let rated = seed_media_file(&state, "/lib/rated.mp4").await;
        let unrated = seed_media_file(&state, "/lib/unrated.mp4").await;
        sqlx::query(
            "INSERT INTO movies (title, year, added_at, file_id, content_rating) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind("Restricted Film")
        .bind(1999_i64)
        .bind("2026-01-01T00:00:00Z")
        .bind(rated)
        .bind("R")
        .execute(&state.db.pool)
        .await
        .unwrap();
        // A row with no rating must serialize the field as JSON null (unknown),
        // not omit it — the client decodes `content_rating: String?`.
        let unrated_id: i64 =
            sqlx::query("INSERT INTO movies (title, added_at, file_id) VALUES (?, ?, ?)")
                .bind("Unknown Rating")
                .bind("2026-01-01T00:00:00Z")
                .bind(unrated)
                .execute(&state.db.pool)
                .await
                .unwrap()
                .last_insert_rowid();

        let app = crate::build_router(state);

        let list = body_json(
            app.clone()
                .oneshot(req("GET", "/api/media/movies"))
                .await
                .unwrap(),
        )
        .await;
        let items = list["items"].as_array().unwrap();
        let rated_item = items
            .iter()
            .find(|i| i["title"] == "Restricted Film")
            .expect("rated movie present");
        assert_eq!(rated_item["content_rating"], "R");
        let unrated_item = items
            .iter()
            .find(|i| i["title"] == "Unknown Rating")
            .expect("unrated movie present");
        assert!(
            unrated_item["content_rating"].is_null(),
            "an un-enriched movie must expose content_rating: null, got {:?}",
            unrated_item["content_rating"]
        );

        // The single-item detail route projects it too.
        let detail = body_json(
            app.oneshot(req("GET", format!("/api/media/movies/{unrated_id}")))
                .await
                .unwrap(),
        )
        .await;
        assert!(detail["content_rating"].is_null());
    }

    #[tokio::test]
    async fn list_shows_exposes_content_rating() {
        // Show half of the S3 gate: the parental gate must see a show's rating
        // too. Red on origin/main (no column / no projection).
        let state = test_state().await;
        sqlx::query("INSERT INTO shows (title, added_at, content_rating) VALUES (?, ?, ?)")
            .bind("Mature Series")
            .bind("2026-01-01T00:00:00Z")
            .bind("TV-MA")
            .execute(&state.db.pool)
            .await
            .unwrap();

        let app = crate::build_router(state);
        let list = body_json(app.oneshot(req("GET", "/api/media/shows")).await.unwrap()).await;
        let item = list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["title"] == "Mature Series")
            .expect("show present");
        assert_eq!(item["content_rating"], "TV-MA");
    }

    #[tokio::test]
    async fn get_movie_missing_is_404() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(req("GET", "/api/media/movies/9999"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_episodes_is_ordered() {
        let state = test_state().await;
        let show_id: i64 = sqlx::query("INSERT INTO shows (title, added_at) VALUES (?, ?)")
            .bind("Foo")
            .bind("2026-01-01T00:00:00Z")
            .execute(&state.db.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        let f1 = seed_media_file(&state, "/lib/s1e2.mp4").await;
        let f2 = seed_media_file(&state, "/lib/s1e1.mp4").await;
        // Insert out of order; query must return season,episode order.
        sqlx::query(
            "INSERT INTO episodes (show_id, season, episode, title, file_id) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(show_id)
        .bind(1_i64)
        .bind(2_i64)
        .bind("Ep2")
        .bind(f1)
        .execute(&state.db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO episodes (show_id, season, episode, title, file_id) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(show_id)
        .bind(1_i64)
        .bind(1_i64)
        .bind("Ep1")
        .bind(f2)
        .execute(&state.db.pool)
        .await
        .unwrap();

        let app = crate::build_router(state);
        let resp = app
            .oneshot(req("GET", format!("/api/media/shows/{show_id}/episodes")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["episode"], 1);
        assert_eq!(items[1]["episode"], 2);
    }

    #[tokio::test]
    async fn movie_search_is_case_and_diacritic_insensitive() {
        // §7-7: FTS5 unicode61 + remove_diacritics=2 folds case and diacritics,
        // which the old ASCII-only leading-wildcard LIKE could not do.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/amelie.mkv").await;
        sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
            .bind("Amélie")
            .bind(2001_i64)
            .bind("2026-01-01T00:00:00Z")
            .bind(file_id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        async fn search(state: &AppState, term: &str) -> i64 {
            let v = list_movies(
                State(state.clone()),
                Query(ListQuery {
                    q: Some(term.to_string()),
                    limit: None,
                    offset: None,
                }),
            )
            .await
            .unwrap();
            v.0["total"].as_i64().unwrap()
        }

        assert_eq!(search(&state, "amelie").await, 1, "diacritic-folded match");
        assert_eq!(search(&state, "AMÉLIE").await, 1, "case-folded match");
        assert_eq!(search(&state, "ame").await, 1, "prefix match");
        assert_eq!(search(&state, "zzz").await, 0, "non-match returns nothing");
    }

    async fn seed_show_with_episodes(state: &AppState, n: i64) {
        let show_id: i64 =
            sqlx::query("INSERT INTO shows (title, norm_title, added_at) VALUES (?, ?, ?)")
                .bind("Bar")
                .bind("bar")
                .bind("2026-01-01T00:00:00Z")
                .execute(&state.db.pool)
                .await
                .unwrap()
                .last_insert_rowid();
        for i in 1..=n {
            let f = seed_media_file(state, &format!("/lib/bar_s1e{i}.mp4")).await;
            sqlx::query(
                "INSERT INTO episodes (show_id, season, episode, title, file_id) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(show_id)
            .bind(1_i64)
            .bind(i)
            .bind(format!("Ep{i}"))
            .bind(f)
            .execute(&state.db.pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn list_episodes_all_returns_items_and_total() {
        let state = test_state().await;
        seed_show_with_episodes(&state, 3).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(req("GET", "/api/media/episodes"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 3);
        assert_eq!(v["items"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn list_episodes_all_honors_limit() {
        let state = test_state().await;
        seed_show_with_episodes(&state, 3).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(req("GET", "/api/media/episodes?limit=1"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["total"], 3);
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
    }
}
