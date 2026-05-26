# M1.5 Contract — Decision Briefs Index

**Date:** 2026-05-25
**Purpose:** Decision briefs synthesizing 23 adversarial-research agent reports into actionable user-facing decision documents for the four [USER'S CALL] items and three residual flags blocking the M1.5 contract lock.

---

## Documents in this directory

| File | Topic | Decision needed? |
|---|---|---|
| `00-sequencing-and-lock-verdict.md` | Recommended decision order across the four [USER'S CALL] items; dependency DAG; lock-readiness checklist; total implementation-cost estimate | Read FIRST — sets reading order and lock criteria |
| `01-section-4-internal-auth.md` | §4 Hono ↔ Rust ↔ Python internal auth boundary: Option A (HMAC) / B (Rust JWE) / C (mTLS-UDS) / D (signed+encrypted) | YES — [USER'S CALL] |
| `02-section-9-recommender-data-model.md` | §9 IPTV-vs-TMDB data model: Resolution A (keep join) / B (per-source rows) / C (keep both) / D (event-driven backfill) | YES — [USER'S CALL] |
| `03-section-14-license.md` | §14 LICENSE: GPL-3.0 / MIT / Apache-2.0 / Proprietary | YES — [USER'S CALL] |
| `04-section-15-telemetry.md` | §15 Telemetry posture: Sentry SaaS / self-hosted Glitchtip / local-only file logs | YES — [USER'S CALL] |
| `05-flag-r17-sub-type-roundtrip.md` | Residual flag r17: §8.3 `plex:[0-9]+` regex allows leading-zero round-trip bug | NO — apply the regex tighten + test vector |
| `06-flag-r11-tombstone-design.md` | Residual flag r11: §11 tombstone design is silently wrong under §9=B, needs-rewrite under §9=C | CONDITIONAL — fix depends on §9 outcome |
| `07-flag-r19-missing-ratifications.md` | Residual flag r19: two missing §19 ratifications (§3.4 revocation surface, §3.6 multi-kid verifier) + three bonus candidates | NO — paste drop-in entries |

---

## How to use this directory

Read briefs in **dependency order**: start with `00-sequencing-and-lock-verdict.md` to see the recommended order and why each decision depends on others. Then read the four section briefs in that recommended order (typically `03` → `01` → `02` → `04`), making each decision before moving to the next where order matters. The three flag briefs (`05`-`07`) are reference-only: r17 and r19 are mechanical fixes the user does not need to "decide" — they need to be applied before lock. r11's fix is determined by the §9 outcome from brief `02`, so read it after making the §9 call. Once all four [USER'S CALL] items are picked and all three flag fixes are applied (or, for r11, applied conditionally on the §9 outcome), return to brief `00`'s lock-verdict checklist to confirm the contract is ready to tag and lock.

---

## STATUS: DONE
