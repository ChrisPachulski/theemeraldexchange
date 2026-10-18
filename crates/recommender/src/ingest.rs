//! TMDB ingest worker (port of workers/tmdb_ingest.py).
//!
//! * `bootstrap` walks /discover by 5-year buckets (vote_count >= 50, no
//!   adult titles) into ingest_queue, then hydrates each pending row through
//!   /movie/{id} or /tv/{id} with keywords and credits. Resumable.
//! * `changes` reads /movie/changes and /tv/changes from the ingest_state
//!   cursor in 14-day windows, re-queues those ids and hydrates them.
//! * `retry-errors` puts error rows (below max attempts) back to pending.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use chrono::{Datelike, NaiveDate};
use serde_json::{Map, Value};
use sqlx::sqlite::{Sqlite, SqliteArguments};
use sqlx::{Connection, SqliteConnection, SqlitePool};

use crate::db::encode_vec_rowid;
use crate::tmdb::TmdbClient;
use crate::{Error, Result};

pub const MIN_VOTE_COUNT: i64 = 50;
const TMDB_MAX_PAGES: i64 = 500;
pub const CONCURRENCY: usize = 8;
pub const DEFAULT_MAX_REQUEUE_ATTEMPTS: i64 = 8;
/// A batch that moves no row out of 'pending' re-selects the same rows, so
/// the loop backs off and aborts after this many such batches in a row.
const MAX_STALLED_NO_PROGRESS_BATCHES: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Bootstrap,
    Changes,
    RetryErrors,
}

#[derive(Clone, Debug)]
pub struct Opts {
    pub mode: Mode,
    pub concurrency: usize,
    /// Stop after this many done + skipped hydrations.
    pub limit: Option<i64>,
    pub skip_enumerate: bool,
    pub retry_errors: bool,
    /// <= 0 means unbounded.
    pub max_attempts: i64,
}

impl Opts {
    /// `ingest --mode M [--concurrency N] [--limit N] [--skip-enumerate]
    /// [--retry-errors] [--max-attempts N]`.
    pub fn parse(args: &[String]) -> std::result::Result<Self, String> {
        let mut opts = Opts {
            mode: Mode::Bootstrap,
            concurrency: CONCURRENCY,
            limit: None,
            skip_enumerate: false,
            retry_errors: false,
            max_attempts: DEFAULT_MAX_REQUEUE_ATTEMPTS,
        };
        let mut mode = None;
        let mut it = args.iter();
        while let Some(flag) = it.next() {
            let mut value = || it.next().ok_or(format!("{flag} needs a value"));
            let int = |v: &String| {
                v.parse::<i64>()
                    .map_err(|_| format!("{flag}: {v:?} is not an integer"))
            };
            match flag.as_str() {
                "--mode" => {
                    mode = Some(match value()?.as_str() {
                        "bootstrap" => Mode::Bootstrap,
                        "changes" => Mode::Changes,
                        "retry-errors" => Mode::RetryErrors,
                        m => return Err(format!("unknown mode: {m}")),
                    })
                }
                "--concurrency" => {
                    let n = int(value()?)?;
                    opts.concurrency = usize::try_from(n)
                        .ok()
                        .filter(|&n| n >= 1)
                        .ok_or("--concurrency must be >= 1")?;
                }
                "--limit" => opts.limit = Some(int(value()?)?),
                "--max-attempts" => opts.max_attempts = int(value()?)?,
                "--skip-enumerate" => opts.skip_enumerate = true,
                "--retry-errors" => opts.retry_errors = true,
                f => return Err(format!("unknown flag {f}")),
            }
        }
        opts.mode = mode.ok_or("--mode is required")?;
        Ok(opts)
    }
}

