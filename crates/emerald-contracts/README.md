# emerald-contracts

Canonical source of truth for the tokens, key derivation, `sub` parsing, and PII
scrub keys shared across runtimes (`src/lib.rs:1-4`). Rust is the implementation;
TypeScript consumes it through `@emerald/contracts-napi`
(`../emerald-contracts-napi/package.json:2`), Python through the `emerald_contracts`
PyO3 module (`../emerald-contracts-pyo3/src/lib.rs:215-224`).

`tests/vectors/` is the interop oracle. This crate's suite loads six — stream-token-canonical,
sub-namespace, telemetry-pii-scrub, device-token-kid-rotation, internal-principal, hkdf-parity
(`tests/vectors.rs:43,81,116,133,205,288`) — and CI gates the Rust side
(`.github/workflows/ci.yml:314`) and the N-API↔PyO3 cross-binding (`:250-257`) on them.

## Frozen wire values

| What | Value | Code |
| --- | --- | --- |
| HKDF info — session | `eex/session/v1` | `src/hkdf.rs:13` |
| HKDF info — device token | `eex/device-token/v1` | `src/hkdf.rs:14` |
| HKDF info — internal principal | `eex/internal-principal/v1` | `src/hkdf.rs:15` |
| `sub` — Plex | `^plex:(0\|[1-9][0-9]*)$` | `src/sub.rs:15` |
| `sub` — local | `^local:[0-9A-HJKMNP-TV-Z]{26}$` | `src/sub.rs:18` |
| `sub` — Apple | `^apple:[0-9]{6}\.[0-9a-f]{32}\.[0-9]{4}$` | `src/sub.rs:21` |
| `sub` — Google | `^google:[0-9]{1,32}$` | `src/sub.rs:25` |
| Device token — TTL, kid | 180 days, `device-v1` | `src/device_token.rs:24`, `:20` |
| Internal principal — TTL, kid | 60 s, `internal-v1` | `src/internal_principal.rs:18`, `:17` |
| Stream token — verify skew | nbf +30 s, exp −5 s | `src/stream_token.rs:104-105` |

Renaming an HKDF info string does not fail loudly — it silently rotates every key
derived under that label (`src/hkdf.rs:10-12`). The `sub` regex literals are
themselves the contract; the Rust, TS, and Swift implementations must match
exactly (`src/sub.rs:4-6`).

## Traps

- **Stream tokens do not use HKDF.** They HMAC the raw UTF-8 bytes of
  `STREAM_TOKEN_SECRET` (`src/stream_token.rs:3-6`, `:143-144`).
  `INFO_STREAM_TOKEN_RESERVED` exists but is unused at v1, held so a future
  migration cannot reuse the label for something else (`src/hkdf.rs:17-22`).
- **Stream-token HMAC input is not `serde_json`.** serde emits fields in declaration
  order, not alphabetical; `canonical.rs` mirrors the TS emitter (`src/canonical.rs:3-10`).
- **`parse_sub` requires the provider prefix.** Grace-window normalization of legacy
  bare-Plex-ID subs is TS-side; it depends on a per-deployment timer (`src/sub.rs:70-73`).
- **Unknown `StreamKind` wire values are rejected, not ignored**
  (`src/stream_token.rs:29-31`, `:48-59`).
- **TypeScript must load the addon via `createRequire`.** A star-import resolves
  every export to `undefined`, and the failure surfaces at the first token
  operation rather than at import (`../../server/services/contractsBinding.ts:3-14`).

## Test

```bash
cargo test -p emerald-contracts   # vectors resolve from the repo root, not the crate
npm run build:napi                # rebuild the N-API binding (package.json:28)
```

The `§N` markers in the sources (§3 device tokens, §5 stream tokens, §8 `sub`
namespaces, §15.3 telemetry scrub) index a cross-service contract that is not
tracked in this repo. Its governing decision: the wire formats are fixed once
and shared, never renegotiated per runtime — so the frozen table above plus
`tests/vectors/` are that contract in executable form, and a change is a vector
change CI gates across Rust, TS and Python, not a per-language tweak.

<!-- seed:gap — author: when the untracked §-contract and this crate disagree, which wins? `device_token.rs:22-23` says "contract wins" over design.md; `sub.rs:4-5` says the regex literals here are the contract. State the tiebreaker. -->
