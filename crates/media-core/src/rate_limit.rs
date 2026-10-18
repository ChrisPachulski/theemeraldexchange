//! Token bucket per caller key, as the Hono rateLimit middleware: `capacity`
//! tokens, `refill` added back per whole interval. Shared by iptv (search,
//! DVR) and the gateway (*arr/SAB mutations); each limiter keeps its own
//! buckets.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

// ponytail: buckets are never evicted; one household is a handful of keys. Add
// a sweep if callers ever become unbounded.
pub struct RateLimiter {
    capacity: u32,
    refill: u32,
    interval: Duration,
    buckets: Mutex<HashMap<String, (u32, Instant)>>,
}

impl RateLimiter {
    pub fn new(capacity: u32, refill: u32, interval: Duration) -> Self {
        RateLimiter {
            capacity,
            refill,
            interval,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Take a token for `key`, or the 429 the Hono middleware answers:
    /// Retry-After plus `retry_after_ms`.
    // The 429 is the cold path; boxing it buys nothing.
    #[allow(clippy::result_large_err)]
    pub fn check(&self, key: &str) -> Result<(), Response> {
        self.take(key).map_err(|retry_ms| {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, retry_ms.div_ceil(1000).to_string())],
                Json(json!({ "error": "rate_limited", "retry_after_ms": retry_ms })),
            )
                .into_response()
        })
    }

    /// Ok, or the milliseconds until the next refill.
    pub fn take(&self, key: &str) -> Result<(), u64> {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap();
        let (tokens, last) = buckets
            .entry(key.to_string())
            .or_insert((self.capacity, now));
        let elapsed = now.duration_since(*last);
        if elapsed >= self.interval {
            let refills = (elapsed.as_millis() / self.interval.as_millis().max(1)) as u32;
            *tokens = self
                .capacity
                .min(tokens.saturating_add(refills.saturating_mul(self.refill)));
            *last = now;
        }
        if *tokens == 0 {
            return Err(self
                .interval
                .saturating_sub(now.duration_since(*last))
                .as_millis() as u64);
        }
        *tokens -= 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // rateLimit.test.ts: refill per whole interval, the capacity clamp, no
    // refill before a full interval, per-key and per-limiter isolation.
    #[test]
    fn refills_in_whole_intervals() {
        let l = RateLimiter::new(2, 2, Duration::from_millis(50));
        assert!(l.take("a").is_ok() && l.take("a").is_ok());
        let retry = l.take("a").unwrap_err();
        assert!(retry <= 50);
        assert!(l.take("b").is_ok(), "per key");
        std::thread::sleep(Duration::from_millis(60));
        assert!(l.take("a").is_ok());
    }

    #[test]
    fn refill_is_clamped_to_capacity() {
        let l = RateLimiter::new(2, 2, Duration::from_millis(10));
        assert!(l.take("a").is_ok());
        std::thread::sleep(Duration::from_millis(100));
        let got: Vec<bool> = (0..3).map(|_| l.take("a").is_ok()).collect();
        assert_eq!(got, [true, true, false]);
    }

    #[test]
    fn no_refill_inside_an_interval() {
        let l = RateLimiter::new(1, 1, Duration::from_secs(60));
        assert!(l.take("a").is_ok());
        assert!(l.take("a").is_err());
        std::thread::sleep(Duration::from_millis(20));
        assert!(l.take("a").is_err());
    }

    #[test]
    fn limiters_keep_their_own_buckets() {
        let (a, b) = (
            RateLimiter::new(1, 1, Duration::from_secs(60)),
            RateLimiter::new(1, 1, Duration::from_secs(60)),
        );
        assert!(a.take("sub:x").is_ok());
        assert!(a.take("sub:x").is_err());
        assert!(b.take("sub:x").is_ok());
    }

    #[tokio::test]
    async fn the_429_carries_retry_after_and_the_hint() {
        let l = RateLimiter::new(1, 1, Duration::from_secs(60));
        assert!(l.check("k").is_ok());
        let res = l.check("k").unwrap_err();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(res.headers()[header::RETRY_AFTER], "60");
        let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"], "rate_limited");
        assert!(v["retry_after_ms"].as_u64().unwrap() <= 60_000);
    }
}
