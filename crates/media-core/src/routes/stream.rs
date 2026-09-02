//!/ Process-wide HTTP client for the outbound transcoder handoff. Built once and
//!/ reused so each transcode-required request does not spin up a fresh connection
//!/ pool. A short timeout keeps a slow/dead transcoder from holding the request
//!/ open — on timeout we fall back to the `503 transcoder required` path.

use super::library::prewarm_next_episode;
use super::*;

pub(super) fn transcoder_http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default()
    })
}
// ── Playback ────────────────────────────────────────────────────────────

/// Resolve the backing `media_files` row for a `(kind, id)` pair. `movie`
/// and `episode` both carry a `file_id` foreign key into `media_files`.
pub(super) async fn resolve_media_file(
    state: &AppState,
    kind: &str,
    id: i64,
) -> AppResult<MediaFileRow> {
    let file_id: i64 = match kind {
        "movie" => sqlx::query_scalar("SELECT file_id FROM movies WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        "episode" => sqlx::query_scalar("SELECT file_id FROM episodes WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        // A track's backing file lives in `tracks.media_file_id`; from here on
        // it flows through the identical media_files → ServeFile range path.
        "track" => sqlx::query_scalar("SELECT media_file_id FROM tracks WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        // Audiobooks are keyed the same way (same probe, same range path).
        "audiobook" => sqlx::query_scalar("SELECT media_file_id FROM audiobooks WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or(AppError::NotFound)?,
        _ => return Err(AppError::BadRequest(format!("unknown media kind: {kind}"))),
    };

    sqlx::query_as::<_, MediaFileRow>(
        "SELECT id, path, size_bytes, mtime, container, duration_secs, video_codec, \
         video_height, video_profile, hdr_format, audio_tracks_json, subtitle_tracks_json, \
         scanned_at FROM media_files WHERE id = ?",
    )
    .bind(file_id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or(AppError::NotFound)
}

pub(super) async fn play_grant(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Path((kind, id)): Path<(String, i64)>,
    body: Option<Json<ClientCaps>>,
) -> AppResult<Json<Value>> {
    let file = resolve_media_file(&state, &kind, id).await?;
    let caps = body.map(|Json(c)| c).unwrap_or_default();
    // Audio always direct-plays (never transcoded); video runs the capability
    // decision against the advertised client caps.
    let (direct_play, reason) = if kind == "track" || kind == "audiobook" {
        (true, "audio direct play".to_string())
    } else {
        let decision = capability::decide(&file, &caps);
        (decision.direct_play, decision.reason)
    };

    // Autoplay-next: warm the next episode's keyframes now so its first play scrubs
    // too (best-effort, fire-and-forget; no-op for movies / the last episode).
    if kind == "episode" {
        tokio::spawn(prewarm_next_episode(
            state.clone(),
            claims.map(|Extension(c)| c),
            id,
        ));
    }

    Ok(Json(json!({
        "directPlay": direct_play,
        "transcoderRequired": !direct_play,
        "reason": reason,
        "file": {
            "container": file.container,
            "duration_secs": file.duration_secs,
            "video_codec": file.video_codec,
            "video_height": file.video_height,
            "hdr_format": file.hdr_format,
            "audio_tracks": file.audio_tracks(),
            "subtitle_tracks": file.subtitle_tracks(),
        },
        "streamUrl": format!("/api/media/stream/{kind}/{id}"),
    })))
}

/// Optional client capabilities advertised on the stream request as query
/// params, so a GET can carry the same direct-play contract that `play_grant`
/// computes from a JSON body — including `max_bitrate` (bits/second) and the
/// audio/fmp4 fields. All fields are optional; absent caps mean "no
/// constraints advertised" and the file streams directly (back-compat).
/// Absent `audio_codecs`/`aac_max_channels` fall back to the browser-safe
/// defaults `ClientCaps` carries (AAC-only, ≤2ch).
#[derive(Debug, Deserialize, Default)]
pub(super) struct StreamCapsQuery {
    containers: Option<String>,
    video_codecs: Option<String>,
    max_height: Option<i64>,
    max_bitrate: Option<i64>,
    #[serde(default)]
    hdr: bool,
    audio_codecs: Option<String>,
    aac_max_channels: Option<i64>,
    #[serde(default)]
    hls_fmp4_hevc: bool,
    /// Native HLS player (AVPlayer) — opt into multi-audio muxing for in-band
    /// language switching. Browser/MSE clients omit it (single English track).
    #[serde(default)]
    native_hls: bool,
    /// Client pipeline applies Dolby Vision RPUs itself — gates DV
    /// direct-play and the transcoder's DV copy passthrough.
    #[serde(default)]
    dolby_vision: bool,
    #[serde(default)]
    start_secs: Option<u64>,
    /// Client explicitly requested buffered (HLS) delivery: bypass the
    /// direct-play decision and hand off to the transcoder, which resolves a
    /// direct-play-eligible file to a lossless copy-remux session.
    #[serde(default)]
    force_transcode: bool,
}

impl StreamCapsQuery {
    /// True when the client advertised any capability constraint at all.
    fn advertised(&self) -> bool {
        self.containers.is_some()
            || self.video_codecs.is_some()
            || self.max_height.is_some()
            || self.max_bitrate.is_some()
            || self.hdr
            || self.audio_codecs.is_some()
            || self.aac_max_channels.is_some()
            || self.hls_fmp4_hevc
            || self.dolby_vision
            || self.force_transcode
    }

    fn to_caps(&self) -> ClientCaps {
        let split = |s: &Option<String>| {
            s.as_deref()
                .map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let defaults = ClientCaps::default();
        ClientCaps {
            containers: split(&self.containers),
            video_codecs: split(&self.video_codecs),
            max_height: self.max_height,
            hdr: self.hdr,
            max_bitrate: self.max_bitrate,
            audio_codecs: match split(&self.audio_codecs) {
                v if v.is_empty() => defaults.audio_codecs,
                v => v,
            },
            aac_max_channels: self.aac_max_channels.unwrap_or(defaults.aac_max_channels),
            hls_fmp4_hevc: self.hls_fmp4_hevc,
            native_hls: self.native_hls,
            dolby_vision: self.dolby_vision,
        }
    }
}

/// Mint a fresh internal-principal Bearer for the media-core → transcoder hop.
///
/// We do NOT forward the caller's inbound token: it has a 60s TTL already partly
/// spent, and media-core only holds the *verified claims* (not a reusable raw
/// Bearer). Instead we re-mint from the verified claims using the same shared
/// `INTERNAL_PRINCIPAL_SECRET` both services hold, with a fresh time window — so
/// the transcoder verifies it identically. Returns `None` when there is no
/// secret or no verified claims (the `Off`-mode dev path, where the transcoder
/// is also `Off` and needs no Bearer).
pub(super) fn mint_transcoder_principal(
    state: &AppState,
    claims: &Option<InternalClaims>,
) -> Option<String> {
    let secret = state.config.internal_principal_secret.as_ref()?;
    let inbound = claims.as_ref()?;
    let now = chrono::Utc::now().timestamp();
    let fresh = InternalClaims {
        iss: inbound.iss.clone(),
        sub: inbound.sub.clone(),
        role: inbound.role.clone(),
        auth_mode: inbound.auth_mode.clone(),
        server_id: inbound.server_id.clone(),
        device_id: inbound.device_id.clone(),
        req_id: format!("mc-tx-{now}"),
        iat: now,
        exp: now + emerald_contracts::internal_principal::DEFAULT_TTL_SECS,
    };
    Some(emerald_contracts::internal_principal::encrypt_with_secret(
        secret.as_bytes(),
        &fresh,
    ))
}

/// Everything the transcoder handoff needs for one transcode-required request,
/// bundled so the call does not balloon into a positional-argument soup.
pub(super) struct TranscodeHandoff<'a> {
    file: &'a MediaFileRow,
    caps: &'a ClientCaps,
    kind: &'a str,
    id: i64,
    claims: &'a Option<InternalClaims>,
    start_secs: u64,
    /// The capability decision reason, echoed back in the grant for the client.
    reason: &'a str,
    /// Forward the client's explicit buffered-delivery request so the
    /// transcoder skips its own DirectPlay short-circuit.
    force_transcode: bool,
}

impl TranscodeHandoff<'_> {
    /// Build the transcoder `POST /api/transcode/grant` body. The transcoder's
    /// `GrantRequest`/`GrantFile`/`ClientCaps` deserialize from these exact
    /// field names (verified against transcoder/src/routes.rs), so we serialize
    /// by hand — `ClientCaps`/`MediaFileRow` are not symmetrically
    /// `Serialize`/`Deserialize` on this side, but the JSON contract is fixed.
    fn grant_body(&self) -> Value {
        let sub = self
            .claims
            .as_ref()
            .map(|c| c.sub.as_str())
            .unwrap_or_default();
        json!({
            "file": {
                "path": self.file.path,
                "container": self.file.container,
                // size powers the transcoder's source-relative bitrate cap
                // (avg bps = size_bytes * 8 / duration_secs).
                "size_bytes": self.file.size_bytes,
                "duration_secs": self.file.duration_secs,
                "video_codec": self.file.video_codec,
                "video_height": self.file.video_height,
                "video_profile": self.file.video_profile,
                "hdr_format": self.file.hdr_format,
                "audio_tracks_json": self.file.audio_tracks_json,
                "subtitle_tracks_json": self.file.subtitle_tracks_json,
            },
            "caps": {
                "containers": self.caps.containers,
                "video_codecs": self.caps.video_codecs,
                "max_height": self.caps.max_height,
                "hdr": self.caps.hdr,
                "max_bitrate": self.caps.max_bitrate,
                "audio_codecs": self.caps.audio_codecs,
                "aac_max_channels": self.caps.aac_max_channels,
                "hls_fmp4_hevc": self.caps.hls_fmp4_hevc,
                "dolby_vision": self.caps.dolby_vision,
            },
            "media_kind": self.kind,
            "media_id": self.id,
            "sub": sub,
            "start_secs": self.start_secs,
            "force_transcode": self.force_transcode,
        })
    }
}

/// Hand a transcode-required file off to the M4 transcoder and translate its
/// response into the media-core handoff contract. Returns the JSON grant the
/// client (via the Hono proxy) consumes to start HLS playback.
///
/// Failure handling treats an unreachable/slow/erroring transcoder as "offline"
/// → `AppError::TranscoderRequired` (503), identical to the no-URL path, so a
/// transcoder outage degrades to the exact pre-M4 behavior rather than a 500.
pub(super) async fn handoff_to_transcoder(
    state: &AppState,
    transcoder_url: &str,
    handoff: &TranscodeHandoff<'_>,
) -> Result<axum::response::Response, AppError> {
    let claims = handoff.claims;
    let reason = handoff.reason;
    let body = handoff.grant_body();
    let url = format!(
        "{}/api/transcode/grant",
        transcoder_url.trim_end_matches('/')
    );

    let mut request = transcoder_http().post(&url).json(&body);
    if let Some(bearer) = mint_transcoder_principal(state, claims) {
        request = request.bearer_auth(bearer);
    }

    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            // Unreachable/timeout → behave as if no transcoder is configured.
            tracing::warn!(error = %e, url = %url, "transcoder unreachable; treating as offline");
            return Err(AppError::TranscoderRequired);
        }
    };

    let status = resp.status();
    let payload: Value = resp.json().await.unwrap_or_else(|_| json!({}));

    if status.is_success() {
        // The transcoder echoes directPlay:true only if it somehow disagreed
        // with our decision; we only call it on !direct_play, so on that edge
        // fall back to the 503 path rather than shipping a contradictory grant.
        if payload.get("directPlay").and_then(Value::as_bool) == Some(true) {
            tracing::warn!("transcoder returned directPlay on a transcode-required file; refusing");
            return Err(AppError::TranscoderRequired);
        }
        let session_id = payload.get("sessionId").and_then(Value::as_str);
        let manifest_url = payload
            .get("manifestUrl")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| session_id.map(|s| format!("/api/transcode/session/{s}/index.m3u8")));
        let heartbeat_url = payload
            .get("heartbeatUrl")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| session_id.map(|s| format!("/api/transcode/session/{s}/heartbeat")));
        // Forward the transcoder's sidecar-subtitle descriptor verbatim
        // ({ url, language, forced } | null). Its `url` is a transcoder-relative
        // asset path; the Node grant layer stream-token-wraps it like the
        // manifest before the player loads it as a <track>.
        let subtitle = payload.get("subtitle").cloned().unwrap_or(Value::Null);

        return Ok(Json(json!({
            "transcode": true,
            "directPlay": false,
            "sessionId": session_id,
            "manifestUrl": manifest_url,
            "heartbeatUrl": heartbeat_url,
            "subtitle": subtitle,
            "reason": reason,
        }))
        .into_response());
    }

    // Surface a genuine "all transcode slots busy" as a 503 the client can
    // back off on; any other transcoder error also degrades to 503 offline.
    if payload.get("error").and_then(Value::as_str) == Some("transcoder_busy") {
        tracing::info!("transcoder busy at capacity");
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "transcoder_busy" })),
        )
            .into_response());
    }

    tracing::warn!(status = %status, ?payload, "transcoder grant failed; treating as offline");
    Err(AppError::TranscoderRequired)
}

