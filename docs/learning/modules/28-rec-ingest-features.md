
# Teaching Dossier: Recommender Data Side — Catalog Ingest, Featurization, Vector Storage

---

## 1. WHAT

The recommender needs to know about every movie and TV show it might ever suggest before it can suggest anything. This "catalog ingest" step is a one-time (and periodically refreshed) data-pull from The Movie Database (TMDB), a public API that carries metadata—title, plot summary, genres, keywords, cast, crew—for millions of titles. Once those raw facts are in SQLite, a second step called "featurize" converts them into a compact list of numbers called an *embedding* or *feature vector*: a 384-number fingerprint that captures what a title is about. Those vectors are stored in a special SQLite extension called `sqlite-vec`, which can find the most similar titles to any query vector in milliseconds, treating similarity as geometric proximity in 384-dimensional space. The full pipeline is: `migrate` (prepare the database schema) → `ingest-bootstrap` (pull TMDB catalog, one network call per title) → `featurize` (compute vectors) → database ready for the scoring API.

---

## 2. WHY

**Why precompute features instead of computing them at query time?**

Embedding a title's plot summary through an ML model (the `sentence-transformers/all-MiniLM-L6-v2` model used here) takes real CPU time—tens of milliseconds per title on a CPU, and the catalog has tens of thousands of titles. If the server ran that computation during each user request, a single `/score` call would stall for minutes. Precomputing once and storing the result means scoring is a fast database lookup instead of an ML inference job.

**Why keep a separate `title_features` table AND a `title_vec` virtual table?**

`title_features` is the durable source of truth: it stores the raw vector blob alongside the JSON record of exactly which genres and keywords went into building it. `title_vec` is the searchable index the sqlite-vec extension builds on top. If you ever need to re-index (e.g., because you changed the vector dimensions or the index format), you can rebuild `title_vec` from `title_features` without re-running the expensive TMDB fetches or ML inference.

**Why sqlite-vec instead of a dedicated vector database (Pinecone, Qdrant, Weaviate)?**

A dedicated vector DB is a separate service: it runs as a network process, needs its own container, its own credentials, its own backup strategy, and adds a network round-trip on every query. The recommender already lives beside a SQLite database. sqlite-vec adds nearest-neighbor search as a SQLite extension—same file, same connection, no network hop, no extra ops burden. For a homelab-scale catalog (tens of thousands of titles) the performance of an in-process index is more than sufficient, and the operational simplicity is significant: one file to back up, one connection to manage, no separate service to keep alive.

**Why chain: ingest → featurize, not merge them?**

They depend on different external resources. Ingest is I/O-bound: it hammers the TMDB network API, needs a key, is rate-limited, and can be resumed from the queue. Featurize is CPU/GPU-bound: it loads a ~100 MB ML model and runs matrix multiplications. Keeping them separate means you can re-featurize without re-fetching TMDB, re-fetch TMDB without re-featurizing unchanged titles, and run each step at the right throttle.

---

## 3. MAP

**Key files:**

| File | Lines | Role |
|---|---|---|
| `recommender/Makefile` | all | Pipeline entry points (`migrate`, `ingest-bootstrap`, `featurize`) |
| `recommender/workers/tmdb_client.py` | 1–180 | Thin TMDB v3 HTTP client with rate limiter + retry |
| `recommender/workers/tmdb_ingest.py` | 1–553 | Enumerate TMDB catalog → queue → hydrate → persist |
| `recommender/workers/featurize.py` | 1–196 | Load embeddings, build vectors, write title_features + title_vec |
| `recommender/app/db.py` | 297–313 | `connect()`: loads sqlite-vec extension, sets WAL mode |
| `recommender/app/db.py` | 50–56 | `VEC_TABLE_DDL`: the CREATE VIRTUAL TABLE statement for title_vec |
| `recommender/app/db.py` | 350–405 | `encode_vec_rowid`, `serialize_f32`, `deserialize_f32` |
| `recommender/app/config.py` | 155–162 | `embed_model` and `embed_dim` config (default: MiniLM-L6-v2, 384d) |
| `recommender/app/retrieval.py` | 33–135 | KNN query against title_vec, anti-join excluded ids |
| `recommender/migrations/0001_initial.sql` | 1–100 | Schema: `titles`, `title_genres`, `title_keywords`, `title_cast`, `title_crew`, `title_features` |

