//! ranker (`app/recipes/ranker.py`): a two-stage ranker learned from the
//! household's own judgments.
//!
//! 1. Candidates from an in-memory catalog (no sqlite-vec k cap): the cheap
//!    half of the household model over every eligible title, a quota of the
//!    nearest titles per spherical k-means interest of the positives, and the
//!    best fresh releases by the cheap score.
//! 2. Features against positives P (library + likes, which include stored
//!    engagement) and negatives N (dislikes + vetoes): content cosine to P
//!    (max, top-k mean) and how far it is closer to N than to P, IDF cast /
//!    crew / keyword overlap with P and N, genre / language / decade log-odds
//!    of P vs N, Bayesian rating, vote volume and velocity, popularity, age.
//! 3. Class-balanced logistic regression on P vs N with leave-self-out
//!    features, ridge-shrunk toward PRIOR; cached per (sub, kind).
//! 4. A calibrated greedy slate (Steck 2018): genre mix tracks the
//!    household's, a near-duplicate penalty, one title per collection, a
//!    running fresh floor and the running kids-genre cap.
//!
//! The arithmetic follows numpy's dtypes (float32 embeddings, overlaps and
//! log-odds, float64 elsewhere) and the seeded draws go through crate::rng,
//! so features, weights and slates match the Python recipe.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Datelike;
use serde_json::{Map, Value, json};
use sqlx::{Row, SqlitePool};

use super::fused::{KEY_CREW_JOBS_SQL, dot, is_kids};
use super::{Caches, Def, EMBED_EPS, P, RecipeResult, ScoredItem, cold_start_result, diag};
use crate::config::Config;
use crate::context::{
    Candidate, UserContext, get_active_model_config, load_title_rows, normalize_title_key,
};
use crate::db::{GENRE_AGG_SQL, deserialize_f32, table_generation};
use crate::reasons::{discover_reason, personalized_reason};
use crate::retrieval::AVAILABLE_TITLE_PREDICATE;
use crate::rng::Generator;
use crate::{Error, Result};

pub const DEFAULTS: &[(&str, Def)] = &[
    // Candidates scored by the full model.
    ("pool_size", Def::Int(600)),
    // Max k-means interests over the positives.
    ("interest_clusters", Def::Int(12)),
    ("min_vote_count", Def::Int(50)),
    // Pull toward PRIOR (units: one balanced sample).
    ("ridge", Def::Float(10.0)),
    // Slate genre mix vs relevance (Steck lambda).
    ("calibration", Def::Float(0.3)),
    // Penalty on similarity to already-picked titles.
    ("redundancy", Def::Float(0.1)),
    // Running floor of titles out this year or last.
    ("fresh_share", Def::Float(0.25)),
    ("kids_genre_cap", Def::Float(0.35)),
    // Neighbour affinity for "personalized".
    ("personalized_threshold", Def::Float(0.55)),
];

pub const FEATURES: [&str; NF] = [
    "sim_pos_max",
    "sim_pos_topk",
    "neg_excess_max",
    "neg_excess_topk",
    "cast_pos",
    "cast_neg",
    "crew_pos",
    "crew_neg",
    "kw_pos",
    "kw_neg",
    "genre_lo",
    "lang_lo",
    "decade_lo",
    "rating",
    "log_votes",
    "log_vote_rate",
    "log_pop",
    "age",
];
pub const NF: usize = 18;
/// genre_lo .. age: computable for the whole catalog without per-title
/// overlaps; they drive the learned-cheap candidate source.
const CHEAP: std::ops::Range<usize> = 10..NF;

/// Standardized-feature weights a household starts from; the ridge pulls
/// the fit toward these.
const PRIOR: [f64; NF] = [
    0.3, 0.5, -0.3, -0.5, 0.2, -0.2, 0.2, -0.2, 0.2, -0.2, 0.5, 0.3, 0.2, 0.3, 0.2, 0.2, 0.1, 0.0,
];

// Neighbours averaged by the *_topk features.
const TOPK: usize = 10;
// Category-rate prior, as a share of each class.
const LOGODDS_PRIOR: f64 = 0.1;
// Judgments before a category's log-odds count fully.
const LOGODDS_EVIDENCE: f32 = 20.0;
// Top-billed cast only, as fused.
const CAST_TOPN: i64 = 10;
// Bayesian-average pseudo-votes.
const RATING_PRIOR_VOTES: f64 = 200.0;
const MAX_TRAIN_PER_CLASS: usize = 1500;
const MODEL_TTL: Duration = Duration::from_secs(12 * 3600);
// Top-scored candidates the slate chooses from.
const SLATE_INPUT: usize = 150;
// Plus the top fresh ones, so the floor can be met.
const FRESH_INPUT: usize = 40;
const CALIBRATION_SMOOTHING: f64 = 0.01;

// --- catalog ---------------------------------------------------------------

/// Sparse rows (column, value), columns ascending.
#[derive(Debug, Default)]
pub struct Sparse {
    pub rows: Vec<Vec<(usize, f32)>>,
    pub ncols: usize,
}

impl Sparse {
    /// scipy's csr_matrix from (row, col, 1.0) triples: duplicates summed,
    /// columns sorted, at least one column.
    fn from_entries(n: usize, entries: impl Iterator<Item = (usize, usize)>, ncols: usize) -> Self {
        let mut rows: Vec<Vec<(usize, f32)>> = vec![Vec::new(); n];
        for (r, c) in entries {
            rows[r].push((c, 1.0));
        }
        for row in &mut rows {
            row.sort_by_key(|e| e.0);
            row.dedup_by(|b, a| {
                let same = a.0 == b.0;
                if same {
                    a.1 += b.1;
                }
                same
            });
        }
        Self {
            rows,
            ncols: ncols.max(1),
        }
    }

    /// One-hot / multi-hot over a vocabulary built in first-seen order.
    fn onehot<K: std::hash::Hash + Eq>(codes: Vec<Vec<K>>) -> Self {
        let n = codes.len();
        let mut vocab: HashMap<K, usize> = HashMap::new();
        let mut entries = Vec::new();
        for (r, cs) in codes.into_iter().enumerate() {
            for c in cs {
                let next = vocab.len();
                entries.push((r, *vocab.entry(c).or_insert(next)));
            }
        }
        let ncols = vocab.len();
        Self::from_entries(n, entries.into_iter(), ncols)
    }

    /// Column sums of `rows` (float32, as scipy sums a float32 matrix).
    fn col_sums(&self, rows: impl Iterator<Item = usize>) -> Vec<f32> {
        let mut out = vec![0f32; self.ncols];
        for r in rows {
            for &(c, v) in &self.rows[r] {
                out[c] += v;
            }
        }
        out
    }
}

