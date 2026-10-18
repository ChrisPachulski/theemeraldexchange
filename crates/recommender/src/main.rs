use recommender::{config::Config, db};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "recommender=info,eex_recommender=info,media_core=info".into()),
        )
        .init();
    let config =
        Config::from_env().inspect_err(|e| tracing::error!("recommender config error: {e}"))?;
    let _pool = db::open(&config.db_path).await?;
    tracing::info!(db = %config.db_path.display(), "exchange.db migrated");
    Ok(())
}
