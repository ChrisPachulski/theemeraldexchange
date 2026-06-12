
# Recommender Serving Side — Teaching Dossier

---

## 1. WHAT

The recommender's serving side is a small FastAPI Python service running inside Docker alongside the main Node/Rust backend. Its one job is to answer the question "what should this household watch next?" When the Node backend needs a list of suggestions for a user, it calls `POST /score` on this service. The service looks up that user's library (the titles they have downloaded/added via Radarr/Sonarr), their likes, dislikes, and household vetoes, then computes a similarity score for every candidate title in the catalog. A *score* is a single number — the higher it is, the more the model thinks this household will enjoy that title. The service returns the top N scored titles as a ranked list, each tagged with a provenance label ("personalized", "discover", or "trending") so the UI can distinguish a high-confidence pick from a cold-start guess. Nothing in this service talks to TMDB, Plex, or the internet at request time — it works entirely from pre-ingested data already stored in a local SQLite database.

---

## 2. WHY

**Why local-first (privacy + cost + co-located data):** All user taste signals — likes, dislikes, viewing history, household vetoes — stay on the NAS and never leave. There is no third-party API call per recommendation, so latency is deterministic (no network round-trip), there is no per-request dollar cost, and the data that matters most (what's actually *in* the household's Radarr/Sonarr library) only exists on this machine anyway. Co-location also means the recommender can join the same SQLite database that holds embeddings, cast/crew, and catalog metadata with zero serialization overhead.

**Why the fused recipe — why-chained:** A simple "average all the things the household liked and find nearest neighbors to that average" (the centroid baseline) collapses a diverse library into a mush vector. A family that likes both horror and romantic comedies ends up with a centroid that points at neither. The research loop showed item-based max-sim (take EVERY library item, score each candidate against EVERY library item, keep the best match) is about 5x better in offline nDCG@10. Layering cast/crew IDF overlap on top of content cosine adds another dimension: if you loved *Aliens*, a film with the same director or lead actor that *content* alone would miss rises in rank. The chain is: retrieve a broad pool of nearest-neighbor candidates via ANN, score each candidate against the library using fused similarity, sort, apply hard filters (vetoes, recently-shown), return top N.

---

## 3. MAP

**Key files:**

- `/Users/cujo253/Documents/theemeraldexchange/recommender/app/main.py` — FastAPI app, all HTTP endpoints. The `POST /score` handler is at line 183. The `POST /events/rejection` handler (household veto write) is at line 439.
- `/Users/cujo253/Documents/theemeraldexchange/recommender/app/schemas.py` — Pydantic models. `PositiveStrictInt` defined at line 11 — this is the guard that blocks `tmdb_id=0`. `ScoreRequest` at line 32. `household_rejections` field at line 48.
- `/Users/cujo253/Documents/theemeraldexchange/recommender/app/context.py` — `load_user_context()` at line 215: reads library, likes/dislikes/rejections from DB and builds a `UserContext`. `positive_centroid()` at line 91, `negative_centroid()` at line 101.
- `/Users/cujo253/Documents/theemeraldexchange/recommender/app/retrieval.py` — `retrieve_candidates()` at line 33: sqlite-vec ANN query + anti-join against excluded ids.
- `/Users/cujo253/Documents/theemeraldexchange/recommender/app/recipes/fused.py` — the production recipe. `score()` function at line 173. `_block_bonus()` at line 142 is the cast/crew inverted-index overlap. `_idf_map()` at line 76 builds the IDF weights.

**One /score request walkthrough:**

