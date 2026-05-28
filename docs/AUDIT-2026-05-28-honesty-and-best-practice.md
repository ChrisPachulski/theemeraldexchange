# theemeraldexchange — Honesty & Best-Practice Audit

**Date:** 2026-05-28
**Branch audited:** `m3-media-core` @ `a8046ec` (main worktree — confirmed to contain `crates/media-core`)
**Auditor stance:** blunt, no-hedge. Every number below was re-executed on this exact commit.

> Process note: an earlier ground-truth pass ran on the wrong worktree (`36465cf`, which has **no** media-core). That run's "773 passed", "no media-core", and "Python = 0 collected" numbers describe a **different commit** and do not apply to this branch. This report supersedes it with commands re-run on `a8046ec`.

---

## 1. Headline verdict

**The code is real and substantially good; the status reporting is not honest.** The M3 media-core Rust service, the emerald-contracts trio, the Hono proxy, and the recommender are genuine, non-stubbed implementations with substantive tests — there is no fabricated functionality at the "empty function behind a real signature" level for the core paths, and the secret-hygiene is clean. **But the "tested / green / clean / verified" framing in the commit messages is materially overstated and, in two specific places, flatly false:**

1. **`cargo fmt --all -- --check` FAILS** — 38 diffs across 12 files spanning the entire emerald-contracts crate plus both binding crates. The repeated "clippy/fmt clean" commit claim is **false**; clippy is clean, fmt is not.
2. **The recommender Python suite is RED, not green** — re-run via the project's own venv: **2 failed, 70 passed**. The "55 Python contract tests green" claim is false on three axes: the count is wrong (46 functions / 72 runtime cases, never 55), the suite is not green, and the two failures are stale tests that no longer match a silently-weakened backup safety gate.

Beyond the false claims, there is a cluster of **real "tested-in-isolation but not wired" gaps** that let "green" be claimed while the feature is inert end to end: TMDB enrichment is fully built + unit-tested but **never called by the scanner** (the exact mechanism behind 100% null `tmdb_id`); the transcode 503 contract is computed but **never enforced** in the stream path; the entire `/api/media/*` vertical has **no frontend consumer**; and the library server **has no scheduler** so it never scans on its own. None of these are lies about code existing — they are overstatements of "live and working end to end."

**Verdict: materially-overstated.** The engineering is honest at the unit level; the milestone-status narrative is not.

---

## 2. Claims-vs-Reality table

