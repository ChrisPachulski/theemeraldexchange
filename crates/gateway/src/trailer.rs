//! Trailer resolution for AVPlayer (services/ytresolve.ts, ytmux.ts,
//! ytdlp.ts, ffmpeg.ts). tvOS cannot embed YouTube, so the server turns a
//! video id into something directly playable:
//!
//! - [`Trailers::resolve`] runs `eex-ytresolve <id>` (the Rust ytresolve
//!   crate's CLI, iOS Innertube client) and caches its JSON for 3 h, under
//!   googlevideo's ~6 h `expire`. Failures are not cached.
//! - [`Trailers::ensure_muxed`] turns an adaptive video+audio pair into one
//!   faststart mp4: both streams come down in 1 MiB `&range=` windows (a plain
//!   or over-cap GET is a 403), 256 MiB at most, then `ffmpeg -c copy`. One
//!   download per id at a time; a fresh file (3 h) is reused.
//! - [`Trailers::ytdlp`] is the fallback: `yt-dlp -g` for a single muxed mp4,
//!   also cached for 3 h on success.
//! - [`check_ffmpeg`] is the boot gate: ffprobe >= 6 or the process exits.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use serde::Deserialize;
use tokio::process::Command;

use crate::config::External;

const CACHE_TTL: Duration = Duration::from_secs(3 * 60 * 60);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(20);
const RESOLVE_MAX_OUTPUT: usize = 512 * 1024;
const YTDLP_MAX_OUTPUT: usize = 1024 * 1024;
/// googlevideo rejects full-file GETs; 1 MiB windows reliably return 200/206.
pub const CHUNK: usize = 1_048_576;
const CHUNK_TIMEOUT: Duration = Duration::from_secs(20);
/// Trailers are small; a bad URL must not fill the disk.
pub const MAX_STREAM_BYTES: usize = 256 * 1024 * 1024;
const MUX_TIMEOUT: Duration = Duration::from_secs(60);
const FFPROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// itag 18 (360p) is the always-present muxed mp4; never a bare DASH
/// video-only stream.
const YTDLP_FORMAT: &str = "best[ext=mp4][acodec!=none][vcodec!=none]/18/best[ext=mp4]/best";

/// An 11-character YouTube id. It reaches argv and a youtube.com URL, so this
/// allowlist is what stops a hostile `key` from injecting anything.
pub fn valid_youtube_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `eex-ytresolve <id>`'s JSON line (the ytresolve crate's `Resolved`).
#[derive(Clone, Debug, Deserialize)]
pub struct Resolved {
    pub hls: Option<String>,
    pub progressive: Option<String>,
    pub video: Option<StreamRef>,
    pub audio: Option<StreamRef>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct StreamRef {
    pub url: String,
}

type MuxResult = Result<PathBuf, String>;

/// The caches and the per-id mux single-flight.
#[derive(Default)]
pub struct Trailers {
    resolved: Mutex<HashMap<String, (Resolved, Instant)>>,
    ytdlp: Mutex<HashMap<String, (String, Instant)>>,
    muxing: Arc<Mutex<HashMap<String, Shared<BoxFuture<'static, MuxResult>>>>>,
}

impl Trailers {
    /// A cached resolution, else the binary's. Errors are not cached.
    pub async fn resolve(&self, ext: &External, id: &str) -> Result<Resolved, String> {
        if let Some((r, at)) = self.resolved.lock().unwrap().get(id)
            && at.elapsed() < CACHE_TTL
        {
            return Ok(r.clone());
        }
        let out = run(
            Command::new(&ext.ytresolve_bin).arg(id),
            RESOLVE_TIMEOUT,
            RESOLVE_MAX_OUTPUT,
        )
        .await
        .map_err(|e| format!("eex-ytresolve failed for {id}: {e}"))?;
        let line = out.trim();
        if line.is_empty() {
            return Err(format!("eex-ytresolve produced no output for {id}"));
        }
        let r: Resolved = serde_json::from_str(line).map_err(|_| {
            let head: String = line.chars().take(200).collect();
            format!("eex-ytresolve: invalid JSON for {id}: {head}")
        })?;
        self.resolved
            .lock()
            .unwrap()
            .insert(id.into(), (r.clone(), Instant::now()));
        Ok(r)
    }

    /// `yt-dlp -g`'s first https line, or None when it is missing, fails or
    /// prints none.
    pub async fn ytdlp(&self, ext: &External, id: &str) -> Option<String> {
        if !valid_youtube_id(id) {
            return None;
        }
        if let Some((url, at)) = self.ytdlp.lock().unwrap().get(id)
            && at.elapsed() < CACHE_TTL
        {
            return Some(url.clone());
        }
        let mut cmd = Command::new(&ext.ytdlp_bin);
        cmd.args(["--no-cache-dir", "--no-playlist", "--quiet", "-f"])
            .arg(YTDLP_FORMAT)
            .arg("-g")
            .arg(format!("https://www.youtube.com/watch?v={id}"))
            .env("TMPDIR", "/tmp");
        let out = match run(&mut cmd, RESOLVE_TIMEOUT, YTDLP_MAX_OUTPUT).await {
            Ok(out) => out,
            Err(e) => {
                let first = e.lines().next().unwrap_or_default();
                tracing::warn!(event = "ytdlp", id, err = first, "resolve failed");
                return None;
            }
        };
        let url = out
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("https://"))?
            .to_string();
        self.ytdlp
            .lock()
            .unwrap()
            .insert(id.into(), (url.clone(), Instant::now()));
        Some(url)
    }

