# Multi-stage build for the transcoder (M4) Rust service.
#
# Stage 1 (builder): compiles the `transcoder` binary from the Rust
# workspace. Build context is the REPO ROOT (see docker-compose.yml) so
# cargo resolves the full workspace — transcoder depends on the
# media-core + emerald-contracts crates.
#
# Stage 2 (runtime): debian-slim + statically-linked ffmpeg/ffprobe.
# The transcoder spawns `ffmpeg` per session (tokio::process), so the
# binary MUST be present at runtime. The Rust binary is glibc-linked, so
# the runtime base matches the bookworm builder.

FROM rust:1.90-slim-bookworm AS builder

WORKDIR /build

# Workspace resolution needs every member manifest present. Copying the
# whole crates/ tree is simplest; .dockerignore already excludes target/.
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates

RUN cargo build --release -p transcoder

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

WORKDIR /srv

# Statically-linked ffmpeg/ffprobe 7.x — no glibc/runtime deps, runs as-is.
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /ffprobe /usr/local/bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /scratch

COPY --from=builder /build/target/release/transcoder /usr/local/bin/transcoder

# Bind 0.0.0.0 inside the container so media-core/backend can reach it over
# the docker network; compose publishes the port to the host loopback only.
# Pin the port explicitly so the published port and the binary default match
# (binary default is 8090; we run on 8003).
ENV TRANSCODER_HOST=0.0.0.0
ENV TRANSCODER_PORT=8003
ENV TRANSCODER_FFMPEG_BIN=/usr/local/bin/ffmpeg
ENV TRANSCODER_TMP_DIR=/scratch

EXPOSE 8003

CMD ["transcoder"]
