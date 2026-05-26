# §14 Decision Brief: LICENSE (GPL-3.0 / MIT / Apache-2.0 / Proprietary)

> Status: [USER'S CALL]. Decision-research only — picking is the user's job.
> Source agents: a14-question, a14-impl-cost, a14-oneway-door, a14-failure-modes, a14-precedents
> Date: 2026-05-25

## TL;DR

- Four options: **GPL-3.0** (copyleft; forks must publish source under same), **MIT** (maximally permissive; commercial forks allowed), **Apache-2.0** (permissive with explicit patent grant + NOTICE obligation), **Proprietary** (source-available or fully closed; you control distribution).
- Dominant trade-off is **App Store reachability vs. fork protection**. GPL-3.0 is structurally incompatible with Apple's App Store EULA (FSF and Apple both acknowledge). MIT and Apache leave you defenseless against commercial forks. Proprietary forecloses public registry publishing.
- Pivotal question: **do you intend to build something the public can improve, fork, and run forever — or something you alone control and could eventually monetize?**
- 5-year cost: MIT = **$7,155** (23.85h), Apache-2.0 = **$12,255** (40.85h), Proprietary = **$15,975** (53.25h), GPL-3.0 = **$18,555** (61.85h).
- Evidence most strongly supports **Apache-2.0 OR Proprietary** depending on commercial intent. GPL-3.0 is structurally disqualifying for the stated M5.5 App Store goal (FSF position is firm; VLC's return required relicensing to LGPL + MPL, and that required sole-copyright control). MIT is viable but leaves the project defenseless against white-label competitors. The closest analog with an App Store presence and Apache-compatible posture is Home Assistant; the closest analog overall is Jellyfin (GPL-2.0 server + MPL-2.0 Swiftfin client).

## The pivotal question

From `a14-question`: **"Do you intend to build something the public can improve, fork, and run forever — or something you alone control and could eventually monetize?"**

This single axis cleanly separates the four options. GPL-3.0 and MIT both answer "yes, public" but disagree on whether commercial forks are acceptable. Proprietary answers "no" cleanly. Apache-2.0 sits between MIT and GPL: permissive like MIT but with an explicit patent grant and a contributor license agreement baseline baked in.

"Personal-use only" is already foreclosed — the moment you push a Homebrew formula or a GitHub Release, it stops being personal-use regardless of what the LICENSE file says. The real fork is between controlled distribution (proprietary or source-available) and uncontrolled distribution (OSS), with a secondary fork inside OSS between copyleft (GPL) and permissive (MIT/Apache).

Timing pressure is real: the decision should be made before the first binary ships outside the NAS, which the roadmap places at M3 (GitHub Releases) — roughly 3-4 months away. It is a pre-M2 prerequisite per the strategic update so CONTRIBUTING.md is right from the first public commit forward.

## Options at a glance

| Option | Impl cost (OT + 5yr OY) | One-way door | Worst failure mode | Industry precedent |
|---|---|---|---|---|
| **GPL-3.0** | 18.35h + 43.5h = **61.85h ($18,555)** | CRITICAL — App Store blocked once any external GPL contribution lands without CLA; relicensing closes silently and incrementally; TestFlight also blocked (App Store-adjacent) | Apple App Store distribution is structurally incompatible (DPLA imposes "further restrictions" forbidden by GPL §7). VLC was pulled in 2011, returned in 2013 only after LGPL + MPL relicensing. Sonarr/Radarr have no official iOS app because copyright is distributed across many contributors with no CLA | Jellyfin server (GPL-2.0) + Swiftfin client (MPL-2.0). Nextcloud (AGPL server + GPL-3.0 client via CLA). Sonarr/Radarr (no official iOS). |
| **MIT** | 8.1h + 15.75h = **23.85h ($7,155)** | One-way: once a public MIT release ships, fork-and-compete is permanently permitted | White-labeling. Any competitor can take the codebase, rebrand it, add a $4.99/mo subscription, and distribute on the App Store with no obligation to contribute back | Owncast (server). Common in lightweight self-hosted tools. No surveyed iOS app uses MIT for both server and client (Home Assistant uses Apache, Jellyfin uses MPL for client). |
| **Apache-2.0** | 12.35h + 28.5h = **40.85h ($12,255)** | Low. Same fork posture as MIT; slightly stronger via patent retaliation clause (§3); NOTICE file obligation requires automation | NOTICE file maintenance drift. Corporate contributors may unknowingly trigger employer patent grants via §3 (theoretical for solo project; real if scale grows). Patent retaliation clause cannot be combined with proprietary distribution of contributions | **Home Assistant (server + iOS, both Apache-2.0)** — the cleanest end-to-end App-Store-compatible OSS pattern. Tailscale daemon is BSD-3-Clause. |
| **Proprietary** | 16.75h + 36.5h = **53.25h ($15,975)** | One-way for public registries — once published to crates.io or npm under proprietary license, source is permanently accessible | GPL-dep poisoning. Any GPL crate accidentally added to Rust binary forces relicensing or removal. LGPL static-linking in Swift triggers re-linking obligation Apple does not allow (libass, some crypto libraries). Self-hosters are suspicious of proprietary binaries running on home networks — limits organic growth | Plex (fully proprietary). Emby (proprietary since 2018 after community fork as Jellyfin). Tailscale GUI wrappers (open core hybrid). |

## Decision tree

From `a14-question`, with App Store / contributor branching:

```
Do you want anyone to be able to fork, modify, and run this forever,
with no permission required from you?
│
├── NO → Proprietary (source-available or fully closed)
│         You control distribution. App Store works. Public registries (crates.io/npm) foreclosed
│         for any package you want to keep private.
│
└── YES → Are you okay with commercial forks that don't contribute back?
          │
          ├── YES → MIT or Apache-2.0
          │         MIT: minimal friction, maximum permissiveness, no patent grant.
          │         Apache-2.0: explicit patent termination + NOTICE-file obligation.
          │         CLA recommended if you ever want to relicense.
          │
          └── NO → GPL-3.0
                    Forks must publish source under GPL-3.0.
                    App Store path requires sole copyright (no outside contributions)
                    or full CLA from every contributor.
                    GPL + App Store is a known FSF-flagged conflict.
                    Direct App Store distribution under GPL-3.0 is documented as
                    structurally incompatible per Apple DPLA terms.
```

## Detailed comparison

### GPL-3.0

- **Implementation cost** — 18.35h OT + 8.7h/year ongoing. 5-year total: **61.85h, $18,555 at $300/hr opportunity cost**. Highest of any option. Drivers: per-file GPL notice blocks (~3x longer than MIT SPDX), dependency license audit across 4 runtimes (cargo-deny with GPL-compat allowlist), App Store legal review for GPL/DPLA tension, NOTICE/source-offer compliance.
- **One-way door** — CRITICAL combined lock (`a14-oneway-door`). Two simultaneous permanent locks: (1) App Store submission permanently blocked once any external contributor's GPL-3.0 code is in the binary unless you hold a CLA giving you re-license rights; (2) relicensing closes permanently after the first non-CLA external contribution. This activates silently and incrementally — every merged PR is a permanent nail.
- **Worst failure mode** — App Store distribution is structurally incompatible. Apple's Standard EULA imposes redistribution restrictions, non-transferability, and device limits that constitute "further restrictions" under GPL §7. FSF position is firm; Apple has never published a formal ban but removes GPL apps when copyright holders complain (GNU Go 2010, VLC 2011). VLC's return required relicensing libvlc to LGPL-2.1 and iOS app to MPL-2.0 + GPL-2.0 dual — Sole-copyright control made that possible; Sonarr/Radarr cannot replicate it because copyright is distributed. **TestFlight is App-Store-adjacent and falls under the same DPLA terms — also blocked.**
- **Precedent** — Jellyfin keeps server at GPL-2.0 (no network trigger, simpler than AGPL) and Swiftfin client at MPL-2.0 — the cleanest "community open-source with App Store path" pattern, but requires the iOS client to be separately licensed. Nextcloud and Mastodon ship GPL-3.0 iOS apps on the App Store, but Nextcloud GmbH and Mastodon GmbH hold copyright via mandatory CLA and grant App Store-specific exceptions.

### MIT

- **Implementation cost** — 8.1h OT + 3.15h/year. 5-year total: **23.85h, $7,155**. Lowest of any option. SPDX one-liner per file, minimal NOTICE/attribution obligation, no CLA required (recommended only if relicensing later is desired).
- **One-way door** — Once any public MIT release ships, fork-and-compete is permanently permitted for that release. All other axes are open. MIT contributions are permissive enough to be incorporated into a proprietary future product, but the contributors' code retains MIT — if you ever want to relicense the whole codebase, you still need consent or a CLA.
- **Worst failure mode** — White-labeling. GSE Smart IPTV, IPTV Smart Player, OttPlayer, and Infuse all live in the same distribution lane this project targets. Any could incorporate the Rust media-core or Swift EmeraldKit under MIT without contributing back. License stripping is routine in commercial forks; enforcement cost exceeds realistic recovery. No patent protection — if you or a contributor hold a patent, MIT may implicitly grant a patent license to all users via "use" rights.
- **Precedent** — Owncast server. Common pattern in lightweight self-hosted tools. No surveyed product uses MIT for an App Store-distributed iOS client alongside a self-hosted server. Home Assistant chose Apache-2.0 over MIT specifically for the patent grant.

### Apache-2.0

- **Implementation cost** — 12.35h OT + 5.7h/year. 5-year total: **40.85h, $12,255**. Middle of the pack. NOTICE file maintenance is the recurring driver; automation via `license-checker`/`cargo-about`/`cargo-deny` reduces it but doesn't eliminate it. Patent grant verification adds modest initial legal time.
- **One-way door** — Same fork posture as MIT (one-way once released). Slightly more attribution obligation than MIT in practice. Apache-2.0 contributor patent grants under §3 are irrevocable on Apache-licensed releases — good for users, but means you cannot revoke those grants even with unanimous contributor consent.
- **Worst failure mode** — NOTICE file drift. If you fail to include NOTICE files from Apache-licensed deps in your distribution, you are in breach of *those* dependencies' licenses, not just your own. At scale this requires CI automation. Patent retaliation clause (§3) is a net benefit but corporate contributors may unknowingly trigger employer patent grants — relevant only if scale grows beyond solo-dev.
- **Precedent** — **Home Assistant: Apache-2.0 server + Apache-2.0 iOS Companion App, both on the App Store.** This is the only surveyed precedent that achieves "self-hosted server + first-party Apple client + community open source + no CLA complexity + no App Store friction" in a single license choice. Used by Google, AWS, and most corporate OSS programs.

### Proprietary

- **Implementation cost** — 16.75h OT + 7.3h/year. 5-year total: **53.25h, $15,975**. EULA + ToS drafting is the largest one-time cost ($1,500 attorney time); ongoing LGPL dependency auditing for Rust + Swift is the recurring driver. CLA infrastructure required before any external contribution.
- **One-way door** — Lowest legally — you can open-source at will, accept contributors via CLA, submit to App Store without friction. One permanent lock: cannot publish to public registries (crates.io, npm) for any code you want to keep private. `emerald-contracts` crate publishing to crates.io requires source disclosure — making the cross-language test-vector strategy harder.
- **Worst failure mode** — GPL/LGPL dep poisoning is a continuous maintenance tax. Rust's default static linking means any LGPL crate in the dependency graph triggers dynamic-linking obligations Apple's App Store does not allow. `cargo-deny` catches this but discovery 6 months into Rust development is painful. Community adoption is limited: self-hosters are suspicious of proprietary binaries on home networks, especially for a product that points at paid IPTV services. Jellyfin's market position is explicitly "not Plex (closed source)."
- **Precedent** — Plex (fully proprietary, gold standard for App Store + commercial success). Emby (went proprietary in 2018; community forked as Jellyfin and original was abandoned). Tailscale GUI wrappers (proprietary alongside BSD daemon — "open core" pattern).

## Cross-option interactions

- **§14 ↔ §4 (auth)**: From `a4-oneway-door` axis 1 + `a14-oneway-door` axis 7. Option B (Rust decrypts user JWE) under proprietary doubles audit surface on closed code with no community eyeballs. Under GPL-3.0 with no CLA, every contributed auth fix is a permanent nail blocking App Store. Option A under any license keeps Rust auth surface to one HMAC-verify call.
- **§14 ↔ §15 (telemetry)**: Sentry's Open Source SDK is BSL-1.1 since 2024 — permits use in proprietary products (restriction is on competing hosted services). Not a license-level conflict. Glitchtip SDK is Apache-2.0 — cleanest license posture across all three repo-license scenarios.
- **§14 ↔ App Store (M5.5)**: This is the dominant axis. GPL-3.0 is structurally blocked by Apple DPLA. **GPL-3.0 blocks TestFlight too — TestFlight is App-Store-adjacent and falls under the same Apple Developer Program terms.** All other options are App Store-compatible. The "no-IPTV insurance build" (§13.3 compile-flag) does not change the GPL conflict — it is a content policy hardening, not a license bypass.
- **§14 ↔ public registries (crates.io / npm)**: Proprietary forecloses these for any code you want to keep private. `emerald-contracts` crate for cross-language test vectors should be a published crate — that pushes against proprietary unless that specific crate is dual-licensed.
- **§14 ↔ contributor structure (CLA / DCO)**: GPL-3.0 without CLA = permanent ratchet to GPL forever. MIT without CLA = practical relicensing requires contributor consent. Proprietary without CLA = cannot accept external contributions at all. Apache-2.0 without CLA = same as MIT but with irrevocable patent grants.

## Disagreements among source agents

`a14-question` lays out the decision tree but explicitly does not pick. `a14-impl-cost` ranks MIT lowest cost, GPL-3.0 highest. `a14-oneway-door` ranks GPL-3.0 as having the tightest project-specific lock-in (App Store + relicensing combined). `a14-failure-modes` flags App Store GPL incompatibility as "disqualifying on its own given the stated M2/M5.5 goals" — the most direct claim made by any agent. `a14-precedents` is more nuanced: GPL-3.0 *can* work for App Store distribution via the Nextcloud/Mastodon CLA pattern, but that requires sole copyright control and a full CLA from day one.

No agent disputes the structural App Store + GPL incompatibility. The disagreement is on whether the CLA mitigation is acceptable: `a14-failure-modes` treats it as disqualifying given the solo-dev posture, `a14-precedents` treats it as viable for a sole-copyright-holder with mandatory CLA. Both positions are defensible.

## Advisory recommendation

The evidence most strongly supports **Apache-2.0** if the project goal is community open-source with App Store distribution. Home Assistant is the only surveyed precedent that achieves all of: self-hosted server, first-party Apple client, community open-source, no CLA complexity, no App Store friction. Apache-2.0's NOTICE file maintenance overhead is the only meaningful cost above MIT, and that automates.

If the project goal is full control with future monetization optionality, the evidence supports **Proprietary** (source-available is a coherent middle position — published source with usage restrictions). Plex and Emby demonstrate that proprietary self-hosted media servers can be commercially viable on the App Store.

The evidence does *not* support **GPL-3.0** given the M5.5 App Store goal unless: (a) you commit to sole-copyright control with no outside contributions ever, or (b) you implement a mandatory CLA from day one before any external contribution lands. Either is operationally heavy. The closest GPL-3.0 + App Store success stories (Nextcloud, Mastodon, Signal) are all corporate-controlled with mandatory CLAs.

This is non-binding.

## What I'd need to know before locking

- Will you ever sell support contracts, enterprise builds, priority-feature access, or a managed-NAS appliance? If yes, dual-license (GPL-3.0 community + commercial) is the structural answer — same pattern as MySQL, Qt, Ghostscript. Requires CLA from day one.
- Have you ever published anything on GitHub before, and under what license? Reflex choices are data.
- Are you willing to require a CLA from contributors? Without one, every merged PR is a permanent veto on relicensing. With one, you retain control even under GPL-3.0.
- Would it bother you to see a $4.99 App Store app that is your transcoder, rebranded? MIT/Apache say yes; GPL/proprietary say no.
- Is `emerald-contracts` planned to be a published crate on crates.io? If yes, that crate's license is constrained — proprietary publishing requires source disclosure on the registry.
- Does the no-IPTV compile-flag App Store build need to ship under the same license as the IPTV-enabled GitHub Release binary? Dual-licensing is the structural answer if not.
