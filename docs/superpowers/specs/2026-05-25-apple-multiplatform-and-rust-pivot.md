# Apple Multi-Platform Delivery + Rust Server Pivot

## Why this doc exists

Strategic decisions reached on 2026-05-25 that **refine or supersede** parts of
`2026-05-24-mybunny-and-plex-replacement-design.md` (the canonical roadmap).
Future sessions: read both. Where they disagree, this doc wins.

This document absorbed the consolidated five-agent review findings
(`2026-05-25-review-findings.md`) later the same day. Factual errors found in
the first draft are corrected here; new operational sections were added.
The review-findings doc remains the audit trail for what changed and why.

The triggering conversation: live IPTV playback in the browser stutters because
`mpegts.js` is JavaScript demuxing MPEG-TS through MSE. The user wants to (a) ship
native Apple TV / iPad / iPhone apps and (b) eventually replace Plex with a
self-hosted server that can be published to the App Store. That forces explicit
strategic choices about distribution, language, and what's web-only.

## Locked decisions (overrides existing roadmap)

| # | Decision | Why |
|---|---|---|
| A | **One product, one App Store submission.** A single unified app talks to the user's self-hosted server. IPTV is one of several content sources the *server* exposes — the app itself is a thin client that doesn't know or care what mybunny is. | Same shape as Plex's iOS app: user connects their own server, server happens to integrate with HDHomeRun / personal files. IPTV-capable BYO-credentials apps that have passed Apple review and are currently live: GSE Smart IPTV Player (`id6444845680`), IPTV Smart Player (`id6448987395`), IPTV Player Live: M3U & Xtream (`id1662299469`), OttPlayer (`id1672208961`), Infuse, VLC. |
| B | **Rust beachhead at M3.** New services (M3 media-core, M4 transcoder) ship in Rust. M1 Hono backend stays in TypeScript. | Single static binary distribution. Memory safety for 24/7 home server. No throwaway rewrite of working IPTV code. Reconsider consolidation at M6 once media-core and transcoder are stable. |
| C | **Self-hosted only.** Never multi-tenant SaaS. | Same model as Plex. Avoids licensing, hosting, scaling, and most legal exposure. |
| D | **Web SPA is permanent second-class.** | Browser can't beat AVPlayer for media. That's a property of browsers, not our architecture. |
| E | **Native targets: tvOS + iOS universal.** Single iOS target binary; iPad gets dedicated NavigationSplitView layouts and iPad-specific interaction handling on top of that one binary. Apple TV needs its own focus-engine target. | Universal Purchase via one bundle ID across iOS + tvOS so users get a single App Store listing. iPad-as-enlarged-iPhone fails to use the screen well; Plex re-invested in iPad-specific layouts in 2025 for exactly this reason. |

## What's needed to ship as an Apple-platform app

### 1. Repo + workspace structure

Sibling repo `theemeraldexchange-apple/` — keep Xcode artifacts out of the web
repo. Same structure speced in M2 of the existing roadmap, refined:

```
theemeraldexchange-apple/
├── Package.swift                          # SPM workspace root
├── EmeraldKit/                            # shared SwiftUI/Combine SDK
│   └── Sources/EmeraldKit/
│       ├── API/                           # URLSession client, error types,
│       │                                  #   matches Hono / future Rust API
│       ├── Models/                        # Codable mirrors of server DTOs
│       ├── Auth/                          # device-token flow, Keychain
│       ├── Player/                        # AVPlayer wrapper, grant resolver,
│       │                                  #   PiP, AirPlay, multi-room
│       ├── State/                         # Observable stores
│       └── Recommender/                   # availability badge resolution
├── EmeraldTV/                             # tvOS target (focus engine, 10-foot UI)
├── EmeraldMobile/                         # iOS universal target (iPhone + iPad
│                                          #   with iPad-specific layouts)
└── EmeraldApp.xcodeproj
```

**Sharing target ~70% (EmeraldKit).** Per-target view layer is expected to
remain ~30% — focus engine, NavigationStack vs NavigationSplitView, 10-foot
vs 1-foot typography, remote-press gestures vs touch, modal idioms all
diverge. Swiftfin and Plex both report similar ratios. Treat 85% as stretch,
not the plan.

**Universal Purchase**: single bundle ID across iOS + tvOS targets so users
get one App Store listing and one in-app entitlement. Cheap to configure;
strongly recommended.

### 2. Auth flow (multi-platform device token)

Already speced in M2 of the existing roadmap. Re-confirmed here:

