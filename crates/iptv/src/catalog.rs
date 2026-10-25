//! Catalog and guide reads (iptvCatalog.ts, iptvEpgQuery.ts): category and
//! catalog lists, VOD/series detail, now/next, one channel's window, the guide
//! grid and programme search. Same SQL as the TS, so the same rows in the same
//! order.

use std::collections::HashMap;

use serde::Serialize;
use sqlx::SqlitePool;

/// The id a channel joins EPG on: its listing (the name-resolved id, else the
/// raw tvg-id), unless a feed check proved the stream carries another channel
/// (effectiveEpgSql in iptvFeedChecks.ts).
pub(crate) const EFFECTIVE_EPG: &str = "COALESCE((SELECT f.actual_epg_id FROM channel_feed_checks f \
     WHERE f.stream_id = channels.stream_id AND f.verdict = 'mislabeled' \
       AND f.listed_epg_id = NULLIF(COALESCE(channels.epg_resolved_id, channels.epg_channel_id), '')), \
     NULLIF(COALESCE(channels.epg_resolved_id, channels.epg_channel_id), ''))";
/// The listing alone (listedEpgSql in iptvFeedChecks.ts).
pub(crate) const LISTED_EPG: &str =
    "NULLIF(COALESCE(channels.epg_resolved_id, channels.epg_channel_id), '')";

const GRID_LIMIT_MAX: i64 = 60_000;
const SEARCH_LIMIT_MAX: i64 = 500;
const GUIDE_SCOPE_KEY: &str = "feed_check_guide_scope";
const DEFAULT_GUIDE_LIMIT: i64 = 500;

