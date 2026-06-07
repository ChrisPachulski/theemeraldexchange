# theemeraldexchange — High-Level TODO

_Last updated: 2026-06-07. The single at-a-glance worklist. Detail lives in the
linked docs; this file is the map, not the territory. Keep it short — promote
items here, demote detail to the source docs._

**Authoritative detail docs**
- [docs/ROADMAP-STATUS.md](./docs/ROADMAP-STATUS.md) — honest per-milestone state (M1–M6).
- [docs/PRODUCTION-READINESS-2026-05-30.md](./docs/PRODUCTION-READINESS-2026-05-30.md) — historical 80-finding review ledger. Re-verify against code/CI before treating any row as current.
- [scripts/autoloop/README.md](./scripts/autoloop/README.md) — autonomous codex mesh design. Treat runtime status files as non-authoritative unless the process is freshly verified.
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

- [ ] **Prove M4 deployed playback end-to-end.** A real-ffmpeg fixture test now
      proves the production argv can emit playable HLS, but the deployed
      transcoder still needs one captured non-direct-play library file
      transcode+play under real NAS/service conditions. This remains the top
      unblock for M5 playback.
- [ ] **Build the M4 stress/bench harness on NAS hardware** (non-optional per
      spec) → capture CPU/latency for crit 2/3/6. `TRANSCODER_FORCE_CPU=1`
      already exists; the remaining gap is measurement evidence.
- [ ] **Wire the web SPA media-core consumer** (`grant`/`stream`/`watch` in
      `mediaApi`). M3 is live in enforce mode but **no client consumes
      `/api/media/*`** — crit 4/5 can't be demonstrated until one does. This is
      the pre-Apple way to prove M3.
- [ ] **Add M3 measurement harnesses.** 100-file `<5s` scan-timing fixture
      (crit 2) and a TMDB match-accuracy eval with title-similarity scoring +
      confidence threshold (crit 3). Both bars are currently unfalsifiable; the
      matcher blindly takes `results.first()`.

## P1 — Close the contract & infra loose ends

- [ ] **Verify production internal-principal posture.** Source and CI prove the
      cross-binding path, but `docker-compose.yml` still defaults media-core and
      transcoder verification to `off`; confirm production env overrides or
      make enforce mode the default.
- [ ] **HIGH-3 (partial): recommender entrypoint `chown` under `cap_drop: ALL`.**
      Still flagged partial in the readiness ledger — confirm fresh-volume boot
      doesn't crash-loop.
- [ ] **Refresh the readiness tail** — the 2026-05-30 ledger is historical and
      contains stale rows now closed by code/CI. Re-run a current review before
      using its medium/low counts for planning.

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
