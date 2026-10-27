//! Feed-check records (migration 0008) and the guide id a channel joins EPG on
//! (iptvFeedChecks.ts).
//!
//! A channel's LISTED guide id is COALESCE(epg_resolved_id, epg_channel_id),
//! or none when the resolver refused the tag (`catalog::LISTED_EPG`). Its
//! EFFECTIVE guide id is the listed one, unless a feed check proved the stream
//! carries another channel's picture: then it is that channel's id, for as
//! long as the listing the check saw still holds (`catalog::EFFECTIVE_EPG`).

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use chrono::DateTime;
use regex::Regex;
use sqlx::SqlitePool;

use crate::catalog::{EFFECTIVE_EPG, LISTED_EPG};
use crate::epg_resolve::normalize_channel_name;
use crate::siblings::sibling_feed_key;

/// The reason a check records when no other stream of its listing exists.
pub const NO_SIBLING_REASON: &str = "no other stream of its listing to compare";

const HOUR_MS: i64 = 3_600_000;

#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct FeedCheck {
    pub stream_id: i64,
    /// 'match' | 'mislabeled' | 'inconclusive' (a CHECK constraint holds it).
    pub verdict: String,
    pub listed_epg_id: Option<String>,
    pub actual_epg_id: Option<String>,
    pub matched_stream_id: Option<i64>,
    pub score: Option<f64>,
    /// Why the check ended so (feed_verify's outcome reason); NULL before 0009.
    pub reason: Option<String>,
    pub checked_at: String,
}

impl FeedCheck {
    /// A record to write; `checked_at` is stamped by [`record_feed_check`].
    pub fn new(
        stream_id: i64,
        verdict: &str,
        listed: Option<&str>,
        actual: Option<&str>,
        matched: Option<i64>,
        score: Option<f64>,
    ) -> FeedCheck {
        FeedCheck {
            stream_id,
            verdict: verdict.into(),
            listed_epg_id: listed.map(Into::into),
            actual_epg_id: actual.map(Into::into),
            matched_stream_id: matched,
            score,
            reason: None,
            checked_at: String::new(),
        }
    }
}

/// `Date#toISOString` of an epoch-ms instant.
pub(crate) fn iso_ms(ms: i64) -> String {
    crate::xtream::iso(DateTime::from_timestamp_millis(ms).unwrap_or_default())
}

/// stream_id -> (the listing a check saw, the guide id it proved the stream
/// carries). One row per caught stream, so whole-catalog scans apply it in
/// memory instead of a per-row subquery.
pub async fn feed_overrides(
    pool: &SqlitePool,
) -> Result<HashMap<i64, (String, String)>, sqlx::Error> {
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT stream_id, listed_epg_id, actual_epg_id FROM channel_feed_checks \
         WHERE verdict = 'mislabeled' AND listed_epg_id IS NOT NULL AND actual_epg_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id, l, a)| (id, (l, a))).collect())
}

/// In-memory twin of EFFECTIVE_EPG for a row already read with its listing.
pub fn effective_of<'a>(
    stream_id: i64,
    listed: Option<&'a str>,
    overrides: &'a HashMap<i64, (String, String)>,
) -> Option<&'a str> {
    match overrides.get(&stream_id) {
        Some((l, actual)) if Some(l.as_str()) == listed => Some(actual),
        _ => listed,
    }
}

async fn epg_id_of(
    pool: &SqlitePool,
    expr: &str,
    stream_id: i64,
) -> Result<Option<String>, sqlx::Error> {
    let sql = format!("SELECT {expr} FROM channels WHERE stream_id = ?");
    let id: Option<Option<String>> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(stream_id)
        .fetch_optional(pool)
        .await?;
    Ok(id.flatten().filter(|s| !s.is_empty()))
}

pub async fn listed_epg_id(
    pool: &SqlitePool,
    stream_id: i64,
) -> Result<Option<String>, sqlx::Error> {
    epg_id_of(pool, LISTED_EPG, stream_id).await
}

pub async fn effective_epg_id(
    pool: &SqlitePool,
    stream_id: i64,
) -> Result<Option<String>, sqlx::Error> {
    epg_id_of(pool, EFFECTIVE_EPG, stream_id).await
}

pub async fn get_feed_check(
    pool: &SqlitePool,
    stream_id: i64,
) -> Result<Option<FeedCheck>, sqlx::Error> {
    sqlx::query_as("SELECT * FROM channel_feed_checks WHERE stream_id = ?")
        .bind(stream_id)
        .fetch_optional(pool)
        .await
}