pub struct Catalog {
    pub ids: Vec<i64>,
    pub row: HashMap<i64, usize>,
    pub dim: usize,
    /// Unit rows, flattened.
    pub emb: Vec<f32>,
    pub genre: Sparse,
    pub lang: Sparse,
    pub decade: Sparse,
    pub genres: Vec<Vec<i64>>,
    /// Bayesian average, centred.
    pub rating: Vec<f64>,
    pub log_votes: Vec<f64>,
    /// Votes per year out: lifetime votes bury new releases.
    pub log_vote_rate: Vec<f64>,
    pub log_pop: Vec<f64>,
    /// Decades since release, 0..=12.
    pub age: Vec<f64>,
    /// Released (tv: last aired) this year or last.
    pub fresh: Vec<bool>,
    pub vote_count: Vec<f64>,
    pub available: Vec<bool>,
    /// TMDB collection id, 0 = none.
    pub collection: Vec<i64>,
    pub key: Vec<Option<String>>,
    /// IDF-weighted, L2-normalized top-billed cast / key crew / keywords.
    pub cast: Sparse,
    pub crew: Sparse,
    pub kw: Sparse,
}

impl Catalog {
    pub fn emb(&self, r: usize) -> &[f32] {
        &self.emb[r * self.dim..(r + 1) * self.dim]
    }
}

/// Catalog-aligned rows of IDF-weighted, L2-normalized people or keywords
/// (float32 throughout, as scipy computed them).
fn creators(pairs: &[(i64, i64)], row: &HashMap<i64, usize>, n: usize) -> Sparse {
    let mut vocab: HashMap<i64, usize> = HashMap::new();
    let mut entries = Vec::new();
    for (tid, key) in pairs {
        if let Some(&r) = row.get(tid) {
            let next = vocab.len();
            entries.push((r, *vocab.entry(*key).or_insert(next)));
        }
    }
    let ncols = vocab.len();
    let mut m = Sparse::from_entries(n, entries.into_iter(), ncols);
    let mut df = vec![0usize; m.ncols];
    for row in &mut m.rows {
        for e in row.iter_mut() {
            e.1 = 1.0;
            df[e.0] += 1;
        }
    }
    let idf: Vec<f32> = df
        .iter()
        .map(|d| (((1.0 + n as f64) / (1.0 + *d as f64)).ln() + 1.0) as f32)
        .collect();
    for row in &mut m.rows {
        row.iter_mut().for_each(|e| e.1 *= idf[e.0]);
        let norm = row.iter().map(|e| e.1 * e.1).sum::<f32>().sqrt();
        let inv = 1.0f32 / if norm == 0.0 { 1.0 } else { norm };
        row.iter_mut().for_each(|e| e.1 *= inv);
    }
    m
}

