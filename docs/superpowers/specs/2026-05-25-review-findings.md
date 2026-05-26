# Strategy Doc Review — Consolidated Findings

Five independent review agents pressure-tested
`2026-05-25-apple-multiplatform-and-rust-pivot.md` from five angles:
App Store policy, Rust architecture, Apple native dev, competitive
landscape (Plex/Jellyfin/Emby), and gap/operational risk. This doc
collapses their findings into a single source of truth.

## Tier 1 — Factual errors in the doc that must be corrected

| # | Doc says | Reality | Source agent |
|---|---|---|---|
| 1 | TiviMate is on the iOS App Store as precedent for IPTV-capable apps | **TiviMate is Android/Fire OS only — never iOS.** Replace with GSE Smart IPTV Player (id6444845680), IPTV Smart Player (id6448987395), IPTV Player Live: M3U & Xtream (id1662299469), OttPlayertv (id1672208961), Infuse, VLC. | App Store policy |
| 2 | Plex is precedent because it integrates IPTV providers | **Plex's iOS app supports licensed HDHomeRun OTA tuners — NOT Xtream/M3U.** M3U/IPTV requires xTeVe/Threadfin bridges that Plex doesn't ship. Plex is weaker precedent than the doc implies. | App Store policy |
| 3 | Apple Sign-In MUST be offered if third-party sign-in is offered | **Rule was relaxed Jan 26, 2024.** Apps can offer SIWA OR another "equivalent privacy-focused login service." Plex PIN OAuth alone is plausibly compliant. Only add SIWA if a tracking-prone social login is added later. | Apple native dev |
| 4 | sqlx and rusqlite are interchangeable for SQLite | **They're not.** SQLite is single-writer. `sqlx::SqlitePool` with default `max_connections>1` deadlocks on writes. Correct: split pools — writer pinned to `max_connections(1)`, reader configurable — OR rusqlite + a single writer thread behind `spawn_blocking`. | Rust architecture |
| 5 | "ffmpeg-next FFI for ffprobe" | **Wrong.** ffmpeg-next is maintenance-only and trails upstream by ~6 months. Just `tokio::process::Command::new("ffprobe").arg("-print_format").arg("json")` and parse the JSON — same pattern as Jellyfin. | Rust architecture |
| 6 | Single static Rust binary distribution | **Static-linking ffmpeg = GPL contamination via x264/x265.** Realistic answer: ship a Rust binary that shells out to a separately-distributed ffmpeg. Same model as Plex / Jellyfin. | Rust architecture |
| 7 | "~85% shared code between iOS and tvOS targets" | **Realistic is 60-70%.** Swiftfin and Plex both report this. Focus engine, navigation patterns, modal idioms, and 10-foot vs 1-foot typography all diverge. | Apple native dev |
| 8 | Current ffmpeg `-c copy -f hls` remux gives ~3-4s live latency | **Real-world is 8-12s** — same as Plex. Sub-4s requires CMAF + EXT-X-PART (true LL-HLS). Not in the current spec; needs to be added if live latency matters. | Apple native dev |
| 9 | M4 transcoder = 2-3 months | **Realistic is 6-9 months.** Jellyfin took ~3 years to ship stable hardware accel; `jellyfin-ffmpeg` exists precisely because upstream FFmpeg has too many edge cases. Solo dev in Rust ~6-9 months for HEVC/HDR/PGS/multi-audio reliably. | Competitive |
| 10 | M3-M5 total ≈ 6 months | **Realistic 12-18 months.** Direct-play-only MVP at end of M3 is shippable and not-shameful (Infuse ships in that shape). | Competitive |

## Tier 2 — Risks the doc misses

### App Store survival is a 12-month problem, not a review-day problem

The doc focuses on getting through initial review. Real risk is **post-launch
DMCA-style takedowns from rights holders**, bypassing Apple's normal review
flow:

- IPTV Smarters Pro / XCIPTV / Televizo / VU IPTV / XTV Ultra — all pulled
  from iOS App Store in 2024-2026 via direct complaint-to-platform, not
  review-day rejection.
- JioStar's March 2026 ICC T20 action took down 36 IPTV apps in one sweep
  via complaint, across both Google Play AND iOS.

Approval probability estimates (App Store agent):
- **~70-75%** initial-review approval with the hardened framing (no IPTV
  keywords in listing, no branded channel screenshots, reviewer demo
  server with only public-domain content).
