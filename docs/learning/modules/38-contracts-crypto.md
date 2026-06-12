
# Module: Cross-Language Token Crypto (crates/emerald-contracts)

---

## 1. WHAT

`crates/emerald-contracts` is a single Rust library that owns every cryptographic operation the app uses to prove identity and protect secrets as data moves between its three runtimes — a TypeScript/Hono backend, a Python recommender, and eventually a Swift iOS app. It mints and verifies three kinds of tokens: **stream tokens** (short-lived URLs that authorize a media stream, signed with HMAC-SHA256), **device tokens** (long-lived login credentials stored on-device, encrypted as JWE/AES-256-GCM so the client can never read the claims), and **internal-principal tokens** (60-second single-hop identity badges the Hono backend issues to Rust microservices so those services never have to handle session cookies themselves). It also owns the HKDF key-derivation function that turns one raw environment-variable secret into per-purpose keys, a canonical JSON serializer that guarantees every language produces the exact same bytes before signing, and the regex rules for parsing the `plex:`, `local:`, and `apple:` user-identity namespaces.

---

## 2. WHY

### Why cross-language contracts exist — the drift problem

Imagine instead that TypeScript had its own stream-token signer, Python had its own, and the Swift app had a third. Each developer writes what they think the spec says. Six months later:

- TypeScript sorts JSON fields alphabetically before signing. Python uses insertion order (which matches because Python dicts preserved order since 3.7 — but only by coincidence for the current field list). Someone adds a new field to Python. Now Python HMAC != TypeScript HMAC for the same token. Every stream URL returned by Python is suddenly invalid when the TS verifier checks it.
- TS uses HKDF to stretch the secret. Python reads the raw env var bytes. They derive different keys. Device tokens encrypted by TS cannot be decrypted by anything else.
- Someone fixes a timing-safe comparison bug in TS but forgets Python. Python becomes vulnerable to a timing attack that leaks the HMAC key one bit at a time.

Each of those is a **silent security regression** — the app keeps running, nothing crashes, but tokens validate when they shouldn't or fail when they should succeed. Cross-language crypto bugs are especially dangerous because automated tests rarely catch them (tests usually run within one runtime, not across runtimes).

### Why one Rust implementation solves this

Rust compiles to a native `.node` extension (N-API binding: `crates/emerald-contracts-napi`) that Node/TypeScript loads directly — zero copy, same process. The same Rust code compiles to a Python extension (PyO3). The Swift port will translate the same algorithm. There is now **one source of truth** for the HMAC computation, the canonical serializer, the HKDF derivation, and the AES-GCM encrypt/decrypt. Bugs get fixed once. Clock-skew constants (`NBF_SKEW_SECS=30`, `EXP_SKEW_SECS=5`) are Rust constants imported by all callers, never duplicated.

The test-vector files in `tests/vectors/` act as the **cross-language contract**: they are JSON files with known inputs and the byte-exact expected outputs. `cargo test` verifies the Rust implementation. The TS test suite loads the same JSON files and verifies the N-API binding. If they ever diverge, CI fails before the code ships.

---

## 3. MAP

### Key files

| File | Line range | Purpose |
|------|-----------|---------|
| `crates/emerald-contracts/src/lib.rs` | 1–33 | Public API surface + re-exports; says exactly what this crate offers |
| `crates/emerald-contracts/src/hkdf.rs` | 1–74 | HKDF-Extract+Expand; info-string constants; the bridge from one env-var secret to per-purpose 32-byte keys |
| `crates/emerald-contracts/src/canonical.rs` | 1–92 | `json_escape_string` — the byte-exact JSON serializer that makes Rust and TS produce identical HMAC input |
| `crates/emerald-contracts/src/stream_token.rs` | 1–463 | Stream-token sign/verify (HMAC-SHA256), `canonical_bytes`, `enforce_time_window`, dual-key rotation |
| `crates/emerald-contracts/src/jwe.rs` | 1–210 | AES-256-GCM encrypt/decrypt shared by device_token and internal_principal; random-nonce generation |
| `crates/emerald-contracts/src/device_token.rs` | 1–196 | JWE-wrapped 180-day login token; kid-aware multi-key verifier for key rotation |
| `crates/emerald-contracts/src/internal_principal.rs` | 1–122 | JWE-wrapped 60-second service-to-service identity badge; no nbf skew |
| `crates/emerald-contracts/src/sub.rs` | 1–162 | Sub-namespace parsing (plex/local/apple); regexes are the wire contract |
| `tests/vectors/stream-token-canonical.json` | — | 8 known-good HMAC vectors (input claims → canonical bytes hex → HMAC hex) |
| `tests/vectors/hkdf-parity.json` | — | HKDF known-answer vectors verified by both Rust and Node |
| `tests/vectors/device-token-kid-rotation.json` | — | Device-token kid rotation scenarios: accepted + rejected cases with sampleTokens |
| `crates/emerald-contracts/tests/vectors.rs` | 1–308 | Rust-side integration tests that load all vector files |

