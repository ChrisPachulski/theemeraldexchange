
# Recommender Evaluation & Research — Teaching Dossier

## 1. WHAT

Offline evaluation tests whether your recommender system _would_ work before shipping it to real users. You hold back a known set of titles the household actually liked (from their library), remove them one at a time, ask your recommender to suggest new titles, then measure: _did it rank the held-out titles high_? This is called leave-one-out testing. The metric nDCG@10 (normalized Discounted Cumulative Gain at top-10) asks: "of the things the user liked, how many appear in your top-10 suggestions AND how high do they rank?" You get a score 0–1; higher is better. The theemeraldexchange recommender research loop tested different candidate algorithms (co-engagement retrieval, content fusion, etc.) offline until one reached 10.4× the baseline quality. Only then did we ship it.

## 2. WHY

**Why evaluate offline first (the chain of reasoning):**
1. **Real users are expensive**: testing on live users means bad recommendations hurt trust and churn. Testing offline costs CPU, not reputation.
2. **Feedback delay**: a bad shipped recommender might take weeks to show harm; an offline test gives you the verdict in minutes.
3. **Reproducibility**: an offline eval is deterministic (same database snapshot = same score every run); live A/B tests are noisy and slow.
4. **Honesty bounds**: the offline eval documents what each idea _actually_ does (e.g., the content-only baseline recalls only 0.8% of held-out titles; co-engagement+fusion lifts that to 2.19%), not wishful hype.
5. **Gating decisions**: you can afford to try wild ideas offline (import MovieLens co-ratings, fuse cast+crew, cap neighbors at 10) because failure is free. You'd never ship a config that hasn't proven it improves the holdout score.

## 3. MAP

**Key files and control flow:**

- **`recommender/eval/README.md:1-30`** — holdout format (JSONL, one object per line: `{sub, kind, library[], positives[], negatives[]}`). The optimizer reads this to score candidate configs.
- **`recommender/eval/build_holdout.py:48-127`** — the generator: reads the live recommender DB, mines user library + positive outcomes (liked, added, clicked) from rec_log/rec_outcomes tables in the last 30 days, subtracts known positives from the library to avoid recall-collapse (a subtle but critical trick at line 108-109), filters to users with ≥10 library items AND ≥1 positive.
- **`recommender/research/recsys_loop.py:1-80`** — the harness: imports the production retrieval + ranking code, loads the holdout, runs a for-loop over each candidate config (baseline, content-only, co-engagement retrieval+union, etc.), measures nDCG@10, Recall@10/50, rejection-leakage rate, prints a table.
- **`recommender/research/fusion.py:1-31`** — one candidate: fuse MiniLM dense text embedding with sparse IDF-weighted genre/keyword/cast/crew features (the production ItemSage pattern from Pinterest).
- **`recommender/research/coengagement.py:1-30`** — another candidate: import MovieLens item-item PMI co-ratings (debiased against blockbuster popularity), use as retrieval to widen the candidate pool (iteration-5 finding: co-engagement must drive _retrieval_, not just re-ranking).
- **`recommender/research/iteration_log.md:1-45`** — the **converged result** (iteration 6): `union_cap10` = top-10 PMI co-engagement neighbors per library item (retrieval stage) + fused-content re-scoring (cast+crew+text, no genre) achieves **0.0219 nDCG@10 = 10.4× baseline 0.0021**.

**One eval run (simplified):**
1. Build holdout: `python -m eval.build_holdout > eval/holdout.jsonl` (reads DB, emits ~60 (sub, kind) pairs with 1+ positives).
2. Load holdout into memory (one JSONL line per user).
3. For each config (baseline, fusion, union, etc.):
   - For each user in holdout:
     - Remove one positive title from the library.
     - Call the recommender config with the reduced library.
     - Measure: does the held-out title appear in top-10? rank?
     - Compute nDCG@10 (discount by log rank).
   - Average nDCG@10 across all users → headline score.
4. Print results table (config name, nDCG@10, recall@10, recall@50, leakage@50).
5. Lock the best config, commit iteration results.

## 4. PREREQUISITES

**Train/test split (why 30 days):**
- The recommender DB is a running log of outcomes. You can't train on the SAME examples you test on (the model would memorize, reporting fake performance).
- Iteration 1 built the holdout from outcomes in the LAST 30 days (`HOLDOUT_LOOKBACK_DAYS` env, line 43 of build_holdout.py). Earlier outcomes are never in a test set; recent outcomes (within 30 days) test the model's ability to rank items the household will later find valuable.
- Tradeoff: 30 days is short (noisier signal, fewer examples: ~60 (sub, kind) pairs), but it's realistic (a recommender shipped today should predict likes 30 days from now, not 6 months).

