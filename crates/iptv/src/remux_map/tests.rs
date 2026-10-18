//! iptvLiveRemuxMap.test.ts carried over. The rewrite cases are matched byte
//! for byte against goldens the TS stack wrote (tests/fixtures/remux-goldens.json);
//! the index cases run the real remux registry over a stub ffmpeg.

use super::*;
use crate::remux::Timings;
use crate::remux::tests::{Fake, LIVE, R, remux_with, until};
use serde_json::Value;

// ---- rewrite goldens ---------------------------------------------------------------

#[test]
fn rewrite_matches_the_ts_goldens_byte_for_byte() {
    let raw = include_str!("../../tests/fixtures/remux-goldens.json");
    let goldens: serde_json::Map<String, Value> = serde_json::from_str(raw).unwrap();
    assert_eq!(goldens.len(), 8);
    for (name, calls) in goldens {
        let mut conts = HashMap::new();
        let mut caches: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut n = 0;
        let mut sign = |rid: &str| {
            n += 1;
            format!("TOK({rid}#{n})")
        };
        for (i, call) in calls.as_array().unwrap().iter().enumerate() {
            let s = |k: &str| call[k].as_str().unwrap();
            let cache = call["cache"]
                .as_str()
                .map(|c| caches.entry(c.to_string()).or_default());
            let got = rewrite_remux_manifest(
                s("text"),
                s("streamId"),
                s("sessionId"),
                s("sub"),
                &mut conts,
                cache,
                &mut sign,
            );
            assert_eq!(got, s("out"), "{name} call {i}");
            if let Some(keys) = call["cacheKeys"].as_array() {
                let mut have: Vec<&String> =
                    caches[call["cache"].as_str().unwrap()].keys().collect();
                have.sort();
                let want: Vec<&str> = keys.iter().map(|k| k.as_str().unwrap()).collect();
                assert_eq!(have, want, "{name} call {i} cache");
            }
        }
    }
}

#[test]
fn a_swap_keeps_the_sequence_monotonic_and_bumps_the_discontinuity_sequence() {
    let window = |seq: u32, first: u32, count: u32| {
        let mut s = format!("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:{seq}\n");
        for i in first..first + count {
            s.push_str(&format!("#EXTINF:2.0,\nseg_{i:05}.ts\n"));
        }
        s
    };
    let tag = |m: &str, t: &str| -> Option<i64> {
        m.lines().find_map(|l| l.strip_prefix(t)?.parse().ok())
    };
    let mut conts = HashMap::new();
    let mut sign = |rid: &str| rid.to_string();
    let mut rw = |text: &str, sess: &str| {
        rewrite_remux_manifest(text, "42", sess, "subZ", &mut conts, None, &mut sign)
    };
    let a = rw(&window(12, 12, 3), "sess-A");
    assert_eq!(tag(&a, "#EXT-X-MEDIA-SEQUENCE:"), Some(12));
    let b = rw(&window(0, 0, 3), "sess-B");
    assert!(tag(&b, "#EXT-X-MEDIA-SEQUENCE:").unwrap() > 14);
    assert_eq!(tag(&b, "#EXT-X-DISCONTINUITY-SEQUENCE:"), Some(1));
    let b2 = rw(&window(1, 1, 3), "sess-B");
    assert!(tag(&b2, "#EXT-X-MEDIA-SEQUENCE:") > tag(&b, "#EXT-X-MEDIA-SEQUENCE:"));
    assert_eq!(tag(&b2, "#EXT-X-DISCONTINUITY-SEQUENCE:"), Some(1));
}

// ---- manifest_ready / segment_resource ---------------------------------------------

