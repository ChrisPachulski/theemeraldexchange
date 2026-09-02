//! Sidecar subtitles: OpenSubtitles download + Whisper transcription.

use super::*;

/// Longer-lived client than [`transcoder_http`]: an OpenSubtitles search +
/// download is three sequential internet round-trips, not a LAN hop.
pub(super) fn subtitles_http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

/// Base URL for the OpenSubtitles REST API; overridable for tests/stubs.
pub(super) fn opensubtitles_base() -> String {
    std::env::var("OPENSUBTITLES_API_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.opensubtitles.com".to_string())
}

pub(super) const OPENSUBTITLES_USER_AGENT: &str = "theemeraldexchange v1";

#[derive(Debug, Deserialize, Default)]
pub struct SubtitleLangBody {
    /// BCP-47-ish language code; defaults to English.
    pub language: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SubtitleFileQuery {
    pub language: String,
    pub source: String,
}

/// `(file path, imdb numeric id, Some((season, episode)) for episodes)` for
/// one movie/episode, or the usual 400/404 contract on bad refs. Episodes
/// resolve the PARENT show's imdb id (OpenSubtitles queries take
/// `parent_imdb_id` + season/episode numbers).
pub(super) async fn subtitle_media_lookup(
    state: &AppState,
    kind: &str,
    id: i64,
) -> AppResult<(String, Option<i64>, Option<(i64, i64)>)> {
    match kind {
        "movie" => {
            let row: Option<(String, Option<String>)> = sqlx::query_as(
                "SELECT mf.path, m.imdb_id FROM movies m \
                 JOIN media_files mf ON m.file_id = mf.id WHERE m.id = ?",
            )
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?;
            let (path, imdb) = row.ok_or(AppError::NotFound)?;
            Ok((
                path,
                imdb.as_deref().and_then(crate::subtitles::imdb_numeric),
                None,
            ))
        }
        "episode" => {
            let row: Option<(String, Option<String>, i64, i64)> = sqlx::query_as(
                "SELECT mf.path, s.imdb_id, e.season, e.episode FROM episodes e \
                 JOIN shows s ON e.show_id = s.id \
                 JOIN media_files mf ON e.file_id = mf.id WHERE e.id = ?",
            )
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?;
            let (path, imdb, season, episode) = row.ok_or(AppError::NotFound)?;
            Ok((
                path,
                imdb.as_deref().and_then(crate::subtitles::imdb_numeric),
                Some((season, episode)),
            ))
        }
        _ => Err(AppError::BadRequest(
            "media_kind must be 'movie' or 'episode'".into(),
        )),
    }
}

/// Public URL (relative, BFF-proxied) for one stored sidecar subtitle.
pub(super) fn subtitle_url(kind: &str, id: i64, lang: &str, source: &str) -> String {
    format!("/api/media/subtitles/{kind}/{id}/file?language={lang}&source={source}")
}

pub(super) async fn list_subtitles(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    if kind != "movie" && kind != "episode" {
        return Err(AppError::BadRequest(
            "media_kind must be 'movie' or 'episode'".into(),
        ));
    }
    let prefix = format!("{kind}_{id}_");
    let mut items = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir(&state.config.subtitles_dir).await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(rest) = name
                .strip_prefix(&prefix)
                .and_then(|r| r.strip_suffix(".vtt"))
            else {
                continue;
            };
            // rest = "{lang}_{source}"
            let Some((lang, source)) = rest.split_once('_') else {
                continue;
            };
            items.push(json!({
                "language": lang,
                "source": source,
                "url": subtitle_url(&kind, id, lang, source),
            }));
        }
    }
    Ok(Json(json!({ "items": items })))
}

pub(super) async fn subtitle_file(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    Query(q): Query<SubtitleFileQuery>,
) -> AppResult<axum::response::Response> {
    if kind != "movie" && kind != "episode" {
        return Err(AppError::BadRequest(
            "media_kind must be 'movie' or 'episode'".into(),
        ));
    }
    // sidecar_name sanitizes lang/source to [a-z0-9-], so the joined path can
    // never escape the subtitles dir.
    let path = state
        .config
        .subtitles_dir
        .join(crate::subtitles::sidecar_name(
            &kind,
            id,
            &q.language,
            &q.source,
        ));
    let body = tokio::fs::read_to_string(&path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/vtt; charset=utf-8")],
        body,
    )
        .into_response())
}

