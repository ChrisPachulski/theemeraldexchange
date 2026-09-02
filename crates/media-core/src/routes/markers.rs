//! Markers (intro / credits — M6 "Skip Intro").

use super::catalog::media_exists;
use super::*;

#[derive(Debug, Deserialize)]
pub struct MarkerQuery {
    pub media_kind: String,
    pub media_id: i64,
    /// Required for DELETE (which marker to remove); ignored by GET (returns all).
    pub marker_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MarkerUpsert {
    pub media_kind: String,
    pub media_id: i64,
    pub marker_type: String,
    pub start_secs: i64,
    pub end_secs: i64,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(sqlx::FromRow)]
pub(super) struct MarkerRow {
    marker_type: String,
    start_secs: i64,
    end_secs: i64,
    source: String,
    updated_at: String,
}

/// Pure validation of a marker upsert. Returns an error message, or `None`.
pub(super) fn validate_marker(m: &MarkerUpsert) -> Option<&'static str> {
    if m.marker_type != "intro" && m.marker_type != "credits" {
        return Some("marker_type must be 'intro' or 'credits'");
    }
    if m.start_secs < 0 || m.end_secs <= m.start_secs {
        return Some("require 0 <= start_secs < end_secs");
    }
    if let Some(s) = &m.source
        && !matches!(s.as_str(), "manual" | "imported" | "detected")
    {
        return Some("source must be 'manual', 'imported', or 'detected'");
    }
    None
}

