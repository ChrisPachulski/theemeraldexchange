//! Funnel metrics (`app/metrics.py`): impressions -> clicked / added plus dot
//! feedback over a rolling window, with Wilson 95% intervals and sample sizes.
//! Read-only over rec_log and rec_outcomes.

use serde_json::{Value, json};
use sqlx::SqlitePool;

pub const WINDOW_DAYS_DEFAULT: i64 = 30;
pub const WINDOW_DAYS_MAX: i64 = 365;

/// 95% Wilson score interval, clamped to [0, 1]. The operations run in the
/// Python order so the floats come out bit for bit.
pub fn wilson_interval(successes: i64, total: i64) -> (f64, f64) {
    if total <= 0 {
        return (0.0, 0.0);
    }
    let (s, t, z) = (successes as f64, total as f64, 1.96_f64);
    let p = s / t;
    let z2 = z * z;
    let denom = 1.0 + z2 / t;
    let center = (p + z2 / (2.0 * t)) / denom;
    let margin = (z * ((p * (1.0 - p) + z2 / (4.0 * t)) / t).sqrt()) / denom;
    // Python max(0.0, x) / min(1.0, x): the first argument unless x beats it.
    let (lo, hi) = (center - margin, center + margin);
    (
        if lo > 0.0 { lo } else { 0.0 },
        if hi < 1.0 { hi } else { 1.0 },
    )
}

fn rate(successes: i64, total: i64) -> Value {
    let (lo, hi) = wilson_interval(successes, total);
    json!({
        "n": successes,
        "d": total,
        "rate": if total > 0 { successes as f64 / total as f64 } else { 0.0 },
        "ci95": [lo, hi],
    })
}

pub fn clamp_window_days(window_days: i128) -> i64 {
    window_days.clamp(1, WINDOW_DAYS_MAX as i128) as i64
}

