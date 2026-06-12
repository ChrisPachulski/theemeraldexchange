
# Deploy Pipeline — Teaching Dossier

---

## 1. WHAT

"Deploying" means getting the code that lives on your laptop into the places where real users can reach it. The Emerald Exchange has two separate places code lives in production: the **frontend** (the React web app, what you see in a browser) lives on Netlify's global servers, and the **backend** (the Hono API, plus Rust media-core/transcoder, plus Python recommender) lives in Docker containers on your personal NAS at home. Whenever you `git push` to the `main` branch, Netlify automatically picks up any changes to the web app and rebuilds it — no manual step needed. But the backend never auto-deploys; you always run `scripts/deploy-nas.sh` yourself, which SSHes into your NAS, copies the new code, rebuilds the Docker images, restarts the containers, and confirms everything is healthy before it claims success.

---

## 2. WHY

**Why does the SPA auto-deploy but the backend doesn't?**
Netlify is a specialized hosting platform whose entire job is watching a GitHub repo and publishing static web builds. Connecting it to the repo is a one-time UI step; after that every push triggers a Netlify build for free, with zero server to manage. The SPA has no secrets, no stateful data, no LAN dependencies — it's just HTML + JS files.

**Why can't the backend live on Netlify too?**
The backend needs to talk to Sonarr, Radarr, and SABnzbd, which are on your home LAN and are not reachable from the public internet (by design). A Netlify Function or any public cloud host simply cannot reach `http://sonarr.local`. The backend has to live where those services live — on the NAS.

**Why Docker on the NAS instead of running Node directly?**
Every other service on the NAS (Sonarr, Radarr, Plex, qBittorrent) is already a Docker container managed by Unraid. Docker keeps env vars scoped inside the container, makes rollback as simple as swapping an image tag, and means the deploy process is identical no matter what Node version or Rust version the host OS happens to have.

**Why Cloudflare Tunnel instead of opening a port on your router?**
Port-forwarding 3001 to the internet would expose your NAS's IP address to every scanner on the internet. The Cloudflare Tunnel runs a tiny `cloudflared` container that makes an *outbound* connection to Cloudflare's edge; Cloudflare then terminates HTTPS from the world and forwards requests through that tunnel to your backend. Your router's firewall never needs a hole poked in it, and your home IP is never revealed.

**Why does `cloudflared` share the backend's network namespace?**
The tunnel is configured with `network_mode: service:backend` in docker-compose.yml. This means cloudflared runs inside the backend container's network namespace, so when it looks up `localhost:3001` it finds the backend's own listener. This is safer than host networking: a compromised tunnel image on the host netns could reach every internal loopback port (:8001 recommender, :8002 media-core, :8003 transcoder, :8100 glitchtip). The tradeoff is that every time the backend container is *recreated* (new container ID = new netns), cloudflared's reference to the old netns breaks, and you must restart cloudflared.

---

## 3. MAP

### Key files

| Path | What it does |
|---|---|
| `/Users/cujo253/Documents/theemeraldexchange/scripts/deploy-nas.sh` | Full NAS deploy: validates env, stages from git archive, rsyncs to NAS, builds+starts containers, health-gates, drift-checks /api/version |
| `/Users/cujo253/Documents/theemeraldexchange/scripts/deploy-image.sh` | Targeted image deploy: builds one service locally (cross-compiled amd64), ships via `docker save \| gzip \| docker load`, rolls the service without compiling on the NAS |
| `/Users/cujo253/Documents/theemeraldexchange/netlify.toml` | Tells Netlify: `build.command = "npm run build:spa"`, `publish = "dist"`, Node 24; plus the SPA catch-all redirect rule |
| `/Users/cujo253/Documents/theemeraldexchange/.env.production` | Local secrets file (gitignored). Ships to the NAS as `.env` on every deploy. Never committed. |
| `/Users/cujo253/Documents/theemeraldexchange/docker-compose.yml` | 9-service definition: backend, recommender, media-core, transcoder, cloudflared, glitchtip + 3 sidecars |

