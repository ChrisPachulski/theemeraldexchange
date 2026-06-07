# Glitchtip Setup Guide

Glitchtip is a **mandatory** service in the EEX stack. There is no telemetry-disabled
build option. Each self-hosted deployment runs its own Glitchtip instance; crash data
lives only on the operator's NAS and is never sent to any third-party processor.

This guide covers first-time setup. Complete all sections before starting the EEX stack
for the first time — or before upgrading an existing deployment that did not previously
include Glitchtip.

---

## 1. Generate secrets

Generate `GLITCHTIP_SECRET_KEY` and `GLITCHTIP_DB_PASSWORD` before running
`docker compose up` for the first time. If you run the stack without these set,
Glitchtip will start but its security model will be broken.

```bash
# Secret key for Django (Glitchtip backend)
openssl rand -base64 48

# Postgres password for the glitchtip user.
# Use hex, NOT base64: GLITCHTIP_DB_PASSWORD is interpolated raw into
# DATABASE_URL (postgres://glitchtip:<pw>@...), and base64's '+', '/', '='
# characters break URL parsing ("Port could not be cast to integer").
openssl rand -hex 24
```

Copy the outputs into your `.env.production` file:

```
GLITCHTIP_SECRET_KEY=<output of first command>
GLITCHTIP_DB_PASSWORD=<output of second command>
```

Set `GLITCHTIP_DOMAIN` to the URL through which Glitchtip will be reachable by
the apps. **Glitchtip 6.x requires a scheme** (`http://` or `https://`) — a bare
hostname fails boot with `ImproperlyConfigured: GLITCHTIP_DOMAIN must start with
http or https`. No trailing slash. Choose your access method first (§3) and then
come back to fill in this value. Example values:

- Tailscale: `https://glitchtip.myserver.ts.net`
- Public Caddy: `https://errors.yourdomain.com`

---

## 2. First boot and admin account

Start the stack:

```bash
./scripts/deploy-nas.sh
```

Wait for the `glitchtip` and `glitchtip-worker` containers to reach a healthy state
(watch via `docker compose logs -f glitchtip`). Glitchtip runs its database migrations
automatically on startup.

> **The first deploy is a two-step bootstrap.** `EEX_TELEMETRY_DSN` doesn't exist
> yet, so the backend intentionally crash-loops on this first run. The deploy
> script detects the unset DSN and **skips its health-gate/rollback** (it prints a
> bootstrap notice instead of tearing the stack down), so the Glitchtip services
> still come up healthy. Bring the stack up here, finish §3–§4 to create the
> project + DSN, set `EEX_TELEMETRY_DSN` in `.env.production`, then re-run
> `./scripts/deploy-nas.sh` — the second run health-gates the backend normally.

Access the Glitchtip web UI at the URL you configured in §3 (or temporarily via the
loopback port `http://127.0.0.1:8100` from the NAS itself for initial setup).

On first visit, register an admin account. Glitchtip does not ship with a default
password — you set one during this registration step. Use a strong password; this
account has full access to all crash reports.

> **Force a password change if you ever share login credentials.** The admin UI has
> no automatic forced-rotation, so this is a manual step.

---

## 3. Reverse-proxy and HTTPS

Apps send crash events to Glitchtip's ingest endpoint. That path can be LAN-only
(Tailscale) or internet-reachable (Caddy + public DNS). Either way, the apps need
HTTPS — the Sentry SDK refuses to send events to a plain-HTTP DSN in production mode.

**Do not port-forward port 8100 directly to the internet.** The Glitchtip admin UI
is on the same port as the ingest endpoint. Exposing it publicly gives anyone with
the admin password full access to all crash reports and user data.

### Option A: Tailscale (preferred)

Tailscale is the lowest-ops path. No public DNS record, no certificate renewal, no
firewall rules. Crash events stay on your private network — not reachable from the
internet at all.

1. Install Tailscale on your NAS if you have not already.
2. Enable Tailscale HTTPS (MagicDNS + HTTPS certificates):
   - In the Tailscale admin console, go to DNS → Enable HTTPS Certificates.
   - Note the MagicDNS hostname assigned to your NAS (e.g., `mynas.tail1234.ts.net`).
3. Serve Glitchtip through the Tailscale certificate using `tailscale serve`:

   ```bash
   tailscale serve --bg --https=443 --set-path /  http://127.0.0.1:8100
   ```

   This terminates TLS at the Tailscale layer and proxies to the local Glitchtip port.
4. Set `GLITCHTIP_DOMAIN` to your Tailscale MagicDNS hostname (no `https://`).
5. Your app DSN will look like:
   `https://<key>@mynas.tail1234.ts.net/<project-id>`

Apps on your Tailnet (including iOS/tvOS devices with Tailscale installed) can reach
this DSN. Apps not on your Tailnet silently fail to send telemetry — no crash in the app,
just no data received.

### Option B: Caddy + public DNS + HTTPS

Use this if you want crash events from any network, not just devices on your Tailnet.

1. Add a DNS A record pointing `errors.yourdomain.com` to your NAS's public IP (or use
   a CNAME to your Cloudflare Tunnel if you route through it).
2. Add a Caddyfile block on the NAS:

   ```
   errors.yourdomain.com {
       reverse_proxy 127.0.0.1:8100
   }
   ```

   Caddy fetches a Let's Encrypt certificate automatically. No manual renewal.
