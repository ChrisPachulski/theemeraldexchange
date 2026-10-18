//! ytdlp.test.ts, ytresolve.test.ts (minus buildHlsBundle, not ported),
//! ytmux.test.ts and ffmpeg.test.ts, against the stubs and a loopback fake
//! googlevideo; plus the mux single-flight, the byte cap and part-file cleanup.

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::*;
use crate::config::External;
use crate::tmdb::fake::{Fake, Route, Stubs};

fn ext(stubs: &Stubs, fake: &str) -> External {
    let mut ext = crate::testutil::config(&[]).ext;
    stubs.wire(&mut ext, fake);
    ext
}

fn pattern(len: usize, seed: usize) -> Vec<u8> {
    (0..len).map(|i| ((i + seed) & 0xff) as u8).collect()
}

fn pair_json(fake: &str, video: &str, audio: &str) -> String {
    format!(
        r#"{{"video_id":"x","hls":null,"progressive":null,"video":{{"url":"{fake}/gv/{video}","mime":"video/mp4","height":1080,"bitrate":1}},"audio":{{"url":"{fake}/gv/{audio}","mime":"audio/mp4","height":null,"bitrate":1}},"duration_secs":212}}"#
    )
}

// --- ytdlp.test.ts: the id allowlist ---------------------------------------------------

#[test]
fn accepts_real_11_char_ids() {
    assert!(valid_youtube_id("dQw4w9WgXcQ"));
    assert!(valid_youtube_id("a_b-c1D2E3F"));
}

#[test]
fn rejects_wrong_length_spaces_and_injection() {
    for bad in [
        "",
        "short",
        "dQw4w9WgXcQextra",
        "dQw4w9WgX Q",
        "../../etc/x",
        "a&b=c d|rm-rf",
        "dQw4w9WgXc\u{e9}",
    ] {
        assert!(!valid_youtube_id(bad), "{bad:?}");
    }
}

// --- ytresolve.test.ts: the cache ------------------------------------------------------

#[tokio::test]
async fn resolves_on_a_cold_cache_then_serves_from_it() {
    let stubs = Stubs::new();
    let ext = ext(&stubs, "http://127.0.0.1:9");
    stubs.resolve(
        "testid12345",
        &format!("{}\n", pair_json("http://g", "v", "a")),
    );
    let t = Trailers::default();
    let r = t.resolve(&ext, "testid12345").await.unwrap();
    assert_eq!(r.video.unwrap().url, "http://g/gv/v");
    t.resolve(&ext, "testid12345").await.unwrap();
    assert_eq!(stubs.take("ytresolve"), ["testid12345"]);
}

#[tokio::test]
async fn re_resolves_after_the_ttl() {
    let stubs = Stubs::new();
    let ext = ext(&stubs, "http://127.0.0.1:9");
    stubs.resolve("testid12345", &pair_json("http://g", "v", "a"));
    let t = Trailers::default();
    t.resolve(&ext, "testid12345").await.unwrap();
    let stale = Instant::now()
        .checked_sub(CACHE_TTL + Duration::from_secs(1))
        .unwrap();
    t.resolved.lock().unwrap().get_mut("testid12345").unwrap().1 = stale;
    t.resolve(&ext, "testid12345").await.unwrap();
    assert_eq!(stubs.take("ytresolve").len(), 2);
}

#[tokio::test]
async fn a_failing_binary_is_an_error_and_is_not_cached() {
    let stubs = Stubs::new();
    let ext = ext(&stubs, "http://127.0.0.1:9");
    let t = Trailers::default();
    let e = t.resolve(&ext, "testid12345").await.unwrap_err();
    assert!(e.starts_with("eex-ytresolve failed for testid12345"), "{e}");
    assert!(e.contains("no usable streams"), "{e}");
    stubs.resolve("testid12345", &pair_json("http://g", "v", "a"));
    assert!(t.resolve(&ext, "testid12345").await.is_ok());
    assert_eq!(stubs.take("ytresolve").len(), 2);
}