/// Upsert a check, stamped `at_ms`.
pub async fn record_feed_check(
    pool: &SqlitePool,
    c: &FeedCheck,
    at_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO channel_feed_checks (stream_id, verdict, listed_epg_id, actual_epg_id, matched_stream_id, score, reason, checked_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(stream_id) DO UPDATE SET verdict = excluded.verdict, listed_epg_id = excluded.listed_epg_id, \
           actual_epg_id = excluded.actual_epg_id, matched_stream_id = excluded.matched_stream_id, \
           score = excluded.score, reason = excluded.reason, checked_at = excluded.checked_at",
    )
    .bind(c.stream_id)
    .bind(&c.verdict)
    .bind(&c.listed_epg_id)
    .bind(&c.actual_epg_id)
    .bind(c.matched_stream_id)
    .bind(c.score)
    .bind(&c.reason)
    .bind(iso_ms(at_ms))
    .execute(pool)
    .await?;
    Ok(())
}

/// Fresh = still answers for the stream as listed now. A verdict about another
/// listing says nothing about what the guide shows today (2026-10-15).
///
/// How long a verdict stands: a match or a mislabel a day (the provider
/// re-points streams within days: 200163572 matched East on 2026-10-22 and
/// carried West on 2026-10-25, unchecked under a 7-day match), an inconclusive
/// 6 hours. A check that compared nothing (a capture failed, or the picture
/// was dark) waits a day and an hour, so each retry lands an hour later in the
/// overnight window: a channel off air at 10:00 every night still gets seen.
pub fn feed_check_is_fresh(c: &FeedCheck, listed: Option<&str>, now_ms: i64) -> bool {
    if c.listed_epg_id.as_deref() != listed {
        return false;
    }
    let compared_nothing = c.verdict == "inconclusive"
        && c.score.is_none()
        && c.reason.as_deref().is_some_and(|r| r != NO_SIBLING_REASON);
    let window = match c.verdict.as_str() {
        _ if compared_nothing => 25 * HOUR_MS,
        "match" | "mislabeled" => 24 * HOUR_MS,
        "inconclusive" => 6 * HOUR_MS,
        _ => return false,
    };
    DateTime::parse_from_rfc3339(&c.checked_at)
        .is_ok_and(|t| now_ms - t.timestamp_millis() < window)
}

/// Titles that say nothing about the picture: off-air slates and the event
/// channels' "Next game: ..." filler.
static PLACEHOLDER_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:sign ?off|off[ -]?air|channel off air|to be announced|tba|tbd|no match today|channel no longer available|next (?:game|match)(?-u:\b).*)$",
    )
    .unwrap()
});
static LIVE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:live|new)\s*:\s*").unwrap());
static CATEGORY_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+category:.*$").unwrap());
static NON_LN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());

/// A programme title folded for comparison ("Live: WWE NXT" -> "wwe nxt",
/// "Good Morning America Category: News" -> "good morning america"). None for
/// a placeholder or no title.
pub fn norm_title(title: Option<&str>) -> Option<String> {
    let t = title?.trim().to_lowercase();
    if t.is_empty() || PLACEHOLDER_TITLE.is_match(&t) {
        return None;
    }
    let t = LIVE_PREFIX.replace(&t, "");
    let t = CATEGORY_TAIL.replace(&t, "");
    let t = NON_LN.replace_all(&t, " ");
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Two folded titles name one programme: equal, or one adds an episode or
/// event subtitle the other leaves off ("t20 cricket" / "t20 cricket india vs
/// west indies"). Two different subtitles stay different games.
fn same_programme(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b} ")) || b.starts_with(&format!("{a} "))
}

/// One guide id's programmes over a span: what it airs at any moment in it.
struct Schedule(Vec<(String, String, Option<String>)>);

impl Schedule {
    /// Programmes of `id` overlapping [from, to] (epoch ms).
    async fn load(
        pool: &SqlitePool,
        id: &str,
        from: i64,
        to: i64,
    ) -> Result<Schedule, sqlx::Error> {
        let rows = sqlx::query_as(
            "SELECT start_utc, stop_utc, title FROM epg_programs WHERE channel_id = ? AND start_utc <= ? AND stop_utc > ?",
        )
        .bind(id)
        .bind(iso_ms(to))
        .bind(iso_ms(from))
        .fetch_all(pool)
        .await?;
        Ok(Schedule(rows))
    }