/// One ingest run. `today` is the local date (Python's date.today()).
pub async fn run(
    pool: &SqlitePool,
    client: Arc<TmdbClient>,
    opts: &Opts,
    today: NaiveDate,
) -> Result<()> {
    match opts.mode {
        Mode::Bootstrap if !opts.skip_enumerate => {
            for kind in ["movie", "tv"] {
                let n = enumerate_kind(&client, pool, kind, today.year().into()).await?;
                tracing::info!("enumerate {kind}: {n} added/seen");
            }
        }
        Mode::Changes => {
            for kind in ["movie", "tv"] {
                let n = changes_since(&client, pool, kind, today).await?;
                tracing::info!("changes enqueued {kind}: {n}");
            }
        }
        _ => {}
    }
    if opts.retry_errors || opts.mode == Mode::RetryErrors {
        requeue_errors(pool, opts.max_attempts).await?;
    }
    let worker_pool = pool.clone();
    let (done, skipped) = hydrate_loop(
        pool,
        opts.concurrency,
        opts.limit,
        Duration::from_secs(1),
        move |id, kind| {
            let (pool, client) = (worker_pool.clone(), client.clone());
            async move { hydrate_row(&pool, &client, id, &kind).await }
        },
    )
    .await?;
    tracing::info!("{:?} hydrate: done={done} skipped={skipped}", opts.mode);
    Ok(())
}

/// (start, end) year buckets: 1900 to this year + 2, five years each.
pub fn year_buckets(this_year: i64) -> Vec<(i64, i64)> {
    (1900..this_year + 3)
        .step_by(5)
        .map(|start| (start, (start + 4).min(this_year + 2)))
        .collect()
}

fn utc_now_seconds() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S+00:00")
        .to_string()
}

/// Walk the year buckets and queue every (tmdb_id, kind) /discover returns.
/// A failed page ends its bucket.
pub async fn enumerate_kind(
    client: &TmdbClient,
    pool: &SqlitePool,
    kind: &str,
    this_year: i64,
) -> Result<usize> {
    let mut total = 0;
    for (gte, lte) in year_buckets(this_year) {
        let mut page = 1;
        while page <= TMDB_MAX_PAGES {
            let data = match client.discover(kind, page, MIN_VOTE_COUNT, gte, lte).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!("discover {kind} [{gte}-{lte}] p={page} failed: {e}");
                    break;
                }
            };
            let results = list_or_empty(&data, "results")?;
            if results.is_empty() {
                break;
            }
            let mut ids = Vec::new();
            for r in results {
                let r = object(r)?;
                if truthy(r.get("id")) && !truthy(r.get("adult")) {
                    ids.push(py_int(&r["id"])?);
                }
            }
            let now = utc_now_seconds();
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
            for id in &ids {
                sqlx::query(
                    "INSERT INTO ingest_queue(tmdb_id, kind, status, attempts, updated_at)
                     VALUES (?, ?, 'pending', 0, ?)
                     ON CONFLICT(tmdb_id, kind) DO NOTHING",
                )
                .bind(id)
                .bind(kind)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            total += ids.len();
            let total_pages = data
                .get("total_pages")
                .filter(|v| truthy(Some(v)))
                .map(py_int)
                .transpose()?
                .unwrap_or(0);
            if page >= total_pages {
                break;
            }
            page += 1;
        }
        tracing::info!("enumerated {kind} {gte}-{lte}: {total} cumulative");
    }
    Ok(total)
}

// ---- Python value semantics for TMDB payloads ------------------------------

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// Python's `a or b`.
fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

fn object(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object()
        .ok_or_else(|| Error::Invalid(format!("expected an object, got {v}")))
}

/// `x.get(key) or []`, which must then be a list.
fn list_or_empty<'a>(obj: &'a Value, key: &str) -> Result<&'a [Value]> {
    match obj.get(key) {
        v if !truthy(v) => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        Some(v) => Err(Error::Invalid(format!("{key} is not a list: {v}"))),
        None => Ok(&[]),
    }
}

/// Python's `int(x)` for the shapes JSON can hold.
fn py_int(v: &Value) -> Result<i64> {
    let bad = || Error::Invalid(format!("not an integer: {v}"));
    match v {
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .or_else(|| {
                n.as_f64()
                    .filter(|f| f.is_finite() && f.abs() < 9.2e18)
                    .map(|f| f.trunc() as i64)
            })
            .ok_or_else(bad),
        Value::String(s) => s.trim().parse().map_err(|_| bad()),
        _ => Err(bad()),
    }
}