#[tokio::test]
async fn a_missing_binary_empty_output_or_bad_json_is_an_error() {
    let stubs = Stubs::new();
    let mut ext = ext(&stubs, "http://127.0.0.1:9");
    let t = Trailers::default();
    stubs.resolve("emptyoutput", "  \n");
    let e = t.resolve(&ext, "emptyoutput").await.unwrap_err();
    assert!(e.contains("produced no output"), "{e}");
    stubs.resolve("notjson0000", "<html>\n");
    let e = t.resolve(&ext, "notjson0000").await.unwrap_err();
    assert!(e.contains("invalid JSON for notjson0000: <html>"), "{e}");
    ext.ytresolve_bin = "/nonexistent/eex-ytresolve".into();
    assert!(t.resolve(&ext, "testid12345").await.is_err());
}

// --- yt-dlp ----------------------------------------------------------------------------

#[tokio::test]
async fn ytdlp_takes_the_first_https_line_and_caches_it() {
    let stubs = Stubs::new();
    let ext = ext(&stubs, "http://127.0.0.1:9");
    stubs.ytdlp(
        "dQw4w9WgXcQ",
        "WARNING: x\n  https://a.example/1  \nhttps://b.example/2\n",
    );
    let t = Trailers::default();
    assert_eq!(
        t.ytdlp(&ext, "dQw4w9WgXcQ").await.as_deref(),
        Some("https://a.example/1")
    );
    assert!(t.ytdlp(&ext, "dQw4w9WgXcQ").await.is_some());
    assert_eq!(
        stubs.take("ytdlp"),
        [
            "--no-cache-dir --no-playlist --quiet -f best[ext=mp4][acodec!=none][vcodec!=none]/18/best[ext=mp4]/best -g https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        ]
    );
}

#[tokio::test]
async fn ytdlp_failure_no_https_line_or_a_bad_id_is_none() {
    let stubs = Stubs::new();
    let ext = ext(&stubs, "http://127.0.0.1:9");
    let t = Trailers::default();
    assert_eq!(t.ytdlp(&ext, "unavailable").await, None);
    stubs.ytdlp("plainhttp00", "http://insecure.example/\n");
    assert_eq!(t.ytdlp(&ext, "plainhttp00").await, None);
    assert_eq!(t.ytdlp(&ext, "../../etc/x").await, None);
    // Failures are retried; the bad id never ran.
    assert_eq!(t.ytdlp(&ext, "unavailable").await, None);
    assert_eq!(stubs.take("ytdlp").len(), 3);
}

// --- ytmux.test.ts: the ranged fetch ---------------------------------------------------

#[tokio::test]
async fn stitches_multiple_sub_cap_windows_back_into_the_stream() {
    let len = CHUNK + 524_288;
    let fake = Fake::start(vec![Route::stream("/gv/video", len, 0, 200)]).await;
    let client = reqwest::Client::new();
    let out = fetch_ranged(
        &client,
        &format!("{}/gv/video?x=1", fake.url),
        MAX_STREAM_BYTES,
    )
    .await
    .unwrap();
    assert_eq!(out, pattern(len, 0));
    let calls = fake.take();
    // A full window, then a short read: stop.
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].query, "x=1&range=0-1048575");
    assert_eq!(calls[1].query, "x=1&range=1048576-2097151");
}

#[tokio::test]
async fn a_stream_under_one_window_is_one_request() {
    let fake = Fake::start(vec![Route::stream("/gv/audio", 1000, 7, 200)]).await;
    let client = reqwest::Client::new();
    let out = fetch_ranged(&client, &format!("{}/gv/audio", fake.url), MAX_STREAM_BYTES)
        .await
        .unwrap();
    assert_eq!(out, pattern(1000, 7));
    let calls = fake.take();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].query, "range=0-1048575");
}