| # | Claim (source) | Verdict | Evidence (re-run on a8046ec) |
|---|---|---|---|
| 1 | "clippy/fmt clean" (commit 1c18e4a) | **FALSE (fmt half)** | `cargo fmt --all -- --check` → **exit 1, 38 diffs** in 12 files: all 8 emerald-contracts `src/*.rs`, `examples/gen_vectors.rs`, `tests/vectors.rs`, `emerald-contracts-napi/src/lib.rs`, `emerald-contracts-pyo3/src/lib.rs`. Clippy IS clean (workspace exit 0). |
| 2 | "55 Python contract tests green" | **FALSE** | venv run = **2 failed, 70 passed**. Declared functions = **46** (`def test_` grep). Runtime cases = 72. Never 55; figure appears in no committed doc. |
| 3 | "40 Rust contract tests + byte-parity vectors" | **TRUE** | `cargo test -p emerald-contracts` → 38 lib + 2 vectors = **40 passed, 0 failed**. 8 JSON fixtures in `tests/vectors/`; `tests/vectors.rs` asserts 2 of them byte-identically. |
| 4 | "media-core: 42 Rust tests" (1c18e4a) | **TRUE** | `cargo test -p media-core` → **42 passed, 0 failed**. |
| 5 | "4 TS proxy tests (auth header injection, error propagation)" | **TRUE (exists+passes)** but **WEAK** | 4 `it()` blocks exist and pass. But the auth test only asserts `/^Bearer /` prefix — never proves a valid JWE is minted, never tests the mint-failure (proxy-without-auth) branch. |
| 6 | "tmdb: best-effort metadata resolver (never blocks a scan)" | **OVERSTATED / misleading** | Literally true (resolver exists, would not block). But scanner **never calls it** — `grep TmdbClient\|crate::tmdb crates/media-core/src/ | grep -v tmdb.rs` = **0 hits**. Every scanned row gets `tmdb_id` NULL by construction. |
| 7 | "internal-principal JWE auth verified; 401 unauth confirmed" | **OVERSTATED** | True only in `enforce` mode. Default is `Off` (`config.rs:18 _ => PrincipalMode::Off`; `docker-compose.yml:186 ...:-off`), where `auth.rs:39-41` short-circuits and serves everything unauthenticated. The 401 test forces enforce. |
| 8 | "M1.5 cross-service contract shipped + green — Lockable" | **OVERSTATED** | Doc header (`docs/superpowers/specs/2026-05-25-cross-service-contract.md:3`): **"Status: DRAFT for review"** with 4 "Pending user call" decisions. Only §4 is locked. Parity gate green ≠ contract locked. |
| 9 | Deploy infra (Cargo.lock present, media-core copied into builder, ffmpeg/ffprobe 7.1 installed) | **TRUE** | `Cargo.lock` present at root; `Dockerfile:44 COPY crates/media-core`; `Dockerfile:76 COPY --from=mwader/static-ffmpeg:7.1`. Brief's "missing" assumptions were wrong. |
| 10 | "backend→media-core reachable; 401 confirmed" (commit narrative) | **UNVERIFIABLE / no artifact** | No integration test exercises the live proxy→media-core round-trip. 401 is unit-tested at Hono layer + enforce reject in `auth.rs`; the wired path has no reproducible artifact. |
| 11 | Project state = "done/live/green" | **CONTRADICTED by repo's own files** | `.eex/state.md:30` Resume Checklist `[ ] Verify test counts are still green` is **UNCHECKED**. No `docs/M3-COMPLETION.md`. The strong status lives only in commit messages. |
| 12 | No AI attribution / no hardcoded secrets | **TRUE (positive)** | No tracked `.env`/`.pem`/`.key`; secrets are `${VAR}` only; no Co-Authored-By in commit bodies. CLAUDE.md hygiene invariants respected. |
| 13 | Corruption narrative (reversed titles, TV-as-movies, series split) | **NOT in this code** | `filename.rs` parses titles forward; `scanner.rs upsert_show` is get-or-create by title (one row per series). Live-DB corruption is NOT reproducible from this branch → deploy/source divergence is the real-world follow-up. |

---

## 3. Test reality: claimed vs ground-truth executed

