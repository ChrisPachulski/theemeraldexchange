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

FROM rust:1.96-slim-bookworm AS builder

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

# curl is for the container HEALTHCHECK (audit 9-0). Create a non-root user
# that owns /scratch (where ffmpeg writes HLS segments).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /scratch \
 && groupadd --system --gid 10003 transcoder \
 && useradd --system --uid 10003 --gid transcoder --home-dir /srv --no-create-home transcoder \
 && chown -R transcoder:transcoder /scratch /srv

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

# Drop root (audit 9-0). ffmpeg writes only to /scratch and reads the library
# via the read-only bind mount; no root needed at runtime.
# CAUTION: this `chown` of /scratch is MASKED at runtime when compose mounts a
# tmpfs over /scratch. A tmpfs mount with options (size=) defaults to root:root
# 0755, NOT this uid — so the compose tmpfs MUST set `mode=1777` or the
# transcoder cannot create a session dir (EACCES on every real transcode). The
# image chown only matters when /scratch is NOT a tmpfs (e.g. local `cargo run`).
USER transcoder

# Liveness/readiness probe (audit 9-0/9-1). /health is public (no auth).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8003/health || exit 1

CMD ["transcoder"]
