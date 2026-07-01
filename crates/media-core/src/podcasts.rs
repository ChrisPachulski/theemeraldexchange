//! Podcast subscriptions: fetch an RSS feed, parse channel + episodes, and
//! upsert into `podcasts`/`podcast_episodes`. Episodes play straight from
//! their enclosure URLs (remote audio; nothing is downloaded server-side).

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Feed {
    pub title: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub episodes: Vec<FeedEpisode>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct FeedEpisode {
    pub guid: String,
    pub title: String,
    pub audio_url: String,
    pub published_at: Option<String>,
    pub duration_secs: Option<i64>,
    pub description: Option<String>,
}

/// `itunes:duration` is either plain seconds (`"754"`) or clock-style
/// (`"1:02:03"` / `"62:03"`). Anything else → None.
pub fn parse_itunes_duration(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() > 3 {
        return None;
    }
    let mut total: i64 = 0;
    for part in &parts {
        total = total
            .checked_mul(60)?
            .checked_add(part.trim().parse().ok()?)?;
    }
    Some(total)
}

/// RFC2822 `pubDate` → RFC3339 for lexicographic sorting; unparseable → None.
pub fn parse_pub_date(raw: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc2822(raw.trim())
        .ok()
        .map(|d| d.to_rfc3339())
}

/// Apply one text/CDATA node to whatever field the parser is inside. First
/// value wins per field (feeds sometimes repeat title-ish tags).
fn apply_text(feed: &mut Feed, item: &mut Option<FeedEpisode>, field: &mut Field, text: String) {
    if text.is_empty() {
        *field = Field::None;
        return;
    }
    match (&field, item.as_mut()) {
        (Field::Title, Some(ep)) if ep.title.is_empty() => ep.title = text,
        (Field::Title, None) if feed.title.is_empty() => feed.title = text,
        (Field::Description, Some(ep)) if ep.description.is_none() => ep.description = Some(text),
        (Field::Description, None) if feed.description.is_none() => feed.description = Some(text),
        (Field::Guid, Some(ep)) if ep.guid.is_empty() => ep.guid = text,
        (Field::PubDate, Some(ep)) if ep.published_at.is_none() => {
            ep.published_at = parse_pub_date(&text)
        }
        (Field::Duration, Some(ep)) if ep.duration_secs.is_none() => {
            ep.duration_secs = parse_itunes_duration(&text)
        }
        (Field::ImageUrl, None) if feed.image_url.is_none() => feed.image_url = Some(text),
        _ => {}
    }
    *field = Field::None;
}

/// Which text node the parser is currently inside (channel- or item-level).
#[derive(PartialEq)]
enum Field {
    None,
    Title,
    Description,
    Guid,
    PubDate,
    Duration,
    ImageUrl,
}

/// Pull-parse an RSS document. Namespaced tags are matched on their raw
/// prefixed names (`itunes:duration`) — the handful of feed dialects in the
/// wild all use the conventional prefixes. Items without an enclosure URL are
/// skipped (nothing to play); a missing guid falls back to the audio URL.
pub fn parse_rss(xml: &str) -> Result<Feed, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut feed = Feed::default();
    let mut item: Option<FeedEpisode> = None;
    let mut in_channel_image = false;
    let mut field = Field::None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.name();
                let name = name.as_ref();
                let attr = |key: &[u8]| -> Option<String> {
                    e.attributes().flatten().find_map(|a| {
                        (a.key.as_ref() == key)
                            .then(|| a.unescape_value().ok().map(|v| v.into_owned()))
                            .flatten()
                    })
                };
                match name {
                    b"item" => item = Some(FeedEpisode::default()),
                    b"title" => field = Field::Title,
                    b"description" | b"itunes:summary" => field = Field::Description,
                    b"guid" => field = Field::Guid,
                    b"pubDate" => field = Field::PubDate,
                    b"itunes:duration" => field = Field::Duration,
                    b"enclosure" => {
                        if let (Some(ep), Some(url)) = (item.as_mut(), attr(b"url"))
                            && ep.audio_url.is_empty()
                        {
                            ep.audio_url = url;
                        }
                    }
                    b"itunes:image" => {
                        if item.is_none()
                            && feed.image_url.is_none()
                            && let Some(href) = attr(b"href")
                        {
                            feed.image_url = Some(href);
                        }
                    }
                    b"image" => in_channel_image = item.is_none(),
                    b"url" if in_channel_image => field = Field::ImageUrl,
                    _ => field = Field::None,
                }
            }
            Ok(Event::Text(t)) => {
                let text = t
                    .unescape()
                    .map(|c| c.trim().to_string())
                    .unwrap_or_default();
                apply_text(&mut feed, &mut item, &mut field, text);
            }
            Ok(Event::CData(t)) => {
                let text = String::from_utf8_lossy(t.as_ref()).trim().to_string();
                apply_text(&mut feed, &mut item, &mut field, text);
            }
            Ok(Event::End(e)) => {
                match e.name().as_ref() {
                    b"item" => {
                        if let Some(mut ep) = item.take()
                            && !ep.audio_url.is_empty()
                        {
                            if ep.guid.is_empty() {
                                ep.guid = ep.audio_url.clone();
                            }
                            if ep.title.is_empty() {
                                ep.title = "Untitled episode".to_string();
                            }
                            feed.episodes.push(ep);
                        }
                    }
                    b"image" => in_channel_image = false,
                    _ => {}
                }
                field = Field::None;
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("rss parse error: {e}")),
        }
        buf.clear();
    }

    if feed.title.is_empty() && feed.episodes.is_empty() {
        return Err("not an RSS feed (no channel title, no episodes)".to_string());
    }
    if feed.title.is_empty() {
        feed.title = "Untitled podcast".to_string();
    }
    Ok(feed)
}