/// Build the kind's catalog from exchange.db. `this_year` dates `fresh`/`age`.
pub async fn build_catalog(
    pool: &SqlitePool,
    kind: &'static str,
    this_year: i32,
) -> Result<Catalog> {
    let (collection_sql, last_air_sql) = if kind == "movie" {
        (
            "json_extract(t.raw_json, '$.belongs_to_collection.id')",
            "NULL",
        )
    } else {
        // A returning show with a new season is as topical as a premiere.
        (
            "NULL",
            "substr(json_extract(t.raw_json, '$.last_air_date'), 1, 4)",
        )
    };
    let sql = format!(
        "SELECT t.tmdb_id, t.title, t.year, t.vote_average,
                COALESCE(t.vote_count, 0) AS vote_count,
                COALESCE(t.popularity, 0) AS popularity, t.original_language,
                CASE WHEN {AVAILABLE_TITLE_PREDICATE} THEN 1 ELSE 0 END AS available,
                {collection_sql} AS collection, {last_air_sql} AS last_air_year,
                {GENRE_AGG_SQL},
                f.embedding AS embedding, f.dim AS dim
         FROM titles t
         JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
         WHERE t.kind = ?"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(kind)
        .fetch_all(pool)
        .await?;
    let pairs = |sql: String| {
        sqlx::query_as::<_, (i64, i64)>(sqlx::AssertSqlSafe(sql))
            .bind(kind)
            .fetch_all(pool)
    };
    let cast = pairs(format!(
        "SELECT tmdb_id, person_id FROM title_cast WHERE kind = ? AND order_idx < {CAST_TOPN}"
    ))
    .await?;
    let crew = pairs(format!(
        "SELECT DISTINCT tmdb_id, person_id FROM title_crew WHERE kind = ? AND job IN ({KEY_CREW_JOBS_SQL})"
    ))
    .await?;
    let kw = pairs("SELECT tmdb_id, keyword_id FROM title_keywords WHERE kind = ?".into()).await?;

    struct Raw {
        tmdb_id: i64,
        title: String,
        year: f64,
        vote_average: f64,
        votes: f64,
        popularity: f64,
        lang: String,
        available: bool,
        collection: i64,
        last_air_year: f64,
        genres: Vec<i64>,
        emb: Vec<f32>,
    }
    let mut raw = Vec::with_capacity(rows.len());
    for r in &rows {
        let dim: i64 = r.try_get("dim")?;
        let genres: Option<String> = r.try_get("genres")?;
        let last_air: Option<String> = r.try_get_unchecked("last_air_year")?;
        let lang: Option<String> = r.try_get("original_language")?;
        let year: Option<i64> = r.try_get_unchecked("year")?;
        raw.push(Raw {
            tmdb_id: r.try_get("tmdb_id")?,
            title: r.try_get("title")?,
            // `year or nan`: 0 counts as unknown.
            year: year.filter(|y| *y != 0).map_or(f64::NAN, |y| y as f64),
            vote_average: r
                .try_get_unchecked::<Option<f64>, _>("vote_average")?
                .unwrap_or(0.0),
            votes: r.try_get_unchecked::<f64, _>("vote_count")?,
            popularity: r.try_get_unchecked::<f64, _>("popularity")?,
            lang: lang.filter(|l| !l.is_empty()).unwrap_or_else(|| "?".into()),
            available: r.try_get::<i64, _>("available")? != 0,
            collection: r
                .try_get_unchecked::<Option<i64>, _>("collection")?
                .unwrap_or(0),
            last_air_year: last_air
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                .map_or(f64::NAN, |s| s.parse().unwrap_or(f64::NAN)),
            genres: genres
                .filter(|g| !g.is_empty())
                .map(|g| g.split(',').filter_map(|x| x.parse().ok()).collect())
                .unwrap_or_default(),
            emb: deserialize_f32(r.try_get::<&[u8], _>("embedding")?, Some(dim as usize))?,
        });
    }
    tokio::task::spawn_blocking(move || {
        let n = raw.len();
        let dim = raw.first().map_or(1, |r| r.emb.len());
        if raw.iter().any(|r| r.emb.len() != dim) {
            return Err(Error::Invalid("title_features rows differ in dim".into()));
        }
        let mut emb = Vec::with_capacity(n * dim);
        for r in &raw {
            let norm = (r
                .emb
                .iter()
                .map(|x| f64::from(*x) * f64::from(*x))
                .sum::<f64>()
                .sqrt() as f32)
                .max(EMBED_EPS);
            emb.extend(r.emb.iter().map(|x| x / norm));
        }
        let votes: Vec<f64> = raw.iter().map(|r| r.votes).collect();
        let vote_sum: f64 = votes.iter().sum();
        let mean_rating =
            raw.iter().map(|r| r.vote_average * r.votes).sum::<f64>() / vote_sum.max(1.0);
        let this = f64::from(this_year);
        let age: Vec<f64> = raw
            .iter()
            .map(|r| {
                let y = if r.year.is_nan() { this } else { r.year };
                ((this - y) / 10.0).clamp(0.0, 12.0)
            })
            .collect();
        let row: HashMap<i64, usize> = raw
            .iter()
            .enumerate()
            .map(|(i, r)| (r.tmdb_id, i))
            .collect();
        Ok(Catalog {
            ids: raw.iter().map(|r| r.tmdb_id).collect(),
            dim,
            emb,
            genre: Sparse::onehot(raw.iter().map(|r| r.genres.clone()).collect()),
            lang: Sparse::onehot(raw.iter().map(|r| vec![r.lang.clone()]).collect()),
            decade: Sparse::onehot(
                raw.iter()
                    .map(|r| {
                        vec![if r.year.is_nan() {
                            -1
                        } else {
                            (r.year / 10.0).floor() as i64
                        }]
                    })
                    .collect(),
            ),
            genres: raw.iter().map(|r| r.genres.clone()).collect(),
            rating: raw
                .iter()
                .map(|r| {
                    (r.votes * r.vote_average + RATING_PRIOR_VOTES * mean_rating)
                        / (r.votes + RATING_PRIOR_VOTES)
                        - mean_rating
                })
                .collect(),
            log_votes: votes.iter().map(|v| (1.0 + v).log10()).collect(),
            log_vote_rate: votes
                .iter()
                .zip(&age)
                .map(|(v, a)| (1.0 + v / (a * 10.0 + 0.5)).log10())
                .collect(),
            log_pop: raw.iter().map(|r| (1.0 + r.popularity).log10()).collect(),
            fresh: raw
                .iter()
                .map(|r| {
                    let recent = r.year.max(r.last_air_year); // fmax: NaN loses
                    (if recent.is_nan() { 0.0 } else { recent }) >= this - 1.0
                })
                .collect(),
            age,
            vote_count: votes,
            available: raw.iter().map(|r| r.available).collect(),
            collection: raw.iter().map(|r| r.collection).collect(),
            key: raw.iter().map(|r| normalize_title_key(&r.title)).collect(),
            cast: creators(&cast, &row, n),
            crew: creators(&crew, &row, n),
            kw: creators(&kw, &row, n),
            row,
        })
    })
    .await
    .map_err(|e| Error::Invalid(format!("catalog build panicked: {e}")))?
}

impl Caches {
    fn this_year(&self) -> i32 {
        self.this_year.unwrap_or_else(|| chrono::Utc::now().year())
    }

    /// The cached catalog. Requests never revalidate it (the fingerprint is
    /// full-table scans over a multi-GB DB); `warm` (startup + hourly)
    /// rebuilds it when the catalog tables moved.
    pub async fn catalog(
        &self,
        pool: &SqlitePool,
        kind: &'static str,
        refresh: bool,
    ) -> Result<Arc<Catalog>> {
        let hit = self.catalogs.lock().unwrap().get(kind).cloned();
        if let Some((_, c)) = &hit
            && !refresh
        {
            return Ok(c.clone());
        }
        let generation = table_generation(
            pool,
            &[
                ("titles", Some("fetched_at")),
                ("title_features", Some("computed_at")),
            ],
        )
        .await?;
        if let Some((g, c)) = &hit
            && *g == generation
        {
            return Ok(c.clone());
        }
        let _build = self.catalog_build.lock().await;
        if let Some((g, c)) = self.catalogs.lock().unwrap().get(kind)
            && *g == generation
        {
            return Ok(c.clone());
        }
        let cat = Arc::new(build_catalog(pool, kind, self.this_year()).await?);
        tracing::info!(
            "ranker catalog loaded: kind={kind} titles={}",
            cat.ids.len()
        );
        self.catalogs
            .lock()
            .unwrap()
            .insert(kind, (generation, cat.clone()));
        Ok(cat)
    }
}

/// Rebuild both catalogs off the request path if their tables moved.
pub async fn warm(pool: &SqlitePool, caches: &Caches) -> Result<()> {
    for kind in ["movie", "tv"] {
        caches.catalog(pool, kind, true).await?;
    }
    Ok(())
}

/// The hourly warm: only while the active model_config is the ranker.
pub async fn warm_if_active(pool: &SqlitePool, config: &Config, caches: &Caches) -> Result<()> {
    if get_active_model_config(pool, config).await?.1 == "ranker" {
        warm(pool, caches).await?;
    }
    Ok(())
}

// --- household reference sets + features ----------------------------------

pub struct Refs {
    pub pos: Vec<usize>,
    pub neg: Vec<usize>,
    pub pos_col: HashMap<usize, usize>,
    pub neg_col: HashMap<usize, usize>,
    /// Per category: plain, minus-self-in-P, minus-self-in-N.
    pub lo_genre: [Vec<f32>; 3],
    pub lo_lang: [Vec<f32>; 3],
    pub lo_decade: [Vec<f32>; 3],
}

/// log P(cat | P) - log P(cat | N) per category, plus the leave-self-out
/// variants for a member of P or of N. Each class's rate is smoothed toward
/// the category's catalog share with a prior sized to that class (an empty
/// class's rate is the share itself), and the result is shrunk by the
/// category's evidence. float32, as numpy computed it.
pub fn logodds(m: &Sparse, pos: &[usize], neg: &[usize]) -> [Vec<f32>; 3] {
    let nrows = m.rows.len().max(1) as f32;
    let share: Vec<f32> = m
        .col_sums(0..m.rows.len())
        .iter()
        .map(|s| s / nrows)
        .collect();
    let cp = m.col_sums(pos.iter().copied());
    let cn = m.col_sums(neg.iter().copied());
    let (n_p, n_n) = (pos.len() as f64, neg.len() as f64);
    let rate = |c: f32, n: f64, s: f32| -> f32 {
        if n > 0.0 {
            (c + (LOGODDS_PRIOR * n) as f32 * s) / ((1.0 + LOGODDS_PRIOR) * n) as f32
        } else {
            s
        }
    };
    let lo = |cp: &[f32], n_p: f64, cn: &[f32], n_n: f64| -> Vec<f32> {
        (0..share.len())
            .map(|c| {
                let raw = (rate(cp[c], n_p, share[c]) / rate(cn[c], n_n, share[c])).ln();
                let evidence = cp[c] + cn[c];
                let v = if evidence > 0.0 { nan_to_num(raw) } else { 0.0 };
                v * evidence / (evidence + LOGODDS_EVIDENCE)
            })
            .collect()
    };
    let minus = |c: &[f32]| c.iter().map(|x| (x - 1.0).max(0.0)).collect::<Vec<_>>();
    [
        lo(&cp, n_p, &cn, n_n),
        lo(&minus(&cp), (n_p - 1.0).max(0.0), &cn, n_n),
        lo(&cp, n_p, &minus(&cn), (n_n - 1.0).max(0.0)),
    ]
}

fn nan_to_num(x: f32) -> f32 {
    if x.is_nan() {
        0.0
    } else if x == f32::INFINITY {
        f32::MAX
    } else if x == f32::NEG_INFINITY {
        f32::MIN
    } else {
        x
    }
}

pub fn refs(cat: &Catalog, pos_ids: &HashSet<i64>, neg_ids: &HashSet<i64>) -> Refs {
    let rows = |ids: &mut dyn Iterator<Item = &i64>| -> Vec<usize> {
        let mut v: Vec<usize> = ids.filter_map(|t| cat.row.get(t).copied()).collect();
        v.sort_unstable();
        v
    };
    let pos = rows(&mut pos_ids.iter());
    let neg = rows(&mut neg_ids.iter().filter(|t| !pos_ids.contains(t)));
    Refs {
        pos_col: pos.iter().enumerate().map(|(j, r)| (*r, j)).collect(),
        neg_col: neg.iter().enumerate().map(|(j, r)| (*r, j)).collect(),
        lo_genre: logodds(&cat.genre, &pos, &neg),
        lo_lang: logodds(&cat.lang, &pos, &neg),
        lo_decade: logodds(&cat.decade, &pos, &neg),
        pos,
        neg,
    }
}

/// The row's mean category log-odds (the leave-self-out variant for a
/// member of P or N).
fn mean_logodds(m: &Sparse, r: usize, lo: &[Vec<f32>; 3], variant: usize) -> f32 {
    let row = &m.rows[r];
    let per: f32 = row.iter().map(|&(c, v)| v * lo[variant][c]).sum();
    let count: f32 = row.iter().map(|e| e.1).sum();
    per / count.max(1.0)
}

/// The eight cheap features (genre_lo .. age) of catalog row `r`.
fn cheap(cat: &Catalog, refs: &Refs, r: usize, variant: usize) -> [f64; 8] {
    [
        f64::from(mean_logodds(&cat.genre, r, &refs.lo_genre, variant)),
        f64::from(mean_logodds(&cat.lang, r, &refs.lo_lang, variant)),
        f64::from(mean_logodds(&cat.decade, r, &refs.lo_decade, variant)),
        cat.rating[r],
        cat.log_votes[r],
        cat.log_vote_rate[r],
        cat.log_pop[r],
        cat.age[r],
    ]
}

/// Row max and top-k mean with the row's own column set to `fill`.
fn sim_stats(sim: &[f32], own: Option<usize>, fill: f32) -> (f32, f32) {
    if sim.is_empty() {
        return (0.0, 0.0);
    }
    let mut s = sim.to_vec();
    if let Some(c) = own {
        s[c] = fill;
    }
    let k = TOPK.min(s.len());
    let mut top: Vec<f32> = Vec::with_capacity(k + 1);
    for &v in &s {
        if top.len() < k || v > top[k - 1] {
            let at = top.partition_point(|t| *t >= v);
            top.insert(at, v);
            top.truncate(k);
        }
    }
    let mean = (top.iter().map(|v| f64::from(*v)).sum::<f64>() / k as f64) as f32;
    (top[0], mean)
}

/// column -> [(reference index, value)] over the reference rows.
fn inverted(m: &Sparse, refs: &[usize]) -> HashMap<usize, Vec<(usize, f32)>> {
    let mut inv: HashMap<usize, Vec<(usize, f32)>> = HashMap::new();
    for (j, &r) in refs.iter().enumerate() {
        for &(c, v) in &m.rows[r] {
            inv.entry(c).or_default().push((j, v));
        }
    }
    inv
}

/// The overlap (sparse dot, float32) of catalog row `r` with every reference.
fn overlap(
    m: &Sparse,
    r: usize,
    inv: &HashMap<usize, Vec<(usize, f32)>>,
    n_refs: usize,
) -> Vec<f32> {
    let mut out = vec![0f32; n_refs];
    for &(c, v) in &m.rows[r] {
        for &(j, w) in inv.get(&c).map(Vec::as_slice).unwrap_or(&[]) {
            out[j] += v * w;
        }
    }
    out
}

/// The feature rows of `rows`, plus each row's affinity to every positive
/// (content + half of each creator overlap, its own column -inf), which
/// names the "because you have" neighbours.
pub fn features(cat: &Catalog, refs: &Refs, rows: &[usize]) -> (Vec<[f64; NF]>, Vec<Vec<f32>>) {
    let mats = [&cat.cast, &cat.crew, &cat.kw];
    let inv_pos: Vec<_> = mats.iter().map(|m| inverted(m, &refs.pos)).collect();
    let inv_neg: Vec<_> = mats.iter().map(|m| inverted(m, &refs.neg)).collect();
    let (np_, nn) = (refs.pos.len(), refs.neg.len());
    let mut xs = Vec::with_capacity(rows.len());
    let mut affinity = Vec::with_capacity(rows.len());
    for &r in rows {
        let own_p = refs.pos_col.get(&r).copied();
        let own_n = refs.neg_col.get(&r).copied();
        let e = cat.emb(r);
        let s_pos: Vec<f32> = refs.pos.iter().map(|&p| dot(e, cat.emb(p))).collect();
        let s_neg: Vec<f32> = refs.neg.iter().map(|&q| dot(e, cat.emb(q))).collect();
        let (pos_max, pos_topk) = sim_stats(&s_pos, own_p, -1.0);
        let (neg_max, neg_topk) = sim_stats(&s_neg, own_n, -1.0);
        let mut x = [0f64; NF];
        x[0] = f64::from(pos_max);
        x[1] = f64::from(pos_topk);
        if nn > 0 {
            x[2] = f64::from((neg_max - pos_max).max(0.0));
            x[3] = f64::from((neg_topk - pos_topk).max(0.0));
        }
        let mut aff = s_pos;
        for (k, m) in mats.iter().enumerate() {
            let ov_pos = overlap(m, r, &inv_pos[k], np_);
            let ov_neg = overlap(m, r, &inv_neg[k], nn);
            x[4 + 2 * k] = f64::from(sim_stats(&ov_pos, own_p, 0.0).0);
            x[5 + 2 * k] = f64::from(sim_stats(&ov_neg, own_n, 0.0).0);
            aff.iter_mut().zip(&ov_pos).for_each(|(a, o)| *a += 0.5 * o);
        }
        let variant = if own_p.is_some() {
            1
        } else if own_n.is_some() {
            2
        } else {
            0
        };
        x[CHEAP].copy_from_slice(&cheap(cat, refs, r, variant));
        if let Some(c) = own_p {
            aff[c] = f32::NEG_INFINITY;
        }
        xs.push(x);
        affinity.push(aff);
    }
    (xs, affinity)
}

// --- per-household model ---------------------------------------------------

#[derive(Debug)]
pub struct Model {
    /// Standardized weights, bias last.
    pub w: [f64; NF + 1],
    pub mean: [f64; NF],
    pub std: [f64; NF],
    pub n_pos: usize,
    pub n_neg: usize,
    pub train_auc: f64,
    pub fitted_at: Instant,
    pub ridge: f64,
}

impl Model {
    pub fn z(&self, x: &[f64; NF]) -> f64 {
        (0..NF)
            .map(|c| (x[c] - self.mean[c]) / self.std[c] * self.w[c])
            .sum::<f64>()
            + self.w[NF]
    }

    /// The cheap columns' share of z (no bias).
    fn z_cheap(&self, x: &[f64; 8]) -> f64 {
        CHEAP
            .enumerate()
            .map(|(i, c)| (x[i] - self.mean[c]) / self.std[c] * self.w[c])
            .sum()
    }
}

/// Class-balanced logistic regression, L2-shrunk toward PRIOR (bias
/// unshrunk), by Newton's method.
pub fn fit_logistic(x: &[[f64; NF]], y: &[f64], ridge: f64) -> [f64; NF + 1] {
    const F: usize = NF + 1;
    let n = x.len() as f64;
    let pos: f64 = y.iter().sum();
    let (sw_p, sw_n) = (n / (2.0 * pos.max(1.0)), n / (2.0 * (n - pos).max(1.0)));
    let mut target = [0f64; F];
    target[..NF].copy_from_slice(&PRIOR);
    let mut reg = [ridge; F];
    reg[NF] = 1e-6;
    let mut w = target;
    let xb = |row: &[f64; NF], c: usize| if c < NF { row[c] } else { 1.0 };
    for _ in 0..50 {
        let mut grad = [0f64; F];
        let mut hess = [[0f64; F]; F];
        for (row, &yi) in x.iter().zip(y) {
            let xr: [f64; F] = std::array::from_fn(|c| xb(row, c));
            let t: f64 = xr.iter().zip(&w).map(|(a, b)| a * b).sum();
            let p = 1.0 / (1.0 + (-t.clamp(-30.0, 30.0)).exp());
            let sw = if yi == 1.0 { sw_p } else { sw_n };
            let g = sw * (p - yi);
            let h = sw * p * (1.0 - p);
            for ((gr, hrow), xa) in grad.iter_mut().zip(&mut hess).zip(&xr) {
                *gr += xa * g;
                for (hv, xv) in hrow.iter_mut().zip(&xr) {
                    *hv += xa * h * xv;
                }
            }
        }
        for a in 0..F {
            grad[a] += reg[a] * (w[a] - target[a]);
            hess[a][a] += reg[a];
        }
        let step = solve(hess, grad);
        let mut big = 0f64;
        for a in 0..F {
            w[a] -= step[a];
            big = big.max(step[a].abs());
        }
        if big < 1e-7 {
            break;
        }
    }
    w
}

/// Gaussian elimination with partial pivoting (LAPACK gesv's LU).
fn solve<const F: usize>(mut a: [[f64; F]; F], mut b: [f64; F]) -> [f64; F] {
    for col in 0..F {
        let piv = (col..F)
            .max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()).then(j.cmp(&i)))
            .unwrap();
        a.swap(col, piv);
        b.swap(col, piv);
        for r in col + 1..F {
            let f = a[r][col] / a[col][col];
            if f != 0.0 {
                let (upper, lower) = a.split_at_mut(r);
                for (x, p) in lower[0][col..].iter_mut().zip(&upper[col][col..]) {
                    *x -= f * p;
                }
                b[r] -= f * b[col];
            }
        }
    }
    let mut x = [0f64; F];
    for r in (0..F).rev() {
        let s: f64 = (r + 1..F).map(|c| a[r][c] * x[c]).sum();
        x[r] = (b[r] - s) / a[r][r];
    }
    x
}

