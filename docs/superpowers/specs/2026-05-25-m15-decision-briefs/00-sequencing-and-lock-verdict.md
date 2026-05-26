# M1.5 Contract — Decision Sequencing & Lock Verdict

**Date:** 2026-05-25
**Inputs:** 23 agent reports under `.planning/burn-it-all/m15-decisions/agents/`
**Author:** sequencing-synthesis agent

---

## Part A — Decision Sequencing Recommendation

### The four [USER'S CALL] items, restated

| ID | Decision | Status |
|---|---|---|
| §14 | LICENSE (GPL-3.0 / MIT / Apache-2.0 / Proprietary) | unpicked |
| §4 | Internal auth (A: Hono-only HMAC / B: Rust decrypts JWE / C: mTLS-UDS / D: signed+encrypted) | unpicked |
| §9 | Recommender data model (A: keep join / B: per-source rows / C: keep both / D: event-driven backfill) | unpicked |
| §15 | Telemetry (Sentry SaaS / Glitchtip self-host / Local-only) | unpicked |

### Dependency DAG

```
§14 (LICENSE) ─┬─► §4 (auth)
               │       │
               │       └──┐
               │          ▼
               └──────► §15 (telemetry)
                          ▲
                          │
               §9 (data) ─┘ (weak edge: see note 4)

§14 → §15   (direct edge: see note 2)
§14 → §4    (direct edge: see note 1)
§4  → §15   (HARD edge: see note 3)
§9  → §15   (soft edge: see note 4 — independent of others)
```

### Why these edges exist (cite-by-agent)

**Note 1 — §14 → §4 (strong, but weaker than originally claimed).**
The original §14 framing said "§4 Option A favours proprietary, Option B favours open-source." Per `a14-failure-modes.md` and `a4-failure-modes.md`, that framing was a **category error**: both options sit in the same repo under the same license. The real residual dependency is *audit surface*. Under proprietary, Option A's Rust binary holds a single HMAC-verify call; Option B holds a full JWE stack plus a ported Plex reconciliation implementation that no community can audit. Under any OSS license, B's full stack is fine because the JWE stack is community-readable; under proprietary B doubles the closed-source security-sensitive surface area you must maintain alone. So §14 still influences §4 — but it's an *audit-surface* argument, not a *license-incompatibility* argument. (`a14-failure-modes.md` rows 60-68; `a4-oneway-door.md` axis 1.)

**Note 2 — §14 → §15 (real but small).**
`a15-oneway-door.md` axis 6 shows the Sentry SDK is BSL-1.1; Glitchtip SDK is Apache-2.0. The BSL only restricts hosted-service competitors, not end-user apps, so a proprietary EEX product is unaffected. License does not constrain telemetry choice meaningfully. The edge survives only because §14's "no App Store under GPL-3.0" cascades into §15's nutrition-label problem: if GPL-3.0 forecloses App Store, the §15 "Data Not Collected" target loses its motivation.

**Note 3 — §4 → §15 (HARD edge, single dangerous combination).**
`a15-oneway-door.md` axis 5 and `a4-oneway-door.md` axis 2 are unambiguous: **the only configuration where a live `plexAuthToken` reaches a third-party server is §4 Option B + §15 Sentry SaaS**. Under Option B, Rust decrypts the session JWE, putting `plexAuthToken` in Rust process memory. A single `tracing::debug!("{:?}", claims)` call followed by Sentry SDK capture ships a live Plex credential to Sentry's cloud. Glitchtip self-host bounds the leak to the NAS; local-only bounds it to disk. Picking §4=B forecloses §15=Sentry-SaaS unless you accept a permanent CI-enforced struct constraint as your only safety. Picking §4=A makes all three §15 options equally safe.

**Note 4 — §9 mostly independent, but interlocks with §11.**
`r11-tombstone-design.md` is unambiguous: §11's tombstone design was written assuming §9 Resolution A and **applies as written only under A or D**. Under Resolution **B**, §11 is "silently wrong" — all its DDL targets `iptv_title_link`, which doesn't exist under B; the tombstone schema must be entirely retargeted to `exchange.db.titles` with a parallel migration that does not exist. Under Resolution **C**, §11 is "needs-rewrite": badge continuity and ranker visibility decouple for up to 14+ days during tombstone windows, producing incoherent UX, and §11 has no rule for it. §9 has no edge to §14/§4/§15, but it has a hard edge into §11's residual flag.

### Recommended decision order

```
1. §14 LICENSE                  (one-way door, blocks §4 audit-surface framing)
2. §4 INTERNAL AUTH             (constrains §15 telemetry safety)
3. §9 RECOMMENDER DATA MODEL    (independent; sit in parallel sub-sitting)
4. §15 TELEMETRY                (must follow §4)
```

**Justification:**

