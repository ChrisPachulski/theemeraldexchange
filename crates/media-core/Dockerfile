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

FROM rust:1.96-slim-bookworm@sha256:b5f842fac1e3b4ff718a652a8e0173b62d9403ec826ef4998880b9347db30684 AS builder

WORKDIR /build

# Workspace resolution needs every member manifest present. Copying the
# whole crates/ tree is simplest; .dockerignore already excludes target/.
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates

RUN cargo build --release -p media-core

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb AS runtime

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

COPY --from=builder /build/target/release/media-core /usr/local/bin/media-core

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
