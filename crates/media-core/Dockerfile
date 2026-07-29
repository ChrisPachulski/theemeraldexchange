# Multi-stage build for the media-core (M3) Rust service.
#
# Stage 1 (builder): compiles the `media-core` binary from the Rust
# workspace. Build context is the REPO ROOT (see docker-compose.yml) so
# cargo can resolve the full workspace — media-core depends on the
# emerald-contracts crate.
#
# Stage 2 (runtime): debian-slim + statically-linked ffmpeg/ffprobe.
# media-core shells out to `ffprobe` at scan time (no FFI), so the binary
# must be present at runtime. The Rust binary is glibc-linked, so the
# runtime base matches the bookworm builder.

FROM rust:1.97-slim-bookworm@sha256:99e09cb2284e2ddbb73a995deee3e91783fd04d177602ccf6eab326d778ee777 AS builder

WORKDIR /build

# Workspace resolution needs every member manifest present. Copying the
# whole crates/ tree is simplest; .dockerignore already excludes target/.
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates

# Compile-parallelism cap for constrained / shared hosts (same pattern as
# crates/transcoder/Dockerfile — see the incident notes there). The NAS deploy
# passes --build-arg CARGO_BUILD_JOBS via docker-compose build.args so a
# rebuild cannot pin the CPU and starve Plex. Unset (CI / dev) = cargo's
# default. compose interpolates an unset var to an EMPTY string, and empty is
# a cargo parse error, so normalize empty → unset before building.
ARG CARGO_BUILD_JOBS
# BuildKit cache mounts make rebuilds INCREMENTAL: target/ + the crate
# registry persist across builds, so a source change recompiles only the
# changed crates instead of the whole workspace cold (the load storm that
# brown-outed Plex). Cache mounts are not image layers, so the built binary
# is copied OUT to a normal path for the runtime stage to grab.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/build/target,sharing=locked \
    if [ -z "${CARGO_BUILD_JOBS:-}" ]; then unset CARGO_BUILD_JOBS; fi \
 && cargo build --release -p media-core \
 && cp /build/target/release/media-core /usr/local/bin/media-core-bin

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

WORKDIR /srv

# Statically-linked ffmpeg/ffprobe 7.x — no glibc/runtime deps, runs as-is.
COPY --from=mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4 /ffmpeg /ffprobe /usr/local/bin/

# curl is for the container HEALTHCHECK (audit 9-0); ca-certificates for TLS
# egress (TMDB). Create a non-root user (audit 9-0) that owns /data.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data \
 && groupadd --system --gid 10002 mediacore \
 && useradd --system --uid 10002 --gid mediacore --home-dir /srv --no-create-home mediacore \
 && chown -R mediacore:mediacore /data /srv

COPY --from=builder /usr/local/bin/media-core-bin /usr/local/bin/media-core

# Bind 0.0.0.0 inside the container so the backend can reach it over the
# docker network; compose publishes the port to the host's loopback only.
ENV MEDIA_CORE_HOST=0.0.0.0
ENV MEDIA_CORE_PORT=8002
ENV MEDIA_DB_PATH=/data/media.db

EXPOSE 8002

# Drop root (audit 9-0). The library bind-mount is read-only and /data is
# chowned above, so the service needs no root privilege at runtime.
USER mediacore

# Liveness/readiness probe (audit 9-0/9-1) so compose depends_on can gate on
# health instead of mere container start. /health is public (no auth).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8002/health || exit 1

CMD ["media-core"]
