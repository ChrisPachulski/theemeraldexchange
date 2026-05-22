PY ?= python
DB ?= ./data/exchange.db
HOST ?= 127.0.0.1
PORT ?= 8000

.PHONY: install serve migrate ingest-bootstrap ingest-changes featurize optimize test fmt

install:
	$(PY) -m pip install -e '.[dev]'

migrate:
	RECOMMENDER_DB_PATH=$(DB) $(PY) -m app.db --migrate

serve:
	RECOMMENDER_DB_PATH=$(DB) uvicorn app.main:app --host $(HOST) --port $(PORT) --reload

ingest-bootstrap:
	RECOMMENDER_DB_PATH=$(DB) $(PY) -m workers.tmdb_ingest --mode bootstrap

ingest-changes:
	RECOMMENDER_DB_PATH=$(DB) $(PY) -m workers.tmdb_ingest --mode changes

featurize:
	RECOMMENDER_DB_PATH=$(DB) $(PY) -m workers.featurize

optimize:
	RECOMMENDER_DB_PATH=$(DB) $(PY) -m workers.optimizer

test:
	pytest -q

fmt:
	ruff check --fix .
	ruff format .
