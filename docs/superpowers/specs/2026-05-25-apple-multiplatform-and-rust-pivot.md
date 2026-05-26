# Apple Multi-Platform Delivery + Rust Server Pivot

## Why this doc exists

Strategic decisions reached on 2026-05-25 that **refine or supersede** parts of
`2026-05-24-mybunny-and-plex-replacement-design.md` (the canonical roadmap).
Future sessions: read both. Where they disagree, this doc wins.

The triggering conversation: live IPTV playback in the browser stutters because
`mpegts.js` is JavaScript demuxing MPEG-TS through MSE. The user wants to (a) ship
native Apple TV / iPad / iPhone apps and (b) eventually replace Plex with a
self-hosted server that can be published to the App Store. That forces explicit
strategic choices about distribution, language, and what's web-only.

## Locked decisions (overrides existing roadmap)

| # | Decision | Why |
|---|---|---|
| A | **Two-product split.** "Personal Media Server" goes to public App Store; IPTV viewer stays TestFlight-only. | Apple App Store policy bars apps that stream gray-market IPTV. Self-hosted personal media (own files) passes review easily. |
| B | **Rust beachhead at M3.** New services (M3 media-core, M4 transcoder) ship in Rust. M1 Hono backend stays in TypeScript. | Single static binary distribution. Memory safety for 24/7 home server. No throwaway rewrite of working IPTV code. |
| C | **Self-hosted only.** Never multi-tenant SaaS. | Same model as Plex. Avoids licensing, hosting, scaling, and most legal exposure. |
| D | **Web SPA is permanent second-class.** | Browser can't beat AVPlayer for media. That's a property of browsers, not our architecture. |
| E | **Native targets: tvOS + iOS universal (iPhone + iPad).** No separate iPad target. | iPad is iOS with size classes. Apple TV needs its own focus-engine target. |

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
├── EmeraldMobile/                         # iOS universal target (iPhone + iPad)
└── EmeraldApp.xcodeproj
```

**Sharing target ~85% — anything platform-divergent stays in the per-target
target (navigation chrome, focus engine, sheet vs full-screen modals).**

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

**Addition for App Store path:** Apple Sign-In MUST be offered as an alternative
if the app offers any third-party sign-in (Apple's policy since 2020). For the
public Personal Media Server app, the auth screen shows "Sign in with Apple" +
"Sign in with Plex". For the TestFlight IPTV companion, Plex-only is fine.

### 3. Player layer

`EmeraldKit/Sources/Player/`:

- `AVPlayer` for ALL content paths (live, VOD, series, media-core local files)
- Native MPEG-TS NOT supported by AVPlayer → live channels go through the
  M1 phase 4b remux path (ffmpeg HLS on the NAS) — already shipped
- Picture-in-Picture (free with AVPlayer)
- AirPlay receiver selection (built into AVPlayer overlay)
- Audio + subtitle tracks (AVPlayer's native track APIs)
- Resume markers via existing `/api/iptv/history` + future `/api/media/watch`

### 4. Library content sources

Native apps consume the same backend APIs the web does:

| Source | Endpoint | Phase |
|---|---|---|
| mybunny IPTV catalog | `/api/iptv/*` | M1 (shipped) |
| Personal media server library | `/api/media/*` | M3 (Rust) |
| Transcode grants | `/api/media/play/:kind/:id/grant` | M4 (Rust) |
| Unified suggestions | `/api/suggestions` (tagged with `available_on`) | M1 phase 8 (shipped, recommender side) |

### 5. App Store policy hardening

Required before any public submission:

- **Apple Sign-In offered** when any third-party sign-in is offered. Required.
- **Privacy nutrition labels** must declare what's collected. For self-hosted,
  the answer is "nothing" — easy.
- **App Tracking Transparency** prompt — only needed if we track for ads. We
  don't, so skip.
- **No IPTV / streaming-content features in the public build.** Build the
  IPTV side behind a compile flag. Public build excludes it.
- **Demo server for reviewer.** Apple reviewers need a working backend to test
  against. Operate a small TestFlight-only NAS endpoint with sample content,
  give reviewer credentials in the submission notes.
- **Notarization** for any macOS server binary distributed outside the App Store.

### 6. Distribution matrix

| Audience | Channel | Build contents | Apple Dev fee |
|---|---|---|---|
| Household + invited testers | TestFlight (internal + external) | Full app: IPTV + Plex remote + future personal media | $99/yr |
| Public end users | App Store | Personal media server companion only — no IPTV | $99/yr |
| Self-hosted server (Rust binary) | Direct download (Github releases / your own site) | Single static binary per OS/arch | None |

### 7. The Rust pivot: where, when, what

**Where:** new code only.

| Service | Language | Reason |
|---|---|---|
| Hono backend (M1, IPTV) | TypeScript | Working, IPTV is TestFlight-only anyway, don't rewrite |
| Recommender | Python / FastAPI | ML ecosystem, sentence-transformers, etc. Stays Python. |
| media-core (M3) | **Rust** | New service. Single static binary. axum + tokio + sqlx + notify + ffmpeg-next |
| transcoder (M4) | **Rust** | Long-running 24/7 process, CPU-bound, perf-sensitive. tokio::process for ffmpeg subprocess management |
| Native iOS/tvOS clients (M2, M5) | Swift | Apple platforms |
| Web SPA | TypeScript / React | Browser; no escape |

**When:** M3 starts in Rust from day one. No "rewrite Hono in Rust" project
unless and until the value becomes obvious post-M5.

**Why not rewrite M1?** Hono / Node IPTV server works. Rewriting it costs 4-6
weeks for zero user-visible value. The IPTV side is TestFlight-only anyway, so
the "single static binary for App Store distribution" argument doesn't apply.

**Why Rust specifically and not Go?** Both ship single static binaries. Rust
wins for:
- Memory safety without GC pauses (matters for 24/7 transcoder)
- Performance equivalent to C++ (matters for the transcoder orchestration)
- Better FFI to ffmpeg via `ffmpeg-next`
- WASM story (if we ever want to share code with the web)

Go would be fine. Rust is slightly better for this specific shape (long-running,
CPU-sensitive, single binary).

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

**Add to M4 spec:** stress-test phase before declaring it done. Real ffmpeg
invocations on real 4K HDR samples, measured on the target NAS hardware.
Right-size `MAX_CONCURRENT_TRANSCODES` based on observed numbers, not estimates.

### 9. Sequencing through public launch

| Phase | Scope | Output |
|---|---|---|
| M2 | Swift SDK + EmeraldTV + EmeraldMobile, IPTV-only feature set, TestFlight pipeline | TestFlight build distributed to household |
| M3 | Rust media-core (scanner, library APIs, watch state) | Single binary, dockerized for the NAS |
| M4 | Rust transcoder + capability matching | Direct-play and transcode both work; stress-tested |
| M5 | Native apps add Personal Media Server browse + playback | Native apps now self-sufficient (no Plex needed for personal media) |
| M5.5 | App Store public submission of "Personal Media Server" build (IPTV excluded via compile flag) | First public app shipped |
| M6 | Plex-Pass features (DVR for IPTV, intro detection, music, photos) | Selected from the menu in the existing roadmap |

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

## Open questions to settle before M2 kickoff

1. **Apple Developer Program**: $99/yr individual or $99/yr organization? Org
   gives "Sign in with Apple" features for teams; individual is fine for solo dev.
2. **TestFlight audience scope**: Internal-only (you + ~25 testers, no review)
   or external (up to 10k, brief Apple review per build)?
3. **Plex auth fallback**: If the user has no Plex account, do we accept
   anonymous local auth on first launch (for the personal media use case
   where Plex isn't required), or is Plex always required?
4. **Server binary distribution**: Github Releases? Self-hosted download page?
   `brew install` formula for macOS NAS users?
5. **Multi-server support**: Does one app connect to one server (Plex's
   approach) or multiple (Jellyfin's approach)? Affects auth flow significantly.

None of these are urgent. All can be settled during M2 brainstorm cycle.

## How to use this doc

- **Before starting M2**: re-read this + the existing roadmap. Run a fresh
  `/gsd:new-milestone` brainstorm with both docs as context.
- **Before starting M3**: confirm Rust toolchain decisions (axum vs actix-web,
  sqlx vs rusqlite, build target matrix for the distributable binary).
- **Before App Store submission**: do a separate App Store readiness audit
  (privacy labels, Apple Sign-In, demo server, screenshots, marketing copy).
- **If priorities shift**: amend this doc rather than the old one. Date the
  amendment.
