//! `eex-recommender replay-eval`: the temporal household-judgment eval
//! (`research/household_eval.py`), same JSON keys. It replays the household
//! as it stood at a cutoff T and scores a recipe against what happened after:
//!
//! * judgment AUC: P(score(pos) > score(neg)) over titles judged after T
//!   (pos = added / clicked / watched / added to the library, neg = disliked;
//!   "imp" = served picks only), with its Hanley-McNeil standard error;
//! * future recall@20/50 of titles added to the library after T (the full
//!   recipe: retrieval, ranking, filters);
//! * what the top 20 at T looks like.
//!
//! Nothing after T leaks into the context: the library is cut by its `added`
//! date, engagement by ts, and every test-labelled id leaves the context
//! negatives (the backend lists carry no ts). Inputs are a snapshot dir
//! (exchange.db opened read-only/immutable, library.json, user-feedback.json,
//! rejections.json) that never enters the repo.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::{Row, SqlitePool};

use crate::context::{Candidate, Param, Params, UserContext, load_user_context, title_row_from};
use crate::db::{GENRE_AGG_SQL, deserialize_f32};
use crate::http::validate::{LibraryItem, Score};
use crate::recipes::ranker::py_round;
use crate::recipes::{self, Caches};
use crate::retrieval::CandidateBatch;
use crate::{Error, Result};

const POS_SIGNALS: &[&str] = &["added", "clicked", "watched"];
const POS_OUTCOMES: &[&str] = &["added", "clicked"];
const KIDS: &[i64] = &[16, 10751, 10762];
const DIAG_KEYS: &[&str] = &[
    "path",
    "raw",
    "kept",
    "returned",
    "kids_returned",
    "pool",
    "train_auc",
];

pub struct Snapshot {
    pub dir: PathBuf,
    /// EEX_OWNER_SUB: whose judgments are replayed.
    pub owner: String,
}

struct Household {
    /// Owned before T, in library.json order.
    library: Vec<(i64, Option<String>)>,
    engaged: HashSet<i64>,
    liked: HashSet<i64>,
    disliked: HashSet<i64>,
    rejected: HashSet<i64>,
    test_pos: HashSet<i64>,
    test_neg: HashSet<i64>,
    /// Served after T.
    test_imp: HashSet<i64>,
    future_adds: HashSet<i64>,
}

fn read_json(snap: &Snapshot, name: &str) -> Result<Value> {
    let p = snap.dir.join(name);
    let text =
        std::fs::read_to_string(&p).map_err(|e| Error::Invalid(format!("{}: {e}", p.display())))?;
    serde_json::from_str(&text).map_err(|e| Error::Invalid(format!("{}: {e}", p.display())))
}

/// The `id`s of a [{"id": n}, ...] list.
fn ids(v: &Value) -> HashSet<i64> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["id"].as_i64())
        .collect()
}

