//! The Emerald Exchange recommender: owns exchange.db and serves `/score` and
//! `/events/*` to the gateway. Port of the Python `recommender/` service.

pub mod config;
pub mod context;
pub mod db;
pub mod embed;
pub mod featurize;
pub mod holdout;
pub mod http;
pub mod metrics;
pub mod reasons;
pub mod recipes;
pub mod retrieval;
pub mod rng;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    /// A bad argument (the Python raised ValueError).
    #[error("{0}")]
    Invalid(String),
    /// Loading or running the MiniLM encoder.
    #[error("embedding: {0}")]
    Embed(String),
}

pub type Result<T> = std::result::Result<T, Error>;
