//! The user context a /score call hands its recipe (`app/context.py`): the
//! library, likes, dislikes, rejections and recently-shown titles of one sub,
//! with their embeddings, plus the active model_config.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::Result;
use crate::config::Config;
use crate::db::{GENRE_AGG_SQL, deserialize_f32};
use crate::http::validate::Score;
use crate::recipes::{self, Def};

/// The recently_shown read window (the writers trim to the same 30 days).
pub use crate::http::events::RECENTLY_SHOWN_RETENTION_DAYS;

/// Implicit feedback: the household clicked, added or played a title.
pub const ENGAGEMENT_FEEDBACK_SIGNALS: &[&str] = &["clicked", "added", "watched"];
pub const POSITIVE_FEEDBACK_SIGNALS: &[&str] = &["like", "clicked", "added", "watched"];

/// Clamp ranges for optimizer-written params, by key.
pub const MODEL_PARAM_BOUNDS: &[(&str, f64, f64)] = &[
    ("pool_size", 1.0, 5000.0),
    ("mmr_input_k", 1.0, 1000.0),
    ("min_vote_count", 0.0, 100000.0),
    ("negative_weight", 0.0, 5.0),
    ("popularity_weight", 0.0, 5.0),
    ("personalized_threshold", -1.0, 1.0),
    ("mmr_lambda", 0.0, 1.0),
    ("kids_genre_cap", 0.0, 1.0),
    ("interest_clusters", 1.0, 64.0),
    ("ridge", 0.01, 10000.0),
    ("calibration", 0.0, 1.0),
    ("redundancy", 0.0, 1.0),
    ("fresh_share", 0.0, 1.0),
];

#[derive(Clone, Debug, PartialEq)]
pub struct TitleRow {
    pub tmdb_id: i64,
    pub kind: &'static str,
    pub title: String,
    pub year: Option<i64>,
    pub poster_path: Option<String>,
    pub overview: Option<String>,
    pub popularity: f64,
    pub vote_average: Option<f64>,
    pub genre_ids: Vec<i64>,
}

/// A catalog row carrying the GENRE_AGG_SQL `genres` column.
pub fn title_row_from(r: &SqliteRow, kind: &'static str) -> Result<TitleRow> {
    let genres: Option<String> = r.try_get("genres")?;
    Ok(TitleRow {
        tmdb_id: r.try_get("tmdb_id")?,
        kind,
        title: r.try_get("title")?,
        year: r.try_get("year")?,
        poster_path: r.try_get("poster_path")?,
        overview: r.try_get("overview")?,
        // COALESCE(popularity, 0) is an integer 0 for a NULL; read as REAL.
        popularity: r
            .try_get_unchecked::<Option<f64>, _>("popularity")?
            .unwrap_or(0.0),
        vote_average: r.try_get_unchecked("vote_average")?,
        genre_ids: genres
            .filter(|g| !g.is_empty())
            .map(|g| g.split(',').filter_map(|x| x.parse().ok()).collect())
            .unwrap_or_default(),
    })
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub title: TitleRow,
    pub embedding: Vec<f32>,
}

/// Embedding rows with the tmdb_id of each row: ids without an embedding are
/// skipped, so never zip a sorted id set against the rows.
#[derive(Clone, Debug, Default)]
pub struct Embeddings {
    pub ids: Vec<i64>,
    pub rows: Vec<Vec<f32>>,
}

#[derive(Clone, Debug, Default)]
pub struct UserContext {
    pub sub: String,
    pub kind: &'static str,
    pub library_ids: HashSet<i64>,
    pub library_title_keys: HashSet<String>,
    pub library_embeddings: Embeddings,
    pub library_titles: HashMap<i64, TitleRow>,
    pub liked_ids: HashSet<i64>,
    pub liked_titles: HashMap<i64, TitleRow>,
    pub liked_embeddings: Embeddings,
    pub disliked_ids: HashSet<i64>,
    pub disliked_embeddings: Embeddings,
    pub rejected_ids: HashSet<i64>,
    pub recently_shown_ids: HashSet<i64>,
    /// recently_shown ids newest first; bounded_exclusions keeps its front.
    pub recently_shown_order: Vec<i64>,
    pub diag: Value,
}

