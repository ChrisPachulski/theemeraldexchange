
---

# Teaching Dossier: Language Bindings — emerald-contracts-napi & emerald-contracts-pyo3

---

## 1. WHAT

The emerald-contracts crate is a Rust library that owns the canonical implementations of security-critical operations for the whole system: HKDF key derivation, stream-token signing/verification, device token encrypt/decrypt, internal-principal JWE, sub-namespace parsing, and PII scrubbing. Because the rest of the project is written in TypeScript (the Node/Hono backend) and Python (the recommender), two "binding" crates translate that single Rust implementation into forms each language can call directly. `crates/emerald-contracts-napi` uses napi-rs to produce a `.node` binary — a native extension that Node.js loads like a regular `require()`. `crates/emerald-contracts-pyo3` uses PyO3 + maturin to produce a `.whl` Python wheel — a compiled extension that the recommender can `import emerald_contracts` like any other Python package. Neither binding reimplements any logic: every function in both files immediately delegates to the same `emerald-contracts` crate functions, so the cryptographic output from TypeScript and Python is byte-identical to what Rust produces directly.

---

## 2. WHY

**Why not just reimplement the crypto in TypeScript and Python?**
Because "reimplemented" means "a second opinion on the spec" — two independent implementations of HMAC-SHA256 or HKDF will diverge in subtle ways (salt handling, output length, encoding) before the first production incident. Every divergence is a silent interoperability bug that only surfaces when one side mints a token the other can't verify. The Rust implementation is the contract; the bindings are wires to that contract, not copies of it.

**Why not run the Rust code as a microservice and call it over HTTP?**
You could — but you'd be adding a network hop, a serialization round-trip, and a new service to deploy, health-check, and keep alive, for operations that take microseconds. HKDF-Expand over a Unix socket is still faster than HKDF-Expand over localhost HTTP, and either is strictly worse than a native function call in-process. The binding approach gives you zero-copy access (Node `Buffer` maps directly to Rust `&[u8]`; Python `bytes` does too) with no serialization layer and no network failure mode.

**Why is the PyO3 surface narrower than the napi surface?**
Because the contract is about what each consumer actually needs. The recommender never mints device tokens or stream tokens — Hono does. Conversely, the recommender IS the verifier for internal-principal JWEs (Hono mints them, recommender checks them), so that decrypt surface lives in PyO3 but not napi. Each binding is sized to its consumer's trust boundary, not to the full crate API.

---

## 3. MAP

### napi binding (Node/TypeScript)

```
crates/emerald-contracts-napi/
  Cargo.toml          — declares crate-type = ["cdylib"]; depends on napi 2.16 + napi-derive 2.16
  build.rs            — one-liner: napi_build::setup() wires the napi link flags at compile time
  src/lib.rs          — all #[napi] and #[napi(object)] annotations; the entire public surface
  index.d.ts          — hand-authored TypeScript declarations (napi-rs v3 CLI doesn't emit for 2.16 crates)
  index.js            — hand-authored platform-resolving loader: picks the right .node file per OS/arch
  package.json        — "main": "index.js", "types": "index.d.ts"; prepare script; napi targets list
  crates/emerald-contracts-napi/scripts/build-with-dts-guard.mjs — wraps `napi build`; snapshots index.d.ts before build, restores after
  emerald-contracts-napi.darwin-arm64.node — compiled binary for macOS Apple Silicon (checked in)
```

**Build flow:**
1. `cargo build --release` compiles `src/lib.rs` to a `.so`/`.dylib`/`.dll` (crate-type cdylib).
2. `napi build --platform --release` (via napi-rs CLI) renames that artifact to the platform-tagged `.node` file, e.g. `emerald-contracts-napi.darwin-arm64.node`.
3. `build-with-dts-guard.mjs` wraps step 2: it saves `index.d.ts` before the build, then restores it if the CLI touched it.
4. `index.js` at runtime does `require('./emerald-contracts-napi.darwin-arm64.node')` (choosing the right triple), which is a standard Node native module load.

**Distribution to the backend:**
The root `package.json` lists `"@emerald/contracts-napi": "file:./crates/emerald-contracts-napi"`. This is a `file:` workspace dependency — not an npm registry package. When you run `npm ci` at the repo root, npm resolves this path, enters the package directory, and runs its `prepare` script. The prepare script checks if a `.node` binary already exists; if so, it exits 0 immediately (no compile). If not, it runs `build-with-dts-guard.mjs`. The `.node` binary is committed to the repo, so a normal `npm ci` never recompiles.

**Backend import:**
`server/services/contractsBinding.ts` imports from `@emerald/contracts-napi`; other server files (`session.ts`, `internalPrincipal.ts`, etc.) import from that service. TypeScript sees the hand-authored `index.d.ts` for type checking; at runtime Node loads the `.node` binary.

