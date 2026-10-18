//! Idle feed checks (iptvFeedSweep.ts): while nobody is streaming, check every
//! channel the household's guide shows (plus recently watched and favorite
//! channels) before anyone tunes it, so a stream carrying the wrong channel is
//! caught ahead of time instead of in a viewer's first seconds on it.
//!
//! The guide's channel set is what the app last asked /epg/grid for
//! (`catalog::remember_guide_scope`). Each channel is checked once per verdict
//! lifetime: never-checked and re-listed channels first, then the longest
//! unchecked, watched/favorite before guide order on a tie. A run checks
//! channels back to back with a gap after each one that dialed, and stops the
//! moment a viewer or recording needs the provider. Runs happen only in the
//! overnight window (IPTV_FEED_SWEEP_HOURS_UTC) and only after 30 minutes with
//! no viewer: a gap between two channel hops is not idle.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use chrono::{DateTime, Timelike};
use regex::Regex;
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::catalog::LISTED_EPG;
use crate::config::Config;
use crate::feed_checks::{FeedCheck, NO_SIBLING_REASON, feed_check_is_fresh, iso_ms};
use crate::feed_verify::{FeedIo, LiveIo, Outcome, Scheduler, Wanted, check_feed_standalone};
use crate::remux::Remux;
use crate::streams::Streams;
use crate::xtream::Creds;

const HISTORY_DAYS: i64 = 30;
const GUIDE_SCOPE_KEY: &str = "feed_check_guide_scope";
/// Keep clear of a recording about to start: it would preempt a capture anyway.
const DVR_LEAD_MS: i64 = 3 * 60_000;
/// Quiet time after the last viewer activity before the sweep dials. Hopping
/// channels leaves moments with nothing streaming; a sweep starting in them
/// adds connections the provider punishes.
pub const VIEWER_QUIET: Duration = Duration::from_secs(30 * 60);
/// Checks per run, and the wait after each one that dialed.
const MAX_CHECKS: usize = 30;
const GAP_MS: u64 = 20_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuideScope {
    category_ids: Vec<i64>,
    limit: i64,
    /// Only channels with a schedule. Apple clients from 2026-10-15 keep
    /// unscheduled channels as "No guide data" rows. A scope stored before the
    /// flag existed was a hasEpg request.
    has_epg: Option<bool>,
}

async fn guide_scope(pool: &SqlitePool) -> Result<Option<GuideScope>, sqlx::Error> {
    let row = crate::sync::get_state(pool, GUIDE_SCOPE_KEY).await?;
    Ok(row
        .and_then(|(v, _)| serde_json::from_str::<GuideScope>(&v).ok())
        .filter(|s| !s.category_ids.is_empty()))
}

/// Live channels in sweep order: watched in the last HISTORY_DAYS or favorited
/// (most recent first), then the guide's channels in guide order.
async fn sweep_order(pool: &SqlitePool, now: i64) -> Result<Vec<i64>, sqlx::Error> {
    let watched: Vec<String> = sqlx::query_scalar(
        "SELECT item_id FROM ( \
           SELECT item_id, watched_at AS ts FROM iptv_watch_history WHERE kind = 'live' AND watched_at >= ? \
           UNION ALL \
           SELECT item_id, added_ts AS ts FROM iptv_favorites WHERE kind = 'live' \
         ) GROUP BY item_id ORDER BY MAX(ts) DESC LIMIT 200",
    )
    .bind(iso_ms(now - HISTORY_DAYS * 24 * 3_600_000))
    .fetch_all(pool)
    .await?;
    let mut out: Vec<i64> = watched
        .iter()
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|id| id.parse().ok())
        .collect();
    if let Some(scope) = guide_scope(pool).await? {
        let has_epg = scope.has_epg != Some(false);
        let epg_clause = if has_epg {
            format!(
                "AND EXISTS (SELECT 1 FROM epg_programs p WHERE p.channel_id = {LISTED_EPG} AND p.stop_utc > ?)"
            )
        } else {
            String::new()
        };
        let sql = format!(
            "SELECT stream_id FROM channels WHERE category_id IN (SELECT value FROM json_each(?)) {epg_clause} \
             ORDER BY num, name, stream_id LIMIT ?"
        );
        let mut q = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
            .bind(serde_json::to_string(&scope.category_ids).unwrap_or_default());
        if has_epg {
            q = q.bind(iso_ms(now));
        }
        out.extend(q.bind(scope.limit).fetch_all(pool).await?);
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|id| seen.insert(*id));
    Ok(out)
}