/// Rank AUC (ties ranked by position, as argsort().argsort() did).
fn auc(s: &[f64], y: &[f64]) -> f64 {
    let mut order: Vec<usize> = (0..s.len()).collect();
    order.sort_by(|a, b| s[*a].total_cmp(&s[*b]));
    let mut rank = vec![0f64; s.len()];
    for (k, &i) in order.iter().enumerate() {
        rank[i] = k as f64 + 1.0;
    }
    let n1: f64 = y.iter().sum();
    let n0 = y.len() as f64 - n1;
    if n1 == 0.0 || n0 == 0.0 {
        return f64::NAN;
    }
    let r1: f64 = rank
        .iter()
        .zip(y)
        .filter(|(_, y)| **y == 1.0)
        .map(|(r, _)| r)
        .sum();
    (r1 - n1 * (n1 + 1.0) / 2.0) / (n1 * n0)
}

/// Fit the household model from scratch (no cache).
pub fn fit_model(sub: &str, cat: &Catalog, refs: &Refs, ridge: f64) -> Model {
    let (n_pos, n_neg) = (refs.pos.len(), refs.neg.len());
    let seed = sub.chars().count() * 7919 + n_pos * 31 + n_neg;
    let mut rng = Generator::new(seed as u128);
    let mut sample = |v: &[usize]| -> Vec<usize> {
        if v.len() <= MAX_TRAIN_PER_CLASS {
            v.to_vec()
        } else {
            rng.choice(v.len(), MAX_TRAIN_PER_CLASS)
                .into_iter()
                .map(|i| v[i])
                .collect()
        }
    };
    let pos = sample(&refs.pos);
    let neg = sample(&refs.neg);
    let rows: Vec<usize> = pos.iter().chain(&neg).copied().collect();
    let y: Vec<f64> = (0..rows.len())
        .map(|i| f64::from(u8::from(i < pos.len())))
        .collect();
    let (x, _) = features(cat, refs, &rows);
    let n = x.len() as f64;
    let mut mean = [0f64; NF];
    let mut std = [0f64; NF];
    for c in 0..NF {
        mean[c] = x.iter().map(|r| r[c]).sum::<f64>() / n;
        let var = x.iter().map(|r| (r[c] - mean[c]).powi(2)).sum::<f64>() / n;
        std[c] = var.sqrt();
        if std[c] < 1e-9 {
            std[c] = 1.0;
        }
    }
    let xs: Vec<[f64; NF]> = x
        .iter()
        .map(|r| std::array::from_fn(|c| (r[c] - mean[c]) / std[c]))
        .collect();
    let both = !pos.is_empty() && !neg.is_empty();
    let w = if both {
        fit_logistic(&xs, &y, ridge)
    } else {
        let mut w = [0f64; NF + 1];
        w[..NF].copy_from_slice(&PRIOR);
        w
    };
    let train_auc = if both {
        let s: Vec<f64> = xs
            .iter()
            .map(|r| (0..NF).map(|c| r[c] * w[c]).sum())
            .collect();
        auc(&s, &y)
    } else {
        f64::NAN
    };
    Model {
        w,
        mean,
        std,
        n_pos,
        n_neg,
        train_auc,
        fitted_at: Instant::now(),
        ridge,
    }
}

