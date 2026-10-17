//! Catalog sync (`syncOnce` in iptvSync.ts; the EPG half is `epg::refresh`)
//! and the admin sync-job table (iptvSyncJobs.ts).
//!
//! One run fetches categories and the three catalog lists, expands every series
//! 4-wide, then writes everything in ONE transaction: upsert, delete what this
//! run did not see (by `fetched_at`), soft-delete orphaned title links, re-link
//! and prune categories. Rows go in as one JSON array per table through
//! `json_each`, so the write lock is held for SQL time only, not per-row
//! round-trips.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::xtream::{self, Client, Creds, Kind, iso};

const MAX_REMEMBERED_JOBS: usize = 20;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub channels: usize,
    pub vod: usize,
    pub series: usize,
    pub episodes: usize,
    pub epg: usize,
    pub categories: usize,
    pub duration_ms: i64,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum SyncResult {
    Busy { busy: bool },
    Done(SyncStats),
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Running,
    Done,
    /// Another sync was already running, so this one never started.
    Rejected,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncJob {
    pub id: String,
    pub state: JobState,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<SyncResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct CatalogSync {
    pub pool: SqlitePool,
    config: Arc<Config>,
    running: AtomicBool,
    jobs: Mutex<Vec<SyncJob>>,
}

struct Release<'a>(&'a AtomicBool);
impl Drop for Release<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl CatalogSync {
    pub fn new(pool: SqlitePool, config: Arc<Config>) -> Arc<Self> {
        Arc::new(CatalogSync {
            pool,
            config,
            running: AtomicBool::new(false),
            jobs: Mutex::new(Vec::new()),
        })
    }

    /// Single-flight: a call while another run is in progress returns `Busy`.
    /// Records `last_sync` = `ok` or `error:<message>` either way.
    pub async fn sync_once(&self) -> Result<SyncResult, String> {
        self.sync_at(Utc::now()).await
    }

    /// `sync_once` with the clock started at `started`; later times are
    /// `started` plus elapsed, so a test can pin the EPG window.
    pub(crate) async fn sync_at(&self, started: DateTime<Utc>) -> Result<SyncResult, String> {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(SyncResult::Busy { busy: true });
        }
        let _release = Release(&self.running);
        let t0 = std::time::Instant::now();
        let now = || started + chrono::TimeDelta::from_std(t0.elapsed()).unwrap_or_default();
        let outcome = self.run(started, now).await;
        let finished = now();
        match outcome {
            Ok(mut stats) => {
                put_state(&self.pool, "last_sync", "ok", &iso(finished))
                    .await
                    .map_err(|e| e.to_string())?;
                stats.started_at = iso(started);
                stats.finished_at = iso(finished);
                stats.duration_ms = (finished - started).num_milliseconds();
                Ok(SyncResult::Done(stats))
            }
            Err(e) => {
                if let Err(pe) = put_state(
                    &self.pool,
                    "last_sync",
                    &format!("error:{e}"),
                    &iso(finished),
                )
                .await
                {
                    tracing::warn!("could not record sync error state: {pe}");
                }
                Err(e)
            }
        }
    }

    async fn run(
        &self,
        started: DateTime<Utc>,
        now: impl Fn() -> DateTime<Utc>,
    ) -> Result<SyncStats, String> {
        let fetched_at = &iso(started);
        let x = Client::new(
            Creds::from_config(&self.config)?,
            self.config.iptv_list_timeout_ms,
        )?;

        let (live_cats, vod_cats, series_cats) = tokio::try_join!(
            x.categories(Kind::Live),
            x.categories(Kind::Vod),
            x.categories(Kind::Series)
        )?;
        let (live, vod, series) = tokio::try_join!(
            x.live_streams(fetched_at),
            x.vod_streams(fetched_at),
            x.series_list(fetched_at)
        )?;

        // An all-empty answer is a broken panel, not an empty catalog: reconciling
        // it would wipe everything.
        if [
            live_cats.len(),
            vod_cats.len(),
            series_cats.len(),
            live.len(),
            vod.len(),
            series.len(),
        ]
        .iter()
        .all(|n| *n == 0)
        {
            return Err("xtream_empty_response".into());
        }

        // Episode expansion, 4 at a time to spare the provider. A failed series
        // is logged and skipped, never fatal.
        let cursor = AtomicUsize::new(0);
        let episodes = Mutex::new(Vec::new());
        let worker = || async {
            while let Some(s) = series.get(cursor.fetch_add(1, Ordering::SeqCst)) {
                match x.series_info(s.series_id).await {
                    Ok(eps) => episodes.lock().unwrap().extend(eps),
                    Err(e) => tracing::warn!(series_id = s.series_id, "series_info failed: {e}"),
                }
            }
        };
        tokio::join!(worker(), worker(), worker(), worker());
        let episodes = episodes.into_inner().unwrap();

        let mut tx = self.pool.begin().await.map_err(db_err)?;
        for (kind, cats) in [
            (Kind::Live, &live_cats),
            (Kind::Vod, &vod_cats),
            (Kind::Series, &series_cats),
        ] {
            let rows: Vec<_> = cats
                .iter()
                .map(|c| serde_json::json!({"category_id": c.category_id, "name": c.name, "parent_id": c.parent_id}))
                .collect();
            exec(
                &mut tx,
                UPSERT_CATEGORIES,
                &[json(&rows), kind.as_str().into()],
            )
            .await?;
        }
        exec(
            &mut tx,
            UPSERT_CHANNELS,
            &[json(&live.iter().map(channel_json).collect::<Vec<_>>())],
        )
        .await?;
        exec(
            &mut tx,
            UPSERT_VOD,
            &[json(&vod.iter().map(vod_json).collect::<Vec<_>>())],
        )
        .await?;
        exec(
            &mut tx,
            UPSERT_SERIES,
            &[json(&series.iter().map(series_json).collect::<Vec<_>>())],
        )
        .await?;
        exec(
            &mut tx,
            UPSERT_EPISODES,
            &[json(&episodes.iter().map(episode_json).collect::<Vec<_>>())],
        )
        .await?;

        // Reconcile: what this run did not see is gone. Episodes of a de-listed
        // series go with it (ON DELETE CASCADE). Title links are soft-deleted;
        // the nightly sweep hard-deletes them after 14 days.
        for table in ["channels", "vod", "series"] {
            exec(
                &mut tx,
                &format!("DELETE FROM {table} WHERE fetched_at != ?1"),
                &[fetched_at.into()],
            )
            .await?;
        }
        exec(&mut tx, SOFT_DELETE_LINKS, &[]).await?;
        for (kind, cats) in [
            (Kind::Live, &live_cats),
            (Kind::Vod, &vod_cats),
            (Kind::Series, &series_cats),
        ] {
            let ids: Vec<i64> = cats.iter().map(|c| c.category_id).collect();
            exec(
                &mut tx,
                PRUNE_CATEGORIES,
                &[kind.as_str().into(), json(&ids)],
            )
            .await?;
        }
        // Re-listed titles get their link back (removed_at cleared).
        exec(&mut tx, LINK_TITLES, &[]).await?;
        tx.commit().await.map_err(db_err)?;

        let epg = crate::epg::refresh(&self.pool, &self.config, now()).await?;

        // Planner stats for the guide's channel/time lookups; never fails the sync.
        if let Err(e) = sqlx::query("PRAGMA optimize").execute(&self.pool).await {
            tracing::warn!("pragma optimize failed: {e}");
        }

        Ok(SyncStats {
            channels: live.len(),
            vod: vod.len(),
            series: series.len(),
            episodes: episodes.len(),
            epg,
            categories: live_cats.len() + vod_cats.len() + series_cats.len(),
            duration_ms: 0,
            started_at: String::new(),
            finished_at: String::new(),
        })
    }

    /// Start a background sync and return its job id at once (admin POST
    /// /admin/sync answers 202 with it and the panel polls).
    pub fn start_job(self: &Arc<Self>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        remember(
            &mut self.jobs.lock().unwrap(),
            SyncJob {
                id: id.clone(),
                state: JobState::Running,
                started_at: iso(Utc::now()),
                finished_at: None,
                result: None,
                error: None,
            },
        );
        let this = self.clone();
        let job_id = id.clone();
        tokio::spawn(async move {
            let outcome = this.sync_once().await;
            let mut jobs = this.jobs.lock().unwrap();
            let Some(job) = jobs.iter_mut().find(|j| j.id == job_id) else {
                return;
            };
            job.finished_at = Some(iso(Utc::now()));
            match outcome {
                Ok(r) => {
                    job.state = if matches!(r, SyncResult::Busy { .. }) {
                        JobState::Rejected
                    } else {
                        JobState::Done
                    };
                    job.result = Some(r);
                }
                Err(e) => {
                    job.state = JobState::Error;
                    job.error = Some(e);
                }
            }
        });
        id
    }

    pub fn job(&self, id: &str) -> Option<SyncJob> {
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .find(|j| j.id == id)
            .cloned()
    }
}