pub(super) async fn download_subtitle(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<SubtitleLangBody>>,
) -> AppResult<Json<Value>> {
    let Some(api_key) = state.config.opensubtitles_api_key.clone() else {
        return Err(AppError::FeatureDisabled(
            "subtitle download requires OPENSUBTITLES_API_KEY".into(),
        ));
    };
    let lang = crate::subtitles::sanitize_token(
        body.and_then(|Json(b)| b.language)
            .as_deref()
            .unwrap_or("en"),
    );
    let (_path, imdb, episode_nums) = subtitle_media_lookup(&state, &kind, id).await?;
    let Some(imdb) = imdb else {
        return Err(AppError::BadRequest(
            "title has no imdb id to search by".into(),
        ));
    };

    let base = opensubtitles_base();
    let mut search_url = match episode_nums {
        Some((season, episode)) => format!(
            "{base}/api/v1/subtitles?parent_imdb_id={imdb}&season_number={season}&episode_number={episode}&languages={lang}"
        ),
        None => format!("{base}/api/v1/subtitles?imdb_id={imdb}&languages={lang}"),
    };
    search_url.push_str("&order_by=download_count&order_direction=desc");

    let http = subtitles_http();
    let search: Value = http
        .get(&search_url)
        .header("Api-Key", &api_key)
        .header("User-Agent", OPENSUBTITLES_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles search failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles search body: {e}")))?;
    let candidates = crate::subtitles::parse_search_results(&search);
    let Some(best) = crate::subtitles::pick_best(&candidates) else {
        return Err(AppError::NotFound);
    };

    let download: Value = http
        .post(format!("{base}/api/v1/download"))
        .header("Api-Key", &api_key)
        .header("User-Agent", OPENSUBTITLES_USER_AGENT)
        .json(&json!({ "file_id": best.file_id }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles download failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles download body: {e}")))?;
    let Some(link) = download.get("link").and_then(Value::as_str) else {
        return Err(AppError::Internal(
            "opensubtitles download returned no link".into(),
        ));
    };
    let srt = http
        .get(link)
        .header("User-Agent", OPENSUBTITLES_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("subtitle fetch failed: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("subtitle fetch body: {e}")))?;

    let vtt = crate::subtitles::srt_to_vtt(&srt);
    let dir = &state.config.subtitles_dir;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::Internal(format!("subtitles dir: {e}")))?;
    let dest = dir.join(crate::subtitles::sidecar_name(&kind, id, &lang, "os"));
    tokio::fs::write(&dest, vtt)
        .await
        .map_err(|e| AppError::Internal(format!("subtitle write: {e}")))?;

    Ok(Json(json!({
        "ok": true,
        "language": lang,
        "source": "os",
        "url": subtitle_url(&kind, id, &lang, "os"),
    })))
}

pub(super) async fn subtitle_job_status() -> AppResult<Json<Value>> {
    Ok(Json(json!({
        "job": crate::subtitles::job_status(),
    })))
}

pub(super) async fn transcribe_subtitle(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<SubtitleLangBody>>,
) -> AppResult<axum::response::Response> {
    let Some(bin) = state.config.whisper_bin.clone() else {
        return Err(AppError::FeatureDisabled(
            "transcription requires WHISPER_BIN".into(),
        ));
    };
    let lang = crate::subtitles::sanitize_token(
        body.and_then(|Json(b)| b.language)
            .as_deref()
            .unwrap_or("en"),
    );
    let (path, _, _) = subtitle_media_lookup(&state, &kind, id).await?;

    let status = crate::subtitles::job_json(&kind, id, &lang, "running", None);
    if let Err(running) = crate::subtitles::claim_job(status) {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "transcription already running", "job": running })),
        )
            .into_response());
    }

    let dir = state.config.subtitles_dir.clone();
    let dest = dir.join(crate::subtitles::sidecar_name(&kind, id, &lang, "whisper"));
    let model = state.config.whisper_model.clone();
    let kind_owned = kind.clone();
    let lang_job = lang.clone();
    // Detached: Whisper on a full movie runs for many minutes. Progress is
    // observable via GET /subtitles/status; the slot frees on completion.
    tokio::spawn(async move {
        let lang = lang_job;
        let result = run_whisper_job(&bin, model.as_deref(), &path, &dir, &dest, &lang).await;
        let (job_state, detail) = match &result {
            Ok(()) => ("done", None),
            Err(e) => ("error", Some(e.as_str())),
        };
        crate::subtitles::finish_job(crate::subtitles::job_json(
            &kind_owned,
            id,
            &lang,
            job_state,
            detail,
        ));
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "ok": true,
            "state": "running",
            "url": subtitle_url(&kind, id, &lang, "whisper"),
        })),
    )
        .into_response())
}

