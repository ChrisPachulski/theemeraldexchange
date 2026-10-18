//! fused (`app/recipes/fused.py`): content + cast/crew item re-rank. The
//! sqlite-vec pool around the positive centroid is scored by its MAX fused
//! similarity to any single library title (the averaged centroid collapses a
//! diverse library):
//!
//!   fused = content_weight * cosine + cast_weight * idf_overlap(top-billed
//!           cast) + crew_weight * idf_overlap(key crew)
//!
//! Overlap is a cosine of IDF-weighted, L2-normalized person vectors, filled
//! through an inverted index (person -> library titles) so it stays sparse.
//! A running kids-genre cap keeps cartoons from owning the strip.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;
use sqlx::SqlitePool;

use super::{Caches, Def, EMBED_EPS, P, RecipeResult, ScoredItem, cold_start_result, diag, extend};
use crate::Result;
use crate::context::{Candidate, UserContext, normalize};
use crate::db::{TableGeneration, table_generation};
use crate::reasons::{discover_reason, personalized_reason};
use crate::retrieval::{CandidateBatch, retrieve_candidates};

pub const DEFAULTS: &[(&str, Def)] = &[
    ("pool_size", Def::Int(800)),
    ("negative_weight", Def::Float(0.30)),
    ("popularity_weight", Def::Float(0.05)),
    ("min_vote_count", Def::Int(50)),
    // Fused similarity at or above this is "personalized".
    ("personalized_threshold", Def::Float(0.45)),
    ("content_weight", Def::Float(1.0)),
    ("cast_weight", Def::Float(0.7)),
    ("crew_weight", Def::Float(0.5)),
    // Top-billed cast only (order_idx < cast_topn).
    ("cast_topn", Def::Int(10)),
    ("kids_genre_cap", Def::Float(0.35)),
];

/// The key crew jobs, as an SQL IN list.
pub const KEY_CREW_JOBS_SQL: &str =
    "'Director', 'Writer', 'Screenplay', 'Story', 'Creator', 'Author', 'Novel'";

/// TMDB Animation, Family, Kids. A shared household profile pools a
/// preschooler's taste with the adults', and the animated cluster is dense.
pub const KIDS_GENRE_IDS: &[i64] = &[16, 10751, 10762];

pub fn is_kids(genre_ids: &[i64]) -> bool {
    genre_ids.iter().any(|g| KIDS_GENRE_IDS.contains(g))
}

/// Up to `n` of `order` (best first), keeping the RUNNING kids share at or
/// below `cap` at every prefix: a kid is admitted only while
/// kids + 1 <= cap * (len + 1), else deferred. Deferred kids backfill the
/// tail when the rest runs out, so the strip is never short.
pub fn cap_kids_share(order: &[usize], kids: &[bool], n: usize, cap: f64) -> Vec<usize> {
    if cap >= 1.0 {
        return order.iter().take(n).copied().collect();
    }
    let mut chosen = Vec::new();
    let mut deferred = Vec::new();
    let mut n_kids = 0usize;
    for &i in order {
        if kids[i] && (n_kids + 1) as f64 > cap * (chosen.len() + 1) as f64 {
            deferred.push(i);
            continue;
        }
        chosen.push(i);
        n_kids += usize::from(kids[i]);
        if chosen.len() >= n {
            return chosen;
        }
    }
    let short = n - chosen.len();
    chosen.extend(deferred.into_iter().take(short));
    chosen
}

/// (kind, "cast"|"crew", cast_topn or 0 for crew)
pub type IdfKey = (&'static str, &'static str, i64);
pub type IdfCache = HashMap<IdfKey, (Vec<TableGeneration>, Arc<HashMap<i64, f64>>)>;

