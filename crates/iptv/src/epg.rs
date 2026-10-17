//! EPG ingest (iptvEpg.ts, iptvEpgExternal.ts and the EPG half of syncOnce):
//! the provider XMLTV, West feeds derived from East, channel resolution and
//! the third-party feeds layered under the provider's.
//!
//! Every stored timestamp is `toISOString` form (YYYY-MM-DDTHH:MM:SS.mmmZ):
//! the window checks and the guide queries compare them as strings.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::Serialize;
use sqlx::SqlitePool;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::Sqlite;

use crate::config::Config;
use crate::epg_resolve::{
    CatalogChannel, EpgNameIndex, build_epg_name_index, callsign_ids, catalog_tvg_index, epg_id,
    resolve_epg_id,
};
use crate::xmltv::{Batch, ChannelDef, Parser, Programme};
use crate::xtream::{iso, send_guarded};

const EPG_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const EPG_WALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const EXTERNAL_TIMEOUT: Duration = Duration::from_secs(8 * 60);
const STALE: chrono::TimeDelta = chrono::TimeDelta::hours(24);
const HORIZON: chrono::TimeDelta = chrono::TimeDelta::days(7);
const WEST_DELAY: chrono::TimeDelta = chrono::TimeDelta::hours(3);
// Bytes handed to the parser per push, about what a Node stream chunk was.
const PUSH_BYTES: usize = 64 * 1024;
const STAGE_BATCH: usize = 1_000;

fn db_err(e: sqlx::Error) -> String {
    format!("db: {e}")
}

/// A client for feed downloads: no total timeout (the provider feed is 150 MB
/// and takes minutes; callers bound it) and no redirect following, since
/// `send_guarded` checks each hop.
fn feed_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.without_url().to_string())
}

/// An XMLTV body parsed as it downloads (plain or gzip, sniffed by the
/// parser). Each batch carries channel defs first, then programmes, so a
/// caller that waits for the first programmes has every def before them.
pub struct Feed {
    res: reqwest::Response,
    parser: Option<Parser>,
    idle: Option<Duration>,
    pending: Option<Batch>,
    done: bool,
}

impl Feed {
    fn new(res: reqwest::Response, idle: Option<Duration>) -> Self {
        Feed {
            res,
            parser: Some(Parser::new(true)),
            idle,
            pending: None,
            done: false,
        }
    }

    pub async fn next(&mut self) -> Result<Option<Batch>, String> {
        if let Some(b) = self.pending.take() {
            return Ok(Some(b));
        }
        if self.done {
            return Ok(None);
        }
        let mut buf = Vec::new();
        let mut eof = false;
        while buf.len() < PUSH_BYTES {
            let chunk = match self.idle {
                Some(idle) => tokio::time::timeout(idle, self.res.chunk())
                    .await
                    .map_err(|_| "epg_idle_timeout".to_string())?,
                None => self.res.chunk().await,
            };
            match chunk.map_err(|e| e.without_url().to_string())? {
                Some(c) => buf.extend_from_slice(&c),
                None => {
                    eof = true;
                    break;
                }
            }
        }
        // Parsing is CPU work (gunzip, XML, up to 4 threads per 8 MB): keep it
        // off the async workers.
        let mut parser = self
            .parser
            .take()
            .expect("parser is put back after every push");
        let (parser, out) = tokio::task::spawn_blocking(move || {
            let out = parser.push(&buf).and_then(|first| {
                let last = if eof { Some(parser.finish()?) } else { None };
                Ok((first, last))
            });
            (parser, out)
        })
        .await
        .map_err(|e| format!("xmltv_parse_task: {e}"))?;
        self.parser = Some(parser);
        self.done = eof;
        let (first, last) = out?;
        self.pending = last;
        Ok(Some(first))
    }

    /// From now on the parser emits only these channels' programmes.
    pub fn keep_channels(&mut self, ids: impl IntoIterator<Item = String>) {
        if let Some(p) = self.parser.as_mut() {
            p.keep_channels(ids);
        }
    }
}

static PLACEHOLDER_FOLD: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^a-z0-9]+").unwrap());

// 2026-10-15: feeds fill slots they have no listing for with filler titles.
// fox.us carried nothing but "No Match Today" and "SIGN OFF", so 11 Fox locals
// resolved to it and their guide rows said "No Match Today" all day. Filler is
// not stored, so an id with only filler has no EPG and resolution looks
// elsewhere.
// ponytail: exact titles seen in the 2026-10-15 snapshot (case and punctuation
// folded); a new filler wording shows until it is added here. Not "Unknown":
// every such row in the snapshot was the 2011 or 2006 film.
const PLACEHOLDER_TITLES: [&str; 14] = [
    "no match today",
    "sign off",
    "signing off",
    "to be announced",
    "movie to be announced",
    "tba",
    "tbd",
    "channel off air",
    "off air",
    "no data",
    "no event today",
    "channel no longer available",
    "programming will resume shortly",
    "end of transmission",
];

pub fn is_placeholder_title(title: Option<&str>) -> bool {
    title.is_some_and(|t| {
        let lower = t.to_lowercase();
        PLACEHOLDER_TITLES.contains(&PLACEHOLDER_FOLD.replace_all(&lower, " ").trim())
    })
}

#[derive(Debug)]
pub struct Staged {
    pub ids: HashSet<String>,
    pub replaced: usize,
    pub placeholders: usize,
}

/// One feed's programmes, staged in a temp table and committed in one
/// transaction as each delivered id's schedule from its first delivered start
/// on. 2026-10-15: upserting by (channel, start) left a programme whose start
/// moved next to its replacement (47 guide rows stacked or interleaved). A
/// failed fetch never commits, so it changes nothing, and an id the feed did
/// not deliver keeps its rows. An id that delivered only filler is cleared.
pub struct Stage {
    conn: PoolConnection<Sqlite>,
    first_start: HashMap<String, String>,
    ids: HashSet<String>,
    placeholders: usize,
    batch: Vec<Programme>,
}

impl Stage {
    pub async fn new(pool: &SqlitePool) -> Result<Self, String> {
        // A temp table lives on one connection. Closed after use, so a stage
        // that never commits takes its table with it.
        let mut conn = pool.acquire().await.map_err(db_err)?;
        conn.close_on_drop();
        sqlx::raw_sql(
            "DROP TABLE IF EXISTS temp.epg_stage;
             CREATE TEMP TABLE epg_stage (channel_id TEXT NOT NULL, start_utc TEXT NOT NULL,
               stop_utc TEXT NOT NULL, title TEXT, description TEXT, PRIMARY KEY (channel_id, start_utc))",
        )
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
        Ok(Stage {
            conn,
            first_start: HashMap::new(),
            ids: HashSet::new(),
            placeholders: 0,
            batch: Vec::new(),
        })
    }

    /// Stage one row; false for filler, which only moves the first start.
    pub async fn add(&mut self, row: Programme) -> Result<bool, String> {
        match self.first_start.get(&row.channel_id) {
            Some(first) if *first <= row.start_utc => {}
            _ => {
                self.first_start
                    .insert(row.channel_id.clone(), row.start_utc.clone());
            }
        }
        if is_placeholder_title(row.title.as_deref()) {
            self.placeholders += 1;
            return Ok(false);
        }
        self.ids.insert(row.channel_id.clone());
        self.batch.push(row);
        if self.batch.len() >= STAGE_BATCH {
            self.flush().await?;
        }
        Ok(true)
    }

