"""Dump the schema the untouched Python migrator builds on a fresh exchange.db.

Run from the repo root with the main checkout's recommender venv:

    <main checkout>/recommender/.venv/bin/python \
        crates/recommender/tests/fixtures/gen_schema_golden.py

Writes schema-golden.json beside this file: every sqlite_master row
(type, name, tbl_name, sql) sorted by type then name, and the ledger's
(version, checksum) pairs. crates/recommender/src/db/tests.rs compares a fresh
Rust-migrated DB against it.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

with tempfile.TemporaryDirectory() as tmp:
    db_path = Path(tmp) / "exchange.db"
    os.environ["RECOMMENDER_DB_PATH"] = str(db_path)
    os.environ.pop("NODE_ENV", None)
    sys.path.insert(0, str(REPO / "recommender"))
    from app.db import migrate  # noqa: E402

    migrate(db_path=db_path)
    conn = sqlite3.connect(str(db_path))
    schema = [
        list(r)
        for r in conn.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
        )
    ]
    ledger = [
        list(r)
        for r in conn.execute(
            "SELECT version, checksum FROM schema_migrations ORDER BY version"
        )
    ]
    conn.close()

out = HERE / "schema-golden.json"
out.write_text(json.dumps({"schema": schema, "ledger": ledger}, indent=1) + "\n")
print(f"wrote {out}: {len(schema)} objects, {len(ledger)} migrations")
