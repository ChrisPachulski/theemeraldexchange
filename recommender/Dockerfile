# Multi-stage build.
#
# Stage 1 produces the emerald-contracts PyO3 wheel that recommender's
# sub_validation.py imports. Without this, the recommender silently
# degrades to a pass-through validator in prod (the warning logs at
# import but the boundary gate is a no-op). CI proves the wheel builds;
# this Dockerfile is what makes the prod image actually carry it.
#
# Build context = repo root (see docker-compose.yml's recommender
# `build.context: .` + `build.dockerfile: ./recommender/Dockerfile`).
# That's required because the crate sources live at crates/ — they
# can't be reached from a context rooted at recommender/.

# ─── Stage 1: build the emerald_contracts PyO3 wheel ─────────────────────────
FROM rust:1.97-slim-bookworm@sha256:99e09cb2284e2ddbb73a995deee3e91783fd04d177602ccf6eab326d778ee777 AS rust-builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# python + maturin are the build-side toolchain. Pinning maturin matches
# the version range crates/emerald-contracts-pyo3/pyproject.toml declares.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/maturin-venv \
 && /opt/maturin-venv/bin/pip install --upgrade pip \
 && /opt/maturin-venv/bin/pip install 'maturin>=1.7,<2.0'

WORKDIR /build

# Copy the workspace manifest + lock + LICENSE first so cargo can resolve
# member dependencies. license-file.workspace = true means cargo reads
# LICENSE at build time.
COPY Cargo.toml Cargo.lock LICENSE ./

# All workspace members must be present for cargo to resolve the
# workspace — even though we only build the pyo3 crate here. Copying the
# sibling crates is cheap (Rust source only) and avoids needing to
# patch the workspace manifest at build time.
COPY crates/emerald-contracts ./crates/emerald-contracts
COPY crates/emerald-contracts-napi ./crates/emerald-contracts-napi
COPY crates/emerald-contracts-pyo3 ./crates/emerald-contracts-pyo3
COPY crates/media-core ./crates/media-core
COPY crates/transcoder ./crates/transcoder

# `maturin build -m <crate>/Cargo.toml --release` produces an abi3 wheel
# under crates/emerald-contracts-pyo3/target/wheels/. --out redirects the
# wheel to a known dir so stage 2 can COPY without knowing the version.
# --release uses the workspace's [profile.release] (lto=thin, strip=true)
# so the .so is compact.
RUN /opt/maturin-venv/bin/maturin build \
      --release \
      -m crates/emerald-contracts-pyo3/Cargo.toml \
      --out /wheels

# ─── Stage 2: runtime image ──────────────────────────────────────────────────
FROM python:3.12-slim@sha256:090ba77e2958f6af52a5341f788b50b032dd4ca28377d2893dcf1ecbdfdfe203 AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gosu \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 recommender \
 && useradd --system --uid 10001 --gid recommender --home-dir /srv --no-create-home recommender

# Install the PyO3 wheel BEFORE the recommender package. Putting it on
# its own layer means a recommender source change (the common case)
# doesn't bust the wheel-install layer cache, and a wheel rebuild
# doesn't bust the recommender deps layer.
COPY --from=rust-builder /wheels /tmp/wheels
RUN pip install --upgrade pip && pip install /tmp/wheels/*.whl && rm -rf /tmp/wheels

# Copy package source. Paths are repo-root-relative because the build
# context shifted from ./recommender to . — see the comment at the top
# of this file.
COPY recommender/pyproject.toml ./
COPY recommender/app ./app
COPY recommender/workers ./workers
COPY recommender/migrations ./migrations
# eval/ ships the holdout generator (build_holdout.py) and the
# example holdout. pyproject.toml intentionally does NOT include
# eval in the wheel — it's an operator utility, not part of the
# runtime service surface — but the documented production recipe
# (DEPLOY.md: docker exec exchange-recommender python -m eval.build_holdout)
# expects to import it from CWD=/srv, so the directory must still
# land in the image.
COPY recommender/eval ./eval
COPY recommender/docker-entrypoint.sh /usr/local/bin/recommender-entrypoint
# Reproducible install from the committed lock (recommender/requirements.lock),
# pinned to a CI-proven compatible resolved set. This replaces the old
# `pip install .` that re-resolved pyproject's `>=` floors on every build (so
# every rebuild silently drifted) and the bare `pip install torch` that pulled
# whatever CPU torch was newest.
#
# torch is pinned to the CPU build (`+cpu`) in the lock; it only resolves from
# PyTorch's CPU index, added here as an extra index so torch comes from there
# and everything else from PyPI. The CPU build keeps the ~6GB CUDA/nvidia stack
# (cublas, cudnn, triton, nccl, …) out of the image — the NAS has no GPU and it
# overran the build disk (ENOSPC).
COPY recommender/requirements.lock ./requirements.lock
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.lock
# Install the local package itself WITHOUT re-resolving deps (already pinned and
# installed above), so the lock — not pyproject's floors — governs the build.
RUN pip install --no-deps .
RUN mkdir -p /data /data/hf-cache \
 && chown -R recommender:recommender /srv /data \
 && chmod 755 /usr/local/bin/recommender-entrypoint

ENV RECOMMENDER_DB_PATH=/data/exchange.db \
    RECOMMENDER_HOST=0.0.0.0 \
    RECOMMENDER_PORT=8000 \
    HF_HOME=/data/hf-cache

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

ENTRYPOINT ["/usr/local/bin/recommender-entrypoint"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
