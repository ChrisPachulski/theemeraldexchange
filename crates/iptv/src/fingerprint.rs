//! Feed fingerprints (iptvFeedFingerprint.ts): tiny grayscale frame sequences
//! that tell whether two live streams carry the same picture.
//!
//! Provider streams carry no channel identity of their own, and a stream can
//! carry a different channel than its guide listing (2026-10-09: "US:
//! Showtime" carried Showtime 2). The picture is the only ground truth, so
//! `feed_verify` compares a stream's picture with other streams'.
//!
//! A fingerprint is FP_FPS frames/s of a centre crop (letterbox and pillarbox
//! bars cropped away) scaled to FP_W x FP_H luma. Two feeds of one broadcast
//! correlate ~0.98+ per frame at the right offset even across encodes; a
//! different programme scores ~0.3 (prod feeds, 2026-10-09).

use crate::egress::FFMPEG_PROXIED_PROTOCOLS;

pub const FP_W: usize = 32;
pub const FP_H: usize = 18;
pub const FP_FPS: usize = 5;
pub const FP_FRAME_BYTES: usize = FP_W * FP_H;

/// Frames whose luma spread is below this are black / fades / flat slates:
/// they say nothing about the programme, so they never count toward a score.
const FLAT_STD: f64 = 4.0;

/// At least this many informative frame pairs (8 s at 5 fps) must line up
/// before a score means anything.
pub const MIN_OVERLAP_FRAMES: usize = 40;

/// Decoder shortcuts: the picture is scaled to 32x18, so deblocking is wasted
/// work on the Plex-sharing NAS. Two threads keeps a capture off every core.
const DECODE_ARGS: [&str; 4] = ["-skip_loop_filter", "all", "-threads", "2"];

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn output_args() -> Vec<String> {
    let vf = format!("fps={FP_FPS},crop=iw*0.8:ih*0.6,scale={FP_W}:{FP_H}:flags=area,format=gray");
    let mut a = strings(&["-map", "0:v:0", "-an", "-sn", "-dn", "-vf"]);
    a.push(vf);
    a.extend(strings(&["-f", "rawvideo", "pipe:1"]));
    a
}

/// ffmpeg argv: `seconds` of a live upstream feed to fingerprint frames on
/// stdout. Same input hardening as the live remux (protocol whitelist, egress
/// proxy, read timeout, the User-Agent the provider accepts).
pub fn live_capture_args(
    upstream: &str,
    seconds: u32,
    user_agent: &str,
    proxy: &[String],
) -> Vec<String> {
    let mut a = strings(&[
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
    ]);
    a.push(FFMPEG_PROXIED_PROTOCOLS.into());
    a.extend(proxy.iter().cloned());
    a.extend(strings(&[
        "-fflags",
        "+discardcorrupt",
        "-probesize",
        "10M",
        "-analyzeduration",
        "10M",
        "-rw_timeout",
        "15000000",
        "-user_agent",
    ]));
    a.push(user_agent.into());
    a.extend(strings(&DECODE_ARGS));
    a.extend([
        "-t".into(),
        seconds.to_string(),
        "-i".into(),
        upstream.into(),
    ]);
    a.extend(output_args());
    a
}

/// ffmpeg argv: a live session's on-disk remux segments to fingerprint frames.
pub fn segment_capture_args(segments: &[String]) -> Vec<String> {
    let mut a = strings(&[
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,concat",
    ]);
    a.extend(strings(&DECODE_ARGS));
    a.extend(["-i".into(), format!("concat:{}", segments.join("|"))]);
    a.extend(output_args());
    a
}

