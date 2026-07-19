"""Verify the shipped recommender image across dependency upgrades.

This gate compares MiniLM output with a synthetic baseline captured from the
previous production image, then exercises the real featurization persistence
path against a temporary database. It is intended to run inside the image that
will be deployed, not in the GitHub runner's host Python environment.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

EXPECTED_TORCH = "2.13.0+cpu"
EXPECTED_SETUPTOOLS = "83.0.0"
EXPECTED_BASELINE_TORCH = "2.12.0+cpu"
EXPECTED_SENTENCE_TRANSFORMERS = "5.5.1"
EXPECTED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EXPECTED_MODEL_REVISION = "c9745ed1d9f207416be6d2e6f8de32d1f16199bf"
EXPECTED_EMBEDDINGS_SHA256 = "c62435ea899eddc1149eff4c49e078e4781381fcabcce472054129e39f48630b"
MAX_ELEMENT_DELTA = 1e-4
NORM_TOLERANCE = 1e-5


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def _load_fixture(path: Path) -> dict[str, Any]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    _require(fixture.get("schema") == 1, "unsupported embedding baseline schema")
    _require(fixture.get("dtype") == "float32-le", "baseline must contain little-endian float32")
    _require(
        fixture.get("baseline_torch") == EXPECTED_BASELINE_TORCH,
        "baseline must remain pinned to the previous production Torch",
    )
    _require(
        fixture.get("baseline_torch") != EXPECTED_TORCH,
        "baseline and candidate Torch versions must differ",
    )
    _require(
        fixture.get("baseline_sentence_transformers") == EXPECTED_SENTENCE_TRANSFORMERS,
        "baseline sentence-transformers version changed",
    )
    _require(fixture.get("model") == EXPECTED_MODEL, "baseline model name changed")
    _require(
        fixture.get("model_revision") == EXPECTED_MODEL_REVISION,
        "baseline model revision changed",
    )
    raw_embeddings = base64.b64decode(fixture["embeddings_base64"], validate=True)
    digest = hashlib.sha256(raw_embeddings).hexdigest()
    _require(
        fixture.get("embeddings_sha256") == EXPECTED_EMBEDDINGS_SHA256,
        "baseline embedding digest changed",
    )
    _require(digest == EXPECTED_EMBEDDINGS_SHA256, "baseline embedding payload changed")
    return fixture


def _embedding_parity(fixture: dict[str, Any]) -> tuple[float, list[list[int]]]:
    model = SentenceTransformer(
        str(fixture["model"]),
        revision=str(fixture["model_revision"]),
    )
    current = model.encode(
        fixture["texts"],
        batch_size=len(fixture["texts"]),
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    ).astype(np.float32)

    expected_shape = tuple(int(value) for value in fixture["shape"])
    _require(current.shape == expected_shape, f"embedding shape {current.shape} != {expected_shape}")

    raw_baseline = base64.b64decode(fixture["embeddings_base64"], validate=True)
    baseline = np.frombuffer(raw_baseline, dtype="<f4").reshape(expected_shape)
    max_delta = float(np.max(np.abs(current - baseline)))
    _require(
        max_delta <= MAX_ELEMENT_DELTA,
        f"maximum embedding element delta {max_delta:.8g} exceeds {MAX_ELEMENT_DELTA}",
    )

    norms = np.linalg.norm(current, axis=1)
    max_norm_error = float(np.max(np.abs(norms - 1.0)))
    _require(
        max_norm_error <= NORM_TOLERANCE,
        f"maximum normalized-embedding error {max_norm_error:.8g} exceeds {NORM_TOLERANCE}",
    )

    similarities = current @ current.T
    np.fill_diagonal(similarities, -np.inf)
    top3 = np.argsort(-similarities, axis=1, kind="stable")[:, :3].tolist()
    _require(
        top3 == fixture["top3_neighbors"],
        f"top-3 neighbor ranking changed: current={top3} baseline={fixture['top3_neighbors']}",
    )
    return max_delta, top3


def _persistence_smoke(fixture: dict[str, Any]) -> tuple[int, int, int, float]:
    # app.config freezes environment settings at import time. Set the temporary
    # database path before importing any application modules.
    with tempfile.TemporaryDirectory(prefix="eex-embedding-gate-") as temp_dir:
        db_path = Path(temp_dir) / "exchange.db"
        os.environ["RECOMMENDER_DB_PATH"] = str(db_path)
        # This verifier is mounted at /ci, so Python resolves the installed app
        # wheel instead of /srv/app. The image must make its migration location
        # explicit so both import roots share one production configuration.
        migrations_dir = Path("/srv/migrations")
        _require(migrations_dir.is_dir(), f"image migrations missing at {migrations_dir}")

        from app.config import CONFIG
        from app.db import connect, deserialize_f32, migrate
        from workers.featurize import run

        _require(
            CONFIG.migrations_dir == migrations_dir,
            f"configured migrations {CONFIG.migrations_dir} != image migrations {migrations_dir}",
        )
        _require(
            CONFIG.embed_model == fixture["model"],
            f"configured model {CONFIG.embed_model!r} != baseline model {fixture['model']!r}",
        )
        _require(
            CONFIG.embed_revision == fixture["model_revision"],
            "configured model revision does not match the baseline",
        )
        applied = migrate(db_path=db_path)
        _require(applied, "fresh image database applied zero SQL migrations")

        conn = connect(db_path=db_path)
        try:
            conn.execute(
                """INSERT INTO titles(
                       tmdb_id, kind, title, overview, fetched_at
                   ) VALUES (?, ?, ?, ?, ?)""",
                (
                    900000001,
                    "movie",
                    "Synthetic Runtime Gate",
                    fixture["texts"][0],
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ),
            )
        finally:
            conn.close()

        processed = run(limit=1)
        _require(processed == 1, f"featurizer processed {processed} rows instead of 1")

        conn = connect(db_path=db_path)
        try:
            feature = conn.execute(
                """SELECT embedding, dim
                   FROM title_features
                   WHERE tmdb_id = ? AND kind = ?""",
                (900000001, "movie"),
            ).fetchone()
            vec_count = int(
                conn.execute(
                    """SELECT COUNT(*)
                       FROM title_vec
                       WHERE rowid = ? AND kind = ?""",
                    (900000001, "movie"),
                ).fetchone()[0]
            )
        finally:
            conn.close()

        _require(feature is not None, "featurizer did not persist title_features")
        _require(vec_count == 1, f"title_vec contains {vec_count} rows instead of 1")
        stored = deserialize_f32(feature["embedding"], int(feature["dim"]))
        _require(stored.size == int(fixture["shape"][1]), "persisted vector has the wrong dimension")
        _require(bool(np.isfinite(stored).all()), "persisted vector contains non-finite values")
        stored_norm = float(np.linalg.norm(stored))
        _require(
            abs(stored_norm - 1.0) <= NORM_TOLERANCE,
            f"persisted vector norm {stored_norm:.8g} is not normalized",
        )
        return len(applied), processed, vec_count, stored_norm


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    args = parser.parse_args()
    fixture = _load_fixture(args.baseline)

    torch_version = importlib.metadata.version("torch")
    setuptools_version = importlib.metadata.version("setuptools")
    sentence_transformers_version = importlib.metadata.version("sentence-transformers")
    _require(torch_version == EXPECTED_TORCH, f"torch {torch_version} != {EXPECTED_TORCH}")
    _require(
        setuptools_version == EXPECTED_SETUPTOOLS,
        f"setuptools {setuptools_version} != {EXPECTED_SETUPTOOLS}",
    )
    _require(
        sentence_transformers_version == EXPECTED_SENTENCE_TRANSFORMERS,
        "installed sentence-transformers does not match the captured baseline",
    )
    _require(torch.version.cuda is None, "CUDA-enabled torch wheel found in CPU-only image")
    _require(getattr(torch.version, "hip", None) is None, "ROCm-enabled torch wheel found")

    max_delta, top3 = _embedding_parity(fixture)
    migration_count, processed, vec_count, stored_norm = _persistence_smoke(fixture)
    print(
        json.dumps(
            {
                "status": "ok",
                "torch": torch_version,
                "setuptools": setuptools_version,
                "sentence_transformers": sentence_transformers_version,
                "baseline_torch": fixture["baseline_torch"],
                "model": fixture["model"],
                "model_revision": fixture["model_revision"],
                "max_element_delta": max_delta,
                "top3_stable": top3 == fixture["top3_neighbors"],
                "migrations_applied": migration_count,
                "rows_featurized": processed,
                "title_vec_rows": vec_count,
                "persisted_norm": stored_norm,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
