# Recommender research loop — iteration log

## CURRENT STATE (after iteration 3)

**FIRST HEADLINE WIN (movies).** Fusing MiniLM with IDF-weighted genre/keyword/
cast/crew features and re-scoring the 800-item MiniLM-ANN pool by max fused-sim
(`fused_balanced`) is the best config on the movie headline:

| movie metric | mmr_diverse (baseline) | item_knn minilm ann_max (iter2) | **fused_balanced (iter3)** | absolute (of 753) |
|---|---|---|---|---|
| **nDCG@10 (headline)** | 0.0021 | 0.0019 | **0.0106** (5.0x) | — |
| Recall@10 | 0.0053 | 0.0053 | **0.0279** (5.3x) | 4 -> 21 titles (+17) |
| Recall@50 | 0.0173 | 0.0292 | **0.0398** (2.3x) | 13 -> 30 titles (+17) |
| nDCG@50 | 0.0046 | 0.0072 | **0.0135** | — |
| leakage_filtered@50 | 0 | 0 | **0** ✓ | — |

`fused_meta_heavy` ties `fused_balanced` within sampling error (nDCG@10 0.0103
vs 0.0106; SE(recall@10)~0.006, CIs overlap) — treat as one result, pick
balanced. **TV: NO win** — fused nDCG@10 0.0015 < baseline 0.0030.

**HONEST scope of the win (devils-advocate + franchise stratification):**
- It is REAL but ABSOLUTELY SMALL: +17 recalled titles out of 753 at recall@10.
  The "5x" is over a basement baseline; report absolute counts alongside.
- It is a RE-RANK-STAGE win, deployable over the EXISTING MiniLM-ANN pool with no
  retrieval change. It is NOT yet a shipped recipe (research/, needs scipy);
  full production deploy needs the fused vectors precomputed into the index.
- The lift is ENTIRELY creator-affinity. Stratified: movie creator_twin (n=669,
  shares >=2 cast or >=1 key-crew with library) recall@10 0.0105; **novel stratum
  (n=84, no shared cast/crew) recall@10 = 0.0**. Legitimate signal (people follow
  actors/directors) but NARROW — zero cross-creator generalization.
- TV flatness EXPLAINED: only 24/235 (10%) of TV titles are creator-twins (vs 89%
  for movies) — series rarely share cast/crew. The mechanism has nothing to work
  with on TV (where twins exist, TV creator_twin recall@10 0.0417 — it works).

**THE NEXT CEILING (literature Q2, grounded):** content/creator similarity has a
documented production recall ceiling (Spotify content-only HR@10 plateaus at
0.164; a GNN over a co-ENGAGEMENT graph lifts HR 36-57%, long-tail +118% by
reaching items sharing no content/creator overlap — DeNadai 2024 p2,p7; PinSage
+150% HR over content-only, Ying 2018 p8). Breaking it needs multi-user
co-occurrence (we have none) OR manufacturing signal. For ONE household the only
levers are: (A) EXPLORATION + implicit-feedback harvesting (Boltzmann-sampled
slate, log propensities, ingest plays/adds/previews as graded positives — BaRT
McInerney 2018; YouTube Top-K REINFORCE Chen 2019), and (B) IMPORT an exogenous
item-item co-engagement graph (MovieLens co-ratings / Wikidata) + GNN propagation
— which is ALSO the documented fix for the TV gap (series share audiences, not
casts). Pure collaborative (LightGCN) is non-viable standalone (He 2020 p2).

**Next action (iteration 4):** (1) confirm fusion stability (re-run, lock the
best config across 2 iterations); (2) run the pending fused mode=full ablation
(retrieval vs ranking for fusion) + a clean cast-vs-crew isolation; (3) BEGIN the
ceiling-break: implement Variant B (exogenous co-engagement graph item-item
propagation) as the production-grounded lever that targets BOTH cross-creator
recall AND the TV gap. Escalate the co-engagement-graph sourcing question to
literature.

**Open analytical questions:**
- Q1 [ANSWERED iter 2] textbook EASE degenerate at n_users=1; content-kNN correct.
- Q2 [ANSWERED iter 3] multi-feature fusion sharpens MOVIE item-item structure
  (5x headline) but only via creator-affinity; content has a hard ceiling — the
  documented fix is co-engagement graph + exploration (see above).
- Q3 [OPEN] What public item-item co-engagement source best maps onto a TMDB-id
  catalog (MovieLens links, Wikidata "shares audience", IMDb "more like this")
  and what is the cold-start GNN recipe (two-tower distill) for single-household
  serving? -> iteration 4 escalation.

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

---

## Iteration 3 (variant: multi-feature fused item representation)

**Implemented** `research/fusion.py`: fuse the MiniLM(title+overview) vector with
IDF-weighted, L2-normalized SPARSE blocks for genre / keyword / top-billed cast
(order_idx<10) / key crew (Director/Writer/Screenplay/Story/Creator). fused_sim =
weighted sum of per-block cosines; item-knn scores a candidate by max fused-sim
to any library item, re-ranking the SAME 800-item MiniLM-ANN pool (deployable
re-rank stage). Lineage: ItemSage multi-feature embedding (Baltescu 2022);
Spotify content cold-start (DeNadai 2024). Kept in research/ (needs scipy; the
production app has no scipy dep) -- a registered recipe + precomputed index
vectors is the promotion follow-up if it holds.

**Metrics (cited from `iter_3_output.txt`):**
- REF mmr_diverse movie (lines 38-41): nDCG@10 0.0021, recall@10 0.0053,
  recall@50 0.0173. tv (109-112): nDCG@10 0.0030.
