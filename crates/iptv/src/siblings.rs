//! Sibling-feed resolver (iptvSiblingFeeds.ts). One live event is usually
//! carried by several duplicate provider feeds; when the tuned one is a dead
//! placeholder, playback fails over to a sibling. Siblings share the effective
//! guide id or fold to the same feed key. Not the EPG name normalizer
//! (`epg_resolve::normalize_channel_name`), which folds differently.

use std::sync::LazyLock;

use regex::Regex;
use sqlx::SqlitePool;

use crate::catalog::{EFFECTIVE_EPG, LISTED_EPG};

static BRACKETED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\[(][^\])]*[\])]").unwrap());
static QUALIFIERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u:\b)(?:fhd|uhd|hd|sd|4k|8k|2160p?|1080p?|720p?|576p?|480p?|hevc|h\.?265|h\.?264|raw|backup|alt(?:ernate)?|feed\s*[0-9]+|ch\s*[0-9]+)(?-u:\b)",
    )
    .unwrap()
});
static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());

/// Fold a channel name to a feed key: lowercase, drop bracketed tags and the
/// quality/format/backup qualifiers, collapse to single-spaced alphanumerics.
/// "Fox Soccer Plus HD" and "Fox Soccer Plus [Backup]" both give
/// "fox soccer plus".
pub fn sibling_feed_key(name: &str) -> String {
    let s = name.to_lowercase();
    let s = BRACKETED.replace_all(&s, " ");
    let s = QUALIFIERS.replace_all(&s, " ");
    let s = NON_ALNUM.replace_all(&s, " ");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(sqlx::FromRow)]
struct Row {
    stream_id: i64,
    name: String,
    num: Option<i64>,
    listed: Option<String>,
    effective: Option<String>,
}

/// Ordered candidate feeds for `stream_id`: itself first, then every sibling
/// sharing its effective guide id or feed key, by channel number then stream
/// id. A feed a check caught carrying another channel is a sibling of THAT
/// channel and never a name sibling. `[stream_id]` when unknown or non-numeric.
/// Only called on a (re)start, so the whole-table scan is fine.
pub async fn sibling_feeds(pool: &SqlitePool, stream_id: &str) -> Result<Vec<String>, sqlx::Error> {
    let Some(id) = stream_id
        .bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| stream_id.parse::<i64>().ok())
        .flatten()
    else {
        return Ok(vec![stream_id.to_string()]);
    };
    let sql = format!(
        "SELECT stream_id, name, num, {LISTED_EPG} AS listed, {EFFECTIVE_EPG} AS effective FROM channels"
    );
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await?;
    let Some(me) = rows.iter().find(|r| r.stream_id == id) else {
        return Ok(vec![stream_id.to_string()]);
    };
    let epg_of = |r: &Row| r.effective.as_deref().unwrap_or("").trim().to_lowercase();
    let relabeled = |r: &Row| r.effective != r.listed;
    let epg = epg_of(me);
    let key = sibling_feed_key(&me.name);
    let mut siblings: Vec<&Row> = rows
        .iter()
        .filter(|r| {
            if r.stream_id == id {
                return false;
            }
            let r_epg = epg_of(r);
            if !epg.is_empty() && r_epg == epg {
                return true;
            }
            if relabeled(me) || relabeled(r) {
                return false;
            }
            !key.is_empty() && sibling_feed_key(&r.name) == key
        })
        .collect();
    siblings.sort_by_key(|r| r.num.unwrap_or(r.stream_id));
    Ok(std::iter::once(stream_id.to_string())
        .chain(siblings.iter().map(|r| r.stream_id.to_string()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::tests::{channel, exec, pool};

    #[test]
    fn folds_quality_format_and_backup_variants_to_one_key() {
        let key = sibling_feed_key("Fox Soccer Plus");
        for v in [
            "Fox Soccer Plus HD",
            "Fox Soccer Plus FHD",
            "Fox Soccer Plus [Backup]",
            "FOX SOCCER PLUS (1080p)",
            "Fox  Soccer_Plus",
        ] {
            assert_eq!(sibling_feed_key(v), key, "{v}");
        }
        assert_ne!(key, sibling_feed_key("Fox Sports 1"));
    }

    async fn fixture() -> (SqlitePool, tempfile::TempDir) {
        let (pool, dir) = pool().await;
        channel(
            &pool,
            100,
            5,
            "Fox Soccer Plus",
            None,
            Some("foxsoccer.us"),
            1,
        )
        .await;
        channel(
            &pool,
            101,
            6,
            "Fox Soccer Plus HD",
            None,
            Some("foxsoccer.us"),
            1,
        )
        .await;
        channel(&pool, 102, 4, "Fox Soccer Plus [Backup]", None, None, 1).await;
        channel(&pool, 200, 1, "CNN", None, Some("cnn.us"), 1).await;
        (pool, dir)
    }

    #[tokio::test]
    async fn the_tuned_feed_comes_first_then_siblings_by_channel_number() {
        let (pool, _d) = fixture().await;
        assert_eq!(
            sibling_feeds(&pool, "100").await.unwrap(),
            ["100", "102", "101"]
        );
    }

    #[tokio::test]
    async fn siblings_match_by_guide_id_or_feed_key() {
        let (pool, _d) = fixture().await;
        let s = sibling_feeds(&pool, "102").await.unwrap();
        assert_eq!(s[0], "102");
        let mut rest = s[1..].to_vec();
        rest.sort();
        assert_eq!(rest, ["100", "101"]);
    }

    #[tokio::test]
    async fn never_pulls_in_an_unrelated_channel_or_an_unknown_id() {
        let (pool, _d) = fixture().await;
        assert_eq!(sibling_feeds(&pool, "200").await.unwrap(), ["200"]);
        assert_eq!(sibling_feeds(&pool, "999").await.unwrap(), ["999"]);
        assert_eq!(sibling_feeds(&pool, "abc").await.unwrap(), ["abc"]);
    }

    #[tokio::test]
    async fn a_relabeled_feed_is_a_sibling_of_what_it_carries_not_of_its_name() {
        let (pool, _d) = fixture().await;
        // 101 was caught carrying CNN: it joins CNN and leaves Fox Soccer Plus.
        exec(
            &pool,
            "INSERT INTO channel_feed_checks (stream_id, verdict, listed_epg_id, actual_epg_id, checked_at)
             VALUES (101, 'mislabeled', 'foxsoccer.us', 'cnn.us', '2026-10-01T00:00:00Z');",
        )
        .await;
        assert_eq!(sibling_feeds(&pool, "100").await.unwrap(), ["100", "102"]);
        assert_eq!(sibling_feeds(&pool, "200").await.unwrap(), ["200", "101"]);
    }
}
