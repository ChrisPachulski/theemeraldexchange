//! Chapters — a title's embedded container chapters, for the player's chapter
//! list (browsers cannot read MP4/MKV chapter atoms themselves).
//!
//! Read on demand with the same ffprobe call the scanner makes, then cached
//! per (path, mtime): a file's chapters never change, and probing on demand
//! covers the existing library with no schema change or rescan.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::stream::resolve_media_file;
use super::*;
use crate::models::Chapter;

type ChapterCache = Mutex<HashMap<(String, String), Vec<Chapter>>>;

// ponytail: unbounded, one small entry per title played; bounded by library size.
fn cache() -> &'static ChapterCache {
    static CACHE: OnceLock<ChapterCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// `path`'s chapters, probed once per (path, mtime). A failed probe yields an
/// empty list WITHOUT caching it, so a transient failure is retried next time.
/// Probes run one at a time: a burst of misses queues instead of fanning out
/// an ffprobe each on the NAS, and the queued callers then hit the cache.
async fn chapters_for(ffprobe_bin: &str, path: &str, mtime: &str) -> Vec<Chapter> {
    // ponytail: one global permit; per-file in-flight tracking if probes ever queue visibly.
    static PROBE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let key = (path.to_string(), mtime.to_string());
    let cached = || {
        cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned()
    };
    if let Some(hit) = cached() {
        return hit;
    }
    let _permit = PROBE.acquire().await.expect("semaphore never closed");
    if let Some(hit) = cached() {
        return hit;
    }
    match crate::probe::ffprobe_with_bin(ffprobe_bin, std::path::Path::new(path)).await {
        Ok(probe) => {
            cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key, probe.chapters.clone());
            probe.chapters
        }
        Err(e) => {
            tracing::warn!(path, error = %e, "chapter probe failed");
            Vec::new()
        }
    }
}

/// GET a title's chapters: `{ items: [{ title, start_secs, end_secs }] }`,
/// empty when the file carries none. Video kinds only; the same root
/// containment as `/stream` applies before ffprobe ever touches the path.
pub(super) async fn get_chapters(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let roots = match kind.as_str() {
        "movie" | "episode" => state.config.library_paths(),
        "video" => state.config.youtube_roots.clone(),
        _ => {
            return Err(AppError::BadRequest(format!(
                "no chapters for media kind: {kind}"
            )));
        }
    };
    let file = resolve_media_file(&state, &kind, id).await?;
    if !path_within_roots(std::path::Path::new(&file.path), &roots).await {
        return Err(AppError::NotFound);
    }
    let items = chapters_for("ffprobe", &file.path, &file.mtime).await;
    Ok(Json(json!({ "items": items })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;
    use tower::ServiceExt;

    /// An ffprobe stand-in that prints two chapters (one untitled) and appends
    /// a line to `calls` per run, so the test can count probes.
    #[cfg(unix)]
    fn chapter_stub(dir: &std::path::Path) -> std::path::PathBuf {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let json = r#"{"streams":[],"format":{},"chapters":[{"start_time":"0.000000","end_time":"299.600000","tags":{"title":"Opening"}},{"start_time":"299.600000","end_time":"612.000000"}]}"#;
        let calls = dir.join("calls");
        let p = dir.join("ffprobe_chapters_stub.sh");
        let mut f = std::fs::File::create(&p).unwrap();
        writeln!(
            f,
            "#!/bin/sh\necho x >> '{}'\nsleep 0.2\ncat <<'EOF'\n{json}\nEOF",
            calls.display()
        )
        .unwrap();
        f.sync_all().unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&p, perms).unwrap();
        p
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn chapters_are_parsed_and_probed_once_per_file_version() {
        let dir = tempfile::tempdir().unwrap();
        let stub = chapter_stub(dir.path());
        let bin = stub.to_str().unwrap();
        let path = dir.path().join("film.mkv");
        let path = path.to_str().unwrap();

        let first = chapters_for(bin, path, "m1").await;
        assert_eq!(
            first,
            vec![
                Chapter {
                    title: Some("Opening".into()),
                    start_secs: 0,
                    end_secs: 300
                },
                Chapter {
                    title: None,
                    start_secs: 300,
                    end_secs: 612
                },
            ]
        );
        assert_eq!(chapters_for(bin, path, "m1").await, first);
        let probes = || {
            std::fs::read_to_string(dir.path().join("calls"))
                .unwrap()
                .lines()
                .count()
        };
        assert_eq!(probes(), 1, "a cached file must not be re-probed");
        // A replaced file (new mtime) is probed again.
        chapters_for(bin, path, "m2").await;
        assert_eq!(probes(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[cfg(unix)]
    async fn concurrent_misses_for_one_file_probe_it_once() {
        // A burst of requests for an uncached title must not fan out one
        // ffprobe each on the NAS: they queue and the rest hit the cache.
        let dir = tempfile::tempdir().unwrap();
        let stub = chapter_stub(dir.path());
        let bin = stub.to_str().unwrap().to_string();
        let path = dir.path().join("burst.mkv").to_str().unwrap().to_string();
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..20 {
            let (bin, path) = (bin.clone(), path.clone());
            set.spawn(async move { chapters_for(&bin, &path, "m").await.len() });
        }
        while let Some(n) = set.join_next().await {
            assert_eq!(n.unwrap(), 2);
        }
        let probes = std::fs::read_to_string(dir.path().join("calls"))
            .unwrap()
            .lines()
            .count();
        assert_eq!(probes, 1, "20 concurrent misses ran {probes} probes");
    }

    #[tokio::test]
    async fn failed_probe_is_empty_and_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.mkv");
        let missing = dir.path().join("no-such-ffprobe");
        let bin = missing.to_str().unwrap();
        assert!(
            chapters_for(bin, path.to_str().unwrap(), "m")
                .await
                .is_empty()
        );
        let key = (path.to_str().unwrap().to_string(), "m".to_string());
        assert!(!cache().lock().unwrap().contains_key(&key));
    }

    #[tokio::test]
    async fn route_rejects_audio_kinds_and_unknown_titles() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let resp = app
            .clone()
            .oneshot(req("GET", "/api/media/chapters/track/1"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let resp = app
            .oneshot(req("GET", "/api/media/chapters/movie/999"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn route_answers_an_empty_list_when_the_file_has_no_chapters() {
        // The seeded path doesn't exist, so the probe fails (whether or not an
        // ffprobe is installed): the route still answers 200 with no items.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/nonexistent/chapterless.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(req("GET", format!("/api/media/chapters/movie/{movie_id}")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({ "items": [] }));
    }
}
