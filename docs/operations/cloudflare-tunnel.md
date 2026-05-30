# Cloudflare Tunnel — operations

The public site (`https://theemeraldexchange.com` + `https://api.theemeraldexchange.com`)
is served through a Cloudflare Tunnel run by the `exchange-cloudflared` container.

## Topology

```
browser ─► Cloudflare edge ─► cloudflared (shares backend netns) ─► backend :3001
```

- The tunnel is a **token tunnel**: its ingress rules live in the Cloudflare
  Zero Trust dashboard, **not** in a local config file. The container is started
  with `tunnel --no-autoupdate run` and a `TUNNEL_TOKEN` env var. You cannot edit
  the origin over SSH — only in the dashboard.
- The dashboard ingress origin is `http://localhost:3001`.
- The SPA is served by Netlify; only the API hostname is proxied to the NAS
  through this tunnel. (The apex/`www` records are Netlify; `api` is the tunnel.)

## How cloudflared reaches the backend: shared network namespace

cloudflared runs with **`network_mode: "service:backend"`** in
`docker-compose.yml`, i.e. it shares the backend container's network namespace.
That makes `localhost:3001` inside cloudflared resolve to the backend's own
listener — matching the dashboard origin (`http://localhost:3001`) with no
dashboard change.

This is deliberate (commit `8e575d9`). It replaced an earlier `network_mode: host`
setup (audit 9-7 removed host networking so a compromised tunnel image can't reach
the host's loopback admin ports — recommender :8001, media-core :8002, transcoder
:8003, glitchtip :8100). `service:backend` shares **only** the backend's netns,
never the host's, so that security property is preserved while the tunnel still
reaches the backend.

> **Do not** revert to `network_mode: host` to "fix" a 502 — that re-opens the
> admin-port exposure audit 9-7 closed. And do not point the origin at
> `http://backend:3001` unless you also change `network_mode` (on a shared netns
> there is no `backend` DNS name; on the bridge there is no `localhost` backend).

## ⚠️ A backend recreate breaks the tunnel — restart cloudflared after

A `service:backend` netns reference is bound to the specific backend **container
instance**. If the backend is recreated (rebuild / redeploy /
`up --force-recreate backend`), cloudflared's netns ref breaks and the API 502s
**even though both containers show "Up"**. `depends_on` only orders the first
start; it does not re-link on later recreates.

**After any backend recreate, run:**

```sh
ssh root@theemeraldexchange.local \
  "cd /mnt/user/appdata/exchange-backend && docker compose up -d --no-deps --force-recreate cloudflared"
```

## Restart / recovery

Plain restart (does not re-link the netns — use the force-recreate above if the
backend was recreated):

```sh
ssh root@theemeraldexchange.local \
  "cd /mnt/user/appdata/exchange-backend && docker compose up -d --no-deps --force-recreate cloudflared"
```

## Triage: public API 502 but backend healthy

If `https://api.theemeraldexchange.com/api/health` is 502 but on the NAS
`curl http://127.0.0.1:3001/api/health` returns `{"ok":true}`:

1. `docker logs --tail 30 exchange-cloudflared` — look for
   `Unable to reach the origin service ... originService=http://localhost:3001`.
2. Confirm the tunnel shares the backend netns:
   `docker inspect --format '{{.HostConfig.NetworkMode}}' exchange-cloudflared`
   should print `container:<backend-id>`. If it prints a bridge network name
   (e.g. `exchange-backend_default`), the `network_mode: service:backend` line is
   missing or the tunnel was started before the backend — force-recreate it.
3. If the backend was just recreated, force-recreate cloudflared (above).

> A `dial tcp [::1]:3001: connect: connection refused` in the cloudflared log is
> cloudflared dialing **its own** empty loopback when it's NOT sharing the backend
> netns. It is **not** an IPv4/IPv6 backend mismatch — this host's Docker daemon
> has no IPv6. See `incidents/incident-2026-05-30-cloudflared-502.md`.