/// One bound parameter, as sqlite3 bound the Python value.
enum Arg {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

fn arg(v: Option<&Value>) -> Result<Arg> {
    Ok(match v {
        None | Some(Value::Null) => Arg::Null,
        Some(Value::Bool(b)) => Arg::Int(i64::from(*b)),
        Some(Value::Number(n)) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => Arg::Int(i),
            (None, Some(f)) if !n.is_u64() => Arg::Real(f),
            _ => return Err(Error::Invalid(format!("integer out of range: {n}"))),
        },
        Some(Value::String(s)) => Arg::Text(s.clone()),
        Some(v) => return Err(Error::Invalid(format!("cannot bind {v}"))),
    })
}

type Query<'q> = sqlx::query::Query<'q, Sqlite, SqliteArguments>;

fn bind(q: Query<'_>, a: Arg) -> Query<'_> {
    match a {
        Arg::Null => q.bind(None::<i64>),
        Arg::Int(i) => q.bind(i),
        Arg::Real(f) => q.bind(f),
        Arg::Text(s) => q.bind(s),
    }
}

fn flatten_year(release: Option<&Value>) -> Result<Option<i64>> {
    match release {
        r if !truthy(r) => Ok(None),
        Some(Value::String(s)) => {
            if s.chars().count() < 4 {
                return Ok(None);
            }
            Ok(s.chars().take(4).collect::<String>().trim().parse().ok())
        }
        Some(v) => Err(Error::Invalid(format!("release date is not a string: {v}"))),
        None => Ok(None),
    }
}

// ---- Hydration --------------------------------------------------------------

async fn delete_title(conn: &mut SqliteConnection, kind: &str, tmdb_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM title_vec WHERE rowid = ? AND kind = ?")
        .bind(encode_vec_rowid(kind, tmdb_id)?)
        .bind(kind)
        .execute(&mut *conn)
        .await?;
    for table in [
        "title_features",
        "title_genres",
        "title_keywords",
        "title_cast",
        "title_crew",
        "titles",
    ] {
        // Fixed table names from the list above.
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE kind = ? AND tmdb_id = ?"
        )))
        .bind(kind)
        .bind(tmdb_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// What persist_detail writes besides the titles row.
struct Children {
    genres: Vec<i64>,
    keywords: Vec<(i64, Arg)>,
    cast: Vec<(i64, Arg, Arg)>,
    crew: Vec<(i64, Arg, Arg)>,
}

fn children(p: &Value) -> Result<Children> {
    let mut genres = Vec::new();
    for g in list_or_empty(p, "genres")? {
        let g = object(g)?;
        if let Some(id) = g.get("id").filter(|v| !v.is_null()) {
            genres.push(py_int(id)?);
        }
    }
    let empty = Value::Object(Map::new());
    let kw_block = or(p.get("keywords"), Some(&empty)).unwrap_or(&empty);
    object(kw_block)?;
    let kws = match or(kw_block.get("keywords"), kw_block.get("results")) {
        v if !truthy(v) => &[][..],
        Some(Value::Array(a)) => a,
        Some(v) => return Err(Error::Invalid(format!("keywords is not a list: {v}"))),
        None => &[][..],
    };
    let mut keywords = Vec::new();
    for k in kws {
        let k = object(k)?;
        if let Some(id) = k.get("id").filter(|v| !v.is_null()) {
            keywords.push((py_int(id)?, arg(k.get("name"))?));
        }
    }
    let credits = or(p.get("credits"), Some(&empty)).unwrap_or(&empty);
    object(credits)?;
    // Top 20 cast (sliced before the id filter), every crew row with a job.
    let mut cast = Vec::new();
    for c in list_or_empty(credits, "cast")?.iter().take(20) {
        let c = object(c)?;
        if let Some(id) = c.get("id").filter(|v| !v.is_null()) {
            cast.push((py_int(id)?, arg(c.get("name"))?, arg(c.get("order"))?));
        }
    }
    let mut crew = Vec::new();
    for c in list_or_empty(credits, "crew")? {
        let c = object(c)?;
        if let Some(id) = c.get("id").filter(|v| !v.is_null())
            && truthy(c.get("job"))
        {
            crew.push((py_int(id)?, arg(c.get("name"))?, arg(c.get("job"))?));
        }
    }
    Ok(Children {
        genres,
        keywords,
        cast,
        crew,
    })
}

/// Write one detail payload into titles and its child tables. Adult titles
/// and titles under the vote floor are deleted everywhere instead; returns
/// false for those.
pub async fn persist_detail(conn: &mut SqliteConnection, kind: &str, p: &Value) -> Result<bool> {
    let obj = object(p)?;
    let tmdb_id = py_int(
        obj.get("id")
            .ok_or_else(|| Error::Invalid("detail has no id".into()))?,
    )?;
    let adult = truthy(obj.get("adult"));
    let vote_count = match obj.get("vote_count") {
        _ if adult => 0,
        v if !truthy(v) => 0,
        Some(v) => py_int(v)?,
        None => 0,
    };
    if adult || vote_count < MIN_VOTE_COUNT {
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
        delete_title(&mut tx, kind, tmdb_id).await?;
        tx.commit().await?;
        return Ok(false);
    }

    let fallback = Value::String("?".into());
    let title = or(or(obj.get("title"), obj.get("name")), Some(&fallback));
    let original_title = or(obj.get("original_title"), obj.get("original_name"));
    let release = or(obj.get("release_date"), obj.get("first_air_date"));
    let year = flatten_year(release)?;
    let runtime = if kind == "movie" {
        arg(obj.get("runtime"))?
    } else {
        match list_or_empty(p, "episode_run_time")? {
            [] => Arg::Null,
            ert => {
                let mut sum = 0f64;
                for v in ert {
                    sum += v
                        .as_f64()
                        .ok_or_else(|| Error::Invalid(format!("bad episode_run_time {v}")))?;
                }
                Arg::Int((sum / ert.len() as f64).trunc() as i64)
            }
        }
    };
    let kids = children(p)?;
    let raw_json = serde_json::to_string(p).map_err(|e| Error::Invalid(e.to_string()))?;

    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let mut q = sqlx::query(
        "INSERT INTO titles(
            tmdb_id, kind, title, original_title, year, release_date, overview,
            poster_path, vote_average, vote_count, popularity, runtime, status,
            original_language, adult, last_changed_at, fetched_at, raw_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?)
          ON CONFLICT(tmdb_id, kind) DO UPDATE SET
            title = excluded.title,
            original_title = excluded.original_title,
            year = excluded.year,
            release_date = excluded.release_date,
            overview = excluded.overview,
            poster_path = excluded.poster_path,
            vote_average = excluded.vote_average,
            vote_count = excluded.vote_count,
            popularity = excluded.popularity,
            runtime = excluded.runtime,
            status = excluded.status,
            original_language = excluded.original_language,
            adult = excluded.adult,
            last_changed_at = excluded.last_changed_at,
            fetched_at = excluded.fetched_at,
            raw_json = excluded.raw_json",
    )
    .bind(tmdb_id)
    .bind(kind);
    q = bind(q, arg(title)?);
    q = bind(q, arg(original_title)?);
    q = q.bind(year);
    q = bind(q, arg(release)?);
    for key in ["overview", "poster_path", "vote_average"] {
        q = bind(q, arg(obj.get(key))?);
    }
    q = q.bind(vote_count);
    q = bind(q, arg(obj.get("popularity"))?);
    q = bind(q, runtime);
    for key in ["status", "original_language"] {
        q = bind(q, arg(obj.get(key))?);
    }
    q.bind(utc_now_seconds())
        .bind(raw_json)
        .execute(&mut *tx)
        .await?;

    let clear = |table: &str| format!("DELETE FROM {table} WHERE kind = ? AND tmdb_id = ?");
    // Fixed table names.
    sqlx::query(sqlx::AssertSqlSafe(clear("title_genres")))
        .bind(kind)
        .bind(tmdb_id)
        .execute(&mut *tx)
        .await?;
    for g in kids.genres {
        sqlx::query("INSERT INTO title_genres(tmdb_id, kind, genre_id) VALUES (?,?,?)")
            .bind(tmdb_id)
            .bind(kind)
            .bind(g)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(sqlx::AssertSqlSafe(clear("title_keywords")))
        .bind(kind)
        .bind(tmdb_id)
        .execute(&mut *tx)
        .await?;
    for (id, name) in kids.keywords {
        let q = sqlx::query(
            "INSERT INTO title_keywords(tmdb_id, kind, keyword_id, keyword) VALUES (?,?,?,?)",
        )
        .bind(tmdb_id)
        .bind(kind)
        .bind(id);
        bind(q, name).execute(&mut *tx).await?;
    }
    sqlx::query(sqlx::AssertSqlSafe(clear("title_cast")))
        .bind(kind)
        .bind(tmdb_id)
        .execute(&mut *tx)
        .await?;
    for (id, name, order) in kids.cast {
        let q = sqlx::query(
            "INSERT INTO title_cast(tmdb_id, kind, person_id, name, order_idx) VALUES (?,?,?,?,?)",
        )
        .bind(tmdb_id)
        .bind(kind)
        .bind(id);
        bind(bind(q, name), order).execute(&mut *tx).await?;
    }
    sqlx::query(sqlx::AssertSqlSafe(clear("title_crew")))
        .bind(kind)
        .bind(tmdb_id)
        .execute(&mut *tx)
        .await?;
    for (id, name, job) in kids.crew {
        let q = sqlx::query(
            "INSERT INTO title_crew(tmdb_id, kind, person_id, name, job) VALUES (?,?,?,?,?)",
        )
        .bind(tmdb_id)
        .bind(kind)
        .bind(id);
        bind(bind(q, name), job).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// A hydrate worker's result. Locked and Deferred leave the row pending.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Done,
    Skipped,
    Error,
    Locked,
    Deferred,
}

fn is_locked(e: &sqlx::Error) -> bool {
    e.to_string().to_lowercase().contains("database is locked")
}

/// The text last_error stores: sqlite's own message for database errors
/// (as Python's str(exc)), the redacted TMDB text otherwise; 300 chars.
fn error_text(e: &Error) -> String {
    let text = match e {
        Error::Sql(sqlx::Error::Database(db)) => db.message().to_string(),
        e => e.to_string(),
    };
    text.chars().take(300).collect()
}

async fn mark_error(
    conn: &mut SqliteConnection,
    tmdb_id: i64,
    kind: &str,
    e: &Error,
) -> std::result::Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE ingest_queue SET status='error', attempts=attempts+1,
           last_error=?, updated_at=datetime('now')
         WHERE tmdb_id=? AND kind=?",
    )
    .bind(error_text(e))
    .bind(tmdb_id)
    .bind(kind)
    .execute(conn)
    .await
    .map(drop)
}