impl Caches {
    /// The household's fitted weights, reused across catalog reloads (they
    /// hold no catalog rows); refit on TTL, a ridge change, or judgment-count
    /// drift.
    fn model(
        &self,
        sub: &str,
        kind: &'static str,
        cat: &Catalog,
        refs: &Refs,
        ridge: f64,
    ) -> Arc<Model> {
        let key = (sub.to_string(), kind);
        let (n_pos, n_neg) = (refs.pos.len(), refs.neg.len());
        if let Some(m) = self.models.lock().unwrap().get(&key)
            && m.ridge == ridge
            && m.fitted_at.elapsed() < MODEL_TTL
            && ((m.n_pos.abs_diff(n_pos) + m.n_neg.abs_diff(n_neg)) as f64)
                < 10f64.max(0.02 * (n_pos + n_neg) as f64)
        {
            return m.clone();
        }
        let _fit = self.model_fit.lock().unwrap();
        let m = Arc::new(fit_model(sub, cat, refs, ridge));
        tracing::info!(
            "ranker model fit: kind={kind} pos={n_pos} neg={n_neg} train_auc={:.3}",
            m.train_auc
        );
        self.models.lock().unwrap().insert(key, m.clone());
        m
    }
}

// --- candidates --------------------------------------------------------------

/// Indices of the `k` largest of `v` (argpartition's set; ties to the
/// earlier index).
fn top_k(v: &[f64], k: usize) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..v.len()).collect();
    idx.sort_by(|a, b| v[*b].total_cmp(&v[*a]));
    idx.truncate(k);
    idx
}

