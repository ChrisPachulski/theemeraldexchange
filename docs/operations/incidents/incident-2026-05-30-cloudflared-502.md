# Incident — public API 502 after tunnel moved to compose bridge (2026-05-30)

**Status:** resolved
**Severity:** SEV-2 (public API down, SPA up)
**Fix commit:** `8e575d9` (docker-compose.yml: cloudflared `network_mode: service:backend`)

## Summary

The public API (`https://api.theemeraldexchange.com`) returned 502 while the SPA
(`https://theemeraldexchange.com`, Netlify) stayed up. The backend container was
healthy the whole time (`curl http://127.0.0.1:3001/api/health` on the NAS →
`{"ok":true}`), but cloudflared could not reach it.

## Root cause

A prior hardening change (audit 9-7) removed `network_mode: host` from the
`exchange-cloudflared` service and put it on the compose **bridge** network. The
companion step it documented — repointing the dashboard ingress origin from
`http://localhost:3001` to `http://backend:3001` — was never applied.

On the bridge, `localhost` inside the cloudflared container is **cloudflared's
own container**, where nothing listens on :3001. So every proxied request failed:

```
ERR  Unable to reach the origin service ... dial tcp [::1]:3001: connect: connection refused
     originService=http://localhost:3001 ingressRule=0
```

The `[::1]:3001` in that log is cloudflared dialing **its own** empty loopback —
**not** an IPv4/IPv6 mismatch with the backend. (The Docker daemon on this host
has no IPv6 at all; `docker info` shows none.) The earlier "set the origin to
127.0.0.1 to force IPv4" theory in `cloudflare-tunnel.md` was wrong and has been
corrected.

## Fix

Set the cloudflared service to share the **backend's** network namespace:

```yaml
cloudflared:
  network_mode: "service:backend"
```

Now cloudflared's `localhost:3001` resolves to the backend's own listener, so the
unchanged dashboard origin (`http://localhost:3001`) works again — with **no
dashboard change** (it's a token tunnel; ingress is dashboard-managed and can't
be edited over SSH). It shares **only** the backend netns, never the host's, so
audit 9-7's security win holds: the host's loopback admin ports (recommender
:8001, media-core :8002, transcoder :8003, glitchtip :8100) stay unreachable
from a compromised tunnel image.

Applied on prod by recreating only the tunnel:

```sh
ssh root@theemeraldexchange.local \
  "cd /mnt/user/appdata/exchange-backend && docker compose up -d --no-deps --force-recreate cloudflared"
```

Verified: public API `/api/health` → 200, SPA → 200, `/api/iptv/categories` →
401 (backend answering through the tunnel, auth gate working), cloudflared
origin-errors = 0.

## ⚠️ Operational gotcha introduced by this fix

A `network_mode: service:backend` container's netns reference is bound to the
specific backend **container instance**. If the backend is recreated
(rebuild/redeploy/`up --force-recreate backend`), cloudflared's netns ref breaks
and the API 502s again **even though both containers show "Up"**. `depends_on`
only orders the *first* start; it does not re-link on later recreates.

**Always follow a backend recreate with:**

```sh
docker compose up -d --no-deps --force-recreate cloudflared
```

## Prevention

- When changing a service's network mode, change its dependents' origins/refs in
  the same commit — don't leave a "do this in the dashboard later" half-migration.
- Add the backend-recreate → cloudflared-restart step to the deploy runbook.
- After any deploy, verify the **public** API (not just the in-NAS backend):
  `https://api.theemeraldexchange.com/api/health` → 200.