/// Fetch and parse a feed URL (http/https only).
pub async fn fetch_feed(url: &str) -> Result<Feed, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("feed_url must be http(s)".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let xml = client
        .get(url)
        .header("User-Agent", "theemeraldexchange v1")
        .send()
        .await
        .map_err(|e| format!("feed fetch failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("feed body failed: {e}"))?;
    parse_rss(&xml)
}

/// Write a fetched feed's channel + episodes for `podcast_id`. Episodes upsert
/// on `(podcast_id, guid)`; returns the number of episodes upserted.
pub async fn store_feed(db: &Db, podcast_id: i64, feed: &Feed) -> AppResult<usize> {
    sqlx::query(
        "UPDATE podcasts SET title = ?, description = ?, image_url = ?, refreshed_at = ? \
         WHERE id = ?",
    )
    .bind(&feed.title)
    .bind(&feed.description)
    .bind(&feed.image_url)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(podcast_id)
    .execute(&db.pool)
    .await?;

    let mut upserted = 0usize;
    for ep in &feed.episodes {
        sqlx::query(
            "INSERT INTO podcast_episodes \
             (podcast_id, guid, title, audio_url, published_at, duration_secs, description) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(podcast_id, guid) DO UPDATE SET title = excluded.title, \
             audio_url = excluded.audio_url, published_at = excluded.published_at, \
             duration_secs = excluded.duration_secs, description = excluded.description",
        )
        .bind(podcast_id)
        .bind(&ep.guid)
        .bind(&ep.title)
        .bind(&ep.audio_url)
        .bind(&ep.published_at)
        .bind(ep.duration_secs)
        .bind(&ep.description)
        .execute(&db.pool)
        .await?;
        upserted += 1;
    }
    Ok(upserted)
}

/// Refresh one stored podcast from its feed URL.
pub async fn refresh_podcast(db: &Db, podcast_id: i64) -> AppResult<usize> {
    let feed_url: Option<String> = sqlx::query_scalar("SELECT feed_url FROM podcasts WHERE id = ?")
        .bind(podcast_id)
        .fetch_optional(&db.pool)
        .await?;
    let Some(feed_url) = feed_url else {
        return Err(AppError::NotFound);
    };
    let feed = fetch_feed(&feed_url).await.map_err(AppError::BadRequest)?;
    store_feed(db, podcast_id, &feed).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Cast</title>
    <description>A show about tests.</description>
    <image><url>https://example.com/cover.png</url></image>
    <item>
      <title>Episode One</title>
      <guid isPermaLink="false">ep-1</guid>
      <description><![CDATA[First <b>episode</b>]]></description>
      <pubDate>Mon, 01 Jun 2026 10:00:00 +0000</pubDate>
      <itunes:duration>1:02:03</itunes:duration>
      <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="123"/>
    </item>
    <item>
      <title>No audio here</title>
      <guid>ep-skip</guid>
    </item>
    <item>
      <enclosure url="https://example.com/ep2.mp3" type="audio/mpeg"/>
      <itunes:duration>754</itunes:duration>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn parses_channel_and_episodes() {
        let feed = parse_rss(SAMPLE).unwrap();
        assert_eq!(feed.title, "Test Cast");
        assert_eq!(feed.description.as_deref(), Some("A show about tests."));
        assert_eq!(
            feed.image_url.as_deref(),
            Some("https://example.com/cover.png")
        );
        // The enclosure-less item is skipped; the guid-less one falls back to
        // its audio URL and gets a placeholder title.
        assert_eq!(feed.episodes.len(), 2);
        let ep1 = &feed.episodes[0];
        assert_eq!(ep1.guid, "ep-1");
        assert_eq!(ep1.title, "Episode One");
        assert_eq!(ep1.audio_url, "https://example.com/ep1.mp3");
        assert_eq!(ep1.duration_secs, Some(3723));
        assert!(
            ep1.published_at
                .as_deref()
                .unwrap()
                .starts_with("2026-06-01")
        );
        assert_eq!(ep1.description.as_deref(), Some("First <b>episode</b>"));
        let ep2 = &feed.episodes[1];
        assert_eq!(ep2.guid, "https://example.com/ep2.mp3");
        assert_eq!(ep2.title, "Untitled episode");
        assert_eq!(ep2.duration_secs, Some(754));
    }

    #[test]
    fn itunes_image_wins_when_no_image_url() {
        let xml = r#"<rss xmlns:itunes="x"><channel><title>T</title>
            <itunes:image href="https://example.com/i.jpg"/>
            <item><enclosure url="https://e.com/a.mp3"/></item>
        </channel></rss>"#;
        let feed = parse_rss(xml).unwrap();
        assert_eq!(feed.image_url.as_deref(), Some("https://example.com/i.jpg"));
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse_rss("<html><body>not rss</body></html>").is_err());
        assert!(parse_rss("{\"json\": true}").is_err());
    }

    #[test]
    fn durations_parse_all_shapes() {
        assert_eq!(parse_itunes_duration("754"), Some(754));
        assert_eq!(parse_itunes_duration("62:03"), Some(3723));
        assert_eq!(parse_itunes_duration("1:02:03"), Some(3723));
        assert_eq!(parse_itunes_duration(""), None);
        assert_eq!(parse_itunes_duration("abc"), None);
    }
}
