"""Nightly optimizer: Claude reads yesterday's outcomes and proposes a config patch.

Pipeline:
  1. Pull active model_config + last-24h aggregates from rec_log/rec_outcomes.
  2. Build a Claude prompt with: current recipe + params + outcome summary
     + worst-case examples (high-score picks that got rejected, low-score
     picks that got liked).
  3. Claude returns a JSON patch: {recipe, params, notes}.
  4. Clamp every numeric param change to ±drift_pct of the active value.
  5. Eval candidate against eval/holdout.jsonl. If it beats baseline by
     ``epsilon``, write a new model_config row and flip ``active``.
     Otherwise log the proposal and keep current.

All Claude usage is one call per run; output capped via ``max_tokens``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import anthropic

from app import recipes
from app.config import CONFIG
from app.context import load_user_context, select_model_config_for_context
from app.db import connect, transaction
from app.schemas import ScoreRequest

log = logging.getLogger("optimizer")
MIN_ZERO_BASE_STEP = 1e-6
MAX_INACTIVE_MODEL_CONFIGS = 30

CLAUDE_MODEL = os.environ.get("RECOMMENDER_OPTIMIZER_MODEL", "claude-haiku-4-5-20251001")
EVAL_EPSILON = 0.005  # require >0.5% improvement to promote


# =========================================================================
# Outcome aggregation
# =========================================================================


@dataclass
class OutcomeStats:
    total_recs: int
    by_outcome: dict[str, int]
    worst_offenders: list[dict[str, Any]]   # high-score, rejected
    pleasant_surprises: list[dict[str, Any]]  # low-score, liked


def _aggregate(conn: sqlite3.Connection) -> OutcomeStats:
    total = conn.execute(
        "SELECT COUNT(*) AS c FROM rec_log WHERE datetime(ts) >= datetime('now','-1 day')"
    ).fetchone()["c"]

    by_outcome_rows = conn.execute(
        """SELECT o.outcome, COUNT(*) AS c
           FROM rec_outcomes o
           JOIN rec_log r ON r.id = o.rec_id
           WHERE datetime(r.ts) >= datetime('now','-1 day')
           GROUP BY o.outcome"""
    ).fetchall()
    by_outcome = {r["outcome"]: r["c"] for r in by_outcome_rows}

    worst = conn.execute(
        """SELECT r.kind, r.tmdb_id, r.score, r.provenance, r.rank, r.ts, t.title
           FROM rec_log r
           JOIN rec_outcomes o ON o.rec_id = r.id
           LEFT JOIN titles t ON t.kind = r.kind AND t.tmdb_id = r.tmdb_id
           WHERE datetime(r.ts) >= datetime('now','-1 day') AND o.outcome IN ('rejected','disliked')
           ORDER BY r.score DESC LIMIT 8"""
    ).fetchall()
    pleasant = conn.execute(
        """SELECT r.kind, r.tmdb_id, r.score, r.provenance, r.rank, r.ts, t.title
           FROM rec_log r
           JOIN rec_outcomes o ON o.rec_id = r.id
           LEFT JOIN titles t ON t.kind = r.kind AND t.tmdb_id = r.tmdb_id
           WHERE datetime(r.ts) >= datetime('now','-1 day') AND o.outcome IN ('liked','added','clicked')
           ORDER BY r.score ASC LIMIT 8"""
    ).fetchall()

    def _ser(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
        return [
            {"kind": r["kind"], "tmdb_id": r["tmdb_id"], "title": r["title"], "score": r["score"], "provenance": r["provenance"], "rank": r["rank"], "rec_ts": r["ts"]}
            for r in rows
        ]

    return OutcomeStats(
        total_recs=total,
        by_outcome=by_outcome,
        worst_offenders=_ser(worst),
        pleasant_surprises=_ser(pleasant),
    )


# =========================================================================
# Claude call
# =========================================================================


SYSTEM_PROMPT = """You optimize a content-based movie/TV recommender's configuration.

You will be given:
* the active recipe + its numeric params
* the last 24h of outcome aggregates
* eight worst offenders (high-score picks the user rejected/disliked)
* eight pleasant surprises (low-score picks the user liked/added)