- **~45-55%** 12-month survival probability after launch.

### Mitigations not currently planned

1. **Server-side kill switch.** A feature flag that disables `/api/iptv/*`
   and downgrades the app to personal-media-only within minutes, in case
   a rights-holder complaint hits.
2. **The "compile-flag insurance build" should become the DEFAULT submitted
   artifact**, not the fallback. Ship the personal-media-only build to the
   App Store; users enable IPTV on their own self-hosted server, invisible
   to App Store review. App stays a generic media client.
3. **Never put branded streaming keywords anywhere** the app's developer
   identity touches: app name, App Store description, marketing site,
   social posts, support docs. No "IPTV", "M3U", "Xtream Codes", "live TV"
   in user-facing copy. Use "self-hosted personal media server client" /
   "your own media library and providers."

### Operational gaps (BLOCKER before M2 starts)

1. **No observability / operator-experience plan.** No structured logging,
   no admin diagnostics surface, no crash reporting decision. When ffmpeg
   dies / a scan hangs / a remux session leaks PIDs, the operator has no
   UI. Need before M2: structured logs (`tracing` + `tracing-subscriber`),
   `/api/admin/diagnostics` endpoint, a "view server logs" tab in the
   admin UI, decision on Sentry vs Glitchtip vs local-only.
2. **No TLS strategy for self-hosters.** Apple ATS rejects self-signed
   certs and plain HTTP. Three real operator paths — Cloudflare Tunnel,
   Tailscale, LAN-only Let's Encrypt DNS-01 — each have different UX.
   Decide which is "officially supported"; document the others.
3. **First-run pairing UX is undefined.** Apple TV + Siri Remote = brutal
   text entry. Need a QR-pairing flow from phone, or Bonjour `_emerald._tcp`
   advertisement for same-LAN discovery, or NearbyInteraction/Handoff
   push from iPhone to TV.
4. **License decision.** Repo has no LICENSE file. Going GPL prevents
   commercial fork without contribution-back; MIT enables white-label.
   One-way door — pick before any binary leaves the laptop.

### Operational gaps (HIGH, address in M3-M5)

5. **Mobile downloads / offline playback.** Missing from M2-M6 entirely.
   App Store users expect it; Plex Pass users actively switch *away from
   Jellyfin* because Jellyfin's offline story is rough. Table-stakes
   feature. Plan it explicitly into M5 or write "no offline downloads"
   into the App Store description.
6. **Backup / disaster recovery.** Three SQLite DBs, no backup story.
   `POST /api/admin/backup` → consistent tarball via `VACUUM INTO`;
   restore command; data export in portable JSON Lines so users can
   leave for Jellyfin/Plex if they choose. Matters for trust even if
   nobody uses it.
7. **Version skew handling.** Server v1.2 + native app v1.4 = inevitable.
   `/api/version` endpoint, min-server-version check in the app, max-
   client-version 426 response from server. Currently undefined.
8. **DDoS / brute-force on Plex PIN auth.** No rate limits on
   `/api/auth/device/start` or grant endpoints. Self-hosters with
   publicly-accessible servers need fail2ban-style temp bans.
