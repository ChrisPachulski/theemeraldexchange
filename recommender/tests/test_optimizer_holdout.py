"""Holdout loading, seed fallback, and record-only status for the optimizer.

These exercise the auto-promotion safety gate: the optimizer must have a
populated, sufficiently large holdout before it will promote, and must ship a
vetted seed so the learning loop is not silently record-only forever.
"""

from __future__ import annotations

import json
import os

from workers import optimizer


def test_load_holdout_explicit_path_wins(monkeypatch, tmp_path):
    rows = [
        {"sub": "plex:u1", "kind": "movie", "library": list(range(10, 25)),
         "positives": [157336], "negatives": [603534]}
    ]
    p = tmp_path / "holdout.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", str(p))
    loaded = optimizer.load_holdout()
    assert loaded == rows


def test_load_holdout_falls_back_to_seed(monkeypatch):
    # Explicit path missing and repo holdout.jsonl is gitignored/absent, so the
    # loader must fall back to the committed seed that ships in the image.
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", "/nonexistent/holdout.jsonl")
    loaded = optimizer.load_holdout()
    assert len(loaded) >= optimizer.MIN_HOLDOUT_SIZE
    for row in loaded:
        assert "title" not in row  # title prose must never re-enter the data path
        assert set(row) >= {"sub", "kind", "library", "positives", "negatives"}


def test_holdout_status_active_with_seed(monkeypatch):
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", "/nonexistent/holdout.jsonl")
    status = optimizer.holdout_status()
    assert status["mode"] == "active"
    assert status["holdout_size"] >= optimizer.MIN_HOLDOUT_SIZE
    assert status["min_holdout_size"] == optimizer.MIN_HOLDOUT_SIZE


def test_holdout_status_record_only_when_too_small(monkeypatch, tmp_path):
    rows = [
        {"sub": f"plex:u{i}", "kind": "movie", "library": list(range(10, 25)),
         "positives": [157336], "negatives": []}
        for i in range(optimizer.MIN_HOLDOUT_SIZE - 1)
    ]
    p = tmp_path / "tiny.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", str(p))
    status = optimizer.holdout_status()
    assert status["mode"] == "record-only"
    assert status["holdout_size"] == optimizer.MIN_HOLDOUT_SIZE - 1


def test_seed_holdout_is_committed_and_well_formed():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    seed = os.path.join(here, "eval", "holdout.seed.jsonl")
    assert os.path.exists(seed), "vetted seed holdout must ship in the repo/image"
    with open(seed, encoding="utf-8") as fh:
        rows = [json.loads(line) for line in fh if line.strip()]
    assert len(rows) >= optimizer.MIN_HOLDOUT_SIZE
    for row in rows:
        assert set(row) == {"sub", "kind", "library", "positives", "negatives"}
        assert row["kind"] in ("movie", "tv")
        assert row["positives"], "every seed row needs a recall signal"
        # build_holdout invariant: positives are not also in library.
        assert not (set(row["positives"]) & set(row["library"]))


def test_min_candidate_score_is_above_epsilon():
    # The absolute floor must be meaningfully larger than the relative margin,
    # else it adds no protection against near-zero-baseline promotion.
    assert optimizer.MIN_CANDIDATE_SCORE > optimizer.EVAL_EPSILON
