"""Record optimizer goldens from the untouched Python workers/optimizer.py.

Each scenario rebuilds one fresh migrated exchange.db (the /score golden's
synthetic catalog and household, gen_score_goldens.seed), seeds model_config
rows and a rec_log / rec_outcomes history relative to now, points the
optimizer at a holdout file, and runs optimizer.run() once against a local
fake Anthropic Messages server (ANTHROPIC_BASE_URL; the real API is never
called). The golden keeps, per scenario: run()'s return value, every request
the fake received (path, auth headers, JSON body), the replies it gave, the
evaluate_pair result when one ran, and the model_config rows afterwards. The
Rust replay (src/optimizer/tests.rs) runs optimizer::run over the same seed
against its own copy of the fake and must match all of it; timestamps inside
the prompt are compared as a placeholder (they are relative to now).

The promote / failure-gate / no-improvement holdouts are built here from the
Python recipes' own picks (positives that baseline_cosine finds and a
lambda-0 mmr_diverse does not), so a promotion is earned, not staged.

    <main checkout>/recommender/.venv/bin/python \
        crates/recommender/tests/fixtures/gen_optimizer_goldens.py
"""

from __future__ import annotations

import dataclasses
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(HERE))

from gen_score_goldens import A, B, CATALOG  # noqa: E402

MODEL = "claude-fake-optimizer"
API_KEY = "sk-ant-fake-" + "k" * 24
MAX_TOKENS = 1500

# --------------------------------------------------------------------------
# fake Anthropic
# --------------------------------------------------------------------------

STATE: dict = {"replies": [], "requests": []}


def message(text: str) -> dict:
    return {
        "id": "msg_fake", "type": "message", "role": "assistant", "model": MODEL,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


class Fake(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(n))
        STATE["requests"].append({
            "method": "POST", "path": self.path,
            "x-api-key": self.headers.get("x-api-key"),
            "anthropic-version": self.headers.get("anthropic-version"),
            "body": body,
        })
        status, payload = STATE["replies"].pop(0) if STATE["replies"] else (500, {"error": "no reply queued"})
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):  # quiet
        pass


# --------------------------------------------------------------------------
# seed data
# --------------------------------------------------------------------------

OUTS = ["liked", "added", "clicked", "rejected", "disliked"]


def recs(n_live: int) -> list[dict]:
    """rec_log rows with their outcomes; minutes are 'ago' from now.

    n_live keys carry one in-window non-ignored outcome each; key 1 is then
    superseded by a newer 'ignored', key 0 gains an older 'disliked' on a
    second rec row, key 2 holds two outcomes on one rec row, and there are an
    ignored-only row, an out-of-window outcome and an out-of-window rec.
    So n_live - 1 outcomes count."""
    rows = []
    for i in range(n_live):
        rows.append({
            "sub": A if i % 2 == 0 else B, "kind": "tv" if i % 3 == 0 else "movie", "tmdb_id": 1000 + i,
            "rank": i % 20, "score": round(0.05 + i * 0.0137, 4),
            "provenance": ["personalized", "discover", "trending"][i % 3],
            "rec_min": 60 + i, "outcomes": [[OUTS[i % 5], 30 + i]],
        })
    k0, k1 = rows[0], rows[1]
    rows.append({**k0, "rank": 3, "score": 0.9999, "rec_min": 500, "outcomes": [["disliked", 400]]})
    rows.append({**k1, "rank": 4, "score": 0.0001, "rec_min": 20, "outcomes": [["ignored", 5]]})
    rows[2]["outcomes"] = [["clicked", 50], ["added", 40]]
    rows.append({"sub": A, "kind": "movie", "tmdb_id": 3001, "rank": 0, "score": 0.5, "provenance": "discover",
                 "rec_min": 90, "outcomes": [["ignored", 80]]})
    rows.append({"sub": A, "kind": "movie", "tmdb_id": 3002, "rank": 1, "score": 0.42, "provenance": "discover",
                 "rec_min": 3000, "outcomes": [["liked", 2900]]})
    rows.append({"sub": B, "kind": "tv", "tmdb_id": 3003, "rank": 2, "score": 0.77, "provenance": "trending",
                 "rec_min": 4000, "outcomes": []})
    return rows


def seed_recs(conn, rows: list[dict]) -> None:
    ts = "strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', ?)"
    for r in rows:
        cur = conn.execute(
            f"""INSERT INTO rec_log(sub, kind, tmdb_id, rank, score, provenance, model_version, ts)
                VALUES (?, ?, ?, ?, ?, ?, 'v-golden', {ts})""",
            (r["sub"], r["kind"], r["tmdb_id"], r["rank"], r["score"], r["provenance"], f"-{r['rec_min']} minutes"),
        )
        for outcome, minutes in r["outcomes"]:
            conn.execute(f"INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES (?, ?, {ts})",
                         (cur.lastrowid, outcome, f"-{minutes} minutes"))


