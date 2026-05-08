# The Emerald Exchange

A unified media dashboard at `http://theemeraldexchange.local:8085` that replaces the operator-grade UIs of Sonarr, Radarr, and SAB. One bookmark. Find a show, find a movie, see what's downloading, open Plex.

Port 8085 because Caddy already owns port 80 on the NAS and is reverse-proxying the legacy `/tv`, `/movies`, `/downloads` paths to the raw apps. Both pathways coexist; the dashboard does not displace what was there.

## Stack

- **React 19 + Vite + TypeScript** — fastest static-build path; Impeccable design via the project-local skill at `.claude/skills/impeccable/`
- **TanStack Query** — caching, polling, mutations
- **Nginx** (Docker) — serves the static dashboard and reverse-proxies the *arr / SAB APIs at same-origin paths, injecting API keys server-side so they never reach the browser

## Surface

```
Watch (→ Plex)   ·   TV   ·   Movies   ·   Downloads
```

Four tabs. No admin/family split. Destructive actions (pause, cancel, remove from library) gate behind a confirmation modal. The dashboard is the experience; underlying *arr / SAB UIs are not promoted or linked from inside it.

## Project files

- `PRODUCT.md` — Impeccable gate. Audience, tone, anti-references, strategic principles.
- `DESIGN.md` — Impeccable gate. OKLCH palette, type scale, motion easing, spacing rhythm.
- `DEPLOY.md` — One-time NAS setup + ongoing deploys.
- `nginx/default.conf` — Production Nginx with API-key-injecting reverse proxies.
- `Dockerfile` — `nginx:alpine` + envsubst.
- `scripts/deploy-nas.sh` — `npm run build && rsync && docker restart`.

## Local development

1. Copy `.env.example` to `.env.local`. Fill in `SONARR_API_KEY`, `RADARR_API_KEY`, `SAB_API_KEY`. Pull them via:
   ```bash
   ssh root@theemeraldexchange.local 'grep -h "ApiKey\|api_key" /mnt/user/appdata/sonarr/config.xml /mnt/user/appdata/radarr/config.xml /mnt/user/appdata/sabnzbd/sabnzbd.ini'
   ```
2. `npm install`
3. `npm run dev`
4. Open `http://localhost:5173`. The Vite dev server proxies `/api/sonarr`, `/api/radarr`, `/api/sab` to the NAS and injects the keys, mirroring what Nginx does in production.

## Production deploy

See [DEPLOY.md](./DEPLOY.md). Short version after first-time setup:

```bash
./scripts/deploy-nas.sh
```

## Design contract

- Color: Committed (one emerald accent at ~30 to 40% surface coverage; neutrals tinted toward the same hue)
- Theme: dark (no light theme in V1)
- No `#000` / `#fff`, no gradient text, no side-stripe borders, no card-grid monotony, no em dashes in copy
- Motion: ease-out-quint, 140 to 220ms; reduced-motion respected
- Native `<dialog>` for modals (free focus trap and ESC); Enter never submits destructive actions

See `DESIGN.md` for the full token set.

## Phases shipped (V1)

1. **Foundation** — scaffold, Impeccable install, Nginx proxy, API skeletons
2. **Shell** — top nav, tab router, ConfirmModal primitive (`useConfirm` hook)
3. **TV tab** — Sonarr search-as-you-type, In Library badge, AddSeriesModal, remove flow
4. **Movies tab** — Radarr mirror of TV
5. **Downloads tab** — SAB live queue, pause/resume/cancel, history strip
6. **Polish** — em-dash audit, lint, mobile responsiveness, motion tokens
7. **Deploy** — Docker container, deploy script, deploy guide

## Out of scope (V1)

Episode picker, calendar, settings panel, Tautulli stats, home tab widgets, Netlify production deploy. Deferred to V2 once the dashboard proves it has legs. Plan file at `~/.claude/plans/instead-could-we-robust-journal.md`.