/// Spherical k-means: (k unit centroids, cluster sizes).
pub fn interests(cat: &Catalog, rows: &[usize], k: usize) -> (Vec<Vec<f32>>, Vec<usize>) {
    let k = k.min(rows.len()).max(1);
    let mut rng = Generator::new(0);
    let mut cent: Vec<Vec<f32>> = rng
        .choice(rows.len(), k)
        .into_iter()
        .map(|i| cat.emb(rows[i]).to_vec())
        .collect();
    let mut assign = vec![0usize; rows.len()];
    for _ in 0..15 {
        for (a, &r) in assign.iter_mut().zip(rows) {
            let e = cat.emb(r);
            *a = argmax(cent.iter().map(|c| f64::from(dot(e, c))));
        }
        for (c, centroid) in cent.iter_mut().enumerate() {
            let mut v: Option<Vec<f32>> = None;
            for (_, &r) in assign.iter().zip(rows).filter(|(a, _)| **a == c) {
                match &mut v {
                    None => v = Some(cat.emb(r).to_vec()),
                    Some(s) => s.iter_mut().zip(cat.emb(r)).for_each(|(a, b)| *a += b),
                }
            }
            if let Some(v) = v {
                let norm = (dot(&v, &v) as f64).sqrt() as f32;
                let norm = norm.max(EMBED_EPS);
                *centroid = v.into_iter().map(|x| x / norm).collect();
            }
        }
    }
    let mut sizes = vec![0usize; k];
    assign.iter().for_each(|a| sizes[*a] += 1);
    (cent, sizes)
}

/// The first index of the maximum.
fn argmax(xs: impl Iterator<Item = f64>) -> usize {
    let mut best = (0, f64::NEG_INFINITY);
    for (i, x) in xs.enumerate() {
        if i == 0 || x > best.1 {
            best = (i, x);
        }
    }
    best.0
}

pub struct Signals {
    pub sub: String,
    pub kind: &'static str,
    pub library: HashSet<i64>,
    pub liked: HashSet<i64>,
    pub disliked: HashSet<i64>,
    pub rejected: HashSet<i64>,
    pub shown: HashSet<i64>,
}

impl From<&UserContext> for Signals {
    fn from(c: &UserContext) -> Self {
        Self {
            sub: c.sub.clone(),
            kind: c.kind,
            library: c.library_ids.clone(),
            liked: c.liked_ids.clone(),
            disliked: c.disliked_ids.clone(),
            rejected: c.rejected_ids.clone(),
            shown: c.recently_shown_ids.clone(),
        }
    }
}

impl Signals {
    /// (positives, negatives): library + likes, dislikes + vetoes.
    pub fn refs(&self, cat: &Catalog) -> Refs {
        let pos: HashSet<i64> = self.library.union(&self.liked).copied().collect();
        let neg: HashSet<i64> = self.disliked.union(&self.rejected).copied().collect();
        refs(cat, &pos, &neg)
    }
}

/// Available, enough votes, not owned / vetoed / disliked / just shown /
/// liked, and not an exact owned title under another tmdb id.
pub fn eligible(sig: &Signals, cat: &Catalog, min_votes: i64) -> Vec<bool> {
    let mut ok: Vec<bool> = (0..cat.ids.len())
        .map(|r| cat.available[r] && cat.vote_count[r] >= min_votes as f64)
        .collect();
    for set in [
        &sig.library,
        &sig.rejected,
        &sig.disliked,
        &sig.shown,
        &sig.liked,
    ] {
        for t in set {
            if let Some(&r) = cat.row.get(t) {
                ok[r] = false;
            }
        }
    }
    let owned: HashSet<&str> = sig
        .library
        .iter()
        .filter_map(|t| cat.row.get(t).and_then(|r| cat.key[*r].as_deref()))
        .collect();
    if !owned.is_empty() {
        for (o, k) in ok.iter_mut().zip(&cat.key) {
            if k.as_deref().is_some_and(|k| owned.contains(k)) {
                *o = false;
            }
        }
    }
    ok
}

/// The candidate rows (ascending) and the per-source counts.
pub fn candidates(
    cat: &Catalog,
    refs: &Refs,
    model: &Model,
    ok: &[bool],
    pool: usize,
    k_max: usize,
) -> (Vec<usize>, Map<String, Value>) {
    let elig: Vec<usize> = (0..ok.len()).filter(|r| ok[*r]).collect();
    if elig.is_empty() {
        return (elig, Map::new());
    }
    let mut picked: HashSet<usize> = HashSet::new();
    // learned-cheap: the model's cheap half over every eligible title
    let cheap_score: Vec<f64> = elig
        .iter()
        .map(|&r| model.z_cheap(&cheap(cat, refs, r, 0)))
        .collect();
    let n_cheap = elig.len().min(pool / 2);
    picked.extend(top_k(&cheap_score, n_cheap).into_iter().map(|i| elig[i]));
    // multi-interest content neighbours, quota ~ sqrt(interest size)
    let k = k_max.min((refs.pos.len() / 25).max(1));
    let (cent, sizes) = interests(cat, &refs.pos, k);
    let roots: Vec<f64> = sizes.iter().map(|s| (*s as f64).sqrt()).collect();
    let total = roots.iter().sum::<f64>().max(f64::from(EMBED_EPS));
    for (c, centroid) in cent.iter().enumerate() {
        let share = roots[c] / total;
        let q = elig
            .len()
            .min(((share * (pool - n_cheap) as f64).round_ties_even() as usize).max(1));
        let sims: Vec<f64> = elig
            .iter()
            .map(|&r| f64::from(dot(cat.emb(r), centroid)))
            .collect();
        picked.extend(top_k(&sims, q).into_iter().map(|i| elig[i]));
    }
    // fresh: the best recent releases by the cheap model, so the slate's
    // fresh floor has stock
    let fresh: Vec<usize> = (0..elig.len()).filter(|i| cat.fresh[elig[*i]]).collect();
    let n_fresh = fresh.len().min(pool / 8);
    if n_fresh > 0 {
        let fs: Vec<f64> = fresh.iter().map(|i| cheap_score[*i]).collect();
        picked.extend(top_k(&fs, n_fresh).into_iter().map(|i| elig[fresh[i]]));
    }
    let mut rows: Vec<usize> = picked.into_iter().collect();
    rows.sort_unstable();
    let src = diag(json!({
        "cheap": n_cheap, "interests": cent.len(), "fresh": n_fresh, "pool": rows.len(),
    }));
    (rows, src)
}

