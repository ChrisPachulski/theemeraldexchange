use std::sync::Arc;

use media_core::{AppState, build_router, config::Config, db::Db};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "media_core=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env();
    tracing::info!(
        port = config.port,
        db = %config.db_path,
        roots = ?config.library_paths,
        mode = ?config.principal_mode,
        "media-core starting"
    );

    let db = Db::connect(&config.db_path).await?;
    let port = config.port;
    let state = AppState {
        db,
        config: Arc::new(config),
    };

    let host = state.config.host.clone();
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

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}
