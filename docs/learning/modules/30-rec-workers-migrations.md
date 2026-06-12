
# The Recommender's Async Workers & Event-Driven Migrations

## 1. WHAT

The recommender system splits into two parts: a **FastAPI service** that scores recommendations and records user feedback, and **async background workers** that ingest TMDB catalog data and compute embeddings. Events (likes, dislikes, shown items) flow **in from the backend over HTTPS** signed with a shared secret (`RECOMMENDER_EVENT_SECRET`). A SQL **migration system** runs at boot to evolve the schema safely without downtime.

## 2. WHY

**Why workers?** The `/score` endpoint must respond in ~200ms. Fetching 50,000+ TMDB titles and computing 768-d embeddings would block that. Workers run in the background (enqueued in SQLite, processed at their own pace) so the main app stays responsive. Workers also act as circuit-breakers — if TMDB API is down, the recommender still serves cached recommendations.

**Why a shared event secret?** The recommender lives behind the `backend` service inside Docker (no public tunnel). Any container in the network could spoof a request claiming "user liked X." `HMAC-SHA256(event_body, RECOMMENDER_EVENT_SECRET)` passed in the `X-Recommender-Secret` header proves the request came from the backend, which guards the secret in environment variables. The backend also verifies the `sub` (user ID) via `InternalPrincipal` (a verified caller identity) and rejects mismatches in enforce mode.

**Why migrations?** SQLite schemas evolve: new tables, indexes, constraint fixes. A migration system (`schema_migrations` table) tracks which `.sql` files have run, prevents reapplication, detects file edits (checksum verification), and backs up before destructive operations (DROP TABLE). This lets the schema evolve safely across deployments.

## 3. MAP

| Path | Role |
|------|------|
| `/recommender/workers/tmdb_ingest.py:59` | `enumerate_kind()` — paginate TMDB /discover, enqueue (tmdb_id, kind) into `ingest_queue` |
| `/recommender/workers/tmdb_ingest.py:101` | `drain_ingest_queue()` — pull pending rows, call `hydrate_one()` to fetch /movie/{id} + credits/keywords, store in `titles` + related tables |
| `/recommender/workers/optimizer.py` | Rebuild the `model_config` (embeddings + feature vectors) when signaled; uses SQLite `title_features` |
| `/recommender/app/main.py:112` | `require_event_secret()` — FastAPI dependency, validates `X-Recommender-Secret` header via HMAC |
| `/recommender/app/main.py:217` | `@app.post("/events/feedback")` — record like/dislike/reject, link to rec_log (outcome attribution) |
| `/recommender/app/main.py:319` | `@app.post("/events/library/sync")` — bulk replace `library_items` for a kind (movie/tv) |
| `/recommender/app/main.py:354` | `@app.post("/events/shown")` — record trending-fill items in `recently_shown` (no model credit) |
| `/recommender/app/db.py:419` | `migrate()` — load all `.sql` files, check `schema_migrations`, apply new ones |
| `/recommender/migrations/0001_initial.sql` | Create `titles`, `user_feedback`, `rec_log`, `rec_outcomes`, `library_items`, `ingest_queue`, etc. |
| `/recommender/migrations/0008_user_feedback_watched.sql` | Example: add `watched` signal to user_feedback CHECK constraint |

**One event's flow (user likes a movie):**
```
1. Frontend clicks ❤️ on movie.tmdb_id=42, kind='movie'
   → Hono backend receives POST /api/feedback
2. Backend mints a session cookie & computes:
   FeedbackEvent { sub: "plex:user123", kind: "movie", tmdb_id: 42, signal: "like", ... }
3. Backend signs event: hmac_secret = HMAC-SHA256(event_json, RECOMMENDER_EVENT_SECRET)
4. Backend POSTs to http://exchange-recommender:8000/events/feedback
   + Header: X-Recommender-Secret: <hmac_secret>
   + Body: { sub, kind, tmdb_id, signal, ... }
5. Recommender require_event_secret() validates header
   → InternalPrincipal (if enabled) verifies sub matches caller
6. /events/feedback endpoint:
   a. Deletes conflicting signals (dislike, reject) for (sub, kind, tmdb_id)
   b. INSERTs into user_feedback(sub, kind, tmdb_id, signal='like', ts)
   c. Finds most recent rec_log row for (sub, kind, tmdb_id) within 10 min
   d. If found: INSERTs into rec_outcomes(rec_id, outcome='liked', ts)
      → Optimizer will use (recommendation, user_liked_it) as training signal
```