async fn household(
    pool: &SqlitePool,
    snap: &Snapshot,
    kind: &str,
    cutoff: &str,
) -> Result<Household> {
    let lib = read_json(snap, "library.json")?;
    let fb = read_json(snap, "user-feedback.json")?;
    let rej = read_json(snap, "rejections.json")?;
    let fb = &fb[&snap.owner][kind];

    let mut before = Vec::new();
    let mut after = HashSet::new();
    for x in lib[kind].as_array().into_iter().flatten() {
        let Some(id) = x["tmdbId"].as_i64().filter(|i| *i != 0) else {
            continue;
        };
        let added = x["added"]
            .as_str()
            .ok_or_else(|| Error::Invalid(format!("library.json {kind} {id}: no added date")))?;
        if added < cutoff {
            before.push((id, x["title"].as_str().map(String::from)));
        } else {
            after.insert(id);
        }
    }

    let rows: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT tmdb_id, signal, ts FROM user_feedback WHERE sub = ? AND kind = ?")
            .bind(&snap.owner)
            .bind(kind)
            .fetch_all(pool)
            .await?;
    let pick = |pos: bool, after_t: bool| -> HashSet<i64> {
        rows.iter()
            .filter(|(_, s, ts)| {
                (if pos {
                    POS_SIGNALS.contains(&s.as_str())
                } else {
                    s == "dislike"
                }) && (ts.as_str() >= cutoff) == after_t
            })
            .map(|(id, _, _)| *id)
            .collect()
    };
    let eng_before = pick(true, false);
    let mut pos_after = pick(true, true);
    let mut neg_after = pick(false, true);
    let mut neg_before = pick(false, false);

    let out: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT l.tmdb_id, l.ts, o.outcome FROM rec_log l
           LEFT JOIN rec_outcomes o ON o.rec_id = l.id
          WHERE l.sub = ? AND l.kind = ?",
    )
    .bind(&snap.owner)
    .bind(kind)
    .fetch_all(pool)
    .await?;
    let served = |after_t: bool, want: &dyn Fn(Option<&str>) -> bool| -> HashSet<i64> {
        out.iter()
            .filter(|(_, shown, o)| (shown.as_str() >= cutoff) == after_t && want(o.as_deref()))
            .map(|(id, _, _)| *id)
            .collect()
    };
    let is_pos = |o: Option<&str>| o.is_some_and(|o| POS_OUTCOMES.contains(&o));
    let is_neg = |o: Option<&str>| o == Some("disliked");
    let imp_after = served(true, &|_| true);
    pos_after.extend(served(true, &is_pos));
    neg_after.extend(served(true, &is_neg));
    neg_before.extend(served(false, &is_neg));

    let owned_before: HashSet<i64> = before.iter().map(|(i, _)| *i).collect();
    pos_after.extend(&after);
    let conflict: HashSet<i64> = pos_after.intersection(&neg_after).copied().collect();
    let minus =
        |a: &HashSet<i64>, b: &HashSet<i64>| -> HashSet<i64> { a.difference(b).copied().collect() };
    let test_pos = minus(&minus(&pos_after, &conflict), &owned_before);
    let test_neg = minus(&minus(&neg_after, &conflict), &owned_before);
    let test_ids: HashSet<i64> = test_pos.union(&test_neg).copied().collect();

    // Backend lists carry no ts: anything not judged after T is known at T.
    let mut disliked = ids(&fb["disliked"]);
    disliked.extend(&neg_before);
    Ok(Household {
        library: before,
        engaged: minus(&eng_before, &test_ids),
        liked: minus(&ids(&fb["liked"]), &test_ids),
        disliked: minus(&disliked, &test_ids),
        rejected: minus(&ids(&rej[kind]), &test_ids),
        test_pos,
        test_neg,
        test_imp: imp_after,
        future_adds: minus(&after, &neg_after),
    })
}