/// Fetch and persist one queued title, then record the queue outcome.
pub(crate) async fn hydrate_row(
    pool: &SqlitePool,
    client: &TmdbClient,
    tmdb_id: i64,
    kind: &str,
) -> Result<Outcome> {
    let detail = client.detail(kind, tmdb_id).await;
    let mut conn = match pool.acquire().await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("hydrate {kind} {tmdb_id} open-db failed; leaving pending: {e}");
            return Ok(if is_locked(&e) {
                Outcome::Locked
            } else {
                Outcome::Deferred
            });
        }
    };
    let detail = match detail {
        Ok(d) => d,
        Err(e) => {
            return match mark_error(&mut conn, tmdb_id, kind, &e).await {
                Ok(()) => Ok(Outcome::Error),
                Err(db) if is_locked(&db) => {
                    tracing::warn!("hydrate {kind} {tmdb_id} queue update locked; leaving pending");
                    Ok(Outcome::Locked)
                }
                Err(db) => Err(db.into()),
            };
        }
    };
    let persisted = async {
        let kept = persist_detail(&mut conn, kind, &detail).await?;
        sqlx::query(
            "UPDATE ingest_queue SET status=?, attempts=attempts+1,
               last_error=NULL, updated_at=datetime('now')
             WHERE tmdb_id=? AND kind=?",
        )
        .bind(if kept { "done" } else { "skipped" })
        .bind(tmdb_id)
        .bind(kind)
        .execute(&mut *conn)
        .await?;
        Ok::<_, Error>(kept)
    }
    .await;
    match persisted {
        Ok(true) => Ok(Outcome::Done),
        Ok(false) => Ok(Outcome::Skipped),
        Err(Error::Sql(e)) if is_locked(&e) => {
            tracing::warn!("hydrate {kind} {tmdb_id} persist locked; leaving pending");
            Ok(Outcome::Locked)
        }
        Err(e) => {
            tracing::warn!("hydrate {kind} {tmdb_id} persist failed: {e}");
            mark_error(&mut conn, tmdb_id, kind, &e).await?;
            Ok(Outcome::Error)
        }
    }
}

