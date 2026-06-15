# Multi-stage build for the transcoder (M4) Rust service.
#
# Stage 1 (builder): compiles the `transcoder` binary from the Rust
# workspace. Build context is the REPO ROOT (see docker-compose.yml) so
# cargo resolves the full workspace — transcoder depends on the
# media-core + emerald-contracts crates.
#
# Stage 2 (runtime): debian-slim + Debian's stock ffmpeg + Intel VAAPI stack.
# The transcoder spawns `ffmpeg` per session (tokio::process), so the
# binary MUST be present at runtime. The Rust binary is glibc-linked, so
# the runtime base matches the bookworm builder.
#
# ffmpeg provisioning — Debian's OWN ffmpeg, NOT mwader/static-ffmpeg (history):
# Intel hardware H.264 encode (§4.4) needs a DYNAMICALLY-linked ffmpeg with VAAPI
# plus the Intel runtime stack (the iHD driver + libva). A fully-static ffmpeg
# fundamentally cannot dlopen the iHD driver, so a hardware encoder could never
# open its device and the service silently fell back to libx264 on a weak
# 6-thread CPU. We use Debian's stock `ffmpeg` (built with --enable-vaapi) plus
# `intel-media-va-driver` (the iHD driver) and `libva` — all from the official
# Debian repos, no third-party/vendor build — and encode via VAAPI (h264_vaapi),
# the native Linux video API. Hardware encode ALSO requires /dev/dri/renderD128
# mapped in and the process in the render node's group — both wired in
# docker-compose.yml. Without the device the binary still runs everything on the
# CPU (graceful: the boot smoke-test demotes VAAPI→libx264), so the image is safe
# even on a box with no iGPU.

FROM rust:1.96-slim-bookworm@sha256:b5f842fac1e3b4ff718a652a8e0173b62d9403ec826ef4998880b9347db30684 AS builder

WORKDIR /build

# Workspace resolution needs every member manifest present. Copying the
# whole crates/ tree is simplest; .dockerignore already excludes target/.
COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates

# Compile-parallelism cap for constrained / shared hosts. The NAS deploy passes
# --build-arg CARGO_BUILD_JOBS=2 (via docker-compose build.args) so a rebuild
# uses at most N of the box's cores and CANNOT pin the CPU and starve co-tenant
# services (Plex shares this host). Unset (CI / dev) = cargo's default (all
# cores). A real prior incident: an uncapped rebuild drove load to 73 on the
# 6-thread NAS and brown-outed Plex for ~13 minutes.
# NOTE: compose interpolates an unset CARGO_BUILD_JOBS to an EMPTY string, and
# cargo reads this env var natively — empty is a parse error, so the RUN below
# normalizes empty → unset (cargo default) before building.
ARG CARGO_BUILD_JOBS
# BuildKit cache mounts make rebuilds INCREMENTAL: the compiled-dependency
# `target/` and the downloaded crate `registry/` persist across builds, so a
# source change recompiles only the handful of changed crates (~1-2 min, light)
# instead of the whole 400-crate workspace from cold (~20-30 min, the load storm
# that brown-outed Plex). The cache mounts are NOT part of the image layer, so
# the built binary is copied OUT to a normal path for the runtime stage to grab.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/build/target,sharing=locked \
    if [ -z "${CARGO_BUILD_JOBS:-}" ]; then unset CARGO_BUILD_JOBS; fi \
 && cargo build --release -p transcoder \
 && cp /build/target/release/transcoder /usr/local/bin/transcoder-bin

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

WORKDIR /srv

# ffmpeg + the Intel VAAPI runtime, all from the official Debian repos:
#   ffmpeg                 — built with --enable-vaapi (provides h264_vaapi)
#   intel-media-va-driver  — the iHD VA driver for Gen graphics (Alder Lake)
#   libva2 / libva-drm2    — the VAAPI userspace the driver plugs into
# curl is retained for the container HEALTHCHECK (audit 9-0). Then create a
# non-root user that owns /scratch (where ffmpeg writes HLS segments).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg intel-media-va-driver libva2 libva-drm2 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /scratch \
 && groupadd --system --gid 10003 transcoder \
 && useradd --system --uid 10003 --gid transcoder --home-dir /srv --no-create-home transcoder \
 && chown -R transcoder:transcoder /scratch /srv

# From the persisted copy made in the builder (the `target/` cache mount that
# produced it is ephemeral and not present in the builder layer).
COPY --from=builder /usr/local/bin/transcoder-bin /usr/local/bin/transcoder

# Bind 0.0.0.0 inside the container so media-core/backend can reach it over
# the docker network; compose publishes the port to the host loopback only.
# Pin the port explicitly so the published port and the binary default match
# (binary default is 8090; we run on 8003).
ENV TRANSCODER_HOST=0.0.0.0
ENV TRANSCODER_PORT=8003
ENV TRANSCODER_FFMPEG_BIN=/usr/bin/ffmpeg
ENV TRANSCODER_TMP_DIR=/scratch
# Pin the Intel iHD VA driver (the package also ships the legacy i965). VAAPI
# device open fails closed → the boot smoke-test demotes to libx264 if absent.
ENV LIBVA_DRIVER_NAME=iHD

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
