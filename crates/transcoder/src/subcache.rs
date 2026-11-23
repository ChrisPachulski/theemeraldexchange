//! Per-source-file sidecar subtitle cache.
//!
//! The sidecar `subtitles.vtt` is extracted by a subtitle-only ffmpeg pass, but
//! Matroska interleaves subtitle packets with the video, so the pass still
//! demuxes the WHOLE file: 42 s for a 7.4 GB UHD WEB-DL on the NAS. A native
//! master may only advertise a subtitle rendition whose file already exists
//! (AVPlayer will not start an item while a selected rendition is unavailable),
//! so an uncached large title plays its first session without subtitles. This
//! cache makes every later play of that file advertise them from 0:00.
//!
//! Keyed and invalidated exactly like [`crate::keyframes`]: by source path plus
//! (mtime, size), and by the subtitle stream index, on the durable scratch disk.

use std::path::{Path, PathBuf};

use crate::keyframes::{file_identity, write_atomic};

/// Scratch subdirectory holding cached WebVTT sidecars. Durable: the boot sweep
/// skips it, as it does the keyframe cache.
pub(crate) const SUBCACHE_DIRNAME: &str = "subcache";

#[derive(serde::Serialize, serde::Deserialize)]
struct CacheEntry {
    /// Absolute source path, verified on read so a hash collision can never
    /// serve one file's subtitles for another.
    path: String,
    mtime_secs: u64,
    mtime_nanos: u32,
    size: u64,
    /// Absolute stream index the cues were extracted from (`-map 0:<index>`).
    source_index: i64,
    /// The complete WebVTT document.
    vtt: String,
}

/// Deterministic cache filename for one subtitle stream of one source file.
fn cache_file(cache_root: &Path, path: &Path, source_index: i64) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    source_index.hash(&mut h);
    cache_root.join(format!("{:016x}.json", h.finish()))
}

/// The cached WebVTT for this stream of `path` when present and still valid for
/// the file's current (mtime, size). `None` on any miss, mismatch or IO error.
pub(crate) async fn load(cache_root: &Path, path: &Path, source_index: i64) -> Option<String> {
    let (mtime_secs, mtime_nanos, size) = file_identity(path).await?;
    let bytes = tokio::fs::read(cache_file(cache_root, path, source_index))
        .await
        .ok()?;
    let entry: CacheEntry = serde_json::from_slice(&bytes).ok()?;
    let fresh = entry.path == path.to_string_lossy()
        && entry.mtime_secs == mtime_secs
        && entry.mtime_nanos == mtime_nanos
        && entry.size == size
        && entry.source_index == source_index;
    fresh.then_some(entry.vtt)
}

/// Cache a complete extraction. Best-effort: a source that cannot be stat'ed or
/// a failed write just means the next play extracts again.
pub(crate) async fn store(cache_root: &Path, path: &Path, source_index: i64, vtt: String) {
    let Some((mtime_secs, mtime_nanos, size)) = file_identity(path).await else {
        return;
    };
    let entry = CacheEntry {
        path: path.to_string_lossy().into_owned(),
        mtime_secs,
        mtime_nanos,
        size,
        source_index,
        vtt,
    };
    if let Ok(json) = serde_json::to_vec(&entry) {
        write_atomic(
            cache_root,
            &cache_file(cache_root, path, source_index),
            &json,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stored_vtt_loads_for_the_same_file_and_stream_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(SUBCACHE_DIRNAME);
        let source = tmp.path().join("movie.mkv");
        std::fs::write(&source, b"source bytes").unwrap();

        store(
            &root,
            &source,
            2,
            "WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n".into(),
        )
        .await;

        assert_eq!(
            load(&root, &source, 2).await.as_deref(),
            Some("WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n")
        );
        assert!(
            load(&root, &source, 3).await.is_none(),
            "another stream index is a miss"
        );
    }

    #[tokio::test]
    async fn a_changed_source_file_misses() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(SUBCACHE_DIRNAME);
        let source = tmp.path().join("movie.mkv");
        std::fs::write(&source, b"source bytes").unwrap();
        store(&root, &source, 2, "WEBVTT\n".into()).await;

        std::fs::write(&source, b"a re-grabbed, longer source").unwrap();

        assert!(
            load(&root, &source, 2).await.is_none(),
            "size changed: stale cues must not be served"
        );
    }

    #[tokio::test]
    async fn a_missing_source_neither_stores_nor_loads() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(SUBCACHE_DIRNAME);
        let source = tmp.path().join("gone.mkv");

        store(&root, &source, 2, "WEBVTT\n".into()).await;

        assert!(load(&root, &source, 2).await.is_none());
        assert!(
            !root.exists(),
            "nothing is written for a source that cannot be stat'ed"
        );
    }
}
