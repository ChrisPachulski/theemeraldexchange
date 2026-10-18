//! POST /score: load the sub's context, pick the model_config (cold start for
//! a thin household), run the recipe and return its top n with a diag block.

use std::time::Instant;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};

use super::{ApiError, AppState, authoritative_sub, gate, validate};
use crate::context::{load_user_context, select_model_config_for_context};
use crate::recipes;

pub async fn score(
    State(st): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let (body, principal) = gate(&st, &headers, &bytes)?;
    let mut req = validate::score(&body).map_err(ApiError::Invalid)?;
    let t0 = Instant::now();
    // Per-user reads are as spoofable as writes: bind the verified principal.
    req.sub = authoritative_sub(&st.config, principal.as_ref(), &req.sub)?;
    let ctx = load_user_context(&st.pool, &req, true).await?;
    let (model_version, recipe, params) =
        select_model_config_for_context(&st.pool, &st.config, &ctx, None).await?;
    let n = req.n as usize;
    let Some(mut result) = recipes::score(&recipe, &st.pool, &ctx, n, &params).await? else {
        // Python str(KeyError(...)) keeps the quotes.
        return Err(ApiError::Detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("'unknown recipe: {recipe}'"),
        ));
    };
    result.items.truncate(n);

    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let mut diag = Map::new();
    diag.insert(
        "elapsed_ms".into(),
        json!((elapsed_ms * 10.0).round() / 10.0),
    );
    diag.insert("user".into(), ctx.diag.clone());
    diag.extend(result.diag);
    Ok(Json(json!({
        "items": result.items,
        "model_version": model_version,
        "recipe": recipe,
        "diag": diag,
    })))
}
