use std::time::Duration;

use gateway::config::{Config, auth_posture};
use gateway::{AppState, telemetry};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// A drain that outlives this is cut short so a deploy never wedges.
const SHUTDOWN_BACKSTOP: Duration = Duration::from_secs(15);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The sentry-tracing layer reports to whichever client is bound when an
    // event fires, so it can go in before the DSN is known.
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "eex_gateway=info,gateway=info,auth=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_tracing::layer())
        .init();

    let config =
        Config::from_env().inspect_err(|e| tracing::error!("gateway config error: {e}"))?;
    let _sentry_guard = telemetry::init(&config);
    if config.telemetry_dsn.is_none() && config.telemetry_dsn_internal.is_none() {
        tracing::warn!(
            "EEX_TELEMETRY_DSN is not set: telemetry is off. Set TELEMETRY_ENABLED=1 in \
             deployments that run the telemetry stack so a lost DSN fails loudly."
        );
    }

    let pool = auth::db::open(&config.auth.server_db_path).await?;
    let server_id = auth::ensure_server_id(&pool).await?;
    tracing::info!(server_id, "server_id resolved");
    tracing::info!(
        posture = %serde_json::to_string(&auth_posture(&config.auth))?,
        "authentication posture"
    );
    let sweep = auth::spawn_sweep(pool.clone(), &config.auth.token_sweep_cron);

    let port = config.port;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("backend listening on http://localhost:{port}");
    axum::serve(
        listener,
        gateway::router(AppState::new(pool.clone(), config)),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    sweep.abort();
    pool.close().await;
    Ok(())
}

/// SIGTERM (docker stop) or SIGINT starts the drain and arms the backstop.
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
    tokio::spawn(async {
        tokio::time::sleep(SHUTDOWN_BACKSTOP).await;
        tracing::error!("grace window exceeded; forcing exit");
        std::process::exit(1);
    });
}
