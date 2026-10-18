//! Candidate retrieval (`app/retrieval.py`): a sqlite-vec KNN around the
//! query vector, anti-joined against what the household owns, vetoed,
//! disliked or was just shown, then gated on votes and availability. Also the
//! popularity pool for households without a taste signal.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};

use crate::Result;
use crate::context::{Candidate, TitleRow, UserContext, title_key_variants, title_row_from};
use crate::db::{GENRE_AGG_SQL, decode_vec_rowid, deserialize_f32, serialize_f32};

const AVAILABLE_TITLE_PREDICATE: &str = "(t.release_date IS NULL OR t.release_date = '' OR date(t.release_date) <= date('now'))
                     AND (t.status IS NULL OR lower(t.status) IN ('released', 'returning series', 'ended', 'canceled'))";

/// sqlite-vec refuses a KNN `k` above 4096 ("k value in knn query too large").
pub const VEC_KNN_MAX_K: usize = 4096;

/// The retrieval exclusion set, bounded so it cannot starve the KNN. Owned,
/// disliked and rejected titles are always kept; recently-shown ones only as
/// far as the cap leaves room for `pool_size` survivors, newest first.
pub fn bounded_exclusions(user: &UserContext, pool_size: usize) -> HashSet<i64> {
    let mut hard: HashSet<i64> = user.library_ids.clone();
    hard.extend(&user.rejected_ids);
    hard.extend(&user.disliked_ids);
    let keep_soft = VEC_KNN_MAX_K.saturating_sub(pool_size.max(200) + hard.len());
    let mut soft = HashSet::new();
    for &tid in &user.recently_shown_order {
        if soft.len() >= keep_soft {
            break;
        }
        if !hard.contains(&tid) {
            soft.insert(tid);
        }
    }
    hard.extend(soft);
    hard
}

pub struct CandidateBatch {
    pub candidates: Vec<Candidate>,
    pub distances: Vec<f64>,
    pub diag: Value,
}

/// The `pool_size` nearest titles (cosine distance order) that survive the
/// household filters. The KNN over-fetches to leave room for the anti-join.
pub async fn retrieve_candidates(
    pool: &SqlitePool,
    kind: &'static str,
    query_vec: &[f32],
    user: &UserContext,
    pool_size: usize,
    min_vote_count: i64,
) -> Result<CandidateBatch> {
    let excluded = bounded_exclusions(user, pool_size);
    let overfetch = (pool_size * 3)
        .max(pool_size + excluded.len())
        .clamp(200, VEC_KNN_MAX_K);
    let rows: Vec<(i64, f64)> = sqlx::query_as(
        "SELECT v.rowid AS vec_rowid, v.distance AS distance
           FROM title_vec v
           WHERE v.kind = ? AND v.embedding MATCH ? AND k = ?
           ORDER BY v.distance",
    )
    .bind(kind)
    .bind(serialize_f32(query_vec))
    .bind(overfetch as i64)
    .fetch_all(pool)
    .await?;
    let empty = |raw: usize| CandidateBatch {
        candidates: Vec::new(),
        distances: Vec::new(),
        diag: json!({ "raw": raw, "kept": 0 }),
    };
    if rows.is_empty() {
        return Ok(empty(0));
    }

    let mut keep_ids = Vec::new();
    let mut distance_of = HashMap::new();
    for &(rowid, distance) in &rows {
        match decode_vec_rowid(rowid, Some(kind)) {
            Ok((_, tid)) => {
                distance_of.insert(tid, distance);
                if !excluded.contains(&tid) {
                    keep_ids.push(tid);
                }
            }
            Err(_) => tracing::warn!(
                "skipping title_vec row with inconsistent kind encoding: rowid={rowid} kind={kind}"
            ),
        }
    }
    if keep_ids.is_empty() {
        return Ok(empty(rows.len()));
    }

    let sql = format!(
        "SELECT t.tmdb_id, t.kind, t.title, t.year, t.poster_path, t.overview,
                COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                COALESCE(t.vote_count, 0) AS vote_count,
                {GENRE_AGG_SQL},
                f.embedding AS embedding, f.dim AS dim
         FROM titles t
         JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
         WHERE t.kind = ?
           AND t.tmdb_id IN (SELECT value FROM json_each(?))
           AND COALESCE(t.vote_count, 0) >= ?
           AND {AVAILABLE_TITLE_PREDICATE}"
    );
    let title_rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(kind)
        .bind(serde_json::to_string(&keep_ids).expect("ints serialize"))
        .bind(min_vote_count)
        .fetch_all(pool)
        .await?;
    let by_id: HashMap<i64, &sqlx::sqlite::SqliteRow> = title_rows
        .iter()
        .map(|r| Ok((r.try_get("tmdb_id")?, r)))
        .collect::<sqlx::Result<_>>()?;

    // Walk keep_ids (distance order) so the nearest win the truncation.
    let mut candidates = Vec::new();
    let mut distances = Vec::new();
    for tid in keep_ids {
        // Missing: filtered by votes, availability or no features.
        let Some(r) = by_id.get(&tid) else { continue };
        let title = title_row_from(r, kind)?;
        if !user.library_title_keys.is_empty()
            && title_key_variants(Some(&title.title))
                .iter()
                .any(|k| user.library_title_keys.contains(k))
        {
            continue;
        }
        let dim: i64 = r.try_get("dim")?;
        let embedding = deserialize_f32(r.try_get::<&[u8], _>("embedding")?, Some(dim as usize))?;
        candidates.push(Candidate { title, embedding });
        distances.push(distance_of[&tid]);
        if candidates.len() >= pool_size {
            break;
        }
    }
    let diag = json!({ "raw": rows.len(), "kept": candidates.len(), "excluded": excluded.len() });
    Ok(CandidateBatch {
        candidates,
        distances,
        diag,
    })
}

/// Popularity-ordered titles for a household with no taste signal.
pub async fn cold_start_pool(
    pool: &SqlitePool,
    kind: &'static str,
    user: &UserContext,
    pool_size: usize,
    min_vote_count: i64,
) -> Result<Vec<TitleRow>> {
    let mut excluded: HashSet<i64> = user.library_ids.clone();
    excluded.extend(&user.rejected_ids);
    excluded.extend(&user.recently_shown_ids);
    excluded.extend(&user.disliked_ids);
    let fetch_limit = (pool_size * 3).max(pool_size + excluded.len());
    let sql = format!(
        "SELECT t.tmdb_id, t.title, t.year, t.poster_path, t.overview,
                COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                {GENRE_AGG_SQL}
         FROM titles t
         WHERE t.kind = ?
           AND COALESCE(t.vote_count, 0) >= ?
           AND {AVAILABLE_TITLE_PREDICATE}
         ORDER BY popularity DESC
         LIMIT ?"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(kind)
        .bind(min_vote_count)
        .bind(fetch_limit as i64)
        .fetch_all(pool)
        .await?;
    let mut out = Vec::new();
    for r in &rows {
        let t = title_row_from(r, kind)?;
        if excluded.contains(&t.tmdb_id) {
            continue;
        }
        if !user.library_title_keys.is_empty()
            && title_key_variants(Some(&t.title))
                .iter()
                .any(|k| user.library_title_keys.contains(k))
        {
            continue;
        }
        out.push(t);
        if out.len() >= pool_size {
            break;
        }
    }
    Ok(out)
}