```
First launch (no stored device token):
  1. POST /api/auth/device/start   → {pinId, code:"ABCD", verificationUrl:"plex.tv/link"}
  2. Show user the code on screen
  3. POST /api/auth/device/poll    → polls every 2s for authorization
  4. Server runs Plex PIN check + membership gate
  5. On success: issue deviceToken (JWE, aud='device', 1y TTL)
  6. Store in Keychain (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
  7. All subsequent requests: Authorization: Bearer <deviceToken>
```

**Server-side `auth_mode` flag**: `local | plex | both`. Three values
because the App Store reviewer cannot create a Plex account on demand, and
some users won't have one either.

- `local`: server-issued device token without ever touching plex.tv. The
  reviewer demo server MUST run in this mode. Required for App Review.
- `plex`: Plex PIN OAuth flow as above. Default for self-hosters who use
  Plex membership for household gating.
- `both`: user picks at first launch. Reasonable default once we ship.

**Apple Sign-In is NOT mandatory.** Apple relaxed the SIWA requirement
on 2024-01-25: per current App Review Guideline 4.8, apps that offer
third-party sign-in must offer *another* equivalent privacy-focused
option (no email harvesting, no tracking) — SIWA is one option, not
the only one. Plex PIN OAuth alone is plausibly compliant. Only add
SIWA if we later add a tracking-prone third-party login (Google,
Facebook). Sources: Apple Developer News 2024-01-25
(<https://developer.apple.com/news/?id=7j1f99yf>), App Review
Guideline 4.8.

### 3. Player layer

`EmeraldKit/Sources/Player/`:

- `AVPlayer` for ALL content paths (live, VOD, series, media-core local files)
- Native MPEG-TS NOT supported by AVPlayer → live channels go through the
  M1 phase 4b remux path (ffmpeg HLS on the NAS) — already shipped
- Picture-in-Picture (free with AVPlayer)
- AirPlay receiver selection (built into AVPlayer overlay)
- Audio + subtitle tracks (AVPlayer's native track APIs)
- Resume markers via existing `/api/iptv/history` + future `/api/media/watch`

**Subtitles (the rough edge):**

AVPlayer's subtitle support is uneven and gets users to defect to Kodi.
Plan explicitly:

| Format | Path |
|---|---|
| SRT (text) | Direct play via AVPlayer's TextTrack. Cheap. |
| WebVTT (text) | Direct play. Cheap. |
| ASS / SSA (text, styled) | AVPlayer can't render ASS. Either bundle a libass renderer (small native module in EmeraldKit) OR convert ASS → WebVTT on the server, dropping styling. Convert is the simpler v1; libass is M5+. |
| PGS / VOBSUB (image-based) | AVPlayer has zero support. Server MUST burn-in via ffmpeg subtitle filter. Adds 30–50% transcode cost. |
| Forced subtitles | Detect `default+forced` flags, present as a separate track in the UI. |

Treat subtitle handling as a first-class M4 work item, not "AVPlayer handles
it." Jellyfin's #1 user complaint is ASS rendering breakage.

**Live latency reality:**

Current M1 phase 4b ffmpeg invocation (`-c copy -f hls -hls_time 4`) gives
**8–12 seconds** of end-to-end live latency — comparable to Plex, worse than
TiviMate's raw MPEG-TS at 1–2s. Sub-4s requires true LL-HLS (CMAF segments
with `EXT-X-PART` partial-segment directives + blocking playlist reload).
**LL-HLS is an M4 stretch item, not v1.** Current path stays through M5.5.

**First-run pairing (Apple TV without a browser):**

Apple TV's Siri Remote text entry is brutal. Three discovery paths, layered:

1. **Bonjour `_emerald._tcp` advertisement** from the server (via `NWBrowser`
   in `Network.framework`, not the deprecated `NSNetServiceBrowser`). Same-LAN
   servers appear automatically.
2. **QR pair from phone**: iPhone admin opens the web admin → "Pair a TV" →
   QR code containing `{server_url, ephemeral_pair_token}`. Apple TV scans
   via iPhone Camera + Continuity, OR user types a 5-digit code visible on
   TV that the phone admin enters into the web admin (mirror of plex.tv/link).
3. **Manual URL entry** as last resort.

iOS requires a local-network permission prompt for Bonjour discovery on
first launch; not a blocker but design for it.

### 4. Library content sources

Native apps consume the same backend APIs the web does:

| Source | Endpoint | Phase |
|---|---|---|
| mybunny IPTV catalog | `/api/iptv/*` | M1 (shipped) |
| Personal media server library | `/api/media/*` | M3 (Rust) |
| Transcode grants | `/api/media/play/:kind/:id/grant` | M4 (Rust) |
| Unified suggestions | `/api/suggestions` (tagged with `available_on`) | M1 phase 8 (shipped, recommender side) |

### 5. App Store policy hardening

Required before submission:

- **Compile-flag IPTV-disabled build is the DEFAULT submitted artifact.**
  Not insurance — default. The public App Store binary does NOT register
  `/api/iptv/*`-aware UI. Users who run servers that happen to expose IPTV
  enable the IPTV feature on their own NAS; the app receives `available_on`
  badges but doesn't ship branded IPTV affordances. This is the single
  biggest dial on approval odds.
- **Server-side kill switch for `/api/iptv/*`.** A feature flag the operator
  can toggle in minutes. If a rights-holder DMCA hits the app's developer
  identity, we disable the IPTV route fleet-wide while the takedown is
  investigated.
- **No branded streaming keywords anywhere in user-facing copy or metadata.**
  No "IPTV", "M3U", "Xtream Codes", "live TV" in the App Store name,
  description, marketing site, support docs, or social posts under the
  developer identity. Use "self-hosted personal media server client" /
  "your own media library and providers."
- **Disclaimer language verbatim from approved apps.** Use the pattern the
  surviving apps use: *"\[App] does not provide any content or playlists.
  It is designed to be used with users' own legally licensed content.
  \[App] does not endorse the streaming of copyright-protected material
  without permission of the copyright holder."*
- **Marketing screenshots show personal library + features only.** Zero
  HBO/ESPN/CNN/Fox/etc. logos. Zero channel listings. Demo personal media
  library, transcoder UI, watch state, AirPlay, PiP.
- **Reviewer demo server runs `auth_mode=local`** and is loaded with Creative
  Commons / public-domain content only (Big Buck Bunny, Sintel, public
  domain TV, operator-uploaded MP4s). The demo server should not even
  register `/api/iptv/*`. Reviewer credentials in submission notes.
- **Privacy nutrition labels: "Data Not Collected"** — true for the app→Apple
  boundary. If we add telemetry later (see Operational Concerns), update.
- **App Tracking Transparency**: skip unless we track for ads. We don't.
- **Notarization** for any macOS server binary distributed outside the App
  Store. Developer ID Application cert + `xcrun notarytool submit --wait`
  + `xcrun stapler staple`. **Included in the $99/yr Apple Developer
  Program** — no additional fee.

**Realistic approval probability:**

- **~70–75%** for initial review with the hardened framing above.
- **~45–55%** for 12-month survival post-launch. The bigger risk is not
  review-day rejection — it's post-launch DMCA complaints from rights
  holders that bypass normal review (precedent: IPTV Smarters Pro, XCIPTV,
  Televizo, VU IPTV, XTV Ultra all pulled from iOS App Store in 2024–2026
  via complaint).

**Plex precedent caveat:** Plex's iOS app supports licensed HDHomeRun OTA
tuners. Plex does NOT ship Xtream/M3U directly; users use xTeVe/Threadfin
bridges that Plex doesn't endorse. We are weaker precedent than the GSE /
IPTV Smart Player line because mybunny is Xtream-Codes-shaped.

### 6. Distribution matrix

| Audience | Channel | What ships | Cost |
|---|---|---|---|
| Pre-launch household + invited testers | TestFlight (internal up to 100, no review; external public link up to 10k, brief review per version train) | Unified app pointed at your NAS | $99/yr Apple Developer |
| Public end users | App Store | Same unified app, IPTV route disabled by default compile flag, points at user's own server | $99/yr Apple Developer |
| Self-hosted server (Rust binary) | GitHub Releases v1; Homebrew tap (`brew tap chrispachulski/emerald`) v1.1 | Tiny Rust binary + documented ffmpeg dependency | $0 (notarization included in Developer Program) |

**Operational notes:**

- **TestFlight 90-day build expiry is hard.** Schedule a calendar reminder
  at day 85 to push a new build, even if no code changed. Otherwise testers
  see "build expired" and bounce.
- **Internal vs external testing**: internal (100 cap, no review) for the
  M2–M5 development window. External public link (10k cap, anonymous
  signup, no per-tester email collection) once the build train is stable
  and you want feedback from strangers.
- **Build pipeline**: GitHub Actions matrix (`macos-14` for macOS arm64 +
  universal2 via `cargo-zigbuild`, `ubuntu-24.04` for Linux x86_64-gnu +
  aarch64-gnu, `windows-2022` for Windows MSI). `cargo-dist` (now
  published as `dist`) drives the matrix, produces signed installers,
  bakes in `axoupdater` for self-update.

### 7. The Rust pivot: where, when, what

**Where:** new code only.

| Service | Language | Reason |
|---|---|---|
| Hono backend (M1, IPTV) | TypeScript | Working code; rewriting it adds zero user-visible value and burns 4-6 weeks. Reconsider at M6 once Rust services have proven stable. |
| Recommender | Python / FastAPI | ML ecosystem, sentence-transformers, etc. Stays Python. |
| media-core (M3) | **Rust** | New service. Single static binary footprint matters here — the operator installs this. |
| transcoder (M4) | **Rust** | Long-running 24/7 process, CPU-bound, perf-sensitive. tokio::process for ffmpeg subprocess management. |
| Native iOS/tvOS clients (M2, M5) | Swift | Apple platforms |
| Web SPA | TypeScript / React | Browser; no escape |

**When:** M3 starts in Rust from day one. Optional port of M1 to Rust at
M6 — by then the Rust skill base is built and the rewrite cost amortizes
against features you'd otherwise build twice.

**Recommended Rust stack (specific versions, drop-in):**

| Concern | Crate | Notes |
|---|---|---|
| HTTP | `axum 0.8.x` + `tower-http 0.6.x` | Tokio-team maintained, hyper 1.x under the hood. Trace, cors, compression, timeout, request-id middleware in one ecosystem. `Body::from_stream` + `Sse` first-class for the HLS proxy / live progress paths. |
| Async runtime | `tokio` | Standard |
| SQLite | `sqlx 0.8.x` with **split reader/writer pools** — writer pinned to `max_connections(1)`, reader configurable. WAL + `synchronous=NORMAL` + `busy_timeout=5000`. | SQLite is single-writer; default `SqlitePool` deadlocks under write contention. If sqlx compile-time-checked queries cause friction, fall back to `rusqlite` + `tokio::task::spawn_blocking` with a single writer thread. |
| Migrations | `sqlx::migrate!` | |
| File watching | `notify` + `notify-debouncer-full` | Editors emit 5–10 events per save; debounce. |
| Subprocess management | `tokio::process::Command` with `kill_on_drop(true)` | For both `ffprobe` (metadata) and `ffmpeg` (transcode). NO `ffmpeg-next` / `ac_ffmpeg` / `rsmpeg` FFI bindings — ffmpeg-next is maintenance-only and trails upstream by ~6 months. Same pattern Plex and Jellyfin use. |
| JSON | `serde` + `serde_json` | |
| HTTP client (outbound) | `reqwest` | |
| Observability | `tracing` + `tracing-subscriber` + `tower-http::trace::TraceLayer` from day one | Structured logs, request IDs, span propagation. |
| Distribution | `cargo-dist` (`dist`) | GitHub Actions matrix, signed installers, axoupdater for self-update. |

**Why Rust specifically and not Go?** Both ship single static binaries. Rust
wins for:

- Memory safety without GC pauses (matters for 24/7 transcoder)
- Performance equivalent to C++ for the long-tail CPU-sensitive paths
- WASM story (if we ever want to share code with the web)

Go would be fine. Rust is the slightly better fit. Either choice is
defensible; the language is not the bottleneck for this project.

**Async Rust learning curve from TypeScript** (solo dev coming from TS): plan
on **2–3 weeks of frustration before productivity.** The specific stumbling
blocks: `Send` bounds in axum handlers when you hold non-`Send` types like
`rusqlite::Connection` across `.await`; realizing tokio's worker threads are
limited and CPU-heavy work (EPG XML parsing, anything sync-heavy) needs
`spawn_blocking`. The language patterns you'll actually write are
HTTP-handler-and-call-subprocess-shaped — very approachable; you don't have
to fight the borrow checker hard for that.

### 7a. FFmpeg distribution model

**ffmpeg/ffprobe are runtime dependencies, NOT bundled in the Rust binary.**

Three reasons:

1. **Static-linking ffmpeg is a license trap.** ffmpeg-the-project is LGPL,
   but the encoders the operator actually wants — x264 (GPL-2.0+), x265
   (GPL-2.0+), libfdk-aac (nonfree) — are not. A binary that statically
   links a GPL-built ffmpeg inherits those obligations. LGPL-only builds
   are technically legal but ship without the best encoders and still
   carry build complexity. Treating ffmpeg as a runtime dependency
   sidesteps the entire license surface.
2. **Same pattern Plex and Jellyfin use.** Jellyfin maintains a fork
   (`jellyfin-ffmpeg`) precisely because upstream FFmpeg's
   hardware-encode behavior has too many edge cases for a media server to
   consume directly. Plex Transcoder is a binary fork of FFmpeg invoked as
   a subprocess.
3. **Cross-compilation pain.** `x86_64-unknown-linux-musl` + ffmpeg-sys is
   a known sharp edge; most pre-built ffmpegs are glibc. Subprocess sidesteps
   it.

**Per-platform installation guidance** documented in the server's README:

| OS | Source | Constraint |
|---|---|---|
| macOS | `brew install ffmpeg`, OR a signed sidecar binary shipped alongside the Rust binary | If sidecar: also needs hardened-runtime entitlements |
| Linux | Distro package or static glibc build from John Van Sickle | Require ≥ 6.0 |
| Windows | Bundle a pinned Gyan build inside the installer | Less ecosystem friction than asking the user to install it |

**Linux build matrix**: ship `x86_64-unknown-linux-gnu` and
`aarch64-unknown-linux-gnu`. Skip musl — most ffmpegs users have are glibc
and we'd just be making lives harder.

### 8. Refinements to existing M4 (transcoder)

The existing M4 spec has one weakness: it estimates "~3% CPU per session" on
Apple Silicon. That's the optimistic case for h.264 1080p direct-play decisions.
**Realistic case:**

| Stream | Apple Silicon (M2/M3) | Status |
|---|---|---|
| h.264 1080p, direct-play decision | <1% CPU (no transcode) | OK |
| h.264 1080p → h.264 1080p re-encode | 8-12% CPU | OK |
| HEVC 4K HDR → h.264 1080p SDR | 25-40% CPU | Tight |
| HEVC 4K Dolby Vision → h.264 1080p SDR | 40-60% CPU + tone mapping | Single stream max |

**Process lifecycle (port the M1 `iptvRemux.ts` pattern line-for-line):**

- Every ffmpeg child started via `tokio::process::Command` with
  `kill_on_drop(true)` as a safety net.
- Supervisor task per session with exponential backoff restart (up to N
  attempts before surfacing failure to the client).
- Stderr piped into `tracing` at warn level so the operator can grep server
  logs for one transcode session by its session ID.
- Idle sweep at 5s, mirror M1's existing tracker behavior.
- Heartbeat from client every 30s; no-heartbeat → SIGTERM → SIGKILL after 5s.

**Stress test phase before declaring M4 done.** Real ffmpeg invocations on
real 4K HDR samples, measured on target hardware:

- **AVPlayer on tvOS**, not just browser — AVPlayer is pickier (wants fMP4
  segments for HEVC, version-7 playlists, accurate `#EXT-X-TARGETDURATION`).
- Dolby Vision Profile 5 (FEL) — **NOT officially supported on iPhone/iPad**
  by AVPlayer. Plex uses a "fake P5" hack that could disappear at any iOS
  release. Plan for transcode-to-Profile-8.1 or fallback-to-SDR on
  iPhone/iPad. Apple TV 4K handles it natively.

**M4 timeline realism:** **6–9 months for a solo dev**, not 2-3. Jellyfin
took ~3 years from fork to stable hardware acceleration; `jellyfin-ffmpeg`
exists for that reason. HEVC/HDR/DV/PGS/audio-passthrough/subtitle-burn-in/
seek-behavior are each multi-week problems. Plan for `2×` initial estimates.

### 9. Sequencing through public launch

| Phase | Scope | Output | Solo-dev estimate |
|---|---|---|---|
| M1.5 | Cross-service compatibility contract: device-token format frozen, stream-grant token format frozen, identity namespace prefixes adopted, recommender data-model contradiction resolved, DB migration convention adopted, server/app version-compat endpoints. | `2026-MM-DD-cross-service-contract.md` doc + Rust test-vectors crate + M1 code changes to match. Required before M2 — see "Cross-service compatibility contract" section. | 1-2 weeks |
| M2 | Swift SDK + EmeraldTV + EmeraldMobile, IPTV catalog as first content source, TestFlight pipeline | TestFlight build distributed to household | ~2 months |
| M3 | Rust media-core (scanner, library APIs, watch state) | Single binary; initial library scan reliable; TMDB matching for movies + English-language TV at minimum | **3-4 months** |
| M4 | Rust transcoder + capability matching | Direct-play and transcode both work; stress-tested; subtitle pipeline solid | **6-9 months** |
| M5 | Native apps add Personal Media Server browse + playback + offline downloads | Native apps now self-sufficient (no Plex needed for personal media) | **2-3 months** |
| M5.5 | App Store submission of the unified app | First public app shipped. Compile-flag insurance build (no `/api/iptv/*` UI) submitted as default. Personal-media-only build is the public artifact. | 1 month including review iteration |
| M6 | Plex-Pass features (DVR for IPTV, intro detection, music, photos) | Selected from the menu in the existing roadmap | Long tail |

**Total M3–M5 = 12-18 months for a solo developer in Rust.** Reference:
Jellyfin reached Plex feature-parity for most users ~5 years post-fork
(2018→2023-ish) with ~1,100+ contributors at peak. Solo dev on the
narrower Apple-only client scope is plausible at the 18-month outer edge.

**Hard sequencing constraints:**
- M2 can build TestFlight without M3 / M4 — IPTV alone is enough for first build.
- M3 + M4 must both be done before the App Store submission (M5.5).
- M5 can develop in parallel with M3 / M4 (mock the media-core API to unblock UI work).

### 10. What's NOT changing from the existing roadmap

- All M1 endpoint contracts (`/api/iptv/*`)
- Plex PIN OAuth flow + JWE session cookie (web side)
- Three-SQLite database split (`iptv.db`, `exchange.db`, `media.db`)
- Recommender in Python with `iptv_ingest` worker
- Cloudflare Tunnel deployment for the IPTV side
- Existing intel structure (`.planning/intel/`)

## Cross-service compatibility contract (pre-M2 prerequisite)

The strategy now spans four languages and runtimes — TypeScript/Hono (M1),
Rust/axum (M3 + M4), Python/FastAPI (recommender), Swift (M2 + M5). Before
any native client work begins, the **wire-level contracts** these services
share must be frozen. Otherwise migrations bake into Keychain tokens and
App Store binaries that are painful to reverse.

This section captures *what the contract must specify*, not the contract
itself. The contract gets its own document (`2026-MM-DD-cross-service-
contract.md`) drafted before M2 kickoff.

### What the contract must freeze

| Concern | Why |
|---|---|
| **External auth token format** (device JWE: algorithm, headers, claim names, key ID, rotation policy, `jti`, `server_id` claim, `auth_mode` claim, revocation method for local-auth) | Once an iPhone has a 1-year `deviceToken` in Keychain, you can't change the format without forcing every user to re-pair. |
| **Internal auth boundary** | Decision: does Hono validate all external auth and pass short-lived internal principal assertions to Rust services on localhost, OR do Rust services independently decrypt user JWEs? First is simpler and safer; second is more decoupled. Pick one and document. |
| **Stream-grant HMAC token format** (canonical byte ordering, claim names: kind/resourceId/sub/exp/jti, nonce policy, clock-skew tolerance, key separation from session secret, replay-prevention model, max TTL) | Token format must round-trip identically between TS sign and Rust verify. JSON-stringify across languages is not canonical without enforcing key ordering. |
| **Long-lived bearer tokens in URLs** | The old roadmap proposes `/api/iptv/playlist.m3u?t=<deviceToken-issued>`. **Don't.** Bearer tokens leak via logs, proxies, support bundles, server-side error reports. Replace with a separate playlist-scoped token kind that is path-restricted, short-lived, and revocable. |
| **DB migration contract across services** | Each of `iptv.db`, `exchange.db`, `media.db` needs a shared migration-table convention, a `schema_version` API endpoint, a "haven't updated in 8 months" coalesced migration path, and a rollback policy. M3 changes the writer language from TS to Rust; sqlx vs better-sqlite3 must produce byte-identical schema. |
| **Identity namespace** | `sub` from Plex (`plex:12345`), local auth users, and future multi-server identities can collide unless prefixed. Decision: namespace from day one (`plex:`, `local:`, `apple:`). |
| **Recommender data-model contradiction** | The cross-cutting section says "don't duplicate the TMDB title — add `iptv_title_link`." M1's `iptv_ingest.py` upserts VOD/series into `titles` under `iptv_vod`/`iptv_series`. These are different models. The `available_on` badge feature depends on which one is canonical. **Pick: canonical TMDB titles + availability links, OR per-source title rows.** |
| **Availability-badge semantics for orphans** | What does `available_on` mean for an IPTV item with no TMDB match? For a live channel (currently excluded)? For an item that disappeared upstream? Need tombstones + per-source last-seen timestamps; otherwise the recommender advertises stale availability. |
| **Server/app version compatibility gates** | `/api/version` semantics, app-side min-server-version check, server-side max-client-version 426 response. Required before any App Store submission. |
| **CI contract gates** | Tests proving Swift Codable DTOs match the Hono/Rust JSON shapes; DB migration tests that exercise skipped-version upgrades; reproducible personal-media-only build (the App Store insurance build) on every commit; ffmpeg sidecar version validation; server/app version-skew tests. |

### How to draft the contract

1. Inventory current behavior of `signStreamToken` / `verifyStreamToken` in
   `server/services/iptvStreamToken.ts` — that is the de-facto contract today.
2. Identify breaking deltas needed before M2 (nonce policy, jti, server_id
   claim, namespace prefix on sub) and apply them while M1 is still the
   only consumer — cheap to change now, expensive once Apps speak it.
3. Write the Rust equivalents (in a sibling crate `emerald-contracts`)
   that produce/verify the same bytes from the same inputs as the TS
   side. Round-trip vectors as test fixtures shared by both stacks.
4. Lock the device-token format BEFORE shipping any TestFlight build —
   forcing re-pairs across the household is acceptable now, not later.

### What this means for sequencing

M2 cannot start until the contract is drafted and the device-token format
is locked. Realistic timeline: **1-2 weeks for the contract spec + Rust
test vectors + M1 code changes to match.** Add explicitly as M1.5 in the
sequencing table.

## Operational concerns

These were absent from the original draft. All five are pre-M2 prerequisites
or table-stakes for an app that runs in users' homes.

### 11. Observability + operator experience

When ffmpeg dies, a scan hangs, or a remux session leaks PIDs at 2am, the
operator has no UI, no logs, no diagnostics. Need before M2:

- **Structured logging** via `tracing` (Rust services) / pino or equivalent
  structured logger (M1 TypeScript) with a propagated request ID across
  Hono → media-core → transcoder.
- **`/api/admin/diagnostics` endpoint** returning live session list, sync
  job history, DB sizes, ffmpeg process inventory.
- **"View server logs" tab in the admin UI** — tail the last N lines,
  filter by level, copy to clipboard.
- **Crash reporting decision**: Sentry, Glitchtip (self-host-friendly), or
  local-only. Default proposal: self-hosted Glitchtip. Privacy-clean for
  a self-hosted product. If we ship telemetry of any kind, update the
  App Store privacy labels.

### 12. TLS strategy for self-hosters

Apple ATS rejects self-signed certs and plain HTTP outside `localhost`. The
device-token flow assumes `POST https://<server>`. Three realistic operator
paths, all officially supported with documented setup guides:

1. **Cloudflare Tunnel** — already in use for the IPTV side. Best UX, free
   tier sufficient, real cert issued by Cloudflare. Documented as the
   default.
2. **Tailscale** — VPN-like overlay; cert from `ts.net` magic DNS works
   out of the box on Apple devices. Documented as the "no DNS / no public
   exposure" path.
3. **LAN-only with Let's Encrypt DNS-01** — for users who can configure
   DNS-01 for an internal hostname. Power users only; documented but not
   recommended.

**Plain HTTP / self-signed certs are not supported.** Documented as such.
No ATS-exception toggle in `Info.plist` — that complicates review.

### 13. Backup / disaster recovery

Three SQLite DBs (`iptv.db`, `exchange.db`, `media.db`), no backup story
today. Bad shutdown → re-scan a 2 TB library or lose all watch history.

- **`POST /api/admin/backup`** produces a single tarball of all DBs via
  SQLite's `VACUUM INTO` (consistent snapshot) + a sidecar manifest with
  schema versions.
- **`POST /api/admin/restore`** validates the tarball, stops services,
  swaps DBs, restarts.
- **Data export in portable JSON Lines** (watch history, favorites,
  playlists, library metadata) so users who choose to leave for
  Jellyfin/Plex aren't trapped. Matters for trust even if nobody uses it.
- **NAS storage caveat**: SQLite DBs MUST live on the NAS's *local*
  storage. WAL mode breaks on CIFS/NFS-mounted volumes. The media library
  itself can be on a network share; the database files cannot.

### 14. Version skew between server and app

Server v1.2 with native app v1.4 (or vice versa) is inevitable post-App-Store.

- **`/api/version`** returns server semver, list of API versions
  supported, build metadata.
- **App-side min-server-version check** at first connect → clean "please
  update your server" screen if server is too old.
- **Server-side max-client-version 426** response with `{ required_version }`
  → app surfaces "please update via App Store" screen.
- **Migration runner handles missed migrations** — a user who hasn't
  updated in 8 months and skipped 4 migrations gets a single coalesced
  upgrade path, not a death spiral of half-applied schemas.

### 15. Rate limiting + brute-force protection

Self-hosters who expose servers publicly (Cloudflare Tunnel mitigates some
of this, Tailscale users have no DDoS layer) need:

- **Per-IP rate limits on `/api/auth/device/start`** and grant endpoints.
- **Global "this server is under load" circuit breaker** for the transcoder
  when concurrent sessions exceed a configured cap.
- **Fail2ban-style temp bans** after repeated 401s on the Plex PIN flow.

## Legal + license

### 16. License decision (one-way door)

The repo has no LICENSE file yet. Picking after distribution is hard. The
three real options:

| License | Trade-off |
|---|---|
| **GPL-3.0** | Prevents commercial fork without contribution-back. Trust signal to FOSS community. Some commercial integrators reject GPL. |
| **MIT** | Maximum permissive. Anyone can white-label and resell. Trust signal weaker but simpler legally. |
| **Proprietary** | Source-available or fully closed. Maximum control, minimum community contribution. Apple App Store doesn't care about source license — only binary distribution. |

**Decision required before any binary leaves the laptop.** This document
does not prescribe; it flags the decision. The user picks.

### 17. Terms of service + EULA

- **ToS for self-hosters**: "You are responsible for the content on your
  server. We provide infrastructure, you provide rights." Standard
  CYA, but it's important when an upstream rights-holder sends a DMCA
  asking us to identify a downstream user.
- **EULA for App Store users**: "This app is a client. Server operators
  determine what content reaches you. We are not responsible for content
  legality."
- **`is_adult` flag enforcement.** The `channels` table has an `is_adult`
  column. UI must surface a per-user content gate; the server must
  honor it on the EPG/grant endpoints. Without this, a household minor
  watching an adult IPTV channel is a real legal exposure for the
  self-host operator.

## Minimum viable product if the project stalls

A multi-year solo project needs a clean stopping point. The MVP that's
still useful even if M4 burns the user out:

**M2 + M3 alone — Apple apps + media library, no transcoder.**

Direct-play-only is a real product. Infuse ships in that shape and people
pay for it. If M4 stalls:

- Personal media that's already in a compatible codec (h.264 MP4, hevc
  MOV, m4v) plays via AVPlayer direct-play.
