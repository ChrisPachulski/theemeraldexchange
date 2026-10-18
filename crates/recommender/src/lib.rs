//! The Emerald Exchange recommender: owns exchange.db and serves `/score` and
//! `/events/*` to the gateway. Port of the Python `recommender/` service.

pub mod config;
pub mod db;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    /// A bad argument (the Python raised ValueError).
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;