- REF item_knn minilm ann_max movie (73-76): recall@50 0.0292, nDCG@10 0.0019.
- fused_balanced movie (177-180): recall@10 0.0279, recall@50 0.0398,
  nDCG@10 0.0106, nDCG@50 0.0135. tv (200-203): nDCG@10 0.0015 (< baseline).
- fused_meta_heavy movie (223-226): nDCG@10 0.0103 (ties balanced within SE).
- fused_text_kw movie (266-269): nDCG@10 0.0036 -- text+keywords alone gives
  only ~1.7x; the full 5x needs cast+crew.
- Franchise stratification (supplement): movie creator_twin n=669 recall@10
  0.0105 (SE 0.0039) / recall@50 0.0463; novel n=84 recall@10 0.0 / recall@50
  0.0. tv creator_twin n=24 recall@10 0.0417; novel n=211 recall@10 0.0.
  leakage_filtered@50 = 0 (both kinds, verified in the loop, not by assertion).

**Interpretation / deltas vs baseline:**
- FIRST headline win: fused_balanced movie nDCG@10 0.0106 vs 0.0021 = 5.0x
  relative; absolute recall@10 4 -> 21 titles (+17 of 753). The iteration-2
  hypothesis (representation is the ceiling) is CONFIRMED -- enriching the item
  vector, not the ranker, moved the headline.
- Win is creator-affinity ONLY: novel stratum (no shared cast/crew) recall = 0.
  Legitimate (people follow actors/directors) but narrow; no cross-creator reach.
- TV unmoved and EXPLAINED: 10% creator-twin rate (vs 89% movie). Where TV twins
  exist the mechanism works (creator_twin recall@10 0.0417); there just aren't
  enough -- series share audiences, not casts.

**Adversarial review (/devils-advocate substitute, Explore):** findings triaged —
- [reframe, ACCEPTED] "5x" over a basement baseline -> now reported with absolute
  counts (+17 titles) and SE; weight configs reported as tied within noise.
- [MAJOR, ACCEPTED] "production-deployable" overclaim -> softened to "deployable
  re-rank stage over the MiniLM-ANN pool; full deploy needs precomputed vectors."
- [MAJOR doc gap, FIXED] franchise stratification existed only as a throwaway
  script -> promoted to committed code (`fusion.franchise_stratified`, wired into
  section3) + output appended to iter_3_output.txt. Claim now reproducible.
- [MAJOR, DEFERRED to iter 4] no fused mode=full ablation (retrieval vs ranking
  for fusion) and cast/crew not cleanly isolated from keywords. Logged as iter-4
  work. (item_knn iter-2 full/ann gap was small, so unlikely to overturn, but
  must be measured.)
- [MINOR, REFUTED] IDF-leak: IDF is computed over the 31,166-item catalog, not
  753; excluding one held-out title shifts df by <=1/31166 -- immaterial.
- [PASS] leakage=0 correct; recall multipliers correct.

**Literature (Q2 ANSWERED, 2nd escalation -- meets the >=2-by-iter-3 bar):**
content/creator similarity has a DOCUMENTED production recall ceiling. Spotify
audiobook (our closest analog): content-only LLM-KNN HR@10 plateaus at 0.164; a
GNN over a co-LISTENING graph lifts HR 36-57% and long-tail HR +118% by reaching
items 2 hops away that share no content/creator overlap [DeNadai2024 p2,p7].
PinSage: graph+content beats content-only by +150% HR [Ying2018 p8]. Every fix
needs MULTI-USER co-occurrence (we have none) -> single-household levers are
(A) exploration + implicit-feedback harvest [BaRT McInerney2018 p1-5; YouTube
Chen2019 p6-7] and (B) IMPORT an exogenous item-item co-engagement graph + GNN
[DeNadai2024; Ying2018], which is also the documented TV fix. LightGCN non-viable
solo (needs a multi-user graph) [He2020 p2].

**Blind-spot probe (iter 3):** "the movie 5x could be degenerate franchise-
matching, not taste." Evidence (Y): franchise-stratified recall (above). RESULT:
it IS creator-affinity (novel stratum = 0 recall) -- not title/sequel matching,
but cast/crew-driven; legitimate and production-standard, yet narrow. This both
resolves the skeptic concern and defines the next ceiling (cross-creator recall),
which the literature says requires co-engagement/exploration, not more content.

**Overfitting check:** leave-one-out + the creator/novel split agree on
direction (the win is real but bounded to creator-twins). Fusion is not a learned
model (fixed weighted cosine, no training), so there is no train/test fold to
overfit; the weight configs were not tuned on the test fold (two hand-set configs,
tied within noise). A time-based split is deferred to when a LEARNED model (GNN)
is introduced (iter 4+).

**Convergence status:** 3/5 iterations. Baseline ✓. TWO architectures A/B'd
(item_knn + fusion) ✓ (criterion 1 met). Headline nDCG@10 improved over baseline
for MOVIE (5x) ✓ but TV NOT improved (criterion 2 partial). Best config stability
across last 2 iterations: NOT yet (fusion is new this iteration) -> needs iter 4.
Guardrail held (leakage 0). Skeptic concerns resolved (franchise=creator-affinity;
popularity; candidate-set) except two DEFERRED ablations (fused-full, cast/crew
isolation). Overfitting addressed via the creator/novel split. NOT converged:
TV unsolved, fusion stability unconfirmed, ceiling-break (cross-creator) not begun.

**Next action:** Iteration 4 — (1) confirm fusion stability + run the deferred
fused mode=full ablation and clean cast-vs-crew isolation; (2) BEGIN Variant B
(exogenous item-item co-engagement graph + propagation) as the production-grounded
lever for cross-creator recall AND the TV gap; escalate Q3 (co-engagement source
mapping onto TMDB ids) to /literature-consultation.
