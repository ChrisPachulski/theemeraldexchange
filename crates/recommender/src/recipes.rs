//! The recipe registry (`app/recipes/`). The active recipe and its params live
//! in model_config. Only ported recipes are registered; item_knn is not
//! (OFFLINE_ONLY research, never served).

pub mod fused;
pub mod ranker;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::SqlitePool;

use crate::Result;
use crate::context::{Candidate, Param, Params, UserContext, normalize};
use crate::db::TableGeneration;
use crate::reasons::{discover_reason, neighbors_for, personalized_reason, trending_reason};
use crate::retrieval::{cold_start_pool, retrieve_candidates};

/// A row-norm floor: a zero vector is skipped, never divided by.
const EMBED_EPS: f32 = 1e-9;

/// A recipe default's type and value; sanitize_model_params types params by it.
#[derive(Clone, Copy, Debug)]
pub enum Def {
    Int(i64),
    Float(f64),
}

pub struct Recipe {
    pub name: &'static str,
    pub defaults: &'static [(&'static str, Def)],
}

const BASELINE_COSINE: &[(&str, Def)] = &[
    ("pool_size", Def::Int(500)),
    ("negative_weight", Def::Float(0.30)),
    ("popularity_weight", Def::Float(0.05)),
    ("min_vote_count", Def::Int(50)),
    // Cosine sim at or above this is "personalized", else "discover".
    ("personalized_threshold", Def::Float(0.45)),
];

const MMR_DIVERSE: &[(&str, Def)] = &[
    ("pool_size", Def::Int(800)),
    ("negative_weight", Def::Float(0.30)),
    ("popularity_weight", Def::Float(0.05)),
    ("min_vote_count", Def::Int(50)),
    ("personalized_threshold", Def::Float(0.45)),
    ("mmr_lambda", Def::Float(0.70)),
    ("mmr_input_k", Def::Int(200)),
];

const COLD_START_TRENDING: &[(&str, Def)] = &[("min_vote_count", Def::Int(100))];

pub const REGISTRY: &[Recipe] = &[
    Recipe {
        name: "baseline_cosine",
        defaults: BASELINE_COSINE,
    },
    Recipe {
        name: "mmr_diverse",
        defaults: MMR_DIVERSE,
    },
    Recipe {
        name: "cold_start_trending",
        defaults: COLD_START_TRENDING,
    },
    // Promoted from the research loop: content + cast/crew fused item re-rank.
    Recipe {
        name: "fused",
        defaults: fused::DEFAULTS,
    },
    // Two-stage ranker learned from the household's own judgments.
    Recipe {
        name: "ranker",
        defaults: ranker::DEFAULTS,
    },
];

type CatalogCache = HashMap<&'static str, (Vec<TableGeneration>, Arc<ranker::Catalog>)>;

/// The process-wide recipe caches (the Python module globals): the ranker's
/// catalogs and per-household models, and fused's IDF maps.
#[derive(Default)]
pub struct Caches {
    catalogs: Mutex<CatalogCache>,
    catalog_build: tokio::sync::Mutex<()>,
    models: Mutex<HashMap<(String, &'static str), Arc<ranker::Model>>>,
    model_fit: Mutex<()>,
    idf: Mutex<fused::IdfCache>,
    /// Pins the catalog's "this year" (goldens); None is the UTC year.
    pub this_year: Option<i32>,
}

#[cfg(test)]
impl Caches {
    /// Caches whose catalog "this year" is pinned (goldens).
    pub fn with_year(year: i32) -> Self {
        Caches {
            this_year: Some(year),
            ..Default::default()
        }
    }
}

pub fn get(name: &str) -> Option<&'static Recipe> {
    REGISTRY.iter().find(|r| r.name == name)
}

#[derive(Clone, Debug, Serialize)]
pub struct ScoredItem {
    pub tmdb_id: i64,
    pub title: String,
    pub year: Option<i64>,
    pub poster_path: Option<String>,
    pub overview: Option<String>,
    pub score: f64,
    pub provenance: &'static str,
    pub reason: String,
}

pub struct RecipeResult {
    pub items: Vec<ScoredItem>,
    pub diag: Map<String, Value>,
}

/// `{**DEFAULTS, **params}` read as the recipe's int(...)/float(...) calls.
struct P<'a> {
    defaults: &'static [(&'static str, Def)],
    params: &'a Params,
}

impl P<'_> {
    fn num(&self, key: &str) -> f64 {
        match self.params.get(key) {
            Some(Param::Int(i)) => *i as f64,
            Some(Param::Float(f)) => *f,
            None => match self.defaults.iter().find(|(k, _)| *k == key) {
                Some((_, Def::Int(i))) => *i as f64,
                Some((_, Def::Float(f))) => *f,
                None => unreachable!("recipe {key} has a default"),
            },
        }
    }

    /// Python int(): truncation toward zero.
    fn int(&self, key: &str) -> i64 {
        self.num(key).trunc() as i64
    }
}

