# Monetization & Publishing Decision Document

**Status:** Decision-ready planning doc. No code or prod changes made.
**Date:** 2026-05-30
**Audience:** Owner (Chris Pachulski)
**Scope:** Can theemeraldexchange be monetized and published to the App Store, what blocks it, and the concrete path through.

Synthesized from 7 agent reports (4 research, 3 audit). File:line citations verified against the working tree.

---

## 1. Executive Summary — the honest bottom line

**Yes, this can be monetized and published — but not in its current state, and not without resolving one hard licensing blocker and making one product decision about IPTV.**

The product is unusually well-positioned. The market is barbell-shaped: Plex is actively user-hostile (tripling its lifetime price from $250 to **$749.99 on 2026-07-01**, and as of Apr 2025 it paywalls remote streaming of *your own media*), and Jellyfin is free but ships **broken native Apple clients** (Swiftfin tvOS v1.0.1 is completely broken on AppleTV 26; iOS lacks PiP and mid-playback subtitle switching). The wedge is real and the timing is a gift: **a privacy-respecting self-hostable server with a genuinely excellent native iOS/tvOS client, that never paywalls streaming your own media, launched to catch the July 1 2026 Plex-refugee wave.**

The codebase is also unusually ready. Security is mature (no committed secrets, strong auth convergence). The entitlement architecture is greenfield but clean: identity already flows through one verified object (`InternalClaims`) that both Rust services trust, and every paywall decision point already exists as a centralized seam. Adding entitlements is mostly plumbing, not surgery.

**The three hardest obstacles, in order:**

1. **FFmpeg GPL contamination (hard blocker).** Every shipped image bundles a GPL-3.0+ static ffmpeg (`mwader/static-ffmpeg:7.1`, built with libx264/libx265 `--enable-gpl`). GPL-3.0 is **incompatible with the App Store** (Apple's DPLA imposes terms GPLv3 §7 forbids), and you currently redistribute it with **zero** source offer or attribution. This blocks both TestFlight (M2) and any binary distribution. Must be fixed before anything ships.
2. **IPTV viewer (product decision + App Store risk).** An open IPTV viewer fails App Review Guideline 5.2.3 (cannot prove rights to third-party streams) and creates DMCA exposure. M6 monetization makes it worse. This is the single feature most likely to get the app rejected.
3. **Apple's IAP cut is structural, not dodgeable long-term.** The external-payment "loophole" is a temporary, US-only, closing window (Dec 2025 appeals ruling restored Apple's right to a commission; remanded Apr 2026 to set the rate). The clean answer is to sell on your own web storefront and ship a **purchase-silent free companion app** — but that requires discipline (zero buy UI in-app) and is itself a decision.

None of these are fatal. All are resolvable before launch. The rest of this doc is the path.

---

## 2. BLOCKERS — must be resolved before publishing/monetizing

### BLOCKER 1 — FFmpeg GPL-3.0+ contaminates every shipped image, and is App-Store-incompatible

**Evidence (verified):**
- `Dockerfile:77`, `crates/media-core/Dockerfile:30`, `crates/transcoder/Dockerfile:30` each: `COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /ffprobe /usr/local/bin/`. That static build is compiled `gpl/version3/libx264/libx265` → **GPL-3.0+**.
- The transcoder's CPU fallback **is** libx264 (`crates/transcoder/src/args.rs:46`), so the GPL encoder is on a live code path, not dormant.
- Baking the binary into a shipped image means the image **conveys** a GPL work. GPLv2/3 §3 then obligates you to (a) ship a written offer for the complete corresponding ffmpeg source, and (b) carry the GPL license text + attribution. **The project ships none of this.**
- **App Store incompatibility:** GPL-3.0 cannot ship via the App Store. Apple's Developer Program License Agreement imposes use/device restrictions that GPLv3 §7 forbids. This is independently flagged in `docs/03-section-14-license.md:10` and `:68`. This blocks M5 (native clients) outright if ffmpeg ships inside the app bundle.
- Internal contradiction: `LICENSE:5-8` claims proprietary control over "all compiled binaries," which is directly contradicted by the bundled GPL ffmpeg.

