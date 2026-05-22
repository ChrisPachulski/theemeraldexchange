# Eval holdout

`holdout.jsonl` — one JSON object per line. The optimizer evaluates
candidate model configs against these examples before promoting.

Each line:

```json
{
  "sub": "plex-user-sub",
  "kind": "movie",
  "library": [603, 27205, 11],
  "positives": [157336, 1726],
  "negatives": [603534]
}
```

* `library` — TMDB ids the user already has (the model treats these as the
  positive centroid).
* `positives` — TMDB ids the user later liked/added/clicked. The scorer
  rewards recall against these.
* `negatives` — ids the user later rejected/disliked. The scorer penalizes
  false positives against these.

This file is gitignored — generate it from a snapshot of `rec_log` +
`rec_outcomes` after a few weeks of usage:

```sql
-- example seed:
.mode json
SELECT
  r.sub,
  r.kind,
  (SELECT json_group_array(tmdb_id) FROM library_items WHERE kind = r.kind) AS library,
  json_group_array(DISTINCT r.tmdb_id) FILTER (
    WHERE o.outcome IN ('liked','added','clicked')
  ) AS positives,
  json_group_array(DISTINCT r.tmdb_id) FILTER (
    WHERE o.outcome IN ('rejected','disliked')
  ) AS negatives
FROM rec_log r
LEFT JOIN rec_outcomes o ON o.rec_id = r.id
WHERE r.ts >= datetime('now', '-30 days')
GROUP BY r.sub, r.kind;
```
