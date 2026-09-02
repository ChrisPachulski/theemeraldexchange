# Contributing

The Emerald Exchange is proprietary, source-visible software (see
[LICENSE](./LICENSE)). The repository is public so the self-host installer
can fetch `selfhost/install.sh` directly and so the source is readable, not
because it is open for outside contribution.

## Code contributions

External code contributions are not accepted. There is no public issue
tracker for feature requests and no pull request process for this repo.
Reading the source, running your own instance, and reporting bugs are all
welcome; opening a PR is not the path for changes.

## Bug reports and security reports

- **Security issues** (auth, session, token, invite, or admin-gate bypasses;
  anything exploitable): follow [SECURITY.md](./SECURITY.md) and email
  **pachun95@gmail.com** directly. Do not open a public issue for anything
  exploitable.
- **Non-security bugs**: email the same address with the affected component
  (`server/`, `crates/media-core`, `crates/transcoder`, `recommender/`, the
  SPA, or the Apple app) and reproduction steps.

## Running your own instance

If you are standing up your own Emerald server rather than reporting a bug
against this one, start with [DEPLOY.md](./DEPLOY.md) and the
[`selfhost/`](./selfhost/) bundle (`selfhost/install.sh`,
`selfhost/docker-compose.yml`), pull-based multi-arch images, no build
required. `README.md` covers the quickstart and the full capability matrix.

## How the maintainer runs the suites locally

From the repository root (Node 26, see `package.json` → `engines.node`):

```bash
npm install
npm run lint              # eslint .
npm run build             # tsc -b && vite build && tsc -p server/tsconfig.json
npm test                  # vitest run
npm run test:coverage     # vitest run --coverage
npm run build:napi        # crates/emerald-contracts-napi binding
npm run test:e2e          # playwright test --project=chromium
npm run test:e2e:integration
npm run test:e2e:playback
```

Rust workspace and recommender:

```bash
cargo test -p emerald-contracts -p media-core -p transcoder

cd recommender
uv sync --extra dev
uv pip install --python .venv/bin/python maturin
.venv/bin/maturin develop --release -m ../crates/emerald-contracts-pyo3/Cargo.toml
uv run pytest
```

These are the same commands documented in `README.md` under
[Build & test](./README.md#build--test) and defined in `package.json`
`scripts`; there is no separate CI-only test path.
