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
#   2. better-sqlite3 is compiled from source either way — it has NO
#      prebuilt binary for node 24's ABI — so the npm ci layer below
#      installs python3+make+g++ and purges them in the same layer.
#      (An earlier revision of this header claimed a prebuilt glibc
#      binary existed; the RUN block below was always the reality.)
#   3. Image size delta is ~50 MB. Acceptable given the glibc
#      compatibility and the new linux-x64-gnu .node payload.

# BUNDLE_SPA (plan 006 Phase 2): 'on' bundles the vite-built SPA into the
# image (self-host, GHCR publish); 'off' (default) skips the SPA stage
# entirely so the owner's NAS deploy never runs a vite build on the box.
ARG BUNDLE_SPA=off

# Digest-pinned for reproducible builds. The human tag is kept for readability;
# the digest is the source of truth. Resolve a new digest with:
#   docker buildx imagetools inspect rust:1.96-slim-bookworm
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
# Cap the cargo compile behind napi build on shared hosts (cargo reads
# CARGO_BUILD_JOBS natively; empty would be a parse error, so normalize
# empty → unset) and keep it incremental via BuildKit cache mounts — the
# same NAS-safety pattern as crates/transcoder/Dockerfile. The .node output
# is copied by the CLI into the crate dir, OUTSIDE the target cache mount,
# so the later COPY --from=napi-builder still sees it.
ARG CARGO_BUILD_JOBS
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/build/target,sharing=locked \
    if [ -z "${CARGO_BUILD_JOBS:-}" ]; then unset CARGO_BUILD_JOBS; fi \
 && npx --yes --package @napi-rs/cli@3.7.0 napi build --platform --release

# ---------------------------------------------------------------------------
# SPA build (plan 006 Phase 2): the SELF-HOST image serves the web client
# same-origin from ./dist (env.serveSpa auto-detects it). Gated behind
# BUNDLE_SPA so the owner's NAS deploy (BUNDLE_SPA=off, the default) never
# runs a vite build on the weak NAS CPU — BuildKit skips unused stages, so
# with 'off' the spa-on stage costs nothing. The GHCR self-host publish
# passes --build-arg BUNDLE_SPA=on.
#
# --ignore-scripts skips the better-sqlite3/node-gyp compile and the napi
# prepare — a vite build needs neither native module (rollup/esbuild ship
# prebuilt platform packages). VITE_API_BASE_URL is deliberately UNSET:
# apiUrl() then falls back to window.location.origin, which is exactly
# right for same-origin serving.
FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS spa-on
WORKDIR /spa
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
RUN npx vite build

# Empty stand-in: BUNDLE_SPA=off yields an empty /spa/dist (no index.html),
# so env.serveSpa auto-detection stays off — today's owner posture.
FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS spa-off
RUN mkdir -p /spa/dist

FROM spa-${BUNDLE_SPA} AS spa-dist

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

# Pre-stage the napi crate's JS surface + the platform .node so the
# file: dep resolves and the prepare-script's existence check finds the
# binary and short-circuits the rebuild. .dockerignore excludes
# crates/*/target and **/*.node from the build context — the .node copy
# from the napi-builder stage bypasses that. Glob (not the x64 name): the
# napi-builder emits linux-x64-gnu.node on amd64 and linux-arm64-gnu.node
# on arm64 (plan 006 Phase 5 multi-arch); index.js loads by platform.
COPY crates/emerald-contracts-napi/package.json \
     crates/emerald-contracts-napi/index.js \
     crates/emerald-contracts-napi/index.d.ts \
     ./crates/emerald-contracts-napi/
