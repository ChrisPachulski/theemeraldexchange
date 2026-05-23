FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Copy package source before `pip install .` so hatchling's
# wheel build (which packages `app` and `workers` per pyproject) can
# find the directories it needs. Otherwise the build fails on a fresh
# image with "directory not found".
COPY pyproject.toml ./
COPY app ./app
COPY workers ./workers
COPY migrations ./migrations
RUN pip install --upgrade pip && pip install .

ENV RECOMMENDER_DB_PATH=/data/exchange.db \
    RECOMMENDER_HOST=0.0.0.0 \
    RECOMMENDER_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