    async fn flush(&mut self) -> Result<(), String> {
        if self.batch.is_empty() {
            return Ok(());
        }
        let rows = serde_json::to_string(&self.batch).expect("rows serialize");
        self.batch.clear();
        sqlx::query(
            "INSERT OR REPLACE INTO temp.epg_stage (channel_id, start_utc, stop_utc, title, description)
             SELECT value->>'channel_id', value->>'start_utc', value->>'stop_utc', value->>'title',
               value->>'description' FROM json_each(?1)",
        )
        .bind(rows)
        .execute(&mut *self.conn)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    pub async fn commit(mut self) -> Result<Staged, String> {
        self.flush().await?;
        let firsts: Vec<(&String, &String)> = self.first_start.iter().collect();
        let mut tx = sqlx::Connection::begin(&mut *self.conn)
            .await
            .map_err(db_err)?;
        // Rows that end after the first delivered start, so a stored programme
        // airing then does not overlap the delivered one that replaces it.
        sqlx::query(
            "DELETE FROM epg_programs WHERE rowid IN (SELECT p.rowid FROM json_each(?1) j
               JOIN epg_programs p ON p.channel_id = j.value->>0 AND p.stop_utc > j.value->>1)",
        )
        .bind(serde_json::to_string(&firsts).expect("ids serialize"))
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        sqlx::raw_sql(
            "INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title, description)
               SELECT channel_id, start_utc, stop_utc, title, description FROM temp.epg_stage;
             DROP TABLE temp.epg_stage",
        )
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        tx.commit().await.map_err(db_err)?;
        Ok(Staged {
            replaced: self.first_start.len(),
            ids: self.ids,
            placeholders: self.placeholders,
        })
    }
}

/// Fetch the provider's XMLTV (creds in the query, so errors never carry the
/// URL) and open it as a feed. The panel is trusted; a redirect it answers
/// with is re-checked by the SSRF guard.
async fn provider_feed(cfg: &Config, http: &reqwest::Client) -> Result<Feed, String> {
    let creds = crate::xtream::Creds::from_config(cfg)?;
    let path = if cfg.iptv_epg_path.starts_with('/') {
        cfg.iptv_epg_path.clone()
    } else {
        format!("/{}", cfg.iptv_epg_path)
    };
    let mut url = reqwest::Url::parse(&format!("{}{path}", creds.host))
        .map_err(|_| "xtream_bad_host".to_string())?;
    url.query_pairs_mut()
        .append_pair("username", &creds.username)
        .append_pair("password", &creds.password);
    let idle = EPG_IDLE_TIMEOUT.max(Duration::from_millis(cfg.iptv_list_timeout_ms));
    let res = tokio::time::timeout(idle, send_guarded(http, url, "xtream.xmltv"))
        .await
        .map_err(|_| "epg_idle_timeout".to_string())??;
    if !res.status().is_success() {
        return Err(format!("xtream.xmltv_{}", res.status().as_u16()));
    }
    Ok(Feed::new(res, Some(idle)))
}

/// The ISO bounds of what is stored: stop within (now - 24h, now + 7d].
fn window(now: DateTime<Utc>) -> (String, String) {
    (iso(now - STALE), iso(now + HORIZON))
}

/// Stage and commit the provider feed's in-window programmes; returns the
/// commit, its `<channel>` defs and the stored-row count.
async fn ingest_provider(
    pool: &SqlitePool,
    cfg: &Config,
    now: DateTime<Utc>,
) -> Result<(Staged, Vec<ChannelDef>, usize), String> {
    let (cutoff, horizon) = window(now);
    let http = feed_client()?;
    let mut feed = provider_feed(cfg, &http).await?;
    let mut stage = Stage::new(pool).await?;
    let mut defs = Vec::new();
    let mut stored = 0;
    while let Some(batch) = feed.next().await? {
        defs.extend(batch.channels);
        for row in batch.programmes {
            if row.stop_utc < cutoff || row.stop_utc > horizon {
                continue;
            }
            if stage.add(row).await? {
                stored += 1;
            }
        }
    }
    Ok((stage.commit().await?, defs, stored))
}

/// `^(.+?)(?<!south|mid|north)west\.us$`: the East stem of a US West feed id.
/// Southwest/Midwest/Northwest are regional networks, not a coast feed.
fn west_stem(id: &str) -> Option<&str> {
    id.strip_suffix("west.us").filter(|stem| {
        !(stem.is_empty()
            || stem.ends_with("south")
            || stem.ends_with("mid")
            || stem.ends_with("north"))
    })
}

#[derive(Debug, PartialEq)]
pub struct WestFeeds {
    pub channels: u64,
    pub programmes: u64,
    /// West ids that have a schedule, derived or their own.
    pub ids: Vec<String>,
}

/// Give every catalog "<x>west.us" guide id the East schedule three hours
/// later when the provider feed did not deliver it (US West feeds replay East
/// on Pacific time all year). 2026-10-14 "US: Showtime" carried Showtime West
/// and the guide had none to compare it against. Copies are `derived = 1` and
/// each run replaces its earlier ones; a West id with a real listing in the
/// copies' window is left alone. Runs after provider ingest, before resolution.
pub async fn derive_west_feed_epg(
    pool: &SqlitePool,
    fed: &HashSet<String>,
) -> Result<WestFeeds, String> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    let ids: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT epg_channel_id AS id FROM channels
         UNION SELECT NULLIF(COALESCE(channels.epg_resolved_id, channels.epg_channel_id), '') FROM channels",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    let mut out = WestFeeds {
        channels: 0,
        programmes: 0,
        ids: Vec::new(),
    };
    type Row = (String, String, Option<String>, Option<String>);
    for id in ids.into_iter().flatten() {
        let Some(stem) = west_stem(&id) else { continue };
        if fed.contains(&id) {
            continue;
        }
        let mut east: Vec<Row> = Vec::new();
        for e in [format!("{stem}.us"), format!("{stem}east.us")] {
            east = sqlx::query_as(
                "SELECT start_utc, stop_utc, title, description FROM epg_programs WHERE channel_id = ?",
            )
            .bind(&e)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_err)?;
            if !east.is_empty() {
                break;
            }
        }
        if east.is_empty() {
            continue;
        }
        let later = |s: &str| {
            DateTime::parse_from_rfc3339(s)
                .map(|d| iso(d.with_timezone(&Utc) + WEST_DELAY))
                .map_err(|_| format!("epg_bad_time:{s}"))
        };
        let mut copies = Vec::with_capacity(east.len());
        for (start, stop, title, description) in east {
            copies.push((later(&start)?, later(&stop)?, title, description));
        }
        let first_copy = copies
            .iter()
            .map(|c| &c.0)
            .min()
            .cloned()
            .unwrap_or_default();
        out.ids.push(id.clone());
        // Copies outlive their East source by three hours at the stale cutoff,
        // so only rows running in the East window count, and only those go.
        let own: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM epg_programs WHERE channel_id = ? AND derived = 0 AND stop_utc > ? LIMIT 1",
        )
        .bind(&id)
        .bind(&first_copy)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;
        if own.is_some() {
            continue;
        }
        sqlx::query(
            "DELETE FROM epg_programs WHERE channel_id = ? AND derived = 1 AND stop_utc > ?",
        )
        .bind(&id)
        .bind(&first_copy)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        for (start, stop, title, description) in copies {
            out.programmes += sqlx::query(
                "INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title, description, derived)
                 VALUES (?, ?, ?, ?, ?, 1)",
            )
            .bind(&id)
            .bind(start)
            .bind(stop)
            .bind(title)
            .bind(description)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?
            .rows_affected();
        }
        out.channels += 1;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(out)
}