/// Keep at most 20 jobs by evicting the oldest finished one. A running job is
/// never evicted (the poller would 404 mid-run); if all are running, nothing
/// goes until they settle.
fn remember(jobs: &mut Vec<SyncJob>, job: SyncJob) {
    jobs.push(job);
    if jobs.len() > MAX_REMEMBERED_JOBS
        && let Some(i) = jobs.iter().position(|j| j.state != JobState::Running)
    {
        jobs.remove(i);
    }
}

pub async fn get_state(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    sqlx::query_as("SELECT value, ts FROM iptv_sync_state WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
}

pub async fn put_state(
    pool: &SqlitePool,
    key: &str,
    value: &str,
    ts: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO iptv_sync_state (key, value, ts) VALUES (?1, ?2, ?3) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
    )
    .bind(key)
    .bind(value)
    .bind(ts)
    .execute(pool)
    .await
    .map(|_| ())
}

fn db_err(e: sqlx::Error) -> String {
    format!("db: {e}")
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("rows serialize")
}

async fn exec(tx: &mut sqlx::SqliteConnection, sql: &str, args: &[String]) -> Result<(), String> {
    // `sql` is one of this module's constants or a table name from a fixed list.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = q.bind(a);
    }
    q.execute(tx).await.map(|_| ()).map_err(db_err)
}

