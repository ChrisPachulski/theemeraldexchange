use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::fake_tmdb::{self, FIXTURE_CREDENTIAL};
use crate::tmdb::{Auth, RateLimit};

fn goldens() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/ingest-goldens.json")).unwrap()
}

async fn fresh() -> (tempfile::TempDir, std::path::PathBuf, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("exchange.db");
    let pool = crate::db::open(&path).await.unwrap();
    (dir, path, pool)
}

/// No pacing and a 1 ms backoff base: the fake answers at once.
fn client(base: &str, auth: Auth) -> Arc<TmdbClient> {
    let mut c = TmdbClient::new(auth, &format!("{base}/3")).unwrap();
    c.limiter = RateLimit::new(100_000, Duration::from_secs(1));
    c.backoff_base = Duration::from_millis(1);
    Arc::new(c)
}

/// Each dump query yields one json_array(...) text per row.
async fn dump(pool: &SqlitePool, queries: &Value, base: &str) -> Value {
    let mut out = Map::new();
    for (name, sql) in queries.as_object().unwrap() {
        let rows: Vec<String> =
            sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str().unwrap().to_string()))
                .fetch_all(pool)
                .await
                .unwrap();
        let rows = rows
            .iter()
            .map(|r| serde_json::from_str(&r.replace(base, "<base>")).unwrap())
            .collect();
        out.insert(name.clone(), Value::Array(rows));
    }
    Value::Object(out)
}

fn sorted(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = v.as_array().unwrap().iter().map(Value::to_string).collect();
    out.sort();
    out
}

/// tests/fixtures/ingest-goldens.json, recorded by gen_ingest_goldens.py: the
/// untouched Python worker ran each scenario against the same fake.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scenarios_match_the_python_worker() {
    let g = goldens();
    let today = NaiveDate::parse_from_str(g["today"].as_str().unwrap(), "%Y-%m-%d").unwrap();
    for sc in g["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let (_dir, _, pool) = fresh().await;
        for stmt in sc["seed"].as_array().unwrap() {
            sqlx::raw_sql(sqlx::AssertSqlSafe(stmt.as_str().unwrap().to_string()))
                .execute(&pool)
                .await
                .unwrap();
        }
        let fake = fake_tmdb::start(&sc["fake"]).await;
        let auth = match sc["auth"].as_str().unwrap() {
            "bearer" => Auth::Bearer(FIXTURE_CREDENTIAL.into()),
            _ => Auth::Query(FIXTURE_CREDENTIAL.into()),
        };
        let o = &sc["opts"];
        let opts = Opts {
            mode: match o["mode"].as_str().unwrap() {
                "bootstrap" => Mode::Bootstrap,
                "changes" => Mode::Changes,
                _ => Mode::RetryErrors,
            },
            concurrency: o["concurrency"].as_u64().unwrap() as usize,
            limit: o["limit"].as_i64(),
            skip_enumerate: o["skip_enumerate"].as_bool().unwrap(),
            retry_errors: o["retry_errors"].as_bool().unwrap(),
            max_attempts: o["max_attempts"].as_i64().unwrap(),
        };
        let res = run(&pool, client(&fake.base, auth), &opts, today).await;
        let want = &sc["expect"];
        assert_eq!(
            res.err()
                .map(|e| e.to_string().replace(&fake.base, "<base>"))
                .as_deref(),
            want["error"].as_str(),
            "{name}: run error"
        );
        let tables = dump(&pool, &g["dump"], &fake.base).await;
        for (table, rows) in want["tables"].as_object().unwrap() {
            assert_eq!(&tables[table], rows, "{name}: {table}");
        }
        assert_eq!(
            sorted(&Value::from(fake.log())),
            sorted(&want["requests"]),
            "{name}: requests"
        );
    }
}