async fn context(pool: &SqlitePool, hh: &Household, kind: &'static str) -> Result<UserContext> {
    let sorted = |s: &HashSet<i64>| {
        s.iter()
            .copied()
            .filter(|i| *i > 0)
            .collect::<BTreeSet<_>>()
    };
    let mut feedback: Vec<(i64, &'static str)> = Vec::new();
    for (set, signal) in [
        (&hh.liked, "like"),
        (&hh.engaged, "added"),
        (&hh.disliked, "dislike"),
    ] {
        feedback.extend(sorted(set).into_iter().map(|i| (i, signal)));
    }
    let req = Score {
        sub: "eval:replay".into(),
        kind,
        n: 50,
        exclude_recently_shown: false,
        library: Some(
            hh.library
                .iter()
                .map(|(i, t)| LibraryItem {
                    tmdb_id: Some(*i),
                    title: t.clone(),
                })
                .collect(),
        ),
        feedback: Some(feedback),
        household_rejections: Some(sorted(&hh.rejected).into_iter().collect()),
    };
    load_user_context(pool, &req, true).await
}

/// A CandidateBatch of exactly these ids (no exclusions, no filters), in order.
async fn candidate_batch(
    pool: &SqlitePool,
    kind: &'static str,
    ids: &[i64],
) -> Result<CandidateBatch> {
    let sql = format!(
        "SELECT t.tmdb_id, t.kind, t.title, t.year, t.poster_path, t.overview,
                COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                COALESCE(t.vote_count, 0) AS vote_count, {GENRE_AGG_SQL},
                f.embedding AS embedding, f.dim AS dim
           FROM titles t JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
          WHERE t.kind = ? AND t.tmdb_id IN (SELECT value FROM json_each(?))"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(kind)
        .bind(serde_json::to_string(ids).expect("ints serialize"))
        .fetch_all(pool)
        .await?;
    let mut by_id = HashMap::new();
    for r in &rows {
        let dim: i64 = r.try_get("dim")?;
        let embedding = deserialize_f32(r.try_get::<&[u8], _>("embedding")?, Some(dim as usize))?;
        let title = title_row_from(r, kind)?;
        by_id.insert(title.tmdb_id, Candidate { title, embedding });
    }
    let candidates: Vec<Candidate> = ids.iter().filter_map(|i| by_id.remove(i)).collect();
    Ok(CandidateBatch {
        distances: vec![0.0; candidates.len()],
        candidates,
        diag: json!({}),
    })
}

/// Scores for arbitrary ids: the ranker's own hook, or fused with its
/// candidate pool pinned to the ids.
async fn score_ids(
    pool: &SqlitePool,
    caches: &Arc<Caches>,
    recipe: &str,
    ctx: &UserContext,
    ids: &[i64],
    params: &Params,
) -> Result<HashMap<i64, f64>> {
    match recipe {
        "ranker" => recipes::ranker::score_ids(pool, caches, ctx, ids, params).await,
        "fused" => {
            let batch = candidate_batch(pool, ctx.kind, ids).await?;
            recipes::fused_score_batch(pool, caches, ctx, batch, params).await
        }
        other => Err(Error::Invalid(format!(
            "replay-eval scores ranker or fused, not {other:?}"
        ))),
    }
}

/// Mann-Whitney AUC with tie-averaged ranks, and the class sizes it saw.
fn auc(scores: &HashMap<i64, f64>, pos: &HashSet<i64>, neg: &HashSet<i64>) -> (f64, usize, usize) {
    let p: Vec<f64> = pos.iter().filter_map(|i| scores.get(i).copied()).collect();
    let n: Vec<f64> = neg.iter().filter_map(|i| scores.get(i).copied()).collect();
    if p.is_empty() || n.is_empty() {
        return (f64::NAN, p.len(), n.len());
    }
    let all: Vec<f64> = p.iter().chain(&n).copied().collect();
    let mut order: Vec<usize> = (0..all.len()).collect();
    order.sort_by(|a, b| all[*a].total_cmp(&all[*b]));
    let mut ranks = vec![0.0; all.len()];
    let mut i = 0;
    while i < order.len() {
        let mut j = i;
        while j + 1 < order.len() && all[order[j + 1]] == all[order[i]] {
            j += 1;
        }
        let avg = (i + j) as f64 / 2.0 + 1.0;
        for k in i..=j {
            ranks[order[k]] = avg;
        }
        i = j + 1;
    }
    let np = p.len() as f64;
    let u = ranks[..p.len()].iter().sum::<f64>() - np * (np + 1.0) / 2.0;
    (u / (np * n.len() as f64), p.len(), n.len())
}

/// Hanley-McNeil standard error.
fn auc_se(a: f64, n_p: usize, n_n: usize) -> f64 {
    if a.is_nan() || n_p == 0 || n_n == 0 {
        return f64::NAN;
    }
    let (q1, q2) = (a / (2.0 - a), 2.0 * a * a / (1.0 + a));
    let (np, nn) = (n_p as f64, n_n as f64);
    ((a * (1.0 - a) + (np - 1.0) * (q1 - a * a) + (nn - 1.0) * (q2 - a * a)) / (np * nn)).sqrt()
}

#[derive(Debug, Serialize)]
pub struct CtxSizes {
    lib: usize,
    eng: usize,
    dis: usize,
    rej: usize,
}

/// household_eval.evaluate's dict; NaN serializes as null.
#[derive(Debug, Serialize)]
pub struct Report {
    pub recipe: String,
    pub kind: &'static str,
    pub cutoff: String,
    pub ctx: CtxSizes,
    pub auc_all: (f64, f64, usize, usize),
    pub auc_imp: (f64, f64, usize, usize),
    #[serde(rename = "future_recall@20")]
    pub future_recall_20: f64,
    #[serde(rename = "future_recall@50")]
    pub future_recall_50: f64,
    pub future_n: usize,
    #[serde(rename = "slate_kids@20")]
    pub slate_kids: usize,
    #[serde(rename = "slate_vote_avg@20")]
    pub slate_vote_avg: f64,
    #[serde(rename = "slate_judged_pos/neg")]
    pub slate_judged: (usize, usize),
    #[serde(rename = "judged@50_pos/neg")]
    pub judged_50: (usize, usize),
    #[serde(rename = "slate_ils@20")]
    pub slate_ils: f64,
    #[serde(rename = "slate_top_genre_share@20")]
    pub slate_top_genre_share: f64,
    pub diag: Map<String, Value>,
    pub weights: Option<Value>,
    /// --show lines (printed before the JSON, as the script printed them).
    #[serde(skip)]
    pub shown: Vec<String>,
}

struct Meta {
    vote_average: Option<f64>,
    genres: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub async fn evaluate(
    pool: &SqlitePool,
    snap: &Snapshot,
    caches: &Arc<Caches>,
    recipe: &str,
    kind: &'static str,
    cutoff: &str,
    params: &Params,
    show: usize,
) -> Result<Report> {
    let hh = household(pool, snap, kind, cutoff).await?;
    let ctx = context(pool, &hh, kind).await?;

    let judged: Vec<i64> = hh
        .test_pos
        .union(&hh.test_neg)
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let scores = score_ids(pool, caches, recipe, &ctx, &judged, params).await?;
    let (a_all, np_all, nn_all) = auc(&scores, &hh.test_pos, &hh.test_neg);
    let imp = |s: &HashSet<i64>| {
        s.intersection(&hh.test_imp)
            .copied()
            .collect::<HashSet<_>>()
    };
    let (a_imp, np_imp, nn_imp) = auc(&scores, &imp(&hh.test_pos), &imp(&hh.test_neg));

    let res = recipes::score(recipe, pool, caches, &ctx, 50, params)
        .await?
        .ok_or_else(|| Error::Invalid(format!("unknown recipe: {recipe}")))?;
    let ranked: Vec<i64> = res.items.iter().map(|i| i.tmdb_id).collect();
    let targets: Vec<i64> = hh
        .future_adds
        .iter()
        .copied()
        .filter(|i| !ctx.library_ids.contains(i))
        .collect();
    let in_cat: HashSet<i64> = if targets.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar("SELECT tmdb_id FROM title_features WHERE kind = ? AND tmdb_id IN (SELECT value FROM json_each(?))")
            .bind(kind)
            .bind(serde_json::to_string(&targets).expect("ints serialize"))
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect()
    };
    let recall = |k: usize| {
        let top: HashSet<i64> = ranked.iter().take(k).copied().collect();
        top.intersection(&in_cat).count() as f64 / in_cat.len().max(1) as f64
    };

    let top = &res.items[..res.items.len().min(20)];
    let top_ids: Vec<i64> = top.iter().map(|i| i.tmdb_id).collect();
    let meta: HashMap<i64, Meta> = sqlx::query(
        "SELECT t.tmdb_id, t.vote_average,
                (SELECT GROUP_CONCAT(genre_id) FROM title_genres g WHERE g.kind=t.kind AND g.tmdb_id=t.tmdb_id) AS genres
           FROM titles t WHERE t.kind = ? AND t.tmdb_id IN (SELECT value FROM json_each(?))",
    )
    .bind(kind)
    .bind(serde_json::to_string(&top_ids).expect("ints serialize"))
    .fetch_all(pool)
    .await?
    .iter()
    .map(|r| {
        Ok((
            r.try_get("tmdb_id")?,
            Meta {
                vote_average: r.try_get_unchecked("vote_average")?,
                genres: r.try_get("genres")?,
            },
        ))
    })
    .collect::<sqlx::Result<_>>()?;
    let genres_of = |id: &i64| -> HashSet<String> {
        meta.get(id)
            .and_then(|m| m.genres.as_deref())
            .unwrap_or("")
            .split(',')
            .filter(|g| !g.is_empty())
            .map(String::from)
            .collect()
    };
    let kids = top_ids
        .iter()
        .filter(|id| {
            genres_of(id)
                .iter()
                .any(|g| g.parse().is_ok_and(|g: i64| KIDS.contains(&g)))
        })
        .count();

    // Intra-list similarity: mean pairwise cosine of the top 20 (float32 dots).
    let emb: Vec<Vec<f32>> = candidate_batch(pool, kind, &top_ids)
        .await?
        .candidates
        .into_iter()
        .map(|c| {
            let nrm = crate::context::norm(&c.embedding);
            c.embedding.iter().map(|x| x / nrm).collect()
        })
        .collect();
    let ils = if emb.len() > 1 {
        let mut sum = 0.0f64;
        let mut cnt = 0usize;
        for i in 0..emb.len() {
            for j in i + 1..emb.len() {
                sum += f64::from(emb[i].iter().zip(&emb[j]).map(|(a, b)| a * b).sum::<f32>());
                cnt += 1;
            }
        }
        sum / cnt as f64
    } else {
        0.0
    };
    let gsets: Vec<HashSet<String>> = top_ids.iter().map(genres_of).collect();
    let all_genres: HashSet<&String> = gsets.iter().flatten().collect();
    let top_share = all_genres
        .iter()
        .map(|g| gsets.iter().filter(|s| s.contains(*g)).count())
        .max()
        .unwrap_or(0) as f64
        / gsets.len().max(1) as f64;
    let judged_set: HashSet<i64> = judged.iter().copied().collect();
    let count = |ids: &[i64]| -> (usize, usize) {
        let j: Vec<&i64> = ids.iter().filter(|i| judged_set.contains(i)).collect();
        (
            j.iter().filter(|i| hh.test_pos.contains(i)).count(),
            j.iter().filter(|i| hh.test_neg.contains(i)).count(),
        )
    };
    let va: Vec<f64> = top_ids
        .iter()
        .map(|id| meta.get(id).and_then(|m| m.vote_average).unwrap_or(0.0))
        .collect();
    let va_mean = if va.is_empty() {
        0.0
    } else {
        va.iter().sum::<f64>() / va.len() as f64
    };

    let shown = res
        .items
        .iter()
        .take(show)
        .map(|it| {
            let m = meta.get(&it.tmdb_id);
            let tag = if hh.test_pos.contains(&it.tmdb_id) {
                "+"
            } else if hh.test_neg.contains(&it.tmdb_id) {
                "-"
            } else {
                " "
            };
            let none = |o: Option<String>| o.unwrap_or_else(|| "None".into());
            let year = none(it.year.map(|y| y.to_string()));
            let (va, g) = match m {
                Some(m) => (
                    none(m.vote_average.map(crate::optimizer::py_float)),
                    none(m.genres.clone()),
                ),
                None => ("?".into(), "?".into()),
            };
            format!(
                "  {tag} {:7.3} {} ({year}) va={va} g={g} | {}",
                it.score, it.title, it.reason
            )
        })
        .collect();

    let r4 = |x: f64| py_round(x, 4);
    Ok(Report {
        recipe: recipe.into(),
        kind,
        cutoff: cutoff.into(),
        ctx: CtxSizes {
            lib: hh.library.len(),
            eng: hh.engaged.len(),
            dis: hh.disliked.len(),
            rej: hh.rejected.len(),
        },
        auc_all: (r4(a_all), r4(auc_se(a_all, np_all, nn_all)), np_all, nn_all),
        auc_imp: (r4(a_imp), r4(auc_se(a_imp, np_imp, nn_imp)), np_imp, nn_imp),
        future_recall_20: r4(recall(20)),
        future_recall_50: r4(recall(50)),
        future_n: in_cat.len(),
        slate_kids: kids,
        slate_vote_avg: py_round(va_mean, 2),
        slate_judged: count(&top_ids),
        judged_50: count(&ranked[..ranked.len().min(50)]),
        slate_ils: py_round(ils, 3),
        slate_top_genre_share: py_round(top_share, 2),
        diag: DIAG_KEYS
            .iter()
            .filter_map(|k| res.diag.get(*k).map(|v| (k.to_string(), v.clone())))
            .collect(),
        weights: res.diag.get("weights").cloned(),
        shown,
    })
}

/// `--params` JSON: numbers only.
pub fn parse_params(text: &str) -> Result<Params> {
    let v: Value =
        serde_json::from_str(text).map_err(|e| Error::Invalid(format!("--params: {e}")))?;
    let Value::Object(m) = v else {
        return Err(Error::Invalid("--params must be a JSON object".into()));
    };
    m.into_iter()
        .map(|(k, x)| {
            let p = match (x.as_i64(), x.as_f64()) {
                (Some(i), _) if x.is_i64() => Param::Int(i),
                (_, Some(f)) => Param::Float(f),
                _ => return Err(Error::Invalid(format!("--params {k}: not a number"))),
            };
            Ok((k, p))
        })
        .collect()
}

pub struct Opts {
    pub snap: PathBuf,
    pub cutoff: String,
    pub recipe: String,
    pub kinds: Vec<&'static str>,
    pub params: Params,
    pub show: usize,
}

impl Opts {
    /// `[--snap DIR] [--cutoff D] [--recipe R] [--kind movie|tv|both]
    /// [--params JSON] [--show N]`; the snapshot defaults to EEX_SNAP, then
    /// ~/eex-recsys-snap.
    pub fn parse(
        args: &[String],
        env: impl Fn(&str) -> Option<String>,
    ) -> std::result::Result<Self, String> {
        let home = env("HOME").map(PathBuf::from).unwrap_or_default();
        let mut o = Opts {
            snap: env("EEX_SNAP").map_or_else(|| home.join("eex-recsys-snap"), PathBuf::from),
            cutoff: "2026-07-01".into(),
            recipe: "fused".into(),
            kinds: vec!["movie", "tv"],
            params: Params::new(),
            show: 0,
        };
        let mut it = args.iter();
        while let Some(flag) = it.next() {
            let val = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
            match flag.as_str() {
                "--snap" => o.snap = PathBuf::from(val),
                "--cutoff" => o.cutoff = val.clone(),
                "--recipe" => o.recipe = val.clone(),
                "--kind" => {
                    o.kinds = match val.as_str() {
                        "both" => vec!["movie", "tv"],
                        "movie" => vec!["movie"],
                        "tv" => vec!["tv"],
                        _ => return Err(format!("--kind {val:?}: movie, tv or both")),
                    }
                }
                "--params" => o.params = parse_params(val).map_err(|e| e.to_string())?,
                "--show" => o.show = val.parse().map_err(|_| format!("--show {val:?}"))?,
                _ => return Err(format!("unknown flag {flag:?}")),
            }
        }
        Ok(o)
    }
}

/// The CLI: one JSON line per kind on stdout.
pub async fn run(opts: &Opts, owner: String) -> Result<()> {
    let pool = crate::db::open_snapshot(&opts.snap.join("exchange.db")).await?;
    let snap = Snapshot {
        dir: opts.snap.clone(),
        owner,
    };
    for kind in &opts.kinds {
        let caches = Arc::new(Caches::default());
        let r = evaluate(
            &pool,
            &snap,
            &caches,
            &opts.recipe,
            kind,
            &opts.cutoff,
            &opts.params,
            opts.show,
        )
        .await?;
        for line in &r.shown {
            println!("{line}");
        }
        println!(
            "{}",
            serde_json::to_string(&r).expect("plain data serializes")
        );
    }
    pool.close().await;
    Ok(())
}

#[cfg(test)]
mod tests;