### One token's life: stream token from mint to verify

**Step 1 — Hono calls Rust (via N-API) to mint:**
```
stream_token::sign(secret.as_bytes(), &claims)
```
Internally this calls `canonical_bytes(&claims)` (stream_token.rs:121–141), which produces a deterministic JSON string with fields in strict alphabetical order: `exp, iat, jti, k, nbf, rid, sub, v`. No serde — hand-rolled template. The result is then HMAC-SHA256'd (stream_token.rs:145–156). Output format: `base64url(canonical_json).base64url(hmac_sig)`.

**Step 2 — The token travels to the browser as a query parameter or header.**

**Step 3 — The Rust transcoder verifies (via N-API or direct Rust call):**
```
stream_token::verify(secret.as_bytes(), token)
// → Ok(StreamClaims) or Err(TokenError::BadSignature / Expired / etc.)
```
`verify` splits on `.`, decodes both halves, recomputes the HMAC from the canonical bytes, and compares with `ct_eq` (constant-time, timing-attack-resistant). Then `enforce_time_window` checks `nbf ≤ now ≤ exp` with the pinned skew constants.

**Step 4 — Python recommender (future PyO3 binding):**
The same `sign`/`verify` functions are exposed via PyO3. Python calls `contracts.stream_token_verify(secret, token)` — same Rust code path, same HMAC, same skew constants.

---

## 4. PREREQUISITES — Fundamentals ladder

### Hashing (one-way function)
A hash function takes any input and produces a fixed-size digest. SHA-256 always outputs 32 bytes. You cannot reverse it — given the output, you cannot recover the input. Two different inputs rarely produce the same output (collision resistance). Useful for: fingerprinting data, verifying integrity.

### HMAC (keyed hash — what stream tokens use)
HMAC is "Hash with a secret mixed in." `HMAC-SHA256(key, message)` produces a 32-byte tag. Only someone who knows `key` can produce a valid tag. This means:
- **Tamper-proof**: change any byte of the message and the tag no longer matches.
- **Source-authenticated**: only the holder of `key` could have produced the tag.
- Does NOT hide the message — anyone can read the `canonical_bytes` in the token (just base64-decode segment 1). Stream tokens are visible to the client; that is fine because the claims themselves are not secret (they just say "user plex:12345 may stream channel ch-101 until timestamp X").

### Signing vs encryption — why stream tokens use HMAC, not AES-GCM
HMAC = sign (prove who made it, detect tampering). AES-GCM = encrypt (hide the contents). Stream tokens are signed but not encrypted because:
1. The client needs to read the claims to show a progress bar, check expiry, etc.
2. The claims aren't secret — channel IDs and user IDs are not sensitive.

Device tokens ARE encrypted (JWE/AES-256-GCM) because they carry the user's `role`, `auth_mode`, and server identity — information the server needs but the client should never be able to forge or inspect.

### HKDF (key derivation function)
You have one secret (an env-var `DEVICE_TOKEN_SECRET`). You need separate keys for device tokens and session cookies so that compromising one cannot be used to forge the other. HKDF solves this: `HKDF(secret, info="eex/device-token/v1")` and `HKDF(secret, info="eex/session/v1")` produce completely different 32-byte keys from the same master secret. The `info` string is the "label" that separates purposes. Change the label → completely different key, even with the same secret.

