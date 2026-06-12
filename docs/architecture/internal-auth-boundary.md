# The Internal-Auth Crypto Boundary (Rust ↔ TypeScript ↔ Python)

> Living architecture reference. This is the **one document** that traces the §4
> internal-auth trust boundary end-to-end with the napi marshalling types in hand.
> The decision record lives in the M1.5 contract (§4 = **Hybrid D, Rust-canonical**);
> this doc explains the *implementation* that decision produced.

## Why this doc exists

The boundary's *concept* was well documented, but scattered across five places, and
the three TypeScript-facing marshalling DTOs that physically cross the language line —
**`DerivedKey`**, **`StreamClaimsJs`**, **`DualKeyVerifyResult`** — were defined as a set
in none of them. A newcomer had to stitch together the decision brief, the Rust crypto
module, the bindings module, and the deploy runbook to understand one request. This doc
is the stitch.

(It also heals a knowledge-graph blind spot — see [§5](#5-why-the-graph-thinks-these-types-are-orphaned).)

## 1. The two contracts that cross the boundary

There are **two independent crypto contracts** here. Keep them separate — they use
different key schedules on purpose.

| Contract | Purpose | Key schedule | Canonical Rust source |
|---|---|---|---|
| **Internal principal** | Carry the requestor's identity across the internal service hop so media-core (M3) / transcoder (M4) / recommender don't re-verify session cookies | JWE, key = `HKDF(secret, INFO_INTERNAL_PRINCIPAL)` | `crates/emerald-contracts/src/internal_principal.rs` |
| **Stream token** | Authorize a single media/IPTV stream URL (the `?t=` token) | HMAC-SHA256 over canonical bytes, **raw secret, NOT HKDF** (locked decision D18) | `crates/emerald-contracts/src/stream_token.rs` |

Both share the same HKDF primitive for *key derivation* (`crates/emerald-contracts/src/hkdf.rs`,
`derive_key(secret, info) -> [u8;32]`, HKDF-SHA256, byte-identical to Node's `crypto.hkdfSync`).
The frozen `INFO_*` label constants (top of `hkdf.rs`) are wire values — never change them.

## 2. The three marshalling DTOs (the flagged types)

These exist **only** as napi wrapper structs in `crates/emerald-contracts-napi/src/lib.rs`.
They are not in the core crate — they are the shape the core types take when they cross
into JavaScript. Each is mirrored by a hand-authored TypeScript interface in
`crates/emerald-contracts-napi/index.d.ts` (hand-authored, **not** napi-generated — see the
`napi prepare` / dts-guard note in module 39).

| DTO | Rust def | TS mirror | Wraps |
|---|---|---|---|
| `DerivedKey { bytes: Buffer }` | `crates/emerald-contracts-napi/src/lib.rs:25` | `index.d.ts:9` | output of `hkdf_session` / `hkdf_derive` |
| `StreamClaimsJs { exp, iat, jti, k, nbf, rid, sub, v }` | `…napi/src/lib.rs:78` | `index.d.ts:33` | the verified `StreamClaims` (the `k` stream-kind enum becomes a `string`) |
| `DualKeyVerifyResult { claims: StreamClaimsJs, usedFallback }` | `…napi/src/lib.rs:131` | `index.d.ts:55` | the `(StreamClaims, used_fallback)` tuple from `verify_dual_key` |

`DualKeyVerifyResult` exists so a token signed under the *previous* secret still verifies
during a secret rotation: `verify_dual_key` (`stream_token.rs`) computes both the primary
and fallback HMAC **unconditionally** (timing-safe) and reports which one matched.

## 3. End-to-end flow

### Internal principal — TS mints, Rust/Python verify (asymmetric by design)

```
Hono request (has a session/device/stream caller)
  └─ server/services/internalPrincipal.ts  mintInternalPrincipal()
       └─ contracts.internalPrincipalEncrypt(key, 'internal-v1', claims)   [napi → Rust]
            key = deriveKey(secret, INFO_INTERNAL_PRINCIPAL)  (keyDerivation.ts → contracts.hkdfDerive)
       → JWE string, 60s TTL
  └─ attached as `Authorization: Bearer <jwe>` on the internal call
        │
        ▼  (crosses the Docker network to a Rust/Python service)
media-core (Rust)  auth.rs verify_principal()
   derive_key(INFO_INTERNAL_PRINCIPAL) → internal_principal::decrypt → enforce_time_window
   → InternalClaims inserted into request extensions
recommender (Python, PyO3)  = the inverse binding: decrypt + enforce, no minting
```

**Asymmetry to remember:** TypeScript is a **minter only**. There is *no* TS decrypt path
for the internal principal — verification is cross-language (Rust via napi, Python via PyO3).
That is the whole point of Hybrid D / Rust-canonical: the Rust service is the authority.

### Stream token — sign and verify both available in TS

```
server/services/iptvStreamToken.ts
  signStreamToken()              → contracts.streamTokenSign         [napi → Rust]
  verifyStreamToken()            → contracts.streamTokenVerify       → StreamClaimsJs
  verifyStreamTokenDualKey()     → contracts.streamTokenVerifyDualKey → DualKeyVerifyResult
  (+ streamTokenEnforceTimeWindow)
```
The dual-key path is wired and tested but has **no production verify site yet** — it is
reserved for the next secret rotation.

## 4. Who enforces the boundary (call sites)

All three mint an internal principal and attach it, gated on `caller && env.internalPrincipalSecret`:

| Route / service | File | Failure posture |
|---|---|---|
| Media playback (`mediaAuth`; a `?t=` stream token can seed the caller) | `server/routes/media.ts` | — |
| Transcode | `server/routes/transcode.ts` | **Fails closed → 502** if the mint fails |
| Recommender call | `server/services/recommender.ts` | Logs-and-proceeds; the receiver does **not** enforce yet — the M3 "off → log → enforce" rollout is a one-line flip (see `docs/operations/m3-internal-principal-rollout.md`) |

## 5. Why the graph thinks these types are orphaned

The `/graphify` knowledge graph flags `DerivedKey`, `StreamClaimsJs`, and `DualKeyVerifyResult`
as **degree-1, weakly-connected** nodes. That is a **true positive about the graph, a false
positive about the architecture** — these types are referenced 6–41× each across two languages.

The graph is blind because every connecting edge is a **napi cross-language edge**, which AST
extraction structurally cannot produce:

1. **Cross-language.** AST extractors run per-language. No TS extractor walks into a compiled
   Rust `.node` addon; no Rust extractor emits an edge to a `.d.ts`. The `#[napi] DerivedKey`
   (Rust) and `interface DerivedKey` (TS) are two unlinked nodes — graphify only created the TS one.
2. **Dynamic require.** The load site is
   `createRequire(import.meta.url)('@emerald/contracts-napi')` (`server/services/contractsBinding.ts:14`),
   not a static `import` — `cjs-module-lexer` cannot statically analyze it.
3. **`file:` workspace alias.** `@emerald/contracts-napi` resolves via `package.json`
   (`"file:./crates/emerald-contracts-napi"`) — another indirection AST does not traverse.

To heal the graph properly, a napi-boundary extractor would need to link each `#[napi]` Rust
export to its `index.d.ts` declaration and resolve the `createRequire` of the `file:` alias.
Until then, **this doc is the human-readable edge** — and because graphify's *semantic*
(document) pass will index it on the next `--update`, it also restores the missing links in
the graph by naming all three DTOs and the flow together in one place.

## 6. Test coverage (the boundary is proven, not assumed)

- `crates/emerald-contracts/tests/vectors.rs` — Rust↔Node↔Python byte-parity gate against `tests/vectors/*.json`.
- `server/services/internalPrincipal.crossBinding.test.ts` — the real proof: napi mint → PyO3 decrypt round-trip (CI-gated `CI_REQUIRE_CROSS_BINDING=1`).
- `server/services/keyDerivation.test.ts` — HKDF vector parity + an independent `node:crypto` oracle.
- `server/services/internalPrincipal.test.ts`, `sub.test.ts` — mint shape + canonical sub vectors.

## Source docs this consolidates

- `docs/superpowers/specs/2026-05-25-m15-decision-briefs/01-section-4-internal-auth.md` — the decision *research* (point-in-time; the call was locked to Option D / Hybrid D).
- `docs/superpowers/specs/2026-05-25-cross-service-contract.md` — the cross-service contract (§3.3 HKDF, §4, §5.1 canonical JSON, §17).
- `docs/learning/modules/38-contracts-crypto.md` — Rust crypto internals.
- `docs/learning/modules/39-contracts-bindings.md` — the napi binding mechanism + the dts-guard concern.
- `docs/operations/m3-internal-principal-rollout.md` — the off → log → enforce deploy runbook.
