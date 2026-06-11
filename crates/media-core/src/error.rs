use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found")]
    NotFound,
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("transcoder required")]
    TranscoderRequired,
    /// All direct-play stream slots are in use (§7-2 concurrency cap). Kept
    /// distinct from [`AppError::TranscoderRequired`] so clients/ops can tell
    /// "back off and retry, the server is at capacity" from "this file needs
    /// an offline transcoder" — both are 503, but conflating them made a
    /// busy server look like an M4 outage.
    #[error("stream_slots_exhausted")]
    StreamSlotsExhausted,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            AppError::Unauthorized(_) => (StatusCode::UNAUTHORIZED, self.to_string()),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            // M3-only deployments have no transcoder: a file that needs one
            // is 503 per §3.5, telling the client to back off (M4 offline).
            AppError::TranscoderRequired => (
                StatusCode::SERVICE_UNAVAILABLE,
                "transcoder required (M4 offline)".to_string(),
            ),
            // Distinct machine-readable code (verified unmatched by the Hono
            // proxy/SPA, which pass 503 bodies through opaquely) so capacity
            // exhaustion is distinguishable from a transcoder outage in logs
            // and client error handling.
            AppError::StreamSlotsExhausted => (
                StatusCode::SERVICE_UNAVAILABLE,
                "stream_slots_exhausted".to_string(),
            ),
            AppError::Db(e) => {
                tracing::error!("db error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
            AppError::Internal(m) => {
                tracing::error!("internal error: {m}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
