# M2 — EmeraldKit + Apple targets (tvOS, iOS universal)

> **Status:** Brainstorm-output spec drafted 2026-05-27. Pre-execution.
> Run `/gsd:new-milestone` against this doc + the two upstream specs
> before starting plan-phase.
>
> Upstream specs (authoritative):
> - `docs/superpowers/specs/2026-05-25-apple-multiplatform-and-rust-pivot.md` — strategic decisions A–E
> - `docs/superpowers/specs/2026-05-25-cross-service-contract.md` — wire-format contract (§4 internal-principal, §3 stream tokens, §5 device-token, §8 sub namespace)
> - `docs/superpowers/specs/2026-05-24-mybunny-and-plex-replacement-design.md` — original M1–M6 roadmap

## Scope — what M2 ships

| In | Out |
|---|---|
| EmeraldKit SwiftPM package (the shared SDK) | Personal media library browsing (M3) |
| EmeraldTV target (tvOS, focus engine, 10-foot UI) | Transcoded playback (M4) |
| EmeraldMobile target (iOS universal, iPhone + iPad layouts) | Music, photos, DVR (M6) |
| Swift port of `emerald-contracts` (the fourth binding alongside Rust core, napi, pyo3) | Watch-state sync to mythical future Android target |
| TestFlight internal-distribution pipeline (Xcode Cloud or GitHub Actions + Fastlane) | App Store submission (deferred to M5.5) |
| Catalog browse: live, VOD, IPTV series — same `/api/iptv/*` the web consumes | Native multi-server picker (M6) |
| Live channel playback via the M1 phase 4b remux path | Bonjour `_emerald._tcp` discovery (M2 stretch, gated on real-device test) |
| VOD playback via direct HLS to AVPlayer | Native Bonjour entry (deferred to M5; manual URL entry in M2) |
| Per-user favorites + history (server-authoritative) | EPG grid (M2 stretch; M3 if it slips) |
| Catchup TV grant flow | DVR-to-disk (M6) |
| Universal Purchase bundle ID across tvOS + iOS | Adult-content gate enforcement on the client (server-side, M1.5 contract is authoritative) |

## Architecture decisions inherited (locked, not re-litigated)

From the strategic-update doc:

- **A** — One product, one App Store submission.
- **B** — Rust beachhead at M3, not M2. M2 stays language-stack-as-is.
- **C** — Self-hosted only.
- **D** — Web SPA permanent second-class.
- **E** — Universal iOS binary with iPad-specific layouts on top.

From the cross-service contract:

- **§4** — Internal-principal: Hybrid D + Rust-canonical. M2's Hono call sites already mint these; no Apple-side work.
- **§5** — Device-token: JWE A256GCM, `aud='device'`, 1-year TTL, `kid` for rotation. Hono `mintDeviceToken` already implemented; vectors in `tests/vectors/device-token-kid-rotation.json`.
- **§8** — Sub namespace: `plex:<id>` | `local:<ulid>` | `apple:<ulid>`. Apple-side stores the namespaced sub as the Keychain key alongside the device token.

## What's already done that M2 builds on

- **`server/routes/device.ts`** — `POST /api/auth/device/start` and `POST /api/auth/device/poll` are live. The Apple-side device pairing flow has its server contract.
- **`server/services/keyDerivation.ts`** — `INFO_DEVICE_TOKEN` HKDF label active.
- **`crates/emerald-contracts`** — Rust core (8 modules, 38 tests).
- **`crates/emerald-contracts-napi`** — N-API binding for Hono. Cross-binding test against PyO3 passes.
- **`crates/emerald-contracts-pyo3`** — PyO3 binding for the recommender.
- **`tests/vectors/`** — Canonical test vectors (`stream-token-canonical.json`, `device-token-kid-rotation.json`, `internal-principal.json`, `sub-namespace.json`, `hkdf-parity.json`). These are the same vectors a Swift port must round-trip.

## New top-level repo

Per upstream §1: **sibling repo `theemeraldexchange-apple/`**. Do NOT add Xcode artifacts to this repo. Both repos pin the same `emerald-contracts` Rust crate version via git submodule or a Cargo registry mirror (decide in plan-phase — submodule is simpler for solo dev).

### Repo layout