/// Global IDF over the kind's catalog: ln((1 + titles) / (1 + df)) + 1, df
/// the number of titles a person is in (top-billed cast / key crew). Cached
/// against the titles + credits table generation, so the nightly
/// DELETE+INSERT rehydration recomputes it.
async fn idf_map(
    pool: &SqlitePool,
    caches: &Caches,
    kind: &'static str,
    which: &'static str,
    cast_topn: i64,
) -> Result<Arc<HashMap<i64, f64>>> {
    let cast = which == "cast";
    let key = (kind, which, if cast { cast_topn } else { 0 });
    let credits = if cast { "title_cast" } else { "title_crew" };
    let generation = table_generation(pool, &[("titles", None), (credits, None)]).await?;
    if let Some((g, idf)) = caches.idf.lock().unwrap().get(&key)
        && *g == generation
    {
        return Ok(idf.clone());
    }
    let rows: Vec<(i64, i64)> = if cast {
        sqlx::query_as(
            "SELECT person_id, COUNT(DISTINCT tmdb_id) AS df FROM title_cast
             WHERE kind = ? AND order_idx < ? GROUP BY person_id",
        )
        .bind(kind)
        .bind(cast_topn)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT person_id, COUNT(DISTINCT tmdb_id) AS df FROM title_crew
             WHERE kind = ? AND job IN ({KEY_CREW_JOBS_SQL}) GROUP BY person_id"
        )))
        .bind(kind)
        .fetch_all(pool)
        .await?
    };
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM titles WHERE kind = ?")
        .bind(kind)
        .fetch_one(pool)
        .await?;
    let n = if n == 0 { 1 } else { n } as f64;
    let idf: HashMap<i64, f64> = rows
        .into_iter()
        .map(|(pid, df)| (pid, ((1.0 + n) / (1.0 + df as f64)).ln() + 1.0))
        .collect();
    let idf = Arc::new(idf);
    caches
        .idf
        .lock()
        .unwrap()
        .insert(key, (generation, idf.clone()));
    Ok(idf)
}

/// One title's people, in query order, with L2-normalized IDF weights.
type PersonVec = Vec<(i64, f64)>;

/// tmdb_id -> its person vector (people outside the IDF map weigh 1.0).
async fn person_vectors(
    pool: &SqlitePool,
    kind: &str,
    ids: &[i64],
    which: &str,
    idf: &HashMap<i64, f64>,
    cast_topn: i64,
) -> Result<HashMap<i64, PersonVec>> {
    let mut out: HashMap<i64, PersonVec> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let ids_json = serde_json::to_string(ids).expect("ints serialize");
    let rows: Vec<(i64, i64)> = if which == "cast" {
        sqlx::query_as(
            "SELECT tmdb_id, person_id FROM title_cast
             WHERE kind = ? AND order_idx < ? AND tmdb_id IN (SELECT value FROM json_each(?))",
        )
        .bind(kind)
        .bind(cast_topn)
        .bind(ids_json)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT tmdb_id, person_id FROM title_crew
             WHERE kind = ? AND job IN ({KEY_CREW_JOBS_SQL})
               AND tmdb_id IN (SELECT value FROM json_each(?))"
        )))
        .bind(kind)
        .bind(ids_json)
        .fetch_all(pool)
        .await?
    };
    for (tid, pid) in rows {
        let w = idf.get(&pid).copied().unwrap_or(1.0);
        let v = out.entry(tid).or_default();
        // A person with two key crew jobs is one entry (a dict key in Python).
        match v.iter_mut().find(|(p, _)| *p == pid) {
            Some(e) => e.1 = w,
            None => v.push((pid, w)),
        }
    }
    for v in out.values_mut() {
        let norm = v.iter().map(|(_, w)| w * w).sum::<f64>().sqrt();
        let norm = if norm == 0.0 { 1.0 } else { norm };
        v.iter_mut().for_each(|(_, w)| *w /= norm);
    }
    Ok(out)
}

/// (candidates x library) person-overlap cosines in float32, filled sparsely
/// through person -> [(library column, weight)].
fn block_bonus(
    cand_ids: &[i64],
    lib_ids: &[i64],
    cand_vecs: &HashMap<i64, PersonVec>,
    lib_vecs: &HashMap<i64, PersonVec>,
) -> Vec<Vec<f32>> {
    let mut bonus = vec![vec![0f32; lib_ids.len()]; cand_ids.len()];
    let mut inv: HashMap<i64, Vec<(usize, f64)>> = HashMap::new();
    for (j, tid) in lib_ids.iter().enumerate() {
        for &(pid, w) in lib_vecs.get(tid).map(Vec::as_slice).unwrap_or(&[]) {
            inv.entry(pid).or_default().push((j, w));
        }
    }
    for (row, ctid) in bonus.iter_mut().zip(cand_ids) {
        for &(pid, cw) in cand_vecs.get(ctid).map(Vec::as_slice).unwrap_or(&[]) {
            for &(j, lw) in inv.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
                row[j] += (cw * lw) as f32;
            }
        }
    }
    bonus
}