fn diag(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => unreachable!("diag literals are objects"),
    }
}

fn extend(mut base: Map<String, Value>, more: &Value) -> Map<String, Value> {
    if let Value::Object(m) = more {
        base.extend(m.clone());
    }
    base
}

/// Score `ctx` with the named recipe. `None` for a recipe not in REGISTRY.
pub async fn score(
    name: &str,
    pool: &SqlitePool,
    caches: &Arc<Caches>,
    ctx: &UserContext,
    n: usize,
    params: &Params,
) -> Result<Option<RecipeResult>> {
    let Some(r) = get(name) else { return Ok(None) };
    let p = P {
        defaults: r.defaults,
        params,
    };
    Ok(Some(match r.name {
        "baseline_cosine" => cosine(pool, ctx, n, &p, None).await?,
        "mmr_diverse" => {
            let lam = p.num("mmr_lambda");
            let mmr_k = n.max(p.int("mmr_input_k").max(0) as usize);
            cosine(pool, ctx, n, &p, Some((lam, mmr_k))).await?
        }
        "fused" => fused::score(pool, caches, ctx, n, &p, None).await?,
        "ranker" => ranker::score(pool, caches, ctx, n, &p).await?,
        _ => {
            cold_start_result(pool, ctx, n, p.int("min_vote_count"), "cold_start_trending").await?
        }
    }))
}

/// fused scores for exactly `batch`'s candidates, uncapped (household_eval's
/// score_ids: retrieval pinned to the ids, kids_genre_cap 1.0, n = all).
pub async fn fused_score_batch(
    pool: &SqlitePool,
    caches: &Arc<Caches>,
    ctx: &UserContext,
    batch: crate::retrieval::CandidateBatch,
    params: &Params,
) -> Result<HashMap<i64, f64>> {
    let mut params = params.clone();
    params.insert("kids_genre_cap".into(), Param::Float(1.0));
    let p = P {
        defaults: fused::DEFAULTS,
        params: &params,
    };
    let n = batch.candidates.len();
    let res = fused::score(pool, caches, ctx, n, &p, Some(batch)).await?;
    Ok(res.items.iter().map(|i| (i.tmdb_id, i.score)).collect())
}

/// The popularity pool as "trending" items: cold_start_trending, and the
/// fallback of a recipe whose household has no positive embedding.
pub async fn cold_start_result(
    pool: &SqlitePool,
    ctx: &UserContext,
    n: usize,
    min_vote_count: i64,
    path: &str,
) -> Result<RecipeResult> {
    let rows = cold_start_pool(pool, ctx.kind, ctx, n, min_vote_count).await?;
    let items: Vec<ScoredItem> = rows
        .iter()
        .map(|r| ScoredItem {
            tmdb_id: r.tmdb_id,
            title: r.title.clone(),
            year: r.year,
            poster_path: r.poster_path.clone(),
            overview: r.overview.clone(),
            score: r.popularity,
            provenance: "trending",
            reason: trending_reason(r),
        })
        .collect();
    let d = diag(json!({ "path": path, "pool": items.len() }));
    Ok(RecipeResult { items, diag: d })
}