```
theemeraldexchange-apple/
├── Package.swift                                # SPM workspace root
├── Sources/
│   ├── EmeraldContracts/                        # Swift port of emerald-contracts
│   │   ├── HKDF.swift                           # CryptoKit-backed HKDF-Expand
│   │   ├── DeviceToken.swift                    # JWE A256GCM verify (decrypt only — Apple never mints)
│   │   ├── StreamToken.swift                    # HMAC-SHA256 sign + verify
│   │   ├── Sub.swift                            # namespace parse (plex|local|apple)
│   │   └── Vectors/                             # bundled copies of tests/vectors/*.json
│   └── EmeraldKit/                              # shared SwiftUI/Combine SDK
│       ├── API/
│       │   ├── EmeraldClient.swift              # URLSession async/await client
│       │   ├── DeviceFlow.swift                 # start + poll PIN endpoints
│       │   ├── IptvAPI.swift                    # /api/iptv/* typed endpoints
│       │   ├── PlayerGrants.swift               # grant endpoints + token resolution
│       │   └── Errors.swift                     # discriminated server-side errors
│       ├── Models/                              # Codable mirrors of Hono DTOs
│       │   ├── Channel.swift
│       │   ├── VodItem.swift
│       │   ├── SeriesEpisode.swift
│       │   ├── EpgProgram.swift
│       │   ├── Favorite.swift
│       │   └── WatchHistoryEntry.swift
│       ├── Auth/
│       │   ├── DeviceTokenStore.swift           # Keychain wrapper
│       │   └── PINFlow.swift                    # state machine for the pair UI
│       ├── Player/
│       │   ├── EmeraldPlayer.swift              # AVPlayer wrapper, grant resolver
│       │   ├── TrackSelection.swift             # audio + subtitle track API
│       │   └── HeartbeatTimer.swift             # 30s heartbeat to keep grant alive
│       └── State/                               # Observable stores
│           ├── CatalogStore.swift
│           ├── FavoritesStore.swift
│           └── HistoryStore.swift
├── Apps/
│   ├── EmeraldTV/                               # tvOS target
│   └── EmeraldMobile/                           # iOS universal target
├── Tests/
│   ├── EmeraldContractsTests/                   # round-trip against the shared vector files
│   └── EmeraldKitTests/                         # API client, model decoding
├── .github/workflows/
│   └── apple-ci.yml                             # build EmeraldKit + run tests on macos-15
└── README.md
```

## EmeraldContracts (the Swift port)

This is the largest piece of new code. It mirrors `crates/emerald-contracts/src/` and round-trips the same vectors that the napi + pyo3 bindings round-trip.

### Modules

| Swift module | Rust source | What it does on Apple |
|---|---|---|
| `HKDF` | `keys.rs` | Derive 32-byte keys from `INTERNAL_PRINCIPAL_SECRET` (never on the device — the device never sees this) and `SESSION_SECRET` analogues. The device-side only NEEDS hkdf for the device-token-decrypt key, derived from `INFO_DEVICE_TOKEN` over the server's secret — and the device never holds the server secret. **In practice the device only uses the parsed JWE bytes the server emits; the HKDF code is a parity check, not a load-bearing runtime path.** |
| `DeviceToken` | `device_token.rs` | Verify-only. The app stores the JWE compact-serialization string in Keychain. The app doesn't decrypt it locally — the server validates on every request. So this module exists to round-trip the wire format for tests and (future M6) for offline-token introspection. |
| `StreamToken` | `stream_token.rs` | Verify HMAC stream tokens before passing them to AVPlayer. Lets the app fail fast on a server-issued token that's about to be rejected by the proxy. Cheap defense in depth. |
| `Sub` | `sub.rs` | Parse `plex:12345` / `local:01H...` / `apple:01H...` into discriminated cases. Used by `DeviceTokenStore` to key Keychain entries. |
| `Vectors` | `tests/vectors/*.json` | Bundled at build time so the Swift test suite runs on macos-15 CI without network. |

### Crypto primitives

- **HKDF-Expand**: `CryptoKit.HKDF<SHA256>.deriveKey(inputKeyMaterial:info:outputByteCount:)` — has been HKDF-correct since iOS 14. Apple-side parity test feeds the same `secret_hex_utf8` from `hkdf-parity.json` and expects byte-identical 32-byte output.
- **A256GCM**: `CryptoKit.AES.GCM.SealedBox(combined:)` + `AES.GCM.open(_:using:)`. JOSE compact JWE = `header.encryptedKey.iv.ciphertext.tag` (5 parts, base64url). Apple-side parsing splits + base64url-decodes, then feeds the IV/ciphertext/tag into the SealedBox combined buffer.
- **HMAC-SHA256**: `CryptoKit.HMAC<SHA256>` for stream-token verify.
- **No third-party crypto.** Only CryptoKit. Avoids `swift-crypto` even though it's API-identical, because shipping a binary dep makes the App Store reviewer ask why.

### Test plan