#[derive(Serialize, sqlx::FromRow)]
pub struct Category {
    pub category_id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct LiveItem {
    pub stream_id: i64,
    pub num: Option<i64>,
    pub name: String,
    pub stream_icon: Option<String>,
    pub epg_channel_id: Option<String>,
    pub category_id: Option<i64>,
    pub tv_archive: i64,
    pub tv_archive_duration: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct VodItem {
    pub stream_id: i64,
    pub name: String,
    pub stream_icon: Option<String>,
    pub rating: Option<f64>,
    pub category_id: Option<i64>,
    pub year: Option<i64>,
    pub tmdb_id: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct VodDetail {
    pub stream_id: i64,
    pub name: String,
    pub stream_icon: Option<String>,
    pub rating: Option<f64>,
    pub category_id: Option<i64>,
    pub container_extension: Option<String>,
    pub tmdb_id: Option<i64>,
    pub year: Option<i64>,
    pub plot: Option<String>,
    pub director: Option<String>,
    pub cast_csv: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct SeriesItem {
    pub series_id: i64,
    pub name: String,
    pub cover: Option<String>,
    pub rating: Option<f64>,
    pub category_id: Option<i64>,
    pub tmdb_id: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Episode {
    pub episode_id: String,
    #[serde(skip)]
    pub season: i64,
    pub episode_num: i64,
    pub title: Option<String>,
    pub container_extension: Option<String>,
    pub duration_secs: Option<i64>,
    pub plot: Option<String>,
}

#[derive(Serialize)]
pub struct Season {
    pub season: i64,
    pub episodes: Vec<Episode>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct SeriesDetail {
    pub series_id: i64,
    pub name: String,
    pub cover: Option<String>,
    pub plot: Option<String>,
    pub rating: Option<f64>,
    pub category_id: Option<i64>,
    pub tmdb_id: Option<i64>,
    #[sqlx(skip)]
    pub seasons: Vec<Season>,
}

#[derive(Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

/// Parsed list query (`intOrUndef` already applied by the route).
#[derive(Default)]
pub struct ListOpts {
    pub category_id: Option<i64>,
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow, Clone, Debug, PartialEq)]
pub struct Programme {
    pub channel_id: String,
    pub start_utc: String,
    pub stop_utc: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Serialize)]
pub struct NowRow {
    pub channel_stream_id: i64,
    pub name: String,
    pub stream_icon: Option<String>,
    pub current: Option<Programme>,
    pub next: Option<Programme>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct GridRow {
    pub stream_id: i64,
    pub num: i64,
    pub name: String,
    pub stream_icon: Option<String>,
    pub epg_channel_id: Option<String>,
    pub tv_archive: i64,
    pub tv_archive_duration: Option<i64>,
    #[sqlx(skip)]
    pub programmes: Vec<Programme>,
}

#[derive(Default)]
pub struct GridOpts {
    pub category_id: Option<i64>,
    /// Wins over `category_id` when non-empty.
    pub category_ids: Vec<i64>,
    pub q: Option<String>,
    pub has_epg_only: bool,
    pub limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub stream_id: i64,
    pub channel_name: String,
    pub category_id: Option<i64>,
    pub programme: Programme,
    pub program_index: i64,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub total: i64,
}

fn clamp_limit(n: Option<i64>) -> i64 {
    n.unwrap_or(50).clamp(1, 200)
}

fn clamp_offset(n: Option<i64>) -> i64 {
    n.unwrap_or(0).max(0)
}

/// Escape LIKE metacharacters so a typed `%`, `_` or `\` matches literally
/// (pairs with `ESCAPE '\'`).
fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Characters that separate words in a column, as the query's own split does.
const SEPARATORS: [&str; 12] = ["-", ":", ".", ",", "!", "?", "/", "(", ")", "[", "]", "|"];

/// A run-together query shorter than this matches word starts only, so "us"
/// finds "US: CNN" but not "Music".
const RUN_TOGETHER_MIN: usize = 4;

/// Lowercase alphanumeric search words: apostrophes join ("What's" is
/// "whats") and "&" is the word "and".
fn search_words(q: &str) -> Vec<String> {
    q.to_lowercase()
        .replace(['\'', '\u{2019}'], "")
        .replace('&', " and ")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// `col` matched by words, so punctuation never decides a hit: "scooby-doo"
/// finds "SCOOBY DOO", "spiderman" finds "Spider-Man", "law and order" finds
/// "Law & Order". Every query word starts a word of `col`, or the query run
/// together sits in `col` with its separators squeezed out. A query with no
/// words ("%") matches literally. LIKE folds ASCII case. The gateway's
/// Discover search and the apps' WordMatch match the same way.
///
/// Each test leads with a plain substring LIKE, which rejects most rows
/// before the REPLACE chain runs (the 24 h programme window is ~160k rows).
/// `run_together` is off for descriptions, where it costs the most and
/// finds the least.
fn word_match(col: &str, q: &str, run_together: bool) -> (String, Vec<Arg>) {
    let words = search_words(q);
    if words.is_empty() {
        let like = format!("%{}%", escape_like(q.trim()));
        return (format!("{col} LIKE ? ESCAPE '\\'"), vec![Arg::Text(like)]);
    }
    let joined = format!("REPLACE(REPLACE({col}, '''', ''), '\u{2019}', '')");
    let spaced = SEPARATORS
        .iter()
        .fold(format!("REPLACE({joined}, '&', ' and ')"), |e, c| {
            format!("REPLACE({e}, '{c}', ' ')")
        });
    let mut args = Vec::new();
    let mut clause = words
        .iter()
        .map(|w| {
            args.push(Arg::Text(format!("%{w}%")));
            args.push(Arg::Text(format!("% {w}%")));
            let present = if w == "and" {
                format!("({col} LIKE ? OR {col} LIKE '%&%')")
            } else {
                format!("{col} LIKE ?")
            };
            format!("({present} AND ' ' || {spaced} LIKE ?)")
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    let squeezed = words.concat();
    if run_together && squeezed.chars().count() >= RUN_TOGETHER_MIN {
        let first = &squeezed[..squeezed.chars().next().map_or(0, char::len_utf8)];
        clause = format!("({clause}) OR ({col} LIKE ? AND REPLACE({spaced}, ' ', '') LIKE ?)");
        args.push(Arg::Text(format!("%{first}%")));
        args.push(Arg::Text(format!("%{squeezed}%")));
    }
    (format!("({clause})"), args)
}

type SqlQuery<'q, O> = sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>;

fn bind_all<'q, O>(mut q: SqlQuery<'q, O>, args: &[Arg]) -> SqlQuery<'q, O> {
    for a in args {
        q = match a {
            Arg::Int(i) => q.bind(*i),
            Arg::Text(s) => q.bind(s.clone()),
        };
    }
    q
}

enum Arg {
    Int(i64),
    Text(String),
}

pub async fn categories(pool: &SqlitePool, kind: &str) -> Result<Vec<Category>, sqlx::Error> {
    sqlx::query_as(
        "SELECT category_id, name, parent_id FROM categories WHERE kind = ? ORDER BY name",
    )
    .bind(kind)
    .fetch_all(pool)
    .await
}

/// One catalog list: `table` and `cols`/`order` are this module's constants.
async fn list<T>(
    pool: &SqlitePool,
    table: &str,
    cols: &str,
    order: &str,
    opts: &ListOpts,
) -> Result<Page<T>, sqlx::Error>
where
    T: for<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> + Send + Unpin,
{
    let limit = clamp_limit(opts.limit);
    let offset = clamp_offset(opts.offset);
    let mut wh = Vec::new();
    let mut args = Vec::new();
    if let Some(c) = opts.category_id {
        wh.push("category_id = ?".to_string());
        args.push(Arg::Int(c));
    }
    if let Some(q) = opts.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let (clause, words) = word_match("name", q, true);
        wh.push(clause);
        args.extend(words);
    }
    let where_sql = if wh.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", wh.join(" AND "))
    };
    let count_sql = format!("SELECT COUNT(*) FROM {table} {where_sql}");
    let (total,) = bind_all(
        sqlx::query_as::<_, (i64,)>(sqlx::AssertSqlSafe(count_sql)),
        &args,
    )
    .fetch_one(pool)
    .await?;
    let items_sql =
        format!("SELECT {cols} FROM {table} {where_sql} ORDER BY {order} LIMIT ? OFFSET ?");
    let items = bind_all(
        sqlx::query_as::<_, T>(sqlx::AssertSqlSafe(items_sql)),
        &args,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(Page {
        items,
        total,
        limit,
        offset,
    })
}

pub async fn list_live(pool: &SqlitePool, o: &ListOpts) -> Result<Page<LiveItem>, sqlx::Error> {
    list(
        pool,
        "channels",
        "stream_id, num, name, stream_icon, epg_channel_id, category_id, tv_archive, tv_archive_duration",
        "num, name",
        o,
    )
    .await
}

pub async fn list_vod(pool: &SqlitePool, o: &ListOpts) -> Result<Page<VodItem>, sqlx::Error> {
    list(
        pool,
        "vod",
        "stream_id, name, stream_icon, rating, category_id, year, tmdb_id",
        "COALESCE(added_ts, '') DESC, name",
        o,
    )
    .await
}

pub async fn list_series(pool: &SqlitePool, o: &ListOpts) -> Result<Page<SeriesItem>, sqlx::Error> {
    list(
        pool,
        "series",
        "series_id, name, cover, rating, category_id, tmdb_id",
        "name",
        o,
    )
    .await
}

pub async fn vod_detail(pool: &SqlitePool, id: i64) -> Result<Option<VodDetail>, sqlx::Error> {
    sqlx::query_as(
        "SELECT stream_id, name, stream_icon, rating, category_id, container_extension, \
         tmdb_id, year, plot, director, cast_csv FROM vod WHERE stream_id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn series_detail(
    pool: &SqlitePool,
    id: i64,
) -> Result<Option<SeriesDetail>, sqlx::Error> {
    let Some(mut meta) = sqlx::query_as::<_, SeriesDetail>(
        "SELECT series_id, name, cover, plot, rating, category_id, tmdb_id FROM series WHERE series_id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };
    let eps: Vec<Episode> = sqlx::query_as(
        "SELECT episode_id, season, episode_num, title, container_extension, duration_secs, plot \
         FROM series_episodes WHERE series_id = ? ORDER BY season, episode_num",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    // Rows arrive season-ordered, so consecutive grouping is the TS Map grouping.
    for ep in eps {
        match meta.seasons.last_mut() {
            Some(s) if s.season == ep.season => s.episodes.push(ep),
            _ => meta.seasons.push(Season {
                season: ep.season,
                episodes: vec![ep],
            }),
        }
    }
    Ok(Some(meta))
}

/// Now/next per channel, in request order, skipping unknown channels.
/// `ids` are positive; duplicates keep their first position.
pub async fn epg_now(
    pool: &SqlitePool,
    ids: &[i64],
    at_iso: &str,
) -> Result<Vec<NowRow>, sqlx::Error> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for &id in ids.iter().filter(|id| seen.insert(**id)) {
        let sql =
            format!("SELECT name, stream_icon, {EFFECTIVE_EPG} FROM channels WHERE stream_id = ?");
        let Some((name, stream_icon, epg)) =
            sqlx::query_as::<_, (String, Option<String>, Option<String>)>(sqlx::AssertSqlSafe(sql))
                .bind(id)
                .fetch_optional(pool)
                .await?
        else {
            continue;
        };
        let (mut current, mut next) = (None, None);
        if let Some(epg) = epg.filter(|e| !e.is_empty()) {
            current = sqlx::query_as(
                "SELECT channel_id, start_utc, stop_utc, title, description FROM epg_programs \
                 WHERE channel_id = ? AND start_utc <= ? AND stop_utc > ? ORDER BY start_utc DESC LIMIT 1",
            )
            .bind(&epg)
            .bind(at_iso)
            .bind(at_iso)
            .fetch_optional(pool)
            .await?;
            next = sqlx::query_as(
                "SELECT channel_id, start_utc, stop_utc, title, description FROM epg_programs \
                 WHERE channel_id = ? AND start_utc > ? ORDER BY start_utc ASC LIMIT 1",
            )
            .bind(&epg)
            .bind(at_iso)
            .fetch_optional(pool)
            .await?;
        }
        out.push(NowRow {
            channel_stream_id: id,
            name,
            stream_icon,
            current,
            next,
        });
    }
    Ok(out)
}

pub async fn epg_channel_window(
    pool: &SqlitePool,
    stream_id: i64,
    from: &str,
    to: &str,
) -> Result<Vec<Programme>, sqlx::Error> {
    let sql = format!("SELECT {EFFECTIVE_EPG} FROM channels WHERE stream_id = ?");
    let epg: Option<Option<String>> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(stream_id)
        .fetch_optional(pool)
        .await?;
    let Some(epg) = epg.flatten().filter(|e| !e.is_empty()) else {
        return Ok(Vec::new());
    };
    sqlx::query_as(
        "SELECT channel_id, start_utc, stop_utc, title, description FROM epg_programs \
         WHERE channel_id = ? AND start_utc < ? AND stop_utc > ? ORDER BY start_utc ASC",
    )
    .bind(epg)
    .bind(to)
    .bind(from)
    .fetch_all(pool)
    .await
}

/// The guide grid. The channel cap applies before programmes are read, and the
/// programme query reuses the channel SQL as a subquery, so a large library
/// never needs one bind per feed id.
pub async fn epg_grid(
    pool: &SqlitePool,
    from: &str,
    to: &str,
    o: &GridOpts,
) -> Result<Vec<GridRow>, sqlx::Error> {
    let limit = o.limit.unwrap_or(GRID_LIMIT_MAX).clamp(1, GRID_LIMIT_MAX);
    let mut wh = Vec::new();
    let mut args = Vec::new();
    if !o.category_ids.is_empty() {
        wh.push("category_id IN (SELECT value FROM json_each(?))".to_string());
        args.push(Arg::Text(
            serde_json::to_string(&o.category_ids).unwrap_or_default(),
        ));
    } else if let Some(c) = o.category_id {
        wh.push("category_id = ?".into());
        args.push(Arg::Int(c));
    }
    if let Some(q) = o.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let (clause, words) = word_match("name", q, true);
        wh.push(clause);
        args.extend(words);
    }
    if o.has_epg_only {
        wh.push(format!(
            "EXISTS (SELECT 1 FROM epg_programs p WHERE p.channel_id = {EFFECTIVE_EPG} \
             AND p.start_utc < ? AND p.stop_utc > ?)"
        ));
        args.push(Arg::Text(to.into()));
        args.push(Arg::Text(from.into()));
    }
    let where_sql = if wh.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", wh.join(" AND "))
    };
    let channel_sql = format!(
        "SELECT stream_id, COALESCE(num, 0) AS num, name, stream_icon, {EFFECTIVE_EPG} AS epg_channel_id, \
         tv_archive, tv_archive_duration FROM channels {where_sql} ORDER BY num, name, stream_id LIMIT ?"
    );
    let mut channels = bind_all(
        sqlx::query_as::<_, GridRow>(sqlx::AssertSqlSafe(channel_sql.clone())),
        &args,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    if channels.is_empty() {
        return Ok(channels);
    }
    let prog_sql = format!(
        "SELECT channel_id, start_utc, stop_utc, title, description FROM epg_programs \
         WHERE channel_id IN (SELECT epg_channel_id FROM ({channel_sql})) \
         AND start_utc < ? AND stop_utc > ? ORDER BY channel_id, start_utc"
    );
    let progs = bind_all(
        sqlx::query_as::<_, Programme>(sqlx::AssertSqlSafe(prog_sql)),
        &args,
    )
    .bind(limit)
    .bind(to)
    .bind(from)
    .fetch_all(pool)
    .await?;
    let mut by_channel: HashMap<String, Vec<Programme>> = HashMap::new();
    for p in progs {
        by_channel.entry(p.channel_id.clone()).or_default().push(p);
    }
    for ch in &mut channels {
        if let Some(id) = &ch.epg_channel_id {
            ch.programmes = by_channel.get(id).cloned().unwrap_or_default();
        }
    }
    Ok(channels)
}

#[derive(sqlx::FromRow)]
struct SearchRow {
    #[sqlx(rename = "streamId")]
    stream_id: i64,
    #[sqlx(rename = "channelName")]
    channel_name: String,
    #[sqlx(rename = "categoryId")]
    category_id: Option<i64>,
    #[sqlx(flatten)]
    programme: Programme,
    program_index: i64,
    total: i64,
}

/// Programme search over the whole EPG store: title or description matched by
/// words (`word_match`), one hit per (channel, programme), title hits first,
/// then by channel and start. `total` counts every match before the limit.
pub async fn epg_search(
    pool: &SqlitePool,
    from: &str,
    to: &str,
    q: &str,
    category_ids: &[i64],
    limit: Option<i64>,
) -> Result<SearchResult, sqlx::Error> {
    let term = q.trim();
    if term.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            total: 0,
        });
    }
    let limit = limit.unwrap_or(100).clamp(1, SEARCH_LIMIT_MAX);
    let category_where = if category_ids.is_empty() {
        ""
    } else {
        "WHERE category_id IN (SELECT value FROM json_each(?))"
    };
    // Title hits lead: a broad word in many descriptions must not push the
    // programme named for it past the limit.
    let (title_hit, title_args) = word_match("COALESCE(p.title, '')", term, true);
    let (description_hit, description_args) =
        word_match("COALESCE(p.description, '')", term, false);
    let sql = format!(
        "WITH channel_scope AS (
           SELECT stream_id, num, name, category_id, {EFFECTIVE_EPG} AS epg_id
           FROM channels {category_where}
         ), programmes AS (
           SELECT channel_id, start_utc, stop_utc, title, description,
             ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY start_utc) - 1 AS program_index
           FROM epg_programs
           WHERE channel_id IN (SELECT epg_id FROM channel_scope)
             AND start_utc < ? AND stop_utc > ?
         )
         SELECT *, COUNT(*) OVER () AS total FROM (
           SELECT c.stream_id AS streamId, c.name AS channelName, c.category_id AS categoryId,
             c.num, p.*, {title_hit} AS title_hit, {description_hit} AS description_hit
           FROM channel_scope c JOIN programmes p ON p.channel_id = c.epg_id
         )
         WHERE title_hit OR description_hit
         ORDER BY title_hit DESC, num, channelName, streamId, start_utc
         LIMIT ?"
    );
    let mut query = sqlx::query_as::<_, SearchRow>(sqlx::AssertSqlSafe(sql));
    if !category_ids.is_empty() {
        query = query.bind(serde_json::to_string(category_ids).unwrap_or_default());
    }
    query = query.bind(to).bind(from);
    let mut args = title_args;
    args.extend(description_args);
    let rows = bind_all(query, &args).bind(limit).fetch_all(pool).await?;
    Ok(SearchResult {
        total: rows.first().map_or(0, |r| r.total),
        hits: rows
            .into_iter()
            .map(|r| SearchHit {
                stream_id: r.stream_id,
                channel_name: r.channel_name,
                category_id: r.category_id,
                programme: r.programme,
                program_index: r.program_index,
            })
            .collect(),
    })
}

/// Record the app guide's scope (its curated categories, unfiltered) for the
/// idle feed checks (rememberGuideScope in iptvFeedSweep.ts). The JSON text is
/// byte-identical to the TS writer's, and an unchanged scope is not rewritten.
pub async fn remember_guide_scope(
    pool: &SqlitePool,
    category_ids: &[i64],
    limit: Option<i64>,
    has_epg: bool,
    now_iso: &str,
) -> Result<(), sqlx::Error> {
    let mut ids = category_ids.to_vec();
    ids.sort_unstable();
    let value = format!(
        "{{\"categoryIds\":{},\"limit\":{},\"hasEpg\":{has_epg}}}",
        serde_json::to_string(&ids).unwrap_or_default(),
        limit.unwrap_or(DEFAULT_GUIDE_LIMIT),
    );
    let current = crate::sync::get_state(pool, GUIDE_SCOPE_KEY).await?;
    if current.is_some_and(|(v, _)| v == value) {
        return Ok(());
    }
    crate::sync::put_state(pool, GUIDE_SCOPE_KEY, &value, now_iso).await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) async fn pool() -> (SqlitePool, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path().join("iptv.db").to_str().unwrap())
            .await
            .unwrap();
        (pool, dir)
    }

    pub(crate) async fn exec(pool: &SqlitePool, sql: &str) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(pool)
            .await
            .unwrap();
    }

    pub(crate) async fn channel(
        pool: &SqlitePool,
        id: i64,
        num: i64,
        name: &str,
        icon: Option<&str>,
        epg: Option<&str>,
        cat: i64,
    ) {
        sqlx::query(
            "INSERT INTO channels (stream_id, num, name, stream_icon, epg_channel_id, category_id, \
             tv_archive, tv_archive_duration, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-05-24T12:00:00Z')",
        )
        .bind(id)
        .bind(num)
        .bind(name)
        .bind(icon)
        .bind(epg)
        .bind(cat)
        .bind(i64::from(id == 10))
        .bind((id == 10).then_some(7))
        .execute(pool)
        .await
        .unwrap();
    }

    pub(crate) async fn prog(
        pool: &SqlitePool,
        ch: &str,
        start: &str,
        stop: &str,
        title: &str,
        desc: Option<&str>,
    ) {
        sqlx::query(
            "INSERT OR REPLACE INTO epg_programs (channel_id, start_utc, stop_utc, title, description) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(ch)
        .bind(start)
        .bind(stop)
        .bind(title)
        .bind(desc)
        .execute(pool)
        .await
        .unwrap();
    }

    /// The iptvCatalog.test.ts fixture.
    async fn catalog_fixture() -> (SqlitePool, tempfile::TempDir) {
        let (pool, dir) = pool().await;
        exec(
            &pool,
            "INSERT INTO categories (category_id, kind, name, parent_id) VALUES
               (1, 'live', 'News', 0), (2, 'vod', 'Action', 0), (3, 'series', 'Drama', 0);
             INSERT INTO vod (stream_id, name, rating, category_id, container_extension, tmdb_id, year,
               plot, director, cast_csv, fetched_at)
               VALUES (20, 'Matrix', 8.7, 2, 'mp4', 603, 1999, 'Neo', 'Wachowskis', 'Keanu', 'x');
             INSERT INTO series (series_id, name, rating, category_id, tmdb_id, fetched_at)
               VALUES (30, 'GoT', 9, 3, 1399, 'x');
             INSERT INTO series_episodes (episode_id, series_id, season, episode_num, title,
               container_extension, duration_secs) VALUES ('101', 30, 1, 1, 'Winter', 'mp4', 3600);",
        )
        .await;
        channel(&pool, 10, 1, "CNN", None, Some("cnn"), 1).await;
        (pool, dir)
    }

    #[tokio::test]
    async fn lists_categories_filtered_by_kind() {
        let (pool, _d) = catalog_fixture().await;
        let live = serde_json::to_value(categories(&pool, "live").await.unwrap()).unwrap();
        assert_eq!(
            live,
            serde_json::json!([{"category_id": 1, "name": "News", "parent_id": 0}])
        );
        assert_eq!(categories(&pool, "vod").await.unwrap()[0].name, "Action");
    }

    #[tokio::test]
    async fn lists_live_channels_with_paging_and_search() {
        let (pool, _d) = catalog_fixture().await;
        let page = list_live(
            &pool,
            &ListOpts {
                limit: Some(50),
                offset: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!((page.total, page.items[0].name.as_str()), (1, "CNN"));
        let q = |q: &str| ListOpts {
            q: Some(q.into()),
            ..Default::default()
        };
        assert_eq!(list_live(&pool, &q("cnn")).await.unwrap().total, 1);
        assert_eq!(list_live(&pool, &q("fox")).await.unwrap().total, 0);
        assert_eq!(
            list_live(&pool, &q("%")).await.unwrap().total,
            0,
            "LIKE metachar is literal"
        );
        let clamped = list_live(
            &pool,
            &ListOpts {
                limit: Some(9999),
                offset: Some(-3),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!((clamped.limit, clamped.offset), (200, 0));
        assert_eq!(
            list_live(
                &pool,
                &ListOpts {
                    limit: Some(0),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .limit,
            1
        );
    }

    #[tokio::test]
    async fn lists_vod_and_returns_detail_by_stream_id() {
        let (pool, _d) = catalog_fixture().await;
        assert_eq!(
            list_vod(&pool, &ListOpts::default()).await.unwrap().total,
            1
        );
        assert_eq!(
            list_series(&pool, &ListOpts::default())
                .await
                .unwrap()
                .items[0]
                .name,
            "GoT"
        );
        let v = vod_detail(&pool, 20).await.unwrap().unwrap();
        assert_eq!(
            (v.tmdb_id, v.director.as_deref()),
            (Some(603), Some("Wachowskis"))
        );
        assert!(vod_detail(&pool, 21).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn returns_series_detail_with_seasons_and_episodes() {
        let (pool, _d) = catalog_fixture().await;
        let s = serde_json::to_value(series_detail(&pool, 30).await.unwrap().unwrap()).unwrap();
        assert_eq!(s["seasons"].as_array().unwrap().len(), 1);
        assert_eq!(
            s["seasons"][0]["episodes"][0],
            serde_json::json!({"episode_id": "101", "episode_num": 1, "title": "Winter",
                "container_extension": "mp4", "duration_secs": 3600, "plot": null})
        );
        assert_eq!(s["rating"], 9.0);
        assert!(series_detail(&pool, 31).await.unwrap().is_none());
    }

    /// The iptvEpgQuery.test.ts fixture.
    async fn epg_fixture() -> (SqlitePool, tempfile::TempDir) {
        let (pool, dir) = pool().await;
        channel(
            &pool,
            10,
            1,
            "C1",
            Some("https://logos.example/c1.png"),
            Some("c1"),
            1,
        )
        .await;
        channel(&pool, 20, 2, "C2", None, Some("c2"), 2).await;
        channel(&pool, 30, 3, "No EPG", None, None, 1).await;
        prog(
            &pool,
            "c1",
            "2026-05-24T11:00:00Z",
            "2026-05-24T11:30:00Z",
            "Past",
            None,
        )
        .await;
        prog(
            &pool,
            "c1",
            "2026-05-24T11:30:00Z",
            "2026-05-24T12:30:00Z",
            "Now",
            Some("Current show"),
        )
        .await;
        prog(
            &pool,
            "c1",
            "2026-05-24T12:30:00Z",
            "2026-05-24T13:00:00Z",
            "Next",
            None,
        )
        .await;
        prog(
            &pool,
            "c2",
            "2026-05-24T12:00:00Z",
            "2026-05-24T13:00:00Z",
            "Other Channel",
            None,
        )
        .await;
        (pool, dir)
    }

    const FROM: &str = "2026-05-24T10:00:00Z";
    const TO: &str = "2026-05-24T13:00:00Z";

    fn titles(p: &[Programme]) -> Vec<&str> {
        p.iter().map(|p| p.title.as_deref().unwrap()).collect()
    }
    fn ids(rows: &[GridRow]) -> Vec<i64> {
        rows.iter().map(|r| r.stream_id).collect()
    }

    #[tokio::test]
    async fn epg_now_returns_current_and_next_programmes_for_each_channel() {
        let (pool, _d) = epg_fixture().await;
        let rows = serde_json::to_value(
            epg_now(&pool, &[10, 30, 10, 99], "2026-05-24T12:00:00.000Z")
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            rows.as_array().unwrap().len(),
            2,
            "duplicates and unknown ids drop"
        );
        assert_eq!(rows[0]["name"], "C1");
        assert_eq!(rows[0]["stream_icon"], "https://logos.example/c1.png");
        assert_eq!(rows[0]["current"]["title"], "Now");
        assert_eq!(rows[0]["next"]["title"], "Next");
        assert_eq!(
            rows[1],
            serde_json::json!({"channel_stream_id": 30, "name": "No EPG", "stream_icon": null, "current": null, "next": null})
        );
    }

    #[tokio::test]
    async fn schedule_corrections_choose_the_latest_current_row_without_hiding_the_next() {
        let (pool, _d) = epg_fixture().await;
        exec(
            &pool,
            "DELETE FROM epg_programs WHERE channel_id = 'c1' AND title = 'Next'",
        )
        .await;
        prog(
            &pool,
            "c1",
            "2026-05-24T11:45:00.000Z",
            "2026-05-24T12:45:00.000Z",
            "Corrected current",
            None,
        )
        .await;
        prog(
            &pool,
            "c1",
            "2026-05-24T12:45:00.000Z",
            "2026-05-24T13:45:00.000Z",
            "Following show",
            None,
        )
        .await;
        let row = &epg_now(&pool, &[10], "2026-05-24T12:00:00.000Z")
            .await
            .unwrap()[0];
        assert_eq!(
            row.current.as_ref().unwrap().title.as_deref(),
            Some("Corrected current")
        );
        assert_eq!(
            row.next.as_ref().unwrap().title.as_deref(),
            Some("Following show")
        );
    }

    #[tokio::test]
    async fn a_bounded_grid_and_search_survive_more_epg_ids_than_bind_slots() {
        let (pool, _d) = epg_fixture().await;
        exec(
            &pool,
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 32769)
             INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title)
             SELECT 'unrelated-' || i, '2026-05-24T12:00:00.000Z', '2026-05-24T13:00:00.000Z', 'Bulk News' FROM n;",
        )
        .await;
        prog(
            &pool,
            "c1",
            "2026-05-24T12:00:00.000Z",
            "2026-05-24T12:15:00.000Z",
            "Bulk News",
            None,
        )
        .await;
        let (f, t) = ("2026-05-24T12:00:00.000Z", "2026-05-24T13:00:00.000Z");
        let grid = epg_grid(
            &pool,
            f,
            t,
            &GridOpts {
                category_id: Some(1),
                has_epg_only: true,
                limit: Some(1),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(ids(&grid), [10]);
        let search = epg_search(&pool, f, t, "Bulk", &[1], Some(1))
            .await
            .unwrap();
        assert_eq!(search.total, 1);
        assert_eq!(search.hits[0].stream_id, 10);
    }

    #[tokio::test]
    async fn grid_search_matches_like_metacharacters_literally() {
        let (pool, _d) = epg_fixture().await;
        for term in ["%", "_", "\\"] {
            sqlx::query("UPDATE channels SET name = ? WHERE stream_id = 10")
                .bind(format!("100{term} News"))
                .execute(&pool)
                .await
                .unwrap();
            let q = GridOpts {
                q: Some(term.into()),
                ..Default::default()
            };
            assert_eq!(
                ids(&epg_grid(&pool, FROM, TO, &q).await.unwrap()),
                [10],
                "{term}"
            );
        }
    }

    #[tokio::test]
    async fn channel_window_returns_programmes_overlapping_the_range() {
        let (pool, _d) = epg_fixture().await;
        let rows = epg_channel_window(&pool, 10, FROM, TO).await.unwrap();
        assert_eq!(titles(&rows), ["Past", "Now", "Next"]);
        assert!(
            epg_channel_window(&pool, 30, FROM, TO)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            epg_channel_window(&pool, 99, FROM, TO)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn grid_maps_channels_with_programmes_and_filters() {
        let (pool, _d) = epg_fixture().await;
        let grid = |o: GridOpts| {
            let pool = pool.clone();
            async move { epg_grid(&pool, FROM, TO, &o).await.unwrap() }
        };
        let all = grid(GridOpts::default()).await;
        let first = serde_json::to_value(&all[0]).unwrap();
        assert_eq!(
            (
                &first["stream_id"],
                &first["name"],
                &first["stream_icon"],
                &first["tv_archive"],
                &first["tv_archive_duration"]
            ),
            (
                &serde_json::json!(10),
                &serde_json::json!("C1"),
                &serde_json::json!("https://logos.example/c1.png"),
                &serde_json::json!(1),
                &serde_json::json!(7)
            )
        );
        assert_eq!(titles(&all[0].programmes), ["Past", "Now", "Next"]);
        assert_eq!(ids(&all), [10, 20, 30]);

        let by_cat = grid(GridOpts {
            category_id: Some(2),
            ..Default::default()
        })
        .await;
        assert_eq!(ids(&by_cat), [20]);
        assert_eq!(titles(&by_cat[0].programmes), ["Other Channel"]);

        assert_eq!(
            ids(&grid(GridOpts {
                category_ids: vec![1, 2],
                ..Default::default()
            })
            .await),
            [10, 20, 30]
        );
        assert_eq!(
            ids(&grid(GridOpts {
                category_ids: vec![2],
                ..Default::default()
            })
            .await),
            [20]
        );
        assert_eq!(
            ids(&grid(GridOpts {
                category_id: Some(1),
                category_ids: vec![2],
                ..Default::default()
            })
            .await),
            [20],
            "categoryIds wins"
        );
        assert_eq!(
            ids(&grid(GridOpts {
                has_epg_only: true,
                ..Default::default()
            })
            .await),
            [10, 20]
        );
        assert_eq!(
            ids(&grid(GridOpts {
                q: Some("C1".into()),
                ..Default::default()
            })
            .await),
            [10]
        );
        let empty = epg_grid(
            &pool,
            "2020-01-01T00:00:00Z",
            "2020-01-01T01:00:00Z",
            &GridOpts {
                has_epg_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(empty.is_empty());
    }

    /// The pushdown fixture of iptvEpgQuery.test.ts: 200 channels x 300
    /// programmes, the needle on channel c5 at indices 7 and 20 only.
    #[tokio::test]
    async fn channel_search_matches_by_words_not_punctuation() {
        let (pool, _d) = pool().await;
        for (id, name) in [
            (1, "24/7 SCOOBY DOO"),
            (2, "Spider-Man Toons"),
            (3, "US: Law & Order"),
            (4, "Music Channel"),
            (5, "What's New Scooby-Doo?"),
        ] {
            channel(&pool, id, id, name, None, None, 1).await;
        }
        let ids = |q: &str| {
            let pool = pool.clone();
            let q = q.to_string();
            async move {
                let opts = ListOpts {
                    q: Some(q),
                    ..Default::default()
                };
                let mut ids: Vec<i64> = list_live(&pool, &opts)
                    .await
                    .unwrap()
                    .items
                    .iter()
                    .map(|c| c.stream_id)
                    .collect();
                ids.sort_unstable();
                ids
            }
        };
        assert_eq!(ids("scooby-doo").await, [1, 5]);
        assert_eq!(ids("scooby doo").await, [1, 5]);
        assert_eq!(ids("scoobydoo").await, [1, 5]);
        assert_eq!(ids("spiderman").await, [2]);
        assert_eq!(ids("spider man").await, [2]);
        assert_eq!(ids("law and order").await, [3]);
        assert_eq!(ids("law & order").await, [3]);
        assert_eq!(ids("whats new").await, [5]);
        assert_eq!(
            ids("us").await,
            [3],
            "a short word starts a word: not \"Music\""
        );
        assert_eq!(ids("batman").await, Vec::<i64>::new());
    }

    #[tokio::test]
    async fn programme_search_puts_title_hits_first() {
        let (pool, _d) = pool().await;
        channel(&pool, 1, 1, "Alpha", None, Some("a"), 1).await;
        channel(&pool, 2, 2, "Beta", None, Some("b"), 1).await;
        exec(
            &pool,
            "INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title, description) VALUES
               ('a', '2026-05-23T01:00:00.000Z', '2026-05-23T02:00:00.000Z', 'Cartoon Hour', 'Scooby-Doo and friends'),
               ('b', '2026-05-23T01:00:00.000Z', '2026-05-23T02:00:00.000Z', 'Scooby Doo, Where Are You!', NULL);",
        )
        .await;
        let (f, t) = ("2026-05-23T00:00:00.000Z", "2026-05-24T00:00:00.000Z");
        let r = epg_search(&pool, f, t, "scooby-doo", &[], None)
            .await
            .unwrap();
        let titles: Vec<_> = r
            .hits
            .iter()
            .map(|h| h.programme.title.as_deref())
            .collect();
        assert_eq!(
            titles,
            [Some("Scooby Doo, Where Are You!"), Some("Cartoon Hour")]
        );
        assert_eq!(r.total, 2);
    }

    #[tokio::test]
    async fn search_returns_exactly_the_matches_with_grid_aligned_program_index() {
        let (pool, _d) = pool().await;
        exec(
            &pool,
            "WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM c WHERE i < 199)
             INSERT INTO channels (stream_id, num, name, epg_channel_id, category_id, fetched_at)
             SELECT i + 1, i + 1, 'Channel ' || i, 'c' || i, 1, 'x' FROM c;
             WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM c WHERE i < 199),
               p(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM p WHERE j < 299)
             INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title, description)
             SELECT 'c' || i,
               strftime('%Y-%m-%dT%H:%M:%fZ', '2026-05-23T00:00:00', '+' || (j * 2304) || ' seconds'),
               strftime('%Y-%m-%dT%H:%M:%fZ', '2026-05-23T00:00:00', '+' || ((j + 1) * 2304) || ' seconds'),
               CASE WHEN i = 5 AND j = 7 THEN 'Evening News' ELSE 'Filler Show' END,
               CASE WHEN i = 5 AND j = 20 THEN 'Breaking news at ten' ELSE 'nothing to see' END
             FROM c, p;",
        )
        .await;
        let (f, t) = ("2026-05-23T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
        let r = epg_search(&pool, f, t, "news", &[], None).await.unwrap();
        assert_eq!((r.total, r.hits.len()), (2, 2));
        let mut idx: Vec<i64> = r.hits.iter().map(|h| h.program_index).collect();
        idx.sort_unstable();
        assert_eq!(idx, [7, 20]);
        assert!(
            r.hits
                .iter()
                .all(|h| h.stream_id == 6 && h.channel_name == "Channel 5")
        );
        assert!(
            r.hits
                .iter()
                .any(|h| h.programme.title.as_deref() == Some("Evening News"))
        );
        assert!(
            r.hits
                .iter()
                .any(|h| h.programme.description.as_deref() == Some("Breaking news at ten"))
        );
        assert_eq!(
            epg_search(&pool, f, t, "%", &[], None).await.unwrap().total,
            0
        );
        assert_eq!(
            epg_search(&pool, f, t, "   ", &[], None)
                .await
                .unwrap()
                .total,
            0
        );
    }

    #[tokio::test]
    async fn guide_scope_matches_the_ts_text_and_skips_unchanged_writes() {
        let (pool, _d) = pool().await;
        remember_guide_scope(&pool, &[9, 3], None, true, "t1")
            .await
            .unwrap();
        let (v, ts) = crate::sync::get_state(&pool, GUIDE_SCOPE_KEY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(v, r#"{"categoryIds":[3,9],"limit":500,"hasEpg":true}"#);
        remember_guide_scope(&pool, &[3, 9], Some(500), true, "t2")
            .await
            .unwrap();
        assert_eq!(
            crate::sync::get_state(&pool, GUIDE_SCOPE_KEY)
                .await
                .unwrap()
                .unwrap()
                .1,
            ts
        );
        remember_guide_scope(&pool, &[3], Some(80), false, "t3")
            .await
            .unwrap();
        assert_eq!(
            crate::sync::get_state(&pool, GUIDE_SCOPE_KEY)
                .await
                .unwrap()
                .unwrap(),
            (
                r#"{"categoryIds":[3],"limit":80,"hasEpg":false}"#.to_string(),
                "t3".to_string()
            )
        );
    }

    /// Grid, search, now/next and channel windows on the synced S2 scenario DB
    /// (with one feed-check override) equal what the TS queries returned
    /// (epg-goldens.json "api", written by the TS stack before S8).
    #[tokio::test]
    async fn queries_on_the_scenario_db_match_the_ts_goldens() {
        // Two cases differ from the TS on purpose: a search term matches by
        // words (`word_match`), so "US:" also finds "US CMT (S)" and "e" needs
        // a word starting with "e".
        let golden = crate::testpanel::json_fixture("epg-goldens.json");
        let api = &golden["api"];
        let scenario = crate::testpanel::Scenario::start().await;
        for i in 0..scenario.steps() {
            scenario.run_step(i).await;
        }
        let pool = &scenario.sync.pool;
        exec(
            pool,
            "INSERT INTO channel_feed_checks (stream_id, verdict, listed_epg_id, actual_epg_id, checked_at)
             VALUES (200163566, 'mislabeled', 'showtime.us', 'cinemaxclassics.us', '2026-10-15T03:20:00.000Z')",
        )
        .await;
        let ids_of = |v: &serde_json::Value| -> Vec<i64> {
            v.as_array().map_or(Vec::new(), |a| {
                a.iter().map(|x| x.as_i64().unwrap()).collect()
            })
        };
        for case in api["grid"].as_array().unwrap() {
            let (o, w) = (&case["opts"], &case["window"]);
            let opts = GridOpts {
                category_id: o["categoryId"].as_i64(),
                category_ids: ids_of(&o["categoryIds"]),
                q: o["q"].as_str().map(String::from),
                has_epg_only: o["hasEpgOnly"].as_bool().unwrap_or(false),
                limit: o["limit"].as_i64(),
            };
            let rows = epg_grid(
                pool,
                w["from"].as_str().unwrap(),
                w["to"].as_str().unwrap(),
                &opts,
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::to_value(rows).unwrap(),
                case["rows"],
                "grid {o}"
            );
        }
        for case in api["search"].as_array().unwrap() {
            let (o, w) = (&case["opts"], &case["window"]);
            let r = epg_search(
                pool,
                w["from"].as_str().unwrap(),
                w["to"].as_str().unwrap(),
                o["q"].as_str().unwrap(),
                &ids_of(&o["categoryIds"]),
                o["limit"].as_i64(),
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::to_value(r).unwrap(),
                case["result"],
                "search {o}"
            );
        }
        let now = epg_now(
            pool,
            &ids_of(&api["now"]["ids"]),
            "2026-10-15T03:20:00.000Z",
        )
        .await
        .unwrap();
        assert_eq!(serde_json::to_value(now).unwrap(), api["now"]["rows"]);
        for case in api["channel"].as_array().unwrap() {
            let rows = epg_channel_window(
                pool,
                case["id"].as_i64().unwrap(),
                "2026-10-14T00:00:00.000Z",
                "2026-10-16T00:00:00.000Z",
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::to_value(rows).unwrap(),
                case["rows"],
                "channel {}",
                case["id"]
            );
        }
    }
}
