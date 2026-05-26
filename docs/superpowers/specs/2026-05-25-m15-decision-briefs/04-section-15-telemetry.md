# §15 Decision Brief: Telemetry Posture (Sentry SaaS / Self-Hosted Glitchtip / Local-Only)

> Status: [USER'S CALL]. Decision-research only — picking is the user's job.
> Source agents: a15-question, a15-impl-cost, a15-oneway-door, a15-failure-modes, a15-precedents
> Date: 2026-05-25

## TL;DR

- Three options: **Sentry SaaS** ($26/mo Team plan), **Self-hosted Glitchtip** (Docker on NAS), **Local-only** (file logs + admin diagnostics endpoint).
- Dominant trade-off is **App Store privacy nutrition label vs. crash visibility on devices you can't physically touch**. Local-only is the only option compatible with "Data Not Collected" — the strategic-update's stated initial label. SaaS/Glitchtip require "Crash Data + Diagnostics" and re-review.
- Pivotal question: **will anyone outside your household ever run this app or server — i.e., will crash reports come from machines you cannot physically walk to and from users who cannot be asked to share log bundles?**
- 5-stack implementation cost (Hono + Python + Rust M3 + Swift M2 + cross-stack): Sentry SaaS = **32h**, Glitchtip = **37h**, Local-only = **13h**. M1.5-only (Hono + Python): Sentry = 14h, Glitchtip = 15h, Local-only = 6.5h.
- Evidence most strongly supports **Local-only with a feature-flag stub** through TestFlight, deferring SaaS/Glitchtip until real production signal is needed. The plurality of community-respecting self-hosted products ship zero-telemetry (Owncast, Linkding, Jellyfin's per-crash dialog model). Home Assistant — the closest analog — uses Sentry SaaS but only at the opt-in Diagnostics tier and only for Supervisor/OS-Agent, not the main application.

## The pivotal question

From `a15-question`: **"Will anyone outside your household ever run this app or server — i.e., will crash reports come from machines you cannot physically walk to and from users who cannot be asked to share log bundles?"**

If no (household-only, you own every device), local-only is a complete solution — a crash report from your own iPad is a Slack DM to yourself. Sentry and Glitchtip introduce complexity, cost, and a privacy-label change for zero new diagnostic capability.

If yes (TestFlight to friends/family, eventually App Store), local-only is useless. The crash happened on hardware you can't touch. The user can't send you a log bundle. You need an upload path. The question then becomes Sentry vs Glitchtip.

The strategic update (§5) explicitly targets "Privacy nutrition labels: Data Not Collected" as the App Store submission default. Adding *any* telemetry option changes that label. The label is committed at submission. This makes the pivotal question a one-way door gating downstream App Store policy, not just an ops preference.

## Options at a glance

| Option | Impl cost (all-in M1.5→M3) | One-way door | Worst failure mode | Industry precedent |
|---|---|---|---|---|
| **Sentry SaaS** ($26/mo Team) | **32h** (M1.5-only: 14h) | Nutrition label = "Crash Data + Diagnostics + third-party processor Sentry, Inc." Sentry→Glitchtip migration is DSN swap (trivial); nutrition label reversal requires App Store re-review and goes against grain of self-hosted privacy posture | Auth token captured in stack frame transits to Sentry's cloud. `plexAuthToken`, Xtream credentials, or JWE secret bytes captured in error context → external data breach. `beforeSend` scrubber must use *allowlist*, not denylist. IP captured by default — must be disabled per project | Home Assistant (Sentry SaaS for Diagnostics tier only, opt-in). Plex (own SaaS, opt-out). |
| **Glitchtip self-hosted** | **37h** (M1.5-only: 15h) | Nutrition label = "Crash Data + Diagnostics, processor = the developer." Self-host setup recurs on every NAS migration. Sentry-protocol-compatible SDK: trivial DSN swap to/from Sentry SaaS | Glitchtip web UI exposed via Cloudflare Tunnel + weak credentials = admin panel breach exposing all stack traces. Apple ATS rejects HTTP-only Glitchtip endpoint (must run TLS via Tunnel, Tailscale ts.net, or Let's Encrypt). Crash storm fills NAS disk if rate-limiting not configured. Network egress: NAS behind NAT blocks cellular-network App Store users from submitting | Sonarr/Radarr (Sentry self-hosted on own subdomain, no opt-out, no docs — represents the "do not do this" end of the spectrum). |
| **Local-only** (file logs + admin diagnostics) | **13h** (M1.5-only: 6.5h) | Nutrition label = "Data Not Collected" (matches strategic-update target). Adding telemetry later is cheap engineering but requires App Store re-review for label change | Debug blindness — TestFlight or App Store user crashes are invisible (CRITICAL, HIGH likelihood, recoverability NONE). tvOS log export is effectively impossible for non-Xcode users (no Files app, no console). Sensitive data still in local log files — "local-only" ≠ "privacy-clean" | Owncast, Linkding (zero telemetry by design). Jellyfin (per-crash dialog rather than background upload). Plurality of community-respecting self-hosted projects |

## Decision tree

From `a15-question`, tightened:

```
Is this household-only through App Store submission?
│
├── YES (household only, ≤5 people, you own every device)
│   └── LOCAL-ONLY
│       App Store label: "Data Not Collected" (already your target)
│       No ops cost. No label change.
│       Revisit at M5.5 if external testers enter via TestFlight.
│
└── NO (TestFlight to friends/family OR eventually App Store)
    │
    └── Is the "data stays on your infrastructure" privacy narrative
        important enough to add 8h of ops overhead?
        │
        ├── YES → GLITCHTIP (self-hosted)
        │         Label: "Crash Data + Diagnostics, processor = you"
        │         Add to M1.5 queue: Docker compose + Postgres + Tunnel entry
        │
        └── NO → SENTRY SAAS
                  Label: "Crash Data + Diagnostics, processor = Sentry"
                  $26/mo. 30min to first crash report.
                  Update labels before App Store submission.
```

**Degenerate option:** Local-only now + a feature-flag stub (`TELEMETRY_DSN` env var). If TestFlight feedback is "this crashes and I can't figure out why," flip the flag and add Glitchtip or Sentry without App Store label drama — because you haven't submitted yet. Defers the decision cleanly to the moment real signal is needed.

## Detailed comparison

### Sentry SaaS

- **Implementation cost** — All-in 32h across Hono + Python + Rust M3 + Swift M2. M1.5-only (Hono + Python before Rust/Swift come online): **14h**. Drivers: SDK + DSN wiring (~7h across stacks), PII scrubbing (3h, identical for SaaS vs Glitchtip), source maps + dSYM upload (3h — Sentry has polished `@sentry/vite-plugin` and `sentry-cli`), opt-in/out UX (4.5h required for App Store compliance), DSN management (1.5h), App Store label copy (2h).
- **One-way door** — Per `a15-oneway-door`: the true one-way door is the **Apple nutrition label**, not the SDK. SDKs are Sentry-protocol-compatible so Sentry↔Glitchtip is a DSN swap. Nutrition label changes require App Store re-review either direction, but moving from "Data Not Collected" → "Crash Data + Diagnostics" is contemplated by the strategic doc; moving back is harder to explain to users. Sentry is BSL-1.1 since 2024 — permits proprietary use, not a license issue, but historical context: many teams migrated away from Sentry over this relicensing.
- **Worst failure mode** — `plexAuthToken` or Xtream credential captured in a Rust stack frame and shipped to Sentry's cloud infrastructure. Recovery requires credential rotation across Plex, Xtream provider, and JWE signing keys. The `beforeSend` scrubber must be built *before* any Sentry integration is enabled in *any* environment — retrofitting is too late. Apple App Store reviewers can and do flag undisclosed data processors. App Store privacy label conflict (CRITICAL): submitting with "Data Not Collected" while Sentry is active is grounds for rejection.
- **Precedent** — Home Assistant uses Sentry SaaS exclusively for the opt-in Diagnostics tier, scoped to Supervisor/OS-Agent only (not the main HA Core application). All four HA analytics tiers (basic, usage, statistics, diagnostics) are off by default; users opt in per tier during onboarding. Plex uses its own SaaS crash reporting; the 2017 backlash when Plex removed opt-out is the canonical "do not do this" story.

### Glitchtip Self-Hosted

- **Implementation cost** — All-in 37h. M1.5-only: 15h. Drivers: same SDK + scrubbing surface as Sentry; **+4h self-host infra** (Docker Compose, Postgres, retention policy, reverse-proxy route, SMTP, backup volumes); **+1.5h symbolication friction** (Glitchtip accepts Sentry-format uploads but `sentry-cli` requires manual config against the self-hosted endpoint).
- **One-way door** — Same nutrition label change as Sentry. SDK portability is identical (Sentry-protocol). Reversibility is trivial: stop ingestion, archive historical events on the NAS. The unique lock is operational: every NAS migration carries Glitchtip with it (Postgres volume, retention state).
- **Worst failure mode** — Network egress is the dominant failure (HIGH severity, HIGH likelihood, Hard recoverability per `a15-failure-modes`). NAS is behind NAT; apps on household Wi-Fi reach Glitchtip fine but cellular-network users (TestFlight outside the house, App Store users) cannot. Cloudflare Tunnel mitigates but exposes the Glitchtip web UI to public internet — admin panel breach via weak credentials = full crash history exposure. Apple ATS requires HTTPS for all iOS/tvOS network calls — Glitchtip on `http://nas.local:8000` is blocked at the SDK layer.
- **Precedent** — Sonarr/Radarr ships Sentry self-hosted at sentry.sonarr.tv with no UI opt-out and no documentation. Users discovered it via network monitoring; forum thread asking "what purpose does this serve?" received zero response before auto-closing. Sentry endpoint failures caused severe UI slowdowns when users tried blocking the domain. This is the cautionary tale for self-hosted telemetry without operator transparency.

### Local-Only

- **Implementation cost** — All-in 13h. M1.5-only: **6.5h**. Drivers: structured logger baseline (pino for Hono, `tracing` for Rust — required regardless of telemetry choice per strategic-update §11), log rotation (1h Hono + 0.5h Python + 1h Rust), Swift OSLog + log export bundle (1.5h), App Store label copy (0.5h, simplest of the three).
- **One-way door** — Zero historical data when adding remote telemetry later. Nutrition label upgrade from "Data Not Collected" → "Crash Data + Diagnostics" requires App Store re-review. Most recoverable starting point — no SDK to remove, just instrumentation points to add.
- **Worst failure mode** — Debug blindness (CRITICAL, HIGH likelihood, recoverability NONE per `a15-failure-modes`). M5.5 ships, a critical bug causes silent crashes for a subset of users with a specific NAS hardware/iOS configuration, and the developer has no reproduction data, no frequency count, no stack trace. The only recovery is releasing a debug build to TestFlight and asking affected users to reproduce with Xcode attached. For solo developers shipping to App Store, this is the failure most likely to produce a sustained one-star review cluster before root cause is identified. tvOS log export is effectively impossible — no Files app, no console access, only Xcode Devices window with physical Mac connection.
- **Precedent** — Owncast (no external telemetry, deliberate). Linkding (no telemetry; community-contributed PR for usage tracking was made opt-in and local-only). Jellyfin Android TV (per-crash dialog asking for individual submission consent rather than background upload). 3 of 7 surveyed self-hosted products ship effectively zero external telemetry. The plurality position among community-respecting self-hosted projects.

## Cross-option interactions

- **§15 ↔ §4 (auth)**: Most acute asymmetry per `a15-oneway-door`. Under §4 Option A (Hono-only authenticator): Rust never sees `plexAuthToken`; crash reports are safe regardless of destination. Under §4 Option B: **Sentry SaaS + Option B is the only configuration where a live Plex credential can end up on a third-party server.** Glitchtip self-hosted + Option B keeps the credential on the NAS. Local-only + Option B keeps it on local disk only. If §4 Option B ships, that decision exerts pressure toward Glitchtip or Local-only at §15.
- **§15 ↔ §14 (license)**: Sentry SDK is BSL-1.1 (permits use in proprietary; restriction is on competing hosted services). Not a meaningful license conflict for any §14 choice. Glitchtip SDK is Apache-2.0 — cleanest across all §14 scenarios. Local-only has no SDK and no license question.
- **§15 ↔ App Store nutrition label (M5.5)**: This is the dominant axis. The label is committed at submission and changing it requires re-review and is reviewer-flagging. Local-only is the only option that matches the strategic-update's stated "Data Not Collected" target. Starting at "Data Not Collected" and upgrading later is explicitly contemplated by the strategic doc; starting at "Crash Data + Diagnostics" and later wanting "Data Not Collected" is the harder direction.
- **§15 ↔ Sentry Apple privacy manifest**: Sentry SDK v8.25+ ships a `PrivacyInfo.xcprivacy` declaring Crash Data / Performance Data / Other Diagnostic Data all under "App Functionality / Not Linked / Not Tracking" — the most favorable nutrition-label outcome possible for crash data. If you choose Sentry, this is the disclosure tier.

## Disagreements among source agents

`a15-question` and `a15-precedents` both emphasize that the plurality of community-respecting self-hosted products ship zero or minimal telemetry. `a15-impl-cost` shows Sentry and Glitchtip within 1h of each other on M1.5-only cost; the 8h Glitchtip ops delta is the differentiator. `a15-oneway-door` argues that Glitchtip *strictly dominates* Sentry SaaS on data residency, license surface, §4 Option B interaction, and philosophical consistency with self-hosted positioning — matching Sentry on debug capability, SDK portability, reversibility, and revocation telemetry. `a15-failure-modes` makes the most decisive claim: local-only "debug blindness" is CRITICAL with no recoverability post-App-Store-launch.

The disagreement is between `a15-failure-modes`'s "you cannot ship App Store without crash telemetry" framing and `a15-question`/`a15-precedents`'s "household-only through M5.5 makes local-only sufficient" framing. Both depend on the answer to the pivotal question.

## Advisory recommendation

The evidence most strongly supports **Local-only with a feature-flag stub** as the M1.5 / M2 / early-M5 posture, deferring SaaS/Glitchtip to the moment real production signal is needed. Rationale:

1. The strategic-update explicitly targets "Data Not Collected" for the initial App Store submission. Local-only matches this without re-review friction.
2. Three of seven surveyed self-hosted products ship zero external telemetry. Two more are opt-in only. Only Plex (commercial proprietary) and Home Assistant's Diagnostics tier (opt-in, scoped to Supervisor) use Sentry SaaS for crash data.
3. Through TestFlight Internal (≤100 users, the M2 target), "send me your log bundle" is plausibly workable for friends/family/collaborators.
4. The degenerate option (feature flag stub) defers the decision cleanly — flip the flag and add Glitchtip or Sentry the moment a TestFlight user reports a crash you can't reproduce.

If TestFlight or App Store user behavior demonstrates that local-only is insufficient, the evidence then supports **Glitchtip self-hosted** over Sentry SaaS for this specific product, on residency, license, philosophy, and §4 Option B interaction grounds — provided the network-egress problem (Cloudflare Tunnel + ATS HTTPS requirement + Tunnel security hardening) is solved deliberately, not improvised.

This is non-binding.

## What I'd need to know before locking

- For M2 TestFlight Internal (up to 100 users, no review): are those 100 people all in your household, or does "internal" include friends and family who would not be able to send a log bundle?
- Confirm with App Store Connect docs: does changing a privacy nutrition label from "Data Not Collected" to "Crash Data + Diagnostics" require binary re-review or just a metadata update? The strategic-update says "not amendable per release without re-review" — verify whether that means full binary re-review or faster metadata update.
- Will you actually open an incident dashboard proactively after every TestFlight push, or is your usage pattern "something broke, let me find out why"? Sentry's UX is meaningfully better for the first pattern; Glitchtip produces the same stack traces for the second.
- Does the NAS have spare RAM and disk for Postgres? Glitchtip recommends 1GB RAM minimum; if NAS is already at 80% memory, Glitchtip is riskier than it looks.
- Is `emerald-contracts` about to produce a `tracing` integration shape in M1.5? Section 15 says the telemetry decision determines whether the contracts crate exposes that shape — if M1.5 produces the crate, this decision is needed *before* the crate is written, not after.
- If §4 Option B is chosen for the auth boundary: Sentry SaaS becomes a deliberate security override, not a default. Confirm before pairing.