    /// The local faststart mp4 for `id`, downloading and muxing `r`'s
    /// adaptive pair unless a fresh one exists. Concurrent calls for one id
    /// share a single download, which runs on its own task so a client
    /// hang-up never leaves part files behind.
    pub async fn ensure_muxed(
        &self,
        client: &reqwest::Client,
        ext: &External,
        id: &str,
        r: &Resolved,
    ) -> MuxResult {
        if !valid_youtube_id(id) {
            return Err("invalid video id".into());
        }
        let (Some(video), Some(audio)) = (
            r.video.as_ref().filter(|s| !s.url.is_empty()),
            r.audio.as_ref().filter(|s| !s.url.is_empty()),
        ) else {
            return Err("resolved result is not an adaptive video+audio pair".into());
        };
        let out = muxed_path(&ext.mux_dir, id);
        if fresh(&out).await {
            return Ok(out);
        }
        let task = {
            let mut muxing = self.muxing.lock().unwrap();
            match muxing.get(id) {
                Some(task) => task.clone(),
                None => {
                    let key = id.to_string();
                    let (client, ext, id) = (client.clone(), ext.clone(), id.to_string());
                    let (video, audio) = (video.url.clone(), audio.url.clone());
                    let registry = self.muxing.clone();
                    // Spawned under the registry lock, so its own removal
                    // below cannot run before this insert.
                    let handle = tokio::spawn(async move {
                        let res = mux(&client, &ext, &id, &video, &audio).await;
                        registry.lock().unwrap().remove(&id);
                        res
                    });
                    let task = async move { handle.await.map_err(|e| e.to_string())? }
                        .boxed()
                        .shared();
                    muxing.insert(key, task.clone());
                    task
                }
            }
        };
        task.await
    }
}

/// Where `id`'s muxed trailer lives.
pub fn muxed_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.mp4"))
}

async fn fresh(path: &Path) -> bool {
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return false;
    };
    let age = meta
        .modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok());
    meta.len() > 0 && age.is_some_and(|a| a < CACHE_TTL)
}

async fn mux(
    client: &reqwest::Client,
    ext: &External,
    id: &str,
    video: &str,
    audio: &str,
) -> MuxResult {
    let dir = &ext.mux_dir;
    let v_tmp = dir.join(format!("{id}.v.part"));
    let a_tmp = dir.join(format!("{id}.a.part"));
    let out_tmp = dir.join(format!("{id}.out.part"));
    let res = async {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| e.to_string())?;
        // Both downloads finish before either error counts, as Promise.all's
        // losers ran to completion in Node.
        let (v, a) = tokio::join!(
            fetch_ranged(client, video, MAX_STREAM_BYTES),
            fetch_ranged(client, audio, MAX_STREAM_BYTES)
        );
        let (v, a) = (v?, a?);
        let (wv, wa) = tokio::join!(tokio::fs::write(&v_tmp, v), tokio::fs::write(&a_tmp, a));
        wv.and(wa).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&ext.ffmpeg_bin);
        cmd.args(["-nostdin", "-loglevel", "error", "-i"])
            .arg(&v_tmp)
            .arg("-i")
            .arg(&a_tmp)
            .args(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy"])
            .args(["-movflags", "+faststart"])
            // The output is a .part temp, so ffmpeg cannot infer mp4.
            .args(["-f", "mp4", "-y"])
            .arg(&out_tmp);
        run(&mut cmd, MUX_TIMEOUT, YTDLP_MAX_OUTPUT)
            .await
            .map_err(|e| format!("ffmpeg mux failed: {e}"))?;
        let out = muxed_path(dir, id);
        // Atomic publish: a reader never sees a half-written mp4.
        tokio::fs::rename(&out_tmp, &out)
            .await
            .map_err(|e| e.to_string())?;
        Ok(out)
    }
    .await;
    for p in [&v_tmp, &a_tmp, &out_tmp] {
        let _ = tokio::fs::remove_file(p).await;
    }
    res
}

