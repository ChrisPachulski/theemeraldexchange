# Recommender research loop — iteration log

## CURRENT STATE

**Best measured config:** `mmr_diverse` (the deployed production default).
This is the baseline; no variant beats it yet (none implemented).

| metric | movie | tv |
|---|---|---|
| **nDCG@10 (headline)** | 0.0021 | 0.0030 |
| nDCG@50 | 0.0046 | 0.0050 |
| Recall@10 | 0.0053 | 0.0085 |
| Recall@50 | 0.0173 | 0.0170 |
| leakage_filtered@50 (GUARDRAIL, must be 0) | 0 ✓ | 0 ✓ |
| leakage_unfiltered@50 (diagnostic) | 2/363 (0.6%) | 4/286 (1.4%) |

**Headline interpretation:** the production recommender recalls a held-out
library title into its top-50 only ~1.7% of the time. This is catastrophically
low and is NOT a metric artifact (see Iteration 1 blind-spot probe). Root cause:
the recipe queries the ANN index with a SINGLE positive centroid (mean of all
~750 library embeddings). Averaging a diverse library collapses to a generic
mid-point vector that is near nobody. mmr_diverse > baseline_cosine on every
metric (larger pool 800 vs 500 + MMR re-rank both help marginally).

**Next action (iteration 2):** implement an item-based retrieval/scoring recipe
that scores candidates by their MAX (or top-k mean) similarity to ANY library
item, not the centroid. Traces to Amazon item-to-item CF (Linden et al. 2003,
the canonical deployed system) and EASE (Steck 2019, Zotero corpus). Probe shows
this should be a large lift, not a marginal one.

**Open analytical questions** (route via /literature-consultation, 2+ by iter 3):
- Q1 [OPEN] For single-household, sparse, content-only signal: does the
  production world use item-item max-sim (Amazon), closed-form item-item (EASE),
  or per-item kNN candidate union (YouTube co-watch)? Which fits 1 household best?
- Q2 [OPEN] Is MiniLM-L6 over title+overview too coarse a content embedding?
  max-neighbor sim mean is only ~0.62 and only 7% of movies (0% tv) have a
  near-twin >=0.80 — the content space may cap achievable recall. Do production
  content recommenders (Spotify audiobook GNN, ItemSage) get materially better
  item-item structure from multi-feature embeddings (genres/cast/crew/keywords,
  all present in our DB)?

---

## Iteration 1 (foundational: infrastructure + baseline)

**Execution mode decision:** MODE A (local snapshot). The offline eval needs no
torch/sentence-transformers — every library title is a catalog title that
already has a stored MiniLM embedding in `title_features`. Built a lightweight
venv (`recommender/.venv-eval`: numpy, sqlite-vec, pydantic). Fast (~6-56s per
recipe-kind), no NAS round-trips. Snapshot at
`~/Documents/eex-recsys-lit/snapshot/exchange.db` (1.9 GB, 37,738 titles, all
embedded, dim 384).

**Data sourcing (the real foundation, and two live-sync bugs found):**
- `library_items` table in the recommender DB is EMPTY (0 rows). The Sonarr/
  Radarr library was never synced into the recommender. Sourced directly:
  Sonarr `/tv/api/v3/series` -> 260 series; Radarr `/movies/api/v3/movie` ->
  1,182 movie rows -> 796 unique tmdb ids (≈386 Radarr rows have tmdbId=0 /
  dupes). In-catalog WITH embedding: **753 movie + 235 tv** = the usable
  leave-one-out positive set. Cached to `research/cache/library_{movie,tv}.json`
  (gitignored — household personal data).
- `household_rejections` in the DB has only 10 rows; the backend `rejections.json`
  has the real **852** (464 movie + 388 tv). Sourced the full set; in-catalog
  (could actually surface) = **363 movie + 286 tv** = the leakage set. Cached to
  `research/cache/rejections.json` (gitignored).