## 4. PREREQUISITES

**Fundamentals first (eli5):**

- **Job queues**: A queue is a table (`ingest_queue` in this case). Workers read rows with `status='pending'`, process them, update `status` to `done`/`failed`. If the process crashes, `status` stays `pending` and another worker picks it up.

- **HMAC signing**: A shared secret between two services proves one sent a message to the other without a third party intercepting it. `HMAC-SHA256("hello", "shared_secret")` produces a fixed-length signature; only someone with the secret can forge it. Browser can't steal it (lives server-side in env vars).

- **SQLite WAL & concurrency**: SQLite's Write-Ahead Logging lets multiple readers run while one writer commits changes. The recommender uses `isolation_level=None` (autocommit) + explicit `transaction()` context managers so reads don't block on a writer.

- **Event attribution**: When a user likes a movie, we want to credit **which recommendation** they liked (was it the #1 pick? #7?). We store every rec in `rec_log(id, sub, kind, tmdb_id, ...)` and link feedback to it via `rec_outcomes(rec_id, outcome)`. This teaches the optimizer "when I showed title X to user Y, they liked it — learn from that."

## 5. GOTCHAS & WAR STORIES

1. **Feedback attribution window is 10 minutes** (`FEEDBACK_ATTRIBUTION_MINUTES` in main.py). If a user closes the browser, comes back in 15 min, and rates a movie, it doesn't link to the original rec. This is intentional — too much time = too much uncertainty. Log warning if no rec_log row is found.

2. **`require_event_secret()` returns `None` on success** — FastAPI dependency quirk. If auth fails, it raises HTTPException(401). The dependency is used as `_auth: None = Depends(require_event_secret)` so the caller doesn't need the value; the exception does the work.

3. **Migrations check file checksums** (`_sha256()`). If you edit a `.sql` file by hand after it's been applied, the boot fails loudly. This prevents schema drift (e.g., a human hand-edited `0001_initial.sql` but the code expects a different schema). Override with `ALLOW_MIGRATION_CHECKSUM_MISMATCH=1` only for repairs.

4. **Destructive migrations require a backup** (see `_check_backup_gate()` in db.py). A migration marked `-- DESTRUCTIVE` that contains `DROP TABLE` will boot-fail unless a recent backup exists. This is a circuit-breaker for data loss.

5. **`shown` events don't go in `rec_log`** — only in `recently_shown`. The backend pads short recommendation lists with trending items. Those trending fills are visible to the user but are **not recommendations**, so crediting a click to them would poison optimizer training. See the `post_shown()` docstring (line 354).

6. **Schema evolution snapshot**: The initial schema (0001) creates 8 tables + 10+ indexes. Later migrations add constraints, indexes, or whole tables. Each `.sql` file must be idempotent (`CREATE TABLE IF NOT EXISTS`) and runnable in isolation (copy-paste the file into `sqlite3` and it should work).

## 6. QUIZ BANK

**Q1: Why does the recommender use a separate event endpoint instead of the backend writing directly to `user_feedback`?**  
**A:** Isolation + observability. The backend uses PostgreSQL; the recommender uses SQLite. They're separate services with separate databases. The event endpoint creates a versioned contract (FeedbackEventRequest schema) so the backend can change its DB without breaking the recommender, and vice versa. Also, event endpoints are audit-loggable (every feedback POST is timestamped in rec_log/rec_outcomes).

**Q2: What happens if the RECOMMENDER_EVENT_SECRET is weak or missing?**  
**A:** Boot-fail. The config loader (app/config.py:_event_secret) requires `len >= 32` chars in production (USE_LOCAL_RECOMMENDER=1). If blank or `< 32` chars, it raises ValueError at startup. This prevents the security misconfiguration of shipping with a placeholder secret.

**Q3: A migration adds a new column to `user_feedback` but doesn't include `PRAGMA foreign_keys=ON` in the file. What happens?**  
**A:** The migrator hoists leading/trailing PRAGMAs outside the transaction (see _split_pragma_statements). If the PRAGMA is in the middle, it's silently ignored during the transaction, but the code detects this and raises RuntimeError. PRAGMAs don't work inside transactions, so they must be at the top/bottom only.

**Q4: The optimizer wants to train on user feedback, but it only sees a subset of `rec_log` rows. Why?**  
**A:** Feedback attribution window (10 minutes). If there's no recent `rec_log` row for (sub, kind, tmdb_id), the feedback is recorded but the optimizer never sees it — it stays in `user_feedback` but doesn't link to a `rec_id` via `rec_outcomes`. This prevents noisy training signals from stale impressions.

**Q5: How does the recommender prevent replay attacks (an attacker resending the same signed feedback JSON multiple times)?**  
**A:** It doesn't — by design. The event endpoint is idempotent: `INSERT … ON CONFLICT … DO UPDATE`. If the same (sub, kind, tmdb_id, signal) arrives twice, the timestamp is updated and the second write is absorbed. This simplifies retry logic (HTTP 5xx → retry without fear of duplicates).

**Q6: A worker crashes mid-ingest after fetching 500 TMDB titles. Will those rows be lost?**  
**A:** No. The worker updates rows in the ingest_queue: `UPDATE … SET status='done'` inside a transaction. If the process crashes before COMMIT, the row stays `status='pending'` and the next worker picks it up. This is the job-queue durability guarantee.

## 7. CODE-READING EXERCISE

**File: `/recommender/app/main.py` lines 217–316 (post_feedback)**

Read and answer:

1. Why does the code delete conflicting signals (line 232–248)? What would happen if a user likes a title they previously disliked?
2. The code maps signals to outcomes (line 277–283). Why are signal names present-tense ("like") but outcome names past-tense ("liked")?
3. Outcome attribution (line 285–315): the code looks for a `rec_log` row within 10 minutes. Why search `ORDER BY ts DESC, id DESC` instead of just the oldest match?
4. If no `rec_log` row is found (line 307), the code logs a warning but still returns `{"ok": True}`. Why not fail the request?
5. The `signal=='shown'` case (line 249–266) never writes to `user_feedback`. Why?

**Guided answers:**

1. A user might dislike a movie, then watch it anyway and love it. Deleting the old dislike and inserting the new like ensures the feedback table has the most recent signal. The constraint `UNIQUE(sub, kind, tmdb_id, signal)` enforces one signal per (sub, kind, tmdb_id); the DELETE is how the code enforces "latest signal wins, older ones lose."

2. Signals describe what the user *did* ("I like this right now"); outcomes are what happened *as a result* ("because I was shown it, I liked it"). The rec_outcomes table stores past-tense outcomes so the optimizer can reason about "what happened after I made a recommendation."

3. The most recent rec_log row is the one most likely to have caused the user's action. If the user clicked three different titles and then rated one of them 10 minutes later, the most recent rec_log is the closest match in time, so it gets credit. `ORDER BY … DESC` finds the most recent.

4. Returning `{"ok": True}` even without a rec_log row is intentional. The feedback is still recorded in `user_feedback` for analytics (what did users like?), even if we can't attribute it to a specific recommendation. Failing the request would lose the feedback entirely.

5. `shown` events are trending fills, not recommendations. Crediting them would teach the optimizer "I showed a trending item and the user interacted with it" — but that's not a recommendation learning signal, it's a popularity signal that the optimizer shouldn't use. `shown` goes only to `recently_shown` (for rotation logic, not training).

---

