# Multi-stage build for the backend container: the Rust gateway (eex-gateway,
# crates/gateway).
#
# Build context is the REPO ROOT so cargo resolves the full workspace: the
# gateway links crates/auth in-process and depends on media-core and
# emerald-contracts. CI builds this image and pushes it to GHCR as
# theemeraldexchange-backend:sha-<commit>; scripts/deploy-nas.sh pulls that
# image, so the NAS never compiles it.

# BUNDLE_SPA: 'on' bundles the vite-built SPA into the image (self-host, GHCR
# publish); 'off' (default) skips the SPA stage entirely so the owner's deploy
# (the SPA is on Netlify) never runs a vite build.
ARG BUNDLE_SPA=off

# Digest-pinned for reproducible builds. Resolve a new digest with:
#   docker buildx imagetools inspect rust:1.98-slim-bookworm
FROM rust:1.98-slim-bookworm@sha256:1469a27c125cb5a3aebfa4f4e4665d935b02fb72cc093b2c974b3d740e43f157 AS builder

WORKDIR /build

# Workspace resolution needs every member manifest present; .dockerignore
# already excludes target/.
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates

# Compile-parallelism cap for shared hosts (see crates/transcoder/Dockerfile for
# the Plex brown-out history). compose interpolates an unset value to "", which
# cargo cannot parse, so the RUN normalizes empty to unset (cargo default).
ARG CARGO_BUILD_JOBS
# BuildKit cache mounts keep target/ and the registry across builds, so a source
# change recompiles only the changed crates. They are not in the image layer, so
# the binary is copied out for the runtime stage.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/build/target,sharing=locked \
    if [ -z "${CARGO_BUILD_JOBS:-}" ]; then unset CARGO_BUILD_JOBS; fi \
 && cargo build --release -p gateway --bin eex-gateway \
 && cp /build/target/release/eex-gateway /usr/local/bin/

# ---------------------------------------------------------------------------
# SPA build: the SELF-HOST image serves the web client same-origin from
# /app/dist (SERVE_SPA auto-detects ./dist/index.html). BuildKit skips unused
# stages, so with BUNDLE_SPA=off the spa-on stage costs nothing.
#
# --ignore-scripts: a vite build needs no install scripts (rollup/esbuild ship
# prebuilt platform packages). VITE_API_BASE_URL is deliberately UNSET:
# apiUrl() then falls back to window.location.origin, which is exactly right
# for same-origin serving.
FROM node:26-slim@sha256:aa8fa825983c9ce8c794de92beb9c5402572e07fb0b4b80164856497894cc722 AS spa-on
WORKDIR /spa
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
RUN npx vite build

# Empty stand-in: BUNDLE_SPA=off yields an empty /spa/dist (no index.html), so
# SERVE_SPA auto-detection stays off (the owner posture).
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS spa-off
RUN mkdir -p /spa/dist

FROM spa-${BUNDLE_SPA} AS spa-dist

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

WORKDIR /app

# ca-certificates: TLS to TMDB, OMDb, Anthropic, Glitchtip and googlevideo.
# curl: the HEALTHCHECK. python3 + yt-dlp: the trailer fallback resolver
# (`yt-dlp -g`) when eex-ytresolve fails. yt-dlp is installed with pip (not the
# PyInstaller standalone) so it runs under the system python on the read-only
# rootfs; the standalone self-extracts to /tmp, which compose mounts noexec.
# Unpinned: a YouTube extractor must track YouTube's changes; pinning rots fast.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
 && apt-get purge -y --auto-remove python3-pip \
 && rm -rf /var/lib/apt/lists/*

# ffmpeg + ffprobe >= 6.0. The gateway checks the version at boot and exits if
# it is missing or < 6.0 (the trailer mux needs it). Debian bookworm's apt
# ships ffmpeg 5.1, which FAILS that gate, so we COPY statically-linked 7.x
# binaries from a pinned, binaries-only image instead. Digest-pinned — pinning
# this digest also pins the GPL ffmpeg/x264 binary provenance at the heart of
# the licensing review. When the tag is bumped, record the new digest plus the
# ffmpeg/x264 versions it ships in THIRD-PARTY-LICENSES. Resolve a new digest:
#   docker buildx imagetools inspect mwader/static-ffmpeg:7.1
COPY --from=mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4 /ffmpeg /ffprobe /usr/local/bin/

# Our native Rust YouTube resolver, prebuilt in its own repo's CI
# (github.com/ChrisPachulski/rust-yt-extractor) so the NAS never compiles
# boa_engine. The gateway execs it to resolve a trailer/extra id to adaptive
# googlevideo streams and muxes them into a served mp4; on any failure it falls
# back to yt-dlp. Staged into the build context at bin/ (CI stages an exec-fail
# stub; the owner deploy mounts the real binary over it). --chmod guarantees
# the exec bit regardless of the staged file's mode.
COPY --chmod=0755 bin/eex-ytresolve /usr/local/bin/eex-ytresolve
ENV EEX_YTRESOLVE_BIN=/usr/local/bin/eex-ytresolve

COPY --from=builder /usr/local/bin/eex-gateway /usr/local/bin/

# SPA bundle: empty dir when BUNDLE_SPA=off (SERVE_SPA auto-off), the vite
# build when 'on' (self-host: the gateway serves it same-origin at /).
COPY --from=spa-dist /spa/dist ./dist

# /app/data: bind-mount target for server.db, the JSON stores, the grab and
# usage logs and DB snapshots. Created here so a fresh host directory still has
# the right ownership inside the container. uid 10001 is the uid the NAS data
# dir is chowned to (scripts/deploy-nas.sh), as it was for the Node image.
RUN mkdir -p /app/data \
 && groupadd --system --gid 10001 emerald \
 && useradd --system --uid 10001 --gid emerald --home-dir /app --no-create-home emerald \
 && chown -R emerald:emerald /app
USER emerald

# NODE_ENV is the production switch the gateway's config reads (the same key
# the Node backend used, so .env files carry over).
ENV NODE_ENV=production
ENV PORT=3001

# Build identifier surfaced by /api/version (EEX_RELEASE, default 'dev'). CI
# passes the short sha so the deployed API self-reports the exact commit.
# Declared late so a sha change never busts the heavier layers' cache.
ARG EEX_RELEASE=dev
ENV EEX_RELEASE=$EEX_RELEASE

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/api/health || exit 1

CMD ["eex-gateway"]
