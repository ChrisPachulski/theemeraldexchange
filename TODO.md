# theemeraldexchange — High-Level TODO

_Last updated: 2026-05-31. The single at-a-glance worklist. Detail lives in the
linked docs; this file is the map, not the territory. Keep it short — promote
items here, demote detail to the source docs._

**Authoritative detail docs**
- [docs/ROADMAP-STATUS.md](./docs/ROADMAP-STATUS.md) — honest per-milestone state (M1–M6).
- [docs/PRODUCTION-READINESS-2026-05-30.md](./docs/PRODUCTION-READINESS-2026-05-30.md) — 80-finding review ledger; all crit/high fixed, ~63 medium/low open.
- [scripts/autoloop/README.md](./scripts/autoloop/README.md) — the autonomous codex mesh (P0–P1 done, P2–P5 pending).
- [README.md](./README.md) · [PRODUCT.md](./PRODUCT.md) · [DESIGN.md](./DESIGN.md) · [DEPLOY.md](./DEPLOY.md)

---

## The one constraint that orders everything

The project splits into a **buildable-now backend track** and an
**Apple-blocked client track**. Xcode is not installed and the Apple Developer
Program membership (purchased 2026-05-29) is pending activation. Until that
gate clears, **every native target (M2, M5) and the monetization tail (M6) are
hard-blocked** — there are zero `.swift` files in the repo. Do the backend work
now; it is the only thing the Apple gate does not block.

---

## P0 — Buildable now, highest leverage (no Apple dependency)

- [ ] **Prove M4 end-to-end.** Run real ffmpeg against a real non-direct-play
      library file under the deployed transcoder and capture one verified
      transcode+play. The code is deployed + 55 tests green but **self-admitted
      stub-verified — no real transcode has ever run.** This is the top unblock:
      it converts M4 from scaffold to real and gates all M5 playback.
- [ ] **Build the M4 stress/bench harness on NAS hardware** (non-optional per
      spec) → capture CPU/latency for crit 2/3/6. Add a `TRANSCODER_FORCE_CPU=1`
      alias or restate crit 5 (the env var does not currently exist).
- [ ] **Wire the web SPA media-core consumer** (`grant`/`stream`/`watch` in
      `mediaApi`). M3 is live in enforce mode but **no client consumes
      `/api/media/*`** — crit 4/5 can't be demonstrated until one does. This is
      the pre-Apple way to prove M3.
- [ ] **Add M3 measurement harnesses.** 100-file `<5s` scan-timing fixture
      (crit 2) and a TMDB match-accuracy eval with title-similarity scoring +
      confidence threshold (crit 3). Both bars are currently unfalsifiable; the
      matcher blindly takes `results.first()`.

## P1 — Close the contract & infra loose ends

- [ ] **M1.5: add the `/api/version` `schemas:{iptv,exchange,media}` block** (§7.2).
      Half-wired today; M2 clients expecting per-DB schema versions get a thin response.
- [ ] **M1.5: add repo-root `.gitattributes`** (`*.sql text eol=lf`, §7.1 hard
      requirement). Mitigated by runtime CRLF→LF normalization, so belt-without-suspenders.
- [ ] **HIGH-3 (partial): recommender entrypoint `chown` under `cap_drop: ALL`.**
      Still flagged partial in the readiness ledger — confirm fresh-volume boot
      doesn't crash-loop.
- [ ] **Burn down the readiness tail** — ~63 medium/low findings open in
      [the ledger](./docs/PRODUCTION-READINESS-2026-05-30.md). All critical and
      high are fixed; triage mediums next.

## P2 — Autoloop substrate (autonomous self-improvement mesh)

See [scripts/autoloop/README.md](./scripts/autoloop/README.md). Runs on **codex**
(flat-rate, never `claude -p`). P0 (engine/guard/node-contract) and P1
(governor/CONTROL.md kill-switch/supervisor/launchd) are landed on `main`.

- [ ] **P2–P5:** orchestrator + team mesh, rotation/handoff at every tier,
      goal-classifier + researcher + auto-immune, propagation + final-synthesis +
      notifications + convergence (`EEX-GOALS-MET`). (First-run orchestrator +
      24h kill + email channel already landed in commit `aafe7c5`.)

## Apple-blocked — cannot start until Xcode installs + Developer Program activates

- [ ] **Create the sibling `theemeraldexchange-apple/` repo** the moment the gate
      clears — Swift work has nowhere to live today.
- [ ] **M2 in full:** EmeraldContracts Swift port (4th binding against the frozen
      vectors) → EmeraldKit SDK → EmeraldTV (tvOS) / EmeraldMobile (iOS) →
      TestFlight pipeline.
- [ ] **M5 native media clients + offline downloads** (needs M2 shipped AND M4
      proven). Offline downloads — the headline M5 capability — has **zero code**.
      M5 UI can develop in parallel now against a mocked media-core API.
- [ ] **M6 Plex-Pass menu** (DVR / intro-credits / music / photos / sharing) —
      selectable only after M5 ships. Correctly not-started.

## Standing risk flags (resolve before any monetized binary ships)

- [ ] **ffmpeg / GPL licensing.** The transcoder ships static ffmpeg + libx264
      (GPL/x264). For App-Store/paid distribution this is an unresolved licensing
      question — not yet addressed anywhere in the repo.
- [ ] **IPTV distributability.** The M5.5 policy already makes the
      IPTV-disabled compile-flag build the default public artifact (good); treat
      any monetized build's IPTV surface as a standing legal/compliance risk.

---

## Doc hygiene

- [ ] **DEPLOY.md** last had a substantive edit 2026-05-23; several operational
      learnings since (cloudflared netns restart-after-recreate, node-not-curl
      healthcheck, SSRF http-redirect allowance) live only in
      [docs/operations/](./docs/operations/) and incident notes. Fold the
      load-bearing ones into DEPLOY.md or link them from it.
- [ ] **LICENSE** is the proprietary placeholder (intentional defer to M2
      TestFlight / first binary distribution). Revisit when the first artifact ships.