**Pipeline walkthrough:**

```
STEP 0: make migrate
  app/db.py:migrate() runs 0001_initial.sql (creates titles, title_features, etc.)
  + creates title_vec VIRTUAL TABLE USING vec0(...)
  sqlite-vec extension must already be loaded on the connection

STEP 1: make ingest-bootstrap
  tmdb_ingest.py:enumerate_kind("movie")
  tmdb_ingest.py:enumerate_kind("tv")
    For each 5-year bucket from 1900 to today:
      GET /discover/movie?vote_count.gte=50&primary_release_date.gte=... (paginated)
      INSERT each (tmdb_id, kind) into ingest_queue with status='pending'
      ON CONFLICT DO NOTHING → resumable; re-running is safe

  tmdb_ingest.py:_hydrate_loop(concurrency=8)
    LOOP: SELECT 64 pending rows from ingest_queue
      For each row (N=8 concurrent async workers):
        GET /movie/{id}?append_to_response=keywords,credits
        _persist_detail(): UPSERT into titles, DELETE+INSERT genres/keywords/cast/crew
        UPDATE ingest_queue SET status='done' WHERE tmdb_id=?

STEP 2: make featurize
  featurize.py:run()
    _load_pending(): SELECT titles LEFT JOIN title_features WHERE never featurized
                      OR title was re-fetched since features were computed
    Load SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')
    For each chunk of 256 titles:
      texts = ["<title> — <overview>", ...]
      text_embs = model.encode(texts, normalize_embeddings=True)  # shape (256, 384)
      For each title in the chunk:
        g_pert = 0.30 * _genre_perturbation(384, genre_ids)   # hashed ±1 noise
        k_pert = 0.15 * _keyword_perturbation(384, keyword_ids)
        vec = L2-normalize(text_emb + g_pert + k_pert)        # 384 float32s
      UPSERT title_features(embedding=blob, feature_json=...)
      DELETE FROM title_vec WHERE rowid=? AND kind=?
      INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, ?, ?)

STEP 3 (at query time): retrieval.py:retrieve_candidates()
  serialize query_vec to bytes
  SELECT rowid, distance FROM title_vec
    WHERE kind=? AND embedding MATCH ? AND k=200
    ORDER BY distance     ← sqlite-vec KNN, cosine distance
  Decode rowids, anti-join excluded ids
  JOIN back to titles + title_features for full metadata
  Return top pool_size candidates
```

---

## 4. PREREQUISITES

**Vectors explained for a beginner (ELI5):**

Imagine you could describe every movie with exactly 384 numbers: number 1 might loosely capture "how dark the tone is," number 2 might capture "how much action there is," and so on. In reality the numbers don't map to human concepts—they're learned by a machine learning model—but the key property holds: movies with *similar plot summaries and themes* end up with *similar sets of numbers*. Two heist thrillers might have vectors like `[0.82, 0.45, -0.21, ...]` and `[0.79, 0.47, -0.19, ...]`, while a romantic comedy gets `[-0.55, 0.12, 0.88, ...]`. The "distance" between two vectors measures how different two titles are.

**Why 384 dimensions?** That's the output size of the `all-MiniLM-L6-v2` sentence transformer. You didn't choose it—it came with the model. Larger models produce more dimensions (768, 1536) with potentially more nuance; smaller models are faster. 384 is a good balance for a homelab.

**Nearest neighbors explained (ELI5):**

