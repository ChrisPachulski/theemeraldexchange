"""Recommender funnel metrics — the online observability the flywheel needs.

Computes the conversion funnel (impressions -> clicked / added, plus dot
feedback) over a rolling window, with Wilson 95% confidence intervals and
sample sizes so an operator can tell signal from n=1 noise. Read-only over the
existing rec_log + rec_outcomes tables.

Known limits (surfaced as `caveats` in the payload, not hidden):
  * denominator: impressions are server-logged at fetch and include cards the
    UI may not have rendered — overcounts until visibility-based impression
    logging lands (increment 2).
  * attribution: outcomes attribute by (sub, kind, tmdb_id) last-touch within
    the recommender's window, not a per-impression id — per-model_version
    splits are unreliable until impression_id lands (increment 2).
"""

from __future__ import annotations

import math
import sqlite3

WINDOW_DAYS_DEFAULT = 30
WINDOW_DAYS_MAX = 365


def wilson_interval(successes: int, total: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for a binomial proportion, clamped to [0, 1].

    Wilson rather than the normal approximation because at small n or extreme
    rates (e.g. 0/1243) the normal interval is invalid (can fall outside
    [0, 1]); Wilson stays well-behaved, which is exactly the n=1 regime here.
    """
    if total <= 0:
        return (0.0, 0.0)
    p = successes / total
    z2 = z * z
    denom = 1.0 + z2 / total
    center = (p + z2 / (2 * total)) / denom
    margin = (z * math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def _rate(successes: int, total: int) -> dict:
    lo, hi = wilson_interval(successes, total)
    return {
        "n": successes,
        "d": total,
        "rate": (successes / total) if total > 0 else 0.0,
        "ci95": [lo, hi],
    }


def clamp_window_days(window_days: int) -> int:
    try:
        wd = int(window_days)
    except (TypeError, ValueError):
        return WINDOW_DAYS_DEFAULT
    return max(1, min(WINDOW_DAYS_MAX, wd))


def compute_funnel(conn: sqlite3.Connection, window_days: int = WINDOW_DAYS_DEFAULT) -> dict:
    """Funnel rates + Wilson CIs over the last `window_days`.

    Outcome counts are COUNT(DISTINCT rec_id) per outcome so a rec carrying
    several outcome rows (clicked + added + ...) is not double-counted within an
    outcome. Impressions = rec_log rows in-window.
    """
    wd = clamp_window_days(window_days)
    win = f"-{wd} days"

    impressions = conn.execute(
        "SELECT COUNT(*) AS c FROM rec_log WHERE datetime(ts) >= datetime('now', ?)",
        (win,),
    ).fetchone()["c"]

    rows = conn.execute(
        """SELECT o.outcome AS outcome, COUNT(DISTINCT o.rec_id) AS c
           FROM rec_outcomes o
           WHERE datetime(o.ts) >= datetime('now', ?)
           GROUP BY o.outcome""",
        (win,),
    ).fetchall()
    by = {r["outcome"]: r["c"] for r in rows}

    return {
        "window_days": wd,
        "impressions": impressions,
        # added_rate is the near-term north-star (strong intent, already
        # attributed); the others are the funnel + dot-feedback context.
        "metrics": {
            "added_rate": _rate(by.get("added", 0), impressions),
            "click_rate": _rate(by.get("clicked", 0), impressions),
            "like_rate": _rate(by.get("liked", 0), impressions),
            "dislike_rate": _rate(by.get("disliked", 0), impressions),
        },
        "caveats": [
            "denominator: impressions are server-logged at fetch and may include "
            "cards the UI never rendered (logs up to TARGET_COUNT, strip renders "
            "fewer) — overcounts until visibility-based impression logging (increment 2).",
            "attribution: outcomes attribute by (sub,kind,tmdb_id) last-touch in-window, "
            "not by a per-impression id — per-model_version splits are unreliable until "
            "impression_id lands (increment 2).",
        ],
    }