    /// The folded title airing at `at` (the latest-starting programme on air,
    /// as `ORDER BY start_utc DESC LIMIT 1`).
    fn title(&self, at: i64) -> Option<String> {
        let at = iso_ms(at);
        let (_, _, title) = self
            .0
            .iter()
            .filter(|(start, stop, _)| *start <= at && *stop > at)
            .max_by(|a, b| a.0.cmp(&b.0))?;
        norm_title(title.as_deref())
    }
}

async fn title_at(pool: &SqlitePool, id: &str, at: i64) -> Result<Option<String>, sqlx::Error> {
    Ok(Schedule::load(pool, id, at, at).await?.title(at))
}

/// True when both guide ids list a real programme at `at` and the titles
/// differ. Only then does a picture match tell the two channels apart: East
/// and West feeds (and sister channels) carry the same live event at once.
pub async fn listings_differ(
    pool: &SqlitePool,
    a: &str,
    b: &str,
    at: i64,
) -> Result<bool, sqlx::Error> {
    let (ta, tb) = (title_at(pool, a, at).await?, title_at(pool, b, at).await?);
    Ok(matches!((ta, tb), (Some(ta), Some(tb)) if !same_programme(&ta, &tb)))
}

#[derive(Debug, PartialEq)]
pub struct Agreement {
    /// Share of `points` listing the same programme.
    pub share: f64,
    /// Half-hour points where both list a real programme.
    pub points: u32,
    /// Distinct titles that agreed.
    pub titles: usize,
}

/// How far two guide ids' schedules agree within `hours` either side of `at`.
pub async fn schedule_agreement(
    pool: &SqlitePool,
    a: &str,
    b: &str,
    at: i64,
    hours: i64,
) -> Result<Agreement, sqlx::Error> {
    let (from, to) = (at - hours * HOUR_MS, at + hours * HOUR_MS);
    let sa = Schedule::load(pool, a, from, to).await?;
    let sb = Schedule::load(pool, b, from, to).await?;
    let mut agreed = HashSet::new();
    let (mut points, mut same) = (0u32, 0u32);
    for t in (from..=to).step_by(30 * 60_000) {
        let (Some(ta), Some(tb)) = (sa.title(t), sb.title(t)) else {
            continue;
        };
        points += 1;
        if same_programme(&ta, &tb) {
            same += 1;
            agreed.insert(if ta.chars().count() < tb.chars().count() {
                ta
            } else {
                tb
            });
        }
    }
    let share = if points > 0 {
        same as f64 / points as f64
    } else {
        0.0
    };
    Ok(Agreement {
        share,
        points,
        titles: agreed.len(),
    })
}

/// Two ids of one channel (travel.us / travelchannel.us): their schedules agree
/// most of the time, so a stream carrying one carries the other's programmes.
pub async fn same_schedule_epg_ids(
    pool: &SqlitePool,
    a: &str,
    b: &str,
    at: i64,
) -> Result<bool, sqlx::Error> {
    let g = schedule_agreement(pool, a, b, at, 12).await?;
    Ok(g.points >= 4 && g.share >= 0.5)
}

/// The guide id a checked stream is known to carry, or None when unknown.
pub fn known_carried_epg_id(c: Option<&FeedCheck>, listed: Option<&str>) -> Option<String> {
    let c = c.filter(|c| c.listed_epg_id.as_deref() == listed)?;
    match c.verdict.as_str() {
        "match" => listed.map(Into::into),
        "mislabeled" => c.actual_epg_id.clone(),
        _ => None,
    }
}

// ── Candidate streams to compare a feed against ─────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Carries the intended guide id.
    Sibling,
    /// Carries a related channel's.
    Family,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub stream_id: i64,
    pub epg_id: String,
    pub role: Role,
}

#[derive(Debug, PartialEq)]
pub struct Family {
    pub base: String,
    pub root: String,
    pub country: String,
}

static FEED_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:east|west|pacific|hd|[0-9]+)$").unwrap());
static COAST_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:east|west|pacific)$").unwrap());

/// "showtime2west.us" -> base "showtime2west", root "showtime", country "us":
/// the brand part of a guide id with its feed number / coast / HD suffixes
/// stripped.
pub fn epg_id_family(epg_id: &str) -> Family {
    let lower = epg_id.to_lowercase();
    let (head, country) = lower.split_once('.').unwrap_or((&lower, ""));
    let base = NON_LN.replace_all(head, "").into_owned();
    let mut root = base.clone();
    loop {
        let next = FEED_SUFFIX.replace(&root, "").into_owned();
        if next == root || next.chars().count() < 3 {
            break;
        }
        root = next;
    }
    Family {
        base,
        root,
        country: country.into(),
    }
}