async fn catalog(
    pool: &SqlitePool,
    sql: &'static str,
) -> Result<Vec<(i64, CatalogChannel)>, String> {
    let rows: Vec<(i64, String, Option<String>)> =
        sqlx::query_as(sql).fetch_all(pool).await.map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(|(id, name, epg_channel_id)| {
            (
                id,
                CatalogChannel {
                    name,
                    epg_channel_id,
                },
            )
        })
        .collect())
}

const SET_RESOLVED: &str = "UPDATE channels SET epg_resolved_id = j.value->>1
  FROM json_each(?1) j WHERE channels.stream_id = j.value->>0";
const SET_UNRESOLVED: &str = "UPDATE channels SET epg_resolved_id = j.value->>1
  FROM json_each(?1) j WHERE channels.stream_id = j.value->>0
    AND COALESCE(NULLIF(TRIM(channels.epg_resolved_id), ''), '') = ''";

/// Recompute every channel's epg_resolved_id from the feed's alias defs and
/// the ids with programmes (callsign, tvg-id, a same-named stream's tvg-id,
/// then name). A refused provider tag is stored as '' so the guide does not
/// fall back to it.
pub async fn resolve_epg_channels(
    pool: &SqlitePool,
    defs: &[ChannelDef],
    feed_with_epg: HashSet<String>,
) -> Result<(), String> {
    let mut index = build_epg_name_index(defs, feed_with_epg);
    let channels = catalog(pool, "SELECT stream_id, name, epg_channel_id FROM channels").await?;
    let plain: Vec<CatalogChannel> = channels.iter().map(|(_, c)| c.clone()).collect();
    index.catalog_tvg = catalog_tvg_index(&plain, &index.feed_with_epg);
    index.last_stop = sqlx::query_as::<_, (String, String)>(
        "SELECT channel_id, MAX(stop_utc) FROM epg_programs GROUP BY channel_id",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?
    .into_iter()
    .collect();
    let rows: Vec<(i64, Option<String>)> = channels
        .iter()
        .map(|(id, ch)| (*id, resolve_epg_id(ch, &index)))
        .collect();
    sqlx::query(SET_RESOLVED)
        .bind(serde_json::to_string(&rows).expect("rows serialize"))
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalResult {
    pub url: String,
    pub ok: bool,
    pub channels_matched: u64,
    pub programmes_stored: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids_replaced: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholders_dropped: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Match {
    stream_id: i64,
    id: String,
    /// Set when the station has several callsign ids, to pick again once
    /// their schedules are known.
    station: Option<CatalogChannel>,
}

const UNRESOLVED: &str = "SELECT stream_id, name, epg_channel_id FROM channels
  WHERE COALESCE(NULLIF(TRIM(epg_resolved_id), ''), '') = ''";

/// Resolve every still-unresolved catalog channel against the external feed's
/// aliases: the tentative matches and the ids worth keeping programmes for.
/// Only channels the provider left unresolved are touched (the provider wins).
async fn resolve_against_external(
    pool: &SqlitePool,
    defs: &[ChannelDef],
) -> Result<(HashSet<String>, Vec<Match>), String> {
    let feed_ids = defs.iter().filter_map(|d| epg_id(Some(&d.id))).collect();
    let index = build_epg_name_index(defs, feed_ids);
    let mut wanted = HashSet::new();
    let mut matches = Vec::new();
    for (stream_id, ch) in catalog(pool, UNRESOLVED).await? {
        let Some(id) = resolve_epg_id(&ch, &index).filter(|id| !id.is_empty()) else {
            continue;
        };
        // Which of a station's ids (wesh-dt, wesh-ld) has programmes is not
        // known until they stream in, so keep them all and pick after.
        let ids = callsign_ids(&ch, &index);
        wanted.insert(id.clone());
        let several = ids.len() > 1;
        wanted.extend(ids);
        matches.push(Match {
            stream_id,
            id,
            station: several.then_some(ch),
        });
    }
    Ok((wanted, matches))
}

/// Ingest one third-party XMLTV feed. Stores programmes only for channels the
/// catalog still needs, which keeps epg_programs at ~8k of its 28k channels.
/// `fed` holds ids an earlier feed delivered this sync (the provider first):
/// their schedules stay as delivered, and this feed's stored ids join it.
/// `west` holds the West ids derive_west_feed_epg covers: already resolved, so
/// name matching never asks for them, but a real West schedule beats the copy.
pub async fn ingest_external_epg(
    pool: &SqlitePool,
    url: &str,
    now: DateTime<Utc>,
    fed: &mut HashSet<String>,
    west: &HashSet<String>,
) -> ExternalResult {
    let failed = |error: String| ExternalResult {
        url: url.to_string(),
        ok: false,
        channels_matched: 0,
        programmes_stored: 0,
        ids_replaced: None,
        placeholders_dropped: None,
        error: Some(error),
    };
    match tokio::time::timeout(EXTERNAL_TIMEOUT, ingest_external(pool, url, now, fed, west)).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => failed(e),
        Err(_) => failed("external_epg_timeout".into()),
    }
}

async fn ingest_external(
    pool: &SqlitePool,
    url: &str,
    now: DateTime<Utc>,
    fed: &mut HashSet<String>,
    west: &HashSet<String>,
) -> Result<ExternalResult, String> {
    let (cutoff, horizon) = window(now);
    let parsed = reqwest::Url::parse(url).map_err(|_| "external_epg_bad_url".to_string())?;
    // The URL is operator-configured; the aggregator's 30x is not, so every
    // redirect target is re-checked before it is dialed.
    let res = send_guarded(&feed_client()?, parsed, "external_epg").await?;
    if !res.status().is_success() {
        return Err(format!("http_{}", res.status().as_u16()));
    }
    let mut feed = Feed::new(res, None);
    let mut stage = Stage::new(pool).await?;
    let mut defs: Vec<ChannelDef> = Vec::new();
    let mut candidates: Option<(HashSet<String>, Vec<Match>)> = None;
    let mut stored = 0;
    while let Some(batch) = feed.next().await? {
        defs.extend(batch.channels);
        if batch.programmes.is_empty() {
            continue;
        }
        // First programmes: the channel section is parsed (standard XMLTV
        // order). Resolve once, and let the parser skip every channel nobody
        // wants (~92% of this feed's programmes).
        if candidates.is_none() {
            let c = resolve_against_external(pool, &defs).await?;
            feed.keep_channels(
                c.0.iter()
                    .chain(west)
                    .filter(|id| !fed.contains(*id))
                    .cloned(),
            );
            candidates = Some(c);
        }
        let wanted = &candidates.as_ref().expect("resolved above").0;
        for row in batch.programmes {
            if (!wanted.contains(&row.channel_id) && !west.contains(&row.channel_id))
                || fed.contains(&row.channel_id)
                || row.stop_utc < cutoff
                || row.stop_utc > horizon
            {
                continue;
            }
            if stage.add(row).await? {
                stored += 1;
            }
        }
    }
    let staged = stage.commit().await?;

    // Commit only mappings backed by retained programmes, this feed's or an
    // earlier feed's: an empty, expired or failed source leaves the channel
    // for the next feed. A station with several ids is resolved again against
    // the ids that kept programmes, now that their schedules are known.
    let mut asked = HashSet::new();
    let ids: Vec<String> = defs
        .iter()
        .filter_map(|d| epg_id(Some(&d.id)))
        .filter(|id| (staged.ids.contains(id) || fed.contains(id)) && asked.insert(id.clone()))
        .collect();
    let last_stop: HashMap<String, String> = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT j.value, (SELECT MAX(stop_utc) FROM epg_programs WHERE channel_id = j.value)
         FROM json_each(?1) j",
    )
    .bind(serde_json::to_string(&ids).expect("ids serialize"))
    .fetch_all(pool)
    .await
    .map_err(db_err)?
    .into_iter()
    .filter_map(|(id, stop)| stop.map(|s| (id, s)))
    .collect();
    let mut kept: EpgNameIndex = build_epg_name_index(&defs, last_stop.keys().cloned().collect());
    kept.last_stop = last_stop;
    let mut rows: Vec<(i64, String)> = Vec::new();
    for m in candidates.map(|c| c.1).unwrap_or_default() {
        let id = m
            .station
            .and_then(|st| resolve_epg_id(&st, &kept))
            .filter(|id| !id.is_empty())
            .unwrap_or(m.id);
        if kept.last_stop.contains_key(&id) || staged.ids.contains(&id) || fed.contains(&id) {
            rows.push((m.stream_id, id));
        }
    }
    let matched = sqlx::query(SET_UNRESOLVED)
        .bind(serde_json::to_string(&rows).expect("rows serialize"))
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    fed.extend(staged.ids.iter().cloned());
    Ok(ExternalResult {
        url: url.to_string(),
        ok: true,
        channels_matched: matched,
        programmes_stored: stored,
        ids_replaced: Some(staged.replaced),
        placeholders_dropped: Some(staged.placeholders),
        error: None,
    })
}

/// The EPG half of a sync: drop stale rows, ingest the provider feed, derive
/// West feeds, resolve channels, then layer the external feeds. A failed
/// provider feed fails the sync; an external feed never does. Returns the
/// provider programmes stored.
pub async fn refresh(pool: &SqlitePool, cfg: &Config, now: DateTime<Utc>) -> Result<usize, String> {
    let (cutoff, _) = window(now);
    sqlx::query("DELETE FROM epg_programs WHERE stop_utc < ?")
        .bind(&cutoff)
        .execute(pool)
        .await
        .map_err(db_err)?;
    let (provider, defs, stored) =
        tokio::time::timeout(EPG_WALL_TIMEOUT, ingest_provider(pool, cfg, now))
            .await
            .map_err(|_| "epg_wall_timeout".to_string())??;
    tracing::info!(
        programmes = stored,
        ids_replaced = provider.replaced,
        placeholders_dropped = provider.placeholders,
        "provider epg"
    );

    // Before resolution, so a catalog tvg "<x>west.us" with no feed of its own
    // has programmes when the resolver checks it (2026-10-15 showtimewest.us
    // was name-matched to showtime2west.us first).
    let west = derive_west_feed_epg(pool, &provider.ids).await?;
    tracing::info!(
        channels = west.channels,
        programmes = west.programmes,
        "west feed epg"
    );

    let mut with_epg = provider.ids.clone();
    with_epg.extend(west.ids.iter().cloned());
    resolve_epg_channels(pool, &defs, with_epg).await?;

    // Third-party feeds fill what the provider omits; never an id the provider
    // just delivered.
    let mut fed = provider.ids;
    let west: HashSet<String> = west.ids.into_iter().collect();
    for url in &cfg.iptv_external_epg_urls {
        let r = ingest_external_epg(pool, url, now, &mut fed, &west).await;
        if r.ok {
            tracing::info!(result = ?r, "external epg");
        } else {
            tracing::warn!(result = ?r, "external epg failed");
        }
    }
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_config;
    use crate::testpanel::Panel;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn now() -> DateTime<Utc> {
        "2026-10-15T03:20:00Z".parse().unwrap()
    }
    /// "03:00" is that time on 2026-10-15; a full "YYYY-MM-DDTHH:MM" passes through.
    fn at(t: &str) -> DateTime<Utc> {
        let full = if t.contains('T') {
            t.to_string()
        } else {
            format!("2026-10-15T{t}")
        };
        format!("{full}:00Z").parse().unwrap()
    }

    /// A standard XMLTV doc: every <channel> before every <programme>.
    fn xml(defs: &[(&str, &str)], progs: &[(&str, &str, &str, &str)]) -> String {
        let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><tv>");
        for (id, name) in defs {
            out += &format!("<channel id=\"{id}\"><display-name>{name}</display-name></channel>");
        }
        for (id, start, stop, title) in progs {
            let t = |s: &str| at(s).format("%Y%m%d%H%M%S +0000").to_string();
            out += &format!(
                "<programme channel=\"{id}\" start=\"{}\" stop=\"{}\"><title>{title}</title></programme>",
                t(start),
                t(stop)
            );
        }
        out + "</tv>"
    }

    async fn db() -> (SqlitePool, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        (pool, dir)
    }
    async fn channel(p: &SqlitePool, id: i64, name: &str, tvg: Option<&str>) {
        sqlx::query(
            "INSERT INTO channels (stream_id, num, name, epg_channel_id, category_id, fetched_at)
             VALUES (?1, ?1, ?2, ?3, 1, '2026-10-15T00:00:00.000Z')",
        )
        .bind(id)
        .bind(name)
        .bind(tvg)
        .execute(p)
        .await
        .unwrap();
    }
    async fn programme(p: &SqlitePool, id: &str, start: &str, stop: &str, title: &str) {
        sqlx::query(
            "INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(iso(at(start)))
        .bind(iso(at(stop)))
        .bind(title)
        .execute(p)
        .await
        .unwrap();
    }
    async fn schedule(p: &SqlitePool, id: &str) -> Vec<(String, String)> {
        sqlx::query_as(
            "SELECT substr(start_utc, 12, 5), title FROM epg_programs WHERE channel_id = ? ORDER BY start_utc",
        )
        .bind(id)
        .fetch_all(p)
        .await
        .unwrap()
    }
    fn rows(r: &[(&str, &str)]) -> Vec<(String, String)> {
        r.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }
    async fn resolved(p: &SqlitePool, id: i64) -> Option<String> {
        sqlx::query_scalar("SELECT epg_resolved_id FROM channels WHERE stream_id = ?")
            .bind(id)
            .fetch_one(p)
            .await
            .unwrap()
    }
    /// The guide's listing: NULLIF(COALESCE(epg_resolved_id, tvg-id), '').
    async fn listed(p: &SqlitePool, id: i64) -> Option<String> {
        sqlx::query_scalar(
            "SELECT NULLIF(COALESCE(epg_resolved_id, epg_channel_id), '') FROM channels WHERE stream_id = ?",
        )
        .bind(id)
        .fetch_one(p)
        .await
        .unwrap()
    }
    async fn count(p: &SqlitePool, id: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM epg_programs WHERE channel_id = ?")
            .bind(id)
            .fetch_one(p)
            .await
            .unwrap()
    }
    fn cfg(panel: &Panel, external: &[&str]) -> Config {
        let urls: Vec<String> = external.iter().map(|p| panel.url(p)).collect();
        let urls = if urls.is_empty() {
            ",".to_string()
        } else {
            urls.join(",")
        };
        test_config(&[
            ("XTREAM_HOST", &panel.base),
            ("XTREAM_USERNAME", "u"),
            ("XTREAM_PASSWORD", "p"),
            ("IPTV_EXTERNAL_EPG_URLS", &urls),
        ])
    }
    /// One provider sync's EPG half against `feed`.
    async fn provider(p: &SqlitePool, panel: &Panel, feed: String) -> Result<usize, String> {
        panel.set_feed("/xmltv.php", feed);
        refresh(p, &cfg(panel, &[]), now()).await
    }
    async fn external(p: &SqlitePool, panel: &Panel, feed: String) -> ExternalResult {
        external_fed(p, panel, feed, &mut HashSet::new()).await
    }
    async fn external_fed(
        p: &SqlitePool,
        panel: &Panel,
        feed: String,
        fed: &mut HashSet<String>,
    ) -> ExternalResult {
        panel.set_feed("/ext.xml", feed);
        ingest_external_epg(p, &panel.url("/ext.xml"), now(), fed, &HashSet::new()).await
    }

    #[test]
    fn placeholder_titles_fold_case_and_punctuation() {
        assert!(is_placeholder_title(Some("No Match Today")));
        assert!(is_placeholder_title(Some("  SIGN-OFF! ")));
        assert!(!is_placeholder_title(Some("Unknown")));
        assert!(!is_placeholder_title(None));
    }

    #[tokio::test]
    async fn replaces_a_rescheduled_lineup_instead_of_interleaving_it() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(
            &p,
            200163548,
            "US: Cinemax Classics",
            Some("cinemaxclassics.us"),
        )
        .await;
        provider(
            &p,
            &panel,
            xml(
                &[],
                &[
                    (
                        "cinemaxclassics.us",
                        "02:39",
                        "04:01",
                        "Godzilla vs. Megalon",
                    ),
                    (
                        "cinemaxclassics.us",
                        "04:01",
                        "05:23",
                        "Godzilla Raids Again",
                    ),
                    ("showtime.us", "02:15", "04:15", "Patriot Games"),
                ],
            ),
        )
        .await
        .unwrap();
        provider(
            &p,
            &panel,
            xml(
                &[],
                &[
                    ("cinemaxclassics.us", "01:56", "03:32", "Just Friends"),
                    ("cinemaxclassics.us", "03:32", "04:58", "Son of Godzilla"),
                    ("cinemaxclassics.us", "04:58", "06:45", "The Usual Suspects"),
                ],
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            schedule(&p, "cinemaxclassics.us").await,
            rows(&[
                ("01:56", "Just Friends"),
                ("03:32", "Son of Godzilla"),
                ("04:58", "The Usual Suspects")
            ])
        );
        // An id this sync did not deliver keeps its schedule.
        assert_eq!(
            schedule(&p, "showtime.us").await,
            rows(&[("02:15", "Patriot Games")])
        );
    }

    #[tokio::test]
    async fn a_failed_fetch_leaves_every_schedule_as_it_was() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(
            &p,
            200163548,
            "US: Cinemax Classics",
            Some("cinemaxclassics.us"),
        )
        .await;
        provider(
            &p,
            &panel,
            xml(
                &[],
                &[("cinemaxclassics.us", "01:56", "03:32", "Just Friends")],
            ),
        )
        .await
        .unwrap();
        // Past one parser batch (8 MB), so many write batches are staged before
        // the feed turns out malformed.
        let mut body = String::from("<tv>");
        let start = at("02:00");
        for i in 0..60_000 {
            let s = start + chrono::TimeDelta::minutes(i);
            let f = |d: DateTime<Utc>| d.format("%Y%m%d%H%M%S +0000").to_string();
            body += &format!(
                "<programme channel=\"cinemaxclassics.us\" start=\"{}\" stop=\"{}\"><title>Partial</title></programme>\n",
                f(s),
                f(s + chrono::TimeDelta::minutes(1))
            );
        }
        body += "<programme channel=\"x\" start=\"20261015000000 +0000\" stop=\"20261015010000 +0000\"><title>A & B</title></programme></tv>";
        let err = provider(&p, &panel, body).await.unwrap_err();
        assert!(err.starts_with("xmltv_parse"), "{err}");
        assert_eq!(
            schedule(&p, "cinemaxclassics.us").await,
            rows(&[("01:56", "Just Friends")])
        );
    }

    #[tokio::test]
    async fn stores_no_filler_so_an_id_with_only_filler_has_no_epg() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 200168129, "US: FOX 13 Memphis (WHBQ)", Some("fox.us")).await;
        programme(&p, "fox.us", "00:00", "04:00", "No Match Today").await;
        let stored = provider(
            &p,
            &panel,
            xml(
                &[],
                &[
                    ("fox.us", "00:00", "04:00", "No Match Today"),
                    ("fox.us", "02:00", "10:00", "SIGN OFF"),
                    ("outdoorchannel.us", "02:05", "06:05", "Channel Off Air"),
                    ("outdoorchannel.us", "03:00", "03:30", "Guns &amp; Ammo TV"),
                ],
            ),
        )
        .await
        .unwrap();
        assert_eq!(stored, 1);
        assert!(schedule(&p, "fox.us").await.is_empty());
        // A callsign station never falls back to the bare network id.
        assert_eq!(listed(&p, 200168129).await, None);
        assert_eq!(
            schedule(&p, "outdoorchannel.us").await,
            rows(&[("03:00", "Guns & Ammo TV")])
        );
    }

    #[tokio::test]
    async fn drops_a_stored_programme_still_airing_when_the_lineup_starts_later() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 1, "US: X", Some("x.us")).await;
        provider(
            &p,
            &panel,
            xml(&[], &[("x.us", "03:00", "05:00", "Old movie")]),
        )
        .await
        .unwrap();
        provider(
            &p,
            &panel,
            xml(&[], &[("x.us", "03:30", "05:30", "Rescheduled movie")]),
        )
        .await
        .unwrap();
        assert_eq!(
            schedule(&p, "x.us").await,
            rows(&[("03:30", "Rescheduled movie")])
        );
    }

    #[tokio::test]
    async fn lists_showtime_west_on_showtimewest_with_west_times() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 5866, "US Showtime West (S)", Some("showtimewest.us")).await;
        channel(&p, 400124927, "US: SHOWTIME WEST", None).await;
        channel(&p, 200163566, "US: Showtime", Some("showtime.us")).await;
        sqlx::query(
            "UPDATE channels SET epg_resolved_id = 'showtime2west.us' WHERE stream_id = 5866",
        )
        .execute(&p)
        .await
        .unwrap();
        provider(
            &p,
            &panel,
            xml(
                &[
                    ("showtime.us", "Showtime"),
                    ("showtime2west.us", "Showtime 2 West"),
                    ("showtimewest.us", "Showtime West"),
                ],
                &[
                    ("showtime.us", "00:00", "02:15", "V for Vendetta"),
                    ("showtime.us", "02:15", "04:15", "Patriot Games"),
                    ("showtime2west.us", "03:00", "05:00", "The Return"),
                ],
            ),
        )
        .await
        .unwrap();
        assert_eq!(listed(&p, 5866).await.as_deref(), Some("showtimewest.us"));
        assert_eq!(
            listed(&p, 400124927).await.as_deref(),
            Some("showtimewest.us")
        );
        assert_eq!(
            schedule(&p, "showtimewest.us").await,
            rows(&[("03:00", "V for Vendetta"), ("05:15", "Patriot Games")])
        );
    }

    async fn west_db() -> (SqlitePool, tempfile::TempDir) {
        let (p, d) = db().await;
        for (id, tvg) in [
            (200163566, "showtime.us"),
            (5866, "showtimewest.us"),
            (7, "hgtvwest.us"),
        ] {
            channel(&p, id, &id.to_string(), Some(tvg)).await;
        }
        programme(&p, "showtime.us", "00:00", "02:15", "V for Vendetta").await;
        programme(&p, "showtime.us", "02:15", "04:15", "Patriot Games").await;
        (p, d)
    }
    fn no_fed() -> HashSet<String> {
        HashSet::new()
    }

    #[tokio::test]
    async fn a_west_feed_with_no_guide_gets_the_east_schedule_three_hours_later() {
        let (p, _d) = west_db().await;
        let w = derive_west_feed_epg(&p, &no_fed()).await.unwrap();
        assert_eq!((w.channels, w.programmes), (1, 2));
        assert_eq!(
            schedule(&p, "showtimewest.us").await,
            rows(&[("03:00", "V for Vendetta"), ("05:15", "Patriot Games")])
        );
        // Idempotent, and it follows a later East change on the next sync.
        sqlx::query("UPDATE epg_programs SET title = 'Sleeping Dogs' WHERE channel_id = 'showtime.us' AND title = 'Patriot Games'")
            .execute(&p)
            .await
            .unwrap();
        assert_eq!(
            derive_west_feed_epg(&p, &no_fed()).await.unwrap().channels,
            1
        );
        assert_eq!(
            schedule(&p, "showtimewest.us").await,
            rows(&[("03:00", "V for Vendetta"), ("05:15", "Sleeping Dogs")])
        );
    }

    #[tokio::test]
    async fn west_copies_keep_going_after_the_east_source_ages_out() {
        let (p, _d) = west_db().await;
        derive_west_feed_epg(&p, &no_fed()).await.unwrap();
        sqlx::query("DELETE FROM epg_programs WHERE channel_id = 'showtime.us' AND title = 'V for Vendetta'")
            .execute(&p)
            .await
            .unwrap();
        assert_eq!(
            derive_west_feed_epg(&p, &no_fed()).await.unwrap().channels,
            1
        );
        assert_eq!(schedule(&p, "showtimewest.us").await.len(), 2);
    }

    #[tokio::test]
    async fn west_copies_are_replaced_when_an_east_programme_moves() {
        let (p, _d) = west_db().await;
        derive_west_feed_epg(&p, &no_fed()).await.unwrap();
        sqlx::query("UPDATE epg_programs SET start_utc = '2026-10-15T02:30:00.000Z' WHERE channel_id = 'showtime.us' AND title = 'Patriot Games'")
            .execute(&p)
            .await
            .unwrap();
        derive_west_feed_epg(&p, &no_fed()).await.unwrap();
        assert_eq!(
            schedule(&p, "showtimewest.us").await,
            rows(&[("03:00", "V for Vendetta"), ("05:30", "Patriot Games")])
        );
    }

    #[tokio::test]
    async fn a_west_feed_with_its_own_listings_or_a_provider_feed_is_left_alone() {
        let (p, _d) = west_db().await;
        programme(&p, "showtimewest.us", "03:30", "05:00", "Real West Listing").await;
        assert_eq!(
            derive_west_feed_epg(&p, &no_fed()).await.unwrap(),
            WestFeeds {
                channels: 0,
                programmes: 0,
                ids: vec!["showtimewest.us".into()]
            }
        );
        let fed = HashSet::from(["showtimewest.us".to_string()]);
        assert_eq!(
            derive_west_feed_epg(&p, &fed).await.unwrap(),
            WestFeeds {
                channels: 0,
                programmes: 0,
                ids: vec![]
            }
        );
        assert_eq!(
            schedule(&p, "showtimewest.us").await,
            rows(&[("03:30", "Real West Listing")])
        );
    }

    #[test]
    fn west_stems_skip_regional_networks() {
        assert_eq!(west_stem("showtimewest.us"), Some("showtime"));
        assert_eq!(west_stem("fsmidwest.us"), None);
        assert_eq!(west_stem("west.us"), None);
        assert_eq!(west_stem("hbowest.ca"), None);
    }

    fn defs(d: &[(&str, &[&str])]) -> Vec<ChannelDef> {
        d.iter()
            .map(|(id, names)| ChannelDef {
                id: id.to_string(),
                names: names.iter().map(|n| n.to_string()).collect(),
            })
            .collect()
    }
    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn resolution_prefers_the_callsign_id_whose_schedule_runs_latest() {
        let (p, _d) = db().await;
        channel(
            &p,
            200168354,
            "US: NBC 11 Minneapolis (KARE)",
            Some("dubai.ae"),
        )
        .await;
        programme(
            &p,
            "nbckare11minneapolis.us",
            "2026-10-14T01:00",
            "2026-10-14T02:00",
            "KARE 11 News at 10",
        )
        .await;
        programme(
            &p,
            "nbckare.us",
            "2026-10-16T11:00",
            "2026-10-16T12:00",
            "KARE 11 News at 10",
        )
        .await;
        let d = defs(&[
            ("nbckare.us", &[]),
            ("nbckare11minneapolis.us", &[]),
            ("dubai.ae", &[]),
        ]);
        resolve_epg_channels(
            &p,
            &d,
            set(&["nbckare.us", "nbckare11minneapolis.us", "dubai.ae"]),
        )
        .await
        .unwrap();
        assert_eq!(resolved(&p, 200168354).await.as_deref(), Some("nbckare.us"));
    }

    #[tokio::test]
    async fn resolution_takes_a_refused_provider_tag_off_the_guide() {
        let (p, _d) = db().await;
        channel(
            &p,
            200168495,
            "US: MY 38 Boston (WSBK)",
            Some("aljazeera.arabic.net"),
        )
        .await;
        channel(
            &p,
            200168388,
            "US: FOX 13 Seattle (KCPQ)",
            Some("aljazeera.arabic.net"),
        )
        .await;
        channel(&p, 200168199, "US: ABC 3 Mobile (WEAR)", Some("dubai.ae")).await;
        channel(&p, 7, "US: Al Jazeera Arabic", Some("aljazeera.arabic.net")).await;
        programme(
            &p,
            "aljazeera.arabic.net",
            "01:00",
            "02:00",
            "Al Jazeera News",
        )
        .await;
        let d = defs(&[("aljazeera.arabic.net", &["Al Jazeera Arabic"])]);
        resolve_epg_channels(&p, &d, set(&["aljazeera.arabic.net"]))
            .await
            .unwrap();
        for id in [200168495, 200168388, 200168199] {
            assert_eq!(resolved(&p, id).await.as_deref(), Some(""));
            assert_eq!(listed(&p, id).await, None);
        }
        assert_eq!(listed(&p, 7).await.as_deref(), Some("aljazeera.arabic.net"));
    }

    #[tokio::test]
    async fn resolution_gives_a_dead_tvg_id_the_one_its_us_twins_carry() {
        let (p, _d) = db().await;
        channel(&p, 36206, "US CMT (A)", Some("cmt.us")).await;
        channel(&p, 67730, "US CMT (East) (H)", Some("cmt.us")).await;
        channel(&p, 30800, "US CMT (S)", Some("cmt.east.us")).await;
        channel(&p, 1, "UK: CMT", Some("cmt.uk")).await;
        let d = defs(&[("cmt.us", &[]), ("cmt.uk", &[]), ("cmt.hd.us2", &["CMT"])]);
        resolve_epg_channels(&p, &d, set(&["cmt.us", "cmt.uk", "cmt.hd.us2"]))
            .await
            .unwrap();
        assert_eq!(resolved(&p, 30800).await.as_deref(), Some("cmt.us"));
        assert_eq!(resolved(&p, 1).await.as_deref(), Some("cmt.uk"));
    }

    #[tokio::test]
    async fn external_resolves_by_name_and_stores_the_in_window_programme() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 100, "US: ESPN", None).await;
        let r = external(
            &p,
            &panel,
            xml(
                &[("espn.us", "ESPN")],
                &[("espn.us", "03:20", "04:20", "Game")],
            ),
        )
        .await;
        assert!(r.ok, "{r:?}");
        assert_eq!((r.channels_matched, r.programmes_stored), (1, 1));
        assert_eq!(resolved(&p, 100).await.as_deref(), Some("espn.us"));
        assert_eq!(count(&p, "espn.us").await, 1);
        assert_eq!(panel.feed_hits(), vec!["/ext.xml"]);
    }

    #[tokio::test]
    async fn external_does_not_honor_a_junk_tvg_id_it_happens_to_define() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 200168199, "US: ABC 3 Mobile (WEAR)", Some("dubai.ae")).await;
        channel(&p, 7, "US: Al Jazeera", Some("aljazeera.english.net")).await;
        external(
            &p,
            &panel,
            xml(
                &[
                    ("dubai.ae", "Dubai TV"),
                    ("aljazeera.english.net", "Al Jazeera English"),
                ],
                &[
                    ("dubai.ae", "03:20", "04:20", "Shark Tank :Season 4"),
                    ("aljazeera.english.net", "03:20", "04:20", "News"),
                ],
            ),
        )
        .await;
        assert_eq!(resolved(&p, 200168199).await, None);
        assert_eq!(count(&p, "dubai.ae").await, 0);
        assert_eq!(
            resolved(&p, 7).await.as_deref(),
            Some("aljazeera.english.net")
        );
    }

    #[tokio::test]
    async fn external_lists_a_station_under_whichever_of_its_ids_has_programmes() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(
            &p,
            1,
            "US: NBC 2 Orlando (WESH)",
            Some("wesh-ld.us_locals1"),
        )
        .await;
        channel(&p, 2, "US NBC 2 (WESH) Orlando (H)", None).await;
        channel(&p, 3, "US: FOX 7 Miami (WSVN)", None).await;
        external(
            &p,
            &panel,
            xml(
                &[
                    ("wesh-dt.us_locals1", "WESH-DT"),
                    ("wesh-ld.us_locals1", "WESH-LD"),
                    ("wsvn-dt.us_locals1", "WSVN-DT"),
                    ("wsvn-dt2.us_locals1", "WSVN-DT2"),
                ],
                &[
                    ("wesh-ld.us_locals1", "03:20", "04:20", "WESH 2 News"),
                    ("wsvn-dt.us_locals1", "03:20", "04:20", "7 News"),
                    ("wsvn-dt2.us_locals1", "03:20", "05:20", "Cozi"),
                ],
            ),
        )
        .await;
        assert_eq!(resolved(&p, 1).await.as_deref(), Some("wesh-ld.us_locals1"));
        assert_eq!(resolved(&p, 2).await.as_deref(), Some("wesh-ld.us_locals1"));
        assert_eq!(resolved(&p, 3).await.as_deref(), Some("wsvn-dt.us_locals1"));
    }

    #[tokio::test]
    async fn external_lists_a_station_under_the_id_whose_schedule_runs_latest() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 1, "US: NBC 11 Minneapolis (KARE)", None).await;
        let kare = [
            ("nbckare.us", "NBC KARE"),
            ("nbckare11minneapolis.us", "NBC KARE 11 Minneapolis"),
        ];
        external(
            &p,
            &panel,
            xml(
                &kare,
                &[
                    ("nbckare.us", "03:20", "2026-10-18T03:20", "KARE 11 News"),
                    ("nbckare11minneapolis.us", "03:20", "04:20", "KARE 11 News"),
                ],
            ),
        )
        .await;
        assert_eq!(resolved(&p, 1).await.as_deref(), Some("nbckare.us"));
    }

    #[tokio::test]
    async fn external_counts_a_schedule_an_earlier_feed_stored_when_ranking() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 1, "US: NBC 11 Minneapolis (KARE)", None).await;
        programme(
            &p,
            "nbckare.us",
            "03:20",
            "2026-10-18T03:20",
            "KARE 11 News",
        )
        .await;
        let kare = [
            ("nbckare.us", "NBC KARE"),
            ("nbckare11minneapolis.us", "NBC KARE 11 Minneapolis"),
        ];
        let mut fed = set(&["nbckare.us"]);
        external_fed(
            &p,
            &panel,
            xml(
                &kare,
                &[("nbckare11minneapolis.us", "03:20", "04:20", "KARE 11 News")],
            ),
            &mut fed,
        )
        .await;
        assert_eq!(resolved(&p, 1).await.as_deref(), Some("nbckare.us"));
        assert!(
            fed.contains("nbckare11minneapolis.us"),
            "stored ids join fed"
        );
    }

    #[tokio::test]
    async fn external_stores_nothing_for_unmatched_stale_or_far_programmes() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 100, "US: ESPN", None).await;
        for progs in [
            [("unmatched.zz", "03:20", "04:20", "Show")],
            [("espn.us", "2026-10-13T03:00", "2026-10-13T04:00", "Stale")],
            [(
                "espn.us",
                "2026-11-14T03:00",
                "2026-11-14T04:00",
                "Beyond the horizon",
            )],
        ] {
            let r = external(&p, &panel, xml(&[("espn.us", "ESPN")], &progs)).await;
            assert!(r.ok);
            assert_eq!(
                (r.channels_matched, r.programmes_stored),
                (0, 0),
                "{progs:?}"
            );
        }
        assert_eq!(resolved(&p, 100).await, None);
        assert_eq!(
            count(&p, "espn.us").await + count(&p, "unmatched.zz").await,
            0
        );
    }

    #[tokio::test]
    async fn external_leaves_an_already_resolved_channel_alone() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 100, "US: ESPN", None).await;
        sqlx::query("UPDATE channels SET epg_resolved_id = 'provider.id' WHERE stream_id = 100")
            .execute(&p)
            .await
            .unwrap();
        let r = external(
            &p,
            &panel,
            xml(
                &[("espn.us", "ESPN")],
                &[("espn.us", "03:20", "04:20", "Game")],
            ),
        )
        .await;
        assert_eq!((r.channels_matched, r.programmes_stored), (0, 0));
        assert_eq!(resolved(&p, 100).await.as_deref(), Some("provider.id"));
        assert_eq!(count(&p, "espn.us").await, 0);
    }

    #[tokio::test]
    async fn external_errors_come_back_as_a_failed_result() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        panel.set_feed_status("/ext.xml", 503);
        let r =
            ingest_external_epg(&p, &panel.url("/ext.xml"), now(), &mut no_fed(), &no_fed()).await;
        assert_eq!(
            r,
            ExternalResult {
                url: panel.url("/ext.xml"),
                ok: false,
                channels_matched: 0,
                programmes_stored: 0,
                ids_replaced: None,
                placeholders_dropped: None,
                error: Some("http_503".into()),
            }
        );
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({"url": panel.url("/ext.xml"), "ok": false, "channelsMatched": 0, "programmesStored": 0, "error": "http_503"})
        );
        // Nothing listens on port 1.
        let r =
            ingest_external_epg(&p, "http://127.0.0.1:1/x", now(), &mut no_fed(), &no_fed()).await;
        assert!(
            !r.ok
                && r.error
                    .as_deref()
                    .unwrap()
                    .starts_with("external_epg_failed"),
            "{r:?}"
        );
    }

    #[tokio::test]
    async fn external_refuses_a_redirect_into_metadata_or_loopback() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 100, "US: ESPN", None).await;
        for target in [
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
            "http://localhost:8000/admin",
        ] {
            panel.set_feed_redirect("/ext.xml", target);
            let r =
                ingest_external_epg(&p, &panel.url("/ext.xml"), now(), &mut no_fed(), &no_fed())
                    .await;
            let err = r.error.unwrap();
            assert!(err.starts_with("external_epg_blocked"), "{err}");
            assert_eq!(r.programmes_stored, 0);
        }
        assert!(
            panel.feed_hits().iter().all(|h| h == "/ext.xml"),
            "only the trusted origin was dialed"
        );
        assert_eq!(resolved(&p, 100).await, None);
    }

    #[tokio::test]
    async fn an_empty_source_leaves_the_channel_for_a_working_fallback() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 100, "US: ESPN", None).await;
        let r = external(&p, &panel, xml(&[("espn.us", "ESPN")], &[])).await;
        assert!(r.ok);
        assert_eq!((r.channels_matched, r.programmes_stored), (0, 0));
        assert_eq!(resolved(&p, 100).await, None);
        let r = external(
            &p,
            &panel,
            xml(
                &[("fallback.espn", "ESPN")],
                &[("fallback.espn", "03:20", "04:20", "Game")],
            ),
        )
        .await;
        assert_eq!(r.programmes_stored, 1);
        assert_eq!(resolved(&p, 100).await.as_deref(), Some("fallback.espn"));
    }

    #[tokio::test]
    async fn persisted_external_schedules_are_not_coverage_from_the_current_provider_feed() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 100, "US: ESPN", Some("espn.us")).await;
        external(
            &p,
            &panel,
            xml(
                &[("espn.us", "ESPN")],
                &[("espn.us", "03:20", "04:20", "Original")],
            ),
        )
        .await;
        resolve_epg_channels(&p, &[], HashSet::new()).await.unwrap();
        let r = external(
            &p,
            &panel,
            xml(
                &[("espn.us", "ESPN")],
                &[("espn.us", "04:20", "05:20", "Updated")],
            ),
        )
        .await;
        assert_eq!(r.programmes_stored, 1);
        assert_eq!(
            schedule(&p, "espn.us").await,
            rows(&[("03:20", "Original"), ("04:20", "Updated")])
        );
    }

    #[tokio::test]
    async fn refresh_ingests_each_external_url_once_in_order() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        channel(&p, 100, "US: ESPN", None).await;
        channel(&p, 200, "US: CNN", None).await;
        panel.set_feed(
            "/a.xml",
            xml(
                &[("espn.us", "ESPN")],
                &[("espn.us", "03:20", "04:20", "Game")],
            ),
        );
        panel.set_feed(
            "/b.xml",
            xml(
                &[("cnn.us", "CNN")],
                &[("cnn.us", "03:20", "04:20", "News")],
            ),
        );
        refresh(&p, &cfg(&panel, &["/a.xml", "/b.xml"]), now())
            .await
            .unwrap();
        assert_eq!(panel.feed_hits(), vec!["/xmltv.php", "/a.xml", "/b.xml"]);
        assert_eq!(
            (count(&p, "espn.us").await, count(&p, "cnn.us").await),
            (1, 1)
        );
    }

    #[tokio::test]
    async fn the_provider_feed_refuses_a_redirect_into_metadata_or_an_internal_host() {
        let (p, _d) = db().await;
        let panel = Panel::start().await;
        for target in [
            "http://169.254.169.254/latest/meta-data/",
            "http://recommender:8000/x",
        ] {
            panel.set_feed_redirect("/xmltv.php", target);
            let err = refresh(&p, &cfg(&panel, &[]), now()).await.unwrap_err();
            assert!(err.starts_with("xtream.xmltv_blocked"), "{err}");
            assert!(!err.contains("password"), "no creds in errors: {err}");
        }
        panel.set_feed_status("/xmltv.php", 401);
        assert_eq!(
            refresh(&p, &cfg(&panel, &[]), now()).await.unwrap_err(),
            "xtream.xmltv_401"
        );
        assert_eq!(count(&p, "leak.1").await, 0);
    }

    /// A raw HTTP server: sends `head` and `body`, then stalls or hangs up.
    async fn raw_server(head: String, body: Vec<u8>, stall: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/feed.xml", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = [0u8; 4096];
            let _ = sock.read(&mut req).await;
            sock.write_all(head.as_bytes()).await.unwrap();
            sock.write_all(&body).await.unwrap();
            if stall {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
        url
    }
    async fn open(url: &str, idle: Option<Duration>) -> Feed {
        Feed::new(feed_client().unwrap().get(url).send().await.unwrap(), idle)
    }
    async fn drain(feed: &mut Feed) -> Result<(), String> {
        while feed.next().await?.is_some() {}
        Ok(())
    }
    fn gz(xml: &str) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut e, xml.as_bytes()).unwrap();
        e.finish().unwrap()
    }
    fn many(n: usize) -> String {
        let p = "<programme channel=\"a.us\" start=\"20261016000000 +0000\" stop=\"20261016010000 +0000\"><title>T</title></programme>";
        format!("<?xml version=\"1.0\"?><tv>{}</tv>", p.repeat(n))
    }

    #[tokio::test]
    async fn a_stalled_feed_hits_the_idle_timeout() {
        let body = gz(&many(5000));
        let url = raw_server(
            "HTTP/1.1 200 OK\r\ncontent-length: 999999\r\n\r\n".into(),
            body[..1024].to_vec(),
            true,
        )
        .await;
        let mut feed = open(&url, Some(Duration::from_millis(200))).await;
        assert_eq!(drain(&mut feed).await.unwrap_err(), "epg_idle_timeout");
    }

    #[tokio::test]
    async fn a_connection_reset_mid_gzip_or_a_truncated_gzip_fails_the_feed() {
        let body = gz(&many(5000));
        let half = body[..body.len() / 2].to_vec();
        let url = raw_server(
            format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n", body.len()),
            half.clone(),
            false,
        )
        .await;
        assert!(drain(&mut open(&url, None).await).await.is_err());
        let url = raw_server(
            format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n", half.len()),
            half,
            false,
        )
        .await;
        let err = drain(&mut open(&url, None).await).await.unwrap_err();
        assert!(err.starts_with("xmltv_gunzip"), "{err}");
    }

    #[tokio::test]
    async fn keep_channels_drops_other_channels_once_the_first_programmes_arrive() {
        // Larger than one parser batch (8 MB).
        let mut body = String::from("<tv>");
        for i in 0..120_000 {
            let id = if i % 2 == 1 { "b.us" } else { "a.us" };
            body += &format!(
                "<programme channel=\"{id}\" start=\"20261016000000 +0000\" stop=\"20261016010000 +0000\"><title>Show {i}</title></programme>\n"
            );
        }
        body += "</tv>";
        let panel = Panel::start().await;
        panel.set_feed("/big.xml", body);
        let mut feed = open(&panel.url("/big.xml"), None).await;
        let (mut a, mut b, mut asked) = (0, 0, 0);
        while let Some(batch) = feed.next().await.unwrap() {
            if asked == 0 && !batch.programmes.is_empty() {
                asked += 1;
                feed.keep_channels(["a.us".to_string()]);
            }
            for r in batch.programmes {
                if r.channel_id == "a.us" {
                    a += 1
                } else {
                    b += 1
                }
            }
        }
        assert_eq!((asked, a), (1, 60_000));
        // Only the batch parsed before keep_channels still carries b.us rows.
        assert!(b > 0 && b < 60_000, "{b}");
    }
}