impl UserContext {
    /// Mean of library + liked embeddings (a title in both counts twice),
    /// unit-normalized. None without either.
    pub fn positive_centroid(&self) -> Option<Vec<f32>> {
        centroid(
            self.library_embeddings
                .rows
                .iter()
                .chain(&self.liked_embeddings.rows),
        )
    }

    pub fn negative_centroid(&self) -> Option<Vec<f32>> {
        centroid(self.disliked_embeddings.rows.iter())
    }
}

/// numpy's float32 `mean(axis=0)`: rows summed in order, then divided.
fn centroid<'a>(rows: impl Iterator<Item = &'a Vec<f32>>) -> Option<Vec<f32>> {
    let mut sum: Option<Vec<f32>> = None;
    let mut n = 0usize;
    for r in rows {
        n += 1;
        match &mut sum {
            None => sum = Some(r.clone()),
            Some(s) => s.iter_mut().zip(r).for_each(|(a, b)| *a += b),
        }
    }
    let mean: Vec<f32> = sum?.into_iter().map(|s| s / n as f32).collect();
    Some(normalize(mean))
}

pub fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

/// Unit-normalize; a zero vector stays as it is.
pub fn normalize(v: Vec<f32>) -> Vec<f32> {
    let n = norm(&v);
    if n > 0.0 {
        v.into_iter().map(|x| x / n).collect()
    } else {
        v
    }
}

/// Lowercase, non-alphanumeric runs to one space, trimmed; None when empty.
pub fn normalize_title_key(title: &str) -> Option<String> {
    let lower = title.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    let key = out.trim();
    (!key.is_empty()).then(|| key.to_string())
}

/// The title's key plus the key of its part before " - " or ": ", so a
/// "Heist: Part Two" collides with an owned "Heist".
pub fn title_key_variants(title: Option<&str>) -> HashSet<String> {
    let Some(title) = title else {
        return HashSet::new();
    };
    let Some(key) = normalize_title_key(title) else {
        return HashSet::new();
    };
    let mut out = HashSet::from([key]);
    for sep in [" - ", ": "] {
        if let Some((head, _)) = title.split_once(sep)
            && let Some(base) = normalize_title_key(head)
        {
            out.insert(base);
        }
    }
    out
}

fn ids_json(ids: &HashSet<i64>) -> String {
    let mut v: Vec<i64> = ids.iter().copied().collect();
    v.sort_unstable();
    serde_json::to_string(&v).expect("ints serialize")
}

pub(crate) async fn load_title_rows(
    pool: &SqlitePool,
    kind: &'static str,
    ids: &HashSet<i64>,
) -> Result<HashMap<i64, TitleRow>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = format!(
        "SELECT t.tmdb_id, t.kind, t.title, t.year, t.poster_path, t.overview,
                COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                {GENRE_AGG_SQL}
         FROM titles t
         WHERE t.kind = ? AND t.tmdb_id IN (SELECT value FROM json_each(?))"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(kind)
        .bind(ids_json(ids))
        .fetch_all(pool)
        .await?;
    rows.iter()
        .map(|r| title_row_from(r, kind).map(|t| (t.tmdb_id, t)))
        .collect()
}

/// The embeddings of `ids` in ascending id order, skipping ids without one.
async fn stack_embeddings(pool: &SqlitePool, kind: &str, ids: &HashSet<i64>) -> Result<Embeddings> {
    let mut out = Embeddings::default();
    if ids.is_empty() {
        return Ok(out);
    }
    let rows = sqlx::query(
        "SELECT tmdb_id, embedding, dim FROM title_features
         WHERE kind = ? AND tmdb_id IN (SELECT value FROM json_each(?))
         ORDER BY tmdb_id",
    )
    .bind(kind)
    .bind(ids_json(ids))
    .fetch_all(pool)
    .await?;
    for r in rows {
        let dim: i64 = r.try_get("dim")?;
        out.ids.push(r.try_get("tmdb_id")?);
        out.rows.push(deserialize_f32(
            r.try_get::<&[u8], _>("embedding")?,
            Some(dim as usize),
        )?);
    }
    Ok(out)
}