Key lines inside deploy-nas.sh:
- **Lines 72–87**: dirty-tree guard — `git status --porcelain --untracked-files=no`; refuses to run unless working tree is clean (or `--allow-dirty` passed)
- **Lines 89–108**: captures `DEPLOY_SHA_SHORT` and warns if HEAD ≠ origin/main
- **Lines 213–217**: stages the payload — `git archive HEAD | tar -x -C "$STAGE_DIR"` — the clean snapshot
- **Lines 241–290**: rsyncs from `$STAGE_DIR` (not working tree) to NAS
- **Lines 354–383**: SSHes to NAS and runs `docker compose up -d --build`
- **Lines 392–393**: always restarts `exchange-cloudflared` after backend recreate
- **Lines 556–576**: `/api/version` drift check — compares `"release"` field to `$DEPLOY_SHA_SHORT`

### Full deploy walkthrough: push → live

1. **You commit your changes** (`git add server/routes/foo.ts && git commit -m "..."`)
2. **`git push origin main`** — this triggers Netlify if you also changed SPA code (`src/`). Netlify runs `npm run build:spa`, outputs to `dist/`, publishes to their CDN. ~30 seconds.
3. **You run `./scripts/deploy-nas.sh`** from your laptop.
4. The script checks for uncommitted tracked changes — if any exist, it stops with an error.
5. It validates your `.env.production` has all required keys and that `SESSION_SECRET` is ≥32 bytes and not a placeholder.
6. It runs `git archive HEAD | tar -x -C /tmp/eex-deploy-stage.XXXXX` — this materializes exactly what's committed into a temp directory. Your in-progress edits are NOT here.
7. It SSHes to the NAS and snapshots the current `docker-compose.yml` and `.env` as `.rollback-<timestamp>` files (for rollback).
8. It rsyncs source files from the temp stage dir to `/mnt/user/appdata/exchange-backend/` on the NAS.
9. It rsyncs `.env.production` to the NAS as `.env`, chmod 600.
10. It tags the current running images as `:rollback-<timestamp>`.
11. It SSHes to the NAS and runs `docker compose up -d --build` with `EEX_RELEASE=<short sha>` exported.
12. It runs `docker restart exchange-cloudflared` unconditionally.
13. It polls all four containers (backend, recommender, media-core, transcoder) for `docker inspect` health status every 3 seconds, up to ~150 seconds total.
14. If all healthy, it hits `http://127.0.0.1:3001/api/version` (via curl on the NAS, not through Cloudflare) and checks that the `"release"` field equals the short sha it shipped.
15. If drift is detected (wrong sha returned), it prints a diagnostic and exits 1. It does NOT roll back in this case because the running code is still the previous working build.
16. On failure, it restores the rollback images and config, re-ups, and re-verifies with the same health gate.
17. **Done.** The public endpoint `https://api.theemeraldexchange.com/api/health` returns `{"ok":true}`.

---

## 4. PREREQUISITES

### Build artifacts (ELI5)

When you write TypeScript, you're writing source code — instructions a human can read. But a Node.js server can't directly run TypeScript; it needs JavaScript. The build step (`npm run build`) runs a compiler (TypeScript compiler + Vite) that transforms the TypeScript source into JavaScript files. For the SPA, Vite also bundles everything into a few optimized `.js` files (chunks) and an `index.html`. That `dist/` folder is what Netlify publishes.

For the Rust crates (media-core, transcoder, the contract bindings), the build step compiles Rust source code into native binaries. This takes several minutes on first build because Rust compiles every dependency from scratch. Subsequent builds are fast because Docker's BuildKit caches the compiled dependency artifacts in a layer.

A **Docker image** is a frozen snapshot of a filesystem: it contains the compiled code, the Node.js runtime, all npm dependencies, the OS libraries the app needs — everything required to run the service. Think of it as a ZIP file of an entire mini-computer. When you run `docker compose up --build`, Docker reads the `Dockerfile`, executes each step (installing packages, copying files, compiling code), and saves the result as an image. A **container** is a running instance of that image — the image is like a cookie cutter, the container is the actual cookie.

### Why `git archive` instead of just rsync-ing the working directory?