// --- slate -----------------------------------------------------------------

/// Each row's weight spread evenly over its genres (dense, genre columns).
fn genre_dist(m: &Sparse, r: usize) -> Vec<f64> {
    let mut g = vec![0f64; m.ncols];
    for &(c, v) in &m.rows[r] {
        g[c] = f64::from(v);
    }
    let s: f64 = g.iter().sum::<f64>().max(1.0);
    g.iter_mut().for_each(|x| *x /= s);
    g
}

pub struct SlateParams {
    pub calibration: f64,
    pub redundancy: f64,
    pub kids_genre_cap: f64,
    pub fresh_share: f64,
}

/// Greedy slate over the inputs (their indices, best first). Each pick
/// maximizes (1 - lam) * P(want) - lam * KL(target || slate genre mix) -
/// redundancy * max similarity to the picked titles. Running constraints,
/// each relaxed only when nothing else is left: one title per collection,
/// kids share <= cap at every prefix, fresh share >= floor at every prefix
/// (the floor rounds down, so the first card is never forced).
#[allow(clippy::too_many_arguments)]
pub fn slate(
    z: &[f64],
    emb: &[&[f32]],
    gdist: &[Vec<f64>],
    target: &[f64],
    collection: &[i64],
    kids: &[bool],
    fresh: &[bool],
    n: usize,
    p: &SlateParams,
) -> Vec<usize> {
    let (lam, mu) = (p.calibration, p.redundancy);
    let rel: Vec<f64> = z
        .iter()
        .map(|z| 1.0 / (1.0 + (-z.clamp(-30.0, 30.0)).exp()))
        .collect();
    let has_target: Vec<usize> = (0..target.len()).filter(|g| target[*g] > 0.0).collect();
    let mut qsum = vec![0f64; target.len()];
    let mut best_sim = vec![0f64; z.len()];
    let mut left = vec![true; z.len()];
    let mut seen_coll: HashSet<i64> = HashSet::new();
    let mut chosen = Vec::new();
    let (mut n_kids, mut n_fresh) = (0usize, 0usize);
    while chosen.len() < n && left.iter().any(|l| *l) {
        let m = chosen.len() + 1;
        let mut allowed = left.clone();
        let narrow = |allowed: &mut Vec<bool>, keep: &dyn Fn(usize) -> bool| {
            if (0..allowed.len()).any(|i| allowed[i] && keep(i)) {
                (0..allowed.len()).for_each(|i| allowed[i] &= keep(i));
            }
        };
        narrow(&mut allowed, &|i| {
            !(collection[i] != 0 && seen_coll.contains(&collection[i]))
        });
        if (n_kids + 1) as f64 > p.kids_genre_cap * m as f64 {
            narrow(&mut allowed, &|i| !kids[i]);
        }
        if (n_fresh as f64) < (p.fresh_share * m as f64).trunc() {
            narrow(&mut allowed, &|i| fresh[i]);
        }
        let obj = (0..z.len()).map(|i| {
            if !allowed[i] {
                return f64::NEG_INFINITY;
            }
            let kl: f64 = has_target
                .iter()
                .map(|&g| {
                    let q = (1.0 - CALIBRATION_SMOOTHING) * (qsum[g] + gdist[i][g]) / m as f64
                        + CALIBRATION_SMOOTHING * target[g];
                    target[g] * (target[g] / q).ln()
                })
                .sum();
            (1.0 - lam) * rel[i] - lam * kl - mu * best_sim[i]
        });
        let i = argmax(obj);
        chosen.push(i);
        left[i] = false;
        qsum.iter_mut().zip(&gdist[i]).for_each(|(q, g)| *q += g);
        for (b, e) in best_sim.iter_mut().zip(emb) {
            *b = b.max(f64::from(dot(emb[i], e)));
        }
        n_kids += usize::from(kids[i]);
        n_fresh += usize::from(fresh[i]);
        if collection[i] != 0 {
            seen_coll.insert(collection[i]);
        }
    }
    chosen
}

// --- recipe entry points -----------------------------------------------------

/// Python round(x, nd) (NaN stays NaN).
pub(crate) fn py_round(x: f64, nd: usize) -> f64 {
    format!("{x:.nd$}").parse().unwrap_or(x)
}

/// What the request path needs back from the blocking stage.
struct Picked {
    tmdb_id: i64,
    z: f64,
    emb: Vec<f32>,
    kids: bool,
    fresh: bool,
    /// The top-2 positives by affinity: (tmdb_id, affinity).
    neighbours: Vec<(i64, f32)>,
}

enum Stage {
    NoPositives,
    EmptyPool,
    Picked {
        picked: Vec<Picked>,
        src: Map<String, Value>,
        n_pos: usize,
        n_neg: usize,
        model: Arc<Model>,
    },
}