- Incompatible files fail gracefully with "this file needs transcoding —
  not yet supported, sorry."
- Library browse, search, watch state, AirPlay, PiP all work.
- TestFlight ship. Maybe even App Store ship as "Personal media player
  for direct-play-compatible files."

This is not the goal, but it's the floor. Document it so the user knows
where the "good enough" line is and doesn't push past it into burnout.

## Open questions — resolved

The original draft ended with five open questions. All are now answered;
preserved here for the audit trail.

1. **Apple Developer Program: $99/yr individual vs organization?**
   **Individual.** SIWA works fine on individual. Org gives multiple App
   Store Connect roles and a legal-entity name on the store page.
   Convert later if you bring on contractors or want a brand entity on
   the listing. Solo dev = individual.

2. **TestFlight audience scope: internal-only or external?**
   **Start internal (100 users, no review), move to external public
   link once stable.** External public-link route gives anonymous
   signup with no per-tester email collection, 10k cap, ~24-48h beta
   review per first build of a version train. Internal is the right
   surface for M2 → M5 development.

3. **Plex auth fallback: anonymous local-only mode?**
   **Yes, support local-only.** `auth_mode = local | plex | both`
   server config flag. Required for App Review anyway — reviewer can't
   create a Plex account on demand. Default mode for new servers is
   `both`, defaulting the user picker to `plex` if a Plex account is
   present in the server's environment.

