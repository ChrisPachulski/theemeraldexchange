//!/ Liveness + readiness. `ok` is true only when the DB answers AND its applied
//!/ schema matches the version this binary was built for. A structurally broken
//!/ or un-/under-migrated DB where `SELECT 1` still succeeds must NOT report
//!/ healthy (the prior code returned raw `db_ok`, a half-truth — §7-5). The HTTP
//!/ status mirrors `ok`: 200 when healthy, 503 otherwise, so a compose/orchestrator
//!/ healthcheck can act on it. `expected_schema` is echoed for diagnosis.

use super::*;

pub(super) async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db.pool)
        .await
        .is_ok();
    let schema = state.db.schema_version().await.unwrap_or(-1);
    let healthy = db_ok && schema == SCHEMA_VERSION;
    let status = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "ok": healthy,
            "service": "media-core",
            "schema": schema,
            "expected_schema": SCHEMA_VERSION,
        })),
    )
}

pub(super) async fn version(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "service": "media-core",
        "schema": SCHEMA_VERSION,
        "server_id": state.config.server_id,
        "library_roots": state.config.library_roots.len(),
    }))
}
