
---

# Testing Strategy — Teaching Dossier

---

## 1. WHAT

The Emerald Exchange tests itself at four distinct levels, each run by a different tool matched to the language it tests: **vitest** runs TypeScript unit and integration tests for both the Hono backend (`server/`) and the React SPA (`src/`); **pytest** runs unit tests for the Python recommender service (`recommender/`); **cargo test** runs tests for the Rust cryptographic and media-core crates (`crates/`); and **Playwright** runs browser-automation tests that open a real browser and exercise full-stack flows end-to-end (`tests/e2e/`). Across all four layers, a special set of static JSON files in `tests/vectors/` acts as a shared truth document: they pin the exact byte-level output that any language's crypto implementation must produce, ensuring a token minted by the Rust crate and a token verified by the TypeScript server and a token accepted by the Python recommender are all talking about the same mathematical operation.

---

## 2. WHY

**Why test at all?** Because "the code runs" is not the same as "the code does what we intended." A function can return without crashing and still return the wrong answer. A server can respond with HTTP 200 and still send corrupted data. Tests are the machine-checkable specification: they describe what the system is *supposed* to do, and they run fast enough to catch regressions before they reach users.

**Why not just write unit tests in each language?** You could write a Rust test that verifies HMAC-SHA256 produces the right output, a TypeScript test that verifies the same thing, and a Python test that verifies the same thing. But that only proves each implementation is internally consistent with itself. It does *not* prove the three implementations agree with each other. If the Rust crate serializes JSON fields in alphabetical order and the TypeScript implementation accidentally serializes them in insertion order, both unit test suites pass while the system is broken: a token minted by one runtime will fail verification in another.

**Why do cross-language vectors solve this?** A vector file is a table of known inputs and their required outputs, computed once from an authoritative implementation and then locked into source control. Every runtime loads the same file and checks its own output against the same table. If Rust produces HMAC `4b0b2e...` and the vector says the answer must be `4b0b2e...` and TypeScript also produces `4b0b2e...`, we have proved that the three implementations are byte-identical without any of them calling the others. The vector is the contract. The contract lives in `tests/vectors/` in plain JSON so humans can read it and reason about the security properties.

**The "why-chain":**  
Code breaks → tests catch regressions → but multi-language code can break *between* implementations → duplicated unit tests only prove internal consistency → vectors prove cross-language byte equality → therefore vectors are the right tool for a system where a token minted in Rust must verify identically in TS and Python.

---

## 3. MAP

| Runner | Location | What it covers | How to run |
|---|---|---|---|
| **vitest** (server) | `server/**/*.test.ts` | Hono routes, middleware (CSRF, rate-limit, auth), session/JWT minting+verification, IPTV stream tokens, device tokens, HKDF key derivation, telemetry PII scrubbing, *arr bridge logic, feedback/suggestions routes | `npm test` |
| **vitest** (SPA) | `src/**/*.test.ts`, `src/**/*.test.tsx` | React hooks, query client config, router, optimistic mutations, title normalization utilities | `npm test` (same run) |
| **vitest** (coverage gate) | all of the above | Enforces floors: server ≥ 87% stmts, SPA ≥ 25% stmts; fails CI on regression | `npm run test:coverage` |
| **vitest** (eval harness) | `server/routes/suggestions.eval.test.ts` | AI recommendation quality scoring with a programmable mock Anthropic; writes timestamped JSON report | `npm run eval:recs` (excluded from `npm test`) |
| **pytest** | `recommender/tests/` | Python recommender service: scoring path, feedback signals, TMDB ingest, holdout optimizer, internal-principal JWE verification (cross-language gate), sub-namespace parsing, cache invalidation, DB migrations | `pytest recommender/tests/` (inside venv) |
| **cargo test** | `crates/emerald-contracts/tests/vectors.rs` (integration), inline `#[test]` in each crate | Rust crypto crate: HMAC stream tokens, HKDF derivation, sub-namespace parsing, telemetry PII scrub, device token KID rotation, internal-principal JWE round-trip — all verified against the shared JSON vectors | `cargo test` (from repo root) |
| **Playwright** (chromium) | `tests/e2e/*.spec.ts` | Mocked-API SPA flows: auth, movie search mode, downloads permissioning | `npm run test:e2e` |
| **Playwright** (integration) | `tests/e2e/integration/coreFlows.spec.ts` | Real backend (throwaway SQLite, stubbed third-party HTTP): session JWE, CSRF, authz, *arr proxies, SPA fetch layer | `npm run test:e2e:integration` |
| **Playwright** (playback-chrome) | `tests/e2e/playback/msePlayback.spec.ts` | Real Chrome + real H.264/AAC HLS fixture + real backend transcode proxy: MSE SourceBuffer append success, `video.currentTime` actually advances | `npm run test:e2e:playback` |