4. **Server binary distribution channel?**
   **GitHub Releases for v1, Homebrew tap for v1.1.** GitHub Releases is
   the cheapest, most credible-looking option for a self-hosted FOSS
   server. `brew tap chrispachulski/emerald` formula once releases are
   stable — macOS NAS users will expect `brew install`. Notarize each
   release; Gatekeeper friction kills installs of unsigned binaries.

5. **Multi-server support: one or many?**
   **Single-server v1, multi-server in M6.** Plex's single-active-server
   model covers 99% of self-hosters. Multi-server (Jellyfin-style) is a
   real engineering tax — token scoping, server-picker UI, Bonjour merge.
   But build device-token storage with `server_id` in the schema **from
   day one** so it's not a migration later.

## How to use this doc

- **Before starting M2**: re-read this + the canonical roadmap. Run a fresh
  `/gsd:new-milestone` brainstorm with both docs as context. Confirm the
  TLS path, LICENSE choice, observability stack — those are the only
  pre-M2 decisions that remain.
- **Before starting M3**: confirm Rust toolchain decisions are still
  current (axum 0.8.x, sqlx 0.8.x, cargo-dist). Verify the build target
  matrix runs end-to-end on a hello-world Rust binary before committing
  to the full M3 scope.
- **Before App Store submission**: separate App Store readiness audit.
  Privacy labels, screenshots (no branded logos), demo server content
  (Creative Commons only), marketing copy (no "IPTV"/"M3U" keywords),
  insurance build buildable.
- **If priorities shift**: amend this doc in place, but preserve the
  audit trail by adding dated amendment notes. Don't silently rewrite
  past decisions — readers depend on knowing what changed when.

## Source documents

- `2026-05-24-mybunny-and-plex-replacement-design.md` — canonical 6-milestone roadmap.
- `2026-05-25-review-findings.md` — consolidated output of the 5-agent review pass that produced the corrections absorbed here.