### pyo3 binding (Python)

```
crates/emerald-contracts-pyo3/
  Cargo.toml          — crate-type = ["cdylib"]; lib.name = "emerald_contracts"; pyo3 0.28 + abi3-py312
  pyproject.toml      — build-system: maturin>=1.7,<2.0; module-name = "emerald_contracts"
  src/lib.rs          — all #[pyfunction] + #[pymodule] annotations; narrower surface than napi
```

**Build flow:**
1. `maturin build --release -m crates/emerald-contracts-pyo3/Cargo.toml --out /wheels` compiles the crate and packages it as an abi3 wheel (compatible with CPython 3.12+).
2. The wheel filename encodes the target: `emerald_contracts-0.1.0-cp312-abi3-linux_aarch64.whl`.
3. `pip install /wheels/*.whl` installs it into the Python environment; after that `import emerald_contracts` works.

**Distribution to the recommender (Docker multi-stage):**
`recommender/Dockerfile` (lines 14–55) uses a two-stage build:
- **Stage 1 (rust-builder):** starts from `rust:1.96-slim-bookworm`, installs python3 + maturin, copies the full workspace source (all crates must be present for Cargo workspace resolution), runs `maturin build`, drops the wheel into `/wheels`.
- **Stage 2 (runtime):** starts from `python:3.12-slim`, copies `/wheels` from stage 1, runs `pip install /wheels/*.whl`. Now `import emerald_contracts` works in any Python process in that image.

**Python import:**
`recommender/app/internal_principal.py` and `recommender/app/sub_validation.py` both do `import emerald_contracts as _ec` inside a try/except — if the wheel isn't installed (e.g., running outside Docker without `maturin develop`), the module degrades gracefully with a warning log rather than crashing at import time.

---

## 4. PREREQUISITES

**Compiled vs. interpreted languages (eli5):**
When you write Python, the computer doesn't run your text directly. Python reads your file, translates it to a simpler internal form, and interprets that form instruction by instruction while the program runs. TypeScript is similar — it gets compiled to JavaScript, which Node.js then interprets. "Interpreted" buys you fast iteration (change a file, run it immediately) but pays a runtime cost for the translation work.

Rust is a compiled language. Before your program runs at all, a compiler reads every file and produces machine code — raw CPU instructions the processor executes directly, with no interpreter in the loop. This is why Rust is fast: there's nothing between your code and the hardware.

A **native binding** (or FFI — Foreign Function Interface) is a bridge between these two worlds. The compiled Rust code is packaged as a `.so` / `.dylib` / `.dll` (a shared library), and the interpreted language loads that binary and calls into it using a C-compatible calling convention that both sides agree on. From the JS/Python caller's perspective it looks like a regular function call; inside the binary, it's Rust running at full compiled speed.

**napi-rs** is a framework that automates writing that bridge for Node.js. You annotate Rust functions with `#[napi]` and it generates the glue code that maps JS types (`Buffer`, `string`, `number`) to Rust types (`&[u8]`, `String`, `u32`) and handles memory ownership across the boundary.

**PyO3** does the same thing for Python. `#[pyfunction]` annotates Rust functions, and PyO3 maps Python types (`bytes`, `str`, `dict`) to Rust types. **maturin** is the build tool that compiles the crate and packages the resulting `.so` into a `.whl` (Python wheel) that `pip install` can consume.

---

## 5. GOTCHAS & WAR STORIES

### The dts-clobber bug (fix 1ae47c0)

