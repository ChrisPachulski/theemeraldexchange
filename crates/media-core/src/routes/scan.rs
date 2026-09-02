//! Scan trigger.

use super::*;

/// Upsert one `scan_state` (key, value, ts) row. Best-effort: logs on failure
/// so the background task never panics on a transient DB error.
pub(super) async fn set_scan_state(db: &crate::db::Db, key: &str, value: &str) {
    let ts = chrono::Utc::now().to_rfc3339();
    if let Err(e) = sqlx::query(
        "INSERT INTO scan_state (key, value, ts) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
    )
    .bind(key)
    .bind(value)
    .bind(&ts)
    .execute(&db.pool)
    .await
    {
        tracing::warn!("failed to persist scan_state {key}: {e}");
    }
}

pub(super) async fn get_scan_state(db: &crate::db::Db, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM scan_state WHERE key = ?")
        .bind(key)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten()
}

/// Authorize a scan trigger. A full library rescan is an expensive, DoS-prone
/// operation, so outside `Off` mode (local/dev, no auth boundary) it is gated to
/// admins: the caller must present a verified internal principal whose
/// `role == "admin"`. This mirrors the Hono proxy's `requireAdmin` gate over
/// `/scan` (403 `admin role required`). In `Off` mode there is no principal and
/// no boundary, so the gate is skipped. Returns the rejection response on deny.
pub(super) fn authorize_scan(
    claims: &Option<InternalClaims>,
    mode: &PrincipalMode,
) -> Result<(), (StatusCode, Json<Value>)> {
    if *mode == PrincipalMode::Off {
        return Ok(());
    }
    let is_admin = claims.as_ref().map(|c| c.role == "admin").unwrap_or(false);
    if is_admin {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "admin role required" })),
        ))
    }
}

/// Kick off a background scan and return `202` immediately. A second request
/// while a scan is in flight returns `409`. Progress + the final report land
/// in the `scan_state` table, readable via `GET /scan/status`.
///
/// Authorization: outside `Off` mode the caller must be a verified admin
/// principal (see [`authorize_scan`]); a non-admin gets `403`.
pub(super) async fn trigger_scan(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
) -> AppResult<impl IntoResponse> {
    use std::sync::atomic::Ordering;

    let claims = claims.map(|Extension(c)| c);
    if let Err(rejection) = authorize_scan(&claims, &state.config.principal_mode) {
        return Ok(rejection);
    }

    // Atomically claim the scan slot; bail with 409 if already running.
    if state
        .scanning
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok((
            StatusCode::CONFLICT,
            Json(
                json!({ "status": "running", "job_id": get_scan_state(&state.db, "job_id").await }),
            ),
        ));
    }

    let job_id = chrono::Utc::now().timestamp_millis().to_string();
    let started_at = chrono::Utc::now().to_rfc3339();

    // CANCELLATION SAFETY: spawn the background task IMMEDIATELY after the
    // compare_exchange claim, with no intervening await. The bookkeeping
    // writes below run inside the spawned task: if they ran here and the
    // handler future was dropped mid-await (client disconnect, TimeoutLayer),
    // the spawn would never happen and `scanning` would stay true, 409-ing
    // every future POST /scan forever.
    let bg = state.clone();
    let bg_job_id = job_id.clone();
    tokio::spawn(async move {
        set_scan_state(&bg.db, "state", "running").await;
        set_scan_state(&bg.db, "job_id", &bg_job_id).await;
        set_scan_state(&bg.db, "started_at", &started_at).await;
        set_scan_state(&bg.db, "finished_at", "").await;

        // scan_once_isolated contains a panic in the scan pass as an Err, so
        // the state/flag resets below always run — otherwise one bad file
        // would leave `scanning` true and 409 every future POST /scan.
        let result = scanner::scan_once_isolated(
            bg.db.clone(),
            bg.config.library_roots.clone(),
            bg.tmdb.clone(),
        )
        .await;
        match result {
            Ok(report) => {
                let json = serde_json::to_string(&report).unwrap_or_else(|_| "{}".into());
                set_scan_state(&bg.db, "last_report", &json).await;
            }
            Err(e) => {
                tracing::warn!("background scan failed: {e}");
                set_scan_state(
                    &bg.db,
                    "last_report",
                    &json!({ "error": e.to_string() }).to_string(),
                )
                .await;
            }
        }

        // Music library scan in the same background task (a no-op when
        // MUSIC_LIBRARY_PATHS is unset). Its summary lands in `last_music_report`
        // for observability; the video report above still drives /scan/status.
        match scanner::scan_music_isolated(
            bg.db.clone(),
            bg.config.music_roots.clone(),
            bg.config.artwork_dir.clone(),
        )
        .await
        {
            Ok(report) => {
                let json = serde_json::to_string(&report).unwrap_or_else(|_| "{}".into());
                set_scan_state(&bg.db, "last_music_report", &json).await;
            }
            Err(e) => {
                tracing::warn!("background music scan failed: {e}");
                set_scan_state(
                    &bg.db,
                    "last_music_report",
                    &json!({ "error": e.to_string() }).to_string(),
                )
                .await;
            }
        }

        set_scan_state(&bg.db, "finished_at", &chrono::Utc::now().to_rfc3339()).await;
        set_scan_state(&bg.db, "state", "idle").await;
        bg.scanning.store(false, Ordering::SeqCst);
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "status": "started", "job_id": job_id })),
    ))
}

