"""Record HTTP goldens from the untouched FastAPI recommender.

Every scenario starts from a fresh migrated exchange.db plus SEED_SQL, sets
the scenario's config (event secret, internal-principal mode and secret) and
replays its steps through TestClient. Each step records the status, the JSON
body and the household tables afterwards (every column except ts), read with
the DUMP_SQL queries the Rust replay (src/http/goldens.rs) runs as well. A
step without "tables" left them as the previous step (or seed_tables) had them.

The PyO3 binding is needed (sub validation and principal verification run
through it). Build it once, without maturin, and point PYTHONPATH at it:

    cargo rustc -p emerald-contracts-pyo3 --lib -- \
        -C link-arg=-undefined -C link-arg=dynamic_lookup        # macOS
    mkdir -p /tmp/ec && cp target/debug/libemerald_contracts.dylib \
        /tmp/ec/emerald_contracts.abi3.so

Then, from the repo root, with the main checkout's recommender venv:

    PYTHONPATH=/tmp/ec <main checkout>/recommender/.venv/bin/python \
        crates/recommender/tests/fixtures/gen_http_goldens.py

Bearer tokens are described, not stored (they expire after 60 s): a step's
"bearer" is minted by whoever replays it.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

# Low-entropy on purpose: the fixture must not look like a leaked key.
EVENT_SECRET = "e" * 36
PRINCIPAL_SECRET = "p" * 40
OTHER_SECRET = "o" * 40
A = "local:01HABCDEFGHJKMNPQRSTVWXYZ0"
B = "google:12345"

ZERO_VEC = "[" + ",".join(["0.0"] * 384) + "]"


def ago(spec: str) -> str:
    # datetime(ts) truncates to seconds, so no row sits on a window boundary.
    return f"strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', '{spec}')"


SEED_SQL = f"""
INSERT INTO titles(tmdb_id, kind, title, fetched_at) VALUES
  (550, 'movie', 'Fight Club', '2026-01-01'),
  (603, 'movie', 'The Matrix', '2026-01-01'),
  (1399, 'tv', 'Game of Thrones', '2026-01-01');
INSERT INTO title_vec(rowid, kind, embedding) VALUES
  (550, 'movie', '{ZERO_VEC}'),
  (4294968695, 'tv', '{ZERO_VEC}');
INSERT INTO model_config(version, recipe, params_json, active, created_at) VALUES
  ('v-old', 'baseline_cosine', '{{}}', 0, '2026-01-01'),
  ('v-golden', 'mmr_diverse', '{{}}', 1, '2026-01-02');
INSERT INTO rec_log(id, sub, kind, tmdb_id, rank, score, provenance, model_version, ts) VALUES
  (1, '{A}', 'movie', 550, 0, 0.9, 'personalized', 'v-golden', {ago('-2 minutes')}),
  (2, '{A}', 'movie', 550, 3, 0.5, 'discover', 'v-golden', {ago('-5 minutes')}),
  (3, '{A}', 'movie', 603, 1, 0.7, 'personalized', 'v-golden', {ago('-30 minutes')}),
  (4, '{A}', 'tv', 1399, 2, 0.25, 'trending', 'v-old', {ago('-100 days')}),
  (5, '{B}', 'movie', 550, 0, 0.75, 'personalized', 'v-golden', {ago('-1 minutes')}),
  (6, '{A}', 'tv', 1399, 4, 0.125, 'trending', 'v-old', {ago('-100 days')}),
  (7, '{A}', 'movie', 680, 5, 0.375, 'discover', 'v-golden', {ago('-70 hours')}),
  (8, '{A}', 'movie', 13, 6, 0.0625, 'discover', 'v-golden', {ago('-20 days')});
INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES
  (2, 'liked', {ago('-4 minutes')}),
  (5, 'added', {ago('-1 minutes')}),
  (6, 'clicked', {ago('-100 days')}),
  (7, 'clicked', {ago('-40 hours')}),
  (7, 'added', {ago('-40 hours')}),
  (8, 'disliked', {ago('-1 days')});
INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES
  ('{A}', 'movie', 550, 'dislike', {ago('-1 days')}),
  ('{A}', 'movie', 603, 'like', {ago('-1 days')}),
  ('{A}', 'movie', 603, 'clicked', {ago('-1 days')}),
  ('{B}', 'movie', 550, 'like', {ago('-1 days')});
INSERT INTO recently_shown(sub, kind, tmdb_id, ts) VALUES
  ('{A}', 'movie', 550, {ago('-1 days')}),
  ('{A}', 'movie', 777, {ago('-40 days')}),
  ('{B}', 'tv', 1399, {ago('-31 days')});
INSERT INTO household_rejections(kind, tmdb_id, ts) VALUES ('movie', 999, datetime('now'));
"""

DUMP_SQL = {
    t: f"SELECT COALESCE(json_group_array(json_array({cols})), '[]') FROM "
    f"(SELECT {cols} FROM {t} ORDER BY {cols})"
    for t, cols in {
        "user_feedback": "sub, kind, tmdb_id, signal",
        "recently_shown": "sub, kind, tmdb_id",
        "rec_log": "id, sub, kind, tmdb_id, rank, score, provenance, model_version",
        "rec_outcomes": "rec_id, outcome",
        "household_rejections": "kind, tmdb_id",
    }.items()
}

OK = {"x-recommender-secret": EVENT_SECRET}


def post(path, body=None, headers=OK, bearer=None, raw=None, content_type="application/json"):
    step = {"method": "POST", "path": path, "headers": dict(headers)}
    if raw is not None:
        step["raw"] = raw
    elif body is not None:
        step["raw"] = json.dumps(body)
    if content_type is not None and "raw" in step:
        step["headers"]["content-type"] = content_type
    if bearer is not None:
        step["bearer"] = bearer
    return step


def get(path, headers=OK, bearer=None):
    step = {"method": "GET", "path": path, "headers": dict(headers)}
    if bearer is not None:
        step["bearer"] = bearer
    return step


def fb(sub, tmdb_id, signal, kind="movie", **kw):
    return post("/events/feedback", {"sub": sub, "kind": kind, "tmdb_id": tmdb_id, "signal": signal}, **kw)


def imp(tmdb_id, rank=0, score=0.5, provenance="personalized", model_version="v-golden"):
    return {
        "tmdb_id": tmdb_id,
        "rank": rank,
        "score": score,
        "provenance": provenance,
        "model_version": model_version,
    }


def scenario(name, steps, event_secret=True, mode="off", principal_secret=True):
    return {
        "name": name,
        "config": {
            "event_secret": EVENT_SECRET if event_secret else None,
            "mode": mode,
            "principal_secret": PRINCIPAL_SECRET if principal_secret else None,
        },
        "steps": steps,
    }


ENDPOINTS = [
    ("POST", "/events/feedback", {"sub": A, "kind": "movie", "tmdb_id": 1, "signal": "like"}),
    ("POST", "/events/shown", {"sub": A, "kind": "movie", "tmdb_ids": [1]}),
    ("POST", "/events/impressions", {"sub": A, "kind": "movie", "items": [imp(1)]}),
    ("POST", "/events/rejection", {"kind": "movie", "tmdb_id": 1}),
    ("POST", "/events/rejection/clear", {"kind": "movie", "tmdb_id": 999}),
    ("POST", "/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 603}),
    ("GET", "/metrics/funnel", None),
]


def every_endpoint(headers):
    return [
        get(p, headers=headers) if m == "GET" else post(p, body, headers=headers)
        for m, p, body in ENDPOINTS
    ]


SCENARIOS = [
    scenario(
        "health",
        [
            get("/health", headers={}),
            get("/health", headers={"x-recommender-secret": "wrong"}),
            get("/health", headers={"x-recommender-secret": ""}),
            get("/health"),
            get("/health", headers={"X-Recommender-Secret": EVENT_SECRET}),
        ],
    ),
    scenario("health_log_mode", [get("/health")], mode="log"),
    scenario("health_enforce_mode", [get("/health"), get("/health", headers={})], mode="enforce"),
    scenario("health_secret_unset", [get("/health"), get("/health", headers={})], event_secret=False),
    scenario("secret_unset_503", every_endpoint({}) + every_endpoint(OK), event_secret=False),
    scenario(
        "secret_mismatch_401",
        every_endpoint({})
        + every_endpoint({"x-recommender-secret": "wrong"})
        + every_endpoint({"x-recommender-secret": ""})
        + every_endpoint({"x-recommender-secret": EVENT_SECRET + "x"}),
    ),
    scenario(
        "check_order",
        [
            # A body that is not JSON fails before any dependency runs.
            post("/events/feedback", raw="{not json", headers={}),
            post("/events/feedback", raw="{not json"),
            # A schema error waits for the secret gate.
            post("/events/feedback", {"sub": A}, headers={}),
            post("/events/feedback", {"sub": A}, headers={"x-recommender-secret": "nope"}),
        ],
    ),
    scenario(
        "check_order_secret_unset",
        [post("/events/feedback", raw="[1,", headers={}), post("/events/feedback", {}, headers={})],
        event_secret=False,
    ),
    scenario(
        "check_order_enforce",
        [
            post("/events/feedback", {"sub": "bad"}),
            post("/events/feedback", {"sub": "bad"}, bearer="garbage"),
            post("/events/feedback", {"sub": "bad"}, bearer={"sub": A}),
            post("/events/feedback", raw="nope", bearer=None),
        ],
        mode="enforce",
    ),
    scenario(
        "principal_off",
        [
            fb(A, 550, "like", bearer="garbage"),
            fb(A, 603, "dislike", bearer={"sub": B}),
            post("/events/shown", {"sub": A, "kind": "tv", "tmdb_ids": [5]}, bearer={"sub": B}),
        ],
    ),
    scenario(
        "principal_log",
        [
            fb(A, 550, "like"),
            fb(A, 680, "added", bearer={"sub": B}),
            fb(A, 13, "clicked", bearer="garbage"),
            fb(A, 14, "watched", bearer={"sub": B, "expired": True}),
            fb(A, 15, "like", bearer={"sub": B, "kid": "internal-v2"}),
            fb(A, 16, "like", bearer={"sub": B, "secret": OTHER_SECRET}),
            post("/events/shown", {"sub": A, "kind": "movie", "tmdb_ids": [20, 21]}, bearer={"sub": B}),
            post(
                "/events/impressions",
                {"sub": A, "kind": "movie", "items": [imp(30)]},
                bearer={"sub": B},
            ),
            post("/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 680}, bearer={"sub": B}),
            post("/events/feedback", {"sub": A, "kind": "movie", "tmdb_id": 17, "signal": "like"},
                 headers={**OK, "authorization": "Basic dXNlcjpwYXNz"}),
        ],
        mode="log",
    ),
    scenario(
        "principal_log_secret_unset",
        [fb(A, 550, "like", bearer={"sub": B})],
        mode="log",
        principal_secret=False,
    ),
    scenario(
        "principal_enforce",
        [
            fb(A, 550, "like"),
            post("/events/feedback", {"sub": A, "kind": "movie", "tmdb_id": 1, "signal": "like"},
                 headers={**OK, "authorization": "Basic dXNlcjpwYXNz"}),
            post("/events/feedback", {"sub": A, "kind": "movie", "tmdb_id": 1, "signal": "like"},
                 headers={**OK, "authorization": "Bearer"}),
            post("/events/feedback", {"sub": A, "kind": "movie", "tmdb_id": 1, "signal": "like"},
                 headers={**OK, "authorization": "Bearer    "}),
            fb(A, 1, "like", bearer="garbage"),
            fb(A, 1, "like", bearer="not.a.real.jwe.token"),
            fb(A, 1, "like", bearer={"sub": A, "expired": True}),
            fb(A, 1, "like", bearer={"sub": A, "kid": "internal-v2"}),
            fb(A, 1, "like", bearer={"sub": A, "secret": OTHER_SECRET}),
            # Matching sub: accepted.
            fb(A, 550, "like", bearer={"sub": A}),
            # Lower-case scheme and extra whitespace are accepted.
            fb(A, 680, "clicked", bearer={"sub": A, "scheme": "bearer", "pad": "   "}),
            # A body sub that disagrees with the verified principal: 403.
            fb(B, 603, "like", bearer={"sub": A}),
            post("/events/shown", {"sub": B, "kind": "movie", "tmdb_ids": [1]}, bearer={"sub": A}),
            post("/events/impressions", {"sub": B, "kind": "movie", "items": [imp(1)]}, bearer={"sub": A}),
            post("/events/feedback/clear", {"sub": B, "kind": "movie", "tmdb_id": 550}, bearer={"sub": A}),
            # Empty batches answer before the sub check.
            post("/events/shown", {"sub": B, "kind": "movie", "tmdb_ids": []}, bearer={"sub": A}),
            post("/events/impressions", {"sub": B, "kind": "movie"}, bearer={"sub": A}),
            # No sub in the body: any verified principal goes.
            post("/events/rejection", {"kind": "tv", "tmdb_id": 1399}, bearer={"sub": B}),
            post("/events/rejection/clear", {"kind": "movie", "tmdb_id": 999}, bearer={"sub": B}),
            post("/events/rejection", {"kind": "tv", "tmdb_id": 1}),
            get("/metrics/funnel"),
            get("/metrics/funnel", bearer={"sub": A}),
            post("/events/shown", {"sub": A, "kind": "movie", "tmdb_ids": [40]}, bearer={"sub": A}),
            post("/events/impressions", {"sub": A, "kind": "tv", "items": [imp(41)]}, bearer={"sub": A}),
            post("/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 603}, bearer={"sub": A}),
        ],
        mode="enforce",
    ),
    scenario(
        "principal_enforce_secret_unset",
        [fb(A, 550, "like", bearer={"sub": A}), fb(A, 550, "like")],
        mode="enforce",
        principal_secret=False,
    ),
    scenario(
        "feedback_signals",
        [
            fb(A, 555, "like"),
            fb(A, 555, "clicked"),
            fb(A, 555, "added"),
            fb(A, 555, "watched"),
            fb(A, 555, "reject"),
            fb(A, 555, "dislike"),
            fb(A, 555, "like"),
            fb(A, 555, "like"),
            fb(A, 555, "dislike", kind="tv"),
        ],
    ),
    scenario(
        "feedback_attribution",
        [
            # rec 1 is the newest in-window row for (A, movie, 550): the like
            # replaces rec 2's liked outcome.
            fb(A, 550, "like"),
            fb(A, 550, "clicked"),
            fb(A, 550, "watched"),
            fb(A, 550, "dislike"),
            fb(A, 550, "added"),
            fb(A, 550, "reject"),
            # rec 3 is 30 minutes old: no outcome.
            fb(A, 603, "dislike"),
            # rec 5 belongs to B.
            fb(B, 550, "clicked"),
            fb(B, 550, "reject"),
            fb(A, 1399, "like", kind="tv"),
        ],
    ),
    scenario(
        "feedback_clear",
        [
            fb(A, 550, "like"),
            fb(A, 550, "clicked"),
            post("/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 550, "signal": "dislike"}),
            post("/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 550, "signal": "like"}),
            fb(A, 550, "reject"),
            post("/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 550, "signal": None}),
            post("/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 603}),
            post("/events/feedback/clear", {"sub": B, "kind": "movie", "tmdb_id": 550, "signal": "reject"}),
            post("/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 603, "signal": "clicked"}),
            post("/events/feedback/clear", {"sub": A, "kind": "movie", "tmdb_id": 603, "signal": "shown"}),
            post("/events/feedback/clear", {"sub": A, "kind": "show", "tmdb_id": 0}),
        ],
    ),
    scenario(
        "shown",
        [
            post("/events/shown", {"sub": A, "kind": "movie", "tmdb_ids": []}),
            post("/events/shown", {"sub": A, "kind": "movie"}),
            post("/events/shown", {"sub": A, "kind": "movie", "tmdb_ids": [550, 551, 551]}),
            post("/events/shown", {"sub": A, "kind": "tv", "tmdb_ids": list(range(1, 201))}),
            post("/events/shown", {"sub": A, "kind": "tv", "tmdb_ids": list(range(1, 202))}),
            post("/events/shown", {"sub": A, "kind": "tv", "tmdb_ids": [1, 0, -1, "42", 1.0, True, None]}),
            post("/events/shown", {"sub": A, "kind": "tv", "tmdb_ids": None}),
            post("/events/shown", {"sub": A, "kind": "tv", "tmdb_ids": 5}),
            post("/events/shown", {"sub": A, "kind": "tv", "tmdb_ids": "5"}),
        ],
    ),
    scenario(
        "impressions",
        [
            post("/events/impressions", {"sub": A, "kind": "movie", "items": []}),
            post(
                "/events/impressions",
                {
                    "sub": A,
                    "kind": "movie",
                    "items": [
                        imp(550, 0, 0.875),
                        imp(551, 1, 1, "discover"),
                        imp(552, "2", "0.25", "trending", "v-x"),
                        imp(553, 3.0, True),
                        imp(550, 4, -0.5),
                    ],
                },
            ),
            post("/events/impressions", {"sub": A, "kind": "tv", "items": [imp(i, i) for i in range(1, 202)]}),
            post(
                "/events/impressions",
                {
                    "sub": A,
                    "kind": "movie",
                    "items": [
                        imp(0, -1, None, "fill", 5),
                        {"tmdb_id": 1},
                        imp(1, 2.5, "x"),
                        imp(1, True, 0.1),
                        "nope",
                        None,
                    ],
                },
            ),
            post("/events/impressions", {"sub": A, "kind": "movie", "items": {"tmdb_id": 1}}),
            # The 200 cap counts valid items: 201 with one bad is only the
            # item error, 202 with one bad is only too_long.
            post("/events/impressions", {"sub": A, "kind": "tv", "items": [imp(0)] + [imp(i) for i in range(1, 201)]}),
            post("/events/impressions", {"sub": A, "kind": "tv", "items": [imp(0)] + [imp(i) for i in range(1, 202)]}),
            post("/events/shown", {"sub": A, "kind": "tv", "tmdb_ids": [0] + list(range(1, 202))}),
        ],
    ),
    scenario(
        "rejection",
        [
            post("/events/rejection", {"kind": "movie", "tmdb_id": 550}),
            post("/events/rejection", {"kind": "movie", "tmdb_id": 550}),
            post("/events/rejection", {"kind": "movie", "tmdb_id": 999}),
            post("/events/rejection", {"kind": "tv", "tmdb_id": 550, "sub": "garbage"}),
            post("/events/rejection/clear", {"kind": "movie", "tmdb_id": 999}),
            post("/events/rejection/clear", {"kind": "movie", "tmdb_id": 12345}),
            post("/events/rejection", {"kind": "movie", "tmdb_id": 0}),
            post("/events/rejection", {"kind": "movie", "tmdb_id": -1}),
            post("/events/rejection", {"kind": "movie", "tmdb_id": "42"}),
            post("/events/rejection", {"kind": "movie", "tmdb_id": 42.0}),
            post("/events/rejection", {"kind": "movie", "tmdb_id": True}),
            post("/events/rejection", {"kind": "movie", "tmdb_id": None}),
            post("/events/rejection", {"kind": "show", "tmdb_id": 1}),
            post("/events/rejection", {"kind": 1, "tmdb_id": 1}),
            post("/events/rejection/clear", {"kind": "movie"}),
            post("/events/rejection/clear", {}),
        ],
    ),
    scenario(
        "body_shapes",
        [
            post("/events/rejection", raw=""),
            post("/events/rejection", raw="null"),
            post("/events/rejection", raw="[1, 2]"),
            post("/events/rejection", raw='"x"'),
            post("/events/rejection", raw="5"),
            post("/events/rejection", raw='{"kind": "movie", "tmdb_id": 1,}'),
            post("/events/rejection", raw='{"kind": "tv", "tmdb_id": 7}', content_type=None),
            post("/events/rejection", raw='{"kind": "tv", "tmdb_id": 8}', content_type="application/vnd.eex+json"),
            post("/events/rejection", raw='{"kind": "tv", "tmdb_id": 9}', content_type="text/plain"),
            post("/events/rejection", raw='{"kind": "tv", "tmdb_id": 10}', content_type="application/json; charset=utf-8"),
            post("/events/feedback", {}),
            post("/events/feedback", {"sub": 5, "kind": None, "tmdb_id": "x", "signal": "love"}),
        ],
    ),
    scenario(
        "sub_validation",
        [
            fb(s, 1, "like")
            for s in [
                "plex:0",
                "plex:12345",
                "apple:001126.d3c6971f4faa4ccd80027e3654fa404a.1616",
                "workos:user_01E4ZCR3C56J083X43JQXF3JK5",
                "12345",
                "google:abc",
                "plex:007",
                "local:lowercase01HABCDEFGHJKMNPQR",
                "apple:bad-format",
                "",
                "   ",
                "garbage",
                "twitter:1",
            ]
        ]
        + [
            post("/events/shown", {"sub": "garbage", "kind": "movie", "tmdb_ids": []}),
            post("/events/impressions", {"sub": "garbage", "kind": "movie", "items": []}),
            post("/events/feedback/clear", {"sub": "plex:007", "kind": "movie", "tmdb_id": 1}),
        ],
    ),
    scenario(
        "funnel",
        [
            get("/metrics/funnel"),
            get("/metrics/funnel?window_days=7"),
            get("/metrics/funnel?window_days=1"),
            get("/metrics/funnel?window_days=0"),
            get("/metrics/funnel?window_days=-5"),
            get("/metrics/funnel?window_days=99999"),
            get("/metrics/funnel?window_days=abc"),
            get("/metrics/funnel?window_days="),
            get("/metrics/funnel?window_days=3.0"),
            get("/metrics/funnel?window_days=3.5"),
            get("/metrics/funnel?window_days=%207%20"),
            get("/metrics/funnel?window_days=1_0"),
            get("/metrics/funnel?window_days=%2B2"),
            get("/metrics/funnel?window_days=7&window_days=1"),
            get("/metrics/funnel?other=1"),
        ],
    ),
    scenario(
        "funnel_after_events",
        [
            fb(A, 550, "like"),
            fb(A, 550, "added"),
            post("/events/impressions", {"sub": A, "kind": "movie", "items": [imp(9, 0), imp(10, 1)]}),
            fb(A, 9, "clicked"),
            get("/metrics/funnel?window_days=30"),
            get("/metrics/funnel?window_days=365"),
        ],
    ),
    scenario(
        "routing",
        [
            get("/nope"),
            get("/events/feedback"),
            post("/health", {}),
        ],
    ),
    scenario("retention_sweep", [{"sweep": True}]),
]


def mint(spec, ec) -> str:
    if isinstance(spec, str):
        return f"Bearer {spec}"
    secret = spec.get("secret", PRINCIPAL_SECRET)
    key = ec.hkdf_internal_principal(secret.encode("utf-8"))
    now = int(time.time())
    claims = {
        "iss": "eex",
        "sub": spec["sub"],
        "role": "user",
        "auth_mode": "local",
        "server_id": "srv-1",
        "device_id": None,
        "req_id": "req-golden",
        "iat": now,
        "exp": now - 300 if spec.get("expired") else now + 60,
    }
    token = ec.internal_principal_encrypt(key, spec.get("kid", "internal-v1"), claims)
    return f"{spec.get('scheme', 'Bearer')}{spec.get('pad', ' ')}{token}{spec.get('pad', '')}"


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "exchange.db"
        os.environ["RECOMMENDER_DB_PATH"] = str(db_path)
        os.environ["RECOMMENDER_HOLDOUT_PATH"] = str(Path(tmp) / "absent-holdout.jsonl")
        os.environ["EEX_REQUIRE_BINDING"] = "1"
        for k in ("NODE_ENV", "RECOMMENDER_EVENT_SECRET", "INTERNAL_PRINCIPAL_SECRET",
                  "RECOMMENDER_INTERNAL_PRINCIPAL_MODE"):
            os.environ.pop(k, None)
        sys.path.insert(0, str(REPO / "recommender"))
        import emerald_contracts as ec  # noqa: E402
        from fastapi.testclient import TestClient  # noqa: E402

        from app import config as config_module  # noqa: E402
        from app import db as db_module  # noqa: E402
        from app import internal_principal as ip_module  # noqa: E402
        from app import main as main_module  # noqa: E402

        assert not (REPO / "recommender/eval/holdout.jsonl").exists()
        base = config_module.CONFIG
        out = []
        seed_tables = None
        for sc in SCENARIOS:
            for suffix in ("", "-wal", "-shm"):
                Path(str(db_path) + suffix).unlink(missing_ok=True)
            db_module.migrate()
            conn = db_module.connect()
            conn.executescript(SEED_SQL)
            conn.close()
            prev = dump(db_module)
            assert seed_tables in (None, prev)
            seed_tables = prev
            c = sc["config"]
            cfg = replace(
                base,
                event_secret=c["event_secret"],
                internal_principal_mode=c["mode"],
                internal_principal_secret=c["principal_secret"],
            )
            for m in (config_module, main_module, ip_module, db_module):
                m.CONFIG = cfg
            ip_module._reset_key_for_tests()
            client = TestClient(main_module.app, raise_server_exceptions=False)
            for step in sc["steps"]:
                if step.get("sweep"):
                    main_module.sweep_retention_once()
                    step["expect"] = {}
                    prev = changed(step["expect"], prev, dump(db_module))
                    continue
                headers = dict(step["headers"])
                if "bearer" in step:
                    headers["authorization"] = mint(step["bearer"], ec)
                r = client.request(
                    step["method"],
                    step["path"],
                    headers=headers,
                    content=step["raw"].encode() if "raw" in step else None,
                )
                text = r.text.replace(str(cfg.db_path), "<DB_PATH>")
                step["expect"] = {
                    "status": r.status_code,
                    "body": json.loads(text) if text else None,
                }
                prev = changed(step["expect"], prev, dump(db_module))
            out.append(sc)
        for m in (config_module, main_module, ip_module, db_module):
            m.CONFIG = base

    golden = {
        "event_secret": EVENT_SECRET,
        "principal_secret": PRINCIPAL_SECRET,
        "seed_sql": SEED_SQL,
        "seed_tables": seed_tables,
        "dump_sql": DUMP_SQL,
        "scenarios": out,
    }
    path = HERE / "http-goldens.json"
    path.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {path}: {len(out)} scenarios, {sum(len(s['steps']) for s in out)} steps")


def changed(expect: dict, prev: dict, now: dict) -> dict:
    """Record the tables only when a step changed them."""
    if now != prev:
        expect["tables"] = now
    return now


def dump(db_module) -> dict:
    conn = db_module.connect()
    try:
        return {t: json.loads(conn.execute(sql).fetchone()[0]) for t, sql in DUMP_SQL.items()}
    finally:
        conn.close()


if __name__ == "__main__":
    main()
