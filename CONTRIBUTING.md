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
  (`crates/gateway`, `crates/auth`, `crates/media-core`, `crates/iptv`, `crates/transcoder`, `crates/recommender`, the
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
npm run hooks:install   # pre-push: rustfmt/clippy + tsc/eslint on what you push
npm run lint              # eslint .
npm run build             # tsc -b && vite build
npm test                  # vitest run
npm run test:coverage     # vitest run --coverage
npm run test:e2e          # playwright test --project=chromium
npm run test:e2e:integration
npm run test:e2e:playback
```

Rust workspace (the recommender included):

```bash
cargo test --workspace
```

These are the same commands documented in `README.md` under
[Build & test](./README.md#build--test) and defined in `package.json`
`scripts`; there is no separate CI-only test path.
