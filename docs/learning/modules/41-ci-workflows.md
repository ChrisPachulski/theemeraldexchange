
# Teaching Dossier: Continuous Integration (CI) Workflows

## 1. WHAT — Beginner Explanation

Continuous Integration (CI) is a robot that springs to life every time you push code or open a pull request. Instead of letting bugs hide in your drawer, the robot automatically runs tests, checks your code style, scans for security problems, and builds the final app — all in minutes. If anything breaks, the robot turns red and blocks you from merging. It's your safety net: catches problems before they reach users.

## 2. WHY — The Chain of Reasoning

**Why gate merges on CI?**
- Code is complex: one typo or refactoring mistake can crash the app or leak data
- Humans review code, but humans miss things (especially in unfamiliar languages — Rust, Python, TypeScript all in one repo)
- Tests are expensive to run locally (playwright install is ~45s, real ffmpeg builds take minutes)
- When six different codebases share a monorepo (backend, SPA, recommender, transcoder, contracts), a breaking change in one layer can silently break another layer's tests. Gating all in CI forces you to discover it before you merge, not on production deployment

**Why digest pins and supply-chain hardening?**
- Docker images you pull from Docker Hub could be compromised (attacker pushes a backdoored version to the tag you use)
- Rust and npm dependencies auto-update: a version that worked yesterday might have a security hole discovered today
- When you deploy to your own hardware (the NAS running Plex), a compromised dependency can steal your library, your credentials, or hijack your streams
- Pinning image digests (SHA256 hashes) instead of tags is like checking the package seal before opening it; pinning dependency versions + checksums means your build is reproducible and the binary you test is the binary that deploys
- `cargo audit` + `npm audit` + `pip-audit` are the guards: they check the National Vulnerability Database and fail CI if a known CVE exists in a dependency

## 3. MAP — Workflow-by-Workflow

| Workflow | File | Trigger | Key Jobs | Purpose |
|----------|------|---------|----------|---------|
| **CI** | `ci.yml` | Every push to `main` + every PR | `test`, `test-no-iptv`, `recommender`, `rust`, `audit`, `docker-build`, `shellcheck` | Main gate: types/tests/lint/coverage + cross-language parity + vuln scan + image validation + deploy-script linting |
| **Transcoder FFmpeg** | `transcoder-ffmpeg.yml` | Changes to transcoder, media-core, contracts, or Cargo files | `test-real-ffmpeg-fixture` | Proves the transcoder actually compiles valid HLS with REAL ffmpeg (not just state machine tests) |
| **E2E Integration** | `e2e-integration.yml` | Backend/SPA/test/contract changes | `integration`, `playback-chrome` | Real Hono server + real Chrome playback (not mocked): catches MSE append bugs that unit tests miss |
| **Sidecar Images** | `sidecar-images.yml` | Manual trigger + main branch | `recommender-image`, `media-core-image`, `transcoder-image` | Builds heavy Docker images (recommender w/ torch, transcoder w/ Rust) only on deploy branch to keep PR feedback fast |
| **Dependabot auto-merge** | `dependabot-auto-merge.yml` | Dependabot PRs to `main` | `auto-merge` | Enables GitHub auto-merge for low-risk Dependabot bumps; the PR still waits for the 7 required checks before it merges |

## 3.1 MERGE GOVERNANCE — what actually gates `main`

The jobs above only matter if something *enforces* them. Three pieces do that, and they're configured on GitHub (not in the repo), so they're invisible if you only read the YAML:

