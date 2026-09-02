//! Sidecar subtitles: OpenSubtitles download + Whisper transcription.

use super::*;
use crate::ssrf_guard;

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

/// Reachability policy for the [`fetch_subtitle_link`] hop. Production is
/// always `Guarded`. The size-cap and redirect tests below serve from a
/// `127.0.0.1` listener -- an address the guard correctly refuses -- so the
/// non-SSRF tests need the reachability check skipped to reach the
/// streaming/decode paths they are actually about. The permissive variant is
/// `#[cfg(test)]`: it does not exist in a release build, so this is a test
/// seam, not a production bypass. `download_subtitle_rejects_redirect_to_loopback`
/// pins that the public entry point still guards every hop.
#[derive(Clone, Copy)]
enum LinkReachability {
    Guarded,
    #[cfg(test)]
    SkipForLoopbackTests,
    /// Skip the guard on the first hop only -- the test harness runs entirely
    /// on 127.0.0.1, which the guard correctly refuses -- while every
    /// redirect target is still guarded for real. This is what proves
    /// `guard_url` revalidates each `Location`, not just the initial URL.
    #[cfg(test)]
    SkipFirstHopForLoopbackTests,
}

/// Read a JSON body through the same declared-then-streamed size cap as the
/// `.srt` body itself, rather than `.json()`, which buffers to EOF with no
/// bound. `what` names the hop for the error message. These two hops go to
/// `opensubtitles_base()` (operator config, not attacker input), so no SSRF
/// guard applies here -- only the memory-exhaustion bound.
async fn read_capped_json(mut resp: reqwest::Response, what: &str) -> AppResult<Value> {
    let cap = crate::subtitles::MAX_SUBTITLE_API_JSON_BYTES;
    let too_big = || {
        AppError::Internal(format!(
            "opensubtitles {what} body exceeds {cap} byte limit"
        ))
    };
    if let Some(len) = resp.content_length()
        && len as usize > cap
    {
        return Err(too_big());
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles {what} body: {e}")))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > cap {
            return Err(too_big());
        }
    }
    serde_json::from_slice(&body)
        .map_err(|e| AppError::Internal(format!("opensubtitles {what} body: {e}")))
}

/// Fetch the OpenSubtitles-supplied `link` -- attacker-influenced, since it
/// comes back inside the download-lookup response -- through a redirect-
/// revalidating SSRF guard, mirroring `podcasts::fetch_feed_inner`: a
/// dedicated client with `redirect::Policy::none()` so every hop (the
/// initial URL AND each `Location`) clears [`ssrf_guard::guard_url`] before
/// we connect, plus the same declared-then-streamed byte cap used for the
/// two JSON hops above.
async fn fetch_subtitle_link(link: &str, reach: LinkReachability) -> AppResult<Vec<u8>> {
    let mut current = reqwest::Url::parse(link).map_err(|_| {
        AppError::Internal("opensubtitles download returned an invalid link".into())
    })?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Internal(format!("subtitle client build failed: {e}")))?;

    let cap = crate::subtitles::MAX_SUBTITLE_BYTES;
    let too_big = || AppError::Internal(format!("subtitle body exceeds {cap} byte limit"));

    for _hop in 0..=ssrf_guard::MAX_REDIRECTS {
        let must_guard = match reach {
            LinkReachability::Guarded => true,
            #[cfg(test)]
            LinkReachability::SkipForLoopbackTests => false,
            #[cfg(test)]
            LinkReachability::SkipFirstHopForLoopbackTests => _hop != 0,
        };
        if must_guard {
            ssrf_guard::guard_url(&current)
                .await
                .map_err(AppError::Internal)?;
        }
        let mut resp = client
            .get(current.clone())
            .header("User-Agent", OPENSUBTITLES_USER_AGENT)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("subtitle fetch failed: {e}")))?;

        if resp.status().is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    AppError::Internal("subtitle fetch failed: redirect without location".into())
                })?;
            current = current.join(location).map_err(|_| {
                AppError::Internal(format!(
                    "subtitle fetch failed: bad redirect target: {location}"
                ))
            })?;
            continue;
        }

        if let Some(len) = resp.content_length()
            && len as usize > cap
        {
            return Err(too_big());
        }
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| AppError::Internal(format!("subtitle fetch body: {e}")))?
        {
            body.extend_from_slice(&chunk);
            if body.len() > cap {
                return Err(too_big());
            }
        }
        return Ok(body);
    }
    Err(AppError::Internal(format!(
        "subtitle fetch failed: too many redirects (>{})",
        ssrf_guard::MAX_REDIRECTS
    )))
}