#[tokio::test]
async fn a_non_2xx_window_fails() {
    let fake = Fake::start(vec![Route::stream("/gv/x", 10, 0, 403)]).await;
    let client = reqwest::Client::new();
    let e = fetch_ranged(&client, &format!("{}/gv/x", fake.url), MAX_STREAM_BYTES)
        .await
        .unwrap_err();
    assert_eq!(e, "range 0-1048575: HTTP 403");
}

#[tokio::test]
async fn a_stream_past_the_cap_fails() {
    let fake = Fake::start(vec![Route::stream("/gv/big", 3 * CHUNK, 0, 200)]).await;
    let client = reqwest::Client::new();
    let e = fetch_ranged(&client, &format!("{}/gv/big", fake.url), 2 * CHUNK)
        .await
        .unwrap_err();
    assert_eq!(e, format!("stream exceeds {} byte cap", 2 * CHUNK));
    assert_eq!(fake.take().len(), 3);
}

// --- the mux ---------------------------------------------------------------------------

#[tokio::test]
async fn muxes_the_pair_into_one_file_and_reuses_it_while_fresh() {
    let fake = Fake::start(vec![
        Route::stream("/gv/v", CHUNK + 10, 0, 200),
        Route::stream("/gv/a", 100, 3, 200),
    ])
    .await;
    let stubs = Stubs::new();
    let ext = ext(&stubs, &fake.url);
    stubs.resolve("muxAAAAAAAA", &pair_json(&fake.url, "v", "a"));
    let t = Trailers::default();
    let r = t.resolve(&ext, "muxAAAAAAAA").await.unwrap();
    let client = reqwest::Client::new();
    let path = t
        .ensure_muxed(&client, &ext, "muxAAAAAAAA", &r)
        .await
        .unwrap();
    assert_eq!(path, ext.mux_dir.join("muxAAAAAAAA.mp4"));
    let mut want = pattern(CHUNK + 10, 0);
    want.extend(pattern(100, 3));
    assert_eq!(std::fs::read(&path).unwrap(), want);
    let mux = ext.mux_dir.to_str().unwrap();
    assert_eq!(
        stubs.take("ffmpeg"),
        [format!(
            "-nostdin -loglevel error -i {mux}/muxAAAAAAAA.v.part -i {mux}/muxAAAAAAAA.a.part \
             -map 0:v:0 -map 1:a:0 -c copy -movflags +faststart -f mp4 -y {mux}/muxAAAAAAAA.out.part"
        )]
    );
    assert_eq!(fake.take().len(), 3);
    // Fresh: no download, no ffmpeg.
    t.ensure_muxed(&client, &ext, "muxAAAAAAAA", &r)
        .await
        .unwrap();
    assert!(fake.take().is_empty());
    assert!(stubs.take("ffmpeg").is_empty());
    let left: Vec<_> = std::fs::read_dir(&ext.mux_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(left, ["muxAAAAAAAA.mp4"]);
}

#[tokio::test]
async fn concurrent_requests_for_one_id_share_a_single_download() {
    let fake = Fake::start(vec![
        Route::stream("/gv/v", 50, 0, 200).held(),
        Route::stream("/gv/a", 50, 1, 200),
    ])
    .await;
    let stubs = Stubs::new();
    let ext = ext(&stubs, &fake.url);
    stubs.resolve("oneAAAAAAAA", &pair_json(&fake.url, "v", "a"));
    let t = Arc::new(Trailers::default());
    let r = t.resolve(&ext, "oneAAAAAAAA").await.unwrap();
    let client = reqwest::Client::new();
    let spawn = || {
        let (t, ext, r, client) = (t.clone(), ext.clone(), r.clone(), client.clone());
        tokio::spawn(async move { t.ensure_muxed(&client, &ext, "oneAAAAAAAA", &r).await })
    };
    let (first, second) = (spawn(), spawn());
    fake.until(|f| f.count("/gv/v") == 1 && f.count("/gv/a") == 1)
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    fake.release(10);
    let (a, b) = (
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    );
    assert_eq!(a, b);
    assert_eq!(fake.take().len(), 2, "one download for both callers");
    assert_eq!(stubs.take("ffmpeg").len(), 1);
    assert!(t.muxing.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_mux_is_an_error_and_leaves_no_part_files() {
    let fake = Fake::start(vec![Route::stream("/gv/a", 50, 1, 200)]).await;
    let stubs = Stubs::new();
    let ext = ext(&stubs, &fake.url);
    stubs.resolve("ffxAAAAAAAA", &pair_json(&fake.url, "a", "a"));
    let t = Trailers::default();
    let r = t.resolve(&ext, "ffxAAAAAAAA").await.unwrap();
    let client = reqwest::Client::new();
    let e = t
        .ensure_muxed(&client, &ext, "ffxAAAAAAAA", &r)
        .await
        .unwrap_err();
    assert_eq!(
        e,
        "ffmpeg mux failed: Invalid data found when processing input"
    );
    assert_eq!(std::fs::read_dir(&ext.mux_dir).unwrap().count(), 0);
    // Nothing cached for a failure: the next call tries again.
    assert!(
        t.ensure_muxed(&client, &ext, "ffxAAAAAAAA", &r)
            .await
            .is_err()
    );
    assert_eq!(stubs.take("ffmpeg").len(), 2);
}

#[tokio::test]
async fn only_an_adaptive_pair_with_a_valid_id_is_muxed() {
    let stubs = Stubs::new();
    let ext = ext(&stubs, "http://127.0.0.1:9");
    let t = Trailers::default();
    let client = reqwest::Client::new();
    let progressive: Resolved = serde_json::from_str(
        r#"{"hls":null,"progressive":"https://p","video":{"url":"https://v"},"audio":null}"#,
    )
    .unwrap();
    let e = t
        .ensure_muxed(&client, &ext, "proAAAAAAAA", &progressive)
        .await
        .unwrap_err();
    assert_eq!(e, "resolved result is not an adaptive video+audio pair");
    let pair: Resolved = serde_json::from_str(
        r#"{"hls":null,"progressive":null,"video":{"url":"https://v"},"audio":{"url":"https://a"}}"#,
    )
    .unwrap();
    let e = t
        .ensure_muxed(&client, &ext, "../../x", &pair)
        .await
        .unwrap_err();
    assert_eq!(e, "invalid video id");
}

// --- ffmpeg.test.ts --------------------------------------------------------------------

#[test]
fn parses_the_version_token_of_every_family() {
    let cases = [
        (
            "ffprobe version 6.1.1 Copyright (c) 2000-2024 the FFmpeg developers\nbuilt with gcc 13",
            Some("6.1.1"),
        ),
        ("ffprobe version 7.0 Copyright (c) 2000-2024", Some("7.0")),
        (
            "ffmpeg version N-12345-gabc123d Copyright (c)",
            Some("N-12345-gabc123d"),
        ),
        (
            "ffmpeg version 7.1-12-g0857141823 Copyright (c)",
            Some("7.1-12-g0857141823"),
        ),
        (
            "ffmpeg version 2026-05-21-git-0857141823 Copyright (c)",
            Some("2026-05-21-git-0857141823"),
        ),
        (
            "ffmpeg version 6.0-essentials Copyright (c)",
            Some("6.0-essentials"),
        ),
        ("ffmpeg version 6.1.1-1 Copyright (c)", Some("6.1.1-1")),
        ("ffprobe version 6.0 Copyright (c)", Some("6.0")),
        ("not an ffmpeg binary", None),
        ("", None),
        (
            "ffmpeg version CUSTOM_BUILD_XYZ_special Copyright ...",
            Some("CUSTOM_BUILD_XYZ_special"),
        ),
    ];
    for (out, want) in cases {
        assert_eq!(parse_ffprobe_version(out), want, "{out:?}");
    }
}

#[test]
fn classifies_tokens() {
    let git = Some(u32::MAX);
    let cases = [
        ("6.1.1", Some(6)),
        ("7.0", Some(7)),
        ("5.1.4", Some(5)),
        ("N-12345-gabc123d", git),
        ("7.1-12-g0857141823", git),
        ("2026-05-21-git-0857141823", git),
        ("6.0-essentials", Some(6)),
        ("6.1.1-1", Some(6)),
        ("6.0-full", Some(6)),
        ("CUSTOM_BUILD_XYZ", None),
        ("", None),
    ];
    for (token, want) in cases {
        assert_eq!(classify_version_token(token), want, "{token:?}");
    }
}

/// The gate's verdict for an ffprobe that prints `out` and exits `code`.
async fn gate(out: &str, err: &str, code: i32) -> Result<FfmpegOk, (String, String)> {
    let stubs = Stubs::new();
    stubs.write("ffprobe.out", out);
    stubs.write("ffprobe.err", err);
    stubs.write("ffprobe.code", &code.to_string());
    check_ffmpeg(&stubs.bin("ffprobe")).await
}

#[tokio::test]
async fn the_gate_passes_releases_from_6_and_git_builds() {
    for out in [
        "ffprobe version 6.1.1 Copyright ...",
        "ffprobe version 8.1 Copyright ...",
        "ffmpeg version 6.0-essentials Copyright ...",
        "ffmpeg version 6.1.1-1 Copyright ...",
    ] {
        let token = parse_ffprobe_version(out).unwrap().to_string();
        assert_eq!(
            gate(out, "", 0).await,
            Ok(FfmpegOk::Version(token)),
            "{out}"
        );
    }
    for out in [
        "ffmpeg version N-12345-gabc123d Copyright ...",
        "ffmpeg version 7.1-12-g0857141823 Copyright ...",
        "ffmpeg version 2026-05-21-git-0857141823 Copyright ...",
    ] {
        assert!(
            matches!(gate(out, "", 0).await, Ok(FfmpegOk::Version(_))),
            "{out}"
        );
    }
}

#[tokio::test]
async fn the_gate_refuses_releases_below_6() {
    for (out, token) in [
        ("ffprobe version 5.1.4 Copyright ...", "5.1.4"),
        ("ffprobe version 4.4.2 Copyright ...", "4.4.2"),
        (
            "ffmpeg version 5.0-essentials Copyright ...",
            "5.0-essentials",
        ),
    ] {
        let (found, reason) = gate(out, "", 0).await.unwrap_err();
        assert_eq!(found, token);
        assert!(reason.contains("below minimum"), "{reason}");
    }
}

#[tokio::test]
async fn the_gate_allows_an_unrecognised_format() {
    assert_eq!(
        gate(
            "ffmpeg version CUSTOM_BUILD_XYZ_special Copyright ...",
            "",
            0
        )
        .await,
        Ok(FfmpegOk::Unrecognized("CUSTOM_BUILD_XYZ_special".into()))
    );
}

#[tokio::test]
async fn the_gate_reads_stderr_and_recovers_a_failing_exit() {
    assert!(matches!(
        gate("", "ffprobe version 6.0 Copyright ...", 0).await,
        Ok(FfmpegOk::Version(_))
    ));
    assert!(matches!(
        gate("ffprobe version 6.0 Copyright ...", "", 1).await,
        Ok(FfmpegOk::Version(_))
    ));
}

#[tokio::test]
async fn the_gate_refuses_a_missing_silent_or_foreign_binary() {
    let missing = check_ffmpeg("/nonexistent/eex-test/ffprobe")
        .await
        .unwrap_err();
    assert_eq!(missing, ("missing".into(), "ffmpeg not found".into()));
    assert_eq!(
        gate("", "", 1).await.unwrap_err(),
        ("missing".into(), "ffmpeg not found".into())
    );
    assert_eq!(
        gate("this is not ffprobe output", "", 0).await.unwrap_err(),
        (
            "missing".into(),
            "ffmpeg version could not be determined".into()
        )
    );
}
