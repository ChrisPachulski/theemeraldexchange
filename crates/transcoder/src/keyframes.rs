//! Per-source-file keyframe cache.
//!
//! A COPY-remux session cuts HLS segments at the SOURCE's own (irregular)
//! keyframes, so its finite VOD playlist (`vod_manifest::synthesize_copy`) can
//! only be built from the keyframe PTS list — and extracting that list is a
//! full-file demux (`ffprobe -show_entries packet`), ~17s for a 77-min HEVC rip
//! and longer for a feature. That is far too slow to run while AVPlayer is
//! waiting on the manifest, so the list is computed ONCE per file and cached on
//! the durable scratch disk, keyed by (path, mtime, size) for invalidation.
//!
//! With a warm cache a movie gets a real scrubber from 0:00 on every play — the
//! same finite-VOD experience a re-encoded title already has. See
//! [`crate::session::SessionManager::vod_manifest`] (lazy populate on miss) and
//! the boot-spawned warmer in `main.rs` (proactive fill so even a first play is
//! never "live").
//!
//! A file the probe can read but gets no usable keyframes from is cached too, as
//! an empty list: an AVI's keyframe packets carry no timestamp (`N/A`), and a
//! broken file fails the same way every time. Without that record the hourly
//! warmer re-read all ~675 library AVIs end to end on every pass (2026-10-26).

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use tokio::process::Command;

/// Scratch subdirectory holding cached keyframe lists. The boot sweep clears
/// stale SESSION dirs but explicitly skips this one (the cache is durable).
pub(crate) const KFCACHE_DIRNAME: &str = "kfcache";

/// Hard ceiling on a single keyframe probe. A 4K feature's full demux can run a
/// couple of minutes; past this something is wrong (stalled mount) and we bail
/// to the on-disk EVENT fallback rather than hang a warmer slot forever.
const PROBE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(serde::Serialize, serde::Deserialize)]
struct CacheEntry {
    /// Absolute source path — verified on read so a hash collision can never
    /// serve one file's keyframes for another.
    path: String,
    mtime_secs: u64,
    mtime_nanos: u32,
    size: u64,
    /// Source video keyframe presentation times (seconds), ascending. Empty when
    /// the probe got nothing usable from this file: tried, not worth retrying.
    keyframes: Vec<f64>,
}

/// `(mtime_secs, mtime_nanos, size)` identity used to invalidate the cache when
/// the underlying file changes (re-grab, re-mux). `None` if the file is gone.
async fn file_identity(path: &Path) -> Option<(u64, u32, u64)> {
    let md = tokio::fs::metadata(path).await.ok()?;
    let modified = md.modified().ok()?;
    let dur = modified.duration_since(UNIX_EPOCH).ok()?;
    Some((dur.as_secs(), dur.subsec_nanos(), md.len()))
}

/// Deterministic cache filename for a path. `DefaultHasher` (fixed-key SipHash)
/// is stable within a binary; a hash change across builds only forces a one-time
/// re-warm, and collisions are caught by the stored `path` check on read.
fn cache_file(cache_root: &Path, path: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    cache_root.join(format!("{:016x}.json", h.finish()))
}

/// The cached entry for `path` if present AND still valid for the file's
/// current (mtime, size), including an empty one. `None` on any
/// miss/mismatch/IO error.
async fn cached(cache_root: &Path, path: &Path) -> Option<CacheEntry> {
    let (mtime_secs, mtime_nanos, size) = file_identity(path).await?;
    let bytes = tokio::fs::read(cache_file(cache_root, path)).await.ok()?;
    let entry: CacheEntry = serde_json::from_slice(&bytes).ok()?;
    let fresh = entry.path == path.to_string_lossy()
        && entry.mtime_secs == mtime_secs
        && entry.mtime_nanos == mtime_nanos
        && entry.size == size;
    fresh.then_some(entry)
}

/// Return the cached keyframe list for `path` if present, still valid, and
/// non-empty. `None` on any miss/mismatch/IO error or a file that had none.
pub(crate) async fn load(cache_root: &Path, path: &Path) -> Option<Vec<f64>> {
    cached(cache_root, path)
        .await
        .map(|e| e.keyframes)
        .filter(|kf| !kf.is_empty())
}

/// True when this version of `path` was already probed, whether or not it gave
/// keyframes, so the warmer never reads it end to end again.
pub(crate) async fn tried(cache_root: &Path, path: &Path) -> bool {
    cached(cache_root, path).await.is_some()
}