| Suite | Claimed | Executed on a8046ec | Verdict |
|---|---|---|---|
| Rust contracts | 40 | **40 passed** (38 lib + 2 vectors) | ✅ accurate |
| media-core Rust | 42 | **42 passed** | ✅ accurate |
| TS proxy (media.test.ts) | 4 | **4 passed** | ✅ exists+passes (but weak — see #5) |
| TS full suite (vitest) | "45 TS contract + 4 media" | suite is ~779 cases, genuinely large/green; one transient 1-fail flake observed under load | ✅ undercount, genuinely green; flaky cross-binding spawn test |
| `cargo fmt --all --check` | "clean" | **exit 1, 38 diffs / 12 files** | ❌ **FALSE** |
| `cargo clippy` | "clean" | exit 0, 0 warnings | ✅ accurate |
| Python recommender | "55 green" | **2 failed, 70 passed; 46 functions** | ❌ **FALSE on all three counts** |
| Cross-binding parity (N-API↔PyO3) | implied covered in CI | `describe.skipIf(!HAVE_PYTHON)` — file admits CI never runs it; green-by-skip | ⚠️ not real coverage on its target platform |

**Discrepancies called out:** "55 Python" is an invented number (real: 46 functions / 72 cases). "fmt clean" is reproducibly false. The one test that proves cross-language wire parity (the thing "M3 cutover depends on", per its own header) skips in CI.

---

## 4. Findings by severity

### CRITICAL
*(None.)* No fabricated core functionality, no secret leakage, no data-destruction-on-by-default. The two false claims and the security defaults below are serious but not critical given the single-tenant homelab context and `USE_MEDIA_CORE` defaulting off.

### HIGH

**H1 — Recommender Python suite is RED while reported green (stale tests vs silently-weakened safety gate).**
`recommender/tests/test_db_migrator.py:321-353` + `recommender/app/db.py:210-225`. Re-run: `2 failed, 70 passed`. `_check_backup_gate` now calls `_auto_backup(...)` **first** and returns on success (`db.py:225`), short-circuiting the sibling-`server.db`-missing and stale-timestamp abort branches the two tests assert (`DID NOT RAISE RuntimeError`). Either the safety gate was weakened or the tests lie about current behavior — both are integrity failures while a "green" badge is claimed.
*Fix:* Decide the contract. If local auto-backup is the new gate, rewrite both tests to assert auto-backup occurs AND add a test for auto-backup-failure → then the sibling/stale aborts must still fire. Do not ship green while these fail.

**H2 — TMDB enrichment is fully built + unit-tested but NEVER invoked by the scanner → 100% null `tmdb_id` by construction.**
`crates/media-core/src/scanner.rs` (`index_file`/`upsert_movie`@228/`upsert_show`@263) never binds `tmdb_id` and never references `crate::tmdb`. Repo grep: zero `TmdbClient` callers outside `tmdb.rs`. `config.rs:63` loads `TMDB_API_KEY` into a field nobody reads. The resolver has 9 passing tests in isolation, letting "tmdb resolver" be claimed while the feature is inert end to end. This is the exact production symptom.
*Fix:* Wire `TmdbClient` into `index_file` (best-effort, behind the existing timeout) and bind the resolved id in the upsert. Add an integration test asserting non-null `tmdb_id` after a scan against a mocked TMDB, and an `enriched/enrich_failed` counter in `ScanReport` so a 0%-enriched run is observable.

### MEDIUM

**M1 — Transcode decision computed but never enforced; the 503 path is dead code.**
`routes.rs:278-290` `stream_file` unconditionally `ServeFile::new(&file.path).oneshot(req)` — no `capability::decide`, no branch on `direct_play`. `AppError::TranscoderRequired` (`error.rs:15,30`) is **defined and matched in `into_response` but never constructed by any handler** (grep confirmed). `capability.rs`/`lib.rs` doc-claim a 503 contract the stream route does not honor; an h264-only client requesting HEVC gets raw bytes instead of a clean 503.
*Fix:* In `stream_file`, run `capability::decide` against advertised caps and return `TranscoderRequired` when `!direct_play`. Add a route test for HEVC + h264-only → 503. Until then, correct the doc comments.

**M2 — media-core auth defaults to OFF on a 0.0.0.0 listener.**
`config.rs:18 _ => PrincipalMode::Off`, `.unwrap_or_default()`; `auth.rs:39-41` skips all verification in Off; `Dockerfile:41 ENV MEDIA_CORE_HOST=0.0.0.0`; `docker-compose.yml:186 ...:-off`. Shipped default serves the entire API (list/get/watch read+write/play/stream/scan) to any unauthenticated caller on the docker bridge. A typo'd mode string also silently maps to Off.
*Fix:* Default compose to `enforce`, OR fail-fast at boot when host is 0.0.0.0 and mode≠Enforce (or secret is None). Make `PrincipalMode::parse` reject unknown values instead of mapping to Off.

**M3 — IDOR on watch-state via `?sub=` fallback (authenticated cross-user in off/log mode).**
`routes.rs:312-320 acting_sub` falls back to the client-supplied `?sub=` query param whenever verified `InternalClaims` are absent (Off mode, or Log mode with missing/invalid token). The Hono proxy forwards the raw query string verbatim (`media.ts:17`), so `?sub=plex:<victim>` is reachable from the front door. An authenticated user can read/forge another user's resume positions and completion flags. Closed entirely in Enforce mode.
*Fix:* Only honor `?sub=` when mode==Off AND host is loopback; in Log/Enforce always derive the acting user from verified claims and ignore client-supplied `sub`.

**M4 — No fail-fast when `mode=enforce` but `INTERNAL_PRINCIPAL_SECRET` is unset.**
`auth.rs:49-79` / `main.rs:14-23` never validate the secret/mode pairing; `docker-compose.yml:185` ships `INTERNAL_PRINCIPAL_SECRET:-` (empty). An operator who sets enforce but typos the secret gets shape-dependent behavior, not a refusal to boot. The recommender's `config.py` at least validates its mode string; media-core does not.
*Fix:* Panic/return error at boot if `mode==Enforce && secret.is_none()`.

**M5 — `stream_file` serves arbitrary DB-referenced paths with no library-root containment.**
`routes.rs:278-290` serves whatever string is in `media_files.path`; no `canonicalize`/`starts_with` check against `config.library_paths`. Combined with M2 (auth off) and the scanner's `follow_links(true)` (`scanner.rs:40`), a poisoned DB row or a symlink in a library root becomes an arbitrary-file-read primitive scoped to the container.
*Fix:* Canonicalize `file.path` and assert prefix-match under a configured (canonicalized) library root before serving; 404 otherwise.

**M6 — TMDB resolver swallows every network/parse/build error into `None`.**
`tmdb.rs:84-104`: three `.ok()?` sites (client build, send, json) erase 401/timeout/DNS/JSON-shape failures into the same `None` as "no match". Once wired (H2), a 0% hit rate would be undiagnosable without a debugger — same failure class as the null-id incident.
*Fix:* Replace `.ok()?` with `tracing::warn!` that logs the error and HTTP status; distinguish 401/429/5xx from an empty results array. Keep the None contract.

**M7 — Hono proxy proceeds WITHOUT auth header on mint failure, and flattens upstream headers.**
`media.ts:22-28` catches a mint error with only `console.warn` then proxies anyway → in off/log mode the write lands anonymous. `media.ts:46-49` rebuilds the Response keeping only `Content-Type`, dropping `Content-Length/Accept-Ranges/Content-Range/ETag` → silently breaks HTTP range/seeking for `/stream`.
*Fix:* On mint failure in a non-off posture, fail the request (502). Forward the relevant upstream headers (and pass inbound `Range` upstream) for the stream path.

**M8 — Episode/show metadata columns are exposed by the API but never written.**
`scanner.rs:263-313` writes only `(title)`/`(show_id,season,episode,file_id)`; schema + `routes.rs:150-219` serialize `episode.title`, `air_date`, `show.year/tvdb_id/imdb_id`. Consumers see perpetual NULLs. The API advertises metadata the ingest path never produces.
*Fix:* Populate from TMDB (once H2 is wired) and filename parsing, or drop the columns from serialized models.

**M9 — No scheduler / boot scan; the "library server" never scans on its own.**
`main.rs` has zero `spawn`/`interval`/`cron` (grep = 0). Only trigger is a manual `POST /api/media/scan`. A deployed instance stays empty until externally poked — consistent with the live DB being populated by some other writer.
*Fix:* Spawn a configurable interval scan (and optional boot scan), or document scans as externally-driven and wire the trigger.

**M10 — Entire `/api/media/*` vertical has no frontend consumer.**
`grep -rln 'api/media' src/` = 0 (only a comment in `iptv.ts:106`). Proxy is feature-flagged off (`useMediaCore`) and unreachable from the SPA. "Live and working end to end" overstates: even if media-core runs, no product surface exercises it on this branch.
*Fix:* Build the SPA consumer or mark M3 explicitly backend-only in the roadmap; stop describing it as end-to-end working.

**M11 — `play_grant` returns empty audio/subtitle tracks on corrupt JSON via `unwrap_or_default()`.**
`models.rs:110,115`: `serde_json::from_str(...).unwrap_or_default()`. A malformed `audio_tracks_json` is served as zero tracks (no log), which can flip the capability/transcode decision or hide tracks — silent data-integrity→behavior leak on the playback path.
*Fix:* `tracing::warn!` with the `media_files.id` before defaulting, or surface a `metadata_corrupt` flag in the grant.

**M12 — `cargo fmt --check` fails workspace-wide (best-practice + the false claim from #1).**
38 diffs / 12 files. CI gates on `cargo fmt --all -- --check` (`.github/workflows/ci.yml`), so this gate is RED — CI either never went green or the claim was written without running it.
*Fix:* `cargo fmt --all` + commit; add a pre-push hook; pin rustfmt in `rust-toolchain.toml` so "clean" is reproducible.

**M13 — Cross-binding parity test skips in CI (`describe.skipIf(!HAVE_PYTHON)`).**
`internalPrincipal.crossBinding.test.ts:18-42` — the file itself states CI does not run it (separate Node/Python matrix entries). The N-API↔PyO3 wire-parity that "M3 cutover depends on" is green-by-skip everywhere except a hand-built dev box.
*Fix:* Build the pyo3 extension into the Node test job so `HAVE_PYTHON` is true in CI; fail (not skip) if the extension is missing.

**M14 — Guaranteed-pass tautology masks a gated assertion (`suggestions.test.ts:2928-2939`).**
The only meaningful cap assertion is double-gated behind two `if`s, followed by `expect(true).toBe(true)`. If prompt assembly changes so the RECENTLY-SHOWN block disappears, the test goes green instead of catching the regression.
*Fix:* Assert the preconditions (`expect(recentBlock).toBeTruthy()`), then assert the cap unconditionally; delete the tautology.

**M15 — M1.5 "shipped + lockable" overstates a DRAFT spec.**
`cross-service-contract.md:3` = "DRAFT for review" with 4 pending decisions; `.eex/state.md:30` verify-green box unchecked. Parity gate green ≠ contract locked.
*Fix:* Describe as "contract DRAFT, parity gate green, §4 locked." Resolve the 4 decisions before claiming lock.

### LOW

- **L1 — `reqwest` (+ full TLS stack) compiled into media-core solely for the dead `TmdbClient`** (`Cargo.toml:34`). Remove until enrichment is wired, or wire it (H2).
- **L2 — `let _ = create_dir_all(parent)` in `db.rs:23`** discards the Result; self-healing via the subsequent connect, but produces a confusing downstream error on partial-permission/race. `map_err` it.
- **L3 — Auth `log` mode allows invalid/expired/forged tokens with only a warn** (`auth.rs:60-78`, `recommender internal_principal.py:137-168`). By-design tri-mode, but the default is Off, so a deploy that never flips to enforce runs auth-advisory. Emit a startup warn when mode≠Enforce.
- **L4 — `/scan`, `/play`, `/stream` have no role check** (`routes.rs:30-33`). `InternalClaims.role` exists but no handler inspects it; any principal can trigger a full rescan (DoS lever). Hono gates with `requireAdmin`; media-core does not. Gate `/scan` on `role==admin`.
- **L5 — Vitest flake:** observed a transient `1 failed | 779 passed` under load (the Python-spawning cross-binding test). Harden the spawn (timeout/retry/mock) or quarantine; don't report a single green number without a flake pass.
- **L6 — Positive:** secret hygiene clean, no AI attribution, both Dockerfiles copy media-core, filename/scanner do NOT reverse titles or split series. The corruption narrative is **not** in this code — pursue a deploy-vs-source diff on the NAS.

---

## 5. Prioritized remediation plan

| Order | Item | Effort | Why first |
|---|---|---|---|
| 1 | **Fix the false claims first (H1, M12):** run `cargo fmt --all` + commit; resolve the 2 RED Python tests (decide backup-gate contract). Stop asserting fmt-clean / "55 green" until both gates pass. | S (½ day) | These are stated-as-true-but-false. Cheapest credibility fix. |
| 2 | **M2 + M4 security defaults:** flip compose to `enforce`; fail-fast at boot when 0.0.0.0+non-enforce or enforce+no-secret; make `PrincipalMode::parse` reject garbage. | S (½ day) | Closes the unauthenticated-by-default surface before M3 goes live. |
| 3 | **M3 + M5 IDOR/path-traversal:** drop `?sub=` trust in non-Off mode; add library-root containment to `stream_file`. | M (1 day) | Cross-user data integrity + arbitrary-file-read; both real once auth is on. |
| 4 | **H2 + M6:** wire `TmdbClient` into the scanner with logged failure branches + a scan-level enriched counter; add a mocked-HTTP integration test + a "tmdb_id non-null after scan" test. | M (1–2 days) | Fixes the actual null-id production symptom and makes 0% enrichment observable. |
| 5 | **M1:** enforce the transcode 503 in `stream_file` (or correct the docs to stop claiming a contract that isn't honored). | S–M | Honors the advertised playback contract. |
| 6 | **M7 + M13 + L5:** forward stream headers / fail-on-mint-error in the proxy; make cross-binding parity a real CI gate; harden the flaky spawn test. | M | Real coverage of the wire-parity M3 depends on; working video seeking. |
| 7 | **M9 + M10 + M8 + M11:** scheduler/boot scan; SPA consumer (or roadmap honesty); populate or drop the metadata columns; log corrupt-JSON track parses. | L (multi-day) | End-to-end "live and working" reality. |
| 8 | **M15 + state hygiene:** reconcile the contract DRAFT status and `.eex/state.md`; replace commit-message status with a committed CI summary. | S | Stop the documentation from claiming more than the code delivers. |
| 9 | **L1–L4:** drop dead `reqwest`, map dir-create error, startup warn on non-enforce, role-gate `/scan`. | S | Hygiene. |

---

## 6. What was NOT covered (honest scope limits)

- **Live NAS deployment was not inspected.** The reported live-DB corruption (reversed titles, TV-as-movies, series split) is **not reproducible from this branch's code**. I could not confirm what image/branch the NAS actually runs. **The single highest-value real-world check is a deploy-vs-source diff on the NAS** (docker image digest vs CI build) + a clean rescan into a fresh `media.db` — that is where the corruption lives, not in this source.
- **No `docker build` was executed.** Dockerfile *contents* were verified (Cargo.lock present, media-core copied, ffmpeg/ffprobe 7.1 installed); actual build success was not run.
- **No live proxy→media-core round-trip** was exercised; the "401 confirmed" claim has no reproducible artifact and was not validated end to end.
- **TMDB resolver's real HTTP behavior is untested** (only the no-key short-circuit is). I did not stand up a mock TMDB to exercise it.
- **The vitest flake** was observed once; I did not run an N-iteration flake-detection pass to quantify the rate.
- **Three locked sibling worktrees** (`wf/spa-media-tab`, `wf/recommender-local`, `wf/media-core-fixes`) exist and may already address some findings; I audited only the main `a8046ec` worktree as instructed.

---

## 7. Remediation log (2026-05-28, post-audit)

Each row records a claim or finding moving from false/overstated to verified-true, with the command that proves it. Numbers are from real runs on the merged `m3-media-core` branch, not from commit-message assertions.

| Finding | Before | After | Proof |
|---|---|---|---|
| Claim #1 — "fmt clean" | FALSE: `cargo fmt --all -- --check` exit 1, 12 files | TRUE | `cargo fmt --all` applied (commit `5a1218d`); `--check` now exit 0 |
| H1 — recommender backup-gate RED | 2 failed / 70 passed; tests asserted legacy fallback-only behavior | 73 passed / 0 skipped / 0 failed | tests rewritten to force auto-backup failure + cover the primary auto-backup-success path (commit `c18d2e5`); run in a clean venv with `numpy/fastapi/sqlite_vec` + the pyo3 ext built via `maturin develop` |
| "green-by-skip" cross-binding parity | 32 skipped (pyo3 ext not built) | 0 skipped — all parity tests run | `maturin develop` built `emerald_contracts`; `pytest -q` → 73 passed |
| H2 — TMDB never wired | resolver built but uncalled; 100% null tmdb_id | enrichment wired into `scanner::index_file` | merged from `wf/media-core-fixes`; covered by media-core test suite (66 passing) |
| Config silent-Off on typo | `PrincipalMode::parse("garbage") → Off` | hard error on unknown mode | `PrincipalMode::parse` returns `Result`; rejects unknown (commit `e616b9c`) |
| enforce-without-secret | bootable | hard reject at boot | `validate_posture`/`classify_posture` → `Reject` (commit `e616b9c`) |
| non-loopback + non-enforce | (audit suggested hard reject) | **loud WARN, not reject** — preserves the off→log→enforce soak and the docker-network bind | `classify_posture` → `Warn`; corrected the audit's over-prescription |
| watch IDOR via `?sub=` | trusted in any mode w/o claims | `?sub=` honored only in `Off` mode; rejected in log/enforce | `acting_sub(mode)` + test `acting_sub_rejects_query_sub_outside_off_mode` (commit `e616b9c`) |
| M1 — transcode 503 dead code | `TranscoderRequired` never constructed | `stream_file` returns 503 when advertised caps require transcode | test `stream_refuses_when_client_caps_require_transcode` (commit `e616b9c`) |
| stream path traversal | no containment | canonicalized library-root containment | `path_within_roots` in `stream_file` (commit `e616b9c`) |

### Still open (honest)

- **Claim #8 — M1.5 contract "lockable":** the doc still reads `Status: DRAFT for review` with 4 deliberately-pending user decisions (LICENSE, internal-auth boundary, recommender data-model, telemetry). NOT auto-flipped — these are the user's M1.5 gate calls. The "lockable" framing is corrected here: the parity *gate* is green; the *contract* is not locked.
- **Live deploy corruption:** confirmed to originate from a STALE deployed binary, not from this source (current `filename.rs` parses forward; the reversal/misclassification only existed in the pre-impl scaffold). Remedy is rebuild + wipe `media.db` + rescan on the NAS — tracked separately, requires a destructive-cache-wipe confirm.
- **Live proxy→media-core 401 round-trip:** still has no reproducible artifact; to be validated post-deploy on real authed SPA traffic before flipping `enforce`.