1. **§14 first.** It's a one-way door per `a14-oneway-door.md`. GPL-3.0 specifically forecloses the App Store distribution path that the M5.5 milestone depends on (per FSF + Apple incompatibility documented in `a14-precedents.md` — VLC 2011 removal, Sonarr/Radarr have no official iOS app for this reason). MIT/Apache/Proprietary do not. Once any external contributor PR lands under GPL-3.0 without a CLA, relicensing closes permanently. The decision touches §4's audit-surface argument and frames §15's "self-hosted privacy story" question. Decide first; sit on it for a day before locking.

2. **§4 second.** `a4-question.md` shows the pivotal question is "will Rust services ever authorize users without Hono present?" The roadmap and `strategic-update.md` strongly imply NO, which collapses the answer to Option A. But Option A vs Option D is a 6-hour delta with low one-way-door cost, and that micro-choice depends on §14: if §14=proprietary, Option A's smaller closed-source audit surface is preferable. `a4-precedents.md` shows 6 of 7 self-hosted analogs use Option-A-style patterns (Plex transient token, Home Assistant SUPERVISOR_TOKEN, Authelia, authentik, Tailscale, Nextcloud AppAPI); only Sonarr/Radarr/Prowlarr use independent-validation static keys.

3. **§9 third — in parallel with §4 if you wish.** §9 has no dependency on §14 or §4. It does cascade into §11's residual flag (see Part B). `a9-precedents.md` shows 6 of 8 industry analogs (JustWatch, Reelgood, TMDB, Trakt, Letterboxd, Radarr) use Resolution-A-shape designs — one canonical row keyed by external ID, availability as an array or join. Only Jellyfin uses B, and Jellyfin developers treat B as technical debt (per `MergeVersions` plugin and unresolved LiveTV merge issue #632). The pivotal question per `a9-question.md`: "when the same movie exists in IPTV and Plex, is it one thing the user has access to or two different ways to watch the same thing?"

4. **§15 last.** Per `a15-oneway-door.md`, the true one-way door at §15 is **the App Store nutrition label**, not the SDK. SDKs are interchangeable (Sentry/Glitchtip use the same protocol; DSN swap). `strategic-update.md` §5 explicitly targets "Data Not Collected" for initial submission, which means local-only is the only option that does not require a label upgrade. The label lock is committed at submission, not at code-time. The decision can wait until §4 is locked — and `a15-question.md` notes a clean degenerate path: ship M1.5 with local-only, leave a `TELEMETRY_DSN` env-var stub, flip the flag if TestFlight feedback demands it before App Store submission.

### Decision batching

| Sit-down | Decisions | Why batched / why separated |
|---|---|---|
| **Day 1 — License sitting** | §14 alone | One-way door + 12-18 month commitment + contributor-structure implications. Sleep on it. `a14-question.md`: this is "a fact about what you want this project to be." Do not co-sit with anything else. |
| **Day 2 — Architecture sitting** | §4 + §9 | Both architectural, both require thinking about Rust topology + recommender shape. `a4-question.md` Q1 (will Rust ever standalone?) and `a9-question.md` Q4 (is M3 media-core like IPTV?) are adjacent questions about M3 readiness. Can be co-decided in a single session. |
| **Day 3 — Telemetry + lock** | §15, then ratifications + lock | Cheapest decision (SDK swap, deferred via local-only stub). Decide, apply the §19 and r11/r17 fixes, lock the contract. |

Total wall-clock: **3 calendar days** from start to lockable contract, of which **8-12 hours** of actual decision-thinking + fix application.

---

## Part B — Ready-to-Lock Verdict

### State of the contract today