/// Run the Whisper CLI into a scratch dir, then move its `<stem>.vtt` output
/// to the canonical sidecar name. Scratch keeps concurrent-looking filenames
/// (two ids sharing a stem) from clobbering each other.
pub(super) async fn run_whisper_job(
    bin: &str,
    model: Option<&str>,
    input: &str,
    subtitles_dir: &std::path::Path,
    dest: &std::path::Path,
    lang: &str,
) -> Result<(), String> {
    let input_path = std::path::Path::new(input);
    let scratch = subtitles_dir.join(format!(
        ".whisper-{}",
        dest.file_stem().unwrap_or_default().to_string_lossy()
    ));
    tokio::fs::create_dir_all(&scratch)
        .await
        .map_err(|e| format!("scratch dir: {e}"))?;

    let args = crate::subtitles::whisper_args(input_path, &scratch, model, Some(lang));
    let output = match tokio::process::Command::new(bin).args(&args).output().await {
        Ok(o) => o,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&scratch).await;
            return Err(format!("spawn {bin}: {e}"));
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.chars().rev().take(400).collect::<String>();
        let tail: String = tail.chars().rev().collect();
        let _ = tokio::fs::remove_dir_all(&scratch).await;
        return Err(format!("whisper exited {}: {tail}", output.status));
    }

    let produced = crate::subtitles::whisper_output_path(&scratch, input_path);
    let rename_result = tokio::fs::rename(&produced, dest).await;
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    rename_result.map_err(|e| format!("move {}: {e}", produced.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use std::sync::Arc;
    use tower::ServiceExt;

    /// Off-mode state with the subtitle store pointed at a temp dir.
    async fn test_state_subtitles(dir: &std::path::Path) -> AppState {
        let state = test_state().await;
        let mut config = (*state.config).clone();
        config.subtitles_dir = dir.to_path_buf();
        AppState {
            config: Arc::new(config),
            ..state
        }
    }

    #[tokio::test]
    async fn subtitle_endpoints_gate_on_unconfigured_features() {
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/subgate.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        let app = crate::build_router(state);

        // No OPENSUBTITLES_API_KEY → 503 feature-disabled (not 500).
        let dl = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/subtitles/movie/{movie_id}/download?sub=plex:1"),
                json!({ "language": "en" }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(dl.status(), StatusCode::SERVICE_UNAVAILABLE);
        let v = body_json(dl).await;
        assert!(
            v["error"].as_str().unwrap().contains("OPENSUBTITLES"),
            "{v}"
        );

        // No WHISPER_BIN → 503 feature-disabled.
        let tr = app
            .clone()
            .oneshot(json_req(
                "POST",
                format!("/api/media/subtitles/movie/{movie_id}/transcribe?sub=plex:1"),
                json!({}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(tr.status(), StatusCode::SERVICE_UNAVAILABLE);

        // Unknown kind → 400; unknown id → 404 (would first need the key, so
        // exercise via the list endpoint which needs no config).
        let bad_kind = app
            .clone()
            .oneshot(req("GET", "/api/media/subtitles/song/1?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(bad_kind.status(), StatusCode::BAD_REQUEST);

        // Status starts idle.
        let status = app
            .oneshot(req("GET", "/api/media/subtitles/status?sub=plex:1"))
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);
        assert!(body_json(status).await["job"].is_null());
    }

    #[tokio::test]
    async fn subtitle_store_lists_and_serves_vtt() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state_subtitles(tmp.path()).await;
        let file_id = seed_media_file(&state, "/lib/substore.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        std::fs::write(
            tmp.path().join(format!("movie_{movie_id}_en_os.vtt")),
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n",
        )
        .unwrap();
        let app = crate::build_router(state);

        let list = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/subtitles/movie/{movie_id}?sub=plex:1"),
            ))
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::OK);
        let v = body_json(list).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["language"], "en");
        assert_eq!(items[0]["source"], "os");

        let file = app
            .clone()
            .oneshot(req(
                "GET",
                format!(
                    "/api/media/subtitles/movie/{movie_id}/file?sub=plex:1&language=en&source=os"
                ),
            ))
            .await
            .unwrap();
        assert_eq!(file.status(), StatusCode::OK);
        assert_eq!(
            file.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "text/vtt; charset=utf-8"
        );

        // Absent language → 404; traversal-shaped tokens sanitize to a name
        // that simply does not exist (never an escape).
        let missing = app
            .oneshot(req(
                "GET",
                format!(
                    "/api/media/subtitles/movie/{movie_id}/file?sub=plex:1&language=..%2F..&source=os"
                ),
            ))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    /// Scratch-dir path `run_whisper_job` derives from the sidecar destination.
    fn whisper_scratch_for(
        subtitles_dir: &std::path::Path,
        dest: &std::path::Path,
    ) -> std::path::PathBuf {
        subtitles_dir.join(format!(
            ".whisper-{}",
            dest.file_stem().unwrap().to_string_lossy()
        ))
    }

    #[tokio::test]
    async fn run_whisper_job_cleans_scratch_when_output_missing() {
        // A whisper that exits 0 without writing its .vtt makes the final rename
        // fail. The scratch dir must not survive that error path — otherwise every
        // failed transcode leaves a `.whisper-<stem>` turd in the subtitles dir.
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("fake-whisper.sh");
        std::fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let subtitles_dir = tmp.path().join("subs");
        std::fs::create_dir_all(&subtitles_dir).unwrap();
        let input = tmp.path().join("movie.mkv");
        std::fs::write(&input, b"bytes").unwrap();
        let dest = subtitles_dir.join("movie.1.en.whisper.vtt");
        let scratch = whisper_scratch_for(&subtitles_dir, &dest);

        let err = super::run_whisper_job(
            bin.to_str().unwrap(),
            None,
            input.to_str().unwrap(),
            &subtitles_dir,
            &dest,
            "en",
        )
        .await
        .unwrap_err();

        assert!(
            err.starts_with("move "),
            "expected rename failure, got: {err}"
        );
        assert!(!dest.exists(), "no sidecar should be published");
        assert!(
            !scratch.exists(),
            "scratch dir leaked after rename failure: {}",
            scratch.display()
        );
    }

    #[tokio::test]
    async fn run_whisper_job_cleans_scratch_when_spawn_fails() {
        // Same invariant on the earlier exit: a missing/unexecutable WHISPER_BIN
        // must not leave the scratch dir it just created behind.
        let tmp = tempfile::tempdir().unwrap();
        let subtitles_dir = tmp.path().join("subs");
        std::fs::create_dir_all(&subtitles_dir).unwrap();
        let dest = subtitles_dir.join("movie.2.en.whisper.vtt");
        let scratch = whisper_scratch_for(&subtitles_dir, &dest);
        let missing_bin = tmp.path().join("no-such-whisper");

        let err = super::run_whisper_job(
            missing_bin.to_str().unwrap(),
            None,
            "/lib/movie.mkv",
            &subtitles_dir,
            &dest,
            "en",
        )
        .await
        .unwrap_err();

        assert!(
            err.starts_with("spawn "),
            "expected spawn failure, got: {err}"
        );
        assert!(
            !scratch.exists(),
            "scratch dir leaked after spawn failure: {}",
            scratch.display()
        );
    }
}