#[test]
fn manifest_ready_waits_for_the_starting_window_of_real_segments() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("index.m3u8");
    assert!(!manifest_ready(&p, 4), "not written yet");
    let two = "#EXTM3U\n#EXTINF:2,\nseg_00000.ts\n#EXTINF:2,\nseg_00001.ts\n";
    std::fs::write(&p, two).unwrap();
    assert!(!manifest_ready(&p, 4));
    std::fs::write(
        &p,
        format!("{two}#EXTINF:2,\nseg_00002.ts\n#EXTINF:2,\nseg_00003.ts\n"),
    )
    .unwrap();
    assert!(manifest_ready(&p, 4));
    std::fs::write(
        &p,
        "#EXTM3U\n#EXT-X-DISCONTINUITY\nnot-a-seg.bin\n#EXTINF:2,\nseg_00000.ts\n",
    )
    .unwrap();
    assert!(manifest_ready(&p, 1));
    assert!(!manifest_ready(&p, 2));
}

#[test]
fn segment_resource_parses_only_session_slash_segment() {
    assert_eq!(
        segment_resource("remux:42:abc:171/seg_00007.ts"),
        Some(("remux:42:abc:171", "seg_00007.ts"))
    );
    for bad in [
        "seg_00007.ts",
        "/seg_00007.ts",
        "sess/",
        "sess/evil.ts",
        "sess/seg_0007.ts",
    ] {
        assert_eq!(segment_resource(bad), None, "{bad}");
    }
}

#[test]
fn the_reconnect_backoff_widens_and_caps() {
    let secs = |n| reconnect_delay(n).as_secs();
    assert_eq!(
        [secs(0), secs(1), secs(2), secs(3), secs(4), secs(9)],
        [0, 5, 10, 20, 30, 30]
    );
}

// ---- the index ---------------------------------------------------------------------

struct M {
    r: R,
    map: LiveMap,
    t0: Instant,
    started: std::cell::RefCell<std::collections::HashSet<String>>,
}

fn map() -> M {
    let r = remux_with(Fake::new(LIVE), &[], Timings::default());
    let config = crate::config::test_config(&[]);
    M {
        map: LiveMap::new(r.remux.clone(), &config),
        r,
        t0: Instant::now(),
        started: Default::default(),
    }
}

fn url_for(id: &str) -> String {
    format!("http://up/{id}")
}

impl M {
    fn at(&self, ms: u64) -> Instant {
        self.t0 + Duration::from_millis(ms)
    }
    fn ensure_with(&self, stream_id: &str, sub: &str, feeds: &[&str], ms: u64) -> Option<Entry> {
        let feeds: Vec<String> = feeds.iter().map(|f| f.to_string()).collect();
        self.map
            .ensure(
                &EnsureOpts {
                    stream_id,
                    sub,
                    feeds: &feeds,
                    url_for: &url_for,
                },
                self.at(ms),
            )
            .unwrap()
            .inspect(|e| {
                self.started.borrow_mut().insert(e.session_id.clone());
            })
    }
    fn ensure(&self, stream_id: &str, sub: &str, ms: u64) -> Option<Entry> {
        self.ensure_with(stream_id, sub, &[], ms)
    }
    /// Simulate the session's ffmpeg exiting, once every stub logged its argv
    /// (macOS can take a while to exec a fresh script).
    async fn exit(&self, e: &Entry) {
        self.settle().await;
        self.r.remux.stop(&e.session_id, "test-exit");
    }
    async fn settle(&self) {
        let n = self.started.borrow().len();
        until("the stubs to start", || self.r.fake.pids().len() >= n).await;
    }
    fn tag_dead(&self, id: &str) {
        self.r.dead.strike(id);
        self.r.dead.strike(id);
    }
    fn launches(&self) -> usize {
        self.r.remux.list().len() + self.r.remux.draining_count()
    }
    async fn dialed(&self) -> Vec<String> {
        self.settle().await;
        self.r
            .fake
            .argvs()
            .iter()
            .map(|a| {
                let i = a.iter().position(|x| x == "-i").unwrap();
                a[i + 1].clone()
            })
            .collect()
    }
}

#[tokio::test]
async fn starts_a_session_once_and_reuses_it_while_active() {
    let m = map();
    let a = m.ensure("1", "u", 0).unwrap();
    let b = m.ensure("1", "u", 10).unwrap();
    assert_eq!(a.session_id, b.session_id);
    assert_eq!(m.launches(), 1);
}