1. HTTP POST arrives at `main.py:183`. FastAPI validates the JSON body into a `ScoreRequest`. `PositiveStrictInt` on every `tmdb_id` field fires immediately — a zero id causes a 422 before any logic runs.
2. `load_user_context()` (`context.py:215`) runs: loads the household's library ids (from the request body if provided, else from `library_items` table), merges per-user feedback (likes/dislikes) from the recommender's `user_feedback` table, loads household vetoes from `household_rejections` table, loads recently-shown ids. For each set of ids it fetches pre-computed float32 embedding vectors from `title_features`.
3. `select_model_config_for_context()` (`context.py:479`) decides which recipe to run. If the library is too small and there are no likes, it routes to `cold_start_trending` (just popularity order). Otherwise it reads the active recipe name from the `model_config` table — in production that is `fused`.
4. `recipes.get("fused")` returns the `fused` module. `fused.score(ctx, conn, n=20, params={})` is called.
5. Inside `fused.score()`: builds a query vector as `normalize(positive_centroid - 0.3 * negative_centroid)`. Calls `retrieve_candidates()` which issues a sqlite-vec KNN MATCH query against the `title_vec` table (the approximate nearest-neighbor index), over-fetches by 3x, then anti-joins against library+rejected+recently_shown+disliked.
6. For each candidate, computes `(n_cand x n_lib)` content cosine matrix via numpy `@`, then adds IDF-weighted cast overlap and crew overlap matrices from `_block_bonus()`. Takes `max(axis=1)` — each candidate's score is its best match to any single library item.
7. Adds a small popularity bonus, sorts descending, assigns `provenance="personalized"` if fused score >= 0.45 else `"discover"`, returns top N `ScoredItem` objects.
8. `main.py` wraps in `ScoreResponse` with diagnostics and timing, returns JSON.

---

## 4. PREREQUISITES

**Vectors/similarity ELI5:**

A vector is just a list of numbers — imagine a title's "personality fingerprint" as 512 numbers. Two titles with similar genres, themes, and tone end up with similar numbers in similar positions. *Cosine similarity* measures the angle between two of these fingerprint arrows: an angle of 0 degrees (same direction) gives similarity 1.0 (identical taste), 90 degrees gives 0.0 (unrelated), 180 degrees gives -1.0 (opposite). To find "titles like what I've watched", you average together all your library vectors (the centroid), then ask the database "which catalog vectors point in the most similar direction to this centroid?" That sorted list is your recommendations. The subtlety: averaging a diverse library blurs the centroid toward the middle, which is why the fused recipe scores against each library item individually and takes the maximum — it preserves the shape of a diverse library instead of flattening it.

**What you need to know before reading the code:**

- Python dataclasses and type hints (`@dataclass`, `list[int]`, `dict[str, float]`)
- NumPy basics: `np.ndarray`, matrix multiply (`@`), `np.linalg.norm`, `axis=1`
- Pydantic v2: `BaseModel`, `Field`, `field_validator`, what a 422 response means
- FastAPI: `Depends`, `HTTPException`, how route functions map to HTTP endpoints
- SQLite: `SELECT ... WHERE tmdb_id IN (...)`, WAL mode basics
- What "approximate nearest neighbor" (ANN) means: trading a tiny bit of accuracy for a huge speed gain by using a prebuilt index instead of scanning every row

---

## 5. GOTCHAS & WAR STORIES

**The tmdb_id=0 silent TV rec failure:**

Sonarr (the TV automation tool) emits `tmdbId: 0` for shows it hasn't been able to map to TMDB yet. The recommender's `PositiveStrictInt = Annotated[int, Field(strict=True, gt=0)]` (`schemas.py:11`) rejects any field where the value is 0 or negative with a 422. The backend posts the household's TV feedback in a batch to `/score` via the `feedback` field of `ScoreRequest`. When any item in the batch has `tmdb_id=0`, Pydantic raises a 422 for the *entire batch* — the whole TV score call fails. The backend (Node/Hono side) would then silently fall back to the `cold_start_trending` path, which just returns the most popular titles with no personalization. The user would see "trending" recommendations instead of personalized ones with no error visible anywhere. Fix: the backend must filter out `tmdb_id <= 0` entries before posting to `/score`. The guard on the recommender side exists as a second line of defense — a zero id written into the permanent `household_rejections` table would be a veto that can never be removed (there is no title 0).

**Prod recipe is "fused", not "mmr_diverse":**