/// Report the current/last scan status from the `scan_state` table.
pub(super) async fn scan_status(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let st = get_scan_state(&state.db, "state").await.unwrap_or_default();
    let state_str = if st.is_empty() {
        "idle".to_string()
    } else {
        st
    };
    let last_report = get_scan_state(&state.db, "last_report")
        .await
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let started_at = get_scan_state(&state.db, "started_at").await;
    let finished_at = get_scan_state(&state.db, "finished_at")
        .await
        .filter(|s| !s.is_empty());
    Ok(Json(json!({
        "state": state_str,
        "last_report": last_report,
        "started_at": started_at,
        "finished_at": finished_at,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use axum::body::Body;
    use axum::http::Request as HttpRequest;

    use tower::ServiceExt;

    #[tokio::test]
    async fn trigger_scan_returns_202_with_job_id_then_idle() {
        let state = test_state().await;
        let app = crate::build_router(state.clone());
        let resp = app
            .clone()
            .oneshot(req("POST", "/api/media/scan"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let v = body_json(resp).await;
        assert_eq!(v["status"], "started");
        assert!(v["job_id"].as_str().is_some());

        // With empty library_roots the background scan completes ~instantly;
        // poll scan/status until it reports idle (bounded).
        let mut idle = false;
        for _ in 0..50 {
            let st = app
                .clone()
                .oneshot(req("GET", "/api/media/scan/status"))
                .await
                .unwrap();
            let sv = body_json(st).await;
            if sv["state"] == "idle" {
                idle = true;
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(idle, "scan/status never returned idle");
    }

    #[tokio::test]
    async fn trigger_scan_dropped_mid_flight_never_wedges_the_flag() {
        // REGRESSION: trigger_scan used to claim the `scanning` flag and then
        // await four scan_state writes BEFORE tokio::spawn. A handler future
        // dropped in that window (client disconnect, TimeoutLayer) left the
        // flag true forever, 409-ing every future POST /scan. The fix spawns
        // immediately after the claim with no intervening await — so a single
        // poll must complete the handler (claim + spawn + 202), and dropping
        // the future right after must still let the background task reset the
        // flag.
        use std::future::Future;

        let state = test_state().await;
        {
            let fut = trigger_scan(State(state.clone()), None);
            let mut fut = std::pin::pin!(fut);
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            // One poll, then drop — simulating cancellation at the first await
            // point. With no await between claim and spawn this poll already
            // returns Ready(202).
            let polled = fut.as_mut().poll(&mut cx);
            assert!(
                polled.is_ready(),
                "trigger_scan must reach tokio::spawn without an await point \
                 between the scanning-flag claim and the spawn"
            );
        }

        // The spawned task owns the flag reset; with empty roots it finishes
        // almost immediately.
        let mut cleared = false;
        for _ in 0..200 {
            if !state.scanning.load(std::sync::atomic::Ordering::SeqCst) {
                cleared = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(cleared, "scanning flag wedged after handler drop");

        // And a follow-up scan can start: 202, not 409.
        let app = crate::build_router(state);
        let resp = app.oneshot(req("POST", "/api/media/scan")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
    }

    #[test]
    fn authorize_scan_admin_gate() {
        use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims};

        let now = 1_748_000_000;
        let mk = |role: &str| {
            Some(InternalClaims {
                iss: "eex".into(),
                sub: "plex:caller".into(),
                role: role.into(),
                auth_mode: "plex".into(),
                server_id: "srv".into(),
                device_id: None,
                req_id: "r1".into(),
                iat: now,
                exp: now + DEFAULT_TTL_SECS,
            })
        };

        // Off mode: no boundary, gate is skipped regardless of role/claims.
        assert!(authorize_scan(&None, &PrincipalMode::Off).is_ok());
        assert!(authorize_scan(&mk("user"), &PrincipalMode::Off).is_ok());

        // Enforce/Log: admin allowed.
        assert!(authorize_scan(&mk("admin"), &PrincipalMode::Enforce).is_ok());
        assert!(authorize_scan(&mk("admin"), &PrincipalMode::Log).is_ok());

        // Enforce/Log: non-admin and missing principal are rejected with 403.
        for (claims, mode) in [
            (mk("user"), PrincipalMode::Enforce),
            (mk("user"), PrincipalMode::Log),
            (None, PrincipalMode::Enforce),
            (None, PrincipalMode::Log),
        ] {
            let err = authorize_scan(&claims, &mode).expect_err("should reject");
            assert_eq!(err.0, StatusCode::FORBIDDEN);
            assert_eq!(err.1.0["error"], "admin role required");
        }
    }

    #[tokio::test]
    async fn scan_rejects_non_admin_with_403() {
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .header(
                        "authorization",
                        format!("Bearer {}", signed_principal(secret, "user")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let v = body_json(resp).await;
        assert_eq!(v["error"], "admin role required");
    }

    #[tokio::test]
    async fn scan_rejects_missing_principal_with_403() {
        // Enforce mode requires a principal; a missing one is rejected by the
        // principal_layer (401) before reaching the admin gate. Either way an
        // unauthenticated caller cannot trigger a rescan.
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app.oneshot(req("POST", "/api/media/scan")).await.unwrap();
        assert!(
            resp.status() == StatusCode::FORBIDDEN || resp.status() == StatusCode::UNAUTHORIZED,
            "missing principal must not be allowed to scan; got {}",
            resp.status()
        );
    }

    #[tokio::test]
    async fn scan_allows_admin_with_202() {
        let secret = "test-scan-secret";
        let state = test_state_enforce(secret).await;
        let app = crate::build_router(state);
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/media/scan")
                    .header(
                        "authorization",
                        format!("Bearer {}", signed_principal(secret, "admin")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let v = body_json(resp).await;
        assert_eq!(v["status"], "started");
        assert!(v["job_id"].as_str().is_some());
    }
}
