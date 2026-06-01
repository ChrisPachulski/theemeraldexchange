#!/usr/bin/env bash
# scripts/autoloop/ci-gate.sh
#
# The ONE source of truth for "what CI's `test` job would accept". The in-mesh
# tester agent and the driver's pre-promote re-verify both run THIS, so a branch
# that passes here is a branch CI accepts. Closes the IR-7 gap: the loop used to
# verify with `tsc --noEmit` while CI runs `tsc -b` (via `npm run build`), and it
# shipped 9 type errors into integration once.
#
# Mirrors .github/workflows/ci.yml `test` job verbatim, plus the `rust` job's
# cargo gate WHEN Rust/crate files changed vs the base ref. Exits non-zero on the
# FIRST failing gate. Bash shebang is explicit (CLAUDE.md: guard bash-isms).
#
# Usage: bash scripts/autoloop/ci-gate.sh [BASE_REF]
#   BASE_REF defaults to origin/auto/integration (used only to decide whether the
#   cargo gate runs). Run from anywhere — it cd's to the repo root.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)" || { echo "ci-gate: cannot find repo root"; exit 1; }

BASE_REF="${1:-origin/auto/integration}"

fail() { echo "ci-gate: FAIL at -> $1"; exit 1; }
run()  { echo "ci-gate: + $*"; "$@" || fail "$*"; }

echo "ci-gate: repo=$(pwd) head=$(git rev-parse --short HEAD 2>/dev/null) base=$BASE_REF"

# --- JS/TS gate — verbatim from ci.yml `test` job ---
run npx tsc --noEmit                    # Type-check (SPA)
run npx tsc -p server/tsconfig.json     # Type-check (server)
run npm run lint                        # Lint (eslint .)
run npm run test:coverage               # Test + coverage (vitest run --coverage)
run npm run build                       # Build (tsc -b && vite build && tsc -p server) — the IR-7 catcher

# --- Rust gate — from ci.yml `rust` job, only when Rust/crate files changed ---
if git diff --name-only "$BASE_REF"...HEAD 2>/dev/null | grep -qE '(^|/)(Cargo\.(toml|lock)|.*\.rs)$|(^|/)crates/'; then
  echo "ci-gate: Rust/crate changes detected vs $BASE_REF — running cargo gate"
  # fmt is advisory in CI (continue-on-error) — keep it advisory here too.
  cargo fmt --all -- --check || echo "ci-gate: WARN cargo fmt --check (advisory, non-gating like CI)"
  run cargo clippy --all-targets --workspace --exclude emerald-contracts-pyo3 -- -D warnings
  run cargo test  --workspace --exclude emerald-contracts-pyo3 --all-targets
else
  echo "ci-gate: no Rust/crate changes vs $BASE_REF — skipping cargo gate"
fi

echo "ci-gate: PASS — CI test job would accept this branch"
