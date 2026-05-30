use transcoder::args::HwEncoder;
use transcoder::encoders;
use transcoder::{AppState, build_router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "transcoder=info,tower_http=info".into()),
        )
        .init();

    // Boot-time hardware-encoder detection (§4.4). Honor TRANSCODER_HW_ENCODER
    // only if the configured encoder is actually built into this ffmpeg;
    // otherwise fall back to libx264 and say so. This MUST run BEFORE we build
    // AppState so the session manager launches ffmpeg with the RESOLVED encoder
    // — otherwise a misconfigured HW family (e.g. nvenc on a binary without
    // h264_nvenc) would crash-loop every session into a 503.
    let ffmpeg_bin = std::env::var("TRANSCODER_FFMPEG_BIN").unwrap_or_else(|_| "ffmpeg".into());
    let available = encoders::detect(&ffmpeg_bin).await;
    let preferred = HwEncoder::from_env();
    let (resolved, fell_back) = available.resolve(preferred);
    if fell_back {
        tracing::warn!(
            ?preferred,
            "configured HW encoder unavailable; falling back to libx264 (CPU)"
        );
    }
    tracing::info!(?resolved, available = ?available, "transcoder encoder resolved");

    let state = AppState::from_env_with_encoder(resolved).map_err(|e| {
        tracing::error!("transcoder config error: {e}");
        e
    })?;

    // Idle-session sweeper (5s cadence; 30s no-heartbeat → reap).
    let _sweeper = state.sessions.spawn_sweeper();

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