`git archive HEAD` creates a tar of exactly the files that are committed — no more, no less. If you have half-finished edits in your editor, they do NOT appear in the archive. This is the "reproducible build" guarantee: the code running in production is always identifiable by a git commit hash, and you can always recreate the exact same artifact by checking out that hash and running `git archive` again. Rsyncing the working tree would mean your half-written experiments could accidentally ship.

---

## 5. GOTCHAS & WAR STORIES

### The deploy-nas.sh working-tree hazard (memory: project_deploy_nas_hazards)

Early deploys used to rsync directly from the working directory. This caused two real incidents:
1. A WIP change that hadn't been committed shipped to production when deploy-nas.sh was run mid-edit.
2. Worse: the old deploy script also included the local `docker-compose.yml` and `.env` in the rsync, which *overwrote* the NAS's production compose file and env with whatever was on the laptop — including test overrides or missing variables. The NAS's carefully tuned production state was silently trashed.

**The fix (now baked in):** The payload is always `git archive HEAD` into a temp staging dir. The script hard-refuses to run with uncommitted tracked changes (`--allow-dirty` exists as an explicit escape hatch that prints a loud warning). The `.env.production` is rsynced separately and explicitly (not as part of the general rsync glob), so you always know exactly what env file is shipping.

**Lesson:** Always commit first, then deploy. "Deploy from clean `git archive origin/main`" is the rule. If `HEAD != origin/main`, the script warns you — it won't block an ad-hoc hotfix, but you should know you're deploying something not yet on the remote.

### cloudflared force-recreate after any backend recreate (memory: project_cloudflared_tunnel_netns)

This caused a real production outage. The symptom: deploy ran successfully, health gate passed, but `https://api.theemeraldexchange.com/api/*` returned 502.

Root cause: cloudflared uses `network_mode: service:backend` — it literally attaches to the backend container's network namespace. The network namespace is identified by the container's runtime ID, not its name. When `docker compose up --build` recreates the backend container (because the image changed), it gets a *new* container ID and a *new* network namespace. cloudflared is still pointing at the *old* netns, which no longer contains a process listening on :3001. The tunnel is up; the backend is up; but they can't see each other.

**The fix:** `docker restart exchange-cloudflared` after every backend recreate. `deploy-nas.sh` does this unconditionally on every run (line 393). `deploy-image.sh` does it when `backend` is in the service list (lines 78–81 — it uses `--force-recreate` because a plain restart also fails in this scenario). Never skip this step. If you manually run `docker compose up -d backend` without running the deploy script, remember to also run `docker restart exchange-cloudflared` yourself.

**How to diagnose a 502 after deploy:** Check `docker ps` on the NAS — if both `exchange-backend` and `exchange-cloudflared` show "Up", the netns is stale. Restart cloudflared and the 502 resolves in seconds.

### The backend healthcheck `curl` incident (memory: project_backend_healthcheck_curl_sitedown)

The backend's Node Docker image has NO `curl` binary. An earlier version of the healthcheck used `curl http://localhost:3001/api/health` inside the container. This caused the container to be permanently "unhealthy" because every health probe exited with "curl: not found". cloudflared had a `depends_on: backend: condition: service_healthy` gate, which meant cloudflared never started (it kept waiting for a healthy backend that could never become healthy). The public site was down after every deploy.

**The fix:** healthchecks in the backend container now use `node -e "fetch(...)"`. `curl` exists on the NAS host and is available in SSH commands; it does NOT exist inside the Node container. This distinction matters when you're writing probe scripts.

### The Netlify lazy-chunk verification gotcha (memory: project_suggestion_strip_toggle_and_deploy_arch)

Netlify shows a new deploy with a green checkmark and a new deploy ID whenever a build completes. But the main entry bundle (`index-<hash>.js`) only changes when code in the entry path changes. If you only modified a lazy-loaded tab's chunk (e.g., the Movies tab is loaded only when you click it), the entry hash is unchanged. Netlify's deploy list might show "deployed" but browsing to the page and seeing the old behavior is misleading — you might think the deploy didn't take.

**The fix:** grep the deployed chunk for a unique marker from your change rather than trusting the entry hash. Identify the chunk file that contains the code you changed (Vite names them by content hash, so the hash changes if the content changed), find the new hash in the Netlify deploy's published `dist/` assets, and `fetch` or `curl` that chunk URL. If the chunk URL 200s and contains your new code, the deploy is live. If the old chunk URL still 200s, you're looking at stale CDN or the build didn't include your change.

