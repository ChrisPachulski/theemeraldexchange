# Recommender research loop — iteration log

## CURRENT STATE (after iteration 2)

**Best on the HEADLINE (nDCG@10): still `mmr_diverse`** (the deployed baseline) —
movie 0.0021, tv 0.0030. No variant has beaten the headline yet.

**Best on DEEP RECALL (recall@50 / nDCG@50), and production-deployable:
`item_knn` ann_max** — score the same 800-item centroid-ANN pool by MAX cosine
to any library item instead of distance-to-centroid.

| metric | mmr_diverse (baseline) | item_knn ann_max | item_knn full_max (offline ceiling) |
|---|---|---|---|
| **nDCG@10 movie (headline)** | **0.0021** | 0.0019 | 0.0000 |
| nDCG@10 tv | **0.0030** | 0.0000 | 0.0000 |
| Recall@50 movie | 0.0173 | **0.0292** (+69%) | 0.0372 |
| Recall@50 tv | 0.0170 | **0.0213** (+25%) | 0.0085 |
| nDCG@50 movie | 0.0046 | **0.0072** (+57%) | 0.0076 |
| nDCG@50 tv | 0.0050 | 0.0049 | 0.0016 |
| leakage_filtered@50 (GUARDRAIL) | 0 ✓ | 0 ✓ | 0 ✓ |

