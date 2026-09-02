//! Sidecar subtitle acquisition: OpenSubtitles download and Whisper
//! transcription. Both write WebVTT files into `config.subtitles_dir`, named
//! `{kind}_{id}_{lang}_{source}.vtt`, served by the routes layer as
//! `text/vtt` for the player's `<track>` element.
//!
//! Neither feature is on by default: download needs `OPENSUBTITLES_API_KEY`,
//! transcription needs `WHISPER_BIN` (any CLI honoring the openai-whisper
//! convention: `<bin> <input> --output_format vtt --output_dir <dir>
//! [--model <m>]`; whisper.cpp users point WHISPER_BIN at a wrapper script).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{Value, json};

/// One transcription at a time, process-wide: Whisper saturates CPU, and the
/// box also runs Plex. ponytail: a global single-job slot, not a queue — a
/// second request while busy gets 409 and retries later.
static TRANSCRIBE_JOB: OnceLock<Mutex<Option<Value>>> = OnceLock::new();

fn job_slot() -> &'static Mutex<Option<Value>> {
    TRANSCRIBE_JOB.get_or_init(|| Mutex::new(None))
}

/// Lock the job slot, recovering the guard from a poisoned mutex. A panic in a
/// subtitle worker leaves the slot poisoned; propagating that would turn one
/// dead job into a permanent 500 on every later status/claim call. The slot
/// holds only a status `Value`, so the worst a poisoned read yields is a stale
/// status — degrade, do not cascade.
fn lock_slot() -> std::sync::MutexGuard<'static, Option<Value>> {
    job_slot().lock().unwrap_or_else(|e| e.into_inner())
}

/// Current transcription job status (None when idle).
pub fn job_status() -> Option<Value> {
    lock_slot().clone()
}

/// Claim the job slot. `Err` carries the currently running job.
pub fn claim_job(status: Value) -> Result<(), Value> {
    let mut slot = lock_slot();
    match slot.as_ref() {
        Some(running) if running.get("state").and_then(Value::as_str) == Some("running") => {
            Err(running.clone())
        }
        _ => {
            *slot = Some(status);
            Ok(())
        }
    }
}

/// Record a terminal state ("done"/"error") without releasing history — the
/// status endpoint shows the last outcome until the next job claims the slot.
pub fn finish_job(status: Value) {
    *lock_slot() = Some(status);
}

#[cfg(test)]
pub fn reset_jobs_for_tests() {
    *lock_slot() = None;
}

/// Sidecar filename for one subtitle. `lang`/`source` are sanitized to
/// lowercase alphanumerics so a hostile query string can never traverse out
/// of the subtitles dir.
pub fn sidecar_name(kind: &str, id: i64, lang: &str, source: &str) -> String {
    format!(
        "{kind}_{id}_{}_{}.vtt",
        sanitize_token(lang),
        sanitize_token(source)
    )
}

/// Keep `[a-z0-9-]`, lowercased; everything else dropped. Empty → "und".
pub fn sanitize_token(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if cleaned.is_empty() {
        "und".to_string()
    } else {
        cleaned
    }
}

