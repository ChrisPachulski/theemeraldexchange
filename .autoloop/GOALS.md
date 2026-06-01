# Autoloop GOALS — what the loop should work on, and in what order

The loop reads this every window. **Part A is the evidence-derived mechanism (don't casually edit).
Part B is YOURS — reorder it whenever your priorities change; no code change needed.**

Selection each window is: **verifiability GATE → highest non-empty CLASS (Part A) → rank within that
class by `hotspotScore × roadmap-fit (Part B)`**. Effort is a tiebreaker only, never a divisor.
If nothing passes the gate, the correct outcome is a clean **dry window (abstain)** — not a forced pick.

---

## Part A — Work-class ladder (evidence-derived; fixed)

Grounded in the 2026-06-01 production-first literature consultation (Google Tricorder/LSC/AI-Patching,
Meta SapFix/Getafix/TestGen-LLM, Anthropic long-running-agents, Nagappan&Ball, Tornhill, DORA/DevEx).
Pick within the HIGHEST class that has a gate-passing candidate this window:

1. **signal-fix** — Fix a REPRODUCED failure that is RED right now: a failing test, a crash, a type
   error, a lint/sanitizer error. Never speculative bug-hunting — only an already-failing signal.
   (SapFix / Google AI-Patching: trusted auto-repair is reactive + signal-driven.)
2. **mechanical** — Mechanical, SEMANTICS-PRESERVING change at a hotspot: codemod, dead-code removal,
   deprecation migration, safe lint-autofix. Behavior provably unchanged. (Google LSC — safest high-volume class.)
3. **gated-test** — Test improvement at a hotspot that BUILDS + passes reliably + STRICTLY increases
   coverage AND would catch a real regression. (TestGen-LLM monotonic-improvement gate. Coverage on a
   COLD file is near-zero value — only counts at a hotspot.)
4. **devex** — Cognitive-load / feedback-loop work at a hotspot: stronger types, de-flake a flaky test,
   speed up CI, fill a doc gap that blocks understanding. (DevEx/DORA: feedback-loop work compounds.)
5. **dep-hygiene** — Dependency/security hygiene, BATCHED + confidence-scored. Never a single trivial
   bump. Lowest priority; only when classes 1-4 are empty.

**Hard rails (all classes):** an eligible candidate MUST have an objective verification gate it can pass
(`scripts/autoloop/ci-gate.sh` goes green on it) and must target a file near the top of `hotspots.json`.
Reviewer attention is the scarce resource — prefer FEWER, evidence-attached changes; abstain when unsure.

## Part B — Roadmap weighting (HUMAN-OWNED — edit freely)

Within the chosen class, bias the ranking toward these, highest first:

1. **M2 TestFlight blockers** — anything gating the first TestFlight build (auth, device-token, playback,
   the M1.5 contract surface). These outrank everything.
2. **Security / privacy hardening** — auth, webauthn, device-token, internal-principal, SSRF guard,
   telemetry PII scrub, key derivation. (App-Store-bound; security is load-bearing.)
3. **Correctness on hotspots** — real bug/robustness fixes in the top `hotspots.json` files
   (e.g. `server/routes/suggestions.ts`, `iptv.ts`, `env.ts`).
4. **Coverage on hotspots** — gated tests for the hottest under-covered files (the hotspot leg — NOT
   cold-file coverage, which the loop over-did before).
5. **Refactors / docs / types** — cognitive-load reduction on hotspots. Lowest weight.

<!-- The loop never invents features. Feature work only via a human-authored spec in .autoloop/SPECS/ (Phase 3). -->
