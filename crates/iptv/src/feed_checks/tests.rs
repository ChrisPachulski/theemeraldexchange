//! iptvFeedChecks.test.ts carried over, plus the seeding helpers the
//! feed_verify and feed_sweep tests share.

use super::*;
use crate::catalog::tests::pool;
use crate::catalog::{GridOpts, epg_grid, epg_now};
use crate::siblings::sibling_feeds;

pub(crate) fn ms(iso: &str) -> i64 {
    DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .timestamp_millis()
}

/// Upsert a channel (category 123 unless given) and set its epg_resolved_id.
pub(crate) async fn chan(
    pool: &SqlitePool,
    id: i64,
    num: i64,
    name: &str,
    tvg: Option<&str>,
    resolved: Option<&str>,
) {
    chan_in(pool, id, num, name, tvg, resolved, 123).await
}

pub(crate) async fn chan_in(
    pool: &SqlitePool,
    id: i64,
    num: i64,
    name: &str,
    tvg: Option<&str>,
    resolved: Option<&str>,
    cat: i64,
) {
    sqlx::query(
        "INSERT INTO channels (stream_id, num, name, epg_channel_id, category_id, fetched_at) \
         VALUES (?, ?, ?, ?, ?, '2026-10-10T00:00:00Z') \
         ON CONFLICT(stream_id) DO UPDATE SET num = excluded.num, name = excluded.name, \
           epg_channel_id = excluded.epg_channel_id, category_id = excluded.category_id",
    )
    .bind(id)
    .bind(num)
    .bind(name)
    .bind(tvg)
    .bind(cat)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE channels SET epg_resolved_id = ? WHERE stream_id = ?")
        .bind(resolved)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

pub(crate) async fn prog(pool: &SqlitePool, channel: &str, start: &str, stop: &str, title: &str) {
    sqlx::query("INSERT OR REPLACE INTO epg_programs (channel_id, start_utc, stop_utc, title) VALUES (?, ?, ?, ?)")
        .bind(channel)
        .bind(start)
        .bind(stop)
        .bind(title)
        .execute(pool)
        .await
        .unwrap();
}

pub(crate) async fn sql(pool: &SqlitePool, q: &str) {
    crate::catalog::tests::exec(pool, q).await
}

pub(crate) async fn check(pool: &SqlitePool, id: i64) -> Option<FeedCheck> {
    get_feed_check(pool, id).await.unwrap()
}

const NOW: &str = "2026-10-10T03:08:00.000Z";

/// The 2026-10-09 incident in miniature: four Showtime streams from three
/// provider sources, two Showtime 2 streams, and an unrelated channel.
async fn seeded() -> (SqlitePool, tempfile::TempDir) {
    let (p, dir) = pool().await;
    for (id, num, name, tvg) in [
        (200163566, 154, "US: Showtime", "showtime.us"),
        (200163567, 204, "US: Showtime 2", "showtime2.us"),
        (5864, 5386, "US Showtime East (S)", "showtime.us"),
        (22597, 7280, "US Showtime (East) (H)", "showtime.us"),
        (22599, 7357, "US Showtime 2 (East) (H)", "showtime2.us"),
        (200163569, 225, "US: Showtime Extreme", "showtimeextreme.us"),
        (200163568, 419, "US: SHOxBET", "shoxbet.us"),
        (900, 1, "CNN", "cnn.us"),
    ] {
        chan(&p, id, num, name, Some(tvg), None).await;
    }
    for (id, title) in [
        ("showtime.us", "My Cousin Vinny"),
        ("showtime2.us", "Blade Runner 2049"),
        ("showtimeextreme.us", "Heat"),
        ("shoxbet.us", "Friday"),
        ("cnn.us", "News"),
    ] {
        prog(
            &p,
            id,
            "2026-10-10T02:00:00.000Z",
            "2026-10-10T04:30:00.000Z",
            title,
        )
        .await;
    }
    (p, dir)
}

fn not_dead(_: i64) -> bool {
    false
}

async fn candidates(
    p: &SqlitePool,
    subject: i64,
    epg: &str,
    is_dead: &(dyn Fn(i64) -> bool + Sync),
    exclude: &[i64],
) -> Vec<Candidate> {
    let o = CandidateOpts {
        is_dead,
        exclude,
        max_family: 4,
        now_ms: ms(NOW),
    };
    feed_check_candidates(p, subject, epg, &o).await.unwrap()
}

async fn sibling_ids(p: &SqlitePool, subject: i64, epg: &str) -> Vec<i64> {
    candidates(p, subject, epg, &not_dead, &[])
        .await
        .into_iter()
        .filter(|c| c.role == Role::Sibling)
        .map(|c| c.stream_id)
        .collect()
}

async fn mislabel(p: &SqlitePool, at: i64) {
    let c = FeedCheck::new(
        200163566,
        "mislabeled",
        Some("showtime.us"),
        Some("showtime2.us"),
        Some(22599),
        Some(0.97),
    );
    record_feed_check(p, &c, at).await.unwrap();
}

fn cand(stream_id: i64, epg: &str, role: Role) -> Candidate {
    Candidate {
        stream_id,
        epg_id: epg.into(),
        role,
    }
}

#[test]
fn relates_channels_of_one_brand_and_only_those() {
    assert_eq!(
        epg_id_family("showtime2west.us"),
        Family {
            base: "showtime2west".into(),
            root: "showtime".into(),
            country: "us".into()
        }
    );
    assert!(related_epg_ids("showtime.us", "showtime2.us"));
    assert!(related_epg_ids("showtime.us", "showtimeextreme.us"));
    assert!(related_epg_ids("hbozone.us", "hbocomedy.us"));
    assert!(related_epg_ids("showtime.us", "shoxbet.us")); // SHOxBET is a Showtime channel
    assert!(!related_epg_ids("showtime.us", "starz.us"));
    assert!(!related_epg_ids("cnn.us", "cnbc.us"));
    assert!(!related_epg_ids("showtime.us", "showtime.ca"));
    assert!(!related_epg_ids("showtime.us", "showtime.us"));
}

#[tokio::test]
async fn lists_a_mislabeled_stream_with_the_programmes_it_really_carries() {
    let (p, _d) = seeded().await;
    let title =
        |rows: &[crate::catalog::NowRow]| rows[0].current.as_ref().and_then(|c| c.title.clone());
    assert_eq!(
        title(&epg_now(&p, &[200163566], NOW).await.unwrap()).as_deref(),
        Some("My Cousin Vinny")
    );

    mislabel(&p, ms(NOW)).await;
    assert_eq!(
        effective_epg_id(&p, 200163566).await.unwrap().as_deref(),
        Some("showtime2.us")
    );
    assert_eq!(
        title(&epg_now(&p, &[200163566], NOW).await.unwrap()).as_deref(),
        Some("Blade Runner 2049")
    );
    let o = GridOpts {
        has_epg_only: true,
        ..GridOpts::default()
    };
    let grid = epg_grid(
        &p,
        "2026-10-10T02:00:00.000Z",
        "2026-10-10T04:00:00.000Z",
        &o,
    )
    .await
    .unwrap();
    let titles = |id: i64| -> Vec<String> {
        grid.iter()
            .find(|r| r.stream_id == id)
            .unwrap()
            .programmes
            .iter()
            .filter_map(|p| p.title.clone())
            .collect()
    };
    assert_eq!(titles(200163566), ["Blade Runner 2049"]);
    // The other Showtime streams keep their own listing.
    assert_eq!(titles(5864), ["My Cousin Vinny"]);
}

#[tokio::test]
async fn drops_the_override_once_the_provider_re_maps_the_stream() {
    let (p, _d) = seeded().await;
    mislabel(&p, ms(NOW)).await;
    sql(
        &p,
        "UPDATE channels SET epg_channel_id = 'showtimeshowcase.us' WHERE stream_id = 200163566",
    )
    .await;
    assert_eq!(
        effective_epg_id(&p, 200163566).await.unwrap().as_deref(),
        Some("showtimeshowcase.us")
    );
}

#[tokio::test]
async fn moves_a_mislabeled_stream_to_the_failover_list_of_the_channel_it_carries() {
    let (p, _d) = seeded().await;
    assert!(
        sibling_feeds(&p, "5864")
            .await
            .unwrap()
            .contains(&"200163566".to_string())
    );
    mislabel(&p, ms(NOW)).await;
    assert!(
        !sibling_feeds(&p, "5864")
            .await
            .unwrap()
            .contains(&"200163566".to_string())
    );
    assert!(
        sibling_feeds(&p, "22599")
            .await
            .unwrap()
            .contains(&"200163566".to_string())
    );
}

#[tokio::test]
async fn orders_candidates_another_source_then_related_by_closeness_then_a_second_sibling() {
    let (p, _d) = seeded().await;
    assert_eq!(
        candidates(&p, 200163566, "showtime.us", &not_dead, &[]).await,
        [
            cand(5864, "showtime.us", Role::Sibling),
            cand(22599, "showtime2.us", Role::Family),
            cand(200163568, "shoxbet.us", Role::Family),
            cand(200163569, "showtimeextreme.us", Role::Family),
            cand(22597, "showtime.us", Role::Sibling),
        ]
    );
}

#[tokio::test]
async fn compares_the_other_coast_first_ahead_of_closer_named_channels() {
    let (p, _d) = seeded().await;
    chan(
        &p,
        5866,
        5388,
        "US Showtime West (S)",
        Some("showtimewest.us"),
        None,
    )
    .await;
    prog(
        &p,
        "showtimewest.us",
        "2026-10-10T02:00:00.000Z",
        "2026-10-10T04:30:00.000Z",
        "The Firm",
    )
    .await;
    let ids: Vec<String> = candidates(&p, 200163566, "showtime.us", &not_dead, &[])
        .await
        .into_iter()
        .map(|c| c.epg_id)
        .collect();
    assert_eq!(
        ids,
        [
            "showtime.us",
            "showtimewest.us",
            "showtime2.us",
            "shoxbet.us",
            "showtimeextreme.us",
            "showtime.us"
        ]
    );
}

/// 2026-10-25: the provider files "Showtime Women (West) (H)" under the East
/// id, so West streams resolve to no listing; they still stand for the West
/// twin, ahead of the other related channels.
#[tokio::test]
async fn takes_an_unlisted_west_stream_of_the_channel_for_the_west_twin() {
    let (p, _d) = seeded().await;
    for (id, num, name) in [
        (22598, 7281, "US Showtime (West) (H)"),
        (400124927, 1490, "US: SHOWTIME WEST"),
        (22600, 7358, "US Showtime 2 (West) (H)"),
        (300, 9000, "US West Palm Beach Showtime"),
    ] {
        chan(&p, id, num, name, None, None).await;
    }
    let west_of = async |p: &SqlitePool| -> Vec<Candidate> {
        candidates(p, 200163566, "showtime.us", &not_dead, &[])
            .await
            .into_iter()
            .filter(|c| c.epg_id == "showtimewest.us")
            .collect()
    };
    // No West schedule: nothing to tell the West picture by.
    assert_eq!(west_of(&p).await, []);

    prog(
        &p,
        "showtimewest.us",
        "2026-10-10T02:00:00.000Z",
        "2026-10-10T04:30:00.000Z",
        "The Firm",
    )
    .await;
    assert_eq!(
        candidates(&p, 200163566, "showtime.us", &not_dead, &[]).await,
        [
            cand(5864, "showtime.us", Role::Sibling),
            // Two West streams from two provider sources, then three slots left.
            cand(400124927, "showtimewest.us", Role::Family),
            cand(22598, "showtimewest.us", Role::Family),
            cand(22599, "showtime2.us", Role::Family),
            cand(200163568, "shoxbet.us", Role::Family),
            cand(22597, "showtime.us", Role::Sibling),
        ]
    );
    // An East-named subject finds them too; a dead or excluded one is passed over.
    let dead = |id: i64| id == 400124927;
    let o = candidates(&p, 22597, "showtime.us", &dead, &[]).await;
    assert_eq!(
        o.iter()
            .filter(|c| c.epg_id == "showtimewest.us")
            .collect::<Vec<_>>(),
        [&cand(22598, "showtimewest.us", Role::Family)]
    );
    let o = candidates(&p, 22597, "showtime.us", &not_dead, &[400124927, 22598]).await;
    assert!(!o.iter().any(|c| c.epg_id == "showtimewest.us"));

    // Found by the West id's name, not the subject's: a short or differently
    // named subject, or a West stream the guide lists under the East id.
    chan(&p, 40, 30, "US: FX", Some("fx.us"), None).await;
    chan(&p, 41, 31, "US FX (East) (H)", Some("fx.us"), None).await;
    chan(&p, 42, 32, "US FX (West) (H)", None, None).await;
    chan(&p, 43, 33, "US: FX (West)", Some("fx.us"), None).await;
    prog(
        &p,
        "fx.us",
        "2026-10-10T02:00:00.000Z",
        "2026-10-10T04:30:00.000Z",
        "Alien",
    )
    .await;
    prog(
        &p,
        "fxwest.us",
        "2026-10-10T02:00:00.000Z",
        "2026-10-10T04:30:00.000Z",
        "Aliens",
    )
    .await;
    for subject in [40, 43] {
        let o = candidates(&p, subject, "fx.us", &not_dead, &[]).await;
        assert!(
            o.contains(&cand(42, "fxwest.us", Role::Family)),
            "{subject}: {o:?}"
        );
    }

    // A West stream with a listing of its own is the related channel already.
    chan(
        &p,
        5866,
        5388,
        "US Showtime West (S)",
        Some("showtimewest.us"),
        None,
    )
    .await;
    assert_eq!(
        west_of(&p).await,
        [cand(5866, "showtimewest.us", Role::Family)]
    );
}

#[tokio::test]
async fn prefers_a_verified_stream_and_skips_dead_or_excluded_ones() {
    let (p, _d) = seeded().await;
    let c = FeedCheck::new(
        22597,
        "match",
        Some("showtime.us"),
        None,
        Some(5864),
        Some(0.98),
    );
    record_feed_check(&p, &c, ms(NOW)).await.unwrap();
    let ids: Vec<i64> = candidates(
        &p,
        200163566,
        "showtime.us",
        &|id| id == 22599,
        &[200163569],
    )
    .await
    .into_iter()
    .map(|c| c.stream_id)
    .collect();
    assert_eq!(ids, [22597, 200163567, 200163568, 5864]);
}

#[tokio::test]
async fn does_not_rank_a_stream_verified_under_an_old_listing_as_verified() {
    let (p, _d) = seeded().await;
    let c = FeedCheck::new(
        22597,
        "match",
        Some("showtimeeast.us"),
        None,
        Some(5864),
        Some(0.98),
    );
    record_feed_check(&p, &c, ms(NOW)).await.unwrap();
    assert_eq!(
        sibling_ids(&p, 200163566, "showtime.us").await,
        [5864, 22597]
    );
}

#[tokio::test]
async fn takes_as_siblings_only_streams_vouched_to_be_the_channel() {
    let (p, _d) = seeded().await;
    // WTAE Pittsburgh was "confirmed" against WPVI Philadelphia during Good
    // Morning America: both are name-resolved to abc5.us, KOCO's schedule.
    chan(
        &p,
        200168333,
        1189,
        "US: ABC 4 Pittsburgh (WTAE)",
        Some("abcwtae.us"),
        Some("abc5.us"),
    )
    .await;
    chan(
        &p,
        6838,
        4506,
        "US abc 6 (WPVI) Philadelphia (A)",
        Some("abcwpvi.us"),
        Some("abc5.us"),
    )
    .await;
    chan(
        &p,
        200168304,
        1025,
        "US: ABC 5 Oklahoma City (KOCO)",
        Some("koco-dt.us_locals1"),
        Some("abc5.us"),
    )
    .await;
    assert_eq!(
        sibling_ids(&p, 200168333, "abc5.us").await,
        Vec::<i64>::new()
    );
    // The provider's own abc5.us tag vouches; so does sharing WTAE's own tag.
    chan(&p, 9001, 9, "US ABC 5 KOCO (A)", Some("abc5.us"), None).await;
    chan(
        &p,
        9002,
        10,
        "US WTAE (A)",
        Some("abcwtae.us"),
        Some("abc5.us"),
    )
    .await;
    assert_eq!(sibling_ids(&p, 200168333, "abc5.us").await, [9001, 9002]);
    // A West feed name-resolved to the East id is not "US: Showtime" by name.
    chan(
        &p,
        22598,
        7281,
        "US Showtime (West) (H)",
        Some("showtimewest.us"),
        Some("showtime.us"),
    )
    .await;
    assert_eq!(
        sibling_ids(&p, 200163566, "showtime.us").await,
        [5864, 22597]
    );
}

#[tokio::test]
async fn finds_siblings_under_an_id_listing_the_same_schedule() {
    let (p, _d) = seeded().await;
    chan(&p, 200163492, 120, "US: CMT", Some("cmt.us"), None).await;
    chan(&p, 30877, 3000, "US CMT (S)", None, Some("cmt.hd.us2")).await;
    chan(
        &p,
        107464,
        3001,
        "US CMT (West) (H)",
        None,
        Some("cmt.hd.us2"),
    )
    .await;
    chan(&p, 136124, 3002, "CA CMT (FL)", None, Some("cmt.hd.us2")).await;
    assert_eq!(
        sibling_ids(&p, 200163492, "cmt.us").await,
        Vec::<i64>::new()
    );
    let hour = ms("2026-10-10T03:00:00.000Z");
    for h in -13i64..=13 {
        for id in ["cmt.us", "cmt.hd.us2"] {
            let title = format!(
                "{}Show {}",
                if id == "cmt.us" { "Live: " } else { "" },
                (h + 13) % 6
            );
            prog(
                &p,
                id,
                &iso_ms(hour + h * HOUR_MS),
                &iso_ms(hour + (h + 1) * HOUR_MS),
                &title,
            )
            .await;
        }
    }
    // Same name, same coast: the CMT (S) stream only.
    assert_eq!(sibling_ids(&p, 200163492, "cmt.us").await, [30877]);
}

#[tokio::test]
async fn compares_listings_by_programme_not_spelling_and_ignores_placeholders() {
    let (p, _d) = seeded().await;
    let differ = async |a: &str, b: &str| {
        for (id, title) in [("a.us", a), ("b.us", b)] {
            prog(
                &p,
                id,
                "2026-10-10T02:00:00.000Z",
                "2026-10-10T04:30:00.000Z",
                title,
            )
            .await;
        }
        listings_differ(&p, "a.us", "b.us", ms(NOW)).await.unwrap()
    };
    assert!(!differ("T20 Cricket", "T20 Cricket : India vs. West Indies").await);
    assert!(
        !differ(
            "Good Morning America Category: News/Public affairs/Talk/Variety/Series",
            "Good Morning America"
        )
        .await
    );
    assert!(!differ("Live: WWE NXT", "WWE NXT").await);
    assert!(
        differ(
            "College Football : Florida at Texas",
            "College Football : Washington at Purdue"
        )
        .await
    );
    assert!(
        !differ(
            "Men's Health - All-Natural Secret for Prostate Health",
            "SIGN OFF"
        )
        .await
    );
    assert!(
        !differ(
            "Paid Programming",
            "Next game: Chicago Bears at Atlanta Falcons at 10/18/2026 01:00 PM (US/Eastern)"
        )
        .await
    );
    // EPIX HITS on epix.us is still caught.
    assert!(differ("The Last Samurai", "Transformers One").await);
}

#[tokio::test]
async fn knows_what_a_fresh_verdict_says_the_stream_carries() {
    let (p, _d) = seeded().await;
    mislabel(&p, ms(NOW)).await;
    let c = check(&p, 200163566).await.unwrap();
    assert_eq!(
        known_carried_epg_id(Some(&c), Some("showtime.us")).as_deref(),
        Some("showtime2.us")
    );
    assert_eq!(
        known_carried_epg_id(Some(&c), Some("showtimeshowcase.us")),
        None
    );
    assert!(feed_check_is_fresh(
        &c,
        Some("showtime.us"),
        ms(NOW) + 23 * HOUR_MS
    ));
    assert!(!feed_check_is_fresh(
        &c,
        Some("showtime.us"),
        ms(NOW) + 25 * HOUR_MS
    ));
    // A verdict about another listing is no verdict on the stream as listed now.
    assert!(!feed_check_is_fresh(
        &c,
        Some("showtimeshowcase.us"),
        ms(NOW) + HOUR_MS
    ));
}

/// The provider re-points streams within days: 200163572 matched East on
/// 2026-10-22 and carried West on 2026-10-25, unchecked under a 7-day match.
#[tokio::test]
async fn trusts_a_match_for_a_day_not_a_week() {
    let mut c = FeedCheck::new(
        200163566,
        "match",
        Some("showtime.us"),
        None,
        Some(5864),
        Some(0.98),
    );
    c.checked_at = iso_ms(ms(NOW));
    assert!(feed_check_is_fresh(
        &c,
        Some("showtime.us"),
        ms(NOW) + 23 * HOUR_MS
    ));
    assert!(!feed_check_is_fresh(
        &c,
        Some("showtime.us"),
        ms(NOW) + 25 * HOUR_MS
    ));
}

#[tokio::test]
async fn retries_a_check_that_compared_nothing_a_day_and_an_hour_later() {
    let (p, _d) = seeded().await;
    let inconclusive = async |reason: Option<&str>| {
        let mut c = FeedCheck::new(
            200163566,
            "inconclusive",
            Some("showtime.us"),
            None,
            None,
            None,
        );
        c.reason = reason.map(Into::into);
        record_feed_check(&p, &c, ms(NOW)).await.unwrap();
    };
    let fresh_at = async |hours: f64| {
        let c = check(&p, 200163566).await.unwrap();
        feed_check_is_fresh(
            &c,
            Some("showtime.us"),
            ms(NOW) + (hours * HOUR_MS as f64) as i64,
        )
    };
    inconclusive(Some("subject capture failed")).await;
    assert_eq!(
        check(&p, 200163566).await.unwrap().reason.as_deref(),
        Some("subject capture failed")
    );
    assert!(fresh_at(24.5).await);
    assert!(!fresh_at(25.5).await);
    // Nothing to compare (no connection opened) and pre-0009 rows keep 6 hours.
    inconclusive(Some(NO_SIBLING_REASON)).await;
    assert!(!fresh_at(6.5).await);
    inconclusive(None).await;
    assert!(!fresh_at(6.5).await);
}

#[test]
fn folds_titles_and_drops_placeholders() {
    assert_eq!(
        norm_title(Some("Live: WWE NXT")).as_deref(),
        Some("wwe nxt")
    );
    assert_eq!(
        norm_title(Some("Good Morning America Category: News")).as_deref(),
        Some("good morning america")
    );
    assert_eq!(norm_title(Some("  TBA ")), None);
    assert_eq!(norm_title(Some("Next game: Bears at Falcons")), None);
    assert_eq!(norm_title(None), None);
    assert_eq!(edit_distance("showtime", "showtime2"), 1);
    assert_eq!(locale_cmp("a1.us", "ab.us"), Ordering::Less);
    assert_eq!(locale_cmp("B.us", "a.us"), Ordering::Greater);
}