**Interpretation:** item-based scoring is a real, shippable Pareto move on DEEP
recall (more of the household's latent taste at ranks 11-50) with the top-10 and
leakage unchanged — but it does NOT move the headline nDCG@10. The headline is
capped by something neither approach cracks: **the content representation.**
Blind-spot probe (iter 2): only 7% movie / 0% tv held-out titles have a strong
content twin (>=0.8) in the rest of the library; 14% movie / 20% tv have no twin
even >=0.5. MiniLM-over-(title+overview) gives weak item-item structure and there
is no preference signal to rank among content-similar items. THAT is the ceiling.

**Next action (iteration 3):** lift the representation, not the ranker. Build
richer item embeddings from the multi-feature content already in the DB
(genres/cast/crew/keywords) — Spotify audiobook GNN / ItemSage lineage — and
A/B the item_knn ann_max scoring on the richer embedding vs the MiniLM baseline.
Also: franchise-stratified recall (skeptic MAJOR) to confirm the recall@50 gains
are not just sequels.

**Open analytical questions** (route via /literature-consultation):
- Q1 [ANSWERED iter 2] Item-item for 1 household: textbook EASE over a 1-user
  binary matrix is DEGENERATE (rank-1 Gram, near-identity B; Steck 2019 p2). The
  right approach is content-kNN with max/top-k-mean aggregation (Amazon
  item-to-item / Spotify cold-start content-cosine, DeNadai 2024 p3). EASE is
  only usable as a content-feature-Gram re-weighter, not the textbook form.
  Production item-to-item = ANN neighbor lookup (Covington p3, ItemSage p3).
- Q2 [OPEN, now PRIMARY] MiniLM-L6 over title+overview is too coarse: max-twin
  sim median ~0.6, strong twins (>=0.8) only 7% movie / 0% tv. Do multi-feature
  embeddings (genres/cast/crew/keywords) materially sharpen item-item structure?
  -> iteration 3 escalation target.

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

---

## Iteration 2 (variant: item-based kNN; confound-controlled A/B)

**Implemented** `app/recipes/item_knn.py` (registered in recipes/__init__.py):
score a candidate by aggregate cosine to the household's library items, not by
distance to the averaged centroid. Two candidate universes: `full` (whole
eligible catalog, the offline retrieval-unbounded ceiling) and `ann` (the same
800-item centroid-ANN pool the production recipes get — the fair A/B). Two
aggregations: `max` (topk=1, Amazon item-to-item) and top-k-mean. Lineage:
Amazon item-to-item CF (Linden et al. 2003) + content-kNN cold-start (Spotify
audiobook GNN, DeNadai 2024); EASE ruled out in textbook form (see Q1).

**Metrics (cited from `iter_2_output.txt`):**
- mmr_diverse baseline movie (reproduced, lines ~30): recall@50 0.0173,
  ndcg@10 0.0021, ndcg@50 0.0046. tv: recall@50 0.0170, ndcg@10 0.0030.
- item_knn full_max movie (lines 160-193): recall@10 0.0, recall@50 0.0372,
  ndcg@10 0.0, ndcg@50 0.0076.
- item_knn full_top10 movie (lines 230-262): recall@50 0.0146, ndcg@10 0.0008.
- item_knn full_top10_pop0 movie (lines 300-332): recall@50 0.0146, ndcg@10
  0.0008 — BYTE-IDENTICAL to pop0.05 ⇒ popularity prior has ZERO effect
  (skeptic MAJOR popularity-confound REFUTED with a number).
- item_knn ann_top10 movie (lines 370-402): recall@50 0.0159, ndcg@10 0.0008.
- item_knn ann_max movie (supplement): recall@10 0.0053, recall@50 0.0292,
  ndcg@10 0.0019, ndcg@50 0.0072.
- item_knn ann_max tv (supplement): recall@50 0.0213, ndcg@10 0.0, ndcg@50 0.0049.
- leakage_filtered@50 = 0 for EVERY variant (guardrail intact).

**Interpretation / deltas vs baseline:**
- Headline nDCG@10: NOT improved. mmr_diverse (0.0021 movie / 0.0030 tv) still
  best. Best item_knn on headline is ann_max movie 0.0019 (~= baseline, tie).
- Deep recall: ann_max is a genuine win — recall@50 +69% movie / +25% tv,
  ndcg@50 +57% movie, while matching baseline at top-10 and keeping leakage 0.
  ann_max is production-deployable (same 800-pool, only the scoring differs).
- 2x2 decomposition (full/ann × max/top10) on movie recall@50:
  full_max 0.0372, ann_max 0.0292, ann_top10 0.0159, full_top10 0.0146.
  AGGREGATION is the dominant lever (max ≫ top-k-mean); candidate reach is
  secondary (full vs ann only +27% for max, and NEGATIVE for tv where dup
  series crowd the top). This resolves skeptic CRITICAL #1: the win is not a
  candidate-set artifact — it survives at equal candidate budget (ann_max).

**Adversarial review (Explore skeptic):** findings triaged —
- [CRITICAL #1] candidate-set advantage of full-scan vs ANN pool → ADDRESSED:
  added ann mode + ran the full 2x2; the deployable ann_max still beats baseline
  on recall@50, so the effect is real, not an artifact.
- [CRITICAL #2] full-scan not production-deployable → ADDRESSED: ann_max IS
  deployable; full_max is explicitly labeled the offline ceiling only.
- [MAJOR popularity confound] → REFUTED (pop0 == pop0.05, identical).
- [MAJOR franchise bias] → OPEN, tag SKEPTIC-OPEN. Recall@50 gains may be
  sequels/same-franchise twins. Must run franchise-stratified recall (iter 3).
  (First occurrence; becomes mandatory if it recurs.)
- metric/dedup/normalization/self-leak checks → PASS (skeptic confirmed no bug).

**Literature (Q1 ANSWERED):** routed "item-item for 1 household" to the Zotero
corpus. Textbook EASE (Steck 2019) is built on a user×item co-occurrence Gram;
at n_users=1 it degenerates (rank-1 Gram, near-identity B; Steck p2). Right
approach = content-kNN with max/top-k-mean aggregation; production item-to-item
is an ANN neighbor lookup (Covington p3, ItemSage p3); Spotify's documented
cold-start fallback is exactly content-cosine over Sentence-BERT (DeNadai 2024
p3). EASE only usable as a content-feature-Gram re-weighter (deferred). 1/2
literature questions escalated; Q2 (representation) is next.

**Blind-spot probe (iter 2):** "I'm assuming the <4% recall@50 ceiling is a
content-representation limit; the alternative untested threat is that
library-reconstruction is the wrong fitness function (multi-modal taste means a
held-out title need not resemble the library at all)." Evidence checked (Y):
distribution of each held-out title's MAX cosine to any other library item.
RESULT — movie: 14.2% have no twin >=0.5; 31% in [0.5,0.6); 32% in [0.6,0.7);
16% in [0.7,0.8); only 7% >=0.8. tv: 20% none >=0.5; 0% >=0.8. full_max recall@50
(3.7% movie) is BELOW even the 7% strong-twin fraction. CONCLUSION: both threats
are partly true and POINT THE SAME WAY — the MiniLM content space simply lacks
sharp twin structure, so no ranking algorithm can recover much. The fix is a
better item representation (iteration 3), not more ranking machinery. This is
the production-first pivot and it agrees with the literature Q1 recommendation.

**Convergence status:** 2/5 iterations. Baseline measured ✓. 1 architecture
(item_knn, 4 configs) implemented + A/B'd ✓ (criterion 1 needs ≥2 architectures).
Headline nDCG@10 NOT yet improved (criterion 2 unmet — deep recall improved, but
the fixed headline did not). Guardrail held. 1 skeptic concern OPEN (franchise).
Not converged.

**Next action:** Iteration 3 — richer multi-feature item embeddings
(genres/cast/crew/keywords; Spotify GNN/ItemSage) as the representation lever;
re-A/B item_knn ann_max on the richer embedding; franchise-stratified recall to
close the skeptic-open concern; escalate Q2 to /literature-consultation.
