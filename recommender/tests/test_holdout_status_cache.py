"""holdout_status() caches by (path, mtime, size) — /health probes must not
re-parse the entire holdout file on every hit, but an operator swap or rewrite
must be picked up immediately."""

from __future__ import annotations

import json
import os

import pytest

from workers import optimizer


def _write_holdout(path, n_rows: int) -> None:
    rows = [
        {"sub": f"plex:u{i}", "kind": "movie", "library": [10, 11],
         "positives": [157336], "negatives": []}
        for i in range(n_rows)
    ]
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


@pytest.fixture(autouse=True)
def _reset_cache():
    optimizer._HOLDOUT_STATUS_CACHE = None
    yield
    optimizer._HOLDOUT_STATUS_CACHE = None


def test_cache_hit_skips_reparse(monkeypatch, tmp_path) -> None:
    p = tmp_path / "holdout.jsonl"
    _write_holdout(p, 3)
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", str(p))

    calls = {"n": 0}
    real_load = optimizer.load_holdout

    def counting_load():
        calls["n"] += 1
        return real_load()

    monkeypatch.setattr(optimizer, "load_holdout", counting_load)
    s1 = optimizer.holdout_status()
    s2 = optimizer.holdout_status()
    assert s1 == s2
    assert s1["holdout_size"] == 3
    assert calls["n"] == 1, "second probe must be served from the cache"


def test_mtime_change_invalidates(monkeypatch, tmp_path) -> None:
    p = tmp_path / "holdout.jsonl"
    _write_holdout(p, 2)
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", str(p))
    assert optimizer.holdout_status()["holdout_size"] == 2

    _write_holdout(p, optimizer.MIN_HOLDOUT_SIZE)
    # Force a distinct mtime even on coarse-granularity filesystems.
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))

    status = optimizer.holdout_status()
    assert status["holdout_size"] == optimizer.MIN_HOLDOUT_SIZE
    assert status["mode"] == "active"


def test_path_change_invalidates(monkeypatch, tmp_path) -> None:
    p1 = tmp_path / "a.jsonl"
    p2 = tmp_path / "b.jsonl"
    _write_holdout(p1, 1)
    _write_holdout(p2, 4)
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", str(p1))
    assert optimizer.holdout_status()["holdout_size"] == 1
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", str(p2))
    assert optimizer.holdout_status()["holdout_size"] == 4


def test_cached_status_is_a_copy(monkeypatch, tmp_path) -> None:
    p = tmp_path / "holdout.jsonl"
    _write_holdout(p, 2)
    monkeypatch.setenv("RECOMMENDER_HOLDOUT_PATH", str(p))
    s1 = optimizer.holdout_status()
    s1["holdout_size"] = 999  # caller mutation must not poison the cache
    assert optimizer.holdout_status()["holdout_size"] == 2
