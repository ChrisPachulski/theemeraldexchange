from __future__ import annotations

import sys
from contextlib import contextmanager
from types import SimpleNamespace

import numpy as np
import pytest

from app import config as config_module
from workers import featurize

MODEL_REVISION = "c9745ed1d9f207416be6d2e6f8de32d1f16199bf"


def test_default_embedding_model_revision_is_pinned(monkeypatch) -> None:
    monkeypatch.delenv("RECOMMENDER_EMBED_MODEL", raising=False)
    monkeypatch.delenv("RECOMMENDER_EMBED_MODEL_REVISION", raising=False)
    assert config_module.load().embed_revision == MODEL_REVISION


def test_custom_embedding_model_requires_explicit_revision(monkeypatch) -> None:
    monkeypatch.setenv("RECOMMENDER_EMBED_MODEL", "example/custom-model")
    monkeypatch.delenv("RECOMMENDER_EMBED_MODEL_REVISION", raising=False)
    with pytest.raises(ValueError, match="RECOMMENDER_EMBED_MODEL_REVISION"):
        config_module.load()


def test_embedding_model_revision_rejects_mutable_ref(monkeypatch) -> None:
    monkeypatch.setenv("RECOMMENDER_EMBED_MODEL_REVISION", "main")
    with pytest.raises(ValueError, match="full 40-character commit SHA"):
        config_module.load()


def test_featurizer_passes_pinned_model_revision(monkeypatch) -> None:
    constructor: dict[str, str] = {}

    class FakeModel:
        def __init__(self, model_name: str, *, revision: str) -> None:
            constructor.update(model=model_name, revision=revision)

        def encode(self, texts: list[str], **_kwargs) -> np.ndarray:
            vector = np.full(384, 1 / np.sqrt(384), dtype=np.float32)
            return np.stack([vector for _ in texts])

    class FakeConnection:
        def executemany(self, _query: str, _rows: list[tuple]) -> None:
            return None

    @contextmanager
    def fake_transaction(_conn):
        yield

    monkeypatch.setitem(
        sys.modules,
        "sentence_transformers",
        SimpleNamespace(SentenceTransformer=FakeModel),
    )
    monkeypatch.setattr(
        featurize,
        "CONFIG",
        SimpleNamespace(
            embed_model="sentence-transformers/all-MiniLM-L6-v2",
            embed_revision=MODEL_REVISION,
            embed_dim=384,
        ),
    )
    monkeypatch.setattr(featurize, "connect", FakeConnection)
    monkeypatch.setattr(
        featurize,
        "_load_pending",
        lambda _conn, _limit: [
            {
                "tmdb_id": 900000001,
                "kind": "movie",
                "title": "Synthetic Revision Gate",
                "overview": "A fixed synthetic overview.",
                "genres": None,
                "keywords": None,
            }
        ],
    )
    monkeypatch.setattr(featurize, "transaction", fake_transaction)

    assert featurize.run(limit=1) == 1
    assert constructor == {
        "model": "sentence-transformers/all-MiniLM-L6-v2",
        "revision": MODEL_REVISION,
    }
