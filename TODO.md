# theemeraldexchange — High-Level TODO

_Last updated: 2026-06-13. The single at-a-glance worklist. Detail lives in the
linked docs; this file is the map, not the territory. Keep it short — promote
items here, demote detail to the source docs._

**Authoritative detail docs**
- [docs/ROADMAP-STATUS.md](./docs/ROADMAP-STATUS.md) — honest per-milestone state (M1–M6).
- [docs/PRODUCTION-READINESS-2026-05-30.md](./docs/PRODUCTION-READINESS-2026-05-30.md) — historical 80-finding review ledger. Re-verify against code/CI before treating any row as current.
- [README.md](./README.md) · [PRODUCT.md](./PRODUCT.md) · [DESIGN.md](./DESIGN.md) · [DEPLOY.md](./DEPLOY.md)

---

## Update 2026-06-13 — landed since the 06-10 freeze (not yet folded into the lists below)

The milestone skeleton below is still directionally correct, but it predates
~35 commits. None of the open P0/P1 items got done; what shipped is polish,
stability, and infra:

- **Streaming-stability wave (06-11/12, ~15 commits).** Playback-bar redesign on
  the emerald design system; fullscreen fixes; resume-or-start-over prompt +
  absolute-timeline-on-resume; 20 s fresh-HLS startup-stall fix (`5e95faa`); HLS
  timeline pinned to the grant's known duration (`53ed1f4`); forward-seek past
  the produced edge re-grants instead of dying (`a8f3c09`); HLS segment length
  halved 4→2 s for faster startup (`25d84da`). ⇒ The P0 "real player — DONE
  (2026-06-08)" line is true but predates this wave — read it as *working,
  hardened over the following 4 days*, not *settled on the 8th*.
- **Recommender:** KNN `k` clamped to sqlite-vec's 4096 cap — every `/score` was
  500ing (`46f8a20`).
- **Scanner:** TMDB remake-collapse + year-token + extras-dir ingestion fixed
  (`11b2454`).
- **CI/infra (06-13):** Dependabot grouped to cut weekly branch churn; auto-merge
  routine for low-risk bumps (majors + cargo-minors stay manual); `main` CI-gate
  ruleset added with owner-bypass so a red commit can't silently land; two
  process-spawn flaky tests de-flaked.
- **Backend feature wave (06-13).** (a) Device-token contract drift fixed (live
  tokens would have failed to decode). (b) **TMDB match-accuracy eval shipped
  (M3 crit-3)** — 24-case corpus driving the real selection logic, 24/24, as a
  regression floor (`2c19038`). (c) **Sidecar `subtitles.vtt` shipped end-to-end**
  (`735294b`+`40c3147`): a one-shot ffmpeg extraction writes a complete WebVTT
  served by the owner-bound asset route; media-core/Node/SPA thread it through
  and the player renders a `<track>` (forced auto-shows). Remaining: a non-forced
  in-player toggle + live NAS/browser proof (CORS on the `.vtt` at the edge, cue
  rendering) — both browser-bound.
- **Re-measure before trusting:** the gate counts below (vitest 1793 / cargo 310 /
  pytest 189) are a 06-10 snapshot, and the crit-6 ~23–27 s seek figure now also
  predates the 4→2 s segment halving. Both need a fresh run, not a copy-forward.

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
- [x] **Real player against the M4 path — DONE (2026-06-08).** The web SPA's
      `MediaPlayer` plays transcoded HLS in a real Chrome over the full public
      path (laptop → Cloudflare → cloudflared → backend `/api/transcode` proxy →
      media-core → transcoder), including resume. Proof harness:
      `scripts/media-playback-proof.sh`. Four grey-box-at-0:00 root causes were
      found+fixed along the way (keyframe cadence, non-AAC audio, inline
      subtitles under `-re`, multichannel-AAC MSE rejection — `0cda2f4`,
      `977f892`, `f091d41`, `d1fc9a7`).
- [x] **`/media/Movies` unblocked — DONE (2026-06-07).** The share was loosened
      `0700` → `0755` (`chmod a+rX`), so media-core (10002) and transcoder
      (10003) can read the full movie library.
- [x] **Wire the web SPA media-core consumer — DONE (2026-06-07).**
      `src/lib/api/media.ts` exposes grant/watch/stop (+ paged
      `allMovies`/`allShows`) and `src/components/media/MediaPlayer.tsx` is wired
      into the Movies and TV tabs. M3 crit 4/5 are demonstrable on the web; the
      cross-platform (tvOS) half stays Apple-blocked.