/// Unit rows in float32 (each row over max(norm, EMBED_EPS)).
pub(super) fn unit_rows(rows: &[Vec<f32>]) -> Vec<Vec<f32>> {
    rows.iter()
        .map(|r| {
            let n = (r
                .iter()
                .map(|x| f64::from(*x) * f64::from(*x))
                .sum::<f64>()
                .sqrt() as f32)
                .max(EMBED_EPS);
            r.iter().map(|x| x / n).collect()
        })
        .collect()
}

/// A float32 dot product, accumulated wide (BLAS-grade rounding).
// ponytail: no BLAS; a cold ranker fit for a ~3000-judgment household is a
// few seconds of these on the NAS (cached 12 h). f32 SIMD lanes if it matters.
pub(super) fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f64; 8];
    let (ca, cb) = (a.chunks_exact(8), b.chunks_exact(8));
    let tail: f64 = ca
        .remainder()
        .iter()
        .zip(cb.remainder())
        .map(|(x, y)| f64::from(*x) * f64::from(*y))
        .sum();
    for (x, y) in ca.zip(cb) {
        for i in 0..8 {
            acc[i] += f64::from(x[i]) * f64::from(y[i]);
        }
    }
    (acc.iter().sum::<f64>() + tail) as f32
}

/// `pinned` replaces retrieval with exactly these candidates (replay-eval's
/// score_ids); None retrieves as /score does.
pub(super) async fn score(
    pool: &SqlitePool,
    caches: &Caches,
    ctx: &UserContext,
    n: usize,
    p: &P<'_>,
    pinned: Option<CandidateBatch>,
) -> Result<RecipeResult> {
    let pool_size = p.int("pool_size").max(0) as usize;
    let neg_w = p.num("negative_weight");
    let min_votes = p.int("min_vote_count");
    let tau = p.num("personalized_threshold");
    let (w_content, w_cast, w_crew) = (
        p.num("content_weight"),
        p.num("cast_weight"),
        p.num("crew_weight"),
    );
    let pop_w = p.num("popularity_weight");
    let cast_topn = p.int("cast_topn");

    let Some(pos) = ctx.positive_centroid() else {
        return cold_start_result(pool, ctx, n, min_votes, "cold_start").await;
    };
    let query = match ctx.negative_centroid() {
        Some(neg) => {
            let w = neg_w as f32;
            normalize(pos.iter().zip(&neg).map(|(a, b)| a - w * b).collect())
        }
        None => normalize(pos),
    };
    let mut batch = match pinned {
        Some(b) => b,
        None => retrieve_candidates(pool, ctx.kind, &query, ctx, pool_size, min_votes).await?,
    };
    let empty_pool = |batch_diag: &serde_json::Value| RecipeResult {
        items: Vec::new(),
        diag: extend(diag(json!({ "path": "empty_pool" })), batch_diag),
    };
    if batch.candidates.is_empty() {
        return Ok(empty_pool(&batch.diag));
    }

    // Max similarity is to a library title; a likes-only profile scores
    // against its liked titles, minus those titles themselves.
    let (mut lib_ids, mut lib_rows) = (&ctx.library_embeddings.ids, &ctx.library_embeddings.rows);
    if lib_ids.is_empty() {
        lib_ids = &ctx.liked_embeddings.ids;
        lib_rows = &ctx.liked_embeddings.rows;
        batch
            .candidates
            .retain(|c| !ctx.liked_ids.contains(&c.title.tmdb_id));
    }
    if lib_ids.is_empty() {
        return Ok(RecipeResult {
            items: Vec::new(),
            diag: diag(json!({ "path": "no_library_embeddings" })),
        });
    }
    if batch.candidates.is_empty() {
        return Ok(empty_pool(&batch.diag));
    }
    let cands = &batch.candidates;
    let cand_ids: Vec<i64> = cands.iter().map(|c| c.title.tmdb_id).collect();
    // Person vectors first (SQL), then the dense part off the request task.
    let mut blocks = Vec::new();
    for (which, weight, topn) in [("cast", w_cast, cast_topn), ("crew", w_crew, 0)] {
        if weight == 0.0 {
            continue;
        }
        let idf = idf_map(pool, caches, ctx.kind, which, topn).await?;
        let cv = person_vectors(pool, ctx.kind, &cand_ids, which, &idf, topn).await?;
        let lv = person_vectors(pool, ctx.kind, lib_ids, which, &idf, topn).await?;
        blocks.push((weight as f32, cv, lv));
    }
    let lib = (lib_ids.clone(), lib_rows.clone());
    let cand_rows: Vec<Vec<f32>> = cands.iter().map(|c| c.embedding.clone()).collect();
    let ids = cand_ids.clone();
    let fused_score = tokio::task::spawn_blocking(move || {
        let lib_norm = unit_rows(&lib.1);
        let wc = w_content as f32;
        let mut fused: Vec<Vec<f32>> = unit_rows(&cand_rows)
            .iter()
            .map(|c| lib_norm.iter().map(|l| wc * dot(c, l)).collect())
            .collect();
        for (w, cv, lv) in &blocks {
            let bonus = block_bonus(&ids, &lib.0, cv, lv);
            for (row, b) in fused.iter_mut().zip(&bonus) {
                row.iter_mut().zip(b).for_each(|(f, x)| *f += w * x);
            }
        }
        fused
            .iter()
            .map(|r| r.iter().copied().fold(f32::NEG_INFINITY, f32::max))
            .collect::<Vec<f32>>()
    })
    .await
    .map_err(|e| crate::Error::Invalid(format!("fused panicked: {e}")))?;

    let pop_max = cands
        .iter()
        .map(|c| c.title.popularity)
        .fold(f64::NEG_INFINITY, f64::max);
    let pop_max = if pop_max == 0.0 { 1.0 } else { pop_max };
    let pw = pop_w as f32;
    let combined: Vec<f32> = cands
        .iter()
        .zip(&fused_score)
        .map(|(c, f)| f + pw * (c.title.popularity / pop_max) as f32)
        .collect();

    let mut order: Vec<usize> = (0..cands.len()).collect();
    order.sort_by(|a, b| combined[*b].total_cmp(&combined[*a]));
    let kids: Vec<bool> = cands.iter().map(|c| is_kids(&c.title.genre_ids)).collect();
    let kids_cap = p.num("kids_genre_cap");
    let chosen = cap_kids_share(&order, &kids, n, kids_cap);
    let kids_returned = chosen.iter().filter(|i| kids[**i]).count();
    let items: Vec<ScoredItem> = chosen
        .iter()
        .map(|&i| {
            let cand: &Candidate = &cands[i];
            let personal = f64::from(fused_score[i]) >= tau;
            ScoredItem {
                tmdb_id: cand.title.tmdb_id,
                title: cand.title.title.clone(),
                year: cand.title.year,
                poster_path: cand.title.poster_path.clone(),
                overview: cand.title.overview.clone(),
                score: f64::from(combined[i]),
                provenance: if personal { "personalized" } else { "discover" },
                reason: if personal {
                    personalized_reason(cand, &[])
                } else {
                    discover_reason(cand)
                },
            }
        })
        .collect();
    let d = extend(diag(json!({ "path": "fused" })), &batch.diag);
    let d = extend(
        d,
        &json!({
            "lib": lib_ids.len(),
            "weights": { "content": w_content, "cast": w_cast, "crew": w_crew },
            "tau": tau,
            "kids_cap": kids_cap,
            "kids_returned": kids_returned,
            "returned": items.len(),
        }),
    );
    Ok(RecipeResult { items, diag: d })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    // test_scoring_path.py's _cap_kids_share cases.
    #[test]
    fn cap_kids_share_interleaves_so_every_prefix_respects_cap() {
        let kids: Vec<bool> = (0..10).map(|i| i != 3 && i != 7).collect();
        let order: Vec<usize> = (0..10).collect();
        let chosen = cap_kids_share(&order, &kids, 4, 0.5);
        assert_eq!(chosen.len(), 4);
        assert!(
            chosen.iter().filter(|i| kids[**i]).count() <= 2,
            "running cap exceeded"
        );
        assert!(chosen.contains(&3) && chosen.contains(&7));
        assert!(chosen[0] == 3 || chosen[0] == 7);
    }

    #[test]
    fn cap_kids_share_backfills_when_non_kids_exhausted() {
        let chosen = cap_kids_share(&[0, 1, 2, 3, 4, 5], &[true; 6], 5, 0.3);
        assert_eq!(chosen.len(), 5, "must never return a short strip");
        assert_eq!(chosen.iter().collect::<HashSet<_>>().len(), 5);
    }

    #[test]
    fn cap_kids_share_noop_when_cap_disabled() {
        assert_eq!(
            cap_kids_share(&[0, 1, 2, 3, 4], &[true; 5], 3, 1.0),
            [0, 1, 2]
        );
    }
}