pub(super) async fn score(
    pool: &SqlitePool,
    caches: &Arc<Caches>,
    ctx: &UserContext,
    n: usize,
    p: &P<'_>,
) -> Result<RecipeResult> {
    let min_votes = p.int("min_vote_count");
    if ctx.positive_centroid().is_none() {
        return cold_start_result(pool, ctx, n, min_votes, "cold_start").await;
    }
    let cat = caches.catalog(pool, ctx.kind, false).await?;
    let sig = Signals::from(ctx);
    let ridge = p.num("ridge");
    let pool_size = p.int("pool_size").max(0) as usize;
    let k_max = p.int("interest_clusters").max(0) as usize;
    let sp = SlateParams {
        calibration: p.num("calibration"),
        redundancy: p.num("redundancy"),
        kids_genre_cap: p.num("kids_genre_cap"),
        fresh_share: p.num("fresh_share"),
    };
    let caches2 = caches.clone();
    let staged = tokio::task::spawn_blocking(move || {
        let refs = sig.refs(&cat);
        let model = caches2.model(&sig.sub, sig.kind, &cat, &refs, ridge);
        if refs.pos.is_empty() {
            return Stage::NoPositives;
        }
        let ok = eligible(&sig, &cat, min_votes);
        let (rows, src) = candidates(&cat, &refs, &model, &ok, pool_size, k_max);
        if rows.is_empty() {
            return Stage::EmptyPool;
        }
        let (x, affinity) = features(&cat, &refs, &rows);
        let z: Vec<f64> = x.iter().map(|x| model.z(x)).collect();
        let mut by_score: Vec<usize> = (0..rows.len()).collect();
        by_score.sort_by(|a, b| z[*b].total_cmp(&z[*a]));
        let mut top: Vec<usize> = by_score.iter().take(SLATE_INPUT).copied().collect();
        let seen: HashSet<usize> = top.iter().copied().collect();
        top.extend(
            by_score
                .iter()
                .filter(|i| cat.fresh[rows[**i]])
                .take(FRESH_INPUT)
                .filter(|i| !seen.contains(i)),
        );
        let cr: Vec<usize> = top.iter().map(|i| rows[*i]).collect();
        let kids: Vec<bool> = cr.iter().map(|r| is_kids(&cat.genres[*r])).collect();
        let mut target = vec![0f64; cat.genre.ncols];
        for &r in &refs.pos {
            target
                .iter_mut()
                .zip(genre_dist(&cat.genre, r))
                .for_each(|(t, g)| *t += g);
        }
        target.iter_mut().for_each(|t| *t /= refs.pos.len() as f64);
        let picks = slate(
            &top.iter().map(|i| z[*i]).collect::<Vec<_>>(),
            &cr.iter().map(|r| cat.emb(*r)).collect::<Vec<_>>(),
            &cr.iter()
                .map(|r| genre_dist(&cat.genre, *r))
                .collect::<Vec<_>>(),
            &target,
            &cr.iter().map(|r| cat.collection[*r]).collect::<Vec<_>>(),
            &kids,
            &cr.iter().map(|r| cat.fresh[*r]).collect::<Vec<_>>(),
            n,
            &sp,
        );
        let picked = picks
            .into_iter()
            .map(|k| {
                let i = top[k];
                let aff = &affinity[i];
                let mut nb: Vec<usize> = (0..aff.len()).collect();
                nb.sort_by(|a, b| aff[*b].total_cmp(&aff[*a]));
                Picked {
                    tmdb_id: cat.ids[rows[i]],
                    z: z[i],
                    emb: cat.emb(rows[i]).to_vec(),
                    kids: kids[k],
                    fresh: cat.fresh[rows[i]],
                    neighbours: nb
                        .into_iter()
                        .take(2)
                        .map(|j| (cat.ids[refs.pos[j]], aff[j]))
                        .collect(),
                }
            })
            .collect();
        Stage::Picked {
            picked,
            src,
            n_pos: refs.pos.len(),
            n_neg: refs.neg.len(),
            model,
        }
    })
    .await
    .map_err(|e| Error::Invalid(format!("ranker panicked: {e}")))?;
    let (picked, src, n_pos, n_neg, model) = match staged {
        Stage::NoPositives => {
            return cold_start_result(pool, ctx, n, min_votes, "cold_start").await;
        }
        Stage::EmptyPool => {
            return Ok(RecipeResult {
                items: Vec::new(),
                diag: diag(json!({ "path": "empty_pool" })),
            });
        }
        Stage::Picked {
            picked,
            src,
            n_pos,
            n_neg,
            model,
        } => (picked, src, n_pos, n_neg, model),
    };

    let ids: HashSet<i64> = picked.iter().map(|c| c.tmdb_id).collect();
    let titles = load_title_rows(pool, ctx.kind, &ids).await?;
    let picked: Vec<Picked> = picked
        .into_iter()
        .filter(|c| titles.contains_key(&c.tmdb_id))
        .collect();
    let nb_ids: HashSet<i64> = picked
        .iter()
        .flat_map(|c| c.neighbours.iter().map(|n| n.0))
        .collect();
    let pos_titles = load_title_rows(pool, ctx.kind, &nb_ids).await?;
    let tau = p.num("personalized_threshold") as f32;
    let items: Vec<ScoredItem> = picked
        .iter()
        .map(|c| {
            let neighbours: Vec<_> = c
                .neighbours
                .iter()
                .filter(|(t, a)| *a >= tau && pos_titles.contains_key(t))
                .map(|(t, _)| pos_titles[t].clone())
                .collect();
            let cand = Candidate {
                title: titles[&c.tmdb_id].clone(),
                embedding: c.emb.clone(),
            };
            let personal = !neighbours.is_empty();
            ScoredItem {
                tmdb_id: cand.title.tmdb_id,
                title: cand.title.title.clone(),
                year: cand.title.year,
                poster_path: cand.title.poster_path.clone(),
                overview: cand.title.overview.clone(),
                score: 1.0 / (1.0 + (-c.z.clamp(-30.0, 30.0)).exp()),
                provenance: if personal { "personalized" } else { "discover" },
                reason: if personal {
                    personalized_reason(&cand, &neighbours)
                } else {
                    discover_reason(&cand)
                },
            }
        })
        .collect();
    let weights: Map<String, Value> = FEATURES
        .iter()
        .zip(model.w)
        .map(|(f, w)| (f.to_string(), json!(py_round(w, 3))))
        .collect();
    let mut d = diag(json!({ "path": "ranker" }));
    d.extend(src);
    d.extend(diag(json!({
        "pos": n_pos,
        "neg": n_neg,
        "train_auc": py_round(model.train_auc, 4),
        "model_age_s": model.fitted_at.elapsed().as_secs_f64().round_ties_even() as i64,
        "weights": weights,
        "kids_returned": picked.iter().filter(|c| c.kids).count(),
        "fresh_returned": picked.iter().filter(|c| c.fresh).count(),
        "returned": items.len(),
    })));
    Ok(RecipeResult { items, diag: d })
}

/// Model scores for explicit tmdb ids (the offline eval's hook).
pub async fn score_ids(
    pool: &SqlitePool,
    caches: &Arc<Caches>,
    ctx: &UserContext,
    ids: &[i64],
    params: &super::Params,
) -> Result<HashMap<i64, f64>> {
    let p = P {
        defaults: DEFAULTS,
        params,
    };
    let ridge = p.num("ridge");
    let cat = caches.catalog(pool, ctx.kind, false).await?;
    let sig = Signals::from(ctx);
    let ids = ids.to_vec();
    let caches2 = caches.clone();
    tokio::task::spawn_blocking(move || {
        let refs = sig.refs(&cat);
        let model = caches2.model(&sig.sub, sig.kind, &cat, &refs, ridge);
        let rows: Vec<usize> = ids.iter().filter_map(|t| cat.row.get(t).copied()).collect();
        if rows.is_empty() || refs.pos.is_empty() {
            return HashMap::new();
        }
        let (x, _) = features(&cat, &refs, &rows);
        rows.iter()
            .zip(&x)
            .map(|(r, x)| (cat.ids[*r], model.z(x)))
            .collect()
    })
    .await
    .map_err(|e| Error::Invalid(format!("ranker panicked: {e}")))
}

#[cfg(test)]
pub(crate) mod tests;
