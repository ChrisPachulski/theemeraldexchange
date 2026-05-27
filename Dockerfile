# Multi-stage build for the Hono backend container.
#
# Stage 1 (napi-builder): compiles the @emerald/contracts-napi binding
# into a linux-x64-gnu .node from the Rust workspace. Out-of-band of
# npm ci because the napi crate is a `file:` dep and the runtime image
# doesn't carry a Rust toolchain. Symmetric to recommender/Dockerfile's
# rust-builder stage (which produces the PyO3 wheel).
#
# Stage 2 (base): node:24-slim runtime. Pre-stages the napi crate's JS
# bits + the linux-x64-gnu .node from stage 1 INTO the crate's directory
# so the `file:` dep resolves and the prepare-script existence check
# passes without firing a runtime rebuild. The crate dir must exist
# before `npm ci` so npm can symlink the workspace package.
#
# Base switched from alpine (musl) to slim (glibc) because:
#   1. napi-rs linux-x64-gnu artifact is glibc; alpine couldn't load it
#      without rebuilding for musl (extra toolchain in stage 1).
#   2. better-sqlite3 ships prebuilt glibc binaries for node 24 — drops
#      the python3+make+g++ install the alpine image needed.
#   3. Image size delta is ~50 MB. Acceptable given the build-toolchain
#      drop and the new linux-x64-gnu .node payload.

FROM rust:1.90-slim-bookworm AS napi-builder

WORKDIR /build

# napi-rs's CLI is a Node tool, so we need Node here. Pin to 24 to
# match the runtime image — napi-rs's prebuilt-binary loader checks
# N-API version compatibility, which tracks Node's major version.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Cargo workspace requires all members present — copying the pyo3 crate
# manifest only (no compile here) is cheap and lets cargo resolve.
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates/emerald-contracts ./crates/emerald-contracts
COPY crates/emerald-contracts-napi ./crates/emerald-contracts-napi
COPY crates/emerald-contracts-pyo3 ./crates/emerald-contracts-pyo3

# napi-rs CLI ships its own builder script; run it inside the crate dir
# so it picks up package.json's napi block (binaryName, target list).
# Output lands at
# crates/emerald-contracts-napi/emerald-contracts-napi.linux-x64-gnu.node.
WORKDIR /build/crates/emerald-contracts-napi
RUN npx --yes @napi-rs/cli@3 build --platform --release

# ---------------------------------------------------------------------------
FROM node:24-slim AS base

WORKDIR /app

# Pre-stage the napi crate's JS surface + the linux-x64-gnu .node so the
# file: dep resolves and the prepare-script's existence check finds the
# binary and short-circuits the rebuild. .dockerignore excludes
# crates/*/target and **/*.node from the build context — the .node copy
# from the napi-builder stage bypasses that.
COPY crates/emerald-contracts-napi/package.json \
     crates/emerald-contracts-napi/index.js \
     crates/emerald-contracts-napi/index.d.ts \
     ./crates/emerald-contracts-napi/
COPY --from=napi-builder \
     /build/crates/emerald-contracts-napi/emerald-contracts-napi.linux-x64-gnu.node \
     ./crates/emerald-contracts-napi/

COPY package.json package-lock.json ./
RUN npm ci

COPY server ./server
COPY tsconfig.json ./

# Bind-mount target for the grab-event log + sqlite DBs. Created here
# so a fresh host directory still has the right ownership inside the
# container.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "start"]