- FINDING: both sync gaps are real bugs in the live path. The production
  recommender is scoring against an empty library table for any call that does
  not pass the library inline — i.e., its centroid is built only from the inline
  payload Hono sends, and household_rejections de-dup is near-empty server-side.
  (Backend DOES pass library inline on /score, so prod isn't fully blind, but
  the DB-resident fallback is broken. Flag for the live sync path; out of scope
  for the ranking-quality loop itself.)

**Harness:** `recsys_loop.py` builds a faithful leave-one-out eval over the REAL
production code path (`app.retrieval.retrieve_candidates` + `app.recipes.*.score`).
For each held-out positive t: drop t from `library_ids` (removes it from the
centroid AND un-excludes it from retrieval), rebuild `library_title_keys` minus
t's own keys (else retrieval's title-dedup would drop t and fake a 0), score
top-50, record Recall@{10,50} / nDCG@{10,50}. Leakage measured on the full-
library production call: `_filtered` (rejects anti-joined = production, must be 0)
and `_unfiltered` (rejects not excluded = raw ranker reject-affinity diagnostic).

**Metrics (cited from `iter_1_output.txt`):**
- mmr_diverse movie (lines 37-52): recall@10 0.0053, recall@50 0.0173,
  ndcg@10 0.0021, ndcg@50 0.0046; leak_filtered@50 0; leak_unfiltered@50 2.
- mmr_diverse tv (lines 73-88): recall@10 0.0085, recall@50 0.0170,
  ndcg@10 0.0030, ndcg@50 0.0050; leak_filtered@50 0; leak_unfiltered@50 4.
- baseline_cosine movie (lines 107-122): recall@10 0.0027, recall@50 0.0080,
  ndcg@10 0.0008, ndcg@50 0.0018; leak_filtered@50 0.
- baseline_cosine tv (lines 141-156): recall@10 0.0043, recall@50 0.0128,
  ndcg@10 0.0013, ndcg@50 0.0031; leak_filtered@50 0.
- `recallable_frac = 1.0` for both kinds: every positive has vote_count >= 50,
  so the `min_vote_count` retrieval filter is NOT the cap. Rules out one confound.
- Active model_config (line 13-17): v-20260525-114009-c3fb97, mmr_diverse, params
  match DEFAULTS (pool 800, neg_w 0.3, pop_w 0.05, min_votes 50, tau 0.45,
  lambda 0.7, mmr_input_k 200). Baseline == as-deployed config. Good.

**Blind-spot probe:** "The biggest untested threat is that leave-one-out over a
centroid model is mis-measuring — removing 1 of 753 barely moves the centroid,
so the eval may really be testing 'is each title near the global library
centroid,' a coherence test that is near-zero BY CONSTRUCTION for any multi-modal
library, regardless of model quality. Evidence to check (Y): for each held-out
title, compare cos(t, centroid_of_rest) vs max_j cos(t, library_j)."
RESULT (ran the probe): cos(t,centroid) mean 0.418 movie / 0.421 tv; max-neighbor
mean 0.617 / 0.582. **max-neighbor > centroid for 98.9% of movie / 95.7% of tv**
held-out titles, mean gap +0.199 / +0.161. CONCLUSION: the eval is sound and the
finding is real — the centroid is a genuine architecture bottleneck, and a held-
out title IS meaningfully closer to its nearest library neighbor. Item-based
retrieval is the indicated fix (iteration 2). Caveat surfaced for later: max-
neighbor sim is only ~0.6 and near-twins (>=0.80) are rare (7% movie, 0% tv), so
item-based will lift recall but the MiniLM content space likely caps the ceiling
— multi-feature embeddings become the next lever (Q2 above).

**Adversarial review:** not required at iteration 1 (ralph_prompt starts skeptic
at iteration 2). The blind-spot probe already stress-tested the metric.

**Convergence status:** 1/5 iterations. Baseline measured ✓. 0/2 production-
grounded variants implemented. Headline not yet improved (nothing to beat it).
Not converged.

**Next action:** Iteration 2 — implement `item_knn` recipe (max-sim-to-library
candidate scoring), A/B vs mmr_diverse baseline; escalate Q1 to
/literature-consultation; spawn the first Explore skeptic.