9. **Subtitle pipeline undersized.** AVPlayer cannot render ASS subtitles
   (Jellyfin's #1 user complaint), zero support for PGS/VOBSUB image-based
   subs. Server MUST burn-in PGS or convert text subs to WebVTT. Add to
   M4 explicitly.

### Operational gaps (MEDIUM/LOW, M5+)

10. Multi-user content gating (kids' library) — schema slot reserved but
    no auth-claim flow defined.
11. Privacy nutrition labels assume "data not collected" — but the
    recommender does behavioral profiling locally on the server, and
    crash reporting (if added per #1) needs declaration.
12. Legal: Terms of Service for self-hosters ("you are responsible for
    content on your server"), EULA for App Store users.
13. Docs/community/support load — at minimum a docs site + "Report a
    problem" button that bundles diagnostics.
14. Brand uniqueness check — "Emerald Exchange" against existing App
    Store names before any binary ships.
15. Cost ceiling — $99/yr Apple + ~$1500 hardware floor (Apple TV 4K,
    test iPhone, test iPad, NAS or Mac Mini). Not a blocker, but write
    it down.
16. Burnout safety: M2+M3 (Apple apps + library, no transcoder) is a
    shippable product. Direct-play only is real — Infuse ships in that
    shape and people pay for it. Document this stopping point.

## Tier 3 — Competitive positioning recommendation

Of the four value props the doc considers, defensibility ranking from the
competitive agent:

1. **"Best Apple-native client of any self-hosted media server."** Most
   defensible. Swiftfin tvOS is stalled, Plex's redesign is publicly on
   fire (2025 redesign caused widespread playback regressions, downloads
   broke, custom server URLs removed, music exiled to PlexAmp). Polished
   tvOS+iOS app with proper focus engine, PiP, AirPlay, AVPlayer-native
   track switching is a 12+ month moat.
2. **Single-binary self-host (Rust).** Wedge against Jellyfin's
   intimidating Docker setup.
3. **Unified IPTV + personal media.** Real differentiation for the 5-15%
   of self-hosters who have IPTV; Plex dropped this, Jellyfin's LiveTV
   plugin is unmaintained.
4. **Cross-source "available on" recommender badges.** Least defensible —
   no evidence of demand outside the founder. Build because it's already
   shipped, don't lead with it.

**Recommended primary positioning:**
> "The Apple-native self-hosted media server. One app. Your media,
> your IPTV, your server."

Lead with Apple polish + single-binary install. Treat IPTV unification as
the bonus feature. Treat the recommender as table decoration.

**Market opening is real:** Plex's 2025 paywall rollout (remote streaming
$1.99/mo intro → $2.99/mo and $29.99/yr; lifetime Plex Pass doubled to
$249.99) has produced active user churn. Engadget, 9to5Mac, HowToGeek
all treat it as a watershed moment for self-host alternatives.

## Tier 4 — Open questions answered (replaces Section 10 of the doc)

The strategy doc ends with five open questions. The Apple native dev
agent's recommended answers:

1. **$99 individual vs org membership.** **Individual.** SIWA works fine
   on individual. Org is needed only for multiple App Store Connect
   roles or wanting the legal-entity name (not personal) on the store
   page. Convert later if needed.
2. **TestFlight scope.** **Internal first (100 users, no review, fast
   iteration), external public link once stable.** External public-link
   route gives anonymous signup with no per-tester email collection,
   10k cap, ~24-48h beta review per first build of a version train.
3. **Plex auth fallback.** **Yes, support local-only auth mode** via
   `auth_mode = local | plex | both` server flag. Required anyway for
   App Review (reviewer cannot create a Plex account on demand).
4. **Server binary distribution.** **GitHub Releases for v1, brew formula
   in own tap for v1.1.** Notarize each release; don't ship unsigned
   binaries (Gatekeeper friction kills installs).
5. **Multi-server support.** **Single-server v1, multi-server in M6.**
   But build device-token storage with `server_id` already in the
   schema so it's not a migration later.

## Tier 5 — Concrete edits the strategy doc should get

Numbered by section in `2026-05-25-apple-multiplatform-and-rust-pivot.md`:

**§ Locked decisions (table):**
- Decision E: replace "iPad shares iOS target — no separate iPad target" with
  "Single iOS target, but iPad gets dedicated NavigationSplitView layouts
  and iPad-specific interaction handling. One binary, not one layout."

**§ 1 Project structure:**
- Drop "~85% shared code" → "~70% shared (EmeraldKit). Per-target view
  layer expected to remain ~30%."
- Add Universal Purchase (single bundle ID across iOS + tvOS) explicitly.

**§ 2 Auth flow:**
- Replace 2020 SIWA-required language with the post-Jan-2024 rule.
- Add `auth_mode` server config flag: `local | plex | both`.
- Reviewer demo server must use `local` mode.

**§ 3 Player layer:**
- Add explicit subsection on subtitle handling: SRT direct play, ASS via
  libass renderer on tvOS (or burn-in), PGS/VOBSUB server-side burn-in.
- Add LL-HLS section: current `-c copy -f hls` = 8-12s latency. LL-HLS
  (CMAF + EXT-X-PART) is an M4 stretch item; current path stays for v1.
- Add Bonjour `_emerald._tcp` discovery + QR-pair-from-phone first-run
  flow.

**§ 5 App Store policy hardening — major rewrite:**
- Update precedent list: GSE Smart IPTV Player, IPTV Smart Player,
  IPTV Player Live, OttPlayer, Infuse, VLC. **Remove TiviMate.**
- Make compile-flag IPTV-disabled build the **default submitted artifact**,
  not insurance.
- Server-side kill switch for `/api/iptv/*` documented.
- Match disclaimer language verbatim from approved apps: "X does not
  provide any content or playlists. Designed for users' own legally
  licensed content."
- Approval probability: ~70-75% initial, ~45-55% 12-month survival.

**§ 6 Distribution matrix:**
- macOS server binary: Developer ID Application cert + notarization,
  $0 additional cost.
- Build pipeline: GitHub Actions matrix (macos-14 + ubuntu-24.04 +
  windows-2022), `cargo-dist` for installers.
- TestFlight 90-day expiry calendar reminder.

**§ 7 Rust pivot stack — rewrite:**
- HTTP: `axum 0.8.x` + `tower-http 0.6.x` (trace, cors, compression,
  timeout, request-id).
- SQLite: `sqlx 0.8.x` with **split reader/writer pools** (writer
  pinned to `max_connections(1)`). Or rusqlite + `spawn_blocking` if
  compile-time-checked queries cause friction.
- ffmpeg: **subprocess only**, no FFI. `tokio::process` + `kill_on_drop(true)`.
- Distribution: tiny Rust binary + documented ffmpeg dependency,
  **NOT** statically linked ffmpeg.
- Observability: `tracing` + `tracing-subscriber` + `tower-http::trace`
  from day one.

**§ 7a (new): FFmpeg distribution model.**
- ffmpeg/ffprobe are runtime dependencies, not bundled.
- macOS: detect Homebrew install or bundle a signed sidecar.
- Linux: require system ffmpeg ≥ 6.0.
- Windows: bundle pinned Gyan build.

**§ 8 Transcoder refinements:**
- Capacity matrix already corrected.
- Add: process lifecycle. `Command::kill_on_drop(true)`, supervisor task
  with backoff, stderr → `tracing` at warn level, idle sweep at 5s
  (mirror M1's `iptvRemux.ts` pattern line-for-line).
- AVPlayer stress test on tvOS, not just browser (HEVC + Dolby Vision
  edge cases).
- M4 timeline: **6-9 months**, not 2-3.

**§ 9 Sequencing:**
- Total M3-M5: **12-18 months**, not 6.
- Add M5.5 explicit insurance build prep.

**§ 10 Open questions:**
- All five answered (see Tier 4 above). Replace the list with the
  answers + the assumptions behind them.

**§ NEW (after Locked Decisions): Operational concerns.**
- Logging + telemetry decision.
- TLS strategy for self-hosters.
- Backup/restore.
- Version skew handling.
- Rate limiting.

**§ NEW (after Operational): Legal + License.**
- LICENSE file (GPL vs MIT vs proprietary — decide before any binary ships).
- ToS for self-hosters.
- EULA for App Store users.
- Adult-content gating enforcement via existing `is_adult` flag.

**§ NEW (after Sequencing): Minimum viable product if the project stalls.**
- M2 + M3 alone (Apple apps + media library, no transcoder) is shippable.
- Direct-play-only is a real product (Infuse model).
- Document this stopping point so the user knows where the "good enough"
  line is.

## Tier 6 — Highest-conviction "do this now" list (pre-M2)

If only ten things get done before M2 kickoff:

1. Fix the TiviMate factual error in the strategy doc.
2. Drop the static-ffmpeg dream — pick the sidecar model.
3. Pick `sqlx` split-pool OR `rusqlite` + spawn_blocking and write it
   into the doc explicitly.
4. Pick a license (GPL vs MIT). One-way door.
5. Decide the official TLS-for-self-hosters story (Tailscale, Cloudflare
   Tunnel, or both).
6. Pick observability stack (`tracing` is the obvious answer).
7. Move the compile-flag-no-IPTV build to default-submitted-artifact.
8. Draft the disclaimer language for the App Store listing (verbatim
   from GSE Smart IPTV Player + IPTV Smart Player).
9. Adjust the M4 budget to 6-9 months and total roadmap to 12-18.
10. Document the "M2+M3 is a shippable MVP if M4 burns the user out"
    fallback.

---

**Source agents** (all completed 2026-05-25):
- App Store policy precedent
- Rust media server architecture
- Apple native dev
- Plex/Jellyfin/Emby competitive
- Gap + operational risk

**Source documents reviewed:**
- `docs/superpowers/specs/2026-05-25-apple-multiplatform-and-rust-pivot.md`
- `docs/superpowers/specs/2026-05-24-mybunny-and-plex-replacement-design.md`