**The ruleset.** A repository ruleset named **`main: CI must pass (owner bypass)`** requires seven status checks to be green before a PR can merge to `main`: `test`, `test-no-iptv`, `recommender`, `rust`, `audit`, `docker-build`, `shellcheck` — the seven jobs in `ci.yml`. A red check blocks the merge. (Only the 7 always-run `ci.yml` jobs are required; the path-filtered workflows — `transcoder-ffmpeg`, `e2e-integration`, `sidecar-images` — are NOT required, because a PR that doesn't touch their paths never runs them, and a required-but-never-run check would deadlock the merge forever.)

**The owner bypass.** The repo owner is listed as a *bypass actor* on that ruleset. This means the owner's **direct pushes to `main` are not blocked** by the gate — an intentional escape hatch for a solo homelab where the owner sometimes commits straight to `main`. It does NOT exempt Dependabot or any PR: a Dependabot PR must still go green to merge.

**Auto-merge for dependency bumps.** Repo-level "allow auto-merge" is enabled, and `dependabot-auto-merge.yml` turns it on for low-risk Dependabot PRs. The policy (mirrors `.github/dependabot.yml`):

- **majors** → never auto-merge; a human reviews them.
- **cargo minors** → never auto-merge. A `0.x` minor (e.g. `sha2 0.10→0.11`) is API-breaking and byte-compat-sensitive for the cross-language crypto crate, so these land as individual, reviewed PRs.
- **everything else** (any patch; npm/docker/pip/actions minor) → auto-merge **once the 7 checks pass**. Auto-merge only *enables* the merge; it never bypasses CI. A red PR sits until someone fixes it.

This pairs with the Dependabot grouping in `.github/dependabot.yml`, which keeps PR volume sane rather than one-branch-per-package: npm bundles `@types/*` + eslint/typescript/vite/vitest tooling into a **`dev-tooling`** group and other runtime minor/patch bumps into a **`runtime-minor`** group; cargo uses a **patch-only `cargo-patch`** group (minors stay individual for the byte-compat reason above). So a typical week produces a small handful of grouped PRs, most of which auto-merge themselves once green.

**Why this shape?** The repo is private until M2 TestFlight, so the gate is about catching regressions and keeping dependencies current with minimal babysitting — not defending against malicious PRs (there are no outside contributors). The owner bypass keeps a solo workflow fast; the auto-merge routine keeps low-risk bumps from piling up; the 7-check requirement guarantees nothing merges (Dependabot or otherwise) without the full cross-language suite passing. _(Added 2026-06-13, after a stale 4→2s-segment test had silently left `main` red and a dozen Dependabot PRs piled up dead behind it.)_

## 4. PREREQUISITES — Fundamentals First

Before this makes sense, you need to understand:

1. **Push vs. PR**: When you `git push` to `main`, CI runs. When you open a pull request *from* another branch *to* `main`, CI also runs. Merging a PR is blocked until CI goes green — enforced by a ruleset, with the repo owner able to bypass on direct pushes (see §3.1).

2. **GitHub Actions**: GitHub's CI/CD service. A workflow is a YAML file in `.github/workflows/`. Each workflow has jobs; jobs have steps (e.g., "install Node", "run tests"). Steps can run in parallel or depend on each other.

3. **Multi-language project**: This repo has TypeScript (SPA + backend), Rust (contracts, transcoder, media-core), and Python (recommender). CI must validate all three, and some jobs gate on **cross-language parity** (e.g., the Rust token-crypto must match the TypeScript NAPI addon byte-for-byte).

4. **Docker**: The app ships as Docker containers. Dockerfiles compile the app into a runnable image. CI validates the Dockerfile before deployment.

5. **Dependency versions**: `npm` (JS), `cargo` (Rust), `pip` (Python) fetch code from registries. A dependency update can introduce a security hole. Auditing these is a CI job.

## 5. GOTCHAS & WAR STORIES

**NAPI prepare dts-clobber (2026-03-27)**
- The `@emerald/contracts-napi` package has a `prepare` script that runs `napi build` during `npm ci`. The prepare script was clobbering the hand-authored `index.d.ts` → 0 bytes. Result: TypeScript couldn't find the type definitions, CI tsc failed with TS2306. The Docker base has no `scripts/` so the `.node` check must be inline; fixed via dts-guard so the original file survives.

**Rust 1.96 pinning**
- The contracts crate requires Rust 1.96. The CI runner's default rustc is older. If you don't pin it explicitly, the napi addon silently fails to build, and the device-token crypto tests can't load it. The `dtolnay/rust-toolchain@` action pins the exact version.

**Playwright install bloat**
- The first time the test job runs, `playwright install chromium` downloads ~350 MB. On GitHub runners, it adds ~45s. The workflow bumped the timeout from 8 → 15 minutes to account for this. The config pins `chromium-only` so we don't download Firefox/WebKit (~400 MB more).

**IPTV feature gate (test-no-iptv job)**
- A merge landed a feature: `/api/iptv` endpoint. But what if some OTHER endpoint depends on it being missing (e.g., a route that errors if IPTV is enabled)? The job re-runs the full test suite with `IPTV_DISABLED=1` to catch any cross-feature surface that quietly depends on `/api/iptv`. This is contract §13.3 reviewer-insurance.

**Torch CVE in pip-audit**
- The recommender uses PyTorch. A CVE (CVE-2025-3000) was discovered in `torch.jit.script` (memory corruption, local-only attack). The recommender never calls `torch.jit.script` and only uses torch for offline embedding (no untrusted code reaches it). So the vulnerable path is unreachable. But pip-audit would fail CI. The fix: `--ignore-vuln CVE-2025-3000` with a comment explaining why. When a patched torch ships, drop the ignore.

**Compose interpolation shadowing**
- The production `docker-compose.yml` has `${VAR}` placeholders (e.g., `${APPDATA}`). CI runs `docker compose config -q` to validate the schema and interpolation. This catches compose errors before they hit the NAS.

**Image-pin staleness guard**
- The cloudflared image pin once sat ~18 months stale with no one watching. Now a script flags any Docker Hub image tag whose last push was >12 months ago. It's "best-effort" (network failures → warning, not failure) so a Hub blip doesn't fail CI, but a CONFIRMED stale tag does.

**Deploy script (shellcheck)**
- The ~500-line `scripts/deploy-nas.sh` does snapshots, rsyncs, rollbacks, and health-gates on the NAS. One unquoted variable or masked exit code ships an outage. `shellcheck --severity=warning` gates on warnings + errors (info stays advisory because SC2029 expands-on-client is the script's INTENT).

## 6. QUIZ BANK

**Q1: You add a new npm dependency for the SPA. CI runs and `npm audit --audit-level=high` fails. What do you do?**

A: Run `npm audit` locally, see what high/critical CVE exists in the dependency, then decide: (a) upgrade the dependency to a patched version, (b) find a different dependency, or (c) if the CVE is unfixable yet (no patched version released), document the risk assessment in the workflow comment and add `--ignore-vuln CVE-XXXX` like the torch example. Don't just force-merge; a known CVE in prod means your users' data is at risk.

**Q2: You refactor the Rust token-derivation code in `crates/emerald-contracts`. The `recommender` job fails on the Node cross-binding test. What broke?**

A: The Rust crate changed, but you didn't rebuild the NAPI addon or PyO3 wheel. The test runs the Node side (internalPrincipal.crossBinding.test.ts) which mints a JWE via N-API, then decrypts it via the PyO3 binding. If they disagree on the derivation, the decrypt fails. The workflow builds both (maturin for PyO3, npm run build:napi for N-API) in the same job, so they stay in sync.

**Q3: You push a change to the Dockerfile. The `docker-build` job succeeds in CI but the image fails to start on the NAS with "file not found". Why didn't CI catch this?**

A: CI builds the backend Dockerfile but doesn't start a container (push: false, load: false). A layer might compile but not run if a binary is missing, a symlink is broken, or permissions are wrong. The job validates the build succeeds, not that the image runs. The real test is deploying and checking `https://api.theemeraldexchange.com/api/health` (or SSHing to the NAS).

**Q4: The `test-no-iptv` job runs the full test suite with IPTV_DISABLED=1 but the main `test` job already runs the suite. Why not just delete one?**

A: The main job runs with IPTV enabled (default). A bug might hide if IPTV is on but the SPA tries to mount the `/api/iptv` route anyway. The no-iptv job proves the app is resilient to a missing feature — that no OTHER endpoint has a hidden dependency on it being present. Two jobs, different code paths.

**Q5: You want to speed up CI because it's taking 25 minutes. You remove the Playwright E2E step. Is this a good idea?**

A: No. The E2E step catches bugs that unit tests miss: MSE buffer append errors (grey-box bug from 2026-06-08), playback stalls, stream-token handling, etc. Removing it trades real-world correctness for speed. A better move: cache Playwright's browser downloads (already done, via `playwright install --with-deps`), or run E2E on a cheaper tier (matrix on fewer browsers). Speed up by fixing root causes, not by skipping validation.

**Q6: You see the `transcoder-ffmpeg.yml` job run only on changes to transcoder/**, not on every push. Why?**

A: The ffmpeg fixture is slow and resource-intensive. Running it on every change (e.g., a README edit) is wasteful. Path-filtering ensures it only runs when something that affects the produced ffmpeg argv changes: transcoder code, media-core (dependency), contracts (dependency), or Cargo.lock (workspace version bump).

## 7. CODE-READING EXERCISE

Read the `ci.yml` file, lines 22–71 (the main `test` job), and answer these as you go:

1. **Lines 24–28**: What OS does the test job run on, and how long can it take?
2. **Lines 31–44**: Three setup steps. What do they do in sequence?
3. **Lines 46–56**: Four sequential steps. What does each one check?
4. **Lines 60–68**: Two special jobs. What are they gating?
5. **Lines 70–97**: Two build steps + two upload steps. Why upload artifacts on `if: always()` vs. `if: success()`?

**Answers:**

1. **Ubuntu 20.04 LTS (ubuntu-latest)**, timeout 15 minutes. GitHub-hosted runners are free for public repos; the NAS is self-hosted and reserved for heavy compile jobs (transcoder, recommender).

2. **Step 1 (checkout)**: Pull the git commit. **Step 2 (setup-node)**: Install Node 24, cache npm to speed up re-runs. **Step 3 (rust-toolchain)**: Install Rust 1.96 (specific version, not latest) because the contracts crate pinned it.

3. **Type-check SPA (npx tsc --noEmit)**: Validate TypeScript syntax on the SPA codebase. **Type-check server (npx tsc -p server/tsconfig.json)**: Validate backend TS. **Lint (npm run lint)**: Run eslint to catch style/pattern violations. **Test + coverage (npm run test:coverage)**: Run vitest with coverage collection.

4. **Eval:recs (offline recommendation eval)**: Gates the recommender's quality by running a suite of test vectors against the local Python impl + mocked Claude. This caught eval drift in vitest.env.ts. **Build**: Compile Vite (SPA) + server tsc to catch bundling errors.

5. **Upload on `if: always()`** (lines 91–97, coverage + playwright): These should upload even if tests fail, so you can inspect the failure. **Upload on `if: success()`** (lines 99–105, dist): Only upload the SPA build if tests pass, to avoid distributing a broken binary to deploy workflows.

---

**END EXERCISE**: You've read through the job structure. Now, why does the workflow pin EVERY action to a commit SHA (e.g., `actions/checkout@df4cb1c...`) instead of using version tags like `actions/checkout@v6`? (Hint: think supply-chain hardening, digest pins.) *Answer: SHAs are immutable; a version tag can be re-pushed. Pinning SHAs means your workflow runs the exact code GitHub shipped on that date, immune to tag re-points.*