/// GET markers for one title. Readable by any member — the client needs them to
/// render Skip Intro / Skip Credits. Markers are title-scoped, not per-user.
pub(super) async fn get_markers(
    State(state): State<AppState>,
    Query(q): Query<MarkerQuery>,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, MarkerRow>(
        "SELECT marker_type, start_secs, end_secs, source, updated_at \
         FROM media_markers WHERE media_kind = ? AND media_id = ? ORDER BY marker_type",
    )
    .bind(&q.media_kind)
    .bind(q.media_id)
    .fetch_all(&state.db.pool)
    .await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "marker_type": r.marker_type,
                "start_secs": r.start_secs,
                "end_secs": r.end_secs,
                "source": r.source,
                "updated_at": r.updated_at,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// PUT (upsert) an intro/credits marker. Admin-only; the title must exist.
pub(super) async fn put_marker(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Json(body): Json<MarkerUpsert>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    require_admin(&claims, &state.config.principal_mode)?;

    if let Some(msg) = validate_marker(&body) {
        return Err(AppError::BadRequest(msg.into()));
    }
    match media_exists(&state, &body.media_kind, body.media_id).await? {
        None => return Err(AppError::BadRequest("unknown media_kind".into())),
        Some(false) => return Err(AppError::NotFound),
        Some(true) => {}
    }

    let source = body.source.as_deref().unwrap_or("manual");
    let updated_at = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO media_markers \
         (media_kind, media_id, marker_type, start_secs, end_secs, source, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(media_kind, media_id, marker_type) DO UPDATE SET \
         start_secs = excluded.start_secs, end_secs = excluded.end_secs, \
         source = excluded.source, updated_at = excluded.updated_at",
    )
    .bind(&body.media_kind)
    .bind(body.media_id)
    .bind(&body.marker_type)
    .bind(body.start_secs)
    .bind(body.end_secs)
    .bind(source)
    .bind(&updated_at)
    .execute(&state.db.pool)
    .await?;

    Ok(Json(json!({ "ok": true, "updated_at": updated_at })))
}

/// DELETE one marker (by media_kind+media_id+marker_type). Admin-only.
pub(super) async fn delete_marker(
    State(state): State<AppState>,
    claims: Option<Extension<InternalClaims>>,
    Query(q): Query<MarkerQuery>,
) -> AppResult<Json<Value>> {
    let claims = claims.map(|Extension(c)| c);
    require_admin(&claims, &state.config.principal_mode)?;

    let marker_type = q
        .marker_type
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("marker_type required".into()))?;

    let res = sqlx::query(
        "DELETE FROM media_markers WHERE media_kind = ? AND media_id = ? AND marker_type = ?",
    )
    .bind(&q.media_kind)
    .bind(q.media_id)
    .bind(&marker_type)
    .execute(&state.db.pool)
    .await?;

    Ok(Json(json!({ "ok": true, "deleted": res.rows_affected() })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::testsupport::*;

    use tower::ServiceExt;

    #[test]
    fn validate_marker_rules() {
        let mk = |mt: &str, start: i64, end: i64, source: Option<&str>| MarkerUpsert {
            media_kind: "movie".into(),
            media_id: 1,
            marker_type: mt.into(),
            start_secs: start,
            end_secs: end,
            source: source.map(|s| s.to_string()),
        };
        assert!(validate_marker(&mk("intro", 0, 90, None)).is_none());
        assert!(validate_marker(&mk("credits", 3000, 3300, Some("detected"))).is_none());
        assert!(validate_marker(&mk("bogus", 0, 90, None)).is_some());
        assert!(validate_marker(&mk("intro", 90, 90, None)).is_some()); // end <= start
        assert!(validate_marker(&mk("intro", -1, 90, None)).is_some()); // start < 0
        assert!(validate_marker(&mk("intro", 0, 90, Some("weird"))).is_some());
    }

    #[tokio::test]
    async fn markers_round_trip() {
        // §M6: title-scoped intro/credits markers. test_state is Off mode, so the
        // admin gate allows and we exercise the upsert/get/delete path end-to-end.
        let state = test_state().await;
        let file_id = seed_media_file(&state, "/lib/marker.mp4").await;
        let movie_id = seed_movie_for_file(&state, file_id).await;
        let app = crate::build_router(state);

        let put = |kind: &str, start: i64, end: i64| {
            app.clone().oneshot(json_req(
                "PUT",
                "/api/media/markers",
                json!({
                    "media_kind": "movie",
                    "media_id": movie_id,
                    "marker_type": kind,
                    "start_secs": start,
                    "end_secs": end
                })
                .to_string(),
            ))
        };

        assert_eq!(put("intro", 0, 90).await.unwrap().status(), StatusCode::OK);
        assert_eq!(
            put("credits", 3000, 3300).await.unwrap().status(),
            StatusCode::OK
        );

        let get = app
            .clone()
            .oneshot(req(
                "GET",
                format!("/api/media/markers?media_kind=movie&media_id={movie_id}"),
            ))
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        let v = body_json(get).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        // credits sorts before intro alphabetically.
        assert_eq!(items[0]["marker_type"], "credits");
        assert_eq!(items[1]["marker_type"], "intro");
        assert_eq!(items[1]["start_secs"], 0);
        assert_eq!(items[1]["end_secs"], 90);

        // Upsert overwrites the existing intro span.
        assert_eq!(put("intro", 5, 100).await.unwrap().status(), StatusCode::OK);

        // Unknown media_id → 404.
        let put404 = app
            .clone()
            .oneshot(json_req(
                "PUT",
                "/api/media/markers",
                json!({
                    "media_kind": "movie",
                    "media_id": 9999,
                    "marker_type": "intro",
                    "start_secs": 0,
                    "end_secs": 90
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(put404.status(), StatusCode::NOT_FOUND);

        // Delete the intro marker.
        let del = app
            .clone()
            .oneshot(req(
                "DELETE",
                format!(
                    "/api/media/markers?media_kind=movie&media_id={movie_id}&marker_type=intro"
                ),
            ))
            .await
            .unwrap();
        assert_eq!(del.status(), StatusCode::OK);

        let get2 = app
            .oneshot(req(
                "GET",
                format!("/api/media/markers?media_kind=movie&media_id={movie_id}"),
            ))
            .await
            .unwrap();
        let v2 = body_json(get2).await;
        assert_eq!(v2["items"].as_array().unwrap().len(), 1); // only credits remains
    }
}
