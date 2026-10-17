//! Recurring jobs (iptvScheduler.ts): catalog sync on IPTV_SYNC_CRON (6h by
//! default), a bootstrap sync at boot only when `last_sync` is missing or older
//! than 7 days, and the 03:00 sweep that hard-deletes title-link tombstones
//! older than 14 days. Cron times are local time, as node-cron's were.
//! Failures go out as `tracing::error!`, which the sentry layer in main turns
//! into Glitchtip issues.

use std::future::Future;
use std::sync::Arc;

use chrono::{DateTime, Local, Utc};
use croner::Cron;
use croner::parser::{CronParser, Seconds};
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::sync::{CatalogSync, get_state};

pub const DEFAULT_SYNC_CRON: &str = "0 */6 * * *";
const TOMBSTONE_SWEEP_CRON: &str = "0 3 * * *";

/// node-cron syntax: five fields, or six with leading seconds.
pub fn parse_cron(expr: &str) -> Option<Cron> {
    CronParser::builder()
        .seconds(Seconds::Optional)
        .build()
        .parse(expr)
        .ok()
}

fn cron_or_default(expr: &str) -> Cron {
    parse_cron(expr).unwrap_or_else(|| {
        tracing::error!("invalid IPTV_SYNC_CRON {expr:?}; using {DEFAULT_SYNC_CRON}");
        parse_cron(DEFAULT_SYNC_CRON).expect("default cron parses")
    })
}

/// Bootstrap when there is no `last_sync` row or it is older than 7 days. An
/// unparsable timestamp does not bootstrap (NaN compared false in the TS).
pub fn needs_bootstrap(last_ts: Option<&str>, now: DateTime<Utc>) -> bool {
    match last_ts {
        None => true,
        Some(ts) => DateTime::parse_from_rfc3339(ts)
            .is_ok_and(|t| now - t.with_timezone(&Utc) > chrono::Duration::days(7)),
    }
}

pub async fn tombstone_sweep(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    let r =
        sqlx::query("DELETE FROM iptv_title_link WHERE removed_at < datetime('now', '-14 days')")
            .execute(pool)
            .await?;
    Ok(r.rows_affected())
}

/// Spawn the bootstrap check, the sync loop and the tombstone sweep. The
/// handles are returned so shutdown can abort them.
pub fn spawn(sync: Arc<CatalogSync>, sync_cron: &str) -> Vec<JoinHandle<()>> {
    let boot = sync.clone();
    let bootstrap = tokio::spawn(async move {
        let last = match get_state(&boot.pool, "last_sync").await {
            Ok(row) => row,
            Err(e) => return tracing::error!(error = %e, "iptv bootstrap check failed"),
        };
        if needs_bootstrap(last.as_ref().map(|(_, ts)| ts.as_str()), Utc::now())
            && let Err(e) = boot.sync_once().await
        {
            tracing::error!(error = %e, "iptv bootstrap sync failed");
        }
    });

    let tick = sync.clone();
    let sync_loop = tokio::spawn(every(cron_or_default(sync_cron), move || {
        let s = tick.clone();
        async move {
            if let Err(e) = s.sync_once().await {
                tracing::error!(error = %e, "iptv scheduled sync failed");
            }
        }
    }));

    let sweep = tokio::spawn(every(
        parse_cron(TOMBSTONE_SWEEP_CRON).expect("sweep cron parses"),
        move || {
            let s = sync.clone();
            async move {
                match tombstone_sweep(&s.pool).await {
                    Ok(0) => {}
                    Ok(n) => {
                        tracing::info!(removed = n, "tombstone sweep: removed stale link rows")
                    }
                    Err(e) => tracing::error!(error = %e, "iptv tombstone sweep failed"),
                }
            }
        },
    ));

    vec![bootstrap, sync_loop, sweep]
}