**Key path anchors:**
- Vector files: `/Users/cujo253/Documents/theemeraldexchange/tests/vectors/`
- Rust vector consumer: `/Users/cujo253/Documents/theemeraldexchange/crates/emerald-contracts/tests/vectors.rs`
- TS vector consumers: `server/services/iptvStreamToken.test.ts`, `server/services/keyDerivation.test.ts`, `server/services/contractsBinding.test.ts`, `server/services/telemetryPiiScrub.test.ts`
- Python vector consumer: `recommender/tests/test_internal_principal.py`
- Vitest config: `/Users/cujo253/Documents/theemeraldexchange/vitest.config.ts`
- Shared test env: `/Users/cujo253/Documents/theemeraldexchange/vitest.env.ts`
- HLS fixture: `/Users/cujo253/Documents/theemeraldexchange/tests/fixtures/hls/`

---

## 4. PREREQUISITES

### What is an assertion?

An assertion is the core mechanic of every test. It is a statement that says "I claim this value equals that value — if it does not, the test fails and tells me exactly what was wrong." In vitest/Jest it looks like `expect(got).toBe(expected)`. In pytest it is `assert got == expected`. In Rust it is `assert_eq!(got, want, "context message")`. If the assertion passes, the test is green. If it fails, the test prints both the actual value and the expected value so you can compare them.

The important insight: an assertion only checks *one specific claim*. A test file contains many assertions, each checking one specific thing. Together they build up a behavioral specification of the code.

### What is a fixture?

A fixture is any pre-built piece of state that a test needs before it can run. Fixtures answer the question "what does this test assume already exists?" A fixture might be:

- A fake user with a known session cookie (used by many Playwright tests via the `login()` helper in `tests/e2e/integration/coreFlows.spec.ts`)
- A known HMAC key (the `test_key` field in `tests/vectors/stream-token-canonical.json`)
- A temporary in-memory SQLite database with migrations already run (vitest's per-worker DB isolation from `vitest.setup.ts`)
- A physical binary file on disk (the committed MPEG-TS segments under `tests/fixtures/hls/`)

In pytest the `@pytest.fixture` decorator marks a function that vitest runs *before* the test body and injects as a parameter. The `configure_mode` fixture in `test_internal_principal.py` is a good example: it reconfigures the module's global config and guarantees restoration after the test, so tests cannot leak state into each other.

---

## 5. GOTCHAS & WAR STORIES

### Real Chrome vs bundled Chromium — the grey-box false negative

Playwright ships with a bundled open-source Chromium. Open-source Chromium does not include the proprietary H.264 and AAC decoders. The project discovered this the hard way: a playback fix was declared "proven" based on server-side evidence (HTTP 200, valid ffprobe output on segments). The browser never actually advanced the video. A subsequent test using the *bundled* Chromium would have passed too — not because playback worked, but because the browser silently could not decode H.264 and the test was not checking for that.

The real regression class — 6-channel AAC being rejected by Chrome's MSE SourceBuffer despite `isTypeSupported` returning `true` — is completely invisible to any server-side test. The only way to catch it is to run the spec using `channel: 'chrome'` (a real branded Chrome install with codec support) and observe whether `video.currentTime` actually advances beyond 2 seconds. The `tests/e2e/playback/msePlayback.spec.ts` spec was written specifically for this. It is registered as the `playback-chrome` Playwright project and only runs when a real Chrome install exists.

**Lesson:** for media playback, HTTP 200 and valid ffprobe are necessary but not sufficient. Verify the browser MSE append.

### The rotted eval:recs gate

The recommendation eval harness (`server/routes/suggestions.eval.test.ts`) is run by a separate vitest config (`vitest.eval.config.ts`). The main vitest config and the eval config both need the same test-time environment variables because `server/env.ts` validates required variables at *import time* — the moment any server code is imported, it checks for `STREAM_TOKEN_SECRET`, `DEVICE_TOKEN_SECRET`, etc.

When `STREAM_TOKEN_SECRET` became a required variable, it was added to the main vitest config but not the eval config (which used to duplicate a subset). The result: `npm run eval:recs` silently died on import with "Missing required env var: STREAM_TOKEN_SECRET" — but nobody noticed because the eval harness was not part of CI. The fix was to extract a single `TEST_ENV` object in `vitest.env.ts` and import it from both configs. The comment at the top of that file says exactly this.

**Lesson:** env variables validated at import time poison any runner that imports server code. A single source of truth (`vitest.env.ts`) ensures the next required variable cannot break a runner nobody runs in CI.

### "Exit code 0 is not done"

Cargo test exits 0. npm test exits 0. pytest exits 0. None of that tells you the server responds correctly to the actual HTTP request, that the data landed in the database, or that the UI rendered the expected state. Multiple bugs in this project passed all tests while the deployed system was broken:

- The transcoder exited cleanly (exit 0) and supervisor restart-looped it, accumulating stale processes that exhausted the GPU concurrency cap — causing 503s on the second title.
- A Playwright spec showed HTTP 200 for every segment request while the browser never played the video (the grey-box bug above).
- A CSRF fix passed all unit tests; the deployed build 403'd heartbeat POSTs that lacked an `Origin` header.

The rule in the CLAUDE.md is explicit: after every step in stateful or deploy work, verify the intended *downstream behavior* — not just that the process started, but that the service responds correctly, the data is where it should be, the UI renders the expected result.

### Coverage floors are ratchets, not ceilings

The vitest coverage config has per-block thresholds. The comment in `vitest.config.ts` states the ratchet policy: floors sit just below the measured numbers so the gate bites on a real regression but does not flake on a small refactor. NEVER lower a floor — a drop below any floor means coverage genuinely regressed, and the fix is more tests, not a lower bar.

---

## 6. QUIZ BANK

**Q1.** The HKDF key derivation test in `server/services/keyDerivation.test.ts` loads `tests/vectors/hkdf-parity.json` and checks that the TypeScript `deriveKey` function reproduces the pre-computed OKM hex values. The Rust crate has a test in `crates/emerald-contracts/tests/vectors.rs` that loads the same file. If you change the HKDF info string in the Rust crate from `b"eex/session/v1"` to `b"eex/session/v2"`, which tests fail, and which pass?

**A1.** The Rust test in `vectors.rs` (`hkdf_parity_vector`) fails immediately because the derived OKM no longer matches the vector. The TypeScript test continues to pass because it tests the TypeScript implementation, which is unchanged. This illustrates the purpose of vectors: the Rust and TS sides each independently verify against the same expected output, so a divergence in either implementation surfaces immediately — without the two runtimes ever calling each other.

---

**Q2.** `npm run test:e2e` passes. `npm run test:e2e:playback` fails with "video.currentTime never passed 2s." What does that tell you about the state of the system, and where would you look first?

**A2.** Something is wrong in the browser's media pipeline — MSE append, codec decoding, or the transcode proxy serving incorrect segments — that is invisible to HTTP-level checks. Look at `probe.mediaErrors` and `probe.fatalErrors` from the Playwright evaluate call: a `mediaError/bufferAppendError` points to an MSE rejection (check audio codec and channel count — 6-channel AAC is rejected by Chrome MSE). A `fatalError` from hls.js suggests a network-level failure. An empty error list with stalled `currentTime` suggests the video element received data but cannot decode it (wrong codec, e.g., the bundled Chromium H.264 trap — verify which browser is actually running).

---

**Q3.** A new required environment variable `TMDB_API_KEY` is added to `server/env.ts`. The variable is added to `vitest.config.ts`'s `env` block. Two weeks later a colleague reports that `npm run eval:recs` crashes on startup with "Missing required env var: TMDB_API_KEY." Without looking at the code, what is the almost-certain cause?

**A3.** The variable was added to the main vitest `env` block but not to the shared `TEST_ENV` object in `vitest.env.ts` (or to the eval-specific config if it imports `TEST_ENV` but overrides it). Because `server/env.ts` validates at import time, any vitest runner that imports server code dies before any test runs. The fix is to add the variable to `vitest.env.ts`'s `TEST_ENV` export so both configs pick it up automatically.

---

**Q4.** You are asked to add a new stream token kind `dvr` to the system. You add it to the Rust `StreamKind` enum, regenerate the NAPI binding, and add TypeScript handling. What must you do to the `tests/vectors/` directory, and why?

**A4.** You must add a new vector entry for the `dvr` kind to `tests/vectors/stream-token-canonical.json`. The vector must contain: the claims input, the hex-encoded canonical bytes (RFC 8785 deterministic JSON serialization), and the HMAC hex computed with the test key. Without a new vector, neither the Rust `stream_token_canonical_vector_parity` test nor the TypeScript `stream-token-canonical.json vectors` test would ever exercise the new kind, so a bug in its canonical serialization would be undetected. Adding the vector also ensures that any future language (e.g., a Swift client) that consumes stream tokens gets an authoritative expected output to test against.

---

**Q5.** `npm run test:coverage` reports: server statements 86.8%, below the 87% floor. Nobody changed any production code — only a test file was edited. What likely happened, and is this a real regression?

**A5.** Adding a new test file can slightly *lower* aggregate coverage if the test file itself imports code paths that were previously untested but the new test does not exercise all of them, or if a previously well-tested helper was refactored. But more likely: a new server source file was added without corresponding tests, diluting the denominator. This is a real regression by the ratchet policy — the floor exists precisely to catch this. The fix is to add tests for the uncovered code, not to lower the threshold.

---

## 7. CODE-READING EXERCISE

**The file:** `tests/vectors/stream-token-canonical.json`

**The three consumers:** (1) `crates/emerald-contracts/tests/vectors.rs` — Rust; (2) `server/services/iptvStreamToken.test.ts` — TypeScript/vitest; (3) `recommender/tests/test_internal_principal.py` — Python (uses the internal-principal sibling vector, which tests the same HKDF + JWE machinery that protects every recommender call).

### Guided walk

**Step 1 — Read `_meta`.** The `_meta` block documents *why* the vector exists and locks in a design decision: stream tokens use raw `STREAM_TOKEN_SECRET` bytes as the HMAC key — no HKDF, no domain-separation info string. This is the exception to the rule (session/device/internal tokens *do* use HKDF). The note says "Locked 2026-05-27 per ambitions-audit" — meaning this is a deliberate, reviewed choice, not an oversight. A future developer who wonders "why isn't HKDF used here?" will find the answer in the vector file itself.

**Step 2 — Pick one vector: `live-basic`.** The `claims_input` is a plain JSON object with seven fields: version `v:1`, kind `k:"live"`, resource ID `rid:"ch-101"`, subject `sub:"plex:12345"`, and three timestamps. Notice the field names: short, lowercase, no camelCase. This is the wire format. The `canonical_bytes_hex` is the deterministic serialization of those fields: decode it from hex and you get UTF-8 JSON with keys in alphabetical order and no whitespace — that is RFC 8785 canonical JSON. The `hmac_hex_with_test_key` is `HMAC-SHA256(key=b"TEST_SECRET_32_CHARS_FIXED_VALUE_X", data=canonical_bytes)`.

**Step 3 — Trace the Rust consumer** (`vectors.rs`, function `stream_token_canonical_vector_parity`). It loops over every vector. For each one it constructs a `StreamClaims` struct from the `claims_input` fields, calls `canonical_bytes(&claims)`, and asserts the output equals the hex-decoded `canonical_bytes_hex`. Then it calls `sign(test_key.as_bytes(), &claims)`, decodes the HMAC from the token's second segment (base64url-encoded), and asserts it equals `hmac_hex_with_test_key`. If the Rust canonical serializer ever changes — even adding a space — this test fails immediately.

**Step 4 — Trace the TypeScript consumer** (`iptvStreamToken.test.ts`). It loads the same JSON file from disk using `readFileSync`. In the `stream-token-canonical.json vectors` describe block, it iterates over vectors, calls `canonicalBytes(claims)` (the TS implementation), and asserts the hex-encoded output matches `canonical_bytes_hex`. Then it calls `createHmac('sha256', testKey).update(bytes).digest('hex')` and asserts it matches `hmac_hex_with_test_key`. The TS test is asserting the same expected values from the same file as the Rust test. If both pass, the two implementations are byte-identical.

**Step 5 — Trace the Python consumer** (`test_internal_principal.py`). Python does not consume the stream-token vector directly (it does not issue stream tokens). Instead it uses the `internal-principal.json` vector, which tests the JWE-encrypted internal auth token. The `_mint()` helper calls `ec.hkdf_internal_principal(secret.encode('utf-8'))` and `ec.internal_principal_encrypt(...)` — these are PyO3 bindings to the same Rust crate code. So Python's test does not load a separate Python implementation of HKDF+JWE; it exercises the Rust implementation through the PyO3 FFI layer. The vector proves the key derivation step produces the pinned hex; the round-trip tests prove encrypt/decrypt are inverses.

**The key insight:** Three runtimes, one truth table. The JSON files in `tests/vectors/` are the only place where the expected byte output lives. Every runtime that touches these cryptographic operations is responsible for loading the same file and reproducing the same bytes. A change to any implementation that alters the output — even a benign refactor — will fail at least one of these three test suites, and that failure is the signal to update the vector with a new authoritative output (after reviewing whether the change was intentional and backward-compatible with tokens already in the wild).

---