#[tokio::test]
async fn a_fast_failure_throttles_the_redial_until_the_cooldown_elapses() {
    let m = map();
    let a = m.ensure("1", "u", 1_000).unwrap();
    m.exit(&a).await;
    // Died after 500 ms: a fast fail, 5 s backoff, nothing dialed.
    assert!(m.ensure("1", "u", 1_500).is_none());
    assert_eq!(m.launches(), 1);
    let b = m.ensure("1", "u", 6_500).unwrap();
    assert_ne!(a.session_id, b.session_id);
}

#[tokio::test]
async fn a_long_healthy_session_redials_at_once() {
    let m = map();
    let a = m.ensure("1", "u", 1_000).unwrap();
    m.exit(&a).await;
    assert!(m.ensure("1", "u", 61_000).is_some());
}

#[tokio::test]
async fn get_active_is_none_when_absent_or_exited_and_forget_stops_the_session() {
    let m = map();
    assert!(m.map.get_active("9", "u").is_none());
    let e = m.ensure("9", "u", 0).unwrap();
    assert_eq!(m.map.get_active("9", "u").unwrap().session_id, e.session_id);
    m.exit(&e).await;
    assert!(m.map.get_active("9", "u").is_none());

    let e = m.ensure("3", "u", 0).unwrap();
    m.map.forget("3", "u", &e.session_id);
    assert!(!m.r.remux.is_active(&e.session_id));
    assert!(m.map.get_active("3", "u").is_none());
}

#[tokio::test]
async fn drop_others_stops_only_the_same_viewers_other_channels() {
    let m = map();
    let old = m.ensure("1", "u", 0).unwrap();
    let keep = m.ensure("2", "u", 0).unwrap();
    let other = m.ensure("1", "other", 0).unwrap();
    assert_eq!(m.map.drop_others("u", "2"), vec!["1"]);
    assert!(!m.r.remux.is_active(&old.session_id));
    assert!(m.r.remux.is_active(&keep.session_id));
    assert!(m.r.remux.is_active(&other.session_id));
    assert!(m.map.get_active("1", "u").is_none());
    assert_eq!(
        m.map.get_active("2", "u").unwrap().session_id,
        keep.session_id
    );
    assert_eq!(
        m.map.get_active("1", "other").unwrap().session_id,
        other.session_id
    );
    assert!(
        m.map.drop_others("u", "2").is_empty(),
        "only the tuned one left"
    );
}

#[tokio::test]
async fn a_dead_tuned_feed_fails_over_to_its_sibling_at_once() {
    let m = map();
    let a = m.ensure_with("1", "u", &["1", "2"], 1_000).unwrap();
    assert_eq!(a.dialed_stream_id, "1");
    m.exit(&a).await;
    m.tag_dead("1");
    // 100 ms later: a corrupt-feed death would be throttled, a dead one is not.
    let b = m.ensure_with("1", "u", &["1", "2"], 1_100).unwrap();
    assert_eq!(
        (b.stream_id.as_str(), b.dialed_stream_id.as_str()),
        ("1", "2")
    );
    assert_eq!(m.dialed().await, ["http://up/1", "http://up/2"]);
}

#[tokio::test]
async fn every_candidate_dead_is_offline_and_nothing_is_redialed() {
    let m = map();
    let a = m.ensure_with("1", "u", &["1", "2"], 1_000).unwrap();
    m.exit(&a).await;
    m.tag_dead("1");
    let b = m.ensure_with("1", "u", &["1", "2"], 1_100).unwrap();
    m.exit(&b).await;
    m.tag_dead("2");
    assert!(m.ensure_with("1", "u", &["1", "2"], 1_200).is_none());
    assert_eq!(m.dialed().await.len(), 2);
    let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(m.map.is_offline(&ids(&["1", "2"])));
    assert!(!m.map.is_offline(&ids(&["1", "3"])));
    assert!(!m.map.is_offline(&[]));
}

