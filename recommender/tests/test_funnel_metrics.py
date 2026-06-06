"""Funnel metrics: Wilson intervals + the rec_log/rec_outcomes aggregation.

The admin funnel view is the flywheel's observability — it must compute correct
rates with valid small-sample CIs and not double-count multi-outcome recs.
"""

from __future__ import annotations

import sqlite3

from app.metrics import clamp_window_days, compute_funnel, wilson_interval


def test_wilson_interval_basic_properties() -> None:
    # Empty -> (0, 0), no divide-by-zero.
    assert wilson_interval(0, 0) == (0.0, 0.0)
    # 0/100: lower bound pinned at 0, upper bound small but positive (not 0).
    lo, hi = wilson_interval(0, 100)
    assert lo == 0.0
    assert 0.0 < hi < 0.06
    # 50/100: interval brackets 0.5 and stays inside [0, 1].
    lo, hi = wilson_interval(50, 100)
    assert lo > 0.0 and hi < 1.0
    assert lo < 0.5 < hi
    # 1/1: upper bound clamps to 1.0 (normal-approx would exceed it).
    lo, hi = wilson_interval(1, 1)
    assert hi == 1.0
    # Larger n -> tighter interval than smaller n at the same rate.
    w_small = wilson_interval(1, 10)
    w_big = wilson_interval(100, 1000)
    assert (w_big[1] - w_big[0]) < (w_small[1] - w_small[0])


def test_clamp_window_days() -> None:
    assert clamp_window_days(30) == 30
    assert clamp_window_days(0) == 1
    assert clamp_window_days(99999) == 365
    assert clamp_window_days("nonsense") == 30  # type: ignore[arg-type]


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE rec_log (
          id INTEGER PRIMARY KEY, sub TEXT, kind TEXT, tmdb_id INTEGER,
          rank INTEGER, score REAL, provenance TEXT, model_version TEXT, ts TEXT
        );
        CREATE TABLE rec_outcomes (
          rec_id INTEGER, outcome TEXT, ts TEXT, PRIMARY KEY (rec_id, outcome)
        );
        """
    )
    return conn


def test_compute_funnel_counts_rates_distinct_and_window() -> None:
    conn = _conn()
    # 10 in-window impressions (ids 1..10) + 1 old impression (id 99).
    for i in range(1, 11):
        conn.execute(
            "INSERT INTO rec_log(id,sub,kind,tmdb_id,ts) VALUES (?,?,?,?,datetime('now','-1 day'))",
            (i, "plex:494190801", "movie", 1000 + i),
        )
    conn.execute(
        "INSERT INTO rec_log(id,sub,kind,tmdb_id,ts) VALUES (99,?,?,?,datetime('now','-400 days'))",
        ("plex:494190801", "movie", 9999),
    )
    # Outcomes in-window: 2 distinct recs added, 3 clicked, 1 disliked.
    for rid in (1, 2):
        conn.execute("INSERT INTO rec_outcomes(rec_id,outcome,ts) VALUES (?,?,datetime('now','-1 hour'))", (rid, "added"))
    for rid in (3, 4, 5):
        conn.execute("INSERT INTO rec_outcomes(rec_id,outcome,ts) VALUES (?,?,datetime('now','-1 hour'))", (rid, "clicked"))
    conn.execute("INSERT INTO rec_outcomes(rec_id,outcome,ts) VALUES (6,'disliked',datetime('now','-1 hour'))")
    # rec 1 also got clicked -> proves COUNT(DISTINCT rec_id) doesn't inflate added,
    # and that one rec carrying multiple outcomes is fine (PK is (rec_id,outcome)).
    conn.execute("INSERT INTO rec_outcomes(rec_id,outcome,ts) VALUES (1,'clicked',datetime('now','-1 hour'))")
    # An OLD outcome (outside window) must be excluded.
    conn.execute("INSERT INTO rec_outcomes(rec_id,outcome,ts) VALUES (7,'added',datetime('now','-400 days'))")

    out = compute_funnel(conn, window_days=30)

    assert out["window_days"] == 30
    assert out["impressions"] == 10  # old impression excluded
    m = out["metrics"]
    assert m["added_rate"]["n"] == 2 and m["added_rate"]["d"] == 10
    assert abs(m["added_rate"]["rate"] - 0.2) < 1e-9
    assert m["click_rate"]["n"] == 4  # recs 3,4,5 + rec 1
    assert m["dislike_rate"]["n"] == 1
    assert m["like_rate"]["n"] == 0
    # CI present, ordered, within [0,1].
    for key in ("added_rate", "click_rate", "like_rate", "dislike_rate"):
        lo, hi = m[key]["ci95"]
        assert 0.0 <= lo <= hi <= 1.0
    # Caveats are surfaced, not hidden.
    assert len(out["caveats"]) >= 2


def test_compute_funnel_zero_impressions_is_safe() -> None:
    out = compute_funnel(_conn(), window_days=7)
    assert out["impressions"] == 0
    assert out["metrics"]["added_rate"] == {"n": 0, "d": 0, "rate": 0.0, "ci95": [0.0, 0.0]}
