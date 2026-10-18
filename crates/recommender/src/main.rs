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
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(sentry_tracing::layer())
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(cmd) = args.first() {
        return cli(cmd, &args[1..]).await;
    }

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

/// The job subcommands; the server runs when none is given.
async fn cli(cmd: &str, args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match (cmd, args) {
        ("featurize", rest) => {
            let limit = match rest {
                [] => None,
                [flag, n] if flag == "--limit" => Some(n.parse::<i64>()?),
                _ => return Err("usage: eex-recommender featurize [--limit N]".into()),
            };
            let config = Config::from_env()?;
            let pool = db::open(&config.db_path).await?;
            let embedder = Arc::new(recommender::embed::Embedder::load(&config.model_dir)?);
            recommender::featurize::run(&pool, embedder, limit).await?;
            pool.close().await;
            Ok(())
        }
        ("ingest", rest) => {
            let opts = recommender::ingest::Opts::parse(rest).map_err(|e| {
                format!(
                    "{e}; usage: eex-recommender ingest --mode bootstrap|changes|retry-errors \
                     [--concurrency N] [--limit N] [--skip-enumerate] [--retry-errors] \
                     [--max-attempts N]"
                )
            })?;
            let config = Config::from_env()?;
            let client = Arc::new(recommender::tmdb::TmdbClient::from_config(&config)?);
            let pool = db::open(&config.db_path).await?;
            let today = chrono::Local::now().date_naive();
            let res = recommender::ingest::run(&pool, client, &opts, today).await;
            pool.close().await;
            Ok(res?)
        }
        ("verify-embedding", [baseline]) => {
            // Reads only RECOMMENDER_MODEL_DIR: the image check runs without secrets.
            let model_dir = recommender::config::model_dir(|k| std::env::var(k).ok());
            let report =
                recommender::embed::verify_baseline(&model_dir, std::path::Path::new(baseline))
                    .await?;
            println!("{report}");
            Ok(())
        }
        _ => Err(format!(
            "unknown command {cmd:?}; usage: eex-recommender [featurize [--limit N] | \
             ingest --mode M ... | verify-embedding <baseline.json>]"
        )
        .into()),
    }
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
