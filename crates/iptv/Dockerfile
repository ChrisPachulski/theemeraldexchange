# Multi-stage build for the iptv Rust service (live TV, EPG, DVR).
#
# Build context is the REPO ROOT (see docker-compose.yml) so cargo resolves the
# full workspace: iptv depends on media-core and emerald-contracts.
#
# Runtime: debian-slim + Debian's stock ffmpeg (libx264 included). The service
# spawns ffmpeg for the AVPlayer live remux (and the H.264 re-encode of non-H.264
# channels), feed-check captures and DVR recordings. CPU encode only: the iGPU
# belongs to the transcoder. CI builds this image; the NAS never compiles it.

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
 && cargo build --release -p iptv \
 && cp /build/target/release/iptv /usr/local/bin/iptv-bin

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

WORKDIR /srv

# ca-certificates: ffmpeg verifies the provider's TLS through the egress proxy's
# CONNECT tunnel. curl: the HEALTHCHECK. /data holds iptv.db, recordings and
# snapshots (a volume at runtime).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data \
 && groupadd --system --gid 10004 iptv \
 && useradd --system --uid 10004 --gid iptv --home-dir /srv --no-create-home iptv \
 && chown -R iptv:iptv /data /srv

COPY --from=builder /usr/local/bin/iptv-bin /usr/local/bin/iptv

# 0.0.0.0 so the backend reaches it over the docker network; compose publishes
# the port to the host loopback only.
ENV IPTV_HOST=0.0.0.0
ENV IPTV_PORT=8004
ENV IPTV_FFMPEG_BIN=/usr/bin/ffmpeg
ENV IPTV_DB_PATH=/data/iptv.db
ENV DVR_DIR=/data/recordings
ENV DB_BACKUP_DIR=/data/backups
# Remux and capture scratch: a tmpfs in compose.
ENV IPTV_REMUX_TMP_DIR=/tmp/iptv-remux

EXPOSE 8004

USER iptv

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8004/healthz || exit 1

CMD ["iptv"]
