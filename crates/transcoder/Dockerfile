# Multi-stage build for the transcoder (M4) Rust service.
#
# Stage 1 (builder): compiles the `transcoder` binary from the Rust
# workspace. Build context is the REPO ROOT (see docker-compose.yml) so
# cargo resolves the full workspace — transcoder depends on the
# media-core + emerald-contracts crates.
#
# Stage 2 (runtime): debian-slim + jellyfin-ffmpeg (Intel QSV-capable).
# The transcoder spawns `ffmpeg` per session (tokio::process), so the
# binary MUST be present at runtime. The Rust binary is glibc-linked, so
# the runtime base matches the bookworm builder.
#
# ffmpeg provisioning — jellyfin-ffmpeg, NOT mwader/static-ffmpeg (history):
# QSV hardware H.264 encode (§4.4) needs a DYNAMICALLY-linked ffmpeg built with
# VAAPI+QSV plus the Intel runtime stack (the iHD driver, libva, the oneVPL GPU
# runtime). A fully-static ffmpeg fundamentally cannot dlopen the iHD driver, so
# `h264_qsv` could never create its VAAPI child device ("No supported child
# device type is enabled") and the service silently fell back to libx264 on a
# weak 6-thread CPU. jellyfin-ffmpeg bundles ffmpeg + iHD + libva + oneVPL under
# /usr/lib/jellyfin-ffmpeg and is purpose-built for self-hosted Intel transcode.
# Hardware encode ALSO requires /dev/dri/renderD128 mapped in and the process in
# the render node's group — both wired in docker-compose.yml. Without the device
# the binary still runs everything on the CPU (graceful: boot smoke-test demotes
# QSV→libx264), so the image is safe even on a box with no iGPU.

FROM rust:1.96-slim-bookworm@sha256:b5f842fac1e3b4ff718a652a8e0173b62d9403ec826ef4998880b9347db30684 AS builder

WORKDIR /build

# Workspace resolution needs every member manifest present. Copying the
# whole crates/ tree is simplest; .dockerignore already excludes target/.
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates

RUN cargo build --release -p transcoder

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb AS runtime

WORKDIR /srv

# jellyfin-ffmpeg, version- and sha256-pinned (supply chain). curl serves both
# the HEALTHCHECK (audit 9-0) and the .deb download (follows GitHub's redirect to
# the release object). The .deb's own dependencies (libva, intel-media-driver
# runtime bits, etc.) resolve from the bookworm repos via `apt-get install`.
# Then create a non-root user that owns /scratch (where ffmpeg writes HLS
# segments).
ARG JF_VERSION=7.1.4-3
ARG JF_SHA256=0cf62bc2423822c9ec7a38dbc8f526d9a58671bd01843daa7817ece35619fc1c
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /tmp/jf.deb "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${JF_VERSION}/jellyfin-ffmpeg7_${JF_VERSION}-bookworm_amd64.deb" \
 && echo "${JF_SHA256}  /tmp/jf.deb" | sha256sum -c - \
 && apt-get install -y --no-install-recommends /tmp/jf.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/jf.deb \
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
ENV TRANSCODER_FFMPEG_BIN=/usr/lib/jellyfin-ffmpeg/ffmpeg
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