- For each vector file, decode the JSON, drive the Swift API with the inputs, assert byte-identical outputs (or byte-identical JSON-encoded claims after decrypt).
- Same vectors are already round-tripped by Rust unit tests + napi cross-binding tests + pyo3 parity tests. Swift is the fourth.
- New file: `Tests/EmeraldContractsTests/CrossBindingTests.swift` — XCTest cases parameterized by vector file name.

## EmeraldKit (the shared SDK)

### API client

`URLSession` + async/await. No Alamofire, no Combine for the network layer (use `AsyncSequence` where streaming is needed).

```swift
public actor EmeraldClient {
    public init(baseURL: URL, tokenStore: DeviceTokenStore) { ... }

    public func startDeviceFlow() async throws -> DeviceFlowStart
    public func pollDeviceFlow(pinId: String) async throws -> PollResult

    public func categories(kind: CategoryKind) async throws -> [Category]
    public func channels(in category: Int?) async throws -> [Channel]
    public func vodItems(in category: Int?, search: String?) async throws -> [VodItem]
    public func vodDetail(streamId: Int) async throws -> VodItem
    public func epgNow(channelIds: [Int]) async throws -> [EpgNowSlot]

    public func grantLive(streamId: Int, client: ClientHint) async throws -> StreamGrant
    public func grantVod(streamId: Int, client: ClientHint) async throws -> StreamGrant
    public func grantSeriesEpisode(_ id: String, client: ClientHint) async throws -> StreamGrant
    public func grantCatchup(streamId: Int, startUtc: Date, durationMin: Int, client: ClientHint) async throws -> StreamGrant

    public func favorites() async throws -> [Favorite]
    public func addFavorite(_ f: Favorite) async throws
    public func removeFavorite(_ f: Favorite) async throws

    public func history(limit: Int) async throws -> [WatchHistoryEntry]
    public func reportPosition(_ entry: WatchHistoryEntry) async throws
}
```

Every method auto-attaches `Authorization: Bearer <deviceToken>` from the `DeviceTokenStore` if one's present. The PIN endpoints are unauthenticated (cookie-flow-equivalent).

### `ClientHint`

Tells the server which delivery path to negotiate. Locked values (must match the Hono `?client=` parameter handled in `iptvStream.ts`):

- `.web` — `.ts` for live, direct HLS for VOD. **Not used by the Apple targets** — bundled for code-sharing with a future macOS web-tunnel view if anyone wants one.
- `.avplayer` — server returns the M1 phase 4b remux path for live (HLS-from-ffmpeg) and direct HLS for VOD/series.

```swift
public enum ClientHint: String {
    case web = "web"
    case avplayer = "avplayer"
}
```

### `EmeraldPlayer`

Thin SwiftUI-friendly wrapper around `AVPlayer` + `AVPlayerViewController`. Handles:

- Grant fetch → `AVURLAsset` → `AVPlayerItem` chain.
- Heartbeat timer: every 30s, POSTs to a session-keepalive endpoint (M2 stretch — falls back to "re-grant on stall" if the keepalive endpoint slips to M3).
- Position reporting: debounced 5s on `addPeriodicTimeObserver`, POSTs to `/api/iptv/history`.
- AirPlay + PiP: free with `AVPlayerViewController`. Set `allowsPictureInPicturePlayback = true` and `usesExternalPlaybackWhileExternalScreenIsActive = true`.
- Audio + subtitle track selection: `AVMediaSelectionGroup` for `.audible` and `.legible`. The grant payload's `tracks` array hints the UI which to surface; selection drives `currentMediaSelection`.

### `DeviceTokenStore`

```swift
public actor DeviceTokenStore {
    public func storedToken() -> StoredToken?
    public func store(token: String, serverId: UUID, sub: Sub, deviceId: ULID) throws
    public func clear() throws
}

public struct StoredToken {
    public let raw: String
    public let serverId: UUID
    public let sub: Sub
    public let deviceId: ULID
}
```

Keychain attributes: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (per upstream §2). One entry per `(serverId, sub)` pair so multi-account on the same device is forward-compatible (M6, not M2).

## EmeraldTV (tvOS app)

- **Focus engine first.** Every interactive surface uses native `Button`, `NavigationStack`, `LazyVGrid` with `.focusable()` modifiers.
- **No `UIKit` shims.** Pure SwiftUI for tvOS 17+.
- **First-launch screen:** PIN code displayed at ~30pt SF Pro Display Bold, plus `plex.tv/link` URL beneath. Poll every 2s with exponential backoff after the first minute.
- **Top-level nav:** Live | VOD | Series | Favorites | Settings.
- **Player overlay:** native `AVPlayerViewController`. Custom overlay only for the audio/subtitle picker (focus-engine-friendly modal).