**Ranking metric — nDCG@10 eli5:**
- Imagine the household actually liked 5 movies in the held-out window. You run the recommender and it returns a list of 10 suggestions.
- You look at position of each held-out movie in your top-10:
  - If it's at position 1 (rank 0), you give it a "gain" of 1, discounted by log₂(0+2) = 1. Gain/discount = 1.
  - If it's at position 5, gain=1, discount=log₂(6)≈2.58. Gain/discount ≈ 0.39.
  - If it's not in top-10, gain=0.
  - Sum these: DCG = cumulative gain, discounted.
- "Ideal" would be all 5 hits at the top: IDCG = 1 + 1/log₂(3) + 1/log₂(4) + 1/log₂(5) + 1/log₂(6) ≈ 3.98.
- nDCG = DCG / IDCG (normalize to 0–1). If you return 5 hits at positions 1-5, nDCG ≈ 1. If you return no hits, nDCG = 0. If hits are at 8-10, nDCG is low (heavily discounted).
- Higher nDCG = your model ranked the relevant stuff HIGHER.

**Rejection leakage (the guardrail):**
- The household explicitly rejected 852 titles (disliked, marked as "never suggest").
- Leakage@50 = "did any rejected title appear in your top-50 suggestions?"
- The filter (`recommender/app/retrieval.py` anti-joins rejects) should keep this at ~0. If you see leakage, your model is surfacing titles the household already vetoed—a UX failure.

## 5. GOTCHAS & WAR STORIES

**The library-collapse trap (CRITICAL LEARNING):**
- Iteration 1 had a subtle bug: when a user "added" a movie to their library, it now appears in `library_items`. But you're testing "would the model have ranked this title high BEFORE the user added it?"
- If you keep the library unchanged, that title is now "in library" → filtered out by retrieval (you never suggest titles already owned) → impossible to recall → nDCG collapses to 0.
- **Fix (lines 108-109 of build_holdout.py):** subtract known positives from the library before emitting the holdout. Approximate the pre-outcome state. This restores the recall signal and lets the optimizer distinguish a working config from a broken one.

**JSONL vs JSON array (silent failure):**
- The optimizer (`workers/optimizer.py`) reads JSONL: `json.loads(line)` per line.
- SQLite's `.mode json` outputs a single JSON array `[{...}, {...}]`.
- If you feed a JSON array into a JSONL reader, it parses line 1 as one big object (the first array element), then line 2 fails → the optimizer sees zero usable rows and **disables auto-promotion without any error message**.
- **Lesson:** check your holdout shape: `head -3 eval/holdout.jsonl | jq .` should print three separate objects, not one array.

**The sync gap (infrastructure bug found):**
- `library_items` table was EMPTY (0 rows); the live Sonarr/Radarr library was never synced into the recommender DB.
- Iteration 1 sourced the real library directly from Sonarr/Radarr APIs, cached it.
- This is a PRODUCTION BUG: the recommender is scoring against an empty library for any live call (line 91 of workers/optimizer.py loads `library` from the DB; if empty, every user looks like cold-start).
- **Status:** still unfixed in the repo; documented in iteration 1 findings; workaround in place.

**Rotted vitest.env.ts gate (caught in iteration 5):**
- The repo has a test `test/eval:recs` that validates nDCG@10 stays above a threshold.
- This gate had rotted (been commented out / hardcoded to a stale value) and wasn't running in CI.
- When iteration 4 submitted a regression candidate, the gate didn't catch it.
- **Fix:** re-enabled the gate, wired it to the real holdout path, now it blocks regressions in CI.

**TV unsolved (honest boundary):**
- Iterations 1–6 focus on MOVIES (753 titles); TV still has ~0 nDCG@10.
- Reason: TV series share **audiences**, not **cast/crew** (actors rarely appear in multiple series). The fusion approach (creator-affinity) works for movies (89% creator-twins) but fails on TV (10% creator-twins).
- Co-engagement partially addresses this (series CAN share viewers even without shared cast), but the imported MovieLens graph is movies-only.
- **Next step (not yet done):** explicit exploration + implicit-feedback harvesting (log plays, clicks, previews as graded positives; use Thompson sampling to explore novel series).

## 6. QUIZ BANK

**Q1: You run the holdout eval and nDCG@10 improves from 0.0021 to 0.0219. The owner says "that's only 2%, not impressive." How would you respond?**

A: You'd clarify: the 2.19% is the absolute metric (held-out titles are ranked in top-10 about 2% of the time). The _improvement_ is 0.0219 / 0.0021 ≈ 10.4×—a 10-fold lift. Both numbers matter: the absolute tells you you're still bad at novel titles (ceiling is 1.0), but the relative tells you the new config is much better than the old one. In production, 10× worse is unusable; 10× better is a real ship.

**Q2: A colleague proposes a new recommender config and says "I tested it on 50 recent user interactions and the users liked 90% of the suggestions." Why is this not a valid eval?**