### AES-256-GCM (authenticated encryption — what JWE uses)
AES-GCM encrypts AND authenticates. Given a 32-byte key and a random 12-byte nonce (IV), it produces ciphertext that:
- Cannot be read without the key.
- Cannot be tampered with — any modification of the ciphertext is detected via a 16-byte authentication tag.
The nonce must never repeat for the same key. emerald-contracts generates a fresh random nonce via `OsRng` on every encrypt call (jwe.rs:57).

### JWE compact serialization (the wire format for device/internal tokens)
```
base64url(header) . "" . base64url(nonce) . base64url(ciphertext) . base64url(tag)
```
- Segment 1: JSON header `{"alg":"dir","enc":"A256GCM","kid":"device-v1"}` — readable, tells the verifier which key to use.
- Segment 2: empty (no wrapped key; `alg:dir` means the key is used directly).
- Segment 3: the 12-byte nonce.
- Segment 4: the encrypted claim set.
- Segment 5: the 16-byte GCM authentication tag.
The header bytes are used as AAD (Additional Authenticated Data), meaning any tampering with the header also breaks the tag.

---

## 5. GOTCHAS & WAR STORIES

### Stream tokens deliberately do NOT use HKDF — and that decision is locked

The `INFO_STREAM_TOKEN_RESERVED` constant in hkdf.rs exists but is explicitly NOT used. Stream tokens use raw UTF-8 bytes of `STREAM_TOKEN_SECRET` as the HMAC key. This was a deliberate decision locked on 2026-05-27 (contract D18 amendment). The reason: moving to HKDF would silently rotate the key, invalidating all 90-day external playlist tokens already in circulation. The vector file documents this explicitly in `_meta.hmac_key_derivation_note`. If you ever see someone proposing to "clean up" stream tokens to use HKDF for consistency — stop them. It is a breaking change disguised as a refactor.

### Canonical serialization must be hand-rolled, not serde

`serde_json::to_string` serializes struct fields in declaration order (the order you wrote them in the `struct` block). The stream token has 8 fields; the wire contract requires alphabetical order. If you used serde, field `jti` (declaration position 3) would appear at position 3, but alphabetically it belongs at position 3 too — by coincidence it works today, but add one field in the wrong spot and the HMAC breaks silently. The hand-rolled template in `canonical.rs` + `stream_token.rs:canonical_bytes` is the safety net.

### Constant-time comparison is mandatory

`compute_and_compare` in stream_token.rs uses `subtle::ct_eq` (constant-time equality). Naive `==` on byte slices short-circuits at the first differing byte. An attacker can time millions of bad-signature requests to learn, bit by bit, what the valid signature is — a timing side-channel attack. `ct_eq` always runs to completion regardless of where bytes differ. The code also computes BOTH keys unconditionally in `verify_dual_key` before branching (stream_token.rs:169–185) — otherwise the time difference between "primary hit" and "primary miss → try fallback" would leak which key the token was signed with.

### Random nonce is not optional

The test `nonce_uniqueness` in jwe.rs verifies that two encrypts of identical plaintext produce different JWE tokens. If the nonce were deterministic (e.g., a counter), an attacker who observed two JWEs encrypted with the same key and the same nonce could XOR the ciphertexts to cancel the keystream and recover plaintext. This is catastrophic for AES-GCM. The test guards against anyone "optimizing" nonce generation.

### Kid dispatch before decryption

The device-token verifier reads the `kid` from the unencrypted header, looks up the key in a `HashMap`, then decrypts. If the kid is not in the map, it returns `UnknownKid` without attempting decryption. This is important during key rotation: the old key stays in the map under `device-v1` while new tokens use `device-v2`. Both decrypt correctly. Remove the old kid prematurely and all clients with cached old tokens are locked out.

### Changing an HKDF info string is a silent key rotation

The `INFO_*` constants are explicitly documented "NEVER rename post-deploy without a verifier grace window." If you renamed `eex/device-token/v1` to `eex/device/v1`, the HKDF output changes, the derived key changes, and every existing device token becomes undecryptable. No error at deploy time; the first decryption attempt simply fails with `DecryptFailed`.

### Test vectors are the cross-language oracle, not documentation