**Why the Rust code itself is safe (the key enabler):** the transcoder invokes ffmpeg as a **separate process** via `tokio::process` (no FFI/linking — explicit in `crates/transcoder/Cargo.toml` and `crates/transcoder/src/session.rs`). Per the FSF GPL FAQ (https://www.gnu.org/licenses/gpl-faq.html#GPLInProprietarySystem), arms-length CLI/pipe communication does **not** trigger GPL on your proprietary code. So the contamination is **only** the bundled binary, not your source. That makes the fix surgical.

**Fix options (pick one — see Decision 2):**
- **(A) Rebuild ffmpeg LGPL-only** (drop `--enable-gpl`, drop libx264/libx265; use libopenh264 or hardware encoders / a separately-licensed x264). Escapes the GPL source-offer entirely and clears the App Store path. **Trade-off:** loses x264/x265 software encoders — you must lean on hardware encode (VideoToolbox on Apple, VAAPI/NVENC on NAS) and/or openh264. This is the recommended path for App-Store-bound shipping.
- **(B) Keep GPL ffmpeg but distribute it separately** (not baked into the app bundle; downloaded/installed alongside on the NAS), host the exact matching source tarball + GPL text + build config, and add an in-app "Open Source Notices" page. Works for the **self-hosted server**, does **not** work for the iOS bundle.
- **Hard avoid:** `libfdk_aac` — requires `--enable-nonfree`, which makes the binary legally non-redistributable.

**Practically:** the NAS server can ship GPL ffmpeg via path (B) with proper notices; the iOS/tvOS client cannot contain GPL ffmpeg at all and should use VideoToolbox (Apple's native hardware decode/encode) — which it should anyway for performance.

---

### BLOCKER 2 — IPTV viewer fails App Review Guideline 5.2.3 and carries DMCA risk

**Evidence:**
- App Review Guideline 5.2.3 / 5.2 rejects apps that provide "potentially unauthorized access to third-party audio/video streaming." An open IPTV viewer cannot prove rights to the streams it plays. Developers bear all IP-infringement liability.
- M6 monetization **worsens** this: gating or selling around third-party IPTV content moves you from "neutral player" toward "profiting from unauthorized access."
- The audit also surfaced an operational exposure (lower severity, but worth noting): Xtream credentials are embedded in upstream URL paths — `server/services/xtream.ts:64`, `server/routes/iptv.ts:715/759` build `${host}/live/${username}/${password}/${streamId}.ts`. The token-proxy correctly hides this from end-clients, and `xtream.ts` does not log these URLs, but the shared credential is visible to the upstream provider and any TLS-terminating intermediary.

**Resolution path (must choose — see Decision 3):**
- The IPTV feature, **if it ships in the App Store build at all**, must be a **bring-your-own-playlist player only**: no bundled, curated, or discoverable channel lists; an explicit in-EULA disclaimer that all streams are user-supplied and you neither host nor endorse them; off-by-default.
- **Recommended:** keep IPTV **web-only** for v1 App Store launch, or ship it in a later update once the core media app is established. Do **not** make it a paid/premium surface that monetizes third-party content — that is the highest-risk possible framing.

---

### BLOCKER 3 — Apple IAP commission is structural; do not architect revenue around the external-payment loophole

**Evidence:**
- Guideline 3.1.1: unlocking features/subscriptions/content **inside** the app requires StoreKit IAP.
- The 2024-2025 Epic ruling did **not** eliminate the cut. The Dec 2025 US appeals court **restored** Apple's right to charge a "reasonable" commission on external-link purchases and let Apple suppress external-link prominence (https://www.macrumors.com/2025/12/11; https://www.revenuecat.com/blog/growth/apple-anti-steering-ruling-monetization-strategy). Rehearing denied Mar 2026; remanded Apr 2026 to set the exact rate. **External-link commission-free purchasing is a temporary, US-only, closing window.**

**Resolution:** sell the Pass on your own web storefront (Stripe, 0% Apple cut) and ship the iOS/tvOS app as a **free, purchase-silent companion** under Guideline 3.1.3(b)/(f). This is legitimate because the app connects to the user's own server (genuine multiplatform/self-hosted service). The constraint is absolute: **the app must contain no purchase UI and no call-to-action to buy outside.** Any in-app "upgrade" link drops you back under 3.1.1 and you owe IAP. See §3 and §4.

---

## 3. Recommended Monetization Model

**PRIMARY (recommended): Plex-Pass-style hybrid, sold web-first, with a free purchase-silent companion app.**

- **Core self-hosting is free forever** — library scan, local stream, remote streaming of your own media, single user. This is the adoption engine and the explicit anti-Plex positioning. **Never paywall streaming your own media.**
- **A paid "Pass"** unlocks owner/power-user features. Offer **both** a subscription **and** a lifetime tier — this market values ownership heavily and reacts badly to forced rent.
- **Sold on your own Stripe web storefront** → you keep ~100% of revenue, no Apple dependency for core income.
- **iOS/tvOS ships as a free companion app** (Guideline 3.1.3 safe harbor) → Apple takes 0%. Entitlement resolves server-side at sign-in; the app just lights up features. No buy button, ever.
- **Reserve StoreKit IAP only** for an optional convenience tier (e.g. hosted relay/cloud transcode/off-site backup) where in-app conversion is worth Apple's 15% — and enable Family Sharing on it.

**Pricing (anchors to undercut):** Plex $69.99/yr & $749.99 lifetime; Emby $54/yr & $119 lifetime; Infuse $16.99/yr & $99.99 lifetime; Channels $80/yr; Jellyfin free.
- **Subscription:** ~$3-5/mo or ~$30-40/yr.
- **Lifetime:** ~$100-150 — dramatically under Plex's new $749.99, in the Infuse/Emby range, positioned as the ownership-friendly Plex refuge.

**Why this over the alternatives:**
- **vs subscription-only:** alienates the ownership-motivated base you are specifically trying to win from Plex. Lifetime gives cash up front to fund the 12-18mo M3-M5 build; the sub gives recurring runway. (Lifetime risk: never let lifetime obligate you to eat recurring infra cost — scope lifetime to "app + self-host features," and put any ongoing-cost service behind the separate recurring/IAP tier.)
- **vs in-app IAP as primary:** costs you 15-30% and makes Apple a dependency for core income, for a product whose whole pitch is self-hosted independence.
- **vs the external-payment loophole:** closing in 2026 (Blocker 3). Transient, do not build on it.
- **vs AGPL/fully-free (Jellyfin model):** gives up monetization entirely; the differentiators (native clients, recommender) are exactly what justifies paying.

### Free vs Paid split, mapped to M6

| Feature | Free | Paid "Pass" | Enforcement seam (file:line) |
|---|---|---|---|
| Library scan + local stream | ✅ | ✅ | already role-gated `crates/media-core/src/routes.rs:760` (scan = admin) |
| **Remote streaming of own media** | ✅ (never paywalled) | ✅ | — (explicit anti-Plex) |
| Single user | ✅ | ✅ | — |
| Hardware transcoding / advanced profiles | ❌ (or capped 1080p) | ✅ | `crates/transcoder/src/plan.rs:160` (clamp ladder); `crates/media-core/src/routes.rs:498` (deny handoff for free) |
| Concurrent streams (N per account) | 1 | N | `crates/transcoder/src/concurrency.rs:101` (needs per-`sub` dimension — see §4) |
| Multi-user / household / managed accounts | ❌ | ✅ | `server/services/members.ts:81` addMember (cap at mint) |
| Downloads / offline sync | ❌ | ✅ | **new** media-core route (offline manifest) — unbuilt today |
| Native iOS/tvOS polish (PiP, etc.) | basic | full | client-side |
| Recommender (richer metadata, skip-intro) | basic | ✅ | recommender already gated by `require_event_secret` (`recommender/app/main.py:112-119`) |
| IPTV DVR-to-disk | ❌ | ✅ (web-only, see Blocker 2) | **new** recordings route, reuse `IPTV_MAX_CONCURRENT_STREAMS` pattern |
| Multi-server | ❌ | ✅ | device-token mint |
| Hosted relay / cloud transcode / off-site backup | ❌ | **IAP tier** (15%, Family Sharing) | new `server/services/entitlements.ts` |

**Do NOT gate:** basic local playback or remote streaming of your own media. That is the line Jellyfin gives away free and Plex crossed; gating it kills the entire positioning.

---

## 4. Rust Entitlements / Licensing Architecture

**Current state (verified):** there is **zero** notion of plan/tier/entitlement/subscription/billing anywhere. The only authZ axis is `role TEXT ... CHECK (role IN ('admin','user'))` (`server/migrations/server/0003_members_invites.sql:21`), surfaced as `Member.role` (`server/services/members.ts:23`) and propagated as `InternalClaims.role` (`crates/emerald-contracts/src/internal_principal.rs:24`). Greenfield — nothing to retrofit.

### New crate: `crates/entitlements` (workspace name `emerald-entitlements`)

A **pure** crate depending only on `emerald-contracts` (the established leaf-dependency pattern — `Cargo.toml:3-9`; transcoder already does `use media_core::capability/auth/...`). No DB, no IO — exactly like `crates/media-core/src/capability.rs:47` `decide()` (pure, exhaustively unit-tested) and `crates/transcoder/src/concurrency.rs`.

**What it stores / defines:**
```
enum Plan { Free, Premium, Lifetime }
struct EntitlementSet { ... }   // resolved capability set
fn EntitlementSet::allows(Feature) -> bool        // pure gate
fn EntitlementSet::max_height() -> u32             // e.g. Free = 1080
fn EntitlementSet::max_transcodes() -> usize
fn EntitlementSet::concurrent_streams() -> usize
```
Mirror `capability.rs`'s pure-decision-function style. **Do NOT scatter `if plan == Premium` across routes** — route every check through `allows()`.

**The seam — add the entitlement field to `InternalClaims`:**

`InternalClaims` is THE identity object crossing every internal boundary (`internal_principal.rs:20-31`, verified — currently `{iss,sub,role,auth_mode,server_id,device_id,req_id,iat,exp}`, **no entitlement field**). Hono mints it (`server/services/internalPrincipal.ts:79`), media-core verifies it (`crates/media-core/src/auth.rs:21` + `principal_layer` at `:33`), the transcoder reuses the same verifier (`crates/transcoder/src/routes.rs:111`). It is a 60s JWE — the single trust-propagation path.

Add a compact capability field (e.g. `ent: Vec<String>` or a `plan` enum) to the struct. Because the N-API binding (`crates/emerald-contracts-napi`) and PyO3 binding (`crates/emerald-contracts-pyo3`) regenerate from the same struct, **Hono and the recommender pick it up for free**, already-verified, at every downstream gate, with **zero new network calls**.

**Enforcement integration points (verified file:lines):**

1. **media-core `play_grant`** — `crates/media-core/src/routes.rs:320`. After `capability::decide()` returns `!direct_play`, check the entitlement before proxying to the transcoder. **Note:** `play_grant` does **not** currently extract claims; widen its signature to `claims: Option<Extension<InternalClaims>>` (like `trigger_scan` does). Deny → return 402/403 grant instead of handing off. The handoff itself is `handoff_to_transcoder` (`routes.rs:498`); `mint_transcoder_principal` (`routes.rs:419`, copies role/auth_mode/sub at `:426-427`) must **also forward the new entitlement field**.

2. **transcoder `grant` + concurrency `Limiter`** — `crates/transcoder/src/routes.rs:248` builds a `TranscodePlan` and calls `sessions.start()`. **Structural gap (the one piece of real work):** caps are per-**server** globals — `Caps{max_total:4, max_cpu:1}` (`crates/transcoder/src/concurrency.rs:32-33`), and `try_acquire` (`concurrency.rs:101`) has **no per-`sub` dimension**. Plex-Pass "N simultaneous streams per account" cannot be expressed today. The data is present — `GrantRequest` carries `sub` (`routes.rs:239`), threaded through `StartOpts` (`routes.rs:271`, `session.rs:80`) — the limiter just ignores it. Fix: extend `Limiter` with a per-`sub` counter map, read the per-sub cap from the entitlement. The 503 `transcoder_busy` path (`routes.rs:289`) is the template for "concurrency limit reached for your plan." **Quality caps** (Free = 1080p) gate earlier, in `plan_transcode` (`crates/transcoder/src/plan.rs:160`) by clamping the ladder.
   - **Copy the existing model:** `server/services/iptvConcurrency.ts:56` `createConcurrencyTracker` already keys live sessions per `sub` (`:88-97`) and returns `reason:'iptv_concurrency_limit'` with limit/current (`:79-85`). It is the design template for the transcoder's missing per-sub limiter — its cap is just a single env global (`IPTV_MAX_CONCURRENT_STREAMS`, `:115`) and would become `cap = entitlement.concurrent_streams(sub)`.

3. **Hono `memberStatus()` resolves the plan** — `server/services/membership.ts:46` (verified) is "the single authoritative authZ decision," shared by both login paths and the per-request `sessionGate` (`server/services/sessionGate.ts:132`). Resolve the plan/tier here (read a new `members.plan` column or a `subscriptions` table), attach to the Session. It flows into `recommenderCallerFromSession` (`server/services/recommenderCaller.ts:69`) and into `mintInternalPrincipal` (`server/services/internalPrincipal.ts:88` — add the field to the claims object at `:88-108`, mirroring how `role` is passed). Every internal call site already funnels through `recommenderCallerFromSession`, so this is a one-place change.

**Persistence (Hono/TS side, new migration `server/migrations/server/0005_*.sql`):** prefer a dedicated `subscriptions(sub, plan, source, apple_txn_id, stripe_customer_id, expires_at, ...)` table over a bare `members.plan` column — StoreKit/Stripe need a verification + expiry record distinct from the membership allowlist.

**App Store IAP (StoreKit 2) + web path (Stripe):**
- Receipt verification belongs **server-side on the Hono/TS side**, never in Rust. A new `server/services/entitlements.ts` validates **Apple App Store Server API** receipts (StoreKit 2) and writes to the `subscriptions` table. The SIWA identity and HTTPS-to-Apple already live on the Hono side (`server/services/appleAuth.ts`). The intent is documented: `docs/superpowers/specs/2026-05-25-apple-multiplatform-and-rust-pivot.md:63` ("one App Store listing and one in-app entitlement").
- **Stripe (primary path):** the web storefront writes the same `subscriptions` table on successful Stripe webhook (`source='stripe'`).
- **The Rust crate consumes only the RESOLVED plan via the principal claim — it must never see receipts or talk to Apple/Stripe.** Hono is the authority that resolves entitlement (exactly as it resolves `role` at `sessionGate.ts`); Rust services are pure enforcers reading the verified claim.

**Offline-friendly for self-hosters:** entitlement resolves at mint time into the 60s JWE and is then enforced locally by the Rust services with no callback. A self-hoster's server validates the receipt/Stripe state, caches the resolved plan, and re-checks expiry at the next 60s principal refresh — so a lapsed subscription drops to Free automatically (analogous to how a revoked member cascades at `membership.ts:61`). For genuinely offline self-hosters, cache the last validated entitlement with a generous grace window so an internet blip never downgrades a paying user mid-stream. **No phone-home for core enforcement** — fits the privacy-first positioning and the per-self-hoster telemetry-island model.

---

## 5. App Store Publish Checklist (ordered)

1. **Resolve Blocker 1 (ffmpeg).** iOS/tvOS client must contain **no GPL ffmpeg** — use VideoToolbox for hardware decode/encode. NAS server ships LGPL-rebuilt ffmpeg (or GPL via separate distribution with full source offer + notices). *Gate: nothing publishes until this is done.*
2. **Resolve Blocker 2 (IPTV).** Decide IPTV fate (Decision 3). For v1, keep IPTV web-only OR ship as BYO-playlist player, off-by-default, with EULA disclaimer.
3. **Frame as owned-content player** (App-Store-proven, like Infuse/Plex): stream user's NAS files, no bundled catalogs, own-server only, **no copyrighted screenshots** in the listing. M3 media-core + M5 native clients are publishable on this framing.
4. **Sign in with Apple (Guideline 4.8).** Plex login is third-party social login → Sign in with Apple must be **co-equal wherever Plex login appears**. Already planned. (Passkeys alone do **not** trigger 4.8 — only Plex does.)
5. **Privacy Manifest** (`PrivacyInfo.xcprivacy`) — mandatory since May 2024. Declare recommender data if identity-linked. Self-hosted Glitchtip needs no ATT prompt. **Confirm no third-party analytics SDK is in the iOS build** (the audit notes `@sentry/node` server-side — verify the iOS build phones home to self-hosted Glitchtip only).
6. **Privacy Policy URL** — mandatory in App Store Connect (General Information → Privacy URL). Non-negotiable: the app collects passkeys/WebAuthn IDs, Sign-in-with-Apple tokens, Plex tokens, (hosted) billing.
7. **App privacy labels** — declare data types/linkage consistent with the manifest.
8. **EULA** — ship Apple's Standard EULA for M2/M5 (lowest risk; auto-applies). Introduce a custom EULA only at the hosted/premium tier (and only then meet Apple's 10 minimum terms).
9. **Demo account + reachable server for App Review (Guideline 2.1).** Invite-only own-server apps **stall** under 2.1. Provide reviewers a working demo account against a reachable demo server.
10. **UGC moderation (Guideline 1.2)** — only required **if** M6 adds multi-user sharing. Defer until then.
11. **(If IAP tier ships)** StoreKit 2 products configured, server-side receipt validation live (`server/services/entitlements.ts`), Family Sharing enabled (`isFamilyShareable` — irreversible once on; households are the buying unit).

---

## 6. Legal / Licensing Actions

### Product LICENSE choice (currently: proprietary "all rights reserved")

`LICENSE` is "THE EMERALD EXCHANGE — PROPRIETARY SOFTWARE LICENSE … All rights reserved" (verified, `LICENSE:1-10`), and `Cargo.toml` sets `license-file=LICENSE` on every crate. That is the most restrictive option — fine if you never want outside self-hosters, but it **blocks community self-hosting**, which is the entire adoption engine of the recommended model.

**Options (for publishing source while reserving monetization):**
- **PolyForm Shield or Noncommercial** (https://polyformproject.org) — source visible, free to self-host, commercial/hosted use requires a paid grant from you. Shield = "everything allowed except competing with you." **← RECOMMENDED.** Cleanest fit for "free to self-host, pay me to host commercially," keeps the premium/hosted M6 differentiators monetizable, and lets you control commercial grants directly (cleanly resolves the LICENSE-deferral note in memory).
- **BSL 1.1** (MariaDB/Sentry model) — source visible, production use grant-defined, auto-converts to an OSI license after ~4 years. Good if you want a time-delayed open future.
- **Elastic License 2.0** — permissive-ish with a simple "no offering as a managed service to third parties" clause.
- **AGPLv3** — OSI-approved "real open source," but §13 forces you **and** any hosted competitor to publish full source including modifications over the network. **AVOID** — it would force you to open-source the very hosted/premium differentiators M6 exists to monetize. (Redis tried SSPL, got backlash, returned to AGPLv3 in 2025 — a cautionary tale either way.)

**Recommendation: PolyForm Shield** (or Noncommercial). Keep the server source open for trust and self-hosting; reserve commercial/hosted monetization.

### Required documents
- **Privacy Policy URL** — mandatory now (App Store). See §5.6.
- **EULA** — Apple Standard for v1; custom only at hosted tier (must meet Apple's 10 minimum terms: EULA is you↔user not Apple; you are solely responsible for app + content; Apple is a third-party beneficiary who can enforce; support is yours; IP/product-liability claims are yours).
- **Terms of Service** — required when the hosted tier (M6) charges money: billing, cancellation, acceptable use, liability cap, governing law. Don't hand-roll; base on TermsFeed/iubenda, **have the liability cap reviewed once before charging.**
- **GDPR/CCPA Privacy Policy (hosted)** — enumerate data categories (account identity, WebAuthn creds, Plex/Apple OAuth tokens, viewing/library metadata, IP, billing), purposes, retention, and **subprocessors**. The audit flags `@sentry/node` and `@anthropic-ai/sdk` in `package.json` as subprocessors that must be disclosed if they phone home in the hosted build — confirm whether `@sentry/node` points at self-hosted Glitchtip (no third party) or Sentry SaaS (must disclose).
- **DPA** — only for business/team self-hosters you host; names subprocessors.
- **DMCA §512 designated agent** — register **only if/when** users can upload/store content others can fetch on your hosted systems (https://www.copyright.gov/512). A pure self-hosted owner streaming to invitees is **not** hosting third-party UGC — likely unnecessary there. The real App Store liability is the IPTV viewer (Blocker 2), not the personal library.

### FFmpeg compliance (ties to Blocker 1)
- For any GPL ffmpeg you distribute (NAS path): host the **exact matching** ffmpeg source tarball + GPL license text + build config, and add an in-app/in-image "Open Source Notices" page.
- Add a **NOTICE / THIRD-PARTY** file (none exists today — only `./LICENSE`). Apache-2.0 deps also need NOTICE propagation.

### CI license gate (half-day, do before publishing source)
- No `deny.toml` exists. Add it: `cargo deny check licenses` with GPL-2.0/GPL-3.0/AGPL set to **deny**.
- `npx license-checker --failOn 'GPL;AGPL'` for the Node tree. (Watch `mpegts.js` — verify LGPL/Apache; `hls.js` Apache/MIT is fine; `better-sqlite3`→SQLite public-domain is fine.)
- `pip-licenses` against `recommender/pyproject.toml`. (Audit found app trees clean: Rust `Cargo.lock` 273 crates all MIT/Apache-2.0; JS only `lightningcss` MPL-2.0 build-tool; Python `certifi/tqdm` MPL file-level, torch BSD. **ffmpeg is the sole copyleft contaminant.**)

---

## 7. Prioritized Roadmap

**Phase 0 — Unblock (must precede any distribution). BUILDABLE NOW.**
- Rebuild/repackage ffmpeg (Blocker 1): LGPL-only for the iOS bundle (VideoToolbox), GPL-with-compliance for the NAS server. *Blocks everything.*
- Decide + implement IPTV fate (Blocker 2 / Decision 3): web-only or BYO-player-off-by-default.
- Add NOTICE/THIRD-PARTY file + `deny.toml` + CI license gate.
- Choose product LICENSE (Decision 1) and re-license the repo.

**Phase 1 — Entitlement scaffolding. BUILDABLE NOW (greenfield, no external deps).**
- New `crates/entitlements` (pure crate) — `Plan`, `EntitlementSet`, `allows()`, caps.
- Add entitlement field to `InternalClaims` (`internal_principal.rs`); regenerate N-API/PyO3 bindings.
- Resolve plan in `memberStatus()` (`membership.ts:46`); inject at mint (`internalPrincipal.ts:88`).
- Migration `0005_*.sql`: `subscriptions` table.
- Wire pure gates at `play_grant` (`routes.rs:320`), `plan_transcode` (`plan.rs:160`), `handoff` (`routes.rs:498`).
- **Per-sub concurrency limiter** (the one structural piece) — extend `concurrency.rs` `Limiter` with a per-`sub` map, copying `iptvConcurrency.ts`.

**Phase 2 — Web payment path. BUILDABLE NOW (independent of Apple).**
- Stripe web storefront (sub + lifetime tiers).
- `server/services/entitlements.ts` writes `subscriptions` on Stripe webhook.
- Entitlement end-to-end: buy on web → plan resolves at sign-in → Rust enforces.

**Phase 3 — App Store readiness. PARTIALLY BLOCKED (needs Phase 0; needs Apple Developer assets — owner has membership).**
- Native iOS/tvOS client (M5) as free purchase-silent companion.
- Sign in with Apple co-equal; Privacy Manifest; Privacy Policy URL; demo account.
- VideoToolbox transcode in-client (depends on Phase 0 ffmpeg decision).

**Phase 4 — StoreKit IAP convenience tier. BLOCKED on Phase 3 + a hosted service existing.**
- StoreKit 2 + App Store Server API receipt validation in `entitlements.ts`.
- Family Sharing enabled. Reserve for hosted relay/cloud transcode only.

**Phase 5 — Hosted tier (M6 premium). BLOCKED on Phases 2-4 + legal docs.**
- ToS + GDPR/CCPA Privacy Policy + DPA + (if UGC) DMCA agent.
- Multi-user, downloads/offline (new media-core route), IPTV DVR (web), multi-server.

**Security hardening (parallel, before monetized launch — from audit, not blockers but close-before-paid):**
- **Closed 2026-06-07:** media-core/transcoder compose defaults now run `MEDIA_INTERNAL_PRINCIPAL_MODE=enforce` and fail closed without `INTERNAL_PRINCIPAL_SECRET`; prod was verified in enforce mode. Keep this invariant before charging money.
- **Partially closed:** media-core and transcoder now drop to non-root users (`mediacore`/`transcoder`) and compose adds `no-new-privileges`, `cap_drop: ALL`, read-only roots, and loopback-only published ports. The remaining container hardening gap is the Hono backend `Dockerfile`, which still has no runtime `USER`.
- Resolve-then-recheck the SSRF guard (DNS-rebinding hole, `server/services/ssrfGuard.ts:62-71`).
- Add a per-principal rate limiter (no global limiter today, `server/app.ts:36-66`; auth limiter trusts spoofable `cf-connecting-ip`).

---

## 8. DECISIONS NEEDED FROM OWNER

Six genuine choices, each with a recommended default. Everything else is execution.

1. **FFmpeg strategy (resolves Blocker 1).** LGPL-only rebuild everywhere vs LGPL-for-iOS + GPL-with-compliance-for-NAS vs all-GPL-distributed-separately.
   **Recommended default:** LGPL-only (VideoToolbox) in the iOS/tvOS bundle; GPL ffmpeg with full source-offer + notices, distributed alongside (not baked-in), on the NAS server.

2. **Product LICENSE (resolves the M2 deferral).** PolyForm Shield vs PolyForm Noncommercial vs BSL 1.1 vs Elastic 2.0 vs stay-proprietary vs AGPL.
   **Recommended default:** PolyForm Shield — source-available, free to self-host, you control commercial/hosted grants. Not AGPL (would force open-sourcing the M6 differentiators).

3. **IPTV fate (resolves Blocker 2).** Cut from v1 App Store build vs web-only vs ship as BYO-playlist-player-off-by-default.
   **Recommended default:** web-only for v1; revisit as a later App Store update once the core app is established. Never a paid surface over third-party content.

4. **Monetization model + where you sell.** Web-first Stripe Pass + free companion app vs in-app IAP primary vs subscription-only vs free.
   **Recommended default:** web-first Stripe Pass (sub + lifetime), free purchase-silent companion app (0% Apple), IAP reserved only for an optional hosted add-on.

5. **Pricing.** Subscription and lifetime numbers.
   **Recommended default:** sub ~$30-40/yr (or ~$3-5/mo), lifetime ~$100-150 — deliberately under Plex's $749.99, in the Infuse/Emby range, timed to the July 1 2026 Plex hike.

6. **Pre-paid security posture.** Keep the now-enforced internal-principal defaults, and finish container hardening by dropping root in the Hono backend image.
   **Recommended default:** treat enforce/fail-closed internal-principal as non-negotiable for paid builds; add a non-root runtime `USER` to the backend Dockerfile before monetized launch.