BASELINE_DEFAULTS = ('{"pool_size": 500, "negative_weight": 0.3, "popularity_weight": 0.05, '
                     '"min_vote_count": 50, "personalized_threshold": 0.45}')


def inactive(n: int) -> list:
    return [[f"old-{i:02d}", "baseline_cosine", "{}", 0, f"old {i}"] for i in range(n)]


def ids_of(kind: str, cluster: int) -> list[int]:
    return [r["tmdb_id"] for r in CATALOG if r["kind"] == kind and r["cluster"] == cluster]


def holdout_libraries() -> list[tuple[str, str, list[int]]]:
    out = []
    for j in range(30):
        kind = "movie" if j < 22 else "tv"
        pool = ids_of(kind, j % 6)
        off = (j // 6) * 3 % max(len(pool) - 12, 1)
        out.append((A if j % 2 == 0 else B, kind, pool[off:off + 12]))
    return out


TINY = [{"sub": A, "kind": "movie", "library": list(range(1, 13)), "positives": [100], "negatives": []}
        for _ in range(5)]
FAILING = {"sub": A, "kind": "movie", "library": [0, 5, 6], "positives": [7], "negatives": []}


def reply(obj) -> list:
    return [[200, message(obj if isinstance(obj, str) else json.dumps(obj))]]


CLAMP = {"recipe": "baseline_cosine",
         "params": {"pool_size": 900, "negative_weight": 0.1, "min_vote_count": "abc", "foo": 3,
                    "popularity_weight": True, "personalized_threshold": 0.5, "mmr_lambda": 0.5},
         "notes": "tighten the pool " + "x" * 220}
ZERO = {"params": {"popularity_weight": 0.9, "min_vote_count": 30, "negative_weight": -1,
                   "personalized_threshold": 0.5},
        "notes": 7}


def scenarios(good: list[dict]) -> list[dict]:
    mc_base = [["v-golden", "baseline_cosine", BASELINE_DEFAULTS, 1, "golden"]]
    mc_mmr0 = [["v-mmr", "mmr_diverse", '{"mmr_lambda": 0.0, "pool_size": 800, "mmr_input_k": 200}', 1, "golden"]]
    s = lambda name, mc, n_live, replies, holdout="tiny", api_key=True: {  # noqa: E731
        "name": name, "model_config": mc, "recs": n_live, "replies": replies, "holdout": holdout,
        "api_key": api_key}
    return [
        s("skip_low_volume_seeds_defaults", [], 50, []),
        s("no_api_key", mc_base, 60, [], api_key=False),
        s("api_error_retried", mc_base, 60, [[500, {"type": "error"}]] * 3),
        s("non_json_reply", mc_base, 60, reply("I think you should raise pool_size.")),
        s("reply_not_object", mc_base, 60, reply([1, 2])),
        s("unknown_recipe", mc_base, 60, reply({"recipe": "item_knn", "params": {"pool_size": 800}, "notes": "x"})),
        s("cold_start_recipe_rejected", mc_base, 60, reply({"recipe": "cold_start_trending", "params": {}})),
        s("params_not_object", mc_base, 60, reply({"recipe": "baseline_cosine", "params": [1], "notes": "x"})),
        s("same_config", mc_base, 60, reply({"recipe": "baseline_cosine", "params": {}, "notes": "insufficient signal"})),
        s("record_only_clamp_prunes", mc_base + inactive(35), 60, reply(CLAMP)),
        s("clamp_zero_base_missing_key", [["v-z", "baseline_cosine",
          '{"pool_size": 500, "negative_weight": 0.3, "popularity_weight": 0.0, "min_vote_count": 0}', 1, "z"]],
          60, reply(ZERO)),
        s("promote", mc_mmr0 + inactive(31), 60,
          reply({"recipe": "baseline_cosine", "params": {"pool_size": 550}, "notes": "switch to cosine"}),
          good + [FAILING] * 3),
        s("failure_gate_refuses", mc_mmr0, 60,
          reply({"recipe": "baseline_cosine", "params": {"pool_size": 550}, "notes": "switch to cosine"}),
          good + [FAILING] * 4),
        s("no_improvement", mc_base, 60,
          reply({"recipe": "mmr_diverse", "params": {"mmr_lambda": 0.1}, "notes": "diversify"}),
          good),
    ]


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "exchange.db"
        os.environ.update({
            "RECOMMENDER_DB_PATH": str(db_path),
            "ANTHROPIC_API_KEY": API_KEY,
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}",
            "RECOMMENDER_OPTIMIZER_MODEL": MODEL,
            "RECOMMENDER_OPTIMIZER_MAX_TOKENS": str(MAX_TOKENS),
        })
        for k in ("NODE_ENV", "EEX_REQUIRE_BINDING", "RECOMMENDER_COLD_START_THRESHOLD",
                  "RECOMMENDER_DEFAULT_RECIPE", "RECOMMENDER_OPTIMIZER_MAX_DRIFT_PCT", "ANTHROPIC_AUTH_TOKEN"):
            os.environ.pop(k, None)
        sys.path.insert(0, str(REPO / "recommender"))
        from app import db as db_module  # noqa: E402
        from app import recipes  # noqa: E402
        from app.context import load_user_context  # noqa: E402
        from app.schemas import ScoreRequest  # noqa: E402
        from gen_score_goldens import seed  # noqa: E402
        from workers import optimizer  # noqa: E402

        assert optimizer.CLAUDE_MODEL == MODEL
        base_config = optimizer.CONFIG

        def fresh_db():
            for suffix in ("", "-wal", "-shm"):
                Path(str(db_path) + suffix).unlink(missing_ok=True)
            db_module.migrate()
            conn = db_module.connect()
            seed(conn)
            return conn

        # The earned holdout: what baseline_cosine finds and lambda-0 MMR misses.
        conn = fresh_db()
        good = []
        mmr0 = {"mmr_lambda": 0.0, "pool_size": 800, "mmr_input_k": 200}
        for sub, kind, lib in holdout_libraries():
            req = ScoreRequest(sub=sub, kind=kind, n=20, exclude_recently_shown=False,
                               library=[{"tmdb_id": t} for t in lib], feedback=[], household_rejections=[])
            ctx = load_user_context(conn, req, persist_library=False, stored_engagement=False)
            base = [it.tmdb_id for it in recipes.get("baseline_cosine").score(ctx, conn, n=20, params={"pool_size": 550}).items]
            mmr = [it.tmdb_id for it in recipes.get("mmr_diverse").score(ctx, conn, n=20, params=mmr0).items]
            pos = [t for t in base if t not in mmr][:3] or base[:2]
            neg = [t for t in mmr if t not in base][:2]
            good.append({"sub": sub, "kind": kind, "library": lib, "positives": pos, "negatives": neg})
        conn.close()

        captured = {}
        real_pair = optimizer.evaluate_pair

        def capture_pair(*a, **kw):
            res = real_pair(*a, **kw)
            captured["eval"] = list(res)
            return res

        optimizer.evaluate_pair = capture_pair

        out = []
        for sc in scenarios(good):
            conn = fresh_db()
            for version, recipe, params, active, notes in sc["model_config"]:
                conn.execute(
                    "INSERT INTO model_config(version, recipe, params_json, active, created_at, notes) "
                    "VALUES (?, ?, ?, ?, '2026-01-01 00:00:00', ?)",
                    (version, recipe, params, active, notes),
                )
            seed_recs(conn, recs(sc["recs"]))
            conn.close()
            holdout = TINY if sc["holdout"] == "tiny" else sc["holdout"]
            hpath = Path(tmp) / "holdout.jsonl"
            hpath.write_text("".join(json.dumps(r) + "\n" for r in holdout))
            os.environ["RECOMMENDER_HOLDOUT_PATH"] = str(hpath)
            optimizer.CONFIG = base_config if sc["api_key"] else dataclasses.replace(base_config, anthropic_api_key=None)
            STATE["replies"] = [list(r) for r in sc["replies"]]
            STATE["requests"] = []
            captured.clear()
            result = optimizer.run()
            conn = db_module.connect()
            rows = [dict(r) for r in conn.execute(
                "SELECT id, version, recipe, params_json, active, created_at, notes FROM model_config ORDER BY id")]
            conn.close()
            out.append({**sc, "holdout": holdout, "result": result, "requests": STATE["requests"],
                        "eval": captured.get("eval"), "model_config_after": rows})
            print(f"{sc['name']}: result={result} requests={len(STATE['requests'])} "
                  f"eval={captured.get('eval')} rows={len(rows)}")
        server.shutdown()

    golden = {"model": MODEL, "api_key": API_KEY, "max_tokens": MAX_TOKENS,
              "recs": {str(n): recs(n) for n in (50, 60)}, "scenarios": out}
    path = HERE / "optimizer-goldens.json"
    path.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