COPY --from=napi-builder \
     /build/crates/emerald-contracts-napi/*.node \
     ./crates/emerald-contracts-napi/

COPY package.json package-lock.json ./
# better-sqlite3 has no prebuilt binary for node 24, so npm ci compiles
# it from source via node-gyp — which needs python3 + a C++ toolchain.
# node:24-slim ships none of these (CI's npm ci only works because the
# GitHub runner has them preinstalled). Install the toolchain, build,
# then purge it in the same layer so the runtime image stays slim — the
# compiled .node persists and needs no toolchain at runtime.
#
# --omit=dev: this is the RUNTIME image; the server runs via `npm start`
# → `tsx server/index.ts`, and tsx is a production dependency. None of
# the devDependencies (vite, vitest, eslint, playwright, typescript, …)
# are imported at runtime — they exist for the SPA build and the test
# suites, which never run in this image. Omitting them keeps the image
# smaller and shrinks the runtime supply-chain surface. The napi file:
# dep's prepare script still runs but short-circuits on the pre-staged
# .node above (plain `node -e`, no devDeps required).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip make g++ \
 && npm ci --omit=dev \
 # yt-dlp resolves a YouTube trailer/extra id to a directly-playable progressive
 # URL for AVPlayer (tvOS has no WebKit to embed the YouTube player);
 # server/services/ytdlp.ts shells to it (`yt-dlp -g`). Installed via pip (not
 # the PyInstaller standalone) so it runs under the system python on the exec
 # rootfs — the standalone self-extracts to /tmp, which the compose tmpfs mounts
 # noexec, so it can't map its libs there. python3 is KEPT (not purged) for it.
 # Unpinned: a YouTube extractor must track YouTube's changes; pinning rots fast.
 && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
 && apt-get purge -y --auto-remove make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY server ./server
COPY tsconfig.json ./

# Our native Rust YouTube resolver — the eex-ytresolve binary, prebuilt in CI
# (github.com/ChrisPachulski/rust-yt-extractor) so the NAS never compiles
# boa_engine. server/services/ytresolve.ts execs it to resolve a trailer/extra
# id to adaptive googlevideo streams, which server/services/ytmux.ts muxes into
# a served mp4; on any failure the caller falls back to yt-dlp. The binary is
# glibc x86_64 (built in rust:1.96-slim-bookworm), forward-compatible with this
# node:24-slim runtime. Staged into the build context at bin/ by the deploy
# (scripts/deploy-nas.sh fetches the release asset; .gitignored, never committed).
# --chmod guarantees the exec bit regardless of the staged file's mode.
COPY --chmod=0755 bin/eex-ytresolve /usr/local/bin/eex-ytresolve
ENV EEX_YTRESOLVE_BIN=/usr/local/bin/eex-ytresolve

# SPA bundle (plan 006 Phase 2): empty dir when BUNDLE_SPA=off (owner
# posture → env.serveSpa auto-off), the vite build when 'on' (self-host
# → backend serves it same-origin at /).
COPY --from=spa-dist /spa/dist ./dist

# Bind-mount target for the grab-event log + sqlite DBs. Created here
# so a fresh host directory still has the right ownership inside the
# container.
RUN mkdir -p /app/data

# Drop root — parity with the media-core/transcoder images (the last container
# still running as root; audit 9-4 / publishing checklist §8.6). The compose
# hardening is already identical to media-core's working non-root setup
# (read_only rootfs + tmpfs /tmp + cap_drop ALL); only the USER was missing.
# /app is owned here so tsx can read the server code + compiled native modules
# under a read-only rootfs; the /app/data bind mount is chowned to this uid on
# the NAS host so sqlite + the grab log stay writable.
RUN groupadd --system --gid 10001 emerald \
 && useradd --system --uid 10001 --gid emerald --home-dir /app --no-create-home emerald \
 && chown -R emerald:emerald /app
USER emerald

ENV NODE_ENV=production
ENV PORT=3001

# Build identifier surfaced by /api/version (env.ts EEX_RELEASE, default
# 'dev'). scripts/deploy-nas.sh passes the short sha of the archived HEAD via
# docker-compose.yml's build args, so the deployed API self-reports the exact
# commit it was built from — that's the deployed-vs-HEAD drift detection.
# Declared AFTER the heavy npm ci layer so a sha change never busts its cache.
ARG EEX_RELEASE=dev
ENV EEX_RELEASE=$EEX_RELEASE

EXPOSE 3001

CMD ["npm", "start"]