A: That's live/feedback-based testing, not offline eval, and it has three problems: (1) confirmation bias (users who see bad suggestions don't respond, so you only observe the successes); (2) no control (you don't know if 90% is good for this household—is it because your model is great or because the catalog is small?); (3) slow iteration (waiting for 50 interactions takes days). Offline eval uses historical holdout (titles already liked), so you get a verdict in minutes, no feedback loop.

**Q3: The holdout builder filters to users with ≥10 library items AND ≥1 positive. Why not lower the threshold to 5 items?**

A: Lower thresholds mean noisier eval signal: a household with 5 random titles that happen to share one actor will produce a misleading feature-signal (cast/crew fusion will appear to work when it's just overfitting to thin data). The cold-start threshold (≥10) is also the production gate—users with fewer items are routed through cold-start behavior at runtime, so eval against them is out-of-distribution anyway. Stick to ≥10 so offline eval matches production behavior.

**Q4: You implement a new retrieval method that finds 5,000 candidate movies (vs the baseline's 800). But nDCG@10 drops from 0.0219 to 0.0180. Should you ship it because the larger pool could help novel users?**

A: No. The holdout (this household's library) is real user feedback; if nDCG drops, the larger pool is actually hurting _scoring_—the model is drowning in worse candidates. The gain you're hoping for (novel users benefit from larger pool) is speculative; the loss is measured. If you want to test the larger-pool hypothesis, run it offline against a dataset of novel users (e.g., users with <10 library items in a separate holdout), measure _their_ nDCG separately, and prove the tradeoff is worth it.

**Q5: The co-engagement co-occurrence graph has 852 potential edges per item in the catalog, but iteration 5 caps it at top-10 neighbors. Ablation shows capping at 5 gives nDCG@10=0.0217 vs cap-10's 0.0219. Why not just use cap-5?**

A: The difference (0.0217 vs 0.0219) is within sampling error (standard error ~0.001). But cap-10 is on the _flat plateau_ of the lever (caps 5–10 all ≈0.022; caps ≥15 drop to 0.0173). Cap-5 is slightly left of the plateau; cap-10 is on it. Cap-10 is more robust—if you retrain on a different snapshot, cap-5 might fall off the plateau whereas cap-10 is safer. Ship cap-10.

## 7. CODE-READING EXERCISE

**Task: Trace one eval run for a single user.**

Open `recommender/research/recsys_loop.py` (the harness). Focus on lines 100–180 (the main evaluation loop). Here's the walk:

1. **Lines ~120–130 (load holdout and cache the DB):** The harness reads `eval/holdout.jsonl` into a list. Each line is a user: `{sub, kind, library, positives, negatives}`.

2. **Lines ~140–170 (the leave-one-out loop):** For each user in the holdout:
   - For each `held_out_title` in `user["positives"]`:
     - Create a mock library that EXCLUDES the held_out_title (line ~155).
     - Call `score_request(library=[...], kind=kind)` (the production recommender scoring endpoint, imported from `app/`).
     - Extract top-10 results (candidates, their scores).
     - Check: **is the held_out_title in top-10? At what rank?**
     - Record the rank (or None if not found).

3. **Lines ~175–180 (measure nDCG@10):** Collect all ranks. For each rank, compute the discount:
   - If rank=1 (top-1), discount = 1.0 (gain / log₂(2)).
   - If rank=10, discount = 1.0 / log₂(11) ≈ 0.28.
   - If not in top-10, discount = 0.
   - Sum discounts per user, divide by IDCG (the "perfect" case where all positives rank 1–N).
   - Average nDCG across all users → **headline score**.

4. **Why this specific order matters:** You measure RECALL@10 (did the title appear?) and POSITION (where did it rank?). A title at rank 1 is much more valuable (user sees it immediately) than rank 10 (buried in the list). nDCG captures both.

**Your turn:** Open `recommender/research/recsys_loop.py` and find the section that loops `for held_out_title in user["positives"]`. Add a comment explaining what `discount` represents in English. Then find where `recall@10` is computed (it's simpler—just a binary: appears in top-10 or not). Run the eval once (follow the instructions at the top of the file) and check that the headline nDCG matches the iteration-log.md table.

---

## CONVERGED FINDING (summary)

**What works:** Co-engagement retrieval (PMI-weighted top-10 item-item neighbors from MovieLens) + content fusion scoring (cast+crew+text, no genre or keywords) gives **nDCG@10 = 0.0219** (10.4× baseline). This is LOCKED and DEPLOYED.

**What doesn't:** Content alone caps at 0.0081 (creator-affinity only); TV unsolved (series don't share cast); novel titles (no shared cast/crew) stay 0 recall. The next ceiling-break is implicit-feedback + exploration (log plays/adds/previews, use them as graded positives; explore novel titles via Thompson sampling).
