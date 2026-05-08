# Deploying The Emerald Exchange

Live deployment recipe. The current production install runs as a `nginx:alpine` container on port **8085** (because Caddy owns port 80 on the NAS already and proxies the legacy `/tv`, `/movies`, `/downloads` paths to the raw Sonarr/Radarr/SAB UIs). Reach the dashboard at `http://theemeraldexchange.local:8085`.

Two parts: a **one-time NAS setup** and **ongoing deploys** (`npm run build && ./scripts/deploy-nas.sh`).

---

## Architecture note: nginx vs the existing Caddy

The NAS already has Caddy on `:80`. The dashboard does not displace that; it runs in its own `nginx:alpine` container on a separate port. The Caddyfile is untouched, and your existing `theemeraldexchange.local/tv`, `/movies`, `/downloads` direct-app URLs keep working.

If you ever want the dashboard at the bare hostname (no port), the change is to extend the Caddyfile with new routes. That work is deferred (see V2 in the plan file).

---

## One-time NAS setup

Run these from a terminal that already has SSH access to `root@theemeraldexchange.local`.

### 1. Provision appdata

```bash
ssh root@theemeraldexchange.local 'mkdir -p /mnt/user/appdata/exchange-dashboard/{www,conf}'
```

### 2. Build the dashboard locally and ship `dist/`

```bash
cd ~/Documents/theemeraldexchange
npm run build
rsync -av --delete dist/ root@theemeraldexchange.local:/mnt/user/appdata/exchange-dashboard/www/
rsync -av nginx/default.conf root@theemeraldexchange.local:/mnt/user/appdata/exchange-dashboard/conf/default.conf.template
```

(Building locally avoids needing Node on the NAS.)

### 3. Start the container

This reads the API keys directly from the existing service configs on the NAS, so the values never appear in your shell history or transcript:

```bash
ssh root@theemeraldexchange.local '
  SONARR=$(grep -oE "<ApiKey>[^<]+" /mnt/user/appdata/sonarr/config.xml | head -1 | sed "s|<ApiKey>||")
  RADARR=$(grep -oE "<ApiKey>[^<]+" /mnt/user/appdata/radarr/config.xml | head -1 | sed "s|<ApiKey>||")
  SAB=$(awk -F"= *" "/^api_key/ {print \$2; exit}" /mnt/user/appdata/sabnzbd/sabnzbd.ini)

  docker rm -f exchange-dashboard 2>/dev/null

  docker run -d \
    --name exchange-dashboard \
    --restart unless-stopped \
    -p 8085:80 \
    -e SONARR_API_KEY="$SONARR" \
    -e RADARR_API_KEY="$RADARR" \
    -e SAB_API_KEY="$SAB" \
    -v /mnt/user/appdata/exchange-dashboard/www:/usr/share/nginx/html:ro \
    -v /mnt/user/appdata/exchange-dashboard/conf:/etc/nginx/templates:ro \
    nginx:alpine
'
```

The container uses the official `nginx:alpine` image, which auto-substitutes `${VAR}` references in `/etc/nginx/templates/*.template` against the container env at startup. That means the API keys exist only inside the container's process space; they never appear in the on-disk Nginx config.

### 4. Verify

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://10.0.0.52:8085/
curl -s -o /dev/null -w "Sonarr proxy: HTTP %{http_code}\n" http://10.0.0.52:8085/api/sonarr/api/v3/system/status
```

Both should return 200. Then in a browser: `http://theemeraldexchange.local:8085`.

If the dashboard loads but search 401s, run `docker exec exchange-dashboard env | grep API_KEY` to confirm the env vars made it in. If they're empty, redo step 3.

### 5. Optional: bring it under Unraid's UI

If you want to manage it via Unraid's container UI rather than `docker run`:

1. Settings → Docker → Add Container
2. **Name:** `exchange-dashboard`
3. **Repository:** `nginx:alpine`
4. **Network:** Bridge
5. **Port:** Container `80` → Host `8085`
6. **Path:** `/usr/share/nginx/html` ↔ `/mnt/user/appdata/exchange-dashboard/www` (Read Only)
7. **Path:** `/etc/nginx/templates` ↔ `/mnt/user/appdata/exchange-dashboard/conf` (Read Only)
8. **Variable:** `SONARR_API_KEY` = `<your sonarr key>`
9. **Variable:** `RADARR_API_KEY` = `<your radarr key>`
10. **Variable:** `SAB_API_KEY` = `<your sab key>`
11. Apply.

Now the container shows up in Unraid's Docker tab and starts on boot.

---

## Ongoing deploys

Once the container exists, every code change ships in one command:

```bash
cd ~/Documents/theemeraldexchange
./scripts/deploy-nas.sh
```

That script:

1. Runs `npm run build` locally.
2. Rsyncs `dist/` → `/mnt/user/appdata/exchange-dashboard/www/`.
3. Rsyncs `nginx/default.conf` → `/mnt/user/appdata/exchange-dashboard/conf/default.conf.template`.
4. Restarts the container so any nginx config changes take effect.

If you only changed React code (not `nginx/default.conf`), the container restart is technically unnecessary — Nginx serves the new `dist/` immediately. The script restarts anyway to keep things deterministic.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 502 Bad Gateway on `/api/sonarr/*` | Nginx can't reach the upstream | The proxy targets are already pinned to the LAN IP `10.0.0.52`. Confirm Sonarr/Radarr/SAB are running with `docker ps` and that the NAS LAN IP hasn't changed. |
| 5-second delay on every request | Laptop's mDNS resolver is timing out unicast DNS before falling back | Add `10.0.0.52 theemeraldexchange.local` to `/etc/hosts`, or use `http://10.0.0.52:8085` directly. This is a laptop network setting, not the dashboard. |
| 401 from `/api/sonarr/*` | API key env var missing or wrong | `docker exec exchange-dashboard env \| grep API_KEY` to confirm; redeploy with the right key |
| Dashboard loads but tabs are empty | Network proxies fine but service is unhealthy | Open Sonarr / Radarr / SAB directly on their original ports to confirm they're up |
| Mobile Safari shows nothing | Stale service worker / bad cache | Force-refresh; we don't ship a service worker in V1 |
| Brother needs remote access | Tailscale routing not yet set up | Deferred to V2 — see plan file |

---

## Updating the API keys later

If you regenerate a key in Sonarr/Radarr/SAB:

```bash
ssh root@theemeraldexchange.local "docker stop exchange-dashboard && docker rm exchange-dashboard"
```

Then re-run the `docker run` from step 3 with the new key.

(If you set them up via the Unraid UI in step 5, just edit the variable in the container's settings page and apply.)