**What happened:** The napi-rs v3 CLI (`@napi-rs/cli`) is designed for napi-rs 3.x crates, which auto-generate their TypeScript declarations. When invoked against a napi 2.16 crate (which doesn't generate declarations), the CLI still runs its `.d.ts` output phase — but since there's nothing to emit, it writes an empty file. The `index.d.ts` that CI was checking against was the hand-authored one. After any `napi build` invocation, that file became 0 bytes. TypeScript then saw 0 exported symbols and emitted `TS2306: File 'index.d.ts' is not a module`.

**Why it was sneaky:** The build _succeeded_. The `.node` binary was correct. Only the TypeScript type-check phase failed, and only on a CI cold run where `napi build` actually executed. Local dev machines that already had the built binary skipped `prepare` entirely and never saw it.

**The fix:** `crates/emerald-contracts-napi/scripts/build-with-dts-guard.mjs` wraps every `napi build` invocation. It reads and buffers the existing `index.d.ts` before the build. After the build, it compares byte-for-byte: if the file was deleted, truncated, or rewritten (even to _more_ bytes — a future CLI version might emit its own stub), the wrapper restores the snapshot. The length-only check was not enough because a CLI that emits its own longer stub would still clobber the hand-authored contract.

**The `file:` dependency triggers `prepare` on every `npm ci`:** Because `@emerald/contracts-napi` is a `file:` path dependency (not a registry package), npm treats it as a local workspace member and runs its lifecycle scripts — including `prepare` — every time you do `npm ci`. If the `.node` binary were not committed to the repo, every developer and every CI run would trigger a Rust compile. The prepare script guards against this: `fs.readdirSync('.').some(f => f.endsWith('.node'))` — if any `.node` file exists in the crate directory, it exits immediately with code 0. The binary IS committed, so normal installs are always fast.

**Docker base lacking `scripts/`:** Inside the backend Dockerfile's build stage, the full workspace is not necessarily copied before `npm ci` runs. The prepare script tries to execute `node crates/emerald-contracts-napi/scripts/build-with-dts-guard.mjs` — but if `scripts/` wasn't COPYed into that layer, the script path doesn't exist and `require('child_process').execSync(...)` throws. The prepare script's inline form (the one-liner in `package.json`) handles this with `try/catch`: if the build script fails for any reason (including missing scripts/), it logs a non-fatal warning and exits 0. The `.node` check before even attempting the build means Docker images that COPY the committed binary skip the compile entirely.

---

## 6. QUIZ BANK

**Q1.** The recommender imports `emerald_contracts` but the `.whl` is not installed. What happens, and why was the code written that way instead of crashing loudly?

**A1.** The `import emerald_contracts as _ec` is inside a `try` block in both `sub_validation.py` and `internal_principal.py`. If the import fails (wheel not present), a warning is logged and the module falls back to a pass-through mode (sub validation is skipped, internal-principal mode degrades to `off`). This was an intentional design: local development without the full Rust toolchain should still be possible for people working on the Python recommender logic. The cost is that missing-wheel failures are silent in non-enforcing deployments — which is why the Dockerfile goes to the trouble of building and installing the wheel in a separate stage.

**Q2.** `hkdf_session` is exposed in BOTH the napi and pyo3 bindings, and both call `ec_derive_key(secret, INFO_SESSION)`. If you call `hkdf_session(secret)` from TypeScript and from Python with the same `secret`, will the bytes match?

**A2.** Yes, exactly — and that guarantee is the whole reason for the binding architecture. Both bindings call the _same_ Rust function `emerald_contracts::derive_key` with the _same_ `INFO_SESSION` constant. There is no parallel implementation. The output bytes are identical regardless of which language called it, which is what makes session keys derived in the backend readable by the recommender (and vice versa).

**Q3.** A new engineer wants to add a `stream_token_sign` function to the PyO3 binding so the recommender can mint stream tokens. The Rust function already exists in `emerald-contracts`. What are the mechanical steps, and what architectural question should they ask first?

**A3.** Mechanical: add a `#[pyfunction] fn stream_token_sign(...)` in `crates/emerald-contracts-pyo3/src/lib.rs`, import the `stream_token` module from the `ec` crate, map Python types to Rust types, and add `m.add_function(wrap_pyfunction!(stream_token_sign, m)?)?` to the `#[pymodule]` init. Then rebuild the wheel (`maturin develop --release` locally; the Dockerfile rebuilds it on next image build). The architectural question: should the recommender be minting stream tokens at all? The comment at the top of the pyo3 `lib.rs` explains that stream tokens are a "Hono/media-core concern" deliberately excluded from the Python surface. Adding it here would violate that trust boundary — the recommender is a consumer of session context, not an issuer of media access tokens. Raise the question before writing the code.

**Q4.** Why is `crate-type = ["cdylib"]` required in both `Cargo.toml` files, and what would happen if you changed it to `["lib"]`?

**A4.** `cdylib` tells the Rust compiler to produce a C-compatible dynamic library (`.so` on Linux, `.dylib` on macOS, `.dll` on Windows). This is the artifact format that both Node.js `require()` and Python's import system know how to load as a native extension. If you used `["lib"]` instead, Cargo produces a Rust-only static library (`.rlib`) — it can be linked into other Rust crates but cannot be loaded by Node or Python. The build would succeed but no `.node` or `.so` Python extension would be produced.

**Q5.** The `build-with-dts-guard.mjs` script checks `buf.length < 128` to detect a previous clobber. Why is 128 the threshold, and why does it then try `git checkout -- index.d.ts` before snapshotting?

**A5.** 128 bytes is a heuristic: a legitimately hand-authored `.d.ts` file with even one exported function will be longer than 128 bytes (the actual file is ~3.5KB). A 0-byte or near-zero file means either a prior clobber or an empty stub. The `git checkout` before snapshotting is the key insight: if a previous build already clobbered the file (e.g., developer ran `napi build` directly without the guard), the guard would snapshot the _clobbered_ (empty) version and restore that same clobbered version after the next build — permanently losing the hand-authored content. By restoring from git first, the guard always operates against the committed contract, not whatever state the working copy happens to be in.

**Q6.** The PyO3 binding uses `abi3-py312` in its Cargo.toml. What does that mean for which Python runtimes can load the wheel, and why does it matter for a Docker image?

**A6.** `abi3` (also called the "stable ABI") is a subset of the CPython C API that is guaranteed not to change across minor versions. With `abi3-py312`, the wheel is compiled against the 3.12 stable ABI and will load on CPython 3.12, 3.13, 3.14, and any future 3.x without recompilation. This matters enormously for Docker: without abi3, you'd produce a wheel tied to exactly one Python minor version (e.g., `cp312-cp312-linux_aarch64.whl`) and it would break silently when the base image is upgraded from `python:3.12` to `python:3.13`. With abi3, the same wheel works across the version bump.

---

## 7. CODE-READING EXERCISE

**File: `crates/emerald-contracts-napi/src/lib.rs`**

This is the entire napi binding — 332 lines that expose ~20 functions. It's a good file to read carefully because every napi binding in any project follows the same structural pattern.

**Step 1 — Read the top comment (lines 1–6).** The module doc tells you the contract in one sentence: "Hono imports this via `require('@emerald/contracts-napi')` and calls the exposed functions instead of `jose.EncryptJWT` / `node:crypto.createHmac`." Before reading any code, you know the consumer, the import path, and what was replaced.

**Step 2 — Look at the imports (lines 10–18).** Two groups: `napi::bindgen_prelude::*` and `napi_derive::napi` are the framework glue. Everything from `emerald_contracts::` is the actual logic being wrapped. Notice that `lib.rs` does not implement any algorithm itself — every function body is a thin delegation.

**Step 3 — Read one simple function: `hkdf_session` (lines 30–35).** This is the smallest possible napi binding. The `#[napi]` attribute tells napi-rs to generate the JS/C bridge for this function. `Buffer` on the Rust side is napi-rs's type that maps to Node's `Buffer`. The function calls `ec_derive_key(secret.as_ref(), INFO_SESSION)`, converts the `[u8; 32]` result to a `Vec<u8>`, wraps it in the `DerivedKey` struct, and returns. The `#[napi(object)]` on `DerivedKey` (line 24) tells napi-rs to expose the struct as a plain JS object `{ bytes: Buffer }`.

**Step 4 — Read a more complex function: `stream_token_verify_dual_key` (lines 137–148).** Note that `Result<T>` in napi-rs maps to a JS exception on the TypeScript side — if the Rust function returns `Err(...)`, napi-rs throws. The `format!("{:?}", e)` converts a Rust error enum to a string for the JS error message.

**Step 5 — Compare to the pyo3 `parse_sub` (pyo3 `src/lib.rs` lines 60–72).** The same logical operation in PyO3 returns a `Bound<'py, PyDict>` — a Python dictionary. There's no `SubJs` struct here (unlike the napi side's `SubJs`); instead, PyO3 builds a dict at the boundary. Both bindings call `ec_parse_sub(s)` from the same Rust crate. This is the clearest illustration of the architecture: same logic, different type mappings for different language runtimes.

