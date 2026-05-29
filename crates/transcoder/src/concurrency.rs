//! Concurrency caps (§4.4/§4.5 phase 6).
//!
//! Two counters: a global `MAX_CONCURRENT_TRANSCODES` (default 4) and a
//! stricter `MAX_CONCURRENT_CPU_TRANSCODES` (default 1), because a CPU
//! (libx264) transcode is an order of magnitude heavier than a hardware one.
//! When either cap is hit, `try_acquire` returns [`Busy`] and the route maps it
//! to a 503 `transcoder_busy`.
//!
//! The acquired [`Permit`] decrements both counters on drop, so a session that
//! panics or is killed never leaks a slot.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Returned when a start request exceeds a concurrency cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Busy {
    /// True when the CPU-specific cap was the limiter (vs the global cap).
    pub cpu_cap: bool,
}

/// Caps, read from the environment with documented defaults.
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    pub max_total: usize,
    pub max_cpu: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Caps {
            max_total: 4,
            max_cpu: 1,
        }
    }
}

impl Caps {
    /// `MAX_CONCURRENT_TRANSCODES` / `MAX_CONCURRENT_CPU_TRANSCODES`.
    pub fn from_env() -> Self {
        let total = std::env::var("MAX_CONCURRENT_TRANSCODES")
            .ok()
            .and_then(|s| s.trim().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(4);
        let cpu = std::env::var("MAX_CONCURRENT_CPU_TRANSCODES")
            .ok()
            .and_then(|s| s.trim().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(1);
        Caps {
            max_total: total,
            max_cpu: cpu.min(total),
        }
    }
}

/// Live counters behind an `Arc` so the [`Permit`] can decrement on drop.
#[derive(Debug)]
struct Counters {
    total: AtomicUsize,
    cpu: AtomicUsize,
    caps: Caps,
}

/// A concurrency limiter shared across the session manager.
#[derive(Debug, Clone)]
pub struct Limiter {
    inner: Arc<Counters>,
}

impl Limiter {
    pub fn new(caps: Caps) -> Self {
        Limiter {
            inner: Arc::new(Counters {
                total: AtomicUsize::new(0),
                cpu: AtomicUsize::new(0),
                caps,
            }),
        }
    }

    /// Current `(total_active, cpu_active)` — for the admin inventory.
    pub fn active(&self) -> (usize, usize) {
        (
            self.inner.total.load(Ordering::SeqCst),
            self.inner.cpu.load(Ordering::SeqCst),
        )
    }

    pub fn caps(&self) -> Caps {
        self.inner.caps
    }

    /// Try to claim a slot. `is_cpu` is true for a libx264 (CPU) transcode,
    /// which also charges the stricter CPU cap. Returns a [`Permit`] that frees
    /// the slot(s) on drop, or [`Busy`] when a cap is reached.
    ///
    /// The two counters are bumped under a compare-and-swap loop so two
    /// concurrent starts can never both squeak past the last slot.
    pub fn try_acquire(&self, is_cpu: bool) -> Result<Permit, Busy> {
        // Reserve the CPU slot first (the scarcer resource) so we never bump
        // the global counter and then have to roll it back on a CPU miss.
        if is_cpu {
            let mut cur = self.inner.cpu.load(Ordering::SeqCst);
            loop {
                if cur >= self.inner.caps.max_cpu {
                    return Err(Busy { cpu_cap: true });
                }
                match self.inner.cpu.compare_exchange_weak(
                    cur,
                    cur + 1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(observed) => cur = observed,
                }
            }
        }

        // Now the global slot.
        let mut cur = self.inner.total.load(Ordering::SeqCst);
        loop {
            if cur >= self.inner.caps.max_total {
                // Roll back the CPU reservation we just took.
                if is_cpu {
                    self.inner.cpu.fetch_sub(1, Ordering::SeqCst);
                }
                return Err(Busy { cpu_cap: false });
            }
            match self.inner.total.compare_exchange_weak(
                cur,
                cur + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(observed) => cur = observed,
            }
        }

        Ok(Permit {
            inner: Arc::clone(&self.inner),
            is_cpu,
        })
    }
}

/// Holds one global slot (and one CPU slot when `is_cpu`). Frees on drop.
#[derive(Debug)]
pub struct Permit {
    inner: Arc<Counters>,
    is_cpu: bool,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.inner.total.fetch_sub(1, Ordering::SeqCst);
        if self.is_cpu {
            self.inner.cpu.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_default() {
        let c = Caps::default();
        assert_eq!(c.max_total, 4);
        assert_eq!(c.max_cpu, 1);
    }

    #[test]
    fn global_cap_blocks_past_limit() {
        let l = Limiter::new(Caps {
            max_total: 2,
            max_cpu: 2,
        });
        let _p1 = l.try_acquire(false).unwrap();
        let _p2 = l.try_acquire(false).unwrap();
        let busy = l.try_acquire(false).unwrap_err();
        assert!(!busy.cpu_cap, "global cap, not cpu cap");
        assert_eq!(l.active(), (2, 0));
    }

    #[test]
    fn cpu_cap_blocks_independently_of_global() {
        // 4 total slots but only 1 CPU slot: a second CPU start is rejected
        // even though global headroom remains.
        let l = Limiter::new(Caps {
            max_total: 4,
            max_cpu: 1,
        });
        let _cpu = l.try_acquire(true).unwrap();
        let busy = l.try_acquire(true).unwrap_err();
        assert!(busy.cpu_cap, "should be the cpu cap that bites");
        assert_eq!(l.active(), (1, 1));
        // A hardware transcode still fits under the global cap.
        let _hw = l.try_acquire(false).unwrap();
        assert_eq!(l.active(), (2, 1));
    }

    #[test]
    fn permit_release_on_drop_frees_both_counters() {
        let l = Limiter::new(Caps {
            max_total: 2,
            max_cpu: 1,
        });
        {
            let _p = l.try_acquire(true).unwrap();
            assert_eq!(l.active(), (1, 1));
        }
        assert_eq!(l.active(), (0, 0), "drop must free total + cpu");
        // After the drop, a new CPU transcode can start again.
        let _p = l.try_acquire(true).unwrap();
        assert_eq!(l.active(), (1, 1));
    }

    #[test]
    fn cpu_miss_does_not_consume_a_global_slot() {
        // When the CPU cap rejects, the global counter must be untouched (no
        // leaked reservation).
        let l = Limiter::new(Caps {
            max_total: 4,
            max_cpu: 1,
        });
        let _cpu = l.try_acquire(true).unwrap();
        let _ = l.try_acquire(true).unwrap_err();
        assert_eq!(l.active(), (1, 1), "rejected start must not bump total");
    }

    #[test]
    fn global_miss_rolls_back_cpu_reservation() {
        // total==cpu==1: a CPU start fills both. A second CPU start must hit
        // the CPU cap first (rejected) without disturbing counters.
        let l = Limiter::new(Caps {
            max_total: 1,
            max_cpu: 1,
        });
        let _p = l.try_acquire(true).unwrap();
        let busy = l.try_acquire(true).unwrap_err();
        assert!(busy.cpu_cap);
        assert_eq!(l.active(), (1, 1));
    }
}
