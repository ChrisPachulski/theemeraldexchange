//! Per-title feature vectors (port of workers/featurize.py): the MiniLM
//! embedding of "title — overview" plus small deterministic genre and keyword
//! perturbations (so same-overview titles in different genres still separate),
//! normalised. Lands in `title_features` (raw vector + feature JSON) and the
//! sqlite-vec `title_vec` index /score searches.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::db::{EMBED_DIM, encode_vec_rowid, serialize_f32};
use crate::embed::{Embedder, MODEL, MODEL_REVISION, l2_norm};
use crate::rng::Generator;
use crate::{Error, Result};

const GENRE_WEIGHT: f32 = 0.30;
const KEYWORD_WEIGHT: f32 = 0.15;
const COMMIT_CHUNK_SIZE: usize = 256;

/// `{model}@{revision}` as ingest_state.embed_model holds it.
pub fn model_identity() -> String {
    format!("{MODEL}@{MODEL_REVISION}")
}

/// A deterministic {-1,0,1}-ish vector: per id, a numpy default_rng seeded by
/// blake2s-32(`{prefix}:{id}`) draws `picks` indices and as many signs.
/// `out[idx] += signs` is numpy fancy indexing: a repeated index is written
/// once, with its last sign, not accumulated.
fn perturbation(prefix: &str, ids: &[i64], picks: usize) -> Vec<f32> {
    use blake2::digest::{Update, VariableOutput};
    let mut out = vec![0f32; EMBED_DIM];
    for id in ids {
        let mut h = blake2::Blake2sVar::new(4).expect("4 is a valid blake2s length");
        h.update(format!("{prefix}:{id}").as_bytes());
        let mut seed = [0u8; 4];
        h.finalize_variable(&mut seed)
            .expect("buffer matches the output length");
        let mut rng = Generator::new(u128::from(u32::from_be_bytes(seed)));
        let n = picks.min(EMBED_DIM);
        let idx = rng.integers(EMBED_DIM as u64, n);
        let signs = rng.choice_replace(2, n);
        let sums: Vec<f32> = idx
            .iter()
            .zip(&signs)
            .map(|(&i, &s)| out[i as usize] + if s == 0 { -1.0 } else { 1.0 })
            .collect();
        for (&i, s) in idx.iter().zip(sums) {
            out[i as usize] = s;
        }
    }
    out
}

pub fn genre_perturbation(genre_ids: &[i64]) -> Vec<f32> {
    perturbation("g", genre_ids, 8)
}

pub fn keyword_perturbation(keyword_ids: &[i64]) -> Vec<f32> {
    perturbation("k", &keyword_ids[..keyword_ids.len().min(30)], 4)
}

#[derive(Debug, sqlx::FromRow)]
pub(crate) struct Pending {
    pub tmdb_id: i64,
    pub kind: String,
    title: String,
    overview: Option<String>,
    genres: Option<String>,
    keywords: Option<String>,
}

/// Titles never featurized, or re-fetched (fetched_at) after their features
/// were computed: the nightly /changes upsert rewrites plot, genres and
/// keywords, and the embedding must follow. `limit` 0 or None means all.
pub(crate) async fn load_pending(pool: &SqlitePool, limit: Option<i64>) -> Result<Vec<Pending>> {
    Ok(sqlx::query_as(
        "SELECT t.tmdb_id, t.kind, t.title, t.overview,
               (SELECT GROUP_CONCAT(g.genre_id ORDER BY g.genre_id) FROM title_genres g
                WHERE g.kind = t.kind AND g.tmdb_id = t.tmdb_id) AS genres,
               (SELECT GROUP_CONCAT(k.keyword_id ORDER BY k.keyword_id) FROM title_keywords k
                WHERE k.kind = t.kind AND k.tmdb_id = t.tmdb_id) AS keywords
        FROM titles t
        LEFT JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
        WHERE f.tmdb_id IS NULL
           OR f.computed_at < t.fetched_at
        ORDER BY t.fetched_at ASC, t.kind, t.tmdb_id
        LIMIT ?",
    )
    // SQLite reads a negative LIMIT as none, as the Python's falsy limit was.
    .bind(limit.filter(|&l| l != 0).unwrap_or(-1))
    .fetch_all(pool)
    .await?)
}

