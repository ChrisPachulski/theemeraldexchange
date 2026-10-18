use std::sync::Arc;

use recommender::{config::Config, db, http};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// The compose service publishes this port; the address never changes.
const LISTEN: ([u8; 4], u16) = ([0, 0, 0, 0], 8000);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // §15 telemetry, as in iptv: the guard lives for all of main and the
    // sentry-tracing layer turns error! events into Glitchtip issues.
    let _sentry_guard = init_telemetry();
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "recommender=info,eex_recommender=info,media_core=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_tracing::layer())
        .init();

    let config = Arc::new(
        Config::from_env().inspect_err(|e| tracing::error!("recommender config error: {e}"))?,
    );
    tracing::info!("recommender starting; db={}", config.db_path.display());
    let pool = db::open(&config.db_path).await?;
    let caches = Arc::new(recommender::recipes::Caches::default());
    let _sweeper =
        http::events::spawn_retention_sweeper(pool.clone(), config.clone(), caches.clone());

    let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(LISTEN)).await?;
    tracing::info!("recommender listening on http://{}", listener.local_addr()?);
    axum::serve(
        listener,
        http::router(http::AppState {
            pool,
            config,
            caches,
        }),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// Glitchtip from `GLITCHTIP_DSN`; unset or empty is a no-op. No PII is sent.
fn init_telemetry() -> Option<sentry::ClientInitGuard> {
    let dsn = std::env::var("GLITCHTIP_DSN")
        .ok()
        .filter(|d| !d.trim().is_empty())?;
    let mut options = sentry::ClientOptions::default();
    options.release = Some(env!("CARGO_PKG_VERSION").into());
    options.send_default_pii = false;
    Some(sentry::init((dsn, options)))
}

/// Docker stops with SIGTERM, so wait for that as well as SIGINT.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => tokio::select! {
                _ = ctrl_c => {},
                _ = term.recv() => {},
            },
            Err(_) => ctrl_c.await,
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await;
    tracing::info!("shutdown signal received");
}