/// Two guide ids name related channels of one brand (Showtime / Showtime 2 /
/// Showtime Extreme; HBO / HBO Zone): same country, and their roots share a
/// prefix of at least 3 characters covering 40% of the shorter one.
pub fn related_epg_ids(a: &str, b: &str) -> bool {
    if a == b {
        return false;
    }
    let (fa, fb) = (epg_id_family(a), epg_id_family(b));
    if fa.country != fb.country {
        return false;
    }
    let common = fa
        .root
        .chars()
        .zip(fb.root.chars())
        .take_while(|(x, y)| x == y)
        .count();
    let shorter = fa.root.chars().count().min(fb.root.chars().count());
    common >= 3 && common as f64 >= 0.4 * shorter as f64
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push(
                (prev[j + 1] + 1)
                    .min(cur[j] + 1)
                    .min(prev[j] + usize::from(ca != *cb)),
            );
        }
        prev = cur;
    }
    prev[b.len()]
}

/// `String#localeCompare` for guide ids, close enough: punctuation before
/// digits before letters, letters case-insensitive first, lowercase first on a
/// tie. ponytail: not full ICU collation (punctuation order among itself is
/// byte order); only breaks ties after coast and edit distance.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    let key = |s: &str| -> Vec<(u8, char)> {
        s.chars()
            .map(|c| match c {
                '0'..='9' => (1, c),
                c if c.is_alphabetic() => (2, c.to_lowercase().next().unwrap_or(c)),
                c => (0, c),
            })
            .collect()
    };
    key(a).cmp(&key(b)).then_with(|| {
        let case = |s: &str| s.chars().map(|c| c.is_uppercase()).collect::<Vec<_>>();
        case(a).cmp(&case(b))
    })
}

/// Provider source group: the provider numbers each source's streams in its
/// own range (5864 "(S)", 200163566 "US:", 400124922 "US: CAPS"), and one
/// source's mistake is often repeated across its own range, so evidence from
/// another source is worth more.
fn source_group(stream_id: i64) -> i64 {
    stream_id.div_euclid(100_000_000)
}

static COAST_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)(?:east|west|pacific)(?-u:\b)").unwrap());
static WEST_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)(?:west|pacific)(?-u:\b)").unwrap());

/// A channel name as a sibling key: the feed key, but a West feed never pairs
/// with an East one ("US Showtime (West) (H)" is not "US: Showtime").
fn sibling_name_key(name: &str) -> String {
    let key = sibling_feed_key(&COAST_WORD.replace_all(name, " "));
    if !key.is_empty() && WEST_WORD.is_match(name) {
        format!("{key} west")
    } else {
        key
    }
}

fn west_feed(epg_id: &str) -> bool {
    epg_id.contains("west") || epg_id.contains("pacific")
}

/// Guide ids filed for the same channel as `epg_id` (cmt.us and cmt.hd.us2,
/// 2026-10-15): the same programme now and across the surrounding day, with
/// enough distinct titles that two all-day "Teleshopping" ids don't count.
/// Same coast only: some West ids carry the East schedule at East times.
async fn alias_epg_ids(
    pool: &SqlitePool,
    epg_id: &str,
    ids: &[String],
    at: i64,
) -> Result<Vec<String>, sqlx::Error> {
    let Some(now) = title_at(pool, epg_id, at).await? else {
        return Ok(Vec::new());
    };
    let pool_ids: Vec<&String> = ids
        .iter()
        .filter(|id| *id != epg_id && west_feed(id) == west_feed(epg_id))
        .collect();
    // What every candidate id airs now, in one read (the catalog has thousands).
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT channel_id, start_utc, title FROM epg_programs \
         WHERE channel_id IN (SELECT value FROM json_each(?)) AND start_utc <= ?2 AND stop_utc > ?2",
    )
    .bind(serde_json::to_string(&pool_ids).unwrap_or_default())
    .bind(iso_ms(at))
    .fetch_all(pool)
    .await?;
    let mut airing: HashMap<&str, (&str, Option<&str>)> = HashMap::new();
    for (id, start, title) in &rows {
        let e = airing.entry(id).or_insert((start, title.as_deref()));
        if start.as_str() > e.0 {
            *e = (start, title.as_deref());
        }
    }
    let mut out = Vec::new();
    for id in pool_ids {
        let id_now = airing.get(id.as_str()).and_then(|(_, t)| norm_title(*t));
        if !id_now.is_some_and(|t| same_programme(&t, &now)) {
            continue;
        }
        let g = schedule_agreement(pool, epg_id, id, at, 12).await?;
        if g.share >= 0.9 && g.points >= 12 && g.titles >= 4 {
            out.push(id.clone());
        }
    }
    Ok(out)
}