/// The next channel due a check (no fresh verdict for its current listing): a
/// never-checked or re-listed one first, then the one checked longest ago, in
/// sweep order on a tie. None when every one is fresh.
pub async fn next_sweep_channel(pool: &SqlitePool, now: i64) -> Result<Option<i64>, sqlx::Error> {
    let sql = format!(
        "SELECT stream_id, {LISTED_EPG} FROM channels WHERE COALESCE({LISTED_EPG}, '') != ''"
    );
    let listed: HashMap<i64, String> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
    let checks: HashMap<i64, FeedCheck> =
        sqlx::query_as::<_, FeedCheck>("SELECT * FROM channel_feed_checks")
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|c| (c.stream_id, c))
            .collect();
    let mut best: Option<(i64, &str)> = None;
    for id in sweep_order(pool, now).await? {
        let Some(epg) = listed.get(&id) else { continue };
        let check = checks.get(&id);
        if check.is_some_and(|c| feed_check_is_fresh(c, Some(epg), now)) {
            continue;
        }
        // Nothing is known about what the guide shows on it now: '' sorts first.
        let key = match check {
            Some(c) if c.listed_epg_id.as_deref() == Some(epg) => c.checked_at.as_str(),
            _ => "",
        };
        if best.is_none_or(|(_, k)| key < k) {
            best = Some((id, key));
        }
    }
    Ok(best.map(|(id, _)| id))
}

async fn recording_starts_soon(pool: &SqlitePool, now: i64) -> Result<bool, sqlx::Error> {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM dvr_recordings WHERE status IN ('scheduled', 'recording') AND start_utc <= ? AND stop_utc > ? LIMIT 1",
    )
    .bind(iso_ms(now + DVR_LEAD_MS))
    .bind(iso_ms(now))
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

static WINDOW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*([0-9]{1,2})\s*-\s*([0-9]{1,2})\s*$").unwrap());

/// True when `now` falls in a "start-end" UTC hour window (end exclusive,
/// wrapping midnight when start > end). A malformed window is closed.
pub fn sweep_window_open(now: i64, hours: &str) -> bool {
    let Some(m) = WINDOW.captures(hours) else {
        return false;
    };
    let (start, end): (u32, u32) = (m[1].parse().unwrap_or(99), m[2].parse().unwrap_or(99));
    if start > 23 || end > 24 || start == end {
        return false;
    }
    let hour = DateTime::from_timestamp_millis(now)
        .unwrap_or_default()
        .hour();
    if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end
    }
}

/// Inside the sweep window, nothing streaming or recording, no viewer for
/// VIEWER_QUIET, and no recording about to start.
pub async fn sweep_idle(pool: &SqlitePool, remux: &Remux, hours: &str, now: i64) -> bool {
    if remux.viewer_upstream_count() > 0 {
        remux.note_activity();
    }
    if remux.live_upstream_count() > 0
        || remux.last_viewer_activity().elapsed() < VIEWER_QUIET
        || !sweep_window_open(now, hours)
    {
        return false;
    }
    match recording_starts_soon(pool, now).await {
        Ok(soon) => !soon,
        Err(e) => {
            tracing::warn!(error = %e, "feed check sweep: dvr read failed");
            false
        }
    }
}

/// Check due channels back to back while idle: up to `max_checks`, `gap_ms`
/// apart. Returns how many checks ran.
pub async fn run_sweep<I: FeedIo>(
    pool: &SqlitePool,
    sched: &Scheduler,
    io: &I,
    idle: &Wanted<'_>,
    max_checks: usize,
    gap_ms: u64,
) -> Result<usize, sqlx::Error> {
    let mut ran = 0;
    while ran < max_checks {
        if !idle().await {
            break;
        }
        let Some(stream_id) = next_sweep_channel(pool, io.now_ms()).await? else {
            break;
        };
        tracing::info!(stream_id, "idle feed check");
        let outcome = sched
            .run_exclusive(check_feed_standalone(io, pool, stream_id, idle))
            .await
            .transpose()?;
        match outcome {
            // An on-tune check holds the slot, or a viewer arrived: stop until next run.
            None | Some(Outcome::Aborted { .. }) => break,
            // A stream with nothing to compare opened no connection: no gap needed.
            Some(Outcome::Unknown { reason, .. }) if reason == NO_SIBLING_REASON => {}
            Some(_) => io.sleep(gap_ms).await,
        }
        ran += 1;
    }
    Ok(ran)
}

/// The sweep runs with feed checks on and the provider configured (the TS
/// registered it with the catalog sync's cron).
pub fn enabled(config: &Config) -> bool {
    config.iptv_feed_check && config.sync_enabled()
}

/// Every minute, one sweep run (at most one at a time).
pub fn spawn(pool: SqlitePool, streams: Arc<Streams>, config: Arc<Config>) -> JoinHandle<()> {
    let cron = crate::scheduler::parse_cron("* * * * *").expect("minute cron parses");
    tokio::spawn(crate::scheduler::every(cron, move || {
        let (pool, streams, config) = (pool.clone(), streams.clone(), config.clone());
        async move {
            let Ok(creds) = Creds::from_config(&config) else {
                return;
            };
            let remux = streams.live.remux.clone();
            let io = LiveIo::new(remux.clone(), streams.dead.clone(), &creds);
            let hours = config.iptv_feed_sweep_hours_utc.clone();
            let idle = || -> crate::feed_verify::BoxFuture<'_, bool> {
                Box::pin(sweep_idle(
                    &pool,
                    &remux,
                    &hours,
                    chrono::Utc::now().timestamp_millis(),
                ))
            };
            if let Err(e) = run_sweep(&pool, &streams.feed, &io, &idle, MAX_CHECKS, GAP_MS).await {
                tracing::error!(error = %e, "feed check sweep failed");
            }
        }
    }))
}

#[cfg(test)]
mod tests;