pub(super) async fn download_subtitle(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<SubtitleLangBody>>,
) -> AppResult<Json<Value>> {
    download_subtitle_inner(
        state,
        claims.map(|Extension(c)| c),
        kind,
        id,
        body,
        LinkReachability::Guarded,
    )
    .await
}

async fn download_subtitle_inner(
    state: AppState,
    claims: Option<InternalClaims>,
    kind: String,
    id: i64,
    body: Option<Json<SubtitleLangBody>>,
    reach: LinkReachability,
) -> AppResult<Json<Value>> {
    require_admin(&claims, &state.config.principal_mode)?;
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
    let search_resp = http
        .get(&search_url)
        .header("Api-Key", &api_key)
        .header("User-Agent", OPENSUBTITLES_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles search failed: {e}")))?;
    let search = read_capped_json(search_resp, "search").await?;
    let candidates = crate::subtitles::parse_search_results(&search);
    let Some(best) = crate::subtitles::pick_best(&candidates) else {
        return Err(AppError::NotFound);
    };

    let download_resp = http
        .post(format!("{base}/api/v1/download"))
        .header("Api-Key", &api_key)
        .header("User-Agent", OPENSUBTITLES_USER_AGENT)
        .json(&json!({ "file_id": best.file_id }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("opensubtitles download failed: {e}")))?;
    let download = read_capped_json(download_resp, "download").await?;
    let Some(link) = download.get("link").and_then(Value::as_str) else {
        return Err(AppError::Internal(
            "opensubtitles download returned no link".into(),
        ));
    };
    let body = fetch_subtitle_link(link, reach).await?;
    let srt = String::from_utf8_lossy(&body).into_owned();

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

    /// `opensubtitles_base()` reads a process-wide env var, so the download
    /// tests below cannot overlap. Async-aware because the guard is held
    /// across the handler's `.await`.
    static OPENSUBTITLES_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Subtitle-store state with the OpenSubtitles key wired and one movie
    /// carrying an imdb id (the download path 400s without one).
    async fn test_state_opensubtitles(dir: &std::path::Path) -> (AppState, i64) {
        let state = test_state_subtitles(dir).await;
        let mut config = (*state.config).clone();
        // The mock never reads the Api-Key header; the value only has to be
        // Some so the handler clears its feature gate.
        let dummy_key = Some("not-a-credential".to_string());
        config.opensubtitles_api_key = dummy_key;
        let state = AppState {
            config: Arc::new(config),
            ..state
        };
        let file_id = seed_media_file(&state, "/lib/oscap.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        sqlx::query("UPDATE movies SET imdb_id = ? WHERE id = ?")
            .bind("tt0111161")
            .bind(movie_id)
            .execute(&state.db.pool)
            .await
            .unwrap();
        (state, movie_id)
    }

    /// Point `opensubtitles_base()` at `base` and run the handler with a
    /// caller-chosen reachability policy, failing the test rather than
    /// hanging if it does not settle. The budget is deliberately shorter than
    /// `subtitles_http()`'s own 15s client timeout, so "bailed on the size
    /// cap" cannot be confused with "gave up when the request timed out".
    async fn download_subtitle_inner_bounded(
        base: &str,
        state: AppState,
        movie_id: i64,
        reach: LinkReachability,
    ) -> AppResult<Json<Value>> {
        let _guard = OPENSUBTITLES_ENV.lock().await;
        unsafe { std::env::set_var("OPENSUBTITLES_API_URL", base) };
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            download_subtitle_inner(state, None, "movie".to_string(), movie_id, None, reach),
        )
        .await;
        unsafe { std::env::remove_var("OPENSUBTITLES_API_URL") };
        out.expect("download_subtitle must settle on its own, not stall until the request timeout")
    }

    /// The plain-path helper used by every test that is not itself about the
    /// SSRF guard: the `.srt` hop's reachability check is skipped because the
    /// test server is on 127.0.0.1, which the guard correctly refuses.
    async fn download_subtitle_bounded(
        base: &str,
        state: AppState,
        movie_id: i64,
    ) -> AppResult<Json<Value>> {
        download_subtitle_inner_bounded(
            base,
            state,
            movie_id,
            LinkReachability::SkipForLoopbackTests,
        )
        .await
    }

    fn assert_subtitle_size_cap_error(err: &AppError) {
        let msg = err.to_string();
        assert!(
            msg.contains("exceeds") && msg.contains("byte limit"),
            "expected a size-cap rejection, got: {msg}"
        );
    }

    /// Serve the search + download-link hops off one ephemeral port, sized so
    /// exactly `oversized_hop` ("search" or "download") sends a body that
    /// exceeds `MAX_SUBTITLE_API_JSON_BYTES`, declares no `Content-Length`,
    /// and never closes the connection -- an implementation that buffers via
    /// `.json()` hangs forever; the running byte-counter must bail on its
    /// own. The other hop, if reached at all, gets an ordinary reply so the
    /// flow can actually get there.
    fn spawn_opensubtitles_oversized_json_server(oversized_hop: &'static str) -> String {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let path = head.split_whitespace().nth(1).unwrap_or("/");
                    let hop = if path.starts_with("/api/v1/subtitles") {
                        "search"
                    } else if path.starts_with("/api/v1/download") {
                        "download"
                    } else {
                        ""
                    };

                    if hop == oversized_hop {
                        let mut resp =
                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n".to_vec();
                        resp.extend(std::iter::repeat_n(
                            b'a',
                            crate::subtitles::MAX_SUBTITLE_API_JSON_BYTES + 1024,
                        ));
                        let _ = stream.write_all(&resp);
                        loop {
                            std::thread::park();
                        }
                    }

                    let json = |body: String| {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .into_bytes()
                    };
                    // Only reachable when `oversized_hop` is "download" (the
                    // search hop below must succeed first) -- this is the
                    // ordinary search reply so the flow can get there.
                    let response = json(
                        json!({ "data": [
                            { "attributes": {
                                "download_count": 10,
                                "from_trusted": true,
                                "hearing_impaired": false,
                                "files": [{ "file_id": 42 }],
                            } }
                        ] })
                        .to_string(),
                    );
                    let _ = stream.write_all(&response);
                });
            }
        });

        format!("http://{addr}")
    }

    /// Serve the search + download-link hops normally, but the download link
    /// itself points back at a `/redirect` path on this same server that
    /// 302s to `redirect_location` -- a loopback/link-local target the
    /// guard must reject before any connection to it is attempted.
    fn spawn_opensubtitles_redirect_server(redirect_location: &'static str) -> String {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let path = head.split_whitespace().nth(1).unwrap_or("/");

                    let json = |body: String| {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .into_bytes()
                    };
                    let response = if path.starts_with("/api/v1/subtitles") {
                        json(
                            json!({ "data": [
                                { "attributes": {
                                    "download_count": 10,
                                    "from_trusted": true,
                                    "hearing_impaired": false,
                                    "files": [{ "file_id": 42 }],
                                } }
                            ] })
                            .to_string(),
                        )
                    } else if path.starts_with("/api/v1/download") {
                        json(json!({ "link": format!("http://{addr}/redirect") }).to_string())
                    } else {
                        // /redirect: the SSRF guard must reject this target
                        // before ever connecting to it, so this response is
                        // never followed by a correct implementation.
                        format!(
                            "HTTP/1.1 302 Found\r\nLocation: {redirect_location}\r\n\
                             Content-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .into_bytes()
                    };
                    let _ = stream.write_all(&response);
                });
            }
        });

        format!("http://{addr}")
    }

    /// Serve all three OpenSubtitles hops — search, download-link, and the
    /// `.srt` body itself — off one ephemeral port. Raw TCP rather than axum
    /// because the srt hop must be able to emit wire shapes a real server
    /// never would: a body with no `Content-Length`, or a declared length with
    /// no body. When `hold_open`, the srt connection is deliberately never
    /// closed, so an implementation that buffers to EOF (the old `.text()`
    /// behavior) hangs instead of bailing on the cap.
    fn spawn_opensubtitles_server(srt_response: Vec<u8>, hold_open: bool) -> String {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let srt_response = srt_response.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let path = head.split_whitespace().nth(1).unwrap_or("/");

                    let json = |body: String| {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .into_bytes()
                    };
                    let response = if path.starts_with("/api/v1/subtitles") {
                        json(
                            json!({ "data": [
                                { "attributes": {
                                    "download_count": 10,
                                    "from_trusted": true,
                                    "hearing_impaired": false,
                                    "files": [{ "file_id": 42 }],
                                } }
                            ] })
                            .to_string(),
                        )
                    } else if path.starts_with("/api/v1/download") {
                        json(json!({ "link": format!("http://{addr}/sub.srt") }).to_string())
                    } else {
                        srt_response
                    };
                    let _ = stream.write_all(&response);
                    if hold_open && !path.starts_with("/api/v1/") {
                        loop {
                            std::thread::park();
                        }
                    }
                });
            }
        });

        format!("http://{addr}")
    }

    /// The other half of the guard: when the server *declares* an oversized
    /// body up front, the preflight must reject on the header alone. This
    /// server sends a 5 MiB + 1 `Content-Length` and then not a single body
    /// byte, so the only way to settle inside the budget is to have never
    /// started reading the body — deleting the `content_length()` preflight
    /// makes this stall until the request timeout instead.
    #[tokio::test]
    async fn download_subtitle_rejects_declared_oversized_content_length_before_reading_body() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, movie_id) = test_state_opensubtitles(tmp.path()).await;

        let declared = crate::subtitles::MAX_SUBTITLE_BYTES + 1;
        let srt = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {declared}\r\n\r\n"
        );
        let base = spawn_opensubtitles_server(srt.into_bytes(), true);

        let err = download_subtitle_bounded(&base, state, movie_id)
            .await
            .expect_err("a declared oversized Content-Length must be rejected");
        assert_subtitle_size_cap_error(&err);
    }

    /// A hostile/compromised OpenSubtitles response must not be able to
    /// exhaust memory by streaming an unbounded subtitle body. This server
    /// sends just over the cap and then neither declares a `Content-Length`
    /// nor closes the connection — an implementation that buffers to EOF hangs
    /// forever waiting for a body-end signal that never arrives. The running
    /// byte-counter must bail the moment it crosses the cap, so this resolves
    /// well inside the budget and nothing is written to the subtitle store.
    #[tokio::test]
    async fn download_subtitle_rejects_oversized_body_without_waiting_for_eof() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, movie_id) = test_state_opensubtitles(tmp.path()).await;

        let mut srt = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n".to_vec();
        srt.extend(std::iter::repeat_n(
            b'a',
            crate::subtitles::MAX_SUBTITLE_BYTES + 1024,
        ));
        let base = spawn_opensubtitles_server(srt, true);

        let err = download_subtitle_bounded(&base, state, movie_id)
            .await
            .expect_err("an oversized subtitle body must be rejected");
        assert_subtitle_size_cap_error(&err);
        assert!(
            std::fs::read_dir(tmp.path()).unwrap().next().is_none(),
            "a rejected oversized body must not land in the subtitle store"
        );
    }

    /// The download-link hop's response must not be buffered unbounded via
    /// `.json()` either.
    #[tokio::test]
    async fn download_subtitle_rejects_oversized_download_response_without_waiting_for_eof() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, movie_id) = test_state_opensubtitles(tmp.path()).await;
        let base = spawn_opensubtitles_oversized_json_server("download");

        let err = download_subtitle_bounded(&base, state, movie_id)
            .await
            .expect_err("an oversized download-link response must be rejected");
        assert_subtitle_size_cap_error(&err);
    }

    /// The search hop's response must not be buffered unbounded via `.json()`.
    #[tokio::test]
    async fn download_subtitle_rejects_oversized_search_response_without_waiting_for_eof() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, movie_id) = test_state_opensubtitles(tmp.path()).await;
        let base = spawn_opensubtitles_oversized_json_server("search");

        let err = download_subtitle_bounded(&base, state, movie_id)
            .await
            .expect_err("an oversized search response must be rejected");
        assert_subtitle_size_cap_error(&err);
    }

    /// `guard_url` must revalidate every redirect hop, not just the initial
    /// link -- a 302 the OpenSubtitles response's own `link` issues into
    /// loopback/link-local space must be rejected before any connection to
    /// that target is attempted. Only the first hop's guard is skipped here
    /// (the test server itself is on 127.0.0.1); the `/redirect` target is
    /// guarded for real, which is what proves per-hop revalidation rather
    /// than just an initial-URL check.
    #[tokio::test]
    async fn download_subtitle_rejects_redirect_to_loopback() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, movie_id) = test_state_opensubtitles(tmp.path()).await;
        let base = spawn_opensubtitles_redirect_server("http://169.254.169.254/latest/meta-data/");

        let err = download_subtitle_inner_bounded(
            &base,
            state,
            movie_id,
            LinkReachability::SkipFirstHopForLoopbackTests,
        )
        .await
        .expect_err("a redirect into link-local space must be rejected");
        let msg = err.to_string();
        assert!(
            msg.contains("blocked private/reserved address")
                || msg.contains("blocked internal hostname"),
            "expected an SSRF rejection, got: {msg}"
        );
    }

    /// The cap must not break the normal path: an ordinary under-cap `.srt`
    /// still streams through the byte-counter and converts to the same WebVTT
    /// that feeding the srt straight to `srt_to_vtt` produces.
    #[tokio::test]
    async fn download_subtitle_stores_an_under_cap_srt_as_vtt() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, movie_id) = test_state_opensubtitles(tmp.path()).await;

        let srt_text = "1\r\n00:00:01,000 --> 00:00:02,500\r\nhello there\r\n";
        let srt = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n{srt_text}",
            srt_text.len()
        );
        let base = spawn_opensubtitles_server(srt.into_bytes(), false);

        let Json(v) = download_subtitle_bounded(&base, state, movie_id)
            .await
            .expect("an under-cap subtitle must download");
        assert_eq!(v["ok"], true);
        assert_eq!(v["source"], "os");
        assert_eq!(v["language"], "en");

        let stored =
            std::fs::read_to_string(tmp.path().join(format!("movie_{movie_id}_en_os.vtt")))
                .unwrap();
        assert_eq!(stored, crate::subtitles::srt_to_vtt(srt_text));
        assert!(stored.starts_with("WEBVTT"), "{stored}");
        // srt's comma decimal separator becomes WebVTT's dot.
        assert!(stored.contains("00:00:01.000 --> 00:00:02.500"), "{stored}");
    }
}