/// Build the scoring context. The request body's library, feedback and
/// household_rejections are authoritative when present (the gateway always
/// sends them); otherwise the stored tables are read. Stored clicked/added/
/// watched rows join an inline feedback list unless `stored_engagement` is
/// false (offline eval) or the inline list negates the title.
pub async fn load_user_context(
    pool: &SqlitePool,
    req: &Score,
    stored_engagement: bool,
) -> Result<UserContext> {
    let kind = req.kind;

    // ----- library
    let (library_ids, mut library_title_keys): (HashSet<i64>, HashSet<String>) = match &req.library
    {
        Some(items) => (
            items.iter().filter_map(|i| i.tmdb_id).collect(),
            items
                .iter()
                .flat_map(|i| title_key_variants(i.title.as_deref()))
                .collect(),
        ),
        None => (
            sqlx::query_scalar("SELECT tmdb_id FROM library_items WHERE kind = ?")
                .bind(kind)
                .fetch_all(pool)
                .await?
                .into_iter()
                .collect(),
            HashSet::new(),
        ),
    };
    let library_titles = load_title_rows(pool, kind, &library_ids).await?;
    for t in library_titles.values() {
        library_title_keys.extend(title_key_variants(Some(&t.title)));
    }
    let library_embeddings = stack_embeddings(pool, kind, &library_ids).await?;

    // ----- per-user signals
    let fb_rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT tmdb_id, signal FROM user_feedback WHERE sub = ? AND kind = ?")
            .bind(&req.sub)
            .bind(kind)
            .fetch_all(pool)
            .await?;
    let stored = |signals: &[&str]| -> HashSet<i64> {
        fb_rows
            .iter()
            .filter(|(_, s)| signals.contains(&s.as_str()))
            .map(|(id, _)| *id)
            .collect()
    };
    let (liked_ids, disliked_ids, reject_from_feedback) = match &req.feedback {
        Some(inline) => {
            let pick = |want: &dyn Fn(&str) -> bool| -> HashSet<i64> {
                inline
                    .iter()
                    .filter(|(_, s)| want(s))
                    .map(|(id, _)| *id)
                    .collect()
            };
            let likes = pick(&|s| POSITIVE_FEEDBACK_SIGNALS.contains(&s));
            let dislikes = pick(&|s| s == "dislike");
            let rejects = pick(&|s| s != "dislike" && !POSITIVE_FEEDBACK_SIGNALS.contains(&s));
            let mut liked = likes;
            if stored_engagement {
                liked.extend(
                    stored(ENGAGEMENT_FEEDBACK_SIGNALS)
                        .into_iter()
                        .filter(|id| !dislikes.contains(id) && !rejects.contains(id)),
                );
            }
            (liked, dislikes, rejects)
        }
        None => (
            stored(POSITIVE_FEEDBACK_SIGNALS),
            stored(&["dislike"]),
            stored(&["reject"]),
        ),
    };

    // ----- household rejections: inline replaces stored; per-user rejects
    // always apply.
    let mut rejected_ids: HashSet<i64> = match &req.household_rejections {
        Some(ids) => ids.iter().copied().collect(),
        None => sqlx::query_scalar("SELECT tmdb_id FROM household_rejections WHERE kind = ?")
            .bind(kind)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect(),
    };
    rejected_ids.extend(&reject_from_feedback);

    let liked_embeddings = stack_embeddings(pool, kind, &liked_ids).await?;
    let liked_titles = load_title_rows(pool, kind, &liked_ids).await?;
    let disliked_embeddings = stack_embeddings(pool, kind, &disliked_ids).await?;

    // ----- recently shown, newest first
    let recently_shown_order: Vec<i64> = if req.exclude_recently_shown {
        sqlx::query_scalar(
            "SELECT tmdb_id FROM recently_shown
             WHERE sub = ? AND kind = ?
               AND datetime(ts) >= datetime('now', ?)
             ORDER BY ts DESC",
        )
        .bind(&req.sub)
        .bind(kind)
        .bind(format!("-{RECENTLY_SHOWN_RETENTION_DAYS} days"))
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };
    let recently_shown_ids: HashSet<i64> = recently_shown_order.iter().copied().collect();

    let diag = json!({
        "library_count": library_ids.len(),
        "liked_count": liked_ids.len(),
        "disliked_count": disliked_ids.len(),
        "rejected_count": rejected_ids.len(),
        "recently_shown_count": recently_shown_ids.len(),
    });
    Ok(UserContext {
        sub: req.sub.clone(),
        kind,
        library_ids,
        library_title_keys,
        library_embeddings,
        library_titles,
        liked_ids,
        liked_titles,
        liked_embeddings,
        disliked_ids,
        disliked_embeddings,
        rejected_ids,
        recently_shown_ids,
        recently_shown_order,
        diag,
    })
}