The `model_config` table in the DB carries the active recipe name. Early development had `mmr_diverse` as the default (it's still in `recipes/mmr_diverse.py`). The optimizer and a manual migration flipped the active row to `fused`. If you are reading `config.py` or the compose env and see `DEFAULT_RECIPE=mmr_diverse`, that value is only the fallback for a cold DB with no `model_config` row — it does NOT mean mmr_diverse is running in production. Always verify which recipe is actually active by querying `SELECT version, recipe FROM model_config WHERE active=1` in the recommender's SQLite DB.

**min_vote_count tuning did nothing — measure the bottleneck first:**

`min_vote_count` filters out catalog titles with fewer than N TMDB votes (default 50). It sounds like a quality lever: raise it to reduce obscure noise. In practice, when recommendations looked wrong, raising this parameter had zero observable effect on output quality because the bottleneck was elsewhere (either centroid averaging collapsing a diverse library, or the cast/crew overlap weights). The right diagnosis: look at the `diag` field in the `/score` response — it tells you `raw` (ANN fetched), `kept` (after anti-join), and `lib` (library items). If `kept` is large and quality is still bad, the problem is the scoring function, not the retrieval filter. Changing a filter parameter when the bottleneck is the scorer is wasted time. Measure first.

---

## 6. QUIZ BANK

**Q1.** A household has 150 movies in their Radarr library and has explicitly liked 3 movies. They open the suggestions strip and the recipe returned is `cold_start_trending` — all trending, zero personalization. What is the most likely cause, and where in the code would you look?

**A1.** `select_model_config_for_context()` in `context.py:479` checks `len(ctx.library_ids) < CONFIG.cold_start_threshold`. If `cold_start_threshold` is set to something above 150, or if the library sync hasn't posted to the recommender yet (so `library_ids` is empty despite 150 titles in Radarr), the function returns `("cold-start", "cold_start_trending", {})`. Check: (a) the `library_items` table in the recommender DB — does it have rows for this household's kind? (b) what is `CONFIG.cold_start_threshold`? Also check that the `/events/library/sync` call is actually succeeding from Hono.

**Q2.** You look at the `diag` field in a `/score` response and see `{"path": "fused", "raw": 2400, "kept": 12, "lib": 80, ...}`. The user is complaining they see the same 12 movies every time. What is likely wrong, and what would you try?

**A2.** `kept: 12` means the ANN fetched 2400 candidates, but 2388 were dropped by the anti-join against library+rejected+recently_shown+disliked. The most common cause is `recently_shown_ids` growing large (30-day retention window) — the user has been shown nearly the entire high-scoring pool already. Also check `rejected_count` in the `user` sub-diag — a large household veto list reduces the pool. To expand the pool: increase `pool_size` (in `model_config.params_json`), or check whether `exclude_recently_shown` was inadvertently left True when calling from a context where you don't want it. Do NOT raise `min_vote_count` — that would shrink the pool further.

**Q3.** You are told "the household hit the dislike button on a title, but it keeps appearing in recommendations." Walk through every place that dislike signal must exist for it to actually suppress the title, starting from the button click.

**A3.** (1) The SPA sends a feedback event to the Node backend. (2) Node calls `POST /events/feedback` on the recommender with `signal="dislike"`. In `main.py:235`, this DELETEs any prior like/clicked/added/watched row for that (sub, kind, tmdb_id), then INSERTs a `dislike` row into `user_feedback`. (3) On the next `/score` call, `load_user_context()` (`context.py:319`) reads `user_feedback` and puts this tmdb_id into `disliked_ids`. (4) In `retrieval.py:47`, `excluded = user.library_ids | user.rejected_ids | user.recently_shown_ids | user.disliked_ids` — the disliked id is anti-joined out of the candidate pool. If it's still appearing: verify the `POST /events/feedback` call is reaching the recommender (check the event secret header), query `SELECT * FROM user_feedback WHERE tmdb_id=X` in the recommender DB, and confirm the `/score` request's `feedback` field either omits this id or explicitly carries the dislike (if Hono passes an authoritative inline feedback list, a missing entry there could override the stored dislike).

**Q4.** The IDF weight for a person who appears in 500 out of 1000 catalog titles is `log((1+1000)/(1+500)) + 1.0`. Compute it (approximately) and explain why a director who has made 500 movies should have a lower weight than one who has made 2.

**A4.** `log(1001/501) + 1.0 ≈ log(1.998) + 1.0 ≈ 0.692 + 1.0 = 1.692`. For a director with 2 films: `log(1001/3) + 1.0 ≈ log(333.7) + 1.0 ≈ 5.81 + 1.0 = 6.81`. The prolific director has IDF ≈ 1.7 vs the rare director's 6.8. The idea: if you share a rarely-credited director with a library item, that is strong evidence of taste alignment. Sharing a director who has made films in every genre is weak evidence — you might share the director by accident. IDF down-weights people who appear everywhere, borrowed directly from text search where common words ("the", "a") carry no meaning.

**Q5.** A new engineer argues: "The centroid is the average of all liked embeddings, so computing `cosine(candidate, centroid)` is equivalent to what the fused recipe does." Explain specifically why this is wrong using a concrete example.

**A5.** It is NOT equivalent. Consider a household with two liked movies: a horror film with embedding `[1, 0]` and a rom-com with embedding `[0, 1]`. The centroid is `[0.5, 0.5]` (normalized: `[0.707, 0.707]`). A candidate psychological thriller at `[0.9, 0.1]` has cosine with centroid ≈ 0.707. But max-sim to an item gives it `cosine([0.9, 0.1], [1, 0])` ≈ 0.9 — a much higher score, correctly identifying it as strongly related to the horror film specifically. The centroid recipe would rank a mediocre generalist film at `[0.6, 0.6]` equally to the thriller, because that film is equidistant from the blurred centroid. Max-item-sim rewards being very similar to any one thing the household loves, which is what "you'll like this because it's similar to X" means.

---

## 7. CODE-READING EXERCISE

**Guided walk: trace one score call through `fused.py`**

Open `/Users/cujo253/Documents/theemeraldexchange/recommender/app/recipes/fused.py`.

**Step 1 — Entry point (line 173):**
Read the `score(ctx, conn, *, n, params)` signature. Notice `ctx` is a `UserContext` — all user data is already loaded before this function is called. The recipe is pure: it only reads from `ctx` and `conn`, never writes.

**Step 2 — Cold-start branch (lines 185-196):**
`ctx.positive_centroid()` returns `None` when neither `library_embeddings` nor `liked_embeddings` exist (the user is brand new). If so, the recipe skips all the math and returns the `cold_start_pool` result. Ask yourself: why does returning a `RecipeResult` with `path="cold_start"` here still satisfy the caller? Answer: the caller in `main.py` just unpacks `result.items` — it doesn't care which branch ran.

**Step 3 — Query vector (line 199):**
```python
query_vec = _normalize(pos - neg_w * neg) if neg is not None else _normalize(pos)
```
The positive centroid points toward liked titles. Subtracting a fraction of the negative centroid (default 0.30) steers the query *away* from disliked content. If the user has no dislikes, `neg` is `None` and the query is just the normalized positive centroid.

**Step 4 — Retrieve candidates (line 200):**
`retrieve_candidates()` runs a sqlite-vec ANN query. It returns a `CandidateBatch` where each `Candidate` carries a `TitleRow` (metadata) and its pre-stored embedding vector. The ANN query over-fetches (`pool_size * 3`) because the subsequent anti-join will drop titles already in the library, vetoed, or recently seen.

**Step 5 — Content similarity matrix (line 218):**
```python
content = cand_norm @ lib_norm.T  # (n_cand, n_lib) cosine
```
This is matrix multiply. `cand_norm` is shape `(N_candidates, 512)`. `lib_norm.T` is shape `(512, N_library)`. Result is `(N_candidates, N_library)` — one cosine similarity per candidate-library pair. Study this line until it clicks; this is the core of item-based collaborative filtering in one numpy expression.

**Step 6 — Cast/crew bonus (lines 221-230):**
`_block_bonus()` (line 142) computes the same candidate-vs-library matrix but for cast and crew overlap instead of content. It uses a sparse inverted index (person_id to list of library titles containing them), so it only touches cells where the candidate and library item share a person. The result is added to `fused` with weights `w_cast=0.7` and `w_crew=0.5`.

**Step 7 — Max-sim collapse (line 232):**
```python
fused_score = fused.max(axis=1)
```
`fused` is still `(n_cand, n_lib)`. `max(axis=1)` collapses it to shape `(n_cand,)` — each candidate's score is the maximum fused similarity across ALL library items. This is the key difference from centroid: instead of scoring against the average, you score against the best match.

**Step 8 — Provenance assignment (lines 244-246):**
```python
provenance = "personalized" if fsim >= tau else "discover"
```
`tau` defaults to 0.45. A candidate that crosses this threshold is confident enough to label "personalized" (the UI shows a stronger recommendation signal). Below threshold it's "discover" — still surfaced but with weaker backing.

**Exercise question:** Change `max(axis=1)` in your head to `mean(axis=1)`. How would scores change for a household with a very diverse library? Would it be better or worse than the current implementation? Answer: mean would approximate the centroid approach, hurting diverse libraries by averaging away the strong individual matches — exactly the problem the research showed.

---

