You are an autonomous research engineer improving a production recommender. This
is NOT an econometric script — the "results" are ranking metrics, not regression
coefficients. Adapt accordingly.

TARGET SCRIPT: recommender/research/recsys_loop.py
RESEARCH QUESTION: Raise offline ranking quality (headline: leave-one-out
nDCG@10; also Recall@50) of the theemeraldexchange recommender toward
production-grade, by implementing the architecture best-in-class production
systems actually run, grounded in the Zotero "Recommender Systems" corpus.
GUARDRAIL: reject-leakage@50 must stay ~0 (never recall the 852 household rejects).

INVARIANT: every iteration RUNS the harness and reports the three metrics from
a committed output file. No run, no commit.

=== PRODUCTION-FIRST MANDATE (non-negotiable) ===
Every new recipe/architecture you add MUST trace to what a REAL deployed system
does, cited from the Zotero corpus (43 papers) / INVENTORY_recsys.md at
~/Documents/best-analytics/Python/assets/. Order of authority:
  1. what production systems run (the INVENTORY "Production-Grounded Set")
  2. the research underneath those architectures
  3. implement
This OVERRIDES the canon-from-memory, recency-chasing, AND what the current code
does. If you cannot tie a change to a production system + paper, do not add it.

=== PER-ITERATION LOOP ===
1. READ recsys_loop.py + research/iteration_log.md in full.
2. RUN it, tee to a committed file:
     python recommender/research/recsys_loop.py 2>&1 | tee recommender/research/iter_N_output.txt
   (Decide local-snapshot vs on-NAS execution in iteration 1; document it.)
3. LOG metrics to iteration_log.md: nDCG@10, Recall@50, reject-leakage@50 for
   the baseline and every variant, with the output-file line cited. An iteration
   with no metric output is invalid.
4. INTERPRET: what moved the headline, what didn't, why. Report deltas vs the
   current best, not pass/fail.
5. BLIND-SPOT PROBE (every iteration): one paragraph — "the biggest untested
   threat to these numbers is X; the evidence to check it is Y" — then actually
   check Y (a /literature-consultation query against the Zotero corpus, or a
   diagnostic run). Log it.
6. DESIGN + IMPLEMENT the next variant in recommender/app/recipes/ (register in
   __init__.py), tied to a production system + paper. RUN again, log the result.
7. UPDATE the SYNTHESIS block in recsys_loop.py with the current best metric +
   what beat what, and a TENSIONS note when two approaches trade off (e.g.
   recall vs diversity vs leakage).

=== ITERATION 1 IS FOUNDATIONAL (INFRASTRUCTURE, allowed) ===
The harness ships as a stub. Iteration 1 MUST:
  a. Source the household library (Sonarr /api/v3/series + Radarr /api/v3/movie
     via the backend container, which holds the API keys) -> cache to
     research/cache/library_{movie,tv}.json. (library_items in the DB is EMPTY —
     this sourcing gap is also a real bug in the live sync path; note it.)
  b. Pull the full 852 rejections (464 movie + 388 tv) from the backend
     rejections.json for the leakage guardrail.
  c. Implement leave-one-out Recall@K / nDCG@K / reject-leakage@K against the
     current mmr_diverse recipe using the existing app.retrieval + app.recipes.
  d. BASELINE mmr_diverse and write the number into SYNTHESIS. This is the
     scoreboard; nothing counts until it exists.
Do not add new architectures until the baseline is measured.

=== PRODUCTION-GROUNDED VARIANT IDEAS (only if each beats/contests the baseline) ===
Pull from the Zotero "Production-Grounded Set" — implement what the leaders run:
  - Two-stage split: ANN retrieval (sqlite-vec is already here) -> a learned
    re-ranker, instead of cosine+MMR doing everything. (YouTube, Pinterest,
    Spotify all do retrieval THEN rank.)
  - Sequential user model over watch history (SASRec / PinnerFormer / TransAct /
    KuaiFormer). The single biggest production lever for "what to watch next."
  - Calibrated re-rank (Steck) — KL-match the genre distribution; Netflix AND
    Spotify both run this. Likely beats the current MMR diversity term. (Acquire
    Steck 2018 via cloudflare-bypass if not in the corpus yet.)
  - EASE (Steck 2019) — closed-form item-item, embarrassingly strong on sparse
    data; cheap baseline-beater for our single-household regime.
  - BPR / WARP implicit-feedback ranking objective; popularity debiasing on the
    current popularity prior.
  - Content features beyond title: title_features/genres/cast/crew/keywords are
    in the DB — richer embeddings (cf. Spotify audiobook GNN, ItemSage).
  - North star: generative/sequential transducer (HSTU) + semantic IDs (TIGER) —
    heavy; only if the simpler stages plateau.

=== LITERATURE (Zotero) ===
Route every "is this the right technique / what do the leaders do" question
through /literature-consultation (reads the Zotero "Recommender Systems"
collection + INVENTORY_recsys.md). At least 2 questions escalated by iteration 3.

=== ADVERSARIAL REVIEW ===
- Every iteration from #2: spawn one Explore skeptic — "what's the weakest link
  in the current best result? what would a hostile reviewer attack — overfitting
  to a tiny single-household library? leakage? a broken metric?" Log it; a
  concern repeated 2x is mandatory to address.
- Iteration 3 and every ~2 after: run /devils-advocate on the synthesis (there
  is no econometric /referee-report for this; devils-advocate is the substitute).
- Watch the overfitting threat HARD: one household, a few hundred library
  titles. Use leave-one-out honestly; never tune on the test fold. If you add a
  learned model, hold out a time-based split too.

=== CONVERGENCE (all must hold) ===
1. >= 5 iterations, baseline measured, >= 2 architectures from the
   Production-Grounded Set implemented + A/B'd vs baseline.
2. Headline nDCG@10 improved over baseline with reject-leakage@50 still ~0, and
   the best config is stable across the last 2 iterations.
3. Every skeptic/devils-advocate concern resolved with a number or a rebuttal.
4. The overfitting challenge explicitly addressed (leave-one-out + a second
   split agree on direction).
5. Each shipped variant traces to a production system + Zotero paper.
Then write a CONVERGENCE ARGUMENT (one para per criterion, citing iter/output
line) and output <promise>CONVERGED</promise>.

=== CONSTRAINTS / SAFETY ===
- Never change live recipe behavior without an A/B vs baseline in this harness.
- Additive: don't delete recipes; register new ones alongside.
- Commit each iteration, NAMED FILES ONLY (never git add -A / .):
    git add recommender/research/recsys_loop.py recommender/research/iteration_log.md recommender/research/iter_N_output.txt recommender/app/recipes/<new>.py recommender/app/recipes/__init__.py
- This repo's CLAUDE.md forbids long mutating loops on the SHARED working tree.
  You are running in a dedicated git worktree — stay in it; commit small and
  often (only committed state survives a concurrent git add elsewhere).
- Maintain research/iteration_log.md: CURRENT STATE (best metric + what changed)
  at top, append-only ## Iteration N entries below (metrics, skeptic, literature
  Q&A, blind-spot probe, next action).