/// The back-off before the next batch after `n` stalled batches in a row.
pub fn stall_delay(n: u32, unit: Duration) -> Duration {
    unit * 2u32.pow(n.min(5)).min(30)
}

/// Drain ingest_queue (status 'pending') through `worker`, `concurrency` at a
/// time. A worker error or panic counts as a crash. Returns (done, skipped).
pub(crate) async fn hydrate_loop<F, Fut>(
    pool: &SqlitePool,
    concurrency: usize,
    limit: Option<i64>,
    stall_unit: Duration,
    worker: F,
) -> Result<(i64, i64)>
where
    F: Fn(i64, String) -> Fut,
    Fut: Future<Output = Result<Outcome>> + Send + 'static,
{
    let sem = Arc::new(tokio::sync::Semaphore::new(concurrency));
    let batch_size = (concurrency as i64 * 4).max(64);
    let (mut done, mut skipped) = (0i64, 0i64);
    let mut stalled = 0u32;
    loop {
        let mut batch_limit = batch_size;
        if let Some(limit) = limit {
            let remaining = limit - done - skipped;
            if remaining <= 0 {
                break;
            }
            batch_limit = batch_limit.min(remaining);
        }
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT tmdb_id, kind FROM ingest_queue
             WHERE status='pending'
             ORDER BY attempts ASC, kind, tmdb_id
             LIMIT ?",
        )
        .bind(batch_limit)
        .fetch_all(pool)
        .await?;
        if rows.is_empty() {
            break;
        }
        let mut set = tokio::task::JoinSet::new();
        for (id, kind) in rows {
            let (sem, job) = (sem.clone(), worker(id, kind));
            set.spawn(async move {
                let _permit = sem.acquire_owned().await;
                job.await
            });
        }
        let (mut progress, mut locked, mut deferred, mut crashed) = (0, 0, 0, 0);
        while let Some(res) = set.join_next().await {
            match res {
                Ok(Ok(Outcome::Done)) => (done, progress) = (done + 1, progress + 1),
                Ok(Ok(Outcome::Skipped)) => (skipped, progress) = (skipped + 1, progress + 1),
                Ok(Ok(Outcome::Error)) => progress += 1,
                Ok(Ok(Outcome::Locked)) => locked += 1,
                Ok(Ok(Outcome::Deferred)) => deferred += 1,
                Ok(Err(e)) => {
                    tracing::error!("hydrate worker failed unexpectedly: {e}");
                    crashed += 1;
                }
                Err(e) => {
                    tracing::error!("hydrate worker failed unexpectedly: {e}");
                    crashed += 1;
                }
            }
        }
        if progress == 0 {
            stalled += 1;
            let counts =
                format!("{{'locked': {locked}, 'deferred': {deferred}, 'crashed': {crashed}}}");
            if stalled >= MAX_STALLED_NO_PROGRESS_BATCHES {
                return Err(Error::Ingest(format!(
                    "hydrate made no progress for {stalled} consecutive batches ({counts})"
                )));
            }
            let delay = stall_delay(stalled, stall_unit);
            tracing::warn!("hydrate batch made no progress ({counts}); backing off {delay:?}");
            tokio::time::sleep(delay).await;
        } else {
            stalled = 0;
        }
        if limit.is_some_and(|l| done + skipped >= l) {
            break;
        }
        tracing::info!("hydrate progress: done={done} skipped={skipped}");
    }
    Ok((done, skipped))
}

