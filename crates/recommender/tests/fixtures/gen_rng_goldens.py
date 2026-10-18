"""Record numpy Generator draws for src/rng.rs (the ranker's numpy RNG port).

Each case seeds np.random.default_rng(seed) and records, in order on that one
generator, the SeedSequence state, a few raw PCG64 words (from a twin
generator), then integers / choice draws covering both of choice's
no-replacement paths (Floyd's hash set, and the tail shuffle numpy takes when
pop > 10000 and size > pop // 50). Draws share the generator, so the PCG64
half-word carry between 32-bit draws is covered too.

    <main checkout>/recommender/.venv/bin/python \
        crates/recommender/tests/fixtures/gen_rng_goldens.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent

# The ranker's seeds: len(sub) * 7919 + n_pos * 31 + n_neg, and k-means' 0.
SEEDS = [0, 1, 42, 14 * 7919 + 31 * 9 + 3, 2**32 + 5, 2**70 + 123]

# (op, args): integers(0, high, size) | choice(pop, size, replace) |
# choice_array(start, step, n, size) = choice(arange * step + start, size, replace=False)
OPS = [
    ("integers", 1000, 7),
    ("integers", 2, 5),
    ("integers", 1, 3),
    ("choice", 50, 5, True),
    ("choice", 30, 12, False),
    ("choice", 7, 7, False),
    ("choice", 1, 1, False),
    ("choice", 20000, 100, False),   # Floyd: size <= pop // 50
    ("choice", 20000, 1500, False),  # tail shuffle
    ("integers", 3, 1),              # odd count: leaves a half word buffered
    ("choice", 10001, 300, False),   # tail shuffle, just over the threshold
    ("choice", 10000, 300, False),   # Floyd: pop not > 10000
    ("choice_array", 1, 2, 3000, 1500),
    ("choice", 4096, 4000, True),
]


def run(seed: int) -> dict:
    ss = np.random.SeedSequence(seed)
    raw = np.random.PCG64(seed).random_raw(6)
    g = np.random.default_rng(seed)
    draws = []
    for op in OPS:
        if op[0] == "integers":
            out = g.integers(0, op[1], size=op[2])
        elif op[0] == "choice":
            out = g.choice(op[1], op[2], replace=op[3])
        else:
            _, start, step, n, size = op
            out = g.choice(np.arange(n, dtype=np.int64) * step + start, size, replace=False)
        draws.append({"op": list(op), "out": [int(v) for v in out]})
    return {
        "seed": str(seed),
        "state": [str(int(v)) for v in ss.generate_state(4, np.uint64)],
        "raw": [str(int(v)) for v in raw],
        "draws": draws,
    }


def main() -> None:
    golden = {"numpy": np.__version__, "cases": [run(s) for s in SEEDS]}
    path = HERE / "rng-goldens.json"
    path.write_text(json.dumps(golden) + "\n")
    print(f"wrote {path}: numpy {np.__version__}, {len(SEEDS)} seeds x {len(OPS)} draws")


if __name__ == "__main__":
    main()