/// Run `job` at every occurrence of `cron`, one at a time. A run that overlaps
/// the next occurrence skips it, like the single-flight sync does.
async fn every<F, Fut>(cron: Cron, mut job: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    let mut last = Local::now();
    loop {
        // From the later of now and the last fire, so a wake a hair early never
        // fires the same occurrence twice.
        let from = Local::now().max(last);
        let Ok(next) = cron.find_next_occurrence(&from, false) else {
            return tracing::error!("cron has no next occurrence; job stopped");
        };
        tokio::time::sleep((next - Local::now()).to_std().unwrap_or_default()).await;
        last = next;
        job().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::put_state;
    use crate::testpanel::Panel;
    use crate::xtream::iso;

    #[test]
    fn cron_accepts_node_cron_syntax_and_falls_back_on_garbage() {
        assert!(parse_cron("*/5 * * * *").is_some());
        assert!(
            parse_cron("0 0 */6 * * *").is_some(),
            "six fields with seconds"
        );
        assert!(parse_cron("not a cron").is_none());
        let fallback = cron_or_default("not a cron");
        let at = Local::now();
        assert_eq!(
            fallback.find_next_occurrence(&at, false).unwrap(),
            parse_cron(DEFAULT_SYNC_CRON)
                .unwrap()
                .find_next_occurrence(&at, false)
                .unwrap()
        );
    }

    #[test]
    fn bootstraps_only_when_last_sync_is_missing_or_a_week_old() {
        let now = Utc::now();
        assert!(needs_bootstrap(None, now));
        assert!(needs_bootstrap(
            Some(&iso(now - chrono::Duration::days(8))),
            now
        ));
        assert!(!needs_bootstrap(
            Some(&iso(now - chrono::Duration::days(1))),
            now
        ));
        assert!(!needs_bootstrap(Some("garbage"), now));
    }

    #[tokio::test]
    async fn sweep_hard_deletes_tombstones_older_than_14_days_only() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        let now = Utc::now();
        for (id, removed) in [
            (1, Some(iso(now - chrono::Duration::days(15)))),
            (2, Some(iso(now - chrono::Duration::days(13)))),
            (3, None),
        ] {
            sqlx::query("INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id, removed_at) VALUES ('vod', ?, 'movie', 1, ?)")
                .bind(id)
                .bind(removed)
                .execute(&pool)
                .await
                .unwrap();
        }
        assert_eq!(tombstone_sweep(&pool).await.unwrap(), 1);
        let left: Vec<i64> =
            sqlx::query_scalar("SELECT iptv_id FROM iptv_title_link ORDER BY iptv_id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(left, vec![2, 3]);
    }

    #[tokio::test]
    async fn boot_syncs_a_stale_catalog_and_leaves_a_fresh_one_alone() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        let panel = Panel::start().await;
        panel.set(
            "get_live_categories",
            serde_json::json!([{"category_id": 1, "category_name": "News"}]),
        );
        let sync = CatalogSync::new(pool.clone(), Arc::new(panel.config()));

        put_state(&pool, "last_sync", "ok", &iso(Utc::now()))
            .await
            .unwrap();
        let handles = spawn(sync.clone(), DEFAULT_SYNC_CRON);
        let mut handles = handles.into_iter();
        handles.next().unwrap().await.unwrap();
        assert_eq!(
            panel.hits(),
            0,
            "fresh last_sync: no provider traffic at boot"
        );
        handles.for_each(|h| h.abort());

        put_state(
            &pool,
            "last_sync",
            "ok",
            &iso(Utc::now() - chrono::Duration::days(8)),
        )
        .await
        .unwrap();
        let mut handles = spawn(sync, DEFAULT_SYNC_CRON).into_iter();
        handles.next().unwrap().await.unwrap();
        handles.for_each(|h| h.abort());
        assert!(panel.hits() > 0);
        let (value, ts) = get_state(&pool, "last_sync").await.unwrap().unwrap();
        assert_eq!(value, "ok");
        assert!(!needs_bootstrap(Some(&ts), Utc::now()));
    }
}