- **4 [USER'S CALL] items pending** → always blocking lock.
- **r17 §8.3 plex regex** — latent bug. `r17-sub-type-roundtrip.md` proved by machine-execution that `plex:[0-9]+` accepts `plex:007` which round-trips to `plex:7` under design (ii)/(iii) — byte-equal FAIL. Fix is one regex change: `plex:0|plex:[1-9][0-9]*`. Must be applied. Trivial.
- **r11 §11 tombstone design** — VALID under §9 = A or D; SILENTLY WRONG under §9 = B (all DDL targets non-existent table); NEEDS-REWRITE under §9 = C (no rule for badge/ranker decoupling during tombstone window). Fix is **conditional on §9 outcome**. Cannot pre-apply.
- **r19 missing ratifications** — `r19-missing-ratifications.md` produced two drop-in §19 entries (§3.4 revocation surface + §3.6 multi-kid verifier) and identified three more "bonus" candidates (§3.1 boot-time secret guard, §3.3 HKDF/SHA-256 co-deploy, §3.4 external-write operator caveat). Fix is paste-in.

### Lock checklist

```
- [ ] User picks §14 LICENSE                                          (one-way door — sit on it for ≥24h)
- [ ] User picks §4 internal auth                                     (after §14; audit-surface implications)
- [ ] User picks §9 recommender data model                            (independent; can co-sit with §4)
- [ ] User picks §15 telemetry                                        (after §4; B+Sentry-SaaS is dangerous combo)
- [ ] Apply r17 §8.3 regex tighten: plex:[0-9]+ → plex:0|plex:[1-9][0-9]*
- [ ] Apply r17 test vector: add "plex:007" as invalid-input to tests/vectors/sub-namespace.json
- [ ] Apply r19 two new §19 entries: §3.4 revocation surface + §3.6 multi-kid verifier
- [ ] (Recommended) Apply r19 three bonus §19 entries: §3.1 secret-distinctness guard, §3.3 HKDF co-deploy, §3.4 external-write caveat
- [ ] (Conditional on §9) Apply r11 §11 fixes:
        - if §9 = A or D: no §11 change needed
        - if §9 = B: rewrite §11 entirely to target exchange.db.titles
        - if §9 = C: add explicit drift-window rule to §11
- [ ] User ratifies §19 checklist (21 original + 2 from r19 + up to 3 bonus = 23-26 items)
- [ ] Lock + tag the contract (e.g., v1.5.0-contract)
```

### Total M1.5 implementation cost

The M1.5 §16 D-table in the existing contract already counts cross-cutting auth + spec items. The four [USER'S CALL] items add cost on top per the impl-cost agents:

| Decision | Lowest-cost choice | Highest-cost choice | Source |
|---|---|---|---|
| §14 LICENSE | MIT (8.1h OT + 3.15h/yr = 23.85h over 5yr) | GPL-3.0 (18.35h OT + 8.7h/yr = 61.85h over 5yr) | `a14-impl-cost.md` |
| §4 INTERNAL AUTH | A (21h) | C/mTLS-UDS (41h) | `a4-impl-cost.md` |
| §9 DATA MODEL | C (11.5h) ≈ A (12h) | D (31h) | `a9-impl-cost.md` |
| §15 TELEMETRY (M1.5-only portion) | Local-only (6.5h) | Glitchtip (15h) | `a15-impl-cost.md` |

**Total M1.5 implementation range (M1.5 only, no double-counting):**

- **Lowest combination** (MIT + §4 A + §9 C + §15 local-only): roughly **8.1 (§14 OT) + 21 (§4) + 11.5 (§9) + 6.5 (§15 M1.5-portion)** = **~47 hours**.
- **Median combination** (Apache-2.0 + §4 A + §9 A + §15 local-only): **12.35 + 21 + 12 + 6.5** = **~52 hours**.
- **Highest combination** (GPL-3.0 + §4 C + §9 D + §15 Glitchtip): **18.35 + 41 + 31 + 15** = **~105 hours**.

**5-year all-in (including telemetry expansion to Rust/Swift in M2-M3, license OY recurring, no §16 double-counting):**

- **Lowest:** 47 + (3.15 × 4 yrs §14 OY) + (~6.5 §15 M2-M3 portion) ≈ **66 hours**.
- **Highest:** 105 + (8.7 × 4 yrs §14 OY) + (~21 §15 M2-M3 portion) ≈ **161 hours**.

**The §16 D-table in the existing contract overlaps with the §4 auth work** (it already accounts for HMAC-key wiring, env validation, test-vector authoring). The above table treats the §4 row as additive on top of §16's existing line items to avoid undercounting the multi-language port cost. Cross-check against `a4-impl-cost.md` line items to deduplicate when locking the cost estimate at PR time.

### Lockable today?

**No.** Four pending [USER'S CALL] items always block. Plus r17 regex fix and r19 ratification entries are uncontroversial-but-unapplied. Plus r11 §11 fix is conditional on §9 — cannot pre-apply.

**Lockable in 3 days** if the user sits §14 today, §4+§9 tomorrow, §15 + fix-application + lock the day after. Decision-load is moderate, not high. The architecture deltas are well-bounded by the 23 reports.

**Recommended default if the user wants to pick fastest:**

- §14 = **MIT** (lowest legal cost, App Store-clean, lowest one-way-door per `a14-oneway-door.md`).
- §4 = **A** (matches 6 of 7 precedents per `a4-precedents.md`; lowest impl cost; preserves all telemetry options per `a4-oneway-door.md`).
- §9 = **A** (matches 6 of 8 industry analogs per `a9-precedents.md`; lowest impl cost tied with C; §11 applies as-written; locks M3 to the proven join pattern).
- §15 = **Local-only** with `TELEMETRY_DSN` env stub for later flip (preserves "Data Not Collected" label per `strategic-update.md` §5; cheapest now; reversible before M5.5).

That combination is **~47h M1.5 effort**, applies r11 zero-rewrite, and leaves all M3+ doors open. It is not the only defensible answer — the burnitall reports are explicit that the user must pick — but it is the cheapest defensible answer for someone optimizing for "ship M1.5 fast, defer M3-M5 commitments."

---

## STATUS: DONE
