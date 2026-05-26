# §4 Decision Brief: Internal Auth Boundary (Hono → Rust media-core / Python recommender)

> Status: [USER'S CALL]. Decision-research only — picking is the user's job.
> Source agents: a4-question, a4-impl-cost, a4-oneway-door, a4-failure-modes, a4-precedents
> Date: 2026-05-25

## TL;DR

- Four options on the table: **A** (Hono signs short-lived HMAC principal; Rust/Python HMAC-verify), **B** (Rust/Python independently decrypt the user JWE), **C** (Unix-domain-socket + mTLS for Hono↔Rust; A for Python), **D** (A but the principal is JWE-wrapped — signed *and* encrypted).
- Dominant trade-off is **standalone authority vs. audit surface**: Option B makes Rust independently authoritative about identity, at the cost of putting a live `plexAuthToken` and `SESSION_SECRET`/`DEVICE_TOKEN_SECRET` inside Rust's process memory. A, C, and D keep Rust as a trust-consumer of Hono assertions.
- Pivotal question: **will Rust services ever run standalone (without a live Hono process making authorization decisions) in production?** If no, A/C/D are correct. If yes, only B or D survive.
- Implementation cost: A = **21h**, D = **27h**, B = **33h**, C = **41h**.
- Evidence most strongly supports **Option A**: 6 of 7 comparable self-hosted products use a variant of A (Plex transient tokens, Tailscale Serve, Authelia, authentik, Home Assistant SUPERVISOR_TOKEN, Nextcloud AppAPI). Option A with a 60s TTL is *more* secure than the dominant homelab proxies (Authelia, authentik, Tailscale) which ship unsigned headers.

## The pivotal question

From `a4-question`: **"Will Rust services (media-core M3, transcoder M4) ever need to run standalone — without a live Hono process in front of them — in a context where real user authorization decisions must be made?"**

"Standalone" does not mean dev-mode bypass. It means: in a production deployment, should the Rust binary be independently authoritative about who a user is, or is it allowed to be a trust-consumer of assertions Hono already made? If no, the complexity budget belongs entirely to Hono and Options B, C, and D pay tax for a topology that does not exist. If yes, Option A's security claim collapses the moment Hono is absent — Rust has no way to distinguish "Hono signed this" from "an attacker forged this."

The roadmap evidence (single-host NAS, Docker Compose siblings, Hono as sole public-facing service, no `ports:` entry on Rust, the dev-mode bypass was designed precisely to avoid the two-process dependency during development) points to **No**. The evidence for Yes is speculative and M6-or-later (e.g., a Jellyfin-style single-binary Rust install or a GPL fork without the Hono frontend).

## Options at a glance

| Option | Impl cost | One-way door | Worst failure mode | Industry precedent |
|---|---|---|---|---|
| **A** Hono HMAC-sign; Rust/Python verify | **21h** (7.5 TS + 8 Rust + 5.5 Py) | Low — A→D is 1–2 day add; A→B is multi-week cross-service refactor | SSRF amplification: any Rust outbound HTTP call that can loop back to localhost can forge a principal (Crit, Med mitigation cost) | Plex transient tokens (closest analog); Home Assistant SUPERVISOR_TOKEN; Nextcloud AppAPI |
| **B** Rust/Python decrypt user JWE | **33h** (6 TS + 19 Rust + 8 Py) | HIGH and permanent — `plexAuthToken` lands in Rust process memory; cannot un-expose a credential once it has been in a crash report or log | `plexAuthToken` leak via `tracing::debug!("{:?}", claims)` (Crit, High mitigation cost; CI-enforced `#[serde(skip)]` constraint required forever). Plex reconciliation drift between TS and Rust implementations | Sonarr/Radarr/Prowlarr (static API keys per service) — weakest cohort precedent |
| **C** UDS + mTLS (Hono↔Rust) | **41h** (18.5 TS + 17 Rust + 5.5 Py) | HIGH for multi-host — Unix socket is architecturally single-host; multi-host = transport rewrite | macOS peer-cred quirks (`SO_PEERCRED` not honored on macOS) reduce socket-level identity to "owner of the socket directory." Cert expiry causes total media outage with no graceful degradation | None directly — closest is Plex's in-process transcoder (no HTTP boundary at all) |
| **D** Signed + encrypted internal principal (JWE-wrapped JWT) | **27h** (9.5 TS + 12 Rust + 5.5 Py) | Medium — adds the `josekit`/`aes-gcm` crate dependency; A→D is 1–2 day add | Two-step decrypt-then-verify failure mode: decrypted plaintext must never log on inner-JWT verify failure. JWE nonce reuse if a developer hand-rolls AES-GCM with a counter/timestamp nonce (Crit if it happens) | No direct precedent in surveyed cohort |

## Decision tree

From `a4-question`, tightened:

```
Q1: Will Rust services ever authorize users without Hono present in production?
│
├── NO (Rust is always trust-consumer; Hono is always upstream)
│   ├── Q3: Is mTLS/Unix socket operational overhead acceptable?
│   │   ├── YES → Option C
│   │   └── NO  → Option A
│   └── Q4: Multi-host deployment in M5-M6?
│       ├── YES → Option D
│       └── NO  → Option A
│
└── YES (Rust may authorize independently in production)
    └── Q2: Is JWE stack + plexAuthToken leak risk acceptable with CI enforcement?
        ├── YES → Option B
        └── NO  → Option D (Rust sees only the internal principal, never plexAuthToken)
```

Option C is excluded from the Q1=YES branch because mTLS still requires Hono to be the identity-verifying party.

## Detailed comparison

### Option A — Hono signs HMAC; Rust/Python verify

- **Implementation cost** — 21h total (`a4-impl-cost`). 7.5h TS (Hono mint + middleware + dev-mode bypass), 8h Rust (`jsonwebtoken` crate + axum extractor + multi-hop TTL + replay window), 5.5h Python (`PyJWT.decode` + FastAPI dependency).
- **One-way door** — Lowest. A→D is a 1–2 day change (add JWE envelope). A→B is a multi-week cross-service refactor that must add JWE decryption and Plex reconciliation to every Rust service.
- **Worst failure mode** — SSRF amplification in any Rust handler that makes outbound HTTP calls is a full auth bypass (Crit). Header forgery via "ports added to docker-compose.yml during debugging" is also Crit — the entire security guarantee evaporates if Rust ever binds to a host port. Mitigation requires strict egress filtering in Rust HTTP client code and CI gates on the Compose file.
- **Precedent** — Plex transient tokens (48h TTL, server-minted, scoped to one session): the cleanest direct analog. Home Assistant `SUPERVISOR_TOKEN` (static per-process). Nextcloud AppAPI shared secret. Authelia and authentik both ship *unsigned* headers and rely on network isolation alone — A with a signed HMAC token is strictly more secure than the most-deployed homelab auth proxies.

### Option B — Rust/Python independently decrypt user JWE

- **Implementation cost** — 33h total. 6h TS, 19h Rust (the heaviest line item: HKDF + josekit + multi-kid lookup + two payload struct shapes + **the Plex reconciliation port**), 8h Python. From `a4-impl-cost`: the single largest cost surprise is that the dominant Rust cost is *not the crypto* — it is porting `reconcileSession` to Rust, an HTTP call to plex.tv with rate limits, error handling, and membership-check logic that two independent implementations must agree on under load.
- **One-way door** — HIGH and permanent (per `a4-oneway-door`). Any `plexAuthToken` that has appeared in a Rust crash report or log file cannot be un-exposed; the credential is a long-lived bearer for the user's full Plex account. Every new downstream Rust service onboarded later pays the full reimplementation cost.
- **Worst failure mode** — `plexAuthToken` leak from cookie JWE into Rust process memory (Crit). A single `tracing::debug!("{:?}", claims)` ships a live Plex credential to disk. Mitigation requires a CI-enforced struct-level `#[serde(skip)]` constraint that must be maintained as a permanent invariant across every future struct field addition. `SESSION_SECRET` and `DEVICE_TOKEN_SECRET` now sit in Rust binary's accessible memory — a memory-disclosure vulnerability in any Rust media path (which handles untrusted codec input by design) yields universal session hijacking.
- **Precedent** — None in the surveyed cohort. Sonarr/Radarr/Prowlarr is the closest, but they use static API keys per service with no central authenticator — a weaker model, not a stronger one. No comparable self-hosted media product duplicates JWE decryption across language boundaries.

### Option C — Unix domain socket + mTLS

- **Implementation cost** — 41h total. Surprise here is that the TS column (18.5h) exceeds the Rust column (17h) — Node.js mTLS over a Unix socket via a custom `undici` dispatcher is non-obvious plumbing that is genuinely harder than the equivalent `rustls` + `UnixListener` work in axum.
- **One-way door** — Architecturally single-host. The socket transport is `/run/eex/internal.sock`; multi-host deployment requires abandoning the socket entirely and replacing it with an authenticated network channel. New TLS provisioning, new connection management, migration off the socket path in both Hono and Rust. Strongest single lock-in on the multi-host axis.
- **Worst failure mode** — On macOS (the strategic-doc primary deployment target), `SO_PEERCRED` is not honored — the Rust side cannot verify the connecting process's PID/UID via `getpeercred()` the way Linux can. Trust degrades to "anyone who can write to the socket path." Combined with mTLS cert embedded at build time (a single image compromise exposes the CA key for every installation) and silent cert-expiry causing total media outage with no warning, C has the highest macOS-specific operational risk surface.
- **Precedent** — None. Plex and Jellyfin both kept transcoding as a subprocess `exec()` rather than a separate HTTP service, sidestepping the entire problem.

### Option D — Signed + encrypted internal principal (JWE-wrapped JWT)

- **Implementation cost** — 27h total. 9.5h TS, 12h Rust (the two-step decrypt-then-verify pipeline + `josekit` integration), 5.5h Python.
- **One-way door** — Low across most axes. Per `a4-oneway-door`: D→A is a 1–2 day change (remove the JWE envelope); A→D is the same in reverse. No claim shape change, no user-facing impact. Adds AES-GCM dependency for marginal additional license surface.
- **Worst failure mode** — Two-step decrypt-then-verify pipeline introduces a new failure mode not present in A: decryption succeeds but inner JWT signature fails. The decrypted plaintext must never log on inner-JWT verify failure. JWE nonce reuse via a hand-rolled AES-GCM encryption is catastrophic (recovers HMAC key from two ciphertexts) — mitigation is "use `josekit`/`aes-gcm` defaults; never pass a nonce parameter." Confidentiality benefit is marginal in a same-host Docker network and may create a false sense of security.
- **Precedent** — None directly. The closest framing is a homelab build where the JWE envelope is treated as defence-in-depth for a multi-host future.

## Cross-option interactions

- **§4 ↔ §14 (license)**: From `a4-oneway-door` axis 1. Option B ships a full JWE stack and a Plex reconciliation port in Rust — two independent crypto implementations to keep consistent. Under proprietary distribution, the audit-surface is on the maintainer; under GPL-3.0, contributor PRs can land fixes but the auth code accumulates contributor nails that block any later relicensing. Option A's Rust binary auth surface is one HMAC-verify call.
- **§4 ↔ §15 (telemetry)**: Option B + Sentry SaaS is the worst combination. A live `plexAuthToken` captured in a Rust stack frame transits to Sentry's cloud infrastructure. Glitchtip self-hosted + Option B keeps the credential on the NAS. Local-only + Option B keeps it on local disk only. If Option B ships, Sentry SaaS is foreclosed as a safe choice unless the `#[serde(skip)]` CI constraint is enforced forever.
- **§4 ↔ §9**: No direct coupling. The internal principal claim shape is decoupled from the recommender data model.

## Advisory recommendation

The evidence most strongly supports **Option A**. Six of seven comparable self-hosted products use a variant of A. Option A with a 60s TTL is strictly more secure than the dominant homelab auth proxies (Authelia, authentik, Tailscale Serve) which ship unsigned headers and rely on network isolation alone. The roadmap topology evidence (single-host NAS, Hono as sole public-facing process, no `ports:` on Rust) points to Q1=NO, which makes A correct. The strongest case for Option B (Rust independently authoritative) is speculative and M6-or-later; the strongest case for Option C is "operator wants to eliminate `INTERNAL_PRINCIPAL_SECRET` entirely" but the cost is macOS-specific failure modes (no peer-cred) and architectural single-host lock-in.

This is non-binding.

## What I'd need to know before locking

- Is multi-host deployment (Hono on a cloud edge, media-core on a NAS) on the M5-M6 roadmap or speculative? If on the roadmap, Option D handles the topology change gracefully where A degrades to bearer-token-over-network.
- Does the M3 ergonomics requirement include "Rust binary runs without Hono" as a dev-mode or as a production posture? Dev-mode is already covered by A's `X-Internal-Principal-Bypass`; production-standalone requires B or D.
- How allergic are you to a permanent CI invariant (`#[serde(skip)]` on every future struct field in the Rust JWE decoder)? Option B is technically fine if you commit to the constraint and enforce it forever.
- Will `emerald-contracts` be published to crates.io for cross-language test vectors? If yes, the license question for that crate (§14) affects the auth code in the crate — GPL-3.0 packages on crates.io limit downstream commercial adoption.
- Is the threat model "a malicious process running on the NAS can read the Docker bridge"? If yes, Option C or D provides marginal confidentiality; if no, A is sufficient.