fn channel_json(r: &xtream::ChannelRow) -> serde_json::Value {
    serde_json::json!({
        "stream_id": r.stream_id, "num": r.num, "name": r.name, "stream_icon": r.stream_icon,
        "epg_channel_id": r.epg_channel_id, "category_id": r.category_id, "is_adult": r.is_adult,
        "tv_archive": r.tv_archive, "tv_archive_duration": r.tv_archive_duration,
        "added_ts": r.added_ts, "fetched_at": r.fetched_at,
    })
}
fn vod_json(r: &xtream::VodRow) -> serde_json::Value {
    serde_json::json!({
        "stream_id": r.stream_id, "name": r.name, "stream_icon": r.stream_icon, "rating": r.rating,
        "category_id": r.category_id, "container_extension": r.container_extension, "added_ts": r.added_ts,
        "tmdb_id": r.tmdb_id, "year": r.year, "plot": r.plot, "director": r.director,
        "cast_csv": r.cast_csv, "fetched_at": r.fetched_at,
    })
}
fn series_json(r: &xtream::SeriesRow) -> serde_json::Value {
    serde_json::json!({
        "series_id": r.series_id, "name": r.name, "cover": r.cover, "plot": r.plot, "rating": r.rating,
        "category_id": r.category_id, "tmdb_id": r.tmdb_id, "last_modified": r.last_modified,
        "fetched_at": r.fetched_at,
    })
}
fn episode_json(r: &xtream::EpisodeRow) -> serde_json::Value {
    serde_json::json!({
        "episode_id": r.episode_id, "series_id": r.series_id, "season": r.season,
        "episode_num": r.episode_num, "title": r.title, "container_extension": r.container_extension,
        "added_ts": r.added_ts, "plot": r.plot, "duration_secs": r.duration_secs,
    })
}