3. Set `GLITCHTIP_DOMAIN=errors.yourdomain.com` in `.env.production`.
4. Restart Caddy: `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`

> **Firewall note:** Only expose the HTTPS port (443). Do not expose port 8100 directly.
> The admin UI lives at the same origin as the ingest endpoint — port-forwarding 8100
> exposes admin to the public internet.

---

## 4. Create the EEX project and copy the DSN

1. Log in to the Glitchtip UI.
2. Create an **Organization** (e.g., `EEX`) if prompted.
3. Create a **Project** named `eex` (or any name you prefer). Select platform `Other`.
4. Go to Project Settings → DSN. Copy the DSN string. It looks like:
   `https://abc123@errors.yourdomain.com/1`
5. Paste the DSN into `.env.production`:

   ```
   EEX_TELEMETRY_DSN=https://abc123@errors.yourdomain.com/1
   ```

6. Redeploy the stack so the backend picks up `EEX_TELEMETRY_DSN`:

   ```bash
   ./scripts/deploy-nas.sh
   ```

The backend exposes `GET /api/telemetry/config` which returns the DSN to authenticated
clients at boot. Apps initialize their Sentry-compatible SDK with this value — no DSN
is baked into any app binary.

### SDK init requirement: `autoSessionTracking: false`

Every EEX SDK integration **must** disable session tracking on init:

| SDK | Setting |
|---|---|
| `@sentry/node` (Hono) | `autoSessionTracking: false` |
| `sentry-sdk` (Python recommender) | `auto_session_tracking=False` |
| `sentry-cocoa` (Swift/tvOS) | `options.enableAutoSessionTracking = false` |

Glitchtip does not implement the Sentry sessions API. Session envelopes are silently
accepted by the ingest endpoint and then discarded. Omitting this flag wastes SDK
bandwidth on every app launch and adds noise when debugging delivery pipelines.
It does not cause errors visible to users, but it will cause confusion when comparing
session counts against error counts during incident review.

---

## 5. Verify the integration

After the full stack is up and `EEX_TELEMETRY_DSN` is set:

1. Open the EEX web app and sign in.
2. Trigger a test event (or wait for real usage).
3. Check the Glitchtip UI — you should see events appearing in the `eex` project within
   a few seconds of an error occurring in the app.

To send a test event manually from the NAS:

```bash
curl -X POST "https://<key>@${GLITCHTIP_DOMAIN}/<project-id>/store/" \
  -H "Content-Type: application/json" \
  -d '{"message":"test event from setup guide","level":"info"}'
```

A `200` response and a new event in the Glitchtip UI confirms the pipeline is working.

---

## 6. Retention and disk usage

The `glitchtip-worker` container runs retention sweeps automatically using
django-vtasks (Celery was replaced in v6.0). Default retention is 90 days.

Crash events are stored in the `glitchtip-postgres` Docker volume. On a busy deployment
this can grow; check disk usage periodically:

```bash
docker system df -v | grep glitchtip-postgres
```

To adjust retention, log in to the Glitchtip UI and go to Organization Settings →
Event Retention. Lower the value if disk is constrained.

---

## 7. Upgrading Glitchtip

The docker-compose.yml pins both images to a specific tag (e.g., `6.1`). Note the
6.x tags dropped the `v` prefix used by 5.x and earlier — `glitchtip/glitchtip:v6.1`
does not exist on Docker Hub; the published tag is `6.1`. **Do not switch to
`latest` — Glitchtip has had breaking env var changes at every major version.**
Check the Glitchtip release notes before bumping the tag.

To upgrade to a new version:

1. Read the release notes at `https://glitchtip.com/blog/` for any breaking changes
   (new required env vars, removed env vars, schema migrations).
2. Update the image tag in `docker-compose.yml` for both `glitchtip` and
   `glitchtip-worker` services.
3. Pull and restart:

   ```bash
   docker compose pull glitchtip glitchtip-worker
   docker compose up -d glitchtip glitchtip-worker
   ```

Glitchtip runs database migrations automatically on startup. No manual migration step
is required for minor upgrades.

---

## 8. Troubleshooting

**Events not appearing in the UI**
- Confirm `EEX_TELEMETRY_DSN` is set in `.env.production` and the stack was restarted.
- Check `docker compose logs glitchtip-worker` for django-vtasks errors.
- Verify the DSN hostname resolves and the HTTPS certificate is valid from the device
  sending events.

**`glitchtip` container exits immediately**
- `SECRET_KEY` or `GLITCHTIP_DB_PASSWORD` is likely blank. Confirm they are set in
  `.env.production` and re-run `docker compose up -d`.

**Postgres connection refused**
- `glitchtip-db` may still be initializing. Run `docker compose logs glitchtip-db`
  and wait for "database system is ready to accept connections" before starting the
  `glitchtip` web container.

**`glitchtip-worker` crashes with `FATAL: database "glitchtip" does not exist`**
- The Postgres volume may be corrupted or the password changed since the volume was
  created. Stop the stack, delete the `glitchtip-postgres` volume
  (`docker volume rm <project>_glitchtip-postgres`), and restart — Glitchtip will
  recreate the schema on next boot. **This deletes all stored crash data.**