/// Mark every feature stale when the embedding model identity changed, so the
/// index never mixes two models' spaces for long. The first run that finds no
/// identity records the current one. The stale mark is durable, so an
/// interrupted rebuild resumes on the next run.
pub(crate) async fn reconcile_model_identity(pool: &SqlitePool, identity: &str) -> Result<()> {
    let current: Option<String> =
        sqlx::query_scalar("SELECT value FROM ingest_state WHERE key = 'embed_model'")
            .fetch_optional(pool)
            .await?;
    if current.as_deref() == Some(identity) {
        return Ok(());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(old) = current {
        tracing::warn!("embedding model changed ({old} -> {identity}): rebuilding every vector");
        sqlx::query("UPDATE title_features SET computed_at = ''")
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "INSERT INTO ingest_state(key, value, ts) VALUES ('embed_model', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
    )
    .bind(identity)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

fn ids_csv(s: Option<&str>) -> Result<Vec<i64>> {
    s.unwrap_or_default()
        .split(',')
        .filter(|x| !x.trim().is_empty())
        .map(|x| {
            x.trim()
                .parse()
                .map_err(|_| Error::Invalid(format!("bad id list: {s:?}")))
        })
        .collect()
}

/// `" — ".join(x for x in (title, overview or "") if x)`.
fn text(row: &Pending) -> String {
    [row.title.as_str(), row.overview.as_deref().unwrap_or("")]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" — ")
}

/// Upsert one chunk's features and swap its title_vec rows in one transaction.
/// vec0 does not honour INSERT OR REPLACE with a partition key, so the vec row
/// is deleted then inserted (the rowid is kind-encoded: at most one match).
pub(crate) async fn persist(
    pool: &SqlitePool,
    chunk: &[Pending],
    text_embs: &[Vec<f32>],
    computed_at: &str,
) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    for (row, txt) in chunk.iter().zip(text_embs) {
        let genres = ids_csv(row.genres.as_deref())?;
        let keywords = ids_csv(row.keywords.as_deref())?;
        let g = genre_perturbation(&genres);
        let k = keyword_perturbation(&keywords);
        // float32 throughout, left to right, as numpy computed it.
        let mut vec: Vec<f32> = (0..EMBED_DIM)
            .map(|i| txt[i] + GENRE_WEIGHT * g[i] + KEYWORD_WEIGHT * k[i])
            .collect();
        let n = l2_norm(&vec);
        if n > 0.0 {
            vec.iter_mut().for_each(|x| *x /= n);
        }
        let join = |ids: &[i64]| {
            ids.iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        };
        // json.dumps's layout; nothing reads it back.
        let feature_json = format!(
            "{{\"genres\": [{}], \"keywords\": [{}], \"text_norm\": {}}}",
            join(&genres),
            join(&keywords),
            serde_json::Value::from(f64::from(l2_norm(txt)))
        );
        let blob = serialize_f32(&vec);
        sqlx::query(
            "INSERT INTO title_features(tmdb_id, kind, feature_json, embedding, dim, computed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(tmdb_id, kind) DO UPDATE SET
               feature_json=excluded.feature_json,
               embedding=excluded.embedding,
               dim=excluded.dim,
               computed_at=excluded.computed_at",
        )
        .bind(row.tmdb_id)
        .bind(&row.kind)
        .bind(feature_json)
        .bind(&blob)
        .bind(EMBED_DIM as i64)
        .bind(computed_at)
        .execute(&mut *tx)
        .await?;
        let rowid = encode_vec_rowid(&row.kind, row.tmdb_id)?;
        sqlx::query("DELETE FROM title_vec WHERE rowid = ? AND kind = ?")
            .bind(rowid)
            .bind(&row.kind)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, ?, ?)")
            .bind(rowid)
            .bind(&row.kind)
            .bind(&blob)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Featurize every pending title (at most `limit`), 256 rows per commit.
/// Returns the number of titles written.
pub async fn run(pool: &SqlitePool, embedder: Arc<Embedder>, limit: Option<i64>) -> Result<usize> {
    reconcile_model_identity(pool, &model_identity()).await?;
    let pending = load_pending(pool, limit).await?;
    if pending.is_empty() {
        tracing::info!("nothing to featurize");
        return Ok(0);
    }
    tracing::info!(
        "featurizing {} titles with {MODEL}@{} (dim={EMBED_DIM})",
        pending.len(),
        &MODEL_REVISION[..12]
    );
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S+00:00")
        .to_string();
    let mut total = 0;
    for chunk in pending.chunks(COMMIT_CHUNK_SIZE) {
        let texts: Vec<String> = chunk.iter().map(text).collect();
        let e = embedder.clone();
        let embs = tokio::task::spawn_blocking(move || e.encode(&texts))
            .await
            .map_err(|e| Error::Embed(e.to_string()))??;
        persist(pool, chunk, &embs, &now).await?;
        total += chunk.len();
        tracing::info!("featurized {total}/{} titles", pending.len());
    }
    Ok(total)
}

#[cfg(test)]
mod tests;