---

## 6. QUIZ BANK

**Q1.** You edited `src/components/search/MediaCard.tsx` (SPA code only) and `server/routes/media.ts` (backend code). You run `git push origin main` and then immediately check the live site — the UI change is already there, but the API returns the old behavior. You did NOT run `./scripts/deploy-nas.sh`. Is this expected? What should you do?

**A1.** Yes, completely expected. `git push` triggers Netlify to rebuild and deploy only the SPA. The backend on the NAS is never touched by a push — it requires a manual `./scripts/deploy-nas.sh` run. Run the script now. Also: the DEPLOY.md rule says deploy frontend before backend when a change spans both (the SPA is the consumer), so the push-first order was correct.

---

**Q2.** You run `./scripts/deploy-nas.sh` and it immediately prints: `ERROR: tracked files have uncommitted changes — the deploy payload is git archive HEAD, so these edits would silently not ship`. What is the deploy payload actually built from, and why does this matter?

**A2.** The payload is built from `git archive HEAD` — the exact snapshot of all committed files at the current HEAD commit, extracted to a temp directory. The working tree (your open editor files) is never read. The error matters because if you ran the deploy anyway, your in-progress changes would be silently absent from production — the containers would be rebuilt from committed code, not from what you thought you were shipping. Fix: commit (or stash) your changes first, then re-run the script.

---

**Q3.** A deploy completes with the health gate passing ("stack healthy"). You check `https://api.theemeraldexchange.com/api/version` and see `"release":"ac09b40"` but the short sha the script printed was `b7dd248`. What does this mean, and what does the script do about it?

**A3.** This is a release drift: the container is healthy and serving, but it's serving the WRONG build — the new image did not actually take (stale compose cache, or the container was not recreated). The script exits 1 with a clear error. It does NOT roll back, because the running code IS the previous working build — rolling back would downgrade to something even older. The fix: force-recreate the backend: `ssh root@theemeraldexchange.local 'cd /mnt/user/appdata/exchange-backend && docker compose up -d --build --force-recreate backend'`.

---

**Q4.** You deploy successfully, but 30 seconds later `https://api.theemeraldexchange.com/api/health` starts returning 502. The deploy script completed cleanly. What is the most likely cause, and what is the one-line fix?

**A4.** cloudflared is pointing at the old (now-destroyed) backend container's network namespace. The backend was recreated during the deploy (new container ID, new netns), staling cloudflared's reference. Fix: `ssh root@theemeraldexchange.local 'docker restart exchange-cloudflared'`. The deploy script does this automatically, but if it ran and the restart didn't "take" (network timing, cloudflared restart racing the backend's bind), running it manually again is idempotent.

---

**Q5.** You made a change to the Movies tab in the SPA (a lazy-loaded chunk, not the main entry bundle), pushed to main, and Netlify shows the deploy as "Published". A friend reports no change. How do you confirm whether the new code is actually live?

**A5.** Don't trust the entry bundle hash — it's unchanged when only a lazy chunk changed. Identify the specific chunk file that contains your Movies tab code. In the browser DevTools Network tab, look for the lazy chunk that loads when you click Movies — it will have a `<hash>.js` name. The new deploy should have changed that hash. Fetch `https://theemeraldexchange.com/assets/<new-hash>.js` — if it 200s and contains your change, it's live. If the old hash still 200s from cache, try a hard refresh or incognito window.

---

**Q6.** Why does `scripts/deploy-nas.sh` tag existing images as `:rollback-<timestamp>` before building? What would happen if rollback tags were clobbered on each deploy?

**A6.** The rollback tags are the "undo" button. If the new build is broken and the health gate fails, the script restores the `:rollback-<timestamp>` image to `:latest` and re-ups without rebuilding, getting the old code running again in seconds. If a single static `:rollback` tag existed instead of timestamped ones, a second failing deploy would re-tag the BROKEN new image as `:rollback`, leaving no known-good image to revert to. The timestamped scheme keeps the last 2 generations so even a double-failure has a genuine fallback.