pub(super) async fn stream_file(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, i64)>,
    Query(caps_q): Query<StreamCapsQuery>,
    claims: Option<Extension<InternalClaims>>,
    req: Request,
) -> Result<axum::response::Response, AppError> {
    let file = resolve_media_file(&state, &kind, id).await?;

    // Containment: never serve a file outside the configured roots. A track
    // lives under a MUSIC root, an audiobook under an AUDIOBOOK root;
    // movies/episodes under the video library roots.
    let allowed_roots: Vec<std::path::PathBuf> = match kind.as_str() {
        "track" => state.config.music_roots.clone(),
        "audiobook" => state.config.audiobook_roots.clone(),
        _ => state.config.library_paths(),
    };
    if !path_within_roots(std::path::Path::new(&file.path), &allowed_roots).await {
        tracing::warn!(path = %file.path, "refusing to stream file outside library roots");
        return Err(AppError::NotFound);
    }

    // Honor the direct-play contract (§3.5): if the client advertised caps and
    // the file can't direct-play, hand off to the M4 transcoder when one is
    // configured (MEDIA_TRANSCODER_URL). Without a transcoder this is the
    // M3-only posture, so return 503 rather than shipping undecodable bytes.
    // Audio (`track`/`audiobook`) is ALWAYS direct play — never engage the
    // transcoder — so the capability/handoff branch is skipped entirely for it.
    if kind != "track" && kind != "audiobook" && caps_q.advertised() {
        let caps = caps_q.to_caps();
        let decision = capability::decide(&file, &caps);
        // `force_transcode` bypasses the decision: decide() WILL say
        // direct_play for these files, but the client has asked for buffered
        // (HLS) delivery, so the handoff must be explicit.
        if caps_q.force_transcode || !decision.direct_play {
            let reason = if caps_q.force_transcode {
                "client requested buffered delivery".to_string()
            } else {
                decision.reason
            };
            let claims = claims.map(|Extension(c)| c);
            match state.config.transcoder_url.as_deref() {
                Some(transcoder_url) => {
                    tracing::info!(path = %file.path, reason = %reason, "transcode required; handing off to transcoder");
                    let handoff = TranscodeHandoff {
                        file: &file,
                        caps: &caps,
                        kind: &kind,
                        id,
                        claims: &claims,
                        start_secs: caps_q.start_secs.unwrap_or(0),
                        reason: &reason,
                        force_transcode: caps_q.force_transcode,
                    };
                    return handoff_to_transcoder(&state, transcoder_url, &handoff).await;
                }
                None => {
                    tracing::info!(path = %file.path, reason = %reason, "transcode required; no transcoder configured, returning 503");
                    return Err(AppError::TranscoderRequired);
                }
            }
        }
    }

    // §7-2: bound concurrent direct-play streams. We do NOT put a total-request
    // timeout on this path (it would truncate legitimate multi-hour playback);
    // instead we cap how many serves are in flight. Acquire an owned permit just
    // before serving so the transcoder-handoff and error paths above never
    // consume a slot. When the pool is exhausted, return 503 so a burst of
    // stalled reads against a degraded volume cannot exhaust tokio tasks.
    let permit = state
        .stream_semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::StreamSlotsExhausted)?;

    let service = ServeFile::new(&file.path);
    let mut resp = service
        .oneshot(req)
        .await
        .map_err(|e| AppError::Internal(format!("stream serve failed: {e}")))?
        .into_response();
    // cloudflared buffers tunnel responses by default, which turns each range
    // request of a progressive direct-play into edge-accumulate-then-burst.
    // `X-Accel-Buffering: no` is honored on the tunnel path (proven by the
    // live IPTV .ts proxy) and keeps the bytes streaming client-ward.
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("x-accel-buffering"),
        axum::http::HeaderValue::from_static("no"),
    );
    // Hold the permit for the lifetime of the response (and its streaming body):
    // it drops when the response is dropped after the client finishes or
    // disconnects, freeing the slot.
    resp.extensions_mut()
        .insert(StreamPermit(std::sync::Arc::new(permit)));
    Ok(resp)
}