- [x] **Intel VAAPI hardware transcode — SHIPPED (2026-06-08).** The transcoder
      image moved from static ffmpeg to Debian's stock ffmpeg + the Intel VAAPI
      stack; `h264_vaapi` is the primary encoder (boot smoke-test demotes to
      libx264 when no GPU), with a full-HW decode→tone-map→scale pipeline behind
      a source-codec allowlist + boot probe (`8d4c373`). 3 concurrent
      HEVC→H.264 GPU sessions proven on the NAS iGPU.
- [ ] **Build the M4 stress/bench harness on NAS hardware** (non-optional per
      spec) → capture CPU/latency for crit 2/3/6. `TRANSCODER_FORCE_CPU=1`
      already exists and 3 concurrent GPU sessions were proven informally
      (2026-06-08), but the formal measurement evidence still doesn't exist —
      and the crit-6 seek number (~23–27 s) predates the VAAPI pipeline and
      needs re-measuring.
- [x] **M3 scan-timing harness (crit 2) DONE (2026-06-14, `65e3fc3`).** The
      `scan_once_100_file_library_under_5s` test now drives the REAL `scan_once`
      orchestration over a 100-file fixture (walk + stat + classify + the
      movie/episode upserts + prune/GC) via a deterministic ffprobe stub, so all
      100 files actually probe + index and the test asserts `files_added == 100`,
      `errors == 0`, and `<5s` — exercising the DB write path, not just the
      walk-then-error path the prior empty-file guard took. Measured well under
      1s locally. **(crit 3 DONE 2026-06-13** — the TMDB match-accuracy eval now
      exists: a 24-case corpus drives the real selection logic in
      `crates/media-core/tmdb.rs` and asserts a 100% accuracy floor, `2c19038`.)

## P1 — Close the contract & infra loose ends

- [x] **Repo-wide hardening wave 1 (2026-06-10).** Transcoder session
      lifecycle + principal ownership, media-core scanner/probe/db hardening,
      suggestions.ts decomposed into nine services, stream-token single-key
      (dual-key fallback removed), recommender scoring tests. Gates green:
      vitest 1793 / cargo 310 / pytest 189. Detail in
      [docs/ROADMAP-STATUS.md](./docs/ROADMAP-STATUS.md) §Update 2026-06-10.
- [x] **Production internal-principal posture verified (2026-06-07).**
      `docker-compose.yml` now defaults media-core + transcoder to
      `MEDIA_INTERNAL_PRINCIPAL_MODE=enforce` (fail-closed, matching the
      recommender); prod confirmed already running enforce.
- [x] **HIGH-3 DONE (2026-06-13/14): recommender fresh-volume cold-boot.** Three
      mitigations landed — `scripts/deploy-nas.sh` pre-creates + pre-chowns the
      sidecar DB bind-mount dirs (uid 10001/10002) before `compose up`, `29d85be`
      fixed the fresh-DB migration ordering, and `939ddce` fixed the actual
      cold `/data`-volume crash-loop (entrypoint needed `DAC_OVERRIDE` to chown
      under `cap_drop: ALL`). A fresh-volume cold-boot regression test + docker
      proof now pin it (`13ed8b5`, `c3ae48f`), reading the freshly-migrated DB as
      the recommender uid — so the crash-loop can't silently return.
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

- [ ] **ffmpeg / GPL licensing.** The transcoder now ships Debian's apt ffmpeg +
      the Intel VAAPI stack (`h264_vaapi` primary, libx264 boot-probe fallback);
      the backend and media-core images still `COPY` the static
      `mwader/static-ffmpeg:7.1` binary. Both builds enable GPL x264, so for
      App-Store/paid distribution the licensing question is unresolved either
      way — not yet addressed anywhere in the repo.
- [ ] **IPTV distributability.** The M5.5 policy already makes the
      IPTV-disabled compile-flag build the default public artifact (good); treat
      any monetized build's IPTV surface as a standing legal/compliance risk.

---

## Doc hygiene

- [x] **DEPLOY.md refreshed (2026-06-10).** Now documents the real
      `deploy-nas.sh` behavior (git-archive-HEAD staging, clean-tree guard,
      `EEX_RELEASE` drift detection, full-stack rollback tags + health gate,
      cloudflared restart), the 9-service first boot including Glitchtip
      secrets-before-first-up, and the node-not-curl health probe.
- [ ] **LICENSE** is the proprietary placeholder (intentional defer to M2
      TestFlight / first binary distribution). Revisit when the first artifact ships.