#[tokio::test]
async fn a_single_feed_channel_with_a_dead_feed_is_offline() {
    let m = map();
    let a = m.ensure("9", "u", 1_000).unwrap();
    m.exit(&a).await;
    m.tag_dead("9");
    assert!(m.ensure("9", "u", 1_100).is_none());
}

#[tokio::test]
async fn a_redirect_stops_the_wrong_stream_and_the_next_poll_dials_the_feed() {
    let m = map();
    let a = m.ensure("1", "u", 1_000).unwrap();
    m.settle().await;
    m.map.redirect("1", "u", "2", &a.session_id, m.at(2_000));
    assert!(!m.r.remux.is_active(&a.session_id));
    let b = m.ensure("1", "u", 2_100).unwrap();
    assert_eq!(
        (b.stream_id.as_str(), b.dialed_stream_id.as_str()),
        ("1", "2")
    );
}

#[tokio::test]
async fn a_redirect_holds_across_a_retune_and_ends_on_another_channel() {
    let m = map();
    let a = m.ensure("1", "u", 1_000).unwrap();
    m.settle().await;
    m.map.redirect("1", "u", "2", &a.session_id, m.at(2_000));
    m.map.drop_others("u", "1");
    assert_eq!(m.ensure("1", "u", 60_000).unwrap().dialed_stream_id, "2");

    let m = map();
    let a = m.ensure("1", "u", 1_000).unwrap();
    m.settle().await;
    m.map.redirect("1", "u", "2", &a.session_id, m.at(2_000));
    m.map.drop_others("u", "7");
    assert_eq!(m.ensure("1", "u", 60_000).unwrap().dialed_stream_id, "1");
}

#[tokio::test]
async fn a_redirect_is_per_viewer_expires_and_leaves_a_newer_session_alone() {
    let m = map();
    let a = m.ensure("1", "u", 1_000).unwrap();
    m.settle().await;
    m.map.redirect("1", "u", "2", &a.session_id, m.at(2_000));
    assert_eq!(m.ensure("1", "other", 2_100).unwrap().dialed_stream_id, "1");
    let b = m.ensure("1", "u", 2_100).unwrap();
    m.exit(&b).await;
    assert_eq!(
        m.ensure("1", "u", 2_000 + 4 * 3_600_000)
            .unwrap()
            .dialed_stream_id,
        "1"
    );

    let m = map();
    let a = m.ensure("1", "u", 1_000).unwrap();
    m.settle().await;
    m.map
        .redirect("1", "u", "2", "some-older-session", m.at(2_000));
    assert!(m.r.remux.is_active(&a.session_id));
}

#[tokio::test]
async fn a_channel_seen_as_non_h264_is_redialed_as_a_reencode() {
    let r = remux_with(
        Fake::new(&format!(
            "echo '  Stream #0:0: Video: hevc (Main)' >&2\n{LIVE}"
        )),
        &[],
        Timings::default(),
    );
    let map = LiveMap::new(r.remux.clone(), &crate::config::test_config(&[]));
    let feeds: Vec<String> = Vec::new();
    let opts = EnsureOpts {
        stream_id: "5",
        sub: "u",
        feeds: &feeds,
        url_for: &url_for,
    };
    let a = map.ensure(&opts, Instant::now()).unwrap().unwrap();
    until("the copy session killed itself", || {
        !r.remux.is_active(&a.session_id)
    })
    .await;
    // The 15 s manifest wait re-ensures: the young death is throttled first.
    assert!(map.ensure(&opts, Instant::now()).unwrap().is_none());
    map.ensure(&opts, Instant::now() + Duration::from_secs(6))
        .unwrap()
        .unwrap();
    until("two launches", || r.fake.argvs().len() == 2).await;
    let argvs = r.fake.argvs();
    assert!(!argvs[0].contains(&"libx264".to_string()));
    assert!(argvs[1].contains(&"libx264".to_string()));
}