Return ONE JSON object — no prose — with this exact shape:
{
  "recipe": "<name from REGISTRY>",
  "params": { ... },
  "notes": "one short sentence on why"
}

Constraints:
* Only change numeric params. Do not invent new param names.
* Changes should be modest — the orchestrator clamps to ±20% per night.
* If outcome volume is too low to draw a conclusion, return the active
  config unchanged with notes='insufficient signal'.
"""


def call_claude(
    *,
    active_recipe: str,
    active_params: dict,
    stats: OutcomeStats,
    registry: list[str],
) -> dict | None:
    api_key = CONFIG.anthropic_api_key
    if not api_key:
        log.warning("ANTHROPIC_API_KEY not set; skipping optimizer")
        return None

    client = anthropic.Anthropic(api_key=api_key)
    user_block = json.dumps(
        {
            "active_recipe": active_recipe,
            "active_params": active_params,
            "registry": registry,
            "stats_24h": {
                "total_recs": stats.total_recs,
                "by_outcome": stats.by_outcome,
                "worst_offenders": stats.worst_offenders,
                "pleasant_surprises": stats.pleasant_surprises,
            },
        },
        indent=2,
    )
    try:
        msg = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=CONFIG.optimizer_max_tokens,
            temperature=0.2,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_block}],
        )
    except anthropic.APIError as e:
        log.warning("optimizer: claude request failed; skipping optimizer: %s", e)
        return None
    raw = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.error("optimizer: claude returned non-JSON: %r", raw[:400])
        return None
    return parsed


# =========================================================================
# Clamp + eval
# =========================================================================


def clamp_patch(active: dict, proposed: dict, *, drift: float) -> dict:
    """Numeric params clamped to [active*(1-drift), active*(1+drift)]."""
    out: dict[str, Any] = dict(active)
    for k, new in proposed.items():
        if k not in active:
            log.warning("optimizer proposed unknown param %r; ignoring", k)
            continue
        cur = active[k]
        if not isinstance(cur, (int, float)) or not isinstance(new, (int, float)):
            log.warning("optimizer proposed non-numeric change for %r; ignoring", k)
            continue
        if cur == 0:
            if new == 0:
                out[k] = 0
                continue
            if isinstance(cur, int):
                out[k] = 1 if new > 0 else -1
                continue
            limit = max(float(drift), MIN_ZERO_BASE_STEP)
            out[k] = max(-limit, min(limit, float(new)))
            continue
        lo, hi = sorted((cur * (1 - drift), cur * (1 + drift)))
        clamped = max(lo, min(hi, float(new)))
        if isinstance(cur, int):
            clamped = round(clamped)
        out[k] = clamped
    return out


def validate_proposal(proposed: Any, active_recipe: str, active_params: dict) -> tuple[str, dict, str] | None:
    if not isinstance(proposed, dict):
        log.warning("optimizer returned %s instead of object; keeping active config", type(proposed).__name__)
        return None

    candidate_recipe = proposed.get("recipe") or active_recipe
    if not isinstance(candidate_recipe, str) or candidate_recipe not in recipes.REGISTRY:
        log.warning("optimizer proposed unknown recipe %r; keeping active config", candidate_recipe)
        return None

    raw_params = proposed.get("params", {})
    if not isinstance(raw_params, dict):
        log.warning("optimizer proposed params as %s; keeping active config", type(raw_params).__name__)
        return None

    defaults = recipes.get(candidate_recipe).DEFAULTS
    numeric_defaults = {
        k: v
        for k, v in defaults.items()
        if isinstance(v, (int, float)) and not isinstance(v, bool)
    }
    if candidate_recipe == active_recipe:
        base_params = {}
        for k in numeric_defaults:
            if isinstance(active_params.get(k), (int, float)) and not isinstance(active_params.get(k), bool):
                base_params[k] = active_params[k]
            else:
                log.warning(
                    "active %s params missing numeric key %r; ignoring proposed change for this run",
                    active_recipe,
                    k,
                )
    else:
        base_params = dict(numeric_defaults)

    clean_params: dict[str, int | float] = {}
    for key, value in raw_params.items():
        if key not in numeric_defaults:
            log.warning("optimizer proposed unknown param %r; ignoring", key)
            continue
        if candidate_recipe == active_recipe and key not in base_params:
            log.warning("optimizer proposed %r but active config lacks it; ignoring", key)
            continue
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            log.warning("optimizer proposed non-numeric value for %r; ignoring", key)
            continue
        clean_params[key] = value

    notes = proposed.get("notes") or ""
    if not isinstance(notes, str):
        notes = ""
    candidate_params = clamp_patch(
        base_params,
        clean_params,
        drift=CONFIG.optimizer_max_drift_pct,
    )
    return candidate_recipe, candidate_params, notes[:200]


def load_holdout() -> list[dict]:
    # Path resolution prefers the operator-supplied env var so the
    # holdout can live on the persistent /data volume that's already
    # mounted into the recommender container — the Dockerfile does NOT
    # COPY eval/ and the deploy script excludes holdout.jsonl by
    # design (the holdout is operator-curated history, not source).
    # Before this env var existed, the optimizer always read from the
    # repo-relative path, which doesn't exist inside the container,
    # so load_holdout() always returned [] and the auto-promotion gate
    # silently degraded to "record candidate as inactive proposal" on
    # every run (see line ~340 below). Falls back to the repo path so
    # local pytest / a hand-run on the dev box still works.
    env_path = os.environ.get("RECOMMENDER_HOLDOUT_PATH")
    if env_path:
        p = Path(env_path)
    else:
        p = Path(__file__).resolve().parent.parent / "eval" / "holdout.jsonl"
    if not p.exists():
        return []
    out: list[dict] = []
    with p.open() as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as e:
                log.warning("holdout %s:%d skipped (invalid JSON): %s", p, lineno, e)
                continue
            # evaluate() reaches into entry["sub"] / entry["kind"] and
            # iterates entry.get("library"|"positives"|"negatives"). A
            # syntactically valid JSON line that's an array, scalar, or
            # dict missing the required keys would crash evaluate()
            # mid-eval — losing every entry after the bad one and
            # leaving the optimizer with a useless score. Validate
            # here so a malformed line is contained to its own row.
            if not isinstance(parsed, dict):
                log.warning(
                    "holdout %s:%d skipped (expected JSON object, got %s)",
                    p,
                    lineno,
                    type(parsed).__name__,
                )
                continue
            if not isinstance(parsed.get("sub"), str) or not parsed["sub"]:
                log.warning("holdout %s:%d skipped (missing/empty sub)", p, lineno)
                continue
            if parsed.get("kind") not in ("movie", "tv"):
                log.warning(
                    "holdout %s:%d skipped (kind not in {movie,tv}: %r)",
                    p,
                    lineno,
                    parsed.get("kind"),
                )
                continue
            # library/positives/negatives must be int arrays. evaluate()
            # passes library through ScoreRequest validation
            # ({"tmdb_id": t} — a non-int t triggers a Pydantic error
            # mid-eval) and collapses positives/negatives into Python
            # sets — a non-hashable element (dict, list) crashes set()
            # with TypeError. A single bad row would take out every
            # remaining holdout entry. Bound the blast radius to the
            # row itself by validating here.
            bad = False
            for field in ("library", "positives", "negatives"):
                value = parsed.get(field, [])
                if not isinstance(value, list):
                    log.warning(
                        "holdout %s:%d skipped (%s must be a list, got %s)",
                        p,
                        lineno,
                        field,
                        type(value).__name__,
                    )
                    bad = True
                    break
                # bool is a subclass of int — reject explicitly so
                # `[True, False]` doesn't sneak through as a "valid"
                # tmdb_id list.
                if any(not isinstance(v, int) or isinstance(v, bool) for v in value):
                    log.warning(
                        "holdout %s:%d skipped (%s must contain only ints)",
                        p,
                        lineno,
                        field,
                    )
                    bad = True
                    break
            if bad:
                continue
            # An entry with zero positives contributes 0/1 = 0 recall
            # and just drags the average down without any learning
            # signal. Skip with a hint so the operator can prune it
            # from the generator output.
            if not parsed.get("positives"):
                log.warning(
                    "holdout %s:%d skipped (positives list is empty — no recall signal)",
                    p,
                    lineno,
                )
                continue
            out.append(parsed)
    return out


def _evaluate_entries(
    conn: sqlite3.Connection,
    recipe_name: str,
    params: dict,
    holdout: list[dict],
) -> dict[int, float]:
    """Run candidate config against the holdout and return entry-indexed scores.

    Each holdout entry is:
      { "sub": str, "kind": "movie"|"tv", "library": [tmdb_id, ...],
        "positives": [tmdb_id, ...], "negatives": [tmdb_id, ...] }

    Score = recall@N(positives) − 0.5 × false-positive-rate(negatives).
    """
    scores: dict[int, float] = {}
    for index, entry in enumerate(holdout):
        try:
            req = ScoreRequest(
                sub=entry["sub"],
                kind=entry["kind"],
                n=20,
                exclude_recently_shown=False,
                library=[{"tmdb_id": t} for t in entry.get("library", [])],
                feedback=[],
                household_rejections=[],
            )
            # persist_library=False is load-bearing here: eval reads the
            # same DB as production and must not write holdout tmdb_ids into
            # the live library_items table.
            ctx = load_user_context(conn, req, persist_library=False)
            _, selected_recipe, selected_params = select_model_config_for_context(
                conn,
                ctx,
                model_config=("eval", recipe_name, params),
            )
            recipe_mod = recipes.get(selected_recipe)
            result = recipe_mod.score(ctx, conn, n=20, params=selected_params)
            picks = {it.tmdb_id for it in result.items}
            positives = set(entry.get("positives") or [])
            negatives = set(entry.get("negatives") or [])
            recall = len(picks & positives) / max(len(positives), 1)
            fp = len(picks & negatives) / max(len(negatives), 1)
            scores[index] = recall - 0.5 * fp
        except Exception:
            log.exception(
                "optimizer: holdout entry skipped during eval sub=%r kind=%r",
                entry.get("sub"),
                entry.get("kind"),
            )
    return scores


def evaluate(conn: sqlite3.Connection, recipe_name: str, params: dict, holdout: list[dict]) -> float:
    """Run candidate config against the holdout and return a 0..1 score."""
    if not holdout:
        return 0.0
    scores = _evaluate_entries(conn, recipe_name, params, holdout)
    if len(scores) != len(holdout):
        return float("-inf")
    return sum(scores.values()) / len(scores)


def evaluate_pair(
    conn: sqlite3.Connection,
    baseline_recipe: str,
    baseline_params: dict,
    candidate_recipe: str,
    candidate_params: dict,
    holdout: list[dict],
) -> tuple[float, float, bool]:
    baseline_scores = _evaluate_entries(conn, baseline_recipe, baseline_params, holdout)
    candidate_scores = _evaluate_entries(conn, candidate_recipe, candidate_params, holdout)
    shared_indices = sorted(set(baseline_scores) & set(candidate_scores))
    if not shared_indices:
        log.warning("optimizer: no shared successful holdout entries; refusing promotion")
        return 0.0, 0.0, False
    failures = len(holdout) - len(shared_indices)
    failure_rate = failures / len(holdout)
    ok_to_promote = failure_rate <= 0.10
    if not ok_to_promote:
        failed_indices = sorted(set(range(len(holdout))) - set(shared_indices))
        log.warning(
            "optimizer: %d/%d holdout entries failed evaluation (%.1f%%); refusing promotion; failed_indices=%s",
            failures,
            len(holdout),
            failure_rate * 100,
            failed_indices[:20],
        )
    baseline_score = sum(baseline_scores[i] for i in shared_indices) / len(shared_indices)
    candidate_score = sum(candidate_scores[i] for i in shared_indices) / len(shared_indices)
    if len(shared_indices) != len(holdout):
        log.info(
            "optimizer: evaluated %d/%d shared holdout entries",
            len(shared_indices),
            len(holdout),
        )
    return baseline_score, candidate_score, ok_to_promote


# =========================================================================
# Promotion
# =========================================================================


def _prune_inactive_model_configs(conn: sqlite3.Connection) -> None:
    conn.execute(
        """DELETE FROM model_config
           WHERE active = 0
             AND id NOT IN (
               SELECT id FROM model_config
               WHERE active = 0
               ORDER BY id DESC
               LIMIT ?
             )""",
        (MAX_INACTIVE_MODEL_CONFIGS,),
    )


def promote(conn: sqlite3.Connection, *, recipe: str, params: dict, notes: str) -> str:
    new_version = f"v-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    with transaction(conn):
        conn.execute("UPDATE model_config SET active = 0 WHERE active = 1")
        conn.execute(
            """INSERT INTO model_config(version, recipe, params_json, active, created_at, notes)
               VALUES (?, ?, ?, 1, datetime('now'), ?)""",
            (new_version, recipe, json.dumps(params), notes),
        )
        _prune_inactive_model_configs(conn)
    active = conn.execute(
        "SELECT version FROM model_config WHERE active = 1"
    ).fetchall()
    if len(active) != 1 or active[0]["version"] != new_version:
        raise RuntimeError("model_config promotion left an invalid active model state")
    return new_version


# =========================================================================
# Entry point
# =========================================================================


def run(*, dry_run: bool = False) -> int:
    conn = connect()
    try:
        # Active config or default
        active = conn.execute(
            "SELECT version, recipe, params_json FROM model_config WHERE active = 1 LIMIT 1"
        ).fetchone()
        if active:
            active_version = active["version"]
            active_recipe = active["recipe"]
            active_params = json.loads(active["params_json"])
        else:
            active_version = "v0"
            active_recipe = CONFIG.default_recipe
            # Materialize the recipe defaults from the module
            active_params = dict(recipes.get(active_recipe).DEFAULTS)
            if dry_run:
                log.info("using unpersisted %s defaults for dry-run", active_recipe)
            else:
                promote(conn, recipe=active_recipe, params=active_params, notes="initial defaults")
                log.info("seeded initial model_config from %s defaults", active_recipe)

        stats = _aggregate(conn)
        if stats.total_recs < 50:
            log.info("only %d rec_log rows in last 24h — skipping optimizer", stats.total_recs)
            return 0

        proposed = call_claude(
            active_recipe=active_recipe,
            active_params=active_params,
            stats=stats,
            registry=list(recipes.REGISTRY.keys()),
        )
        if proposed is None:
            return 0

        validated = validate_proposal(proposed, active_recipe, active_params)
        if validated is None:
            return 0
        candidate_recipe, candidate_params, notes = validated

        holdout = load_holdout()
        if holdout:
            baseline_score, candidate_score, eval_ok = evaluate_pair(
                conn,
                active_recipe,
                active_params,
                candidate_recipe,
                candidate_params,
                holdout,
            )
        else:
            baseline_score, candidate_score, eval_ok = 0.0, 0.0, True

        log.info(
            "eval baseline=%.4f candidate=%.4f notes=%r",
            baseline_score,
            candidate_score,
            notes,
        )

        same = candidate_recipe == active_recipe and candidate_params == active_params
        improved = eval_ok and candidate_score >= baseline_score + EVAL_EPSILON

        if dry_run:
            log.info("dry-run only — not promoting")
            return 0
        if same:
            log.info("no change proposed; keeping %s", active_version)
            return 0
        if not holdout:
            log.info("no holdout set yet; recording proposal only (active stays %s)", active_version)
            # Insert proposal as inactive row so we can review later.
            with transaction(conn):
                conn.execute(
                    """INSERT INTO model_config(version, recipe, params_json, active, created_at, notes)
                       VALUES (?, ?, ?, 0, datetime('now'), ?)""",
                    (
                        f"proposed-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}",
                        candidate_recipe,
                        json.dumps(candidate_params),
                        f"proposal (no holdout yet): {notes}",
                    ),
                )
                _prune_inactive_model_configs(conn)
            return 0
        if not improved:
            log.info("candidate did not beat baseline; staying on %s", active_version)
            return 0

        new_version = promote(
            conn,
            recipe=candidate_recipe,
            params=candidate_params,
            notes=f"auto-promote score={candidate_score:.4f} vs {baseline_score:.4f}: {notes}",
        )
        log.info("promoted %s -> %s", active_version, new_version)
        return 1
    finally:
        conn.close()


def _cli() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(run(dry_run=args.dry_run))


if __name__ == "__main__":
    _cli()