/// Each frame z-normalised (zero mean, unit variance); None for a flat frame.
/// f32 storage and f64 sums, as the TS Float32Array and JS numbers, so scores
/// agree with the TS to the last few bits.
fn normalise(frames: &[u8]) -> Vec<Option<Vec<f32>>> {
    frames
        .chunks_exact(FP_FRAME_BYTES)
        .map(|f| {
            let n = FP_FRAME_BYTES as f64;
            let mean = f.iter().map(|&v| v as f64).sum::<f64>() / n;
            let sq: f64 = f.iter().map(|&v| (v as f64 - mean).powi(2)).sum();
            let std = (sq / n).sqrt();
            (std >= FLAT_STD).then(|| {
                f.iter()
                    .map(|&v| ((v as f64 - mean) / std) as f32)
                    .collect()
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Match {
    /// Mean per-frame Pearson correlation over the informative aligned frames.
    pub score: f64,
    /// Frames `b` is shifted against `a` at the best alignment.
    pub offset: i64,
    /// Informative frame pairs behind the score.
    pub overlap: usize,
}

/// Best alignment of two fingerprints: slide one over the other, score each
/// offset by the mean correlation of the pairs where both frames carry
/// picture, keep the highest. None when no offset lines up `min_overlap`
/// informative pairs (too short, or mostly black): "can't tell", never a
/// no-match.
pub fn compare(a: &[u8], b: &[u8], min_overlap: usize) -> Option<Match> {
    let na = normalise(a);
    let nb = normalise(b);
    let (la, lb) = (na.len() as i64, nb.len() as i64);
    let mut best: Option<Match> = None;
    // b[j] pairs with a[j + offset].
    for offset in -(lb - 1)..la {
        let lo = 0.max(-offset);
        let hi = lb.min(la - offset);
        if hi - lo < min_overlap as i64 {
            continue;
        }
        let mut total = 0.0;
        let mut pairs = 0;
        for j in lo..hi {
            let (Some(va), Some(vb)) = (&na[(j + offset) as usize], &nb[j as usize]) else {
                continue;
            };
            let dot: f64 = va.iter().zip(vb).map(|(&x, &y)| x as f64 * y as f64).sum();
            total += dot / FP_FRAME_BYTES as f64;
            pairs += 1;
        }
        if pairs < min_overlap {
            continue;
        }
        let score = total / pairs as f64;
        if best.is_none_or(|m| score > m.score) {
            best = Some(Match {
                score,
                offset,
                overlap: pairs,
            });
        }
    }
    best
}

/// The synthetic broadcasts of the TS feed-check tests, bit for bit.
#[cfg(test)]
pub(crate) mod synth {
    use super::FP_FRAME_BYTES;

    pub fn rng(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            s as f64 / 4_294_967_296.0
        }
    }

    fn scenes(seed: u32, frames: usize, noise: bool) -> Vec<u8> {
        let mut r = rng(seed);
        let mut out = vec![0u8; frames * FP_FRAME_BYTES];
        let mut scene = vec![0u8; FP_FRAME_BYTES];
        for f in 0..frames {
            if f % 12 == 0 {
                scene = (0..FP_FRAME_BYTES)
                    .map(|_| (r() * 256.0).floor() as u8)
                    .collect();
            }
            for i in 0..FP_FRAME_BYTES {
                out[f * FP_FRAME_BYTES + i] = if noise {
                    (scene[i] as f64 + ((r() - 0.5) * 20.0).floor()).clamp(0.0, 255.0) as u8
                } else {
                    scene[i]
                };
            }
        }
        out
    }

    /// iptvFeedFingerprint.test.ts `broadcast`: scenes with per-frame noise.
    pub fn noisy(seed: u32, frames: usize) -> Vec<u8> {
        scenes(seed, frames, true)
    }

    /// iptvFeedVerify.test.ts `broadcast`: held scenes, 300 frames.
    pub fn plain(seed: u32) -> Vec<u8> {
        scenes(seed, 300, false)
    }

    pub fn other_source(src: &[u8], start: usize, count: usize, seed: u32) -> Vec<u8> {
        let mut r = rng(seed);
        src[start * FP_FRAME_BYTES..(start + count) * FP_FRAME_BYTES]
            .iter()
            .map(|&v| {
                (v as f64 * 0.85 + 12.0 + (r() - 0.5) * 12.0)
                    .round()
                    .clamp(0.0, 255.0) as u8
            })
            .collect()
    }

    /// iptvFeedVerify.test.ts `slice`: 125 frames from `start`, re-graded.
    pub fn slice(src: &[u8], start: usize) -> Vec<u8> {
        src[start * FP_FRAME_BYTES..(start + 125) * FP_FRAME_BYTES]
            .iter()
            .map(|&v| (v as f64 * 0.9 + 10.0).round() as u8)
            .collect()
    }

    pub fn blend(a: &[u8], b: &[u8]) -> Vec<u8> {
        a.iter()
            .zip(b)
            .map(|(&x, &y)| ((x as f64 + y as f64) / 2.0).round() as u8)
            .collect()
    }

    /// iptvFeedSweep.test.ts `BROADCAST`: every stream shows it.
    pub fn sweep() -> Vec<u8> {
        (0..125 * FP_FRAME_BYTES)
            .map(|i| (((i % FP_FRAME_BYTES) * 37 + (i / (12 * FP_FRAME_BYTES)) * 101) % 251) as u8)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::synth::*;
    use super::*;
    use sha2::{Digest, Sha256};

    fn cmp(a: &[u8], b: &[u8]) -> Option<Match> {
        compare(a, b, MIN_OVERLAP_FRAMES)
    }

    #[test]
    fn matches_two_sources_of_one_broadcast_at_their_time_offset() {
        let session = noisy(1, 300);
        let candidate = other_source(&session, 140, 125, 7);
        let m = cmp(&session, &candidate).unwrap();
        assert!(m.score > 0.95);
        assert_eq!((m.offset, m.overlap), (140, 125));
    }

    #[test]
    fn scores_a_different_broadcast_low() {
        assert!(cmp(&noisy(1, 300), &noisy(2, 125)).unwrap().score < 0.3);
    }

    #[test]
    fn cannot_tell_when_the_picture_is_black() {
        assert_eq!(cmp(&vec![16u8; 300 * FP_FRAME_BYTES], &noisy(3, 125)), None);
    }

    #[test]
    fn cannot_tell_from_too_little_footage() {
        let session = noisy(4, 300);
        assert_eq!(cmp(&session, &other_source(&session, 10, 30, 5)), None);
    }

    fn flag<'a>(a: &'a [String], name: &str) -> &'a str {
        &a[a.iter().position(|x| x == name).unwrap() + 1]
    }

    #[test]
    fn live_capture_reads_a_bounded_slice_of_the_upstream_with_the_provider_ua() {
        let proxy = ["-http_proxy".to_string(), "http://127.0.0.1:9".to_string()];
        let a = live_capture_args("https://up.example/live/u/p/7.ts", 25, "UA", &proxy);
        assert_eq!(flag(&a, "-user_agent"), "UA");
        let pos = |n: &str| a.iter().position(|x| x == n).unwrap();
        assert!(pos("-t") < pos("-i"));
        assert_eq!(flag(&a, "-t"), "25");
        assert_eq!(flag(&a, "-i"), "https://up.example/live/u/p/7.ts");
        assert_eq!(a.last().unwrap(), "pipe:1");
        assert!(!flag(&a, "-protocol_whitelist").contains("concat"));
        assert_eq!(flag(&a, "-http_proxy"), "http://127.0.0.1:9");
        // Two decode threads and no deblocking, at 32x18 gray, 5 fps.
        assert_eq!(flag(&a, "-threads"), "2");
        assert_eq!(flag(&a, "-skip_loop_filter"), "all");
        assert_eq!(
            flag(&a, "-vf"),
            "fps=5,crop=iw*0.8:ih*0.6,scale=32:18:flags=area,format=gray"
        );
    }

    #[test]
    fn segment_capture_concatenates_session_segments_from_disk_only() {
        let a = segment_capture_args(&["/tmp/s/seg_00001.ts".into(), "/tmp/s/seg_00002.ts".into()]);
        assert_eq!(
            flag(&a, "-i"),
            "concat:/tmp/s/seg_00001.ts|/tmp/s/seg_00002.ts"
        );
        assert_eq!(flag(&a, "-protocol_whitelist"), "file,concat");
        assert_eq!(a.last().unwrap(), "pipe:1");
    }

    /// tests/fixtures/fingerprint-goldens.json, written by the TS
    /// compareFingerprints (gen-fingerprint-goldens.ts) on the same frames.
    #[test]
    fn scores_match_the_ts_goldens() {
        let goldens: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/fingerprint-goldens.json"))
                .unwrap();
        let (sho1, sho2) = (plain(1), plain(2));
        let (n1, n4) = (noisy(1, 300), noisy(4, 300));
        let cases: Vec<(Vec<u8>, Vec<u8>)> = vec![
            (n1.clone(), other_source(&n1, 140, 125, 7)),
            (n1.clone(), noisy(2, 125)),
            (vec![16u8; 300 * FP_FRAME_BYTES], noisy(3, 125)),
            (n4.clone(), other_source(&n4, 10, 30, 5)),
            (sho1.clone(), slice(&sho1, 140)),
            (sho2.clone(), slice(&sho1, 140)),
            (sho2.clone(), slice(&sho2, 140)),
            (blend(&sho1, &sho2), slice(&sho1, 140)),
            (slice(&sho2, 130), slice(&sho2, 140)),
            (sweep(), sweep()),
        ];
        let golden = goldens.as_array().unwrap();
        assert_eq!(golden.len(), cases.len());
        let sha = |b: &[u8]| -> String {
            Sha256::digest(b)
                .iter()
                .map(|x| format!("{x:02x}"))
                .collect()
        };
        for (g, (a, b)) in golden.iter().zip(&cases) {
            let name = g["name"].as_str().unwrap();
            assert_eq!(sha(a), g["a"].as_str().unwrap(), "{name}: frames a");
            assert_eq!(sha(b), g["b"].as_str().unwrap(), "{name}: frames b");
            let m = cmp(a, b);
            if g["match"].is_null() {
                assert_eq!(m, None, "{name}");
                continue;
            }
            let m = m.unwrap_or_else(|| panic!("{name}: no match"));
            let want = g["match"]["score"].as_f64().unwrap();
            assert!(
                (m.score - want).abs() < 1e-6,
                "{name}: {} vs {want}",
                m.score
            );
            assert_eq!(m.offset, g["match"]["offset"].as_i64().unwrap(), "{name}");
            assert_eq!(
                m.overlap as u64,
                g["match"]["overlap"].as_u64().unwrap(),
                "{name}"
            );
        }
    }
}
