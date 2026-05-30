use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use media_core::{
    AppState, build_router, config::Config, db::Db, spawn_scheduler, tmdb::TmdbClient,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "media_core=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env().map_err(|e| {
        tracing::error!("media-core config error: {e}");
        e
    })?;
    tracing::info!(
        port = config.port,
        db = %config.db_path,
        roots = ?config.library_roots,
        mode = ?config.principal_mode,
        "media-core starting"
    );

    let db = Db::connect(&config.db_path).await?;
    let port = config.port;
    let tmdb = TmdbClient::new(config.tmdb_api_key.clone());
    let state = AppState {
        db,
        config: Arc::new(config),
        tmdb,
        scanning: Arc::new(AtomicBool::new(false)),
    };

    let host = state.config.host.clone();

    // Boot + periodic library scanner. Reuses the shared `scanning` guard so a
    // scheduled scan never overlaps a manual `POST /api/media/scan`. Without
    // this a freshly deployed instance stays empty until externally poked.
    let _scheduler = spawn_scheduler(state.clone());

    let app = build_router(state);
    let ip: std::net::IpAddr = host
        .parse()
        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]));
    let addr = std::net::SocketAddr::new(ip, port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("media-core listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Wait for a shutdown signal so axum's graceful shutdown can drain in-flight
/// requests before the process exits.
///
/// Docker `stop`/compose `down` deliver **SIGTERM** to PID 1 — not SIGINT — so
/// trapping only `ctrl_c()` (SIGINT) means the graceful path never fires in
/// prod: after the stop grace Docker sends SIGKILL and hard-aborts in-flight
/// requests on each redeploy. We therefore select over BOTH signals (matching
/// the transcoder's handler).
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
