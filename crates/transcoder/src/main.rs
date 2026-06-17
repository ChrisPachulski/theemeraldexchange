use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use transcoder::args::HwEncoder;
use transcoder::encoders;
use transcoder::{AppState, build_router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // §15 telemetry: initialize Glitchtip BEFORE the tracing subscriber so the
    // sentry-tracing layer has a live client to forward to. The guard must live
    // for the whole of main (dropping it flushes + disables reporting), so we
    // bind it here. When no DSN is configured this is a complete no-op.
    let _sentry_guard = init_telemetry();

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "transcoder=info,tower_http=info".into());
    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        // Bridge tracing into Glitchtip: error!/warn! events (including the
        // drained ffmpeg stderr in session.rs) become issues. Inert with no DSN.
        .with(sentry_tracing::layer())
        .init();

    // Boot-time hardware-encoder detection (§4.4). Honor TRANSCODER_HW_ENCODER
    // only if the configured encoder is actually built into this ffmpeg;
    // otherwise fall back to libx264 and say so. This MUST run BEFORE we build
    // AppState so the session manager launches ffmpeg with the RESOLVED encoder
    // — otherwise a misconfigured HW family (e.g. nvenc on a binary without
    // h264_nvenc) would crash-loop every session into a 503.
    let ffmpeg_bin = std::env::var("TRANSCODER_FFMPEG_BIN").unwrap_or_else(|_| "ffmpeg".into());
    // detect() only proves an encoder is COMPILED INTO ffmpeg (present in
    // `-encoders`); it does not prove the GPU/driver actually works on this host.
    // validate() smoke-tests each detected HW encoder once, so a GPU-less box
    // where ffmpeg still lists h264_nvenc/h264_vaapi cleanly falls back to CPU
    // at boot instead of crash-looping every session on the first device-open
    // (§audit 1-13).
    let available = encoders::detect(&ffmpeg_bin)
        .await
        .validate(&ffmpeg_bin)
        .await;
    let preferred = HwEncoder::from_env();
    let (resolved, fell_back) = available.resolve(preferred);
    if fell_back {
        tracing::warn!(
            ?preferred,
            "configured HW encoder unavailable; falling back to libx264 (CPU)"
        );
    }
    // Verify the fallback actually exists: resolve() demotes to Cpu blindly,
    // but an ffmpeg built without libx264 has NO working software encoder —
    // every video re-encode would crash-loop to the restart cap and 503.
    // Fail loudly at boot (error log → Glitchtip) rather than at first
    // playback. We deliberately do NOT abort: copy-remux sessions (the common
    // local-library case) use no encoder and still work.
    if resolved == HwEncoder::Cpu && available.cpu_fallback_missing() {
        tracing::error!(
            ffmpeg_bin,
            "ffmpeg has NO usable H.264 encoder: libx264 is missing and no HW encoder \
             survived detection — every video re-encode will fail (remux-only service); \
             fix the ffmpeg build/image"
        );
    }
    tracing::info!(?resolved, available = ?available, "transcoder encoder resolved");

    let mut state = AppState::from_env_with_encoder(resolved).map_err(|e| {
        tracing::error!("transcoder config error: {e}");
        e
    })?;

    // Full-hardware VAAPI pipeline (GPU decode + tonemap_vaapi/scale_vaapi +
    // h264_vaapi, no CPU<->GPU round-trip). Only meaningful when the resolved
    // encoder is VAAPI; probe the VPP+encode chain at boot so a GPU without
    // working VAAPI post-processing cleanly keeps the proven software-decode path
    // instead of crash-looping. TRANSCODER_VAAPI_HWDECODE=0 forces it off (escape
    // hatch for a flaky driver), mirroring TRANSCODER_FORCE_CPU.
    if resolved == HwEncoder::Vaapi {
        if vaapi_hwdecode_enabled() {
            let full_hw = encoders::vaapi_full_hw_supported(&ffmpeg_bin).await;
            state.sessions.set_vaapi_hw_decode(full_hw);
            tracing::info!(
                vaapi_full_hw = full_hw,
                "VAAPI full-hardware decode/tone-map pipeline"
            );
        } else {
            tracing::info!("VAAPI full-hardware decode disabled via TRANSCODER_VAAPI_HWDECODE");
        }
    }

    // Durable scratch (not RAM tmpfs anymore): clear any session dirs orphaned
    // by a prior crash/restart before serving, so disk stays bounded by ACTIVE
    // sessions and a finished VOD title's segments never linger across restarts.
    state.sessions.sweep_scratch_on_boot().await;

    // Idle-session sweeper (5s cadence; 30s no-heartbeat → reap).
    let _sweeper = state.sessions.spawn_sweeper();

    // Keyframe warmer: pre-builds the per-file keyframe cache so copy-remux
    // movies play as finite VOD (a real scrubber) instead of "live", even on a
    // first play. Gentle (one file at a time, only while idle); disable with
    // TRANSCODER_KEYFRAME_WARM=0 if it ever needs to be parked.
    let _warmer = if std::env::var("TRANSCODER_KEYFRAME_WARM").as_deref() != Ok("0") {
        Some(state.sessions.spawn_keyframe_warmer())
    } else {
        tracing::info!("keyframe warmer disabled via TRANSCODER_KEYFRAME_WARM=0");
        None
    };

    let host = std::env::var("TRANSCODER_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("TRANSCODER_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8090);

    let app = build_router(state);
    let ip: std::net::IpAddr = host
        .parse()
        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]));
    let addr = std::net::SocketAddr::new(ip, port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("transcoder listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Operator escape hatch for the full-hardware VAAPI decode path. Defaults ON;
/// set `TRANSCODER_VAAPI_HWDECODE` to a falsey value (`0`/`false`/`no`/`off`,
/// case-insensitive) to pin the proven software-decode path regardless of the
/// boot capability probe (mirrors `TRANSCODER_FORCE_CPU` for the encoder).
fn vaapi_hwdecode_enabled() -> bool {
    match std::env::var("TRANSCODER_VAAPI_HWDECODE") {
        Ok(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

/// Initialize the Glitchtip/Sentry SDK from the `GLITCHTIP_DSN` env var (§15;
/// the DSN is distributed server->app at boot). When the var is unset or empty
/// this returns `None` and the SDK stays fully inert, so an off/unconfigured
/// deploy is a clean no-op rather than a hard failure (mirrors media-core's
/// off-mode-validates-cleanly posture). The returned guard must be held for the
/// lifetime of `main`. Crash data is per-self-hoster (island); no PII is sent.
fn init_telemetry() -> Option<sentry::ClientInitGuard> {
    let dsn = match std::env::var("GLITCHTIP_DSN") {
        Ok(d) if !d.trim().is_empty() => d,
        _ => return None,
    };
    Some(sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(env!("CARGO_PKG_VERSION").into()),
            send_default_pii: false,
            ..Default::default()
        },
    )))
}

/// Await the first OS shutdown signal so axum can drain in-flight requests and
/// the session manager's `Drop`/sweeper escalation can SIGTERM→grace→SIGKILL
/// every live ffmpeg child cleanly.
///
/// Docker `stop`/compose `down` deliver **SIGTERM** to PID 1 — not SIGINT — so
/// trapping only `ctrl_c()` (SIGINT) means the graceful path never fires in
/// prod: after the ~10s stop grace Docker sends SIGKILL and hard-aborts every
/// in-flight transcode on each redeploy. We therefore select over BOTH signals.
/// (compose `stop_grace_period` must exceed `KILL_GRACE_MS` so the child-level
/// flush has time to complete.)
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        // If we can't install the SIGTERM handler, degrade to SIGINT-only
        // rather than aborting boot.
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("could not install SIGTERM handler: {e}; SIGINT only");
                ctrl_c.await;
                tracing::info!(signal = "SIGINT", "shutdown signal received");
                return;
            }
        };
        tokio::select! {
            _ = ctrl_c => tracing::info!(signal = "SIGINT", "shutdown signal received"),
            _ = sigterm.recv() => tracing::info!(signal = "SIGTERM", "shutdown signal received"),
        }
    }

    #[cfg(not(unix))]
    {
        ctrl_c.await;
        tracing::info!(signal = "SIGINT", "shutdown signal received");
    }
}