The JSON vector files are executable tests, not documentation that might drift. `cargo test` fails if Rust diverges from any vector. The TS test suite loads the same files. If you change canonical serialization or HKDF and the vectors pass in Rust but not TS, you know exactly where the split is — without needing to run both services against a live session.

---

## 6. QUIZ BANK

**Q1.** The TS binding calls `streamTokenSign(secret, claims)`. The Rust implementation in `canonical_bytes` produces field order `exp, iat, jti, k, nbf, rid, sub, v`. A new developer adds a `quality: string` field to `StreamClaims` and re-runs the serde-derived serializer instead of the hand-rolled template. The TS binding is not changed. What breaks, and how would you detect it before production?

**A1.** Serde places `quality` in declaration order (wherever it was added), while the hand-rolled TS template still outputs alphabetical order. The HMAC inputs diverge → every token signed by the new Rust version is rejected by the TS verifier (and vice versa) with `BadSignature`. The cross-language test vector in `tests/vectors/stream-token-canonical.json` would catch this: `stream_token_canonical_vector_parity` in `crates/emerald-contracts/tests/vectors.rs` asserts that Rust's `canonical_bytes` matches the pinned hex for the live-basic vector. It would fail the moment the new field changed the byte sequence.

**Q2.** You rotate the `DEVICE_TOKEN_SECRET` env-var on the NAS and redeploy without updating the key map. You set only `device-v2` in the map (the new key). What happens to users who already have a `device-v1` token stored on their device?

**A2.** Their token's protected header says `kid: device-v1`. The verifier looks up `device-v1` in the `HashMap`, finds nothing, and returns `DeviceTokenError::UnknownKid`. Every such user is immediately logged out on their next request. The correct rotation sequence is: add `device-v2` to the map alongside `device-v1`, deploy, wait for the 180-day device-v1 TTL to drain (or force-invalidate by removing `device-v1` after all clients refresh), then remove `device-v1`.

**Q3.** Someone proposes switching stream tokens from raw-secret HMAC to HKDF-derived HMAC "for consistency with device tokens." The change is a single line in `stream_token::sign`. No other files change. What breaks in production that is not caught by unit tests?

**A3.** Every 90-day external playlist token already issued becomes invalid — the HMAC was computed with the raw secret; the new verifier re-derives with HKDF and gets a different key → `BadSignature`. Unit tests pass because they mint and verify within the same process (same derivation path). The cross-language HMAC vectors would catch it if the vectors' `test_key` were updated — but if someone updates both the code and the vector simultaneously, the regression is invisible. The real protection is the `_meta.hmac_key_is: raw_utf8_of_test_key` annotation and the production invariant that 90-day tokens must survive a rolling deploy.

**Q4.** A JWE device token is intercepted by a network adversary. The adversary flips one bit in the ciphertext segment (segment 4) and forwards the modified token. What happens?

**A4.** AES-GCM's authentication tag (segment 5) was computed over the original ciphertext. Flipping a ciphertext bit invalidates the tag. `aes_gcm.decrypt()` returns an error before any plaintext is produced. The Rust code maps that to `JweError::DecryptFailed`. The adversary learns nothing — not even which byte was wrong. GCM provides authenticated encryption, so integrity and confidentiality are coupled.

**Q5.** `enforce_time_window` in stream_token.rs applies `NBF_SKEW_SECS=30` and `EXP_SKEW_SECS=5`. Explain what each skew is for and what happens if they drift between the Rust crate and a hypothetical Python reimplementation that uses 60/0 instead.

**A5.** `NBF_SKEW_SECS` gives 30 seconds of tolerance for a freshly-minted token arriving at a verifier whose clock is slightly behind the minter's — the token says "not valid before T" but the verifier sees T-20, which is within the 30s window, so it accepts. `EXP_SKEW_SECS` gives 5 seconds of grace after expiry for in-flight requests. If the Python reimplementation uses 60/0: (a) Python accepts tokens the Rust/TS verifier would reject as NotYetValid (window 60s vs 30s — different acceptance envelope, same token); (b) Python rejects tokens at exactly `exp` that Rust/TS would still accept within the 5s grace — causing spurious failures for in-flight HLS segment requests right at the expiry boundary. Security-relevant: the Python verifier is now more permissive on nbf, which means a token minted with a far-future nbf is accepted 30s earlier than intended. These bugs are silent — nothing crashes; some requests succeed or fail inconsistently depending on which language handles them.

