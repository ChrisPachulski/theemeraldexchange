//! The recurring jobs, in process (they were host cron lines running
//! `docker exec ... python -m workers.*`): the optimizer at 03:30, TMDB
//! changes then featurize at 04:00, and every hour (plus once at boot) the
//! retention sweep and the ranker warm. Times are the container's local time.

use std::future::Future;
use std::sync::Arc;

use media_core::cron::{every, parse_cron};
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::config::Config;
use crate::recipes::Caches;

pub const OPTIMIZE_CRON: &str = "30 3 * * *";
pub const NIGHTLY_CRON: &str = "0 4 * * *";
pub const HOURLY_CRON: &str = "0 * * * *";

/// Wire the three jobs to their schedules. The hourly job also runs once now.
pub fn spawn<O, OF, N, NF, H, HF>(optimize: O, nightly: N, mut hourly: H) -> Vec<JoinHandle<()>>
where
    O: FnMut() -> OF + Send + 'static,
    OF: Future<Output = ()> + Send + 'static,
    N: FnMut() -> NF + Send + 'static,
    NF: Future<Output = ()> + Send + 'static,
    H: FnMut() -> HF + Send + 'static,
    HF: Future<Output = ()> + Send + 'static,
{
    let cron = |e: &str| parse_cron(e).expect("schedule constants parse");
    vec![
        tokio::spawn(every(cron(OPTIMIZE_CRON), optimize)),
        tokio::spawn(every(cron(NIGHTLY_CRON), nightly)),
        tokio::spawn(async move {
            hourly().await;
            every(cron(HOURLY_CRON), hourly).await;
        }),
    ]
}

/// The production jobs over the server's pool, config and recipe caches.
pub fn start(pool: SqlitePool, config: Arc<Config>, caches: Arc<Caches>) -> Vec<JoinHandle<()>> {
    let (p1, c1) = (pool.clone(), config.clone());
    let (p2, c2) = (pool.clone(), config.clone());
    spawn(
        move || {
            let (pool, config) = (p1.clone(), c1.clone());
            async move {
                if let Err(e) =
                    crate::optimizer::run(&pool, &config, crate::optimizer::ANTHROPIC_URL).await
                {
                    tracing::error!("optimizer failed: {e}");
                }
            }
        },
        move || {
            let (pool, config) = (p2.clone(), c2.clone());
            async move { nightly(&pool, &config).await }
        },
        move || {
            let (pool, config, caches) = (pool.clone(), config.clone(), caches.clone());
            async move {
                if let Err(e) =
                    crate::http::events::sweep_retention_once(&pool, config.rec_log_retention_days)
                        .await
                {
                    tracing::error!("retention sweep failed: {e}");
                }
                if let Err(e) =
                    crate::recipes::ranker::warm_if_active(&pool, &config, &caches).await
                {
                    tracing::error!("ranker cache warm failed: {e}");
                }
            }
        },
    )
}

/// TMDB changes, then featurize so changed overviews/genres/keywords reach
/// the embeddings. Featurize runs even when the ingest fails (they were two
/// independent cron lines).
async fn nightly(pool: &SqlitePool, config: &Config) {
    let changes = async {
        let client = Arc::new(crate::tmdb::TmdbClient::from_config(config)?);
        let opts = crate::ingest::Opts::parse(&["--mode".into(), "changes".into()])
            .map_err(crate::Error::Invalid)?;
        crate::ingest::run(pool, client, &opts, chrono::Local::now().date_naive()).await
    };
    if let Err(e) = changes.await {
        tracing::error!("nightly TMDB changes ingest failed: {e}");
    }
    let featurize = async {
        let embedder = Arc::new(crate::embed::Embedder::load(&config.model_dir)?);
        crate::featurize::run(pool, embedder, None).await
    };
    if let Err(e) = featurize.await {
        tracing::error!("nightly featurize failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::Local;

    use super::*;

    // The cron strings say what the old host crontab said.
    #[test]
    fn schedules_match_the_old_crontab() {
        let at = |s: &str| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M")
                .unwrap()
                .and_local_timezone(Local)
                .unwrap()
        };
        let from = at("2026-10-18 02:10");
        let next = |e: &str| {
            parse_cron(e)
                .unwrap()
                .find_next_occurrence(&from, false)
                .unwrap()
        };
        assert_eq!(next(OPTIMIZE_CRON), at("2026-10-18 03:30"));
        assert_eq!(next(NIGHTLY_CRON), at("2026-10-18 04:00"));
        assert_eq!(next(HOURLY_CRON), at("2026-10-18 03:00"));
    }

    // spawn() runs the hourly job at boot and each job at its own first
    // occurrence, injected jobs standing in for the real ones.
    #[tokio::test(start_paused = true)]
    async fn spawn_wires_each_job_to_its_schedule() {
        let log = Arc::new(Mutex::new(Vec::<&str>::new()));
        let job = |name: &'static str| {
            let log = log.clone();
            move || {
                let log = log.clone();
                async move { log.lock().unwrap().push(name) }
            }
        };
        let now = Local::now();
        let handles = spawn(job("optimize"), job("nightly"), job("hourly"));
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        assert_eq!(
            *log.lock().unwrap(),
            ["hourly"],
            "hourly runs at boot, nothing else"
        );

        // Each job fires at its own first occurrence and not before.
        let count = |name: &str| log.lock().unwrap().iter().filter(|n| **n == name).count();
        let mut firsts: Vec<(chrono::DateTime<Local>, &str)> = [
            (OPTIMIZE_CRON, "optimize"),
            (NIGHTLY_CRON, "nightly"),
            (HOURLY_CRON, "hourly"),
        ]
        .iter()
        .map(|(e, n)| {
            (
                parse_cron(e)
                    .unwrap()
                    .find_next_occurrence(&now, false)
                    .unwrap(),
                *n,
            )
        })
        .collect();
        firsts.sort();
        let start = tokio::time::Instant::now();
        let second = std::time::Duration::from_secs(1);
        for (at, name) in firsts {
            let due = start + (at - now).to_std().unwrap();
            let before = if name == "hourly" { 1 } else { 0 };
            // Two jobs due at the same minute: the second's "before" has passed.
            if tokio::time::Instant::now() < due - second {
                tokio::time::sleep_until(due - second).await;
                assert_eq!(count(name), before, "{name} before its time");
            }
            tokio::time::sleep_until(due + second).await;
            assert_eq!(count(name), before + 1, "{name} at its time");
        }
        handles.iter().for_each(JoinHandle::abort);
    }
}