#[derive(Clone, sqlx::FromRow)]
struct Row {
    stream_id: i64,
    num: Option<i64>,
    name: String,
    tvg: Option<String>,
    epg: Option<String>,
}

/// What [`feed_check_candidates`] skips and how far it looks.
pub struct CandidateOpts<'a> {
    pub is_dead: &'a (dyn Fn(i64) -> bool + Sync),
    pub exclude: &'a [i64],
    pub max_family: usize,
    pub now_ms: i64,
}

/// Ordered streams to compare `subject` against, to learn which guide id it
/// really carries: one stream of `intended` (a sibling: a match proves the
/// listing right), then up to `max_family` streams of related channels (a
/// match proves it carries that channel instead), then a second sibling (in
/// case the first was itself the odd one out). Each guide id is represented by
/// one stream: one verified under its current listing first, then one from
/// another provider source, then the lowest channel number. Dead feeds and
/// `exclude` are skipped.
///
/// A sibling must be vouched to be the intended channel: the provider tags it
/// with that id itself, or with the subject's own tag, or it has the subject's
/// name. Sharing a name-resolved id is not enough (2026-10-14: WTAE Pittsburgh
/// "confirmed" against WPVI Philadelphia, both name-resolved to abc5.us). When
/// that leaves fewer than two, streams of an id with the same schedule count.
///
/// A West stream of the subject's channel that resolves to no listing still
/// stands for the intended id's West twin ("showtimewomen.us" ->
/// "showtimewomenwest.us") when that id has a schedule: the provider files
/// "Showtime Women (West) (H)" under the East id too, so the resolver drops
/// the name as ambiguous (2026-10-25: "US: Showtime Women" carried the West
/// feed and no West stream was there to say so).
pub async fn feed_check_candidates(
    pool: &SqlitePool,
    subject: i64,
    intended: &str,
    o: &CandidateOpts<'_>,
) -> Result<Vec<Candidate>, sqlx::Error> {
    let overrides = feed_overrides(pool).await?;
    let sql = format!(
        "SELECT stream_id, num, name, epg_channel_id AS tvg, {LISTED_EPG} AS epg FROM channels \
         WHERE COALESCE({LISTED_EPG}, '') != ''"
    );
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await?;
    let sql = format!(
        "SELECT f.stream_id FROM channel_feed_checks f JOIN channels ON channels.stream_id = f.stream_id \
         WHERE f.verdict IN ('match', 'mislabeled') AND f.listed_epg_id = {LISTED_EPG}"
    );
    let verified: HashSet<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
    let subject_group = source_group(subject);
    let rank = |r: &Row| {
        (
            u8::from(!verified.contains(&r.stream_id)),
            u8::from(source_group(r.stream_id) == subject_group),
            r.num.unwrap_or(r.stream_id),
        )
    };

    // Guide ids in first-seen order, each with its streams.
    let mut order: Vec<String> = Vec::new();
    let mut by_epg: HashMap<String, Vec<Row>> = HashMap::new();
    for mut r in rows {
        let epg = effective_of(r.stream_id, r.epg.as_deref(), &overrides)
            .unwrap_or("")
            .to_string();
        if epg.is_empty()
            || r.stream_id == subject
            || o.exclude.contains(&r.stream_id)
            || (o.is_dead)(r.stream_id)
        {
            continue;
        }
        r.epg = Some(epg.clone());
        by_epg
            .entry(epg)
            .or_insert_with_key(|k| {
                order.push(k.clone());
                Vec::new()
            })
            .push(r);
    }

    let me: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name, epg_channel_id AS tvg FROM channels WHERE stream_id = ?")
            .bind(subject)
            .fetch_optional(pool)
            .await?;
    let self_name = me
        .as_ref()
        .map(|(n, _)| sibling_name_key(n))
        .unwrap_or_default();
    let self_tvg = me.and_then(|(_, t)| t).filter(|t| !t.is_empty());
    let vouched = |epg: &str, r: &Row| {
        r.tvg.as_deref() == Some(epg)
            || (self_tvg.is_some() && r.tvg == self_tvg)
            || (!self_name.is_empty() && sibling_name_key(&r.name) == self_name)
    };
    let streams_of = |epg: &str| -> Vec<Row> {
        by_epg
            .get(epg)
            .map(|v| v.iter().filter(|r| vouched(epg, r)).cloned().collect())
            .unwrap_or_default()
    };
    let mut siblings = streams_of(intended);
    let mut aliases = Vec::new();
    if siblings.len() < 2 {
        aliases = alias_epg_ids(pool, intended, &order, o.now_ms).await?;
        for a in &aliases {
            siblings.extend(streams_of(a));
        }
    }
    siblings.sort_by_key(|r| rank(r));

    let intended_base = epg_id_family(intended).base;
    // The other coast's feed of the same channel is the likeliest mix-up
    // (Showtime West, HGTV West): always compare it first.
    let coast = |base: &str| COAST_SUFFIX.replace(base, "").into_owned();
    let other_coast =
        |epg: &str| u8::from(coast(&epg_id_family(epg).base) != coast(&intended_base));
    let mut family_ids = Vec::new();
    for epg in &order {
        if !related_epg_ids(intended, epg) || aliases.contains(epg) {
            continue;
        }
        if has_programmes(pool, epg).await? {
            family_ids.push(epg.clone());
        }
    }
    family_ids.sort_by(|a, b| {
        other_coast(a)
            .cmp(&other_coast(b))
            .then_with(|| {
                edit_distance(&intended_base, &epg_id_family(a).base)
                    .cmp(&edit_distance(&intended_base, &epg_id_family(b).base))
            })
            .then_with(|| locale_cmp(a, b))
    });

    // An alias stream stands for the intended listing: its match is a match.
    let mut out = Vec::new();
    let sibling = |r: &Row| Candidate {
        stream_id: r.stream_id,
        epg_id: intended.into(),
        role: Role::Sibling,
    };
    out.extend(siblings.first().map(sibling));
    let mut family = Vec::new();
    if let Some(head) = intended
        .strip_suffix(".us")
        .filter(|_| !west_feed(intended))
        && let twin = format!("{head}west.us")
        && !family_ids.contains(&twin)
        && has_programmes(pool, &twin).await?
    {
        let sql = format!(
            "SELECT stream_id, num, name, epg_channel_id AS tvg, NULL AS epg FROM channels \
             WHERE COALESCE({LISTED_EPG}, '') = '' AND (name LIKE '%west%' OR name LIKE '%pacific%')"
        );
        let unlisted: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .fetch_all(pool)
            .await?;
        // Named as the West id reads ("US FX (West) (H)" -> "fxwest"), so a
        // short or differently named subject ("US: FX", "US: Discovery ID")
        // still finds them.
        let want = normalize_channel_name(Some(&format!("{head}west")));
        let mut west: Vec<&Row> = unlisted
            .iter()
            .filter(|r| {
                r.stream_id != subject
                    && !o.exclude.contains(&r.stream_id)
                    && !(o.is_dead)(r.stream_id)
                    && want.is_some()
                    && normalize_channel_name(Some(&r.name)) == want
            })
            .collect();
        west.sort_by_key(|r| rank(r));
        // A second from another provider source, in case the first is down.
        let first = west.first().map(|r| source_group(r.stream_id));
        let second = west
            .iter()
            .find(|r| Some(source_group(r.stream_id)) != first);
        for r in west.first().into_iter().chain(second) {
            family.push(Candidate {
                stream_id: r.stream_id,
                epg_id: twin.clone(),
                role: Role::Family,
            });
        }
    }
    for epg in family_ids
        .into_iter()
        .take(o.max_family.saturating_sub(family.len()))
    {
        let best = by_epg[&epg]
            .iter()
            .min_by_key(|r| rank(r))
            .expect("an id has a stream");
        family.push(Candidate {
            stream_id: best.stream_id,
            epg_id: epg,
            role: Role::Family,
        });
    }
    out.extend(family.into_iter().take(o.max_family));
    out.extend(siblings.get(1).map(sibling));
    Ok(out)
}

async fn has_programmes(pool: &SqlitePool, epg: &str) -> Result<bool, sqlx::Error> {
    let has: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM epg_programs WHERE channel_id = ? LIMIT 1")
            .bind(epg)
            .fetch_optional(pool)
            .await?;
    Ok(has.is_some())
}

#[cfg(test)]
pub(crate) mod tests;