/// Probe `path`'s keyframes and cache them, returning the list. Skips the probe
/// when a valid entry already exists (returning its list, or `None` for a file
/// that had none), so the warmer and the lazy path are both idempotent and
/// cheap on a warm cache. A probe that timed out or never started is not
/// cached: that says nothing about the file.
pub(crate) async fn ensure(cache_root: &Path, ffmpeg_bin: &str, path: &Path) -> Option<Vec<f64>> {
    if let Some(entry) = cached(cache_root, path).await {
        return (!entry.keyframes.is_empty()).then_some(entry.keyframes);
    }
    let (mtime_secs, mtime_nanos, size) = file_identity(path).await?;
    let keyframes = probe(ffmpeg_bin, path).await?;
    let entry = CacheEntry {
        path: path.to_string_lossy().into_owned(),
        mtime_secs,
        mtime_nanos,
        size,
        keyframes: keyframes.clone(),
    };
    if let Ok(json) = serde_json::to_vec(&entry) {
        write_atomic(cache_root, &cache_file(cache_root, path), &json).await;
    }
    (!keyframes.is_empty()).then_some(keyframes)
}

/// Write `bytes` to `dest` atomically (temp + rename) so a crash mid-write never
/// leaves a half-written cache file a later `load` would deserialize-fail on.
async fn write_atomic(cache_root: &Path, dest: &Path, bytes: &[u8]) {
    if tokio::fs::create_dir_all(cache_root).await.is_err() {
        return;
    }
    let tmp = dest.with_extension("json.tmp");
    if tokio::fs::write(&tmp, bytes).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, dest).await;
    }
}

/// Run a probe to completion within `limit`; `None` on timeout or spawn
/// failure. `kill_on_drop` makes a timeout kill the child: dropping the
/// `output()` future alone leaves ffprobe running (and holding its file).
pub(crate) async fn output_within(
    cmd: &mut Command,
    limit: Duration,
) -> Option<std::process::Output> {
    cmd.kill_on_drop(true);
    tokio::time::timeout(limit, cmd.output()).await.ok()?.ok()
}

/// Extract video keyframe PTS (seconds, ascending) via a full-file packet demux.
/// `ffprobe ... -show_entries packet=pts_time,flags` emits one CSV line per
/// video packet (`<pts>,<flags>`); a keyframe's flags begin with `K`. Bounded by
/// [`PROBE_TIMEOUT`]. A file ffprobe rejects, or one with no timed keyframes,
/// gives an empty list; a timeout or spawn failure gives `None`, so it is tried
/// again later. Either way the caller falls back to EVENT.
async fn probe(ffmpeg_bin: &str, path: &Path) -> Option<Vec<f64>> {
    let mut cmd = Command::new(ffprobe_bin(ffmpeg_bin));
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time,flags",
        "-of",
        "csv=p=0",
    ]);
    cmd.arg(path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    // A timeout drops the output() future; kill_on_drop then kills ffprobe.
    cmd.kill_on_drop(true);
    let output = match tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => o,
        Ok(Ok(o)) => {
            tracing::warn!(
                path = %path.display(),
                code = ?o.status.code(),
                "keyframe probe exited non-zero"
            );
            return Some(Vec::new());
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %path.display(), error = %e, "keyframe probe spawn failed");
            return None;
        }
        Err(_) => {
            tracing::warn!(path = %path.display(), "keyframe probe timed out");
            return None;
        }
    };

    let mut kf = parse_keyframes(&String::from_utf8_lossy(&output.stdout));
    // Packets arrive in DECODE order; presentation times reorder around
    // B-frames, so sort to get a clean ascending timeline.
    kf.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    kf.dedup();
    Some(kf)
}

/// Parse `pts_time,flags` CSV lines, keeping the pts of keyframe packets
/// (`flags` starting with `K`). Lines with a non-numeric / `N/A` pts are skipped.
fn parse_keyframes(csv: &str) -> Vec<f64> {
    csv.lines()
        .filter_map(|line| {
            let (pts, flags) = line.split_once(',')?;
            flags.trim_start().starts_with('K').then_some(())?;
            pts.trim().parse::<f64>().ok()
        })
        .filter(|p| p.is_finite())
        .collect()
}

/// Derive `ffprobe` from the configured `ffmpeg` path (same install prefix),
/// mirroring `routes::ffprobe_bin`.
fn ffprobe_bin(ffmpeg_bin: &str) -> String {
    match ffmpeg_bin.strip_suffix("ffmpeg") {
        Some(prefix) => format!("{prefix}ffprobe"),
        None => "ffprobe".to_string(),
    }
}