async fn enqueue(pool: &SqlitePool, ids: &[i64]) {
    for id in ids {
        sqlx::query(
            "INSERT INTO ingest_queue(tmdb_id, kind, status, attempts, updated_at)
             VALUES (?, 'movie', 'pending', 0, datetime('now'))",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn statuses(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar("SELECT status FROM ingest_queue ORDER BY tmdb_id")
        .fetch_all(pool)
        .await
        .unwrap()
}

/// A pool that fails every acquire with a non-"locked" error, as Python's
/// broken connect() did ("unable to open database file").
async fn dead(path: &std::path::Path) -> SqlitePool {
    let pool = crate::db::open(path).await.unwrap();
    pool.close().await;
    pool
}

const UNIT: Duration = Duration::from_millis(1);

// test_tmdb_ingest_drain: test_all_deferred_batches_back_off_and_abort.
#[tokio::test]
async fn all_deferred_batches_back_off_and_abort() {
    let (_dir, path, pool) = fresh().await;
    enqueue(&pool, &[1, 2]).await;
    let fake = fake_tmdb::start(&json!({"routes": []})).await; // TMDB down: 404 everything
    let (dead, client) = (
        dead(&path).await,
        client(&fake.base, Auth::Query(FIXTURE_CREDENTIAL.into())),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let started = std::time::Instant::now();
    let err = hydrate_loop(&pool, 2, None, UNIT, move |id, kind| {
        counter.fetch_add(1, Ordering::SeqCst);
        let (pool, client) = (dead.clone(), client.clone());
        async move { hydrate_row(&pool, &client, id, &kind).await }
    })
    .await
    .unwrap_err()
    .to_string();
    assert_eq!(
        err,
        "hydrate made no progress for 3 consecutive batches ({'locked': 0, 'deferred': 2, 'crashed': 0})"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 6);
    // Backed off 2 then 4 units between the stalled batches.
    assert_eq!(
        [stall_delay(1, UNIT), stall_delay(2, UNIT)],
        [2 * UNIT, 4 * UNIT]
    );
    assert!(started.elapsed() >= 6 * UNIT);
    assert_eq!(
        statuses(&pool).await,
        ["pending", "pending"],
        "stalled rows stay pending"
    );
}

// test_crashing_workers_also_hit_the_stall_bound: an error or a panic out of
// the worker counts as a crash, and crashes stall like deferrals.
#[tokio::test]
async fn crashing_workers_also_hit_the_stall_bound() {
    let (_dir, _, pool) = fresh().await;
    enqueue(&pool, &[1, 2]).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let err = hydrate_loop(&pool, 1, None, UNIT, move |id, _kind| {
        counter.fetch_add(1, Ordering::SeqCst);
        async move {
            if id == 1 {
                panic!("boom");
            }
            Err(Error::Invalid("boom".into()))
        }
    })
    .await
    .unwrap_err()
    .to_string();
    assert!(
        err.contains("no progress") && err.contains("'crashed': 2"),
        "{err}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2 * MAX_STALLED_NO_PROGRESS_BATCHES as usize
    );
}

// test_stall_counter_resets_once_a_batch_makes_progress.
#[tokio::test]
async fn stall_counter_resets_once_a_batch_makes_progress() {
    let (_dir, path, pool) = fresh().await;
    enqueue(&pool, &[7]).await;
    let fake = fake_tmdb::start(&json!({"routes": [{"path": "/3/movie/7", "responses": [{"status": 200,
        "body": {"id": 7, "title": "Title 7", "vote_count": 100, "release_date": "2020-01-01"}}]}]}))
    .await;
    let (dead, live) = (dead(&path).await, pool.clone());
    let client = client(&fake.base, Auth::Query(FIXTURE_CREDENTIAL.into()));
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let got = hydrate_loop(&pool, 1, None, UNIT, move |id, kind| {
        let first = counter.fetch_add(1, Ordering::SeqCst) == 0;
        let (pool, client) = (
            if first { dead.clone() } else { live.clone() },
            client.clone(),
        );
        async move { hydrate_row(&pool, &client, id, &kind).await }
    })
    .await
    .unwrap();
    assert_eq!(got, (1, 0));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "one deferred batch, then the recovery"
    );
    assert_eq!(statuses(&pool).await, ["done"]);
}

#[test]
fn year_buckets_run_five_years_to_two_past_this_year() {
    let b = year_buckets(2026);
    assert_eq!((b.len(), b[0], b[25]), (26, (1900, 1904), (2025, 2028)));
    assert_eq!(year_buckets(2027)[25], (2025, 2029));
}

#[test]
fn stall_delay_doubles_to_thirty_units() {
    let s = Duration::from_secs(1);
    let d: Vec<u64> = (1..=6).map(|n| stall_delay(n, s).as_secs()).collect();
    assert_eq!(d, [2, 4, 8, 16, 30, 30]);
}

#[test]
fn cli_flags() {
    let parse = |s: &str| Opts::parse(&s.split_whitespace().map(String::from).collect::<Vec<_>>());
    let o =
        parse("--mode changes --concurrency 3 --limit 5 --retry-errors --max-attempts 0").unwrap();
    assert_eq!(o.mode, Mode::Changes);
    assert_eq!(
        (
            o.concurrency,
            o.limit,
            o.retry_errors,
            o.max_attempts,
            o.skip_enumerate
        ),
        (3, Some(5), true, 0, false)
    );
    let o = parse("--skip-enumerate --mode bootstrap").unwrap();
    assert_eq!(
        (o.mode, o.concurrency, o.limit, o.max_attempts),
        (Mode::Bootstrap, 8, None, 8)
    );
    assert!(o.skip_enumerate);
    assert_eq!(
        parse("--mode retry-errors").unwrap().mode,
        Mode::RetryErrors
    );
    for bad in [
        "",
        "--mode nope",
        "--mode",
        "--mode changes --concurrency 0",
        "--mode changes --limit x",
        "--bogus",
    ] {
        assert!(parse(bad).is_err(), "{bad:?}");
    }
}
