use std::sync::Arc;

use iptv::{api, backup, config::Config, db, dvr, feed_sweep, scheduler, sync::CatalogSync};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // §15 telemetry, as in the transcoder: the guard lives for all of main and
    // the sentry-tracing layer turns error! events into Glitchtip issues.
    let _sentry_guard = init_telemetry();
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "iptv=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_tracing::layer())
        .init();

    let config =
        Arc::new(Config::from_env().inspect_err(|e| tracing::error!("iptv config error: {e}"))?);
    let pool = db::open(&config.iptv_db_path).await?;
    let state = api::AppState::new(pool.clone(), config.clone());
    // Idle feed checks: every minute, only in the overnight window and only
    // when nobody has watched for 30 minutes (IPTV_FEED_CHECK=0 turns it off).
    let _sweep = feed_sweep::enabled(&config)
        .then(|| feed_sweep::spawn(pool.clone(), state.streams.clone(), config.clone()));
    // DVR: a tick now, then every 20 s (DVR_ENABLED; state.dvr is None otherwise).
    let dvr_job = state
        .dvr
        .clone()
        .map(|r| dvr::spawn_scheduler(pool.clone(), r, dvr::TICK_EVERY));
    let _backup = backup::spawn(pool.clone(), config.clone());
    let sync = CatalogSync::new(pool, config.clone());

    let _jobs = if config.sync_enabled() {
        scheduler::spawn(sync, &config.iptv_sync_cron)
    } else {
        tracing::info!("iptv catalog sync off (IPTV_DISABLED or Xtream creds unset)");
        Vec::new()
    };

    let ip: std::net::IpAddr = config
        .host
        .parse()
        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]));
    let addr = std::net::SocketAddr::new(ip, config.port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("iptv listening on http://{addr}");
    let streams = state.streams.clone();
    let recorder = state.dvr.clone();
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    // Stop every remux ffmpeg and wait (bounded) for them to exit.
    streams
        .live
        .remux
        .drain(std::time::Duration::from_secs(5))
        .await;
    // Stop scheduling, then SIGTERM every recording and wait (bounded). An open
    // window stays 'recording' and resumes on the next boot.
    if let Some(job) = dvr_job {
        job.abort();
    }
    if let Some(r) = recorder {
        r.stop_all(std::time::Duration::from_secs(6)).await;
    }
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