---

## 7. CODE-READING EXERCISE

### Guided walk: `scripts/deploy-nas.sh`

Open `/Users/cujo253/Documents/theemeraldexchange/scripts/deploy-nas.sh`. Read it top to bottom with these questions in mind.

**Step 1 — Lines 1–38: The header comment.**
Read the "What this script does" numbered list. Notice point 1 says "Refuses to run with uncommitted tracked changes" and then immediately explains WHY: "the payload is ALWAYS `git archive HEAD`". This is a documentation pattern called "decision + rationale inline" — the why lives next to the what. How many points are there, and which one is responsible for the public site not 502-ing after a deploy?

*(Answer: 6 points. Point 5 — tagging rollback images and running `docker compose up -d --build` — is the deploy itself. But the public 502 fix is implicit: the cloudflared restart is in the main body at line 393, not in the header list. This is worth noting as a gap between the docs and the code.)*

**Step 2 — Lines 64–87: The dirty-tree guard.**
Find the line that runs `git status`. What flags does it use, and what does `--untracked-files=no` do? Why would you NOT want untracked files to trigger the guard?

*(Answer: `git status --porcelain --untracked-files=no`. `--porcelain` gives machine-readable output. `--untracked-files=no` means scratch files you haven't added to git yet (node_modules output, local test data, log files) don't trigger the error — only changes to files git already tracks can "silently not ship" because `git archive` only includes tracked files.)*

**Step 3 — Lines 213–217: The staging step.**
Read these lines carefully:
```bash
STAGE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/eex-deploy-stage.XXXXXX")
cleanup_stage() { rm -rf "$STAGE_DIR"; }
trap cleanup_stage EXIT
git archive HEAD | tar -x -C "$STAGE_DIR"
```
What does `trap cleanup_stage EXIT` do? What would happen if the deploy script crashed halfway through without this line?

*(Answer: `trap` registers a function to run when the script exits for any reason — success, error, or signal. Without it, the temp directory would remain on disk after a crash or Ctrl-C. On a machine that deploys often, these would accumulate. With the trap, the temp dir is always cleaned up.)*

**Step 4 — Lines 241–290: The rsync block.**
Notice that every rsync reads from `"${STAGE_DIR}/..."` — never from the current directory or `"./"`. Trace the value of `$STAGE_DIR` back to Step 3. Then look at the `--delete` flag on the `server/` rsync (line 248). What does `--delete` do, and why is it important when the destination is a persistent directory on the NAS?

*(Answer: `--delete` removes files from the destination that no longer exist in the source. Without it, if you deleted a route file from your repo, the old file would remain on the NAS and Node would still load it. With `--delete`, the NAS directory becomes an exact mirror of the committed source.)*

**Step 5 — Lines 385–393: The cloudflared restart.**
Find the `echo` on line 392. Read the comment explaining why this step is required. Then look at `deploy-image.sh` lines 78–81 — how does that script handle the same problem, and why does it use `--force-recreate` instead of `docker restart`?

*(Answer: deploy-image.sh uses `docker compose up -d --force-recreate --no-build cloudflared`. A plain `docker restart` on cloudflared would fail with "No such container: <old-backend-id>" because cloudflared's netns reference is baked in at container creation time — restarting the existing cloudflared container does not re-resolve it. `--force-recreate` destroys the cloudflared container and creates a fresh one, which re-resolves the netns to the current backend container's ID.)*

**Step 6 — Lines 556–576: The drift check.**
The check queries `http://127.0.0.1:3001/api/version` via SSH (curl on the NAS), not `https://api.theemeraldexchange.com/api/version` (the public URL). Why? And notice the comment at line 549: "deliberately NOT the public URL, so this verifies the container we just deployed independent of Cloudflare edge state." What is "Cloudflare edge state" and why would using the public URL give a false positive?

*(Answer: Cloudflare caches responses at its edge PoPs (Points of Presence). Even after the backend is updated, Cloudflare's CDN might serve a cached `/api/version` response from before the deploy. Using the loopback URL `127.0.0.1:3001` on the NAS queries the backend container directly, bypassing all caching, so the response reflects what the container is actually serving right now.)*

---