**Q6.** `internal_principal` tokens have a 60-second TTL and no `nbf` skew. Stream tokens have a 30-second `nbf` skew. Why the difference?

**A6.** An internal-principal token is a single-request identity badge — it is minted by Hono for one HTTP call to the media-core or transcoder service. A 60-second window is already generous for a local Docker network hop. Adding nbf skew would mean a service could accept a token that is up to 30 seconds before its stated validity start — for a 60-second token that is a 50% expansion of the valid window, meaningfully increasing the forgery-replay window. Stream tokens are delivered to the browser, which then makes HLS segment requests minutes later. A 30-second nbf skew absorbs clock drift between the server that minted the token and a CDN edge node that verifies it. The threat models differ: internal tokens face a local trusted network; stream tokens face the public internet with heterogeneous clocks.

---

## 7. CODE-READING EXERCISE

**Goal:** trace one complete stream-token verify call, understanding every line.

Open `crates/emerald-contracts/src/stream_token.rs`.

**Step 1 — Find the entry point (line 161):**
```rust
pub fn verify(secret_bytes: &[u8], token: &str) -> Result<StreamClaims, TokenError>
```
A caller passes the raw secret bytes and the token string. It returns either the parsed claims or a typed error. Notice: `verify` does NOT check time windows — that is the caller's responsibility. This separation lets callers control the clock source (useful in tests).

**Step 2 — Trace `split_token` (line 212):**
The token is `<base64url_payload>.<base64url_sig>`. `split_token` splits on `.`, decodes both halves. If there are not exactly two segments, or either decode fails, it returns a typed error. Notice `parts.next().is_some()` at line 216 — it rejects tokens with more than two segments (prevents JWT confusion attacks where a third segment changes parsing).

**Step 3 — Trace `verify_with_canonical` → `compute_and_compare` (line 240):**
This is where the cryptography happens. A fresh `HmacSha256` is created from `secret_bytes`, `mac.update(canonical)` feeds the payload, `mac.finalize()` produces the expected 32-byte signature, then `ct_eq` compares it to the signature from the token. Both the "wrong key" path and the "tampered sig" path end here with `false`.

**Step 4 — Understand constant-time (line 249–255):**
The length check `if sig.len() != computed.len()` returns `false` WITHOUT computing ct_eq. HMAC-SHA256 output is always exactly 32 bytes, so in practice a mismatch here means the token is truncated or malformed, not a timing-sensitive comparison. The comment explains why this is safe: the length itself is a known constant for valid signatures.

**Step 5 — Trace `parse_canonical` (line 258):**
This uses `serde_json` to parse the already-verified canonical bytes back into a `StreamClaims` struct. Notice: signing uses the hand-rolled serializer, but parsing uses serde — parsing is permissive (whitespace, field order don't matter), and it happens AFTER the HMAC passes, so a forged payload with nonstandard JSON would have needed to produce a valid HMAC first, which is impossible without the key.

**Step 6 — Cross-reference to the test vector (line 331):**
The test `canonical_bytes_match_ts` at line 330 hardcodes the expected hex bytes for the live-basic claims. Match those bytes to `tests/vectors/stream-token-canonical.json`, vector `live-basic`, field `canonical_bytes_hex`. They are identical. This is the cross-language contract made executable: if you change anything in `canonical_bytes`, this test fails before the vector runner even runs.

**Exercise question:** In `verify_dual_key` (line 169), both `compute_and_compare` calls run unconditionally. Rewrite the function to short-circuit (return early if primary_ok), and explain what security property is lost. Would the behavior observable from the outside change?

*(Answer: losing the unconditional fallback computation means the time taken differs between "primary hit" and "primary miss → fallback". An attacker making millions of requests with a primary-key-signed token vs a fallback-key-signed token could measure the timing difference and determine which key class was used. Externally the return value is the same; only the timing changes. This is a side-channel leak on the key-rotation transition state.)*

---