// `WHERE true` keeps SQLite from reading the upsert's ON as a join constraint.
const UPSERT_CATEGORIES: &str = "
INSERT INTO categories (category_id, kind, name, parent_id)
SELECT value->>'category_id', ?2, value->>'name', value->>'parent_id' FROM json_each(?1) WHERE true
ON CONFLICT(kind, category_id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id";

const UPSERT_CHANNELS: &str = "
INSERT INTO channels (stream_id, num, name, stream_icon, epg_channel_id, category_id,
  is_adult, tv_archive, tv_archive_duration, added_ts, fetched_at)
SELECT value->>'stream_id', value->>'num', value->>'name', value->>'stream_icon', value->>'epg_channel_id',
  value->>'category_id', value->>'is_adult', value->>'tv_archive', value->>'tv_archive_duration',
  value->>'added_ts', value->>'fetched_at'
FROM json_each(?1) WHERE true
ON CONFLICT(stream_id) DO UPDATE SET
  num=excluded.num, name=excluded.name, stream_icon=excluded.stream_icon,
  epg_channel_id=excluded.epg_channel_id, category_id=excluded.category_id,
  is_adult=excluded.is_adult, tv_archive=excluded.tv_archive,
  tv_archive_duration=excluded.tv_archive_duration, added_ts=excluded.added_ts,
  fetched_at=excluded.fetched_at";

const UPSERT_VOD: &str = "
INSERT INTO vod (stream_id, name, stream_icon, rating, category_id, container_extension,
  added_ts, tmdb_id, year, plot, director, cast_csv, fetched_at)
SELECT value->>'stream_id', value->>'name', value->>'stream_icon', value->>'rating', value->>'category_id',
  value->>'container_extension', value->>'added_ts', value->>'tmdb_id', value->>'year', value->>'plot',
  value->>'director', value->>'cast_csv', value->>'fetched_at'
FROM json_each(?1) WHERE true
ON CONFLICT(stream_id) DO UPDATE SET
  name=excluded.name, stream_icon=excluded.stream_icon, rating=excluded.rating,
  category_id=excluded.category_id, container_extension=excluded.container_extension,
  added_ts=excluded.added_ts, tmdb_id=excluded.tmdb_id, year=excluded.year,
  plot=excluded.plot, director=excluded.director, cast_csv=excluded.cast_csv,
  fetched_at=excluded.fetched_at";

const UPSERT_SERIES: &str = "
INSERT INTO series (series_id, name, cover, plot, rating, category_id, tmdb_id, last_modified, fetched_at)
SELECT value->>'series_id', value->>'name', value->>'cover', value->>'plot', value->>'rating',
  value->>'category_id', value->>'tmdb_id', value->>'last_modified', value->>'fetched_at'
FROM json_each(?1) WHERE true
ON CONFLICT(series_id) DO UPDATE SET
  name=excluded.name, cover=excluded.cover, plot=excluded.plot, rating=excluded.rating,
  category_id=excluded.category_id, tmdb_id=excluded.tmdb_id,
  last_modified=excluded.last_modified, fetched_at=excluded.fetched_at";

const UPSERT_EPISODES: &str = "
INSERT INTO series_episodes (episode_id, series_id, season, episode_num, title,
  container_extension, added_ts, plot, duration_secs)
SELECT value->>'episode_id', value->>'series_id', value->>'season', value->>'episode_num', value->>'title',
  value->>'container_extension', value->>'added_ts', value->>'plot', value->>'duration_secs'
FROM json_each(?1) WHERE true
ON CONFLICT(episode_id) DO UPDATE SET
  series_id=excluded.series_id, season=excluded.season, episode_num=excluded.episode_num,
  title=excluded.title, container_extension=excluded.container_extension,
  added_ts=excluded.added_ts, plot=excluded.plot, duration_secs=excluded.duration_secs";

const SOFT_DELETE_LINKS: &str = "
UPDATE iptv_title_link SET removed_at = datetime('now')
WHERE removed_at IS NULL AND (
  (iptv_kind = 'vod' AND iptv_id NOT IN (SELECT stream_id FROM vod)) OR
  (iptv_kind = 'series' AND iptv_id NOT IN (SELECT series_id FROM series)))";

const PRUNE_CATEGORIES: &str = "DELETE FROM categories WHERE kind = ?1 AND category_id NOT IN (SELECT value FROM json_each(?2))";

const LINK_TITLES: &str = "
INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id)
SELECT 'vod', stream_id, 'movie', tmdb_id FROM vod WHERE tmdb_id IS NOT NULL
UNION ALL
SELECT 'series', series_id, 'tv', tmdb_id FROM series WHERE tmdb_id IS NOT NULL
ON CONFLICT(iptv_kind, iptv_id) DO UPDATE
  SET tmdb_id = excluded.tmdb_id, tmdb_kind = excluded.tmdb_kind, removed_at = NULL";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpanel::Panel;
    use serde_json::json;

    /// The iptvSync.test.ts fixture catalog.
    fn fixture(panel: &Panel) {
        panel.set(
            "get_live_categories",
            json!([{"category_id": 1, "category_name": "News", "parent_id": 0}]),
        );
        panel.set(
            "get_vod_categories",
            json!([{"category_id": 2, "category_name": "Action", "parent_id": 0}]),
        );
        panel.set(
            "get_series_categories",
            json!([{"category_id": 3, "category_name": "Drama", "parent_id": 0}]),
        );
        panel.set(
            "get_live_streams",
            json!([{"stream_id": 10, "num": 1, "name": "C", "epg_channel_id": "c.1",
            "category_id": 1, "is_adult": 0, "tv_archive": 1, "tv_archive_duration": 7}]),
        );
        panel.set(
            "get_vod_streams",
            json!([{"stream_id": 20, "name": "M", "rating": 7, "category_id": 2,
            "container_extension": "mp4", "tmdb_id": 603, "year": 1999}]),
        );
        panel.set(
            "get_series",
            json!([{"series_id": 30, "name": "S", "category_id": 3, "tmdb_id": 1399}]),
        );
        panel.set(
            "get_series_info",
            json!({"episodes": {"1": [{"id": "101", "episode_num": 1, "title": "Pilot",
            "container_extension": "mp4", "info": {"duration_secs": 1200}}]}}),
        );
    }

    async fn setup() -> (Panel, Arc<CatalogSync>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        let panel = Panel::start().await;
        fixture(&panel);
        let sync = CatalogSync::new(pool, Arc::new(panel.config()));
        (panel, sync, dir)
    }

    async fn count(pool: &SqlitePool, sql: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .fetch_one(pool)
            .await
            .unwrap()
    }

    fn done(r: SyncResult) -> SyncStats {
        match r {
            SyncResult::Done(s) => s,
            SyncResult::Busy { .. } => panic!("expected a completed sync"),
        }
    }

    #[tokio::test]
    async fn populates_the_catalog_and_records_last_sync() {
        let (_panel, sync, _dir) = setup().await;
        let s = done(sync.sync_once().await.unwrap());
        assert_eq!(
            (s.channels, s.vod, s.series, s.episodes, s.categories),
            (1, 1, 1, 1, 3)
        );
        let p = &sync.pool;
        let ch: (String, Option<String>, i64, Option<i64>) =
            sqlx::query_as("SELECT name, epg_channel_id, tv_archive, tv_archive_duration FROM channels WHERE stream_id = 10")
                .fetch_one(p)
                .await
                .unwrap();
        assert_eq!(ch, ("C".into(), Some("c.1".into()), 1, Some(7)));
        let ep: (i64, i64, String, Option<i64>) =
            sqlx::query_as("SELECT series_id, season, title, duration_secs FROM series_episodes WHERE episode_id = '101'")
                .fetch_one(p)
                .await
                .unwrap();
        assert_eq!(ep, (30, 1, "Pilot".into(), Some(1200)));
        let links: Vec<(String, i64, String, i64)> = sqlx::query_as(
            "SELECT iptv_kind, iptv_id, tmdb_kind, tmdb_id FROM iptv_title_link ORDER BY iptv_kind",
        )
        .fetch_all(p)
        .await
        .unwrap();
        assert_eq!(
            links,
            vec![
                ("series".into(), 30, "tv".into(), 1399),
                ("vod".into(), 20, "movie".into(), 603)
            ]
        );
        assert_eq!(get_state(p, "last_sync").await.unwrap().unwrap().0, "ok");
    }

    #[tokio::test]
    async fn a_delisted_title_goes_its_link_is_tombstoned_and_its_category_pruned() {
        let (panel, sync, _dir) = setup().await;
        done(sync.sync_once().await.unwrap());

        // fetched_at has millisecond resolution; keep the runs apart.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        panel.set("get_vod_streams", json!([]));
        panel.set("get_vod_categories", json!([]));
        panel.set("get_series", json!([]));
        let s = done(sync.sync_once().await.unwrap());
        assert_eq!((s.channels, s.vod, s.series), (1, 0, 0));
        let p = &sync.pool;
        assert_eq!(count(p, "SELECT COUNT(*) FROM vod").await, 0);
        assert_eq!(count(p, "SELECT COUNT(*) FROM series").await, 0);
        assert_eq!(
            count(p, "SELECT COUNT(*) FROM series_episodes").await,
            0,
            "episodes cascade with their series"
        );
        assert_eq!(count(p, "SELECT COUNT(*) FROM channels").await, 1);
        assert_eq!(
            count(
                p,
                "SELECT COUNT(*) FROM iptv_title_link WHERE removed_at IS NOT NULL"
            )
            .await,
            2
        );
        let kinds: Vec<String> = sqlx::query_scalar("SELECT kind FROM categories ORDER BY kind")
            .fetch_all(p)
            .await
            .unwrap();
        assert_eq!(
            kinds,
            vec!["live", "series"],
            "vod's category is pruned, the others stay"
        );

        // Re-listed: the tombstone is cleared.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        fixture(&panel);
        done(sync.sync_once().await.unwrap());
        assert_eq!(
            count(
                p,
                "SELECT COUNT(*) FROM iptv_title_link WHERE removed_at IS NULL"
            )
            .await,
            2
        );
        assert_eq!(count(p, "SELECT COUNT(*) FROM categories").await, 3);
    }

    #[tokio::test]
    async fn a_non_array_list_fails_the_sync_without_deleting_anything() {
        let (panel, sync, _dir) = setup().await;
        done(sync.sync_once().await.unwrap());
        panel.set("get_vod_streams", json!({"user_info": {"auth": 0}}));
        let err = sync.sync_once().await.unwrap_err();
        assert_eq!(err, "xtream.get_vod_streams_not_a_list");
        let p = &sync.pool;
        assert_eq!(count(p, "SELECT COUNT(*) FROM vod").await, 1);
        assert_eq!(
            count(
                p,
                "SELECT COUNT(*) FROM iptv_title_link WHERE removed_at IS NULL"
            )
            .await,
            2
        );
        let (value, _) = get_state(p, "last_sync").await.unwrap().unwrap();
        assert_eq!(value, "error:xtream.get_vod_streams_not_a_list");
    }

    #[tokio::test]
    async fn an_all_empty_panel_is_an_error_not_an_empty_catalog() {
        let (panel, sync, _dir) = setup().await;
        done(sync.sync_once().await.unwrap());
        for action in [
            "get_live_categories",
            "get_vod_categories",
            "get_series_categories",
            "get_live_streams",
            "get_vod_streams",
            "get_series",
        ] {
            panel.set(action, json!([]));
        }
        assert_eq!(sync.sync_once().await.unwrap_err(), "xtream_empty_response");
        assert_eq!(count(&sync.pool, "SELECT COUNT(*) FROM channels").await, 1);
    }

    #[tokio::test]
    async fn a_failed_series_info_skips_that_series_only() {
        let (panel, sync, _dir) = setup().await;
        panel.set_status("get_series_info", 500);
        let s = done(sync.sync_once().await.unwrap());
        assert_eq!((s.series, s.episodes), (1, 0));
    }

    #[tokio::test]
    async fn overlapping_runs_return_busy() {
        let (_panel, sync, _dir) = setup().await;
        let (a, b) = tokio::join!(sync.sync_once(), sync.sync_once());
        let results = [a.unwrap(), b.unwrap()];
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, SyncResult::Busy { busy: true }))
                .count(),
            1
        );
        let winner = results.into_iter().find_map(|r| match r {
            SyncResult::Done(s) => Some(s),
            SyncResult::Busy { .. } => None,
        });
        assert_eq!(winner.unwrap().channels, 1, "the winner did real work");
        // The guard is released: the next run goes ahead.
        assert!(matches!(
            sync.sync_once().await.unwrap(),
            SyncResult::Done(_)
        ));
    }

    #[tokio::test]
    async fn missing_creds_record_an_error_state() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        let sync = CatalogSync::new(pool, Arc::new(crate::config::test_config(&[])));
        assert_eq!(
            sync.sync_once().await.unwrap_err(),
            "xtream_credentials_missing"
        );
        let (value, _) = get_state(&sync.pool, "last_sync").await.unwrap().unwrap();
        assert_eq!(value, "error:xtream_credentials_missing");
    }

    fn json_fixture(name: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The scenario in tests/fixtures/epg-sync-scenario.json (panel catalog,
    /// provider XMLTV, a plain and a gzipped external feed, two syncs) leaves
    /// epg_programs and epg_resolved_id exactly as the TS sync did
    /// (epg-goldens.json, from gen-epg-goldens.ts).
    #[tokio::test]
    async fn a_full_mock_sync_matches_the_ts_goldens() {
        let scenario = json_fixture("epg-sync-scenario.json");
        let golden = json_fixture("epg-goldens.json");
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        let panel = Panel::start().await;
        panel.set("get_live_categories", scenario["live_categories"].clone());
        panel.set("get_live_streams", scenario["live_streams"].clone());
        let paths: Vec<&str> = scenario["external_paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        let urls: Vec<String> = paths.iter().map(|p| panel.url(p)).collect();
        let config = crate::config::test_config(&[
            ("XTREAM_HOST", &panel.base),
            ("XTREAM_USERNAME", "u"),
            ("XTREAM_PASSWORD", "p"),
            ("IPTV_EXTERNAL_EPG_URLS", &urls.join(",")),
        ]);
        let sync = CatalogSync::new(pool, Arc::new(config));
        let now: DateTime<Utc> = scenario["now"].as_str().unwrap().parse().unwrap();
        for (i, step) in scenario["syncs"].as_array().unwrap().iter().enumerate() {
            panel.set_feed("/xmltv.php", step["provider_xml"].as_str().unwrap());
            for path in &paths {
                let xml = step["external"][*path].as_str().unwrap();
                if path.ends_with(".gz") {
                    let mut e =
                        flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                    std::io::Write::write_all(&mut e, xml.as_bytes()).unwrap();
                    panel.set_feed(path, e.finish().unwrap());
                } else {
                    panel.set_feed(path, xml);
                }
            }
            let stats = done(sync.sync_at(now).await.unwrap());
            let want = &golden["syncs"][i];
            assert_eq!(
                stats.epg as u64,
                want["epg"].as_u64().unwrap(),
                "sync {i} epg count"
            );
            for (sql, key) in [
                (
                    "SELECT json_group_array(json_object('channel_id', channel_id, 'start_utc', start_utc,
                       'stop_utc', stop_utc, 'title', title, 'description', description, 'derived', derived))
                     FROM (SELECT * FROM epg_programs ORDER BY channel_id, start_utc)",
                    "epg_programs",
                ),
                (
                    "SELECT json_group_array(json_object('stream_id', stream_id, 'epg_resolved_id', epg_resolved_id))
                     FROM (SELECT * FROM channels ORDER BY stream_id)",
                    "channels",
                ),
            ] {
                let text: String = sqlx::query_scalar(sql).fetch_one(&sync.pool).await.unwrap();
                let got: serde_json::Value = serde_json::from_str(&text).unwrap();
                assert_eq!(got, want[key], "sync {i} {key}");
            }
        }
    }

    async fn settle(sync: &CatalogSync, id: &str) -> SyncJob {
        for _ in 0..200 {
            let j = sync.job(id).unwrap();
            if j.state != JobState::Running {
                return j;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("job {id} never settled");
    }

    #[tokio::test]
    async fn jobs_report_done_rejected_and_error() {
        let (panel, sync, _dir) = setup().await;
        let first = sync.start_job();
        let second = sync.start_job();
        let (a, b) = (settle(&sync, &first).await, settle(&sync, &second).await);
        assert_eq!((a.state, b.state), (JobState::Done, JobState::Rejected));
        let body = serde_json::to_value(&a).unwrap();
        assert_eq!(body["result"]["channels"], 1);
        assert!(body["result"]["durationMs"].is_i64() && body["finishedAt"].is_string());
        assert_eq!(
            serde_json::to_value(&b).unwrap()["result"],
            json!({"busy": true})
        );

        panel.set("get_series", json!("oops"));
        let failed = settle(&sync, &sync.start_job()).await;
        assert_eq!(
            (failed.state, failed.error.as_deref()),
            (JobState::Error, Some("xtream.get_series_not_a_list"))
        );
        assert!(sync.job("nope").is_none());
    }

    #[test]
    fn job_table_evicts_the_oldest_finished_job_never_a_running_one() {
        let job = |id: usize, state| SyncJob {
            id: id.to_string(),
            state,
            started_at: String::new(),
            finished_at: None,
            result: None,
            error: None,
        };
        let mut jobs = Vec::new();
        remember(&mut jobs, job(0, JobState::Running));
        for i in 1..=21 {
            remember(&mut jobs, job(i, JobState::Done));
        }
        assert_eq!(jobs.len(), 20);
        let ids: Vec<&str> = jobs.iter().map(|j| j.id.as_str()).collect();
        assert_eq!(ids[0], "0", "the running job survives the cap");
        assert!(
            !ids.contains(&"1") && !ids.contains(&"2"),
            "the oldest finished jobs went instead"
        );

        let mut all_running: Vec<SyncJob> = (0..21).map(|i| job(i, JobState::Running)).collect();
        all_running.pop();
        remember(&mut all_running, job(99, JobState::Running));
        assert_eq!(
            all_running.len(),
            21,
            "nothing is evicted while every job is running"
        );
    }
}