/// baseline_cosine, and mmr_diverse when `mmr` = (lambda, input k): cosine
/// similarity to the positive centroid (minus a share of the negative one)
/// plus a small popularity prior; mmr_diverse then re-ranks the top input k
/// with Maximal Marginal Relevance.
async fn cosine(
    pool: &SqlitePool,
    ctx: &UserContext,
    n: usize,
    p: &P<'_>,
    mmr: Option<(f64, usize)>,
) -> Result<RecipeResult> {
    let pool_size = p.int("pool_size").max(0) as usize;
    let neg_w = p.num("negative_weight");
    let pop_w = p.num("popularity_weight");
    let min_votes = p.int("min_vote_count");
    let tau = p.num("personalized_threshold");

    let Some(pos) = ctx.positive_centroid() else {
        return cold_start_result(pool, ctx, n, min_votes, "cold_start").await;
    };
    let query = match ctx.negative_centroid() {
        // float32, as numpy: pos - float32(neg_w) * neg.
        Some(neg) => {
            let w = neg_w as f32;
            normalize(pos.iter().zip(&neg).map(|(a, b)| a - w * b).collect())
        }
        None => normalize(pos),
    };
    let batch = retrieve_candidates(pool, ctx.kind, &query, ctx, pool_size, min_votes).await?;
    if batch.candidates.is_empty() {
        let d = extend(diag(json!({ "path": "empty_pool" })), &batch.diag);
        return Ok(RecipeResult {
            items: Vec::new(),
            diag: d,
        });
    }

    // sqlite-vec gives cosine distance (0 = identical); back to similarity.
    let pop_max = batch
        .candidates
        .iter()
        .map(|c| c.title.popularity)
        .fold(f64::NEG_INFINITY, f64::max);
    let pop_max = if pop_max == 0.0 { 1.0 } else { pop_max };
    let mut scored: Vec<(f64, f64, &Candidate)> = batch
        .candidates
        .iter()
        .zip(&batch.distances)
        .map(|(c, d)| {
            let sim = 1.0 - d;
            (sim + pop_w * (c.title.popularity / pop_max), sim, c)
        })
        .collect();
    // Stable, so ties keep distance order (Python sort(reverse=True)).
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));

    let (order, d) = match mmr {
        None => {
            scored.truncate(n);
            let d = extend(diag(json!({ "path": "personalized" })), &batch.diag);
            (
                (0..scored.len()).collect::<Vec<_>>(),
                extend(d, &json!({ "tau": tau })),
            )
        }
        Some((lam, mmr_k)) => {
            scored.truncate(mmr_k);
            let cands: Vec<&Candidate> = scored.iter().map(|t| t.2).collect();
            let rel: Vec<f64> = scored.iter().map(|t| t.0).collect();
            let order = mmr_order(&cands, &rel, lam, n);
            let d = extend(diag(json!({ "path": "mmr" })), &batch.diag);
            let d = extend(
                d,
                &json!({ "lambda": lam, "mmr_input": scored.len(), "tau": tau }),
            );
            (order, d)
        }
    };

    let items = order
        .into_iter()
        .map(|i| {
            let (combined, sim, cand) = scored[i];
            let (provenance, reason) = if sim >= tau {
                let neighbors = neighbors_for(cand, ctx, 2);
                ("personalized", personalized_reason(cand, &neighbors))
            } else {
                ("discover", discover_reason(cand))
            };
            ScoredItem {
                tmdb_id: cand.title.tmdb_id,
                title: cand.title.title.clone(),
                year: cand.title.year,
                poster_path: cand.title.poster_path.clone(),
                overview: cand.title.overview.clone(),
                score: combined,
                provenance,
                reason,
            }
        })
        .collect();
    Ok(RecipeResult { items, diag: d })
}

/// Maximal Marginal Relevance in numpy's float32: the most relevant first,
/// then repeatedly the best lambda * relevance - (1 - lambda) * max cosine
/// to anything already picked. Rows with a non-finite or ~zero embedding are
/// skipped. Returns indices into `cands`.
pub fn mmr_order(cands: &[&Candidate], relevance: &[f64], lam: f64, n: usize) -> Vec<usize> {
    let valid: Vec<(usize, Vec<f32>)> = cands
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let nrm = crate::context::norm(&c.embedding);
            (c.embedding.iter().all(|x| x.is_finite()) && nrm.is_finite() && nrm > EMBED_EPS)
                .then(|| (i, c.embedding.iter().map(|x| x / nrm).collect()))
        })
        .collect();
    let rel: Vec<f32> = valid.iter().map(|(i, _)| relevance[*i] as f32).collect();
    let (a, b) = (lam as f32, (1.0 - lam) as f32);
    let dot = |x: &[f32], y: &[f32]| -> f32 { x.iter().zip(y).map(|(p, q)| p * q).sum() };
    let mut selected: Vec<usize> = Vec::new();
    let mut remaining: Vec<usize> = (0..valid.len()).collect();
    // Running max similarity of each row to the selected set.
    let mut max_sim = vec![f32::NEG_INFINITY; valid.len()];
    while !remaining.is_empty() && selected.len() < n {
        let pick = if selected.is_empty() {
            argmax(remaining.iter().map(|&i| rel[i]))
        } else {
            let last = &valid[*selected.last().unwrap()].1;
            for &i in &remaining {
                max_sim[i] = max_sim[i].max(dot(&valid[i].1, last));
            }
            argmax(remaining.iter().map(|&i| a * rel[i] - b * max_sim[i]))
        };
        selected.push(remaining.remove(pick));
    }
    selected.into_iter().map(|i| valid[i].0).collect()
}

/// The first index of the maximum (numpy argmax / Python max).
fn argmax(xs: impl Iterator<Item = f32>) -> usize {
    let mut best = (0, f32::NEG_INFINITY);
    for (i, x) in xs.enumerate() {
        if i == 0 || x > best.1 {
            best = (i, x);
        }
    }
    best.0
}

#[cfg(test)]
mod tests;