/// A sanitized model_config param.
#[derive(Clone, Debug, PartialEq)]
pub enum Param {
    Int(i64),
    Float(f64),
}

pub type Params = BTreeMap<String, Param>;

/// (version, recipe, params)
pub type ModelConfig = (String, String, Params);

fn implicit_default(config: &Config) -> ModelConfig {
    ("v0".into(), config.default_recipe.clone(), Params::new())
}

/// The active model_config row, or ("v0", default recipe, {}) when there is
/// none or it is unusable (unknown recipe, params_json not a JSON object).
pub async fn get_active_model_config(pool: &SqlitePool, config: &Config) -> Result<ModelConfig> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT version, recipe, params_json FROM model_config WHERE active = 1 LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    let Some((version, recipe, params_json)) = row else {
        return Ok(implicit_default(config));
    };
    let Some(r) = recipes::get(&recipe) else {
        tracing::error!(
            "active model_config {version} has unknown recipe {recipe:?}; using default recipe"
        );
        return Ok(implicit_default(config));
    };
    let params = match serde_json::from_str::<Value>(&params_json) {
        Ok(Value::Object(m)) => m,
        Ok(other) => {
            tracing::error!(
                "active model_config {version} params_json is {}; using default recipe",
                py_type_name(&other)
            );
            return Ok(implicit_default(config));
        }
        Err(_) => {
            tracing::error!(
                "active model_config {version} has invalid params_json; using default recipe"
            );
            return Ok(implicit_default(config));
        }
    };
    let clean = sanitize_model_params(r.defaults, &params, &version);
    Ok((version, recipe, clean))
}

fn py_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// Keep only the recipe's own keys, typed as its defaults: ints rounded half
/// to even and clamped, floats clamped (MODEL_PARAM_BOUNDS, else a wide
/// default range); bools, non-numbers and non-finite values dropped. (No
/// recipe has a string default, so the Python str branch is not ported.)
pub fn sanitize_model_params(
    defaults: &[(&str, Def)],
    params: &serde_json::Map<String, Value>,
    version: &str,
) -> Params {
    let mut out = Params::new();
    for (key, default) in defaults {
        let Some(value) = params.get(*key) else {
            continue;
        };
        if value.is_boolean() {
            continue;
        }
        let bounds = MODEL_PARAM_BOUNDS
            .iter()
            .find(|(k, _, _)| k == key)
            .map(|&(_, lo, hi)| (lo, hi));
        let number = value.as_f64().filter(|f| f.is_finite());
        match default {
            _ if number.is_none() => {
                tracing::error!(
                    "active model_config {version} has invalid param {key:?}; ignoring"
                );
            }
            Def::Int(_) => {
                let (lo, hi) = bounds.unwrap_or((1.0, 100000.0));
                let f = number.unwrap().round_ties_even();
                out.insert(key.to_string(), Param::Int(f.clamp(lo, hi) as i64));
            }
            Def::Float(_) => {
                let (lo, hi) = bounds.unwrap_or((-1.0e6, 1.0e6));
                out.insert(key.to_string(), Param::Float(number.unwrap().clamp(lo, hi)));
            }
        }
    }
    out
}

/// A thin household (library under the threshold, no likes) gets the
/// popularity recipe; everyone else the given or active model_config.
pub async fn select_model_config_for_context(
    pool: &SqlitePool,
    config: &Config,
    ctx: &UserContext,
    model_config: Option<ModelConfig>,
) -> Result<ModelConfig> {
    if (ctx.library_ids.len() as i64) < config.cold_start_threshold && ctx.liked_ids.is_empty() {
        return Ok((
            "cold-start".into(),
            "cold_start_trending".into(),
            Params::new(),
        ));
    }
    match model_config {
        Some(m) => Ok(m),
        None => get_active_model_config(pool, config).await,
    }
}