/// Newtype so the owned stream-concurrency permit can ride in the response
/// extensions (which require `Clone`); it is only ever inserted, never cloned,
/// and exists solely to keep the permit alive until the body is fully sent.
#[derive(Clone)]
pub(super) struct StreamPermit(
    // Held purely for its `Drop` — keeps the concurrency slot reserved until the
    // response body is fully sent. Never read by design, so silence dead_code.
    #[allow(dead_code)] std::sync::Arc<tokio::sync::OwnedSemaphorePermit>,
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::routes::testsupport::*;

    use std::sync::Arc;
    use tower::ServiceExt;

    #[tokio::test]
    async fn play_grant_track_is_always_direct_play() {
        // A track grant must report directPlay:true (audio is never transcoded),
        // regardless of container, and hand back the media stream URL.
        let state = test_state().await;
        let (_a, _al, track_id) =
            seed_track(&state, "Artist", "Album", "Song", 1, "/music/song.flac").await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(req(
                "POST",
                format!("/api/media/play/track/{track_id}/grant"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["directPlay"], true);
        assert_eq!(v["transcoderRequired"], false);
        assert_eq!(
            v["streamUrl"],
            format!("/api/media/stream/track/{track_id}")
        );
    }

    #[tokio::test]
    async fn play_grant_unknown_track_is_404() {
        let state = test_state().await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(req("POST", "/api/media/play/track/9999/grant"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn stream_returns_503_when_concurrency_exhausted() {
        // §7-2: with the stream pool exhausted, a new direct-play request must
        // get 503 rather than spawning another long-lived serve task. Build a
        // state whose semaphore has zero permits available and confirm the 503.
        let mut state = test_state().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.mp4");
        std::fs::write(&path, b"bytes").unwrap();
        let file_id = seed_media_file(&state, path.to_str().unwrap()).await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        // Drain the pool: a 1-permit semaphore with its single permit forgotten.
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        sem.clone().try_acquire_owned().unwrap().forget();
        state.stream_semaphore = sem;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(req("GET", format!("/api/media/stream/movie/{movie_id}")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        // The body must carry the DISTINCT capacity code, not the misleading
        // "transcoder required (M4 offline)" outage message — ops/clients need
        // to tell "retry shortly, at capacity" from "transcoder is down".
        let v = body_json(resp).await;
        assert_eq!(v["error"], "stream_slots_exhausted");
    }

    #[tokio::test]
    async fn stream_refuses_when_client_caps_require_transcode() {
        // A file the advertised client cannot direct-play must 503, not stream.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/hevc.mkv").await;
        // seed_media_file stores container=mp4, codec=h264, height=1080; ask
        // for an mp4/av1 client so codec mismatch forces transcode.
        sqlx::query("INSERT INTO movies (title, year, added_at, file_id) VALUES (?, ?, ?, ?)")
            .bind("Needs Transcode")
            .bind(2020_i64)
            .bind("2026-01-01T00:00:00Z")
            .bind(file_id)
            .execute(&state.db.pool)
            .await
            .unwrap();
        let movie_id: i64 = sqlx::query_scalar("SELECT id FROM movies WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&state.db.pool)
            .await
            .unwrap();

        let app = crate::build_router(state);
        let resp = app
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn stream_refuses_when_bitrate_exceeds_client_max() {
        // The GET stream path must honor ?max_bitrate just like the JSON grant
        // body — previously the param could not be expressed and the cap was
        // silently ignored. 9GB/3600s ≈ 20 Mbps > a 10 Mbps client cap → 503.
        let state = test_state().await;
        sqlx::query(
            "INSERT INTO media_files \
             (path, size_bytes, mtime, container, duration_secs, video_codec, video_height, \
             video_profile, hdr_format, audio_tracks_json, subtitle_tracks_json, scanned_at) \
             VALUES (?, 9000000000, 't', 'mp4', 3600, 'h264', 1080, NULL, NULL, '[]', '[]', 't')",
        )
        .bind("/lib/huge.mp4")
        .execute(&state.db.pool)
        .await
        .unwrap();
        let file_id: i64 = sqlx::query_scalar("SELECT id FROM media_files WHERE path = ?")
            .bind("/lib/huge.mp4")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                req(
                    "GET",
                    format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_bitrate=10000000"
                    ),
                ),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// Off-mode in-memory state with a transcoder URL wired in, so the
    /// transcode-required path hands off instead of returning 503. Roots are
    /// empty (containment skipped) so a seeded path need not exist on disk for
    /// the handoff path (which never opens the file — only the transcoder does).
    async fn test_state_with_transcoder(url: &str) -> AppState {
        unsafe {
            std::env::remove_var("MEDIA_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("RECOMMENDER_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("INTERNAL_PRINCIPAL_SECRET");
        }
        let db = crate::db::Db::connect_memory().await.unwrap();
        let mut config = Config::from_env().unwrap();
        config.transcoder_url = Some(url.to_string());
        AppState {
            db,
            config: Arc::new(config),
            tmdb: crate::tmdb::TmdbClient::new(None),
            scanning: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            stream_semaphore: Arc::new(tokio::sync::Semaphore::new(
                crate::DEFAULT_STREAM_CONCURRENCY,
            )),
        }
    }

    /// Spawn a tiny one-route axum server standing in for the M4 transcoder's
    /// `POST /api/transcode/grant`. Returns `(base_url, JoinHandle)`. The mock
    /// echoes a successful grant so media-core's handoff translation can be
    /// asserted end-to-end without the real transcoder crate.
    async fn spawn_mock_transcoder(
        response: Value,
        status: StatusCode,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/api/transcode/grant",
            post(move || {
                let response = response.clone();
                async move { (status, Json(response)) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    async fn spawn_mock_transcoder_capture(
        response: Value,
        status: StatusCode,
        seen_body: Arc<tokio::sync::Mutex<Option<Value>>>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/api/transcode/grant",
            post(move |Json(body): Json<Value>| {
                let response = response.clone();
                let seen_body = seen_body.clone();
                async move {
                    *seen_body.lock().await = Some(body);
                    (status, Json(response))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn stream_direct_play_serves_bytes_when_caps_match() {
        // A file the advertised client CAN direct-play must stream the bytes,
        // never touch the transcoder, and not 503 — even with a transcoder
        // configured. Guards against the handoff hijacking the direct path.
        let (base, handle) = spawn_mock_transcoder(json!({}), StatusCode::OK).await;
        let state = test_state_with_transcoder(&base).await;

        // Write a real file so ServeFile can stream it; roots are empty so the
        // containment check is skipped and any on-disk path is allowed.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.mp4");
        std::fs::write(&path, b"fake-mp4-bytes").unwrap();
        let file_id = seed_media_file(&state, path.to_str().unwrap()).await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        // seed_media_file stores container=mp4, codec=h264, height=1080 → caps
        // that match exactly direct-play.
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                req(
                    "GET",
                    format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_height=1080"
                    ),
                ),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"fake-mp4-bytes");
        handle.abort();
    }

    #[tokio::test]
    async fn stream_hands_off_to_transcoder_when_configured() {
        // !direct_play + transcoder configured → media-core POSTs the grant and
        // returns the handoff JSON (manifestUrl) instead of 503.
        let grant = json!({
            "directPlay": false,
            "transcode": true,
            "sessionId": "sess-abc",
            "manifestUrl": "/api/transcode/session/sess-abc/index.m3u8",
            "heartbeatUrl": "/api/transcode/session/sess-abc/heartbeat",
            "subtitle": {
                "url": "/api/transcode/session/sess-abc/subtitles.vtt",
                "language": "eng",
                "forced": false,
            },
        });
        let (base, handle) = spawn_mock_transcoder(grant, StatusCode::OK).await;
        let state = test_state_with_transcoder(&base).await;
        let file_id = seed_media_file(&state, "/lib/needs-transcode.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["transcode"], true);
        assert_eq!(v["directPlay"], false);
        assert_eq!(v["sessionId"], "sess-abc");
        assert_eq!(
            v["manifestUrl"],
            "/api/transcode/session/sess-abc/index.m3u8"
        );
        // The sidecar-subtitle descriptor is forwarded verbatim for the Node
        // grant layer to stream-token-wrap and the player to load as a <track>.
        assert_eq!(
            v["subtitle"]["url"],
            "/api/transcode/session/sess-abc/subtitles.vtt"
        );
        assert_eq!(v["subtitle"]["language"], "eng");
        assert_eq!(v["subtitle"]["forced"], false);
        assert!(
            v["reason"].as_str().is_some(),
            "handoff must carry the decision reason"
        );
        handle.abort();
    }

    #[tokio::test]
    async fn stream_handoff_forwards_resume_start_secs_to_transcoder() {
        let grant = json!({
            "directPlay": false,
            "transcode": true,
            "sessionId": "sess-resume",
            "manifestUrl": "/api/transcode/session/sess-resume/index.m3u8",
            "heartbeatUrl": "/api/transcode/session/sess-resume/heartbeat",
        });
        let seen = Arc::new(tokio::sync::Mutex::new(None));
        let (base, handle) =
            spawn_mock_transcoder_capture(grant, StatusCode::OK, seen.clone()).await;
        let state = test_state_with_transcoder(&base).await;
        let file_id = seed_media_file(&state, "/lib/resume.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                req(
                    "GET",
                    format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1&start_secs=95"
                    ),
                ),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = seen.lock().await.clone().expect("transcoder grant body");
        assert_eq!(body["start_secs"], 95);
        handle.abort();
    }

    #[tokio::test]
    async fn stream_force_transcode_bypasses_direct_play() {
        // The stall-escalation contract: a file the caps WOULD direct-play
        // must, with ?force_transcode=true, hand off to the transcoder (which
        // resolves it to a lossless copy-remux) instead of serving bytes —
        // and the grant body must carry force_transcode so the transcoder
        // skips its own DirectPlay short-circuit.
        let grant = json!({
            "directPlay": false,
            "transcode": true,
            "sessionId": "sess-forced",
            "manifestUrl": "/api/transcode/session/sess-forced/index.m3u8",
            "heartbeatUrl": "/api/transcode/session/sess-forced/heartbeat",
        });
        let seen = Arc::new(tokio::sync::Mutex::new(None));
        let (base, handle) =
            spawn_mock_transcoder_capture(grant, StatusCode::OK, seen.clone()).await;
        let state = test_state_with_transcoder(&base).await;
        // seed_media_file stores container=mp4, codec=h264, height=1080 — the
        // caps below match exactly, so without the flag this direct-plays
        // (proven by stream_direct_play_serves_bytes_when_caps_match).
        let file_id = seed_media_file(&state, "/lib/direct-eligible.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                req(
                    "GET",
                    format!(
                        "/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=h264&max_height=1080&start_secs=42&force_transcode=true"
                    ),
                ),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["transcode"], true);
        assert_eq!(v["sessionId"], "sess-forced");
        assert_eq!(v["reason"], "client requested buffered delivery");
        let body = seen.lock().await.clone().expect("transcoder grant body");
        assert_eq!(body["force_transcode"], true);
        assert_eq!(body["start_secs"], 42);
        handle.abort();
    }

    #[tokio::test]
    async fn stream_503s_when_no_transcoder_configured() {
        // Regression guard: with MEDIA_TRANSCODER_URL unset, the transcode-
        // required path must keep the exact pre-M4 503 behavior.
        let state = test_state().await;
        assert!(
            state.config.transcoder_url.is_none(),
            "default test state must have no transcoder"
        );
        let file_id = seed_media_file(&state, "/lib/needs-transcode.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn stream_handoff_maps_transcoder_busy_to_503() {
        // A transcoder at capacity returns {error:"transcoder_busy"}; media-core
        // surfaces that as a 503 with the same error code so the client backs off.
        let (base, handle) = spawn_mock_transcoder(
            json!({ "error": "transcoder_busy", "cpuCap": true }),
            StatusCode::SERVICE_UNAVAILABLE,
        )
        .await;
        let state = test_state_with_transcoder(&base).await;
        let file_id = seed_media_file(&state, "/lib/needs-transcode.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let v = body_json(resp).await;
        assert_eq!(v["error"], "transcoder_busy");
        handle.abort();
    }

    #[tokio::test]
    async fn stream_handoff_degrades_to_503_when_transcoder_unreachable() {
        // A configured-but-dead transcoder must degrade to the offline 503 path,
        // not a 500 — an outage looks identical to the M3-only posture.
        // Point at a port with nothing listening.
        let state = test_state_with_transcoder("http://127.0.0.1:1").await;
        let file_id = seed_media_file(&state, "/lib/needs-transcode.mkv").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;

        let app = crate::build_router(state);
        let resp = app
            .oneshot(req(
                "GET",
                format!("/api/media/stream/movie/{movie_id}?containers=mp4&video_codecs=av1"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
