"""Builds an idempotent SQL import of Plex's intro/credits markers into media-core.

Plex Media Server already detects intros (Chromaprint) and credits for the
library; media-core's media_markers table (Skip Intro / Skip Credits) has a
source='imported' slot for exactly this. Rows are matched by file path: Plex
sees the library at /data/media/X, media-core at /media/X. One intro and one
credits span per title (media-core's key); for credits Plex's pv:final=1
segment wins, else the latest. Existing rows are never replaced, so a manual
edit survives a re-run. Undo: DELETE FROM media_markers WHERE source='imported'.

Run on a Mac (the NAS has no Python):
  1. Export Plex's markers on the NAS (read-only):
     docker exec Plex-Media-Server "/usr/lib/plexmediaserver/Plex SQLite" -readonly -separator "$(printf '\\t')" \\
       "/config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db" \\
       "select t.text, t.time_offset, t.end_time_offset, coalesce(json_extract(t.extra_data, '$.\\"pv:final\\"'), ''), p.file
        from taggings t join media_items m on m.metadata_item_id=t.metadata_item_id
        join media_parts p on p.media_item_id=m.id where t.text in ('intro','credits');" > plex-markers.tsv
  2. Copy media.db (+ media.db-wal) from /mnt/user/appdata/exchange-backend/media-core-db/ next to it.
  3. python3 -I scripts/import-plex-markers.py plex-markers.tsv media.db import-markers.sql
  4. Back up, then apply as media-core's own user with the Plex image's SQLite:
     docker run --rm -i --user 10002:10002 --entrypoint "/usr/lib/plexmediaserver/Plex SQLite" \\
       -v /mnt/user/appdata/exchange-backend/media-core-db:/db plexinc/pms-docker:latest /db/media.db < import-markers.sql
"""
import csv
import math
import sqlite3
import sys
from datetime import datetime, timezone

PLEX_ROOT, CORE_ROOT = "/data/media/", "/media/"


def main(tsv: str, db_path: str, out: str) -> None:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    ids = {}
    for kind, sql in (("episode", "select e.id, f.path from episodes e join media_files f on f.id=e.file_id"),
                      ("movie", "select m.id, f.path from movies m join media_files f on f.id=m.file_id")):
        for media_id, path in db.execute(sql):
            ids[path] = (kind, media_id)

    best = {}
    with open(tsv, newline="") as f:
        for row in csv.reader(f, delimiter="\t"):
            if len(row) != 5 or not row[4].startswith(PLEX_ROOT):
                continue
            marker, start_ms, end_ms, final, path = row
            hit = ids.get(CORE_ROOT + path[len(PLEX_ROOT):])
            if not hit:
                continue
            start, end = int(start_ms) // 1000, math.ceil(int(end_ms) / 1000)
            if start < 0 or end <= start:
                continue
            key, rank = (*hit, marker), (final == "1", start)
            if key not in best or rank > best[key][0]:
                best[key] = (rank, start, end)

    now = datetime.now(timezone.utc).isoformat()
    with open(out, "w") as f:
        f.write("BEGIN;\n")
        for (kind, media_id, marker), (_, start, end) in sorted(best.items()):
            f.write("INSERT INTO media_markers (media_kind, media_id, marker_type, start_secs, end_secs, source, updated_at) "
                    f"VALUES ('{kind}', {media_id}, '{marker}', {start}, {end}, 'imported', '{now}') "
                    "ON CONFLICT(media_kind, media_id, marker_type) DO NOTHING;\n")
        f.write("COMMIT;\n")

    counts = {}
    for kind, _, marker in best:
        counts[f"{kind} {marker}"] = counts.get(f"{kind} {marker}", 0) + 1
    print(counts)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: import-plex-markers.py <plex-markers.tsv> <media.db> <out.sql>")
    main(*sys.argv[1:])