**Step 6 — Look at `index.js` (in the napi crate).** This hand-authored loader is what Node.js executes when your TS file does `import { hkdfSession } from '@emerald/contracts-napi'`. It pattern-matches `process.platform` and `process.arch` to build a list of candidate triple strings, then tries `require('./emerald-contracts-napi.<triple>.node')` for each. The first one that doesn't throw becomes `module.exports`. The error message if all fail tells you exactly what to do: `npm run build -w @emerald/contracts-napi`.

**What to notice:** `index.js` and `index.d.ts` are entirely hand-authored because napi-rs v3 CLI doesn't generate them for napi 2.16 crates. This means if you add a new `#[napi]` function to `src/lib.rs`, you must also add its TypeScript declaration to `index.d.ts` manually. The build does not catch omissions — TypeScript will simply not know the function exists, and callers will get a type error saying the export doesn't exist.

---

## See also

For the boundary traced end-to-end — the three marshalling DTOs (`DerivedKey`,
`StreamClaimsJs`, `DualKeyVerifyResult`) as a set, the mint→header→verify→route
request flow, the TS-mints/Rust-verifies asymmetry, and the enforcement call sites —
see [`docs/architecture/internal-auth-boundary.md`](../../architecture/internal-auth-boundary.md).
This module teaches the *binding mechanism*; that doc maps the *whole trust boundary*.

---