"Nearest-neighbor search" is: given your query vector (built from the user's watch history), find the K vectors in the catalog that are geometrically closest to it. sqlite-vec builds an internal index over all the stored vectors so it can answer this query in milliseconds without checking every row. The distance metric used here is **cosine distance**: it measures the angle between two vectors rather than their raw length, so two vectors that point in the same direction are close even if they have different magnitudes. After L2 normalization (which this code applies to every vector), cosine distance and Euclidean distance are equivalent—normalization is why the code calls `normalize_embeddings=True` in the sentence transformer.

**Concept checklist before studying this code:**

- Python `asyncio` and `await`: the ingest worker fires 8 HTTP requests concurrently using `asyncio.Semaphore` and `asyncio.gather`
- SQLite basics: `INSERT OR IGNORE`, `ON CONFLICT DO UPDATE` (upsert), `LEFT JOIN ... WHERE IS NULL` (anti-join)
- NumPy arrays: `np.ndarray`, `np.linalg.norm`, `astype(np.float32)`
- What a Python `struct.pack` blob is: raw bytes that encode a list of floats in binary format (much smaller than JSON)
- What WAL mode is: SQLite's "write-ahead log" journal mode that allows concurrent readers while a writer is active

---

## 5. GOTCHAS AND WAR STORIES

**WAL mode and the `immutable=1` read trick**

The recommender opens every connection with `PRAGMA journal_mode=WAL`. In WAL mode, readers never block writers and writers never block readers—they each see a consistent snapshot. However, when you want to probe the live database from *outside* the container (e.g., `docker exec` a Python one-liner), you need to open it read-only AND tell SQLite not to touch the WAL files. The pattern used in this project is opening with `file:...?mode=ro` (the `readonly=True` path in `db.connect()`). For truly external probes (when you can't load the sqlite-vec extension), you can open with `?immutable=1` in the URI, which skips all locking—but this is unsafe for a live writer. The `mode=ro` URI flag is the safe version.

**Ingest scale: TMDB has ~500k titles meeting the vote_count>=50 filter**

A full bootstrap can take hours. The design is resumable: the `ingest_queue` table persists `status='pending'|'done'|'error'|'skipped'`. Re-running `make ingest-bootstrap` with `--skip-enumerate` hydrates only the remaining pending/error rows. The CONCURRENCY=8 constant is set conservatively to avoid hammering the TMDB API (the client has a token-bucket rate limiter at 40 calls/10s). The `--limit N` flag exists for dev/test runs so you don't wait an hour to test the featurize step.

**The vec rowid encoding collision**

TMDB ids are not unique across `movie` and `tv`—both can have tmdb_id=1399. sqlite-vec's `vec0` extension uses a single `rowid INTEGER PRIMARY KEY` for all rows regardless of the PARTITION KEY, so inserting both would collide. The fix is `encode_vec_rowid`: movie ids are stored as-is (e.g. 1399), TV ids have bit 32 set (e.g. `1399 | (1 << 32) = 4295968695`). TMDB ids fit in ~25 bits in practice, so bit 32 is always free. Forgetting this is a silent bug: the second upsert fails with a primary key violation.

**Stale features: the `fetched_at` vs `computed_at` race**

The nightly `ingest-changes` job can overwrite a title's plot summary in `titles.fetched_at` without touching `title_features`. `_load_pending()` uses `WHERE f.computed_at < t.fetched_at` to detect and re-featurize these stale rows. Without this check, the vector index can silently point at pre-revision content—the recommender learns on stale text.

**DELETE + INSERT instead of upsert in title_vec**

sqlite-vec's `vec0` virtual table does not honor `INSERT OR REPLACE` cleanly when a PARTITION KEY is involved. The featurize worker explicitly DELETEs the row by `(rowid, kind)` and re-INSERTs inside the same transaction. If you try a plain `INSERT OR REPLACE` you may get a duplicate row or an index inconsistency.

**The `MAX_STALLED_NO_PROGRESS_BATCHES` guard**

Early versions of the ingest loop could hot-spin forever when all 8 workers returned `"locked"` (SQLite busy timeout) on every batch. The guard counts consecutive zero-progress batches and aborts after 3, forcing the operator to investigate. Without this, a misconfigured environment (DB on a read-only mount, SQLite busy timeout too short) would let the loop run for hours burning CPU.

---

## 6. QUIZ BANK

**Q1.** After running `make ingest-bootstrap`, you run `make featurize` and it processes 0 titles. Why, and how do you check?

*Answer:* Featurize only processes rows where `title_features.tmdb_id IS NULL OR title_features.computed_at < titles.fetched_at`. If featurize ran already (e.g., from a prior bootstrap), all rows have features newer than their `fetched_at`. To check: `SELECT COUNT(*) FROM titles LEFT JOIN title_features f ON f.kind=titles.kind AND f.tmdb_id=titles.tmdb_id WHERE f.tmdb_id IS NULL` (should be 0). Re-featurizing requires either dropping `title_features` rows or re-ingesting titles so `fetched_at` advances.

**Q2.** A user has watched 20 action movies. The recommender builds a "query vector" by averaging those 20 titles' embeddings and calls `retrieve_candidates()`. Explain in your own words what sqlite-vec does with that query vector and why the result is a list of candidate movies.

*Answer:* sqlite-vec's `MATCH` operator treats the 384-float query vector as a point in 384-dimensional space and finds the K stored title vectors whose cosine distance to that point is smallest. Because similar movies have similar vectors (the text embedding encodes semantic content), the nearest neighbors tend to be thematically similar titles. The result is the top-K most similar titles, which form the candidate pool before re-ranking.

**Q3.** The code applies `_genre_perturbation` and `_keyword_perturbation` and adds them (with weights 0.30 and 0.15) to the text embedding. What problem does this solve, and what would happen if you set both weights to 0?

*Answer:* Two titles with nearly identical plot summaries (e.g., two disaster movies with generic overviews) would get nearly identical text embeddings and be indistinguishable in the vector space—a query for one would always surface the other at equal distance. The perturbations nudge the vectors slightly apart based on genre and keyword IDs, so genres/keywords add a secondary signal. With weights=0, titles in different genres but with similar text would cluster together, degrading recommendation diversity. The weights are small (0.30 and 0.15 vs a unit-norm text embedding) so the text signal dominates.

**Q4.** You add a new title directly to the `titles` table (bypassing ingest) and run `make featurize`. The title appears in `title_features`. Later you run `make featurize` again. Will it re-featurize the title? Why or why not?

*Answer:* No. After the first featurize run, `title_features.computed_at` is set to `now`. On the second run, `_load_pending()` checks `f.computed_at < t.fetched_at`. Because you inserted the title directly (without going through `_persist_detail`, which sets `fetched_at` to `now()`), `fetched_at` was set at insert time. As long as `computed_at` >= `fetched_at`, the row is considered up-to-date and is skipped.

**Q5.** The `ingest_queue` has 500 rows stuck at `status='error'`. What command do you run to retry them, and what safeguard prevents a title that TMDB permanently removed from retrying forever?

*Answer:* `make ingest-bootstrap` with `--retry-errors` (or `--mode retry-errors`). The `--max-attempts` flag (default 8) caps retries: rows where `attempts >= max_attempts` stay at `status='error'` instead of being requeued. A permanently removed title will exhaust its attempts and stop churning.

**Q6.** `retrieve_candidates()` over-fetches by 3x the requested pool size (the `overfetch` variable). Why not just fetch exactly pool_size from sqlite-vec?

*Answer:* The KNN query returns the nearest N rows from `title_vec` by vector distance alone—it knows nothing about the user's library, rejections, or recently-shown titles. After the KNN result comes back, the code anti-joins against `user.library_ids | user.rejected_ids | user.recently_shown_ids | user.disliked_ids`. If you only fetched `pool_size` rows from sqlite-vec, the anti-join could drop many of them and you'd end up with a smaller pool than requested. Over-fetching gives the anti-join room to drop rows while still returning a full pool.

---

## 7. CODE-READING EXERCISE

**Guided walk of `workers/featurize.py`**

Open `recommender/workers/featurize.py` and work through it from top to bottom. For each section, answer the question before reading the next section.

**Section 1 (lines 1–18, module docstring)**

Read the docstring. It describes the vector as "a concatenation of: overview text embedded by sentence-transformers (384d) + multi-hot genre fingerprint + hashed-keyword bag."

*Question:* The docstring says "the text embedding carries most of the signal; the multi-hot pieces are added as a small additive perturbation." What numeric ratio confirms this claim in the actual code? (Hint: look for the weight constants near line 36.)

*Answer:* `GENRE_WEIGHT = 0.30` and `KEYWORD_WEIGHT = 0.15`. The text embedding is a unit-norm vector (magnitude 1.0 after normalization). The genre perturbation adds at most a few ±1 entries scaled by 0.30; the keyword perturbation adds a few scaled by 0.15. So genre contribution is at most ~30% of the text signal and keyword ~15%.

**Section 2 (lines 46–68, `_genre_perturbation` and `_keyword_perturbation`)**

*Question:* Both functions use `hashlib.blake2s` to hash a string like `"g:28"` (genre id 28) into a 4-byte digest, then use that as an RNG seed. Why hash the id first instead of just using the id as the seed directly? What property does hashing preserve that raw ids would break?

*Answer:* Using raw ids as seeds means id 1 and id 2 produce very similar random sequences (seeds 1 and 2 are adjacent). Blake2s maps even adjacent ids to very different digests (avalanche effect), so the resulting perturbation vectors are uncorrelated. Genre id 28 (action) and genre id 27 (horror) should push their title vectors in uncorrelated directions—that's only guaranteed by the hash mixing.

**Section 3 (lines 71–99, `_load_pending`)**

Trace the SQL query mentally:

```sql
FROM titles t
LEFT JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
WHERE f.tmdb_id IS NULL
   OR f.computed_at < t.fetched_at
```

*Question:* `LEFT JOIN ... WHERE f.tmdb_id IS NULL` is a classic SQL pattern. What is it doing in English?

*Answer:* It returns all rows from `titles` that have NO matching row in `title_features`—i.e., titles that have never been featurized. A regular `INNER JOIN` would silently drop those rows. The `LEFT JOIN` keeps them, and `WHERE f.tmdb_id IS NULL` isolates the "no match" case.

**Section 4 (lines 108–184, `run()`)**

Trace the inner loop at lines 141–157:

```python
for row, txt_emb in zip(chunk, text_embs, strict=True):
    genre_ids = _ids_csv(row["genres"])
    keyword_ids = _ids_csv(row["keywords"])
    g_pert = GENRE_WEIGHT * _genre_perturbation(dim, genre_ids)
    k_pert = KEYWORD_WEIGHT * _keyword_perturbation(dim, keyword_ids)
    vec = _normalize(txt_emb + g_pert + k_pert)
    ...
    blob = serialize_f32(vec)
```

*Question:* `serialize_f32` (defined in `app/db.py` line 401) converts a NumPy float32 array into a bytes object. Why store the vector as raw bytes instead of, say, JSON `[0.82, 0.45, ...]`?

*Answer:* A 384-float JSON array is roughly 384 * 6 characters ≈ 2300 bytes. The `struct.pack("384f", ...)` binary encoding is exactly 384 * 4 = 1536 bytes—40% smaller. More importantly, sqlite-vec's MATCH operator requires the query vector as a binary blob in exactly this format; it does not parse JSON. And reading the blob back via `np.frombuffer` is a zero-copy operation—no parsing overhead at query time.

**Section 5 (lines 171–179, the title_vec update)**

```python
conn.executemany(
    "DELETE FROM title_vec WHERE rowid = ? AND kind = ?",
    [(rowid, kind) for rowid, kind, _ in vec_rows],
)
conn.executemany(
    "INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, ?, ?)",
    vec_rows,
)
```

*Question:* Why DELETE then INSERT instead of `INSERT OR REPLACE`? (Hint: the comment on line 171 explains it.)

*Answer:* sqlite-vec's `vec0` virtual table does not cleanly handle `INSERT OR REPLACE` when a PARTITION KEY (`kind`) is involved. The `OR REPLACE` path internally deletes the old row by rowid, but the vec0 shadow tables that store the actual vector data may not get properly cleaned up under the partitioned index. The explicit DELETE+INSERT-in-same-transaction is a workaround for this limitation of the sqlite-vec extension's upsert support.

---

