//! The /events/* writers and the hourly retention sweep. Each write is one
//! BEGIN IMMEDIATE transaction run on its own task, so a caller that hangs up
//! (the gateway's mirror timeout) cannot cancel it: Python's threadpool
//! handler always ran to the end too.

use std::future::Future;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use serde_json::{Value, json};
use sqlx::{Sqlite, SqlitePool, Transaction};

use super::{ApiError, AppState, authoritative_sub, gate, validate};
use crate::db::utc_now_iso;

/// recently_shown rows older than this are dropped on every write and sweep
/// (the read window in the user context is the same 30 days).
pub const RECENTLY_SHOWN_RETENTION_DAYS: i64 = 30;
/// A feedback event credits the newest rec_log row this recent.
const FEEDBACK_ATTRIBUTION_MINUTES: i64 = 10;

type Tx = Transaction<'static, Sqlite>;

/// Run `work` in one BEGIN IMMEDIATE transaction on a detached task.
async fn write<T, F, Fut>(pool: &SqlitePool, work: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(Tx) -> Fut + Send + 'static,
    Fut: Future<Output = sqlx::Result<(Tx, T)>> + Send,
{
    let pool = pool.clone();
    tokio::spawn(async move {
        let tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let (tx, out) = work(tx).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(out)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?
    .map_err(ApiError::from)
}

async fn trim_recently_shown(tx: &mut Tx) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM recently_shown WHERE datetime(ts) < datetime('now', ?)")
        .bind(format!("-{RECENTLY_SHOWN_RETENTION_DAYS} days"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

const UPSERT_SHOWN: &str = "INSERT INTO recently_shown(sub, kind, tmdb_id, ts)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(sub, kind, tmdb_id) DO UPDATE SET ts = excluded.ts";

fn ok() -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// Store a feedback signal, clear the signals it contradicts, and credit the
/// newest in-window recommendation of the title (rec_outcomes).
pub async fn feedback(
    State(st): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let (body, principal) = gate(&st, &headers, &bytes)?;
    let ev = validate::feedback(&body).map_err(ApiError::Invalid)?;
    let sub = authoritative_sub(&st.config, principal.as_ref(), &ev.sub)?;
    let (kind, tmdb_id, signal) = (ev.kind, ev.tmdb_id, ev.signal);
    let clear = match signal {
        "dislike" => {
            "DELETE FROM user_feedback WHERE sub=? AND kind=? AND tmdb_id=?
               AND signal IN ('like', 'clicked', 'added', 'watched')"
        }
        "reject" => {
            "DELETE FROM user_feedback WHERE sub=? AND kind=? AND tmdb_id=?
               AND signal IN ('like', 'dislike', 'clicked', 'added', 'watched')"
        }
        // like, clicked, added, watched
        _ => {
            "DELETE FROM user_feedback WHERE sub=? AND kind=? AND tmdb_id=?
               AND signal IN ('dislike', 'reject')"
        }
    };
    // Present tense in, past tense out (the rec_outcomes CHECK); watched has none.
    let outcome = match signal {
        "like" => Some("liked"),
        "dislike" => Some("disliked"),
        "reject" => Some("rejected"),
        "clicked" => Some("clicked"),
        "added" => Some("added"),
        _ => None,
    };
    write(&st.pool, move |mut tx| async move {
        let now = utc_now_iso();
        sqlx::query(clear)
            .bind(&sub)
            .bind(kind)
            .bind(tmdb_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(sub, kind, tmdb_id, signal) DO UPDATE SET ts = excluded.ts",
        )
        .bind(&sub)
        .bind(kind)
        .bind(tmdb_id)
        .bind(signal)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let Some(outcome) = outcome else {
            return Ok((tx, ()));
        };
        let rec: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM rec_log
               WHERE sub = ? AND kind = ? AND tmdb_id = ?
                 AND datetime(ts) >= datetime('now', ?)
               ORDER BY datetime(ts) DESC, id DESC LIMIT 1",
        )
        .bind(&sub)
        .bind(kind)
        .bind(tmdb_id)
        .bind(format!("-{FEEDBACK_ATTRIBUTION_MINUTES} minutes"))
        .fetch_optional(&mut *tx)
        .await?;
        let Some(rec_id) = rec else {
            tracing::warn!(
                "feedback attribution skipped: no in-session rec_log row sub={sub:?} kind={kind} \
                 tmdb_id={tmdb_id} signal={signal} window={FEEDBACK_ATTRIBUTION_MINUTES}m"
            );
            return Ok((tx, ()));
        };
        // The dot signals replace each other on every rec of the title.
        if matches!(signal, "like" | "dislike" | "reject") {
            sqlx::query(
                "DELETE FROM rec_outcomes
                   WHERE outcome IN ('liked', 'disliked', 'rejected')
                     AND rec_id IN (SELECT id FROM rec_log WHERE sub=? AND kind=? AND tmdb_id=?)",
            )
            .bind(&sub)
            .bind(kind)
            .bind(tmdb_id)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            "INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES (?, ?, ?)
               ON CONFLICT(rec_id, outcome) DO UPDATE SET ts = excluded.ts",
        )
        .bind(rec_id)
        .bind(outcome)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        Ok((tx, ()))
    })
    .await?;
    Ok(ok())
}

/// Mark trending-fill items as shown (recently_shown only: they were not
/// recommendations, so they never enter rec_log).
pub async fn shown(
    State(st): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let (body, principal) = gate(&st, &headers, &bytes)?;
    let ev = validate::shown(&body).map_err(ApiError::Invalid)?;
    if ev.tmdb_ids.is_empty() {
        return Ok(Json(json!({ "count": 0 })));
    }
    let sub = authoritative_sub(&st.config, principal.as_ref(), &ev.sub)?;
    let count = ev.tmdb_ids.len();
    write(&st.pool, move |mut tx| async move {
        let now = utc_now_iso();
        for id in &ev.tmdb_ids {
            sqlx::query(UPSERT_SHOWN)
                .bind(&sub)
                .bind(ev.kind)
                .bind(id)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
        }
        trim_recently_shown(&mut tx).await?;
        Ok((tx, ()))
    })
    .await?;
    Ok(Json(json!({ "count": count })))
}

/// Log what the recommender showed (rec_log, for attribution and the funnel)
/// and mark it shown.
pub async fn impressions(
    State(st): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let (body, principal) = gate(&st, &headers, &bytes)?;
    let ev = validate::impressions(&body).map_err(ApiError::Invalid)?;
    if ev.items.is_empty() {
        return Ok(Json(json!({ "count": 0 })));
    }
    let sub = authoritative_sub(&st.config, principal.as_ref(), &ev.sub)?;
    let count = ev.items.len();
    write(&st.pool, move |mut tx| async move {
        let now = utc_now_iso();
        for it in &ev.items {
            sqlx::query(
                "INSERT INTO rec_log(sub, kind, tmdb_id, rank, score, provenance, model_version, ts)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&sub)
            .bind(ev.kind)
            .bind(it.tmdb_id)
            .bind(it.rank)
            .bind(it.score)
            .bind(it.provenance)
            .bind(&it.model_version)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        for it in &ev.items {
            sqlx::query(UPSERT_SHOWN)
                .bind(&sub)
                .bind(ev.kind)
                .bind(it.tmdb_id)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
        }
        trim_recently_shown(&mut tx).await?;
        Ok((tx, ()))
    })
    .await?;
    Ok(Json(json!({ "count": count })))
}

/// A household veto (no sub: it applies to everyone).
pub async fn rejection(
    State(st): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let (body, _principal) = gate(&st, &headers, &bytes)?;
    let ev = validate::rejection(&body).map_err(ApiError::Invalid)?;
    write(&st.pool, move |mut tx| async move {
        sqlx::query(
            "INSERT INTO household_rejections(kind, tmdb_id, ts) VALUES (?, ?, datetime('now'))
               ON CONFLICT(kind, tmdb_id) DO NOTHING",
        )
        .bind(ev.kind)
        .bind(ev.tmdb_id)
        .execute(&mut *tx)
        .await?;
        Ok((tx, ()))
    })
    .await?;
    Ok(ok())
}

/// The gateway calls this only once no household member still dislikes it.
pub async fn clear_rejection(
    State(st): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let (body, _principal) = gate(&st, &headers, &bytes)?;
    let ev = validate::rejection(&body).map_err(ApiError::Invalid)?;
    write(&st.pool, move |mut tx| async move {
        sqlx::query("DELETE FROM household_rejections WHERE kind=? AND tmdb_id=?")
            .bind(ev.kind)
            .bind(ev.tmdb_id)
            .execute(&mut *tx)
            .await?;
        Ok((tx, ()))
    })
    .await?;
    Ok(ok())
}

/// Clear one dot signal (or all three) and its outcomes.
pub async fn clear_feedback(
    State(st): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let (body, principal) = gate(&st, &headers, &bytes)?;
    let ev = validate::clear_feedback(&body).map_err(ApiError::Invalid)?;
    let sub = authoritative_sub(&st.config, principal.as_ref(), &ev.sub)?;
    let pairs: &[(&str, &str)] = match ev.signal {
        Some("like") => &[("like", "liked")],
        Some("dislike") => &[("dislike", "disliked")],
        Some(_) => &[("reject", "rejected")],
        None => &[
            ("like", "liked"),
            ("dislike", "disliked"),
            ("reject", "rejected"),
        ],
    };
    let (kind, tmdb_id) = (ev.kind, ev.tmdb_id);
    write(&st.pool, move |mut tx| async move {
        for (signal, outcome) in pairs {
            sqlx::query(
                "DELETE FROM user_feedback WHERE sub=? AND kind=? AND tmdb_id=? AND signal=?",
            )
            .bind(&sub)
            .bind(kind)
            .bind(tmdb_id)
            .bind(signal)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM rec_outcomes
                   WHERE outcome = ?
                     AND rec_id IN (SELECT id FROM rec_log WHERE sub=? AND kind=? AND tmdb_id=?)",
            )
            .bind(outcome)
            .bind(&sub)
            .bind(kind)
            .bind(tmdb_id)
            .execute(&mut *tx)
            .await?;
        }
        Ok((tx, ()))
    })
    .await?;
    Ok(ok())
}

/// Drop rec_log rows past the retention window that no outcome references,
/// and stale recently_shown rows.
pub async fn sweep_retention_once(
    pool: &SqlitePool,
    rec_log_retention_days: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        "DELETE FROM rec_log
           WHERE datetime(ts) < datetime('now', ?)
             AND id NOT IN (SELECT rec_id FROM rec_outcomes)",
    )
    .bind(format!("-{rec_log_retention_days} days"))
    .execute(&mut *tx)
    .await?;
    trim_recently_shown(&mut tx).await?;
    tx.commit().await
}

/// The sweep at boot, then hourly.
pub fn spawn_retention_sweeper(
    pool: SqlitePool,
    rec_log_retention_days: i64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(std::time::Duration::from_secs(3600));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            if let Err(e) = sweep_retention_once(&pool, rec_log_retention_days).await {
                tracing::error!("retention sweep failed: {e}");
            }
        }
    })
}