/// Test-only: seed a valid cache entry for `path`'s current identity, so a
/// `load` hit can be exercised without running a real `ffprobe`.
#[cfg(test)]
pub(crate) async fn seed_for_test(cache_root: &Path, path: &Path, keyframes: Vec<f64>) {
    let (mtime_secs, mtime_nanos, size) = file_identity(path).await.expect("seed: file must exist");
    let entry = CacheEntry {
        path: path.to_string_lossy().into_owned(),
        mtime_secs,
        mtime_nanos,
        size,
        keyframes,
    };
    let json = serde_json::to_vec(&entry).unwrap();
    write_atomic(cache_root, &cache_file(cache_root, path), &json).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-16 review item 17: timeout(cmd.output()) dropped the future on
    // timeout but left the ffprobe running (no kill_on_drop).
    #[tokio::test]
    async fn a_timed_out_probe_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(format!("echo $$ > {}; exec sleep 30", pid_file.display()));
        assert!(
            output_within(&mut cmd, Duration::from_millis(300))
                .await
                .is_none()
        );
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .to_owned();
        let alive = || {
            std::process::Command::new("kill")
                .args(["-0", &pid])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        for _ in 0..50 {
            if !alive() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed-out probe {pid} is still running");
    }

    #[test]
    fn parses_only_keyframe_packets_in_decode_order() {
        // Mirrors real `ffprobe -show_entries packet=pts_time,flags -of csv=p=0`
        // output: keyframes flagged `K_`, others `__`, pts in decode order.
        let csv = "0.000000,K_\n0.209000,__\n0.125000,__\n11.511000,K_\nN/A,K_\n13.347000,K__\n";
        let kf = parse_keyframes(csv);
        assert_eq!(kf, vec![0.0, 11.511, 13.347]);
    }

    #[test]
    fn ffprobe_derived_from_ffmpeg_prefix() {
        assert_eq!(ffprobe_bin("/usr/bin/ffmpeg"), "/usr/bin/ffprobe");
        assert_eq!(ffprobe_bin("ffmpeg"), "ffprobe");
    }

    /// A stand-in `ffmpeg` whose sibling `ffprobe` counts its runs in `runs` and
    /// then executes `body`.
    fn fake_ffmpeg(dir: &Path, body: &str) -> (String, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let runs = dir.join("runs");
        let probe = dir.join("ffprobe");
        std::fs::write(
            &probe,
            format!("#!/bin/sh\necho run >> {}\n{body}\n", runs.display()),
        )
        .unwrap();
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir.join("ffmpeg").to_string_lossy().into_owned(), runs)
    }

    fn runs(file: &Path) -> usize {
        std::fs::read_to_string(file).map_or(0, |s| s.lines().count())
    }

    // 2026-10-26: AVI keyframes come back as `N/A,K_`, so the list was empty,
    // nothing was cached, and the hourly warmer re-read every AVI end to end.
    #[tokio::test]
    async fn a_file_without_timed_keyframes_is_probed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (ffmpeg, count) = fake_ffmpeg(tmp.path(), "echo 'N/A,K_'; echo 'N/A,__'");
        let video = tmp.path().join("show.avi");
        std::fs::write(&video, b"avi").unwrap();
        let cache = tmp.path().join(KFCACHE_DIRNAME);

        assert!(!tried(&cache, &video).await);
        assert!(ensure(&cache, &ffmpeg, &video).await.is_none());
        assert!(ensure(&cache, &ffmpeg, &video).await.is_none());
        assert_eq!(runs(&count), 1, "the second ensure re-read the file");
        assert!(tried(&cache, &video).await);
        assert!(
            load(&cache, &video).await.is_none(),
            "an empty list is no scrubber"
        );
    }

    #[tokio::test]
    async fn a_file_ffprobe_rejects_is_probed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (ffmpeg, count) = fake_ffmpeg(tmp.path(), "exit 1");
        let video = tmp.path().join("broken.mkv");
        std::fs::write(&video, b"mkv").unwrap();
        let cache = tmp.path().join(KFCACHE_DIRNAME);

        ensure(&cache, &ffmpeg, &video).await;
        ensure(&cache, &ffmpeg, &video).await;
        assert_eq!(runs(&count), 1);
    }

    #[tokio::test]
    async fn a_changed_file_is_probed_again() {
        let tmp = tempfile::tempdir().unwrap();
        let (ffmpeg, count) = fake_ffmpeg(tmp.path(), "exit 1");
        let video = tmp.path().join("regrab.mkv");
        std::fs::write(&video, b"old").unwrap();
        let cache = tmp.path().join(KFCACHE_DIRNAME);

        ensure(&cache, &ffmpeg, &video).await;
        std::fs::write(&video, b"replaced with a new grab").unwrap();
        assert!(!tried(&cache, &video).await);
        ensure(&cache, &ffmpeg, &video).await;
        assert_eq!(runs(&count), 2);
    }

    #[tokio::test]
    async fn a_probe_that_never_ran_is_not_remembered() {
        let tmp = tempfile::tempdir().unwrap();
        let video = tmp.path().join("movie.mkv");
        std::fs::write(&video, b"mkv").unwrap();
        let cache = tmp.path().join(KFCACHE_DIRNAME);
        let missing = tmp.path().join("no-such-dir").join("ffmpeg");

        assert!(
            ensure(&cache, &missing.to_string_lossy(), &video)
                .await
                .is_none()
        );
        assert!(!tried(&cache, &video).await);
    }

    #[tokio::test]
    async fn load_miss_when_no_cache_file() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope.mkv");
        assert!(load(tmp.path(), &missing).await.is_none());
    }
}