/// SRT → WebVTT: prepend the magic, swap the decimal comma in timestamps for
/// a dot. Cue identifiers and everything else pass through (both formats
/// tolerate them).
pub fn srt_to_vtt(srt: &str) -> String {
    let mut out = String::with_capacity(srt.len() + 8);
    out.push_str("WEBVTT\n\n");
    for line in srt.replace('\r', "").lines() {
        if line.contains("-->") {
            out.push_str(&line.replace(',', "."));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

/// One OpenSubtitles search hit, reduced to what ranking needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub file_id: i64,
    pub download_count: i64,
    pub hearing_impaired: bool,
    pub from_trusted: bool,
}

/// Flatten the `/subtitles` search response (`data[].attributes`) into
/// candidates. Entries without a file id are unusable and dropped.
pub fn parse_search_results(body: &Value) -> Vec<Candidate> {
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    data.iter()
        .filter_map(|entry| {
            let attrs = entry.get("attributes")?;
            let file_id = attrs
                .get("files")
                .and_then(Value::as_array)
                .and_then(|f| f.first())
                .and_then(|f| f.get("file_id"))
                .and_then(Value::as_i64)?;
            Some(Candidate {
                file_id,
                download_count: attrs
                    .get("download_count")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                hearing_impaired: attrs
                    .get("hearing_impaired")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                from_trusted: attrs
                    .get("from_trusted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// Rank: non-hearing-impaired over HI, trusted uploaders over not, then most
/// downloaded. HI subs annotate sound effects — wrong default for the
/// household use case (they remain reachable by re-running with none found?
/// no: HI is only a tiebreak, so an HI-only result set still returns one).
pub fn pick_best(cands: &[Candidate]) -> Option<&Candidate> {
    cands
        .iter()
        .max_by_key(|c| (!c.hearing_impaired, c.from_trusted, c.download_count))
}

/// The numeric part OpenSubtitles wants from an `tt0111161` imdb id.
pub fn imdb_numeric(imdb_id: &str) -> Option<i64> {
    let digits = imdb_id.trim().trim_start_matches("tt");
    digits.parse().ok()
}

/// Argument list for the openai-whisper CLI convention. `model` is optional;
/// language is passed when known so Whisper skips its detection pass.
pub fn whisper_args(
    input: &Path,
    out_dir: &Path,
    model: Option<&str>,
    language: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        input.to_string_lossy().into_owned(),
        "--output_format".into(),
        "vtt".into(),
        "--output_dir".into(),
        out_dir.to_string_lossy().into_owned(),
    ];
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.into());
    }
    if let Some(l) = language {
        args.push("--language".into());
        args.push(l.into());
    }
    args
}

/// Whisper writes `<input stem>.vtt` into the output dir; the sidecar store
/// wants our canonical name.
pub fn whisper_output_path(out_dir: &Path, input: &Path) -> PathBuf {
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "out".to_string());
    out_dir.join(format!("{stem}.vtt"))
}

/// Status JSON constructors, shared by claim/finish call sites.
pub fn job_json(kind: &str, id: i64, lang: &str, state: &str, detail: Option<&str>) -> Value {
    json!({
        "media_kind": kind,
        "media_id": id,
        "language": lang,
        "state": state,
        "detail": detail,
        "at": chrono::Utc::now().to_rfc3339(),
    })
}

/// Hard ceiling on a downloaded subtitle body. A feature-length `.srt` is tens
/// of KiB; 5 MiB is orders of magnitude past any real one, so it only ever
/// trips on a hostile or compromised OpenSubtitles response trying to exhaust
/// memory. Enforced by a streamed byte-counter (see `routes.rs`), not by
/// trusting `Content-Length`.
pub const MAX_SUBTITLE_BYTES: usize = 5 * 1024 * 1024;

/// Hard ceiling on the two OpenSubtitles API JSON hops (search results,
/// download-link lookup) that precede the `.srt` fetch above. A real response
/// is a few KiB; 1 MiB is orders of magnitude past that, so it only trips on
/// a hostile/compromised API response trying to exhaust memory via `.json()`,
/// which buffers to EOF with no bound of its own. Enforced the same way as
/// `MAX_SUBTITLE_BYTES`: a streamed byte-counter, not trust in `Content-Length`.
pub const MAX_SUBTITLE_API_JSON_BYTES: usize = 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_converts_to_vtt() {
        let srt = "1\n00:00:20,000 --> 00:00:24,400\nHello there\n\n2\n00:01:00,500 --> 00:01:02,000\nGeneral Kenobi,\nyou are bold\n";
        let vtt = srt_to_vtt(srt);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:20.000 --> 00:00:24.400"));
        // Commas in cue TEXT survive; only timestamp lines are rewritten.
        assert!(vtt.contains("General Kenobi,\nyou are bold"));
    }

    #[test]
    fn sidecar_name_sanitizes_tokens() {
        assert_eq!(sidecar_name("movie", 7, "en", "os"), "movie_7_en_os.vtt");
        assert_eq!(
            sidecar_name("episode", 3, "../EN/..", "whisper"),
            "episode_3_en_whisper.vtt"
        );
        assert_eq!(sidecar_name("movie", 1, "", "os"), "movie_1_und_os.vtt");
    }

    #[test]
    fn best_candidate_prefers_non_hi_trusted_most_downloaded() {
        let cands = vec![
            Candidate {
                file_id: 1,
                download_count: 9_000,
                hearing_impaired: true,
                from_trusted: true,
            },
            Candidate {
                file_id: 2,
                download_count: 100,
                hearing_impaired: false,
                from_trusted: false,
            },
            Candidate {
                file_id: 3,
                download_count: 500,
                hearing_impaired: false,
                from_trusted: true,
            },
        ];
        assert_eq!(pick_best(&cands).unwrap().file_id, 3);
        // HI-only result sets still yield something.
        assert_eq!(pick_best(&cands[..1]).unwrap().file_id, 1);
        assert!(pick_best(&[]).is_none());
    }

    #[test]
    fn search_results_parse_and_skip_fileless_entries() {
        let body = serde_json::json!({
            "data": [
                { "attributes": { "download_count": 5, "hearing_impaired": false,
                    "from_trusted": true, "files": [ { "file_id": 42 } ] } },
                { "attributes": { "download_count": 9, "files": [] } },
            ]
        });
        let cands = parse_search_results(&body);
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].file_id, 42);
        assert!(cands[0].from_trusted);
        assert!(parse_search_results(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn imdb_numeric_strips_prefix() {
        assert_eq!(imdb_numeric("tt0111161"), Some(111_161));
        assert_eq!(imdb_numeric(" 603 "), Some(603));
        assert_eq!(imdb_numeric("garbage"), None);
    }

    #[test]
    fn whisper_args_follow_openai_cli_convention() {
        let args = whisper_args(
            Path::new("/lib/movie.mkv"),
            Path::new("/data/subtitles"),
            Some("small"),
            Some("en"),
        );
        assert_eq!(
            args,
            vec![
                "/lib/movie.mkv",
                "--output_format",
                "vtt",
                "--output_dir",
                "/data/subtitles",
                "--model",
                "small",
                "--language",
                "en",
            ]
        );
        assert_eq!(
            whisper_output_path(Path::new("/data/subtitles"), Path::new("/lib/movie.mkv")),
            PathBuf::from("/data/subtitles/movie.vtt")
        );
    }

    #[test]
    fn job_slot_claims_and_conflicts() {
        reset_jobs_for_tests();
        assert!(job_status().is_none());
        claim_job(job_json("movie", 1, "en", "running", None)).unwrap();
        // A second claim while running is refused with the running job.
        let err = claim_job(job_json("movie", 2, "en", "running", None)).unwrap_err();
        assert_eq!(err["media_id"], 1);
        // Terminal state frees the slot for the next claim.
        finish_job(job_json("movie", 1, "en", "done", None));
        claim_job(job_json("movie", 2, "en", "running", None)).unwrap();
        assert_eq!(job_status().unwrap()["media_id"], 2);
        reset_jobs_for_tests();
    }
}