/// A googlevideo URL in `&range=a-b` windows, concatenated: stops at an
/// empty or short window, fails on any status but 200/206 or past `cap`.
pub async fn fetch_ranged(
    client: &reqwest::Client,
    url: &str,
    cap: usize,
) -> Result<Vec<u8>, String> {
    let sep = if url.contains('?') { '&' } else { '?' };
    let mut out = Vec::new();
    // A runaway guard on top of the byte cap.
    for _ in 0..=cap.div_ceil(CHUNK) {
        let (start, end) = (out.len(), out.len() + CHUNK - 1);
        let window = async {
            let mut res = client
                .get(format!("{url}{sep}range={start}-{end}"))
                .send()
                .await
                .map_err(|e| e.without_url().to_string())?;
            let status = res.status().as_u16();
            if status != 200 && status != 206 {
                return Err(format!("range {start}-{end}: HTTP {status}"));
            }
            let mut got = 0;
            while let Some(chunk) = res.chunk().await.map_err(|e| e.without_url().to_string())? {
                got += chunk.len();
                out.extend_from_slice(&chunk);
                if out.len() > cap {
                    return Err(format!("stream exceeds {cap} byte cap"));
                }
            }
            Ok(got)
        };
        let got = tokio::time::timeout(CHUNK_TIMEOUT, window)
            .await
            .map_err(|_| format!("range {start}-{end}: timed out"))??;
        // googlevideo returns the whole window while more data exists.
        if got < CHUNK {
            break;
        }
    }
    Ok(out)
}

/// Run `cmd` (stdin closed, killed on timeout) and return its stdout, or an
/// error carrying its stderr (else the exit status).
async fn run(cmd: &mut Command, timeout: Duration, max_output: usize) -> Result<String, String> {
    cmd.stdin(Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if out.stdout.len() > max_output {
        return Err("stdout maxBuffer length exceeded".into());
    }
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            out.status.to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// --- the boot gate --------------------------------------------------------------------

/// ffmpeg >= 6 (the transcoder's LL-HLS assumes it; the trailer mux spawns it).
const MIN_MAJOR: u32 = 6;

fn re(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).expect("static regex")
}

/// The token after "version" on the first line that has one (else the first
/// line), or None when the output is not ffprobe's.
pub fn parse_ffprobe_version(output: &str) -> Option<&str> {
    static LINE: OnceLock<regex::Regex> = OnceLock::new();
    static TOKEN: OnceLock<regex::Regex> = OnceLock::new();
    let line_re = LINE.get_or_init(|| re(r"(?i)\bversion\b"));
    let line = output
        .split('\n')
        .find(|l| line_re.is_match(l))
        .or_else(|| output.split('\n').next())?;
    let token = TOKEN.get_or_init(|| re(r"\bversion\s+(\S+)"));
    Some(token.captures(line)?.get(1)?.as_str())
}

/// The release major, `Some(u32::MAX)` for a git build (N-..., tag-n-g<hash>,
/// YYYY-MM-DD-git-...: current enough), None when unrecognized.
pub fn classify_version_token(token: &str) -> Option<u32> {
    static GIT: OnceLock<regex::Regex> = OnceLock::new();
    static MAJOR: OnceLock<regex::Regex> = OnceLock::new();
    let git = GIT.get_or_init(|| re(r"^N-\d|-g[0-9a-f]{4,}|^\d{4}-\d{2}-\d{2}-git-"));
    if git.is_match(token) {
        return Some(u32::MAX);
    }
    let major = MAJOR.get_or_init(|| re(r"^(\d+)"));
    // A major too large for u32 is still a number, and above 6.
    Some(major.captures(token)?[1].parse().unwrap_or(u32::MAX))
}

/// What the boot log says on success.
#[derive(Debug, PartialEq, Eq)]
pub enum FfmpegOk {
    Version(String),
    /// Unrecognized format: assumed current, the operator's responsibility.
    Unrecognized(String),
}

/// Run `ffprobe -version` (5 s cap). Stdout and stderr both count, and a
/// non-zero exit that still printed a version is recovered. Err is the
/// `found:` text for `ffmpeg >=6.0 required; found: <...>` and the reason.
pub async fn check_ffmpeg(ffprobe: &str) -> Result<FfmpegOk, (String, String)> {
    let missing = |why: &str| Err(("missing".to_string(), why.to_string()));
    let mut cmd = Command::new(ffprobe);
    cmd.arg("-version").stdin(Stdio::null()).kill_on_drop(true);
    let output = match tokio::time::timeout(FFPROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            if !out.status.success() && text.trim().is_empty() {
                return missing("ffmpeg not found");
            }
            text
        }
        Ok(Err(_)) | Err(_) => return missing("ffmpeg not found"),
    };
    let Some(token) = parse_ffprobe_version(&output) else {
        return missing("ffmpeg version could not be determined");
    };
    match classify_version_token(token) {
        None => Ok(FfmpegOk::Unrecognized(token.into())),
        Some(major) if major < MIN_MAJOR => Err((
            token.into(),
            format!("ffmpeg {token} is below minimum required version 6.0"),
        )),
        Some(_) => Ok(FfmpegOk::Version(token.into())),
    }
}

#[cfg(test)]
mod tests;
