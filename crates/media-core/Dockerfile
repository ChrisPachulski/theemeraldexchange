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

FROM rust:1.90-slim-bookworm AS builder

WORKDIR /build

# Workspace resolution needs every member manifest present. Copying the
# whole crates/ tree is simplest; .dockerignore already excludes target/.
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates

RUN cargo build --release -p media-core

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

WORKDIR /srv

# Statically-linked ffmpeg/ffprobe 7.x — no glibc/runtime deps, runs as-is.
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /ffprobe /usr/local/bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data

COPY --from=builder /build/target/release/media-core /usr/local/bin/media-core

# Bind 0.0.0.0 inside the container so the backend can reach it over the
# docker network; compose publishes the port to the host's loopback only.
ENV MEDIA_CORE_HOST=0.0.0.0
ENV MEDIA_CORE_PORT=8002
ENV MEDIA_DB_PATH=/data/media.db

EXPOSE 8002

CMD ["media-core"]
