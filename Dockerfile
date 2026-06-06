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

# Digest-pinned for reproducible builds. The human tag is kept for readability;
# the digest is the source of truth. Resolve a new digest with:
#   docker buildx imagetools inspect rust:1.90-slim-bookworm
FROM rust:1.96-slim-bookworm@sha256:b5f842fac1e3b4ff718a652a8e0173b62d9403ec826ef4998880b9347db30684 AS napi-builder

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
# media-core and transcoder are workspace members too; cargo must see them to
# resolve the workspace even though this stage only builds the napi addon.
COPY crates/media-core ./crates/media-core
COPY crates/transcoder ./crates/transcoder

# napi-rs CLI ships its own builder script; run it inside the crate dir
# so it picks up package.json's napi block (binaryName, target list).
# Output lands at
# crates/emerald-contracts-napi/emerald-contracts-napi.linux-x64-gnu.node.
#
# Invocation is fiddly in a clean image (no node_modules):
#   - `npx --yes napi build`        → tries to install an npm package
#                                     literally named `napi` (an empty
#                                     placeholder) → ENOVERSIONS.
#   - `npx --yes @napi-rs/cli@3 build` → "could not determine executable
#                                     to run" (bin name ≠ package name).
# The correct form names BOTH the package to fetch and the bin to run:
#   npx --package <pkg> <bin> <args>
# This works locally only because the root `npm ci` already has
# @napi-rs/cli in node_modules; this stage has no such install, so we
# fetch it explicitly. Output lands at
# crates/emerald-contracts-napi/emerald-contracts-napi.linux-x64-gnu.node.
WORKDIR /build/crates/emerald-contracts-napi
# @napi-rs/cli pinned to an EXACT version, matching
# crates/emerald-contracts-napi/package.json — this CLI emits the ABI-critical
# .node that the crypto/contracts wire boundary loads, so a floating major is a
# reproducibility risk for the wire-format-sensitive binding.
RUN npx --yes --package @napi-rs/cli@3.7.0 napi build --platform --release

# ---------------------------------------------------------------------------
# Digest-pinned for reproducible builds. Resolve a new digest with:
#   docker buildx imagetools inspect node:24-slim
FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS base

WORKDIR /app

# ffmpeg + ffprobe ≥6.0. server/services/ffmpeg.ts validates the version at
# boot and exits the process if it is missing or <6.0 (the backend extracts
# video frames). Debian bookworm's apt ships ffmpeg 5.1, which FAILS that gate,
# so we COPY statically-linked 7.x binaries from a pinned, binaries-only image
# instead. Static build → no glibc/runtime deps, runs as-is on node:24-slim.
# Digest-pinned — pinning this digest also pins the GPL ffmpeg/x264 binary
# provenance at the heart of the licensing review. When the tag is bumped, record
# the new digest plus the ffmpeg/x264 versions it ships in THIRD-PARTY-LICENSES.
# Resolve a new digest with:
#   docker buildx imagetools inspect mwader/static-ffmpeg:7.1
COPY --from=mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4 /ffmpeg /ffprobe /usr/local/bin/

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
# better-sqlite3 has no prebuilt binary for node 24, so npm ci compiles
# it from source via node-gyp — which needs python3 + a C++ toolchain.
# node:24-slim ships none of these (CI's npm ci only works because the
# GitHub runner has them preinstalled). Install the toolchain, build,
# then purge it in the same layer so the runtime image stays slim — the
# compiled .node persists and needs no toolchain at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

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