// ---- Changes ----------------------------------------------------------------

/// Queue every id /{kind}/changes lists since the cursor, in 14-day windows
/// (each window's end becomes the next start and the cursor). No cursor, or
/// one that is not a date, starts two days back.
pub async fn changes_since(
    client: &TmdbClient,
    pool: &SqlitePool,
    kind: &str,
    today: NaiveDate,
) -> Result<usize> {
    let key = format!("changes_{kind}_cursor");
    let cursor: Option<String> = sqlx::query_scalar("SELECT value FROM ingest_state WHERE key = ?")
        .bind(&key)
        .fetch_optional(pool)
        .await?;
    let two_back = today - chrono::Days::new(2);
    let start_day = match cursor {
        None => two_back,
        Some(v) => NaiveDate::parse_from_str(&v, "%Y-%m-%d").unwrap_or_else(|_| {
            tracing::warn!("invalid {kind} changes cursor {v:?}; using two-day overlap");
            two_back
        }),
    }
    .min(today);

    let mut window_start = start_day;
    let mut enqueued = 0;
    while window_start <= today {
        let window_end = (window_start + chrono::Days::new(13)).min(today);
        let (start, end) = (window_start.to_string(), window_end.to_string());
        let mut page = 1;
        loop {
            let data = client.changes(kind, &start, &end, page).await?;
            for row in list_or_empty(&data, "results")? {
                let Some(tid) = object(row)?.get("id").and_then(|v| py_int(v).ok()) else {
                    tracing::warn!("skipping {kind} changes row without valid id: {row}");
                    continue;
                };
                sqlx::query(
                    "INSERT INTO ingest_queue(tmdb_id, kind, status, attempts, updated_at)
                     VALUES (?, ?, 'pending', 0, datetime('now'))
                     ON CONFLICT(tmdb_id, kind) DO UPDATE SET status='pending',
                       attempts=0, updated_at=datetime('now')",
                )
                .bind(tid)
                .bind(kind)
                .execute(pool)
                .await?;
                enqueued += 1;
            }
            let total_pages = match data.get("total_pages") {
                v if !truthy(v) => 1,
                Some(v) => py_int(v)?,
                None => 1,
            };
            if page >= total_pages {
                break;
            }
            page += 1;
        }
        sqlx::query(
            "INSERT INTO ingest_state(key, value, ts) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
        )
        .bind(&key)
        .bind(&end)
        .execute(pool)
        .await?;
        if window_end >= today {
            break;
        }
        window_start = window_end;
    }
    Ok(enqueued)
}

/// Put error rows back to pending for another pass; rows at or above
/// `max_attempts` (when > 0) stay at error. Returns (requeued, capped).
pub async fn requeue_errors(pool: &SqlitePool, max_attempts: i64) -> Result<(u64, i64)> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let (n, capped) = if max_attempts <= 0 {
        let n = sqlx::query(
            "UPDATE ingest_queue SET status='pending', last_error=NULL,
               updated_at=datetime('now') WHERE status='error'",
        )
        .execute(&mut *tx)
        .await?
        .rows_affected();
        (n, 0)
    } else {
        let n = sqlx::query(
            "UPDATE ingest_queue SET status='pending', last_error=NULL,
               updated_at=datetime('now') WHERE status='error' AND attempts < ?",
        )
        .bind(max_attempts)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let capped = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ingest_queue WHERE status='error' AND attempts >= ?",
        )
        .bind(max_attempts)
        .fetch_one(&mut *tx)
        .await?;
        (n, capped)
    };
    tx.commit().await?;
    tracing::info!(
        "retry-errors: {n} rows requeued, {capped} rows at attempts >= max_attempts left at error"
    );
    Ok((n, capped))
}

#[cfg(test)]
mod tests;
