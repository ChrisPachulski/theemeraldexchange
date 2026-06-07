# theemeraldexchange — High-Level TODO

_Last updated: 2026-06-07. The single at-a-glance worklist. Detail lives in the
linked docs; this file is the map, not the territory. Keep it short — promote
items here, demote detail to the source docs._

**Authoritative detail docs**
- [docs/ROADMAP-STATUS.md](./docs/ROADMAP-STATUS.md) — honest per-milestone state (M1–M6).
- [docs/PRODUCTION-READINESS-2026-05-30.md](./docs/PRODUCTION-READINESS-2026-05-30.md) — historical 80-finding review ledger. Re-verify against code/CI before treating any row as current.
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

- [x] **Deployed M4 transcode proven (2026-06-07).** The deployed enforce-mode
      transcoder now transcodes a real non-direct-play library file and serves
      `ffprobe`-validated H.264/AAC HLS end-to-end (docs/M4-TRANSCODE-VERIFICATION.md;
      harness scripts/m4-transcode-proof.sh). Found+fixed a `/scratch` tmpfs
      EACCES bug that meant it had never actually transcoded.
- [ ] **Exercise a real player against the M4 path** (web SPA / native). The
      proof validates serving + output bytes, NOT a client consuming the stream —
      that player path is the remaining true-"playback" step (folds into the SPA
      media-core consumer item below and M5).
- [ ] **Unblock `/media/Movies` for the service uids.** Movies is `0700 uid 99`
      on the NAS, so neither media-core (10002) nor transcoder (10003) can read
      it — most of the library is unservable until the share is loosened or the
      services run as the media-owning uid (ops decision; see M4 doc §bugs).
- [ ] **Build the M4 stress/bench harness on NAS hardware** (non-optional per
      spec) → capture CPU/latency for crit 2/3/6. `TRANSCODER_FORCE_CPU=1`
      already exists; the remaining gap is measurement evidence.
- [ ] **Wire the web SPA media-core consumer** (`grant`/`stream`/`watch` in
      `mediaApi`). M3 is live in enforce mode but **no client consumes
      `/api/media/*`** — crit 4/5 can't be demonstrated until one does. This is
      the pre-Apple way to prove M3.
- [ ] **Add M3 measurement harnesses.** 100-file `<5s` scan-timing fixture
      (crit 2) and a TMDB match-accuracy eval (crit 3). The matcher now scores
      candidates by stopword-aware title similarity and rejects zero-overlap hits
      (crates/media-core `tmdb.rs`), but the accuracy eval that would actually
      falsify crit 3 still doesn't exist.

## P1 — Close the contract & infra loose ends

- [x] **Production internal-principal posture verified (2026-06-07).**
      `docker-compose.yml` now defaults media-core + transcoder to
      `MEDIA_INTERNAL_PRINCIPAL_MODE=enforce` (fail-closed, matching the
      recommender); prod confirmed already running enforce.
- [ ] **HIGH-3 (partial): recommender entrypoint `chown` under `cap_drop: ALL`.**
      Still flagged partial in the readiness ledger — confirm fresh-volume boot
      doesn't crash-loop.
- [ ] **Refresh the readiness tail** — the 2026-05-30 ledger is historical and
      contains stale rows now closed by code/CI. Re-run a current review before
      using its medium/low counts for planning.

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
