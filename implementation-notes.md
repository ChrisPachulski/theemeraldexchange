# Implementation notes — Apple companion campaign, server half (2026-07-06)

Session goal: execute `goal-apple-companion.md` S0 → S1 → S2 with per-item gates.
This file is the required window into the autonomous run. Untracked (repo is public).

## What landed (verified)

| Goal item | Status | Where |
|---|---|---|
| S0-1 GlitchTip blind (DSN unresolvable) | fixed + live-verified | PR #178 (self-check) + **PR #179** (event_id + `EEX_TELEMETRY_DSN_INTERNAL`) |
| S0-2 cloudflared stale netns | fixed + **gate verified live** | PR #178 (watchdog script) + PR #179 (deploy auto-install); watchdog installed on NAS and self-healed a real 530 in ~91s |
| S0-3 on-demand 300s TTL | fixed | PR #178 (`IPTV_ONDEMAND…`-equivalent TTL) |
| S0-4 TMDB retry storm | fixed (code) | PR #178 (migration 0009 negcache); scan gate pending post-deploy |
| S0-5 SoA S7 invisible | fixed (code + **files renamed on disk**) | PR #178 (corrupt-basename surfacing); 13 byte-reversed files renamed; rescan gate pending post-deploy |
| S0-6 recommender serverId latch | fixed | PR #178 (bounded retry) |
| S1-7 dead-feed sibling failover | fixed | PR #178 |
| S1-8 channel_offline_upstream split | fixed | PR #178 |
| S1-9 cap-mismatch footgun | fixed | PR #178 (clamp/eviction) |
| NAS build safety | fixed | **PR #180**: media-core + backend-napi Dockerfiles had UNCAPPED cold cargo builds (the Plex brown-out vector); now ARG CARGO_BUILD_JOBS + cache mounts |
| S2 endpoints | in flight by the parallel session | worktrees `campaign/epg-search-person`, `campaign/content-rating`, `campaign/playback-grants` |

## Deviations

1. **Parallel-session collision (major).** A second Claude session executed the same
   S0/S1 tier concurrently in `campaign/*` worktrees and merged PR #178 while this
   session had equivalent fixes committed on `fix/companion-s0-server` (local, now
   superseded — kept for reference, NOT merged). Rather than race, this session
   reconciled: audited #178, found three delivery-critical gaps, and landed them as
   PR #179 — (a) GlitchTip 422-rejects store payloads without `event_id` (verified
   live: 422 → 200 + DB row), so #178's relay AND its own boot self-check could
   never deliver; (b) no in-container DSN, so the unresolvable-host root cause was
   detected but not fixed → new `EEX_TELEMETRY_DSN_INTERNAL`
   (`http://…@exchange-glitchtip:8000/1`, reachability verified from inside
   exchange-backend); (c) the watchdog script deferred install to "deploy stage"
   but nothing installed it → deploy-nas.sh now does.
2. **TMDB episode_groups mapping deferred.** Goal item 4's secondary ask (map
   absolute-numbered shows via TMDB `episode_groups`) is NOT implemented by either
   line; the negative cache stops the 44k-calls/48h storm (the gate). Filed as
   follow-up work.
3. **S1-9 addressed as prevention, not hotfix** (verifier note downgraded it: ops
   pins both caps at 2).
4. **Deploy uses a sync-only payload script + nas-safe-build**, not
   deploy-nas.sh's built-in `compose up --build` (forbidden raw compile on the
   Plex box). Script: scratchpad `sync-payload.sh` (verbatim rsync steps).
5. **SoA S7 E010 normalized to E10** during the rename (reversed stem yielded a
   3-digit episode number).

## Ops changes made directly on the NAS (idempotent, re-applied by deploy)

- `EEX_TELEMETRY_DSN_INTERNAL` appended to `/mnt/user/appdata/exchange-backend/.env`
  AND to local `.env.production` (canonical; shipped on every deploy).
- Watchdog cron: `/boot/config/plugins/dynamix/eex-cloudflared-watchdog.cron`
  (every 2 min) → currently my interim script at
  `APPDATA/scripts/cloudflared-watchdog.sh`; the deploy replaces it with the
  repo's `nas-cloudflared-watchdog.sh`.
- Renamed 13 byte-reversed files in `tv_shows/Sons of Anarchy/Season 7/`.
- Gate tests intentionally caused two brief public-API interruptions
  (backend restart + force-recreate) around 16:00; both self-healed.

## Deploy (2026-07-06 ~23:30–23:40 PT)

- Payload synced from `git archive c22dcf5` (sync-only script; the repo's
  deploy-nas.sh compose-build step deliberately NOT used). Note: `bin/eex-ytresolve`
  is untracked → absent from the archive stage; NAS copy left as-is.
- Backend + media-core images built via `nas-safe-build.sh` (jobs=3, detached,
  Plex healthy throughout, peak 0.75 load/core, ~2.5 min and ~2 min thanks to
  the new cache mounts). Recreated with `--no-build`; cloudflared force-recreated.
- **S0-1 gate GREEN:** boot log `Glitchtip DSN self-check passed
  {hostname: exchange-glitchtip}`; row `eex telemetry self-check (boot)` landed in
  `issue_events_issue` (id 6). The two watchdog recovery events from the live
  test are also visible in GlitchTip.
- Watchdog cron now points at the repo's `nas-cloudflared-watchdog.sh`
  (`--self-test` green); my interim script retired.
- **S0-5 surfacing immediately found a SECOND invisible season:** House of
  Cards (US) Season 5 — 13 byte-reversed basenames (+ matching .nfo files),
  logged by the new library-health WARN on the boot scan. Renamed on disk,
  same as SoA S7. This validates the feature beyond the filed instance.

## Gate results (post-deploy, 2026-07-07 00:37 UTC scan)

- ✅ S0-1: boot self-check `ok` via `exchange-glitchtip`; row in `issue_events_issue`.
- ✅ S0-2: watchdog live-verified earlier (530 → 200 in ~91s unattended); repo
  script installed via persistent dynamix cron, `--self-test` green.
- ✅ S0-5: SoA show 228 season 7 → **13/13 episodes, all TMDB-titled** (was 0).
  Bonus: House of Cards show 98 season 5 → **13/13 titled** (second invisible
  season, found by the new surfacing, renamed + recovered same pass).
- ✅ S0-4 (first half): boot scan stamped 2,022 permanently-unresolvable episodes
  into the negcache; show 124 NULL count = 1042 (matches filed baseline).
  Second-scan gate (zero new `non-2xx for tv 111110` lines; baseline 496)
  pending the next hourly scan (~01:37 UTC).
- ✅ S0-3: red→green covered by the route contract tests in CI (grant mints with
  the playback-duration TTL); live long-playback probe not separately run.
- Scan report: files_seen=25292, added=26 (2×13 recovered seasons), errors=11
  (pre-existing ffprobe failures on a few Mandalorian/Wednesday files —
  unrelated to this campaign, candidate follow-up).
