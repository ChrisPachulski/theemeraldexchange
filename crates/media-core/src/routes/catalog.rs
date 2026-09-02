//! Catalog lookups shared by the shelves.
//!
//! Watch state, playlists, and collections all render polymorphic
//! `(media_kind, media_id)` rows, so they all need the same two things: an
//! existence check the DB cannot express as a foreign key, and a batched
//! title/poster resolve that avoids an N+1 per shelf.

use super::*;

/// Show + episode display metadata for one watched episode (Bug: Home "continue
/// watching" rows showed a bare "Episode" with no art because the client had no
/// episode→show catalog to join against).
pub(super) struct EpisodeMeta {
    pub(super) episode_title: Option<String>,
    pub(super) show_title: String,
    pub(super) poster_path: Option<String>,
    pub(super) season: i64,
    pub(super) episode: i64,
}

/// Batch-resolve `id → T` for an `id IN (...)` lookup, sharing the empty-guard,
/// placeholder build, and per-id bind. `sql_for` receives the comma-joined `?`
/// placeholders; `map` turns each decoded row into its `(id, value)` entry.
pub(super) async fn fetch_by_ids<R, T>(
    state: &AppState,
    ids: &[i64],
    sql_for: impl FnOnce(&str) -> String,
    map: impl Fn(R) -> (i64, T),
) -> AppResult<std::collections::HashMap<i64, T>>
where
    R: for<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> + Send + Unpin,
{
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let mut query = sqlx::query_as::<_, R>(sqlx::AssertSqlSafe(sql_for(&placeholders)));
    for id in ids {
        query = query.bind(id);
    }
    Ok(query
        .fetch_all(&state.db.pool)
        .await?
        .into_iter()
        .map(map)
        .collect())
}

/// Batch-resolve `movies.id → (title, poster_path)` for the watch shelf.
pub(super) async fn fetch_movie_meta(
    state: &AppState,
    ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, (String, Option<String>)>> {
    fetch_by_ids(
        state,
        ids,
        |ph| format!("SELECT id, title, poster_path FROM movies WHERE id IN ({ph})"),
        |(id, title, poster): (i64, String, Option<String>)| (id, (title, poster)),
    )
    .await
}

/// Batch-resolve `episodes.id → EpisodeMeta` (joined to the parent show for its
/// title + poster) for the watch shelf.
pub(super) async fn fetch_episode_meta(
    state: &AppState,
    ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, EpisodeMeta>> {
    fetch_by_ids(
        state,
        ids,
        |ph| {
            format!(
                "SELECT e.id, e.title, s.title, s.poster_path, e.season, e.episode \
                 FROM episodes e JOIN shows s ON e.show_id = s.id WHERE e.id IN ({ph})"
            )
        },
        |(id, episode_title, show_title, poster_path, season, episode): (
            i64,
            Option<String>,
            String,
            Option<String>,
            i64,
            i64,
        )| {
            (
                id,
                EpisodeMeta {
                    episode_title,
                    show_title,
                    poster_path,
                    season,
                    episode,
                },
            )
        },
    )
    .await
}

/// True iff `(media_kind, media_id)` names a row that currently exists. Used to
/// keep watch-state from referencing titles that never existed or were deleted.
/// The relationship is polymorphic (media_kind ∈ {movie, episode}), so a SQL
/// foreign key cannot enforce it (§7-8); this is the in-handler equivalent.
/// `Ok(None)` distinguishes an unknown `media_kind` (→ 400) from a known kind
/// whose id is absent (`Ok(Some(false))` → 404).
pub(super) async fn media_exists(
    state: &AppState,
    media_kind: &str,
    media_id: i64,
) -> AppResult<Option<bool>> {
    let table = match media_kind {
        "movie" => "movies",
        "episode" => "episodes",
        "track" => "tracks",
        "audiobook" => "audiobooks",
        "podcast_episode" => "podcast_episodes",
        _ => return Ok(None),
    };
    // `table` is from the fixed allow-list above (never user input), so the
    // format! is injection-safe; `media_id` is still bound as a parameter.
    // sqlx 0.9 requires an explicit safety assertion for non-'static SQL.
    let sql = format!("SELECT 1 FROM {table} WHERE id = ? LIMIT 1");
    let found: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(media_id)
        .fetch_optional(&state.db.pool)
        .await?;
    Ok(Some(found.is_some()))
}
