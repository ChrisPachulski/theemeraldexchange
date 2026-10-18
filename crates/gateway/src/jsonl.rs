//! An append-only JSONL file (services/grabLog.ts and usageLog.ts, which were
//! one implementation written twice): one writer at a time, a single
//! rotation to `<path>.1` once the live file passes 5 MiB, and a backward
//! tail reader that walks the file in 64 KiB blocks, newest line first.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub const ROTATE_AT_BYTES: u64 = 5 * 1024 * 1024;
const CHUNK: u64 = 64 * 1024;

pub struct JsonlLog {
    path: PathBuf,
    /// Serializes appends so two lines never interleave; a reader takes it
    /// briefly so a just-appended line is visible.
    write: Mutex<()>,
}

impl JsonlLog {
    pub fn new(path: impl Into<PathBuf>) -> JsonlLog {
        JsonlLog {
            path: path.into(),
            write: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn rotated(&self) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(".1");
        p.into()
    }

    /// Append `line` plus a newline. A file already past 5 MiB is renamed to
    /// `.1` first (best effort: a failed rename keeps appending).
    pub async fn append(&self, line: &str) -> std::io::Result<()> {
        let _held = self.write.lock().await;
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(dir).await?;
        }
        let size = tokio::fs::metadata(&self.path).await.map_or(0, |m| m.len());
        if size > ROTATE_AT_BYTES {
            let _ = tokio::fs::rename(&self.path, self.rotated()).await;
        }
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await?;
        f.write_all(format!("{line}\n").as_bytes()).await?;
        // tokio writes in the background; the line is on disk only once flushed.
        f.flush().await
    }

    /// The last `limit` non-empty lines of `path`, newest first. Waits for an
    /// in-flight append.
    pub async fn tail(&self, path: PathBuf, limit: usize) -> Vec<String> {
        drop(self.write.lock().await);
        tokio::task::spawn_blocking(move || read_tail(&path, limit))
            .await
            .unwrap_or_default()
    }
}

/// Newest-first lines from the end of `path` ([] when it cannot be opened).
/// A line is split on the newline byte and decoded only once complete, so a
/// multi-byte character across a block boundary survives.
pub fn read_tail(path: &Path, limit: usize) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else {
        return vec![];
    };
    let Ok(mut pos) = f.metadata().map(|m| m.len()) else {
        return vec![];
    };
    let mut leftover: Vec<u8> = Vec::new();
    let mut lines = Vec::new();
    while pos > 0 && lines.len() < limit {
        let n = CHUNK.min(pos);
        pos -= n;
        let mut buf = vec![0; n as usize];
        if f.seek(SeekFrom::Start(pos)).is_err() || f.read_exact(&mut buf).is_err() {
            break;
        }
        buf.extend_from_slice(&leftover);
        let mut pieces: Vec<&[u8]> = buf.split(|b| *b == b'\n').collect();
        // The first piece may continue in the earlier block.
        let head = pieces.remove(0).to_vec();
        for piece in pieces.iter().rev() {
            if lines.len() >= limit {
                break;
            }
            if !piece.is_empty() {
                lines.push(String::from_utf8_lossy(piece).into_owned());
            }
        }
        leftover = head;
    }
    if pos == 0 && !leftover.is_empty() && lines.len() < limit {
        lines.push(String::from_utf8_lossy(&leftover).into_owned());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn appends_rotates_and_tails_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let log = JsonlLog::new(dir.path().join("sub/x.jsonl"));
        assert!(
            log.tail(log.path().into(), 5).await.is_empty(),
            "missing file"
        );
        for i in 0..3 {
            log.append(&format!("{{\"i\":{i}}}")).await.unwrap();
        }
        assert_eq!(
            log.tail(log.path().into(), 2).await,
            ["{\"i\":2}", "{\"i\":1}"]
        );
        // Past 5 MiB, the next append rolls the file.
        std::fs::write(
            log.path(),
            "x".repeat(ROTATE_AT_BYTES as usize + 1) + "\nlast\n",
        )
        .unwrap();
        log.append("fresh").await.unwrap();
        assert_eq!(std::fs::read_to_string(log.path()).unwrap(), "fresh\n");
        assert_eq!(log.tail(log.rotated(), 1).await, ["last"]);
    }

    #[test]
    fn a_character_across_the_block_boundary_survives() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let first = format!("{}\n", "\u{1f3ac}".repeat(10));
        let emoji_at = 0usize;
        // The boundary (size - 64 KiB) lands 2 bytes into the first emoji.
        let pad = emoji_at + 2 + CHUNK as usize - first.len() - 1;
        std::fs::write(&p, format!("{first}{}\n", "a".repeat(pad))).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().len() - CHUNK, 2);
        let got = read_tail(&p, 10);
        assert_eq!(got.len(), 2);
        assert_eq!(got[1], "\u{1f3ac}".repeat(10));
    }

    #[test]
    fn spans_many_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let text: String = (0..2000)
            .map(|i| format!("line-{i:05}-{}\n", "p".repeat(70)))
            .collect();
        std::fs::write(&p, text).unwrap();
        let got = read_tail(&p, 10);
        assert_eq!(got.len(), 10);
        assert!(got[0].starts_with("line-01999"));
        assert!(got[9].starts_with("line-01990"));
        assert_eq!(read_tail(&p, 5000).len(), 2000);
    }
}