Minimum target: tvOS 17.

## EmeraldMobile (iOS universal)

- **One iOS target, two layouts.** Use `@Environment(\.horizontalSizeClass)` to fork. Compact → `NavigationStack`. Regular (iPad) → `NavigationSplitView` with sidebar + content + detail.
- **Lock orientation per view:**
  - Browse views: portrait or landscape.
  - Player view: landscape only on iPhone; both on iPad.
- **First-launch PIN screen:** mirrors EmeraldTV layout, scales for compact width.
- **Local-network permission prompt:** Bonjour discovery is M5 — skip in M2 unless real-device testing in phase 4 surfaces demand. iOS will prompt at first launch when we add it; design now so the empty manual-URL screen is the v1 onboarding.

Minimum target: iOS 17 (matches the EmeraldKit minimum; SwiftData is iOS 17+).

## Hono-side adjustments (small)

The device-flow endpoints exist. Two small additions needed in M2 phase 0:

1. **`/api/iptv/health` returns `apiVersion`** — Apple client uses this for the M2-defined min-server-version check (cross-service contract §13).
2. **Stream-grant response includes `protocolVersion`** — for forward compatibility when M4's grant shape evolves.

Both are additive; no Apple-side blocker if they slip.

## TestFlight pipeline

### Strategy

**Pick: GitHub Actions matrix on `macos-15` + Fastlane.**

| Option | Pro | Con |
|---|---|---|
| Xcode Cloud | Apple-native, included with Developer Program | Locks the build into iCloud; harder to reproduce locally; less debuggable when CI hangs |
| GitHub Actions + Fastlane | Same CI pattern as the existing repo; build artifacts inspectable; cheap to extend with codesign, App Store Connect upload | Requires App Store Connect API key + Fastlane Match for signing certs |
| Manual Xcode → TestFlight | Zero infra | Manual every time; humans forget |

GitHub Actions wins on solo-dev maintainability. Apple-CI workflow lives at `theemeraldexchange-apple/.github/workflows/apple-ci.yml`:

- **On PR:** build EmeraldKit, run EmeraldContractsTests + EmeraldKitTests, fail on test fail.
- **On push to `main`:** above, plus `xcodebuild archive` + `fastlane pilot upload` to TestFlight internal group.
- **Manual trigger:** "promote latest internal build to external public link."

### App Store Connect prereqs

Operator (you) does once:

1. Apple Developer Program ($99/yr, individual).
2. Create App ID with `com.theemeraldexchange.app` (or chosen reverse-DNS).
3. Enable Universal Purchase on the App ID.
4. App Store Connect: create app entry with iOS + tvOS targets.
5. Generate App Store Connect API key (P8 file + key ID + issuer ID).
6. Add API key to GitHub Actions secrets: `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_P8`.
7. Fastlane Match: dedicated private repo for certs (NOT this repo — Match wants its own).

## Execution phases

| Phase | Scope | Output |
|---|---|---|
| 0 | Repo creation + SPM workspace skeleton + apple-ci.yml hello-world | Apple-CI green on a no-op build |
| 1 | EmeraldContracts: HKDF, Sub, Vectors. Tests round-trip `hkdf-parity.json` + `sub-namespace.json`. | 2/8 vector files round-tripping in Swift |
| 2 | EmeraldContracts: DeviceToken + StreamToken. Tests round-trip `device-token-kid-rotation.json` + `stream-token-canonical.json`. | 4/8 vector files |
| 3 | EmeraldKit API/Models/Auth — device-flow + IPTV catalog endpoints. Models decode against real Hono responses captured as JSON fixtures. | Catalog browse compiles + tests pass |
| 4 | EmeraldKit Player — AVPlayer wrapper, grant resolver, track selection, position reporting | EmeraldPlayer plays a real VOD HLS in a test harness |
| 5 | EmeraldTV target — PIN screen, top-level nav, live/VOD/series grids, player overlay | TestFlight build to your Apple TV |
| 6 | EmeraldMobile target — same content, compact + regular layouts, orientation locks | TestFlight build to your iPhone + iPad |
| 7 | Favorites + history sync on both targets | Resume across web + tvOS + iOS for the same `sub` |
| 8 | EPG grid + catchup grants on both targets (stretch — slip to M3 if needed) | Catchup playback works on tvOS |
| 9 | TestFlight external public-link enablement, first stranger-tester | First non-household tester runs the app |

## Verification gates

