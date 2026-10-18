# Multi-stage build for the recommender (crates/recommender, bin eex-recommender):
# /score, /events/*, /metrics/funnel and the in-process jobs (03:30 optimizer,
# 04:00 TMDB changes then featurize, hourly retention + ranker warm).
#
# Build context is the REPO ROOT (see docker-compose.yml) so cargo resolves the
# full workspace: the recommender depends on media-core and emerald-contracts.
# CI builds this image; the NAS never compiles it.

FROM rust:1.98-slim-bookworm@sha256:ff521445a372125ed4f76e1453a1f8098f2d05332d1601d30db1c1f62757e730 AS builder

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
 && cargo build --release -p recommender --bin eex-recommender \
 && cp /build/target/release/eex-recommender /usr/local/bin/eex-recommender

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

WORKDIR /srv

# ca-certificates: TLS to TMDB and Anthropic. curl: the HEALTHCHECK. gosu: the
# entrypoint chowns the bind-mounted /data as root, then drops to uid 10001.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gosu \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /srv/minilm \
 && groupadd --system --gid 10001 recommender \
 && useradd --system --uid 10001 --gid recommender --home-dir /srv --no-create-home recommender \
 && chown -R recommender:recommender /data /srv

# all-MiniLM-L6-v2 at the pinned revision c9745ed, sha256-checked at build time
# (Dockerfile frontend >= 1.6). /srv/minilm is created above and the files are
# owned by uid 10001: with ADD creating the dir itself, the first CI image gave
# uid 10001 EACCES on config.json. Same files the Python image downloaded into
# /data/hf-cache at featurize time; `eex-recommender verify-embedding` proves
# them against the committed baseline in CI.
ARG MINILM=https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/c9745ed1d9f207416be6d2e6f8de32d1f16199bf
ADD --chown=10001:10001 --chmod=644 --checksum=sha256:953f9c0d463486b10a6871cc2fd59f223b2c70184f49815e7efbcab5d8908b41 ${MINILM}/config.json /srv/minilm/config.json
ADD --chown=10001:10001 --chmod=644 --checksum=sha256:be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037 ${MINILM}/tokenizer.json /srv/minilm/tokenizer.json
ADD --chown=10001:10001 --chmod=644 --checksum=sha256:53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db ${MINILM}/model.safetensors /srv/minilm/model.safetensors

COPY --from=builder /usr/local/bin/eex-recommender /usr/local/bin/eex-recommender
COPY --chmod=755 crates/recommender/docker-entrypoint.sh /usr/local/bin/recommender-entrypoint

ENV RECOMMENDER_DB_PATH=/data/exchange.db
ENV RECOMMENDER_MODEL_DIR=/srv/minilm

# Fixed listen address 0.0.0.0:8000; compose publishes it to the host loopback.
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

ENTRYPOINT ["/usr/local/bin/recommender-entrypoint"]
CMD ["eex-recommender"]