/// Outcomes count DISTINCT rec_id per outcome, and only in-window outcomes of
/// in-window impressions, so successes never exceed impressions.
pub async fn compute_funnel(pool: &SqlitePool, window_days: i128) -> sqlx::Result<Value> {
    let wd = clamp_window_days(window_days);
    let win = format!("-{wd} days");
    let impressions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) AS c FROM rec_log WHERE datetime(ts) >= datetime('now', ?)",
    )
    .bind(&win)
    .fetch_one(pool)
    .await?;
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT o.outcome AS outcome, COUNT(DISTINCT o.rec_id) AS c
           FROM rec_outcomes o
           JOIN rec_log r ON r.id = o.rec_id
           WHERE datetime(r.ts) >= datetime('now', ?)
             AND datetime(o.ts) >= datetime('now', ?)
           GROUP BY o.outcome",
    )
    .bind(&win)
    .bind(&win)
    .fetch_all(pool)
    .await?;
    let by = |o: &str| rows.iter().find(|r| r.0 == o).map_or(0, |r| r.1);
    Ok(json!({
        "window_days": wd,
        "impressions": impressions,
        "metrics": {
            "added_rate": rate(by("added"), impressions),
            "click_rate": rate(by("clicked"), impressions),
            "like_rate": rate(by("liked"), impressions),
            "dislike_rate": rate(by("disliked"), impressions),
        },
        "caveats": [
            "denominator: impressions are server-logged at fetch and may include \
             cards the UI never rendered (logs up to TARGET_COUNT, strip renders \
             fewer) — overcounts until visibility-based impression logging (increment 2).",
            "attribution: outcomes attribute by (sub,kind,tmdb_id) last-touch in-window, \
             not by a per-impression id — per-model_version splits are unreliable until \
             impression_id lands (increment 2).",
        ],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // recommender/tests/test_funnel_metrics.py, case for case.
    #[test]
    fn wilson_interval_basic_properties() {
        assert_eq!(wilson_interval(0, 0), (0.0, 0.0));
        let (lo, hi) = wilson_interval(0, 100);
        assert_eq!(lo, 0.0);
        assert!(0.0 < hi && hi < 0.06);
        let (lo, hi) = wilson_interval(50, 100);
        assert!(lo > 0.0 && hi < 1.0 && lo < 0.5 && 0.5 < hi);
        assert_eq!(wilson_interval(1, 1).1, 1.0);
        let small = wilson_interval(1, 10);
        let big = wilson_interval(100, 1000);
        assert!(big.1 - big.0 < small.1 - small.0);
    }

    #[test]
    fn clamps_window_days() {
        assert_eq!(clamp_window_days(30), 30);
        assert_eq!(clamp_window_days(0), 1);
        assert_eq!(clamp_window_days(99999), 365);
    }

    async fn conn() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE rec_log (
               id INTEGER PRIMARY KEY, sub TEXT, kind TEXT, tmdb_id INTEGER,
               rank INTEGER, score REAL, provenance TEXT, model_version TEXT, ts TEXT
             );
             CREATE TABLE rec_outcomes (
               rec_id INTEGER, outcome TEXT, ts TEXT, PRIMARY KEY (rec_id, outcome)
             );",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn exec(pool: &SqlitePool, sql: &'static str) {
        sqlx::raw_sql(sql).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn counts_rates_distinct_and_window() {
        let pool = conn().await;
        for i in 1..=10 {
            sqlx::query(
                "INSERT INTO rec_log(id,sub,kind,tmdb_id,ts) VALUES (?,'plex:494190801','movie',?,datetime('now','-1 day'))",
            )
            .bind(i)
            .bind(1000 + i)
            .execute(&pool)
            .await
            .unwrap();
        }
        exec(
            &pool,
            "INSERT INTO rec_log(id,sub,kind,tmdb_id,ts) VALUES (99,'plex:494190801','movie',9999,datetime('now','-400 days'));
             INSERT INTO rec_outcomes(rec_id,outcome,ts) VALUES
               (1,'added',datetime('now','-1 hour')), (2,'added',datetime('now','-1 hour')),
               (3,'clicked',datetime('now','-1 hour')), (4,'clicked',datetime('now','-1 hour')),
               (5,'clicked',datetime('now','-1 hour')), (6,'disliked',datetime('now','-1 hour')),
               (1,'clicked',datetime('now','-1 hour')), (7,'added',datetime('now','-400 days'));",
        )
        .await;
        let out = compute_funnel(&pool, 30).await.unwrap();
        assert_eq!(out["window_days"], 30);
        assert_eq!(out["impressions"], 10);
        let m = &out["metrics"];
        assert_eq!(
            (m["added_rate"]["n"].as_i64(), m["added_rate"]["d"].as_i64()),
            (Some(2), Some(10))
        );
        assert!((m["added_rate"]["rate"].as_f64().unwrap() - 0.2).abs() < 1e-9);
        assert_eq!(m["click_rate"]["n"], 4);
        assert_eq!(m["dislike_rate"]["n"], 1);
        assert_eq!(m["like_rate"]["n"], 0);
        for key in ["added_rate", "click_rate", "like_rate", "dislike_rate"] {
            let (lo, hi) = (
                m[key]["ci95"][0].as_f64().unwrap(),
                m[key]["ci95"][1].as_f64().unwrap(),
            );
            assert!(0.0 <= lo && lo <= hi && hi <= 1.0);
        }
        assert!(out["caveats"].as_array().unwrap().len() >= 2);
    }

    #[tokio::test]
    async fn zero_impressions_is_safe() {
        let out = compute_funnel(&conn().await, 7).await.unwrap();
        assert_eq!(out["impressions"], 0);
        assert_eq!(
            out["metrics"]["added_rate"],
            json!({"n": 0, "d": 0, "rate": 0.0, "ci95": [0.0, 0.0]})
        );
    }

    #[tokio::test]
    async fn counts_only_outcomes_of_in_window_impressions() {
        let pool = conn().await;
        exec(
            &pool,
            "INSERT INTO rec_log(id,sub,kind,tmdb_id,ts) VALUES
               (1,'plex:1','movie',1,datetime('now','-1 day')),
               (50,'plex:1','movie',50,datetime('now','-90 days')),
               (51,'plex:1','movie',51,datetime('now','-90 days'));
             INSERT INTO rec_outcomes(rec_id,outcome,ts) VALUES
               (50,'added',datetime('now','-1 hour')), (51,'added',datetime('now','-1 hour'));",
        )
        .await;
        let out = compute_funnel(&pool, 7).await.unwrap();
        assert_eq!(out["impressions"], 1);
        assert_eq!(out["metrics"]["added_rate"]["n"], 0);
    }
}