**Phase 1 gate (EmeraldContracts/HKDF):**
- `swift test --filter HKDFParityTests` passes.
- For each row in `hkdf-parity.json`, Swift `HKDF.expand(secret:info:length:)` produces byte-identical output to the Rust + napi + pyo3 fixtures.

**Phase 2 gate (DeviceToken + StreamToken):**
- Same shape — Swift decode of a JWE produced by Hono's `mintDeviceToken` yields the same claim set the Rust core produced.
- Stream-token HMAC verify on a token signed by Hono's `signStreamToken` succeeds.

**Phase 3 gate (API client):**
- Real PIN flow against a dev Hono — open EmeraldTV, type code into plex.tv/link from a Mac browser, app receives device token, persists in Keychain, subsequent catalog browse succeeds.

**Phase 5 gate (EmeraldTV):**
- TestFlight build installed on a real Apple TV 4K.
- PIN flow → catalog browse → live channel playback through the M1 remux path → AirPlay to a HomePod works.

**Phase 6 gate (EmeraldMobile):**
- TestFlight build installed on a real iPhone + iPad.
- Same flow as Phase 5 + iPad NavigationSplitView shows the sidebar.

**Phase 9 gate (external public link):**
- At least one non-household tester installs via the public link and reports a working build.

## Risks specific to M2

| Risk | Mitigation |
|---|---|
| Swift port of the contracts crate drifts from the Rust core | Cross-binding tests + shared vectors. Every release of `emerald-contracts` bumps the vector files; Apple CI fails on a vector hash mismatch. |
| AVPlayer rejects the M1 phase 4b remux HLS playlist | Phase 5 gate is real-device test. If it fails, fall back is to add `-hls_flags +independent_segments` + bump `-hls_time` to 6s. Already documented in `iptvRemux.ts`. |
| TestFlight build expires (90-day hard limit) | Calendar reminder on day 85 to push a new build even if no changes. |
| Keychain restore-from-backup transfers the device token to another user's device | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (NOT plain `AfterFirstUnlock`) per upstream §2. iCloud Keychain still syncs this; document that household members should not share Keychain. |
| Apple raises minimum target OS mid-M2 | iOS 17 / tvOS 17 already set. Apple typically gives 6+ months notice. Bump in-place if it happens. |
| App Store reviewer rejects mid-M5.5 because the app browses IPTV | Out of M2 scope. The strategic-update doc §5 covers the policy hardening for M5.5; M2 builds the unified app and ships to TestFlight only. |

## Open questions for `/gsd:new-milestone` brainstorm

The strategic-update doc answered most. The remaining M2-specific questions to surface in the brainstorm:

1. **Submodule vs Cargo registry mirror for `emerald-contracts`?** Submodule (1 line of CI to update) vs registry (less rebase pain). Recommend submodule for solo dev.
2. **SwiftUI Observation (`@Observable`) vs Combine `ObservableObject` for State stores?** Observation is iOS 17+ native and cleaner. Default to Observation; revisit if older target needed.
3. **Test framework: XCTest vs Swift Testing?** Swift Testing (the `@Test` macro, Xcode 16+) is cleaner but newer. Default XCTest; explore Swift Testing as a stretch in phase 1.
4. **Bonjour discovery: M2 or defer to M5?** Strategic-update says M5 stretch. If real-device test in phase 5 is friction-y because of manual URL entry, promote to M2 phase 6.
5. **Reviewer demo content host: same NAS, separate compose profile?** Yes — separate compose profile with `auth_mode=local` and Big Buck Bunny / Sintel only. Defer concrete setup to M5.5.
6. **Universal Purchase before or after first internal TestFlight?** Strategic-update locks Universal Purchase. Configure during Phase 0 — cheaper to set up correctly first.

## Cross-references

- M1 plan: `docs/superpowers/specs/2026-05-24-mybunny-and-plex-replacement-design.md`
- Strategic update: `docs/superpowers/specs/2026-05-25-apple-multiplatform-and-rust-pivot.md`
- Cross-service contract: `docs/superpowers/specs/2026-05-25-cross-service-contract.md`
- M3 internal-principal rollout: `docs/operations/m3-internal-principal-rollout.md`
- Existing device-flow endpoints: `server/routes/device.ts`
- Existing device-token minter: `server/session.ts`
- Existing key derivation labels: `server/services/keyDerivation.ts`
- Canonical Rust crate: `crates/emerald-contracts/`
- N-API binding (parity reference): `crates/emerald-contracts-napi/`
- PyO3 binding (parity reference): `crates/emerald-contracts-pyo3/`
- Shared vectors: `tests/vectors/`
