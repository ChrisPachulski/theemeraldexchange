
# NAS Runtime Topology — Teaching Dossier

---

## 1. WHAT

The Emerald Exchange runs entirely on a single home NAS (Network Attached Storage) box — a small computer in someone's house — that also runs Plex, a popular media server. The application is made up of several Docker containers, each a self-contained service doing a specific job: the Node.js backend handles API requests from users, media-core scans and catalogues local video files, the transcoder converts video on the fly when a browser cannot play a raw file, the recommender runs a local machine-learning model to suggest movies, glitchtip collects crash reports, and cloudflared connects the whole thing to the outside internet. That last container, cloudflared, is the only front door: it opens a persistent outbound tunnel to Cloudflare's global network, so public traffic from the internet flows IN through that tunnel rather than through any port-forwarded hole in the home router. All of the internal services communicate over Docker's private internal network — they are never reachable from the public internet directly. Because the NAS only has six CPU threads and Plex is a permanent guest on those same threads, every build and deployment decision is shaped by the need to never overwhelm the box.

---

## 2. WHY

**Why a Cloudflare Tunnel instead of port-forwarding?**
Port-forwarding punches a permanent hole in your home router, exposes your home IP address, and requires you to keep that port open forever. If the service goes down, the hole stays. If the IP changes, DNS breaks. The tunnel is the opposite: the NAS dials *out* to Cloudflare's servers once and keeps a persistent connection open. Cloudflare receives the public traffic and relays it inward through that connection. No hole in the router. No exposed home IP. Cloudflare also absorbs DDoS attacks and handles TLS termination.

**Why does cloudflared share the backend's network namespace (netns) instead of just using Docker's bridge network?**
A Docker bridge network gives each container its own private loopback (`localhost`). If cloudflared ran on the bridge and was told to forward traffic to `http://localhost:3001`, it would dial its *own* container's loopback — where nothing is listening — and every request would fail with "connection refused." Two alternatives exist: (a) switch the dashboard origin to `http://backend:3001` using the Docker service name, or (b) give cloudflared the *same* loopback as the backend. Option (b) was chosen via `network_mode: service:backend`, which makes the two containers share one network namespace. Now cloudflared's `localhost:3001` *is* the backend's listener. No dashboard change needed (it's a "token tunnel" — ingress rules live in Cloudflare's dashboard, not in a local file). Option (a) was ruled out because it would also require changing the dashboard config over SSH, which is not possible for this type of tunnel.

A failed earlier attempt tried `network_mode: host` (sharing the *host machine's* full network). That was rejected on security grounds: a compromised cloudflared container would then be able to reach every admin port on the host's loopback (recommender on :8001, media-core on :8002, transcoder on :8003, glitchtip on :8100). `service:backend` shares only the backend's namespace — those other ports stay unreachable.

**Why must cloudflared be restarted after a backend recreate?**
A `network_mode: service:backend` binding is tied to the specific container *instance*, not just the container name. When Docker recreates the backend (new container ID), the old netns reference is dead. Both containers show "Up" but cloudflared is actually pointing at a vanished namespace. `depends_on` only controls startup order; it has no hook for later recreates.

**Why the NAS build caps?**
The NAS has 6 CPU threads and runs Plex full-time. A Rust workspace compile (the transcoder and media-core are Rust) spawns as many compiler processes as there are threads by default. In two separate real incidents, uncapped builds drove the 1-minute load average to ~73 (12 times the core count) and starved Plex and SSH of CPU for over 13 minutes. Because SSH was starved, the runaway build could not be killed remotely — the kill signal itself couldn't land. The fix is not just "cap the build" — the cap must be *discovered* at runtime, the build must run *detached* from the SSH session (so a dropped connection cannot orphan it), and an *on-NAS watchdog* must be able to abort without SSH (because overload kills SSH first).

**Why cap_add selectively after cap_drop: ALL?**
Docker containers inherit a default set of Linux "capabilities" — fine-grained kernel permissions. Dropping ALL of them is the most locked-down posture (audit rule 9-4). But some containers have startup scripts that need a few specific permissions: the recommender and redis/postgres containers run as root first, chown a data directory, then use `gosu`/`setpriv` to drop to a non-root uid. That privilege drop requires SETUID and SETGID. The chown requires CHOWN. Without them, the containers crash-loop with "Operation not permitted" — which is exactly what happened 948+ times before the correct `cap_add` entries were identified.

---

## 3. MAP

### Container topology (text diagram)

```
INTERNET
  │
  ▼
Cloudflare Edge (global CDN + TLS termination)
  │  (Cloudflare Tunnel — NAS dials out, keeps persistent connection)
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ NAS: theemeraldexchange.local (6-thread CPU, Plex lives here) │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Docker network: exchange-backend_default           │   │
│  │                                                  │   │
│  │  exchange-cloudflared ──┐  (network_mode:        │   │
│  │     shares netns ◄──────┘   service:backend)     │   │
│  │         │ localhost:3001                          │   │
│  │         ▼                                         │   │
│  │  exchange-backend (Node.js :3001)                 │   │
│  │         │                                         │   │
│  │         ├──► exchange-recommender (:8000 internal)│   │
│  │         ├──► exchange-media-core (:8002 internal) │   │
│  │         └──► exchange-transcoder (:8003 internal) │   │
│  │                    │                              │   │
│  │                    └──► /dev/dri/renderD128        │   │
│  │                         (Intel iGPU VAAPI)        │   │
│  │                                                  │   │
│  │  Glitchtip stack (mandatory crash reporting):     │   │
│  │    exchange-glitchtip (:8100 loopback only)       │   │
│  │    exchange-glitchtip-db (Postgres)               │   │
│  │    exchange-glitchtip-redis (Valkey/Redis)        │   │
│  │    exchange-glitchtip-worker (async tasks)        │   │
│  │                                                  │   │
│  │  (qBittorrent+gluetun/NordVPN — separate stack)  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  Plex Media Server (NOT a Docker container managed here) │
└──────────────────────────────────────────────────────────┘

SPA (web frontend) ──► Netlify CDN (not the NAS)
                         Only /api.theemeraldexchange.com → NAS tunnel
```

### Key files

| Path | What it contains |
|------|-----------------|
| `/Users/cujo253/Documents/theemeraldexchange/docker-compose.yml` | Full container definitions: all services, resource caps, network modes, healthchecks, volumes |
| `/Users/cujo253/Documents/theemeraldexchange/docker-compose.yml` line 470 | `network_mode: "service:backend"` — the cloudflared netns-sharing line |
| `/Users/cujo253/Documents/theemeraldexchange/docker-compose.yml` lines 37–54 | `cap_drop: ALL` + node-based healthcheck on backend |
| `/Users/cujo253/Documents/theemeraldexchange/docker-compose.yml` lines 179–195 | `cap_add: SETUID/SETGID/CHOWN` on recommender (gosu drop) |
| `/Users/cujo253/Documents/theemeraldexchange/docker-compose.yml` lines 344–348 | `CARGO_BUILD_JOBS` build arg with Plex-safety comment |
| `/Users/cujo253/Documents/theemeraldexchange/scripts/nas-safe-build.sh` | The safe build script: capacity discovery, detached launch, dual watchdogs |
| `.planning/burn-it-all/syllabus-2026-06-11/inputs/context/ops-cloudflare-tunnel.md` | Tunnel operations runbook (triage, restart commands) |
| `.planning/burn-it-all/syllabus-2026-06-11/inputs/context/incident-incident-2026-05-30-cloudflared-502.md` | The 2026-05-30 502 incident postmortem |

---

## 4. PREREQUISITES

Before diving into this topic, a beginner should understand these concepts:

**Containers (ELI5)**
A container is like a sealed lunchbox with an app inside. It contains the app, all its libraries, and just enough operating system to run — but it shares the host machine's actual kernel (the core OS). Containers are isolated: the app inside cannot directly see other apps or the host's files (unless you explicitly poke holes via volume mounts). Docker is the most common tool for building and running containers. Each container gets its own filesystem view, its own process IDs, and — by default — its own network.

**Network Namespace (ELI5)**
A network namespace is a completely separate copy of the networking stack: its own `localhost`, its own list of open ports, its own routing table. By default, each Docker container lives in its own network namespace. Two containers can't "see" each other's `localhost` — that word means "me, specifically." When we say cloudflared shares the backend's network namespace with `network_mode: service:backend`, we mean they are merged into a single namespace: they share one `localhost`, one set of ports, one network stack. It's as if they are the same machine from a networking perspective, even though they are still isolated in every other way (separate filesystems, separate processes).

**Linux Capabilities**
The Linux kernel grants processes special permissions through "capabilities" — for example, `CAP_NET_BIND_SERVICE` lets a process bind to low-numbered ports; `CAP_SETUID` lets a process change its user ID. Docker containers start with a default set of ~14 capabilities. `cap_drop: ALL` removes every one of them for maximum lockdown. `cap_add` then re-grants only the specific capabilities actually needed, keeping the attack surface small.

**Cloudflare Tunnel**
Cloudflare Tunnel (formerly "Argo Tunnel") is a service where YOUR software dials out to Cloudflare and keeps a persistent encrypted connection. Cloudflare then relays public requests inward through that connection to your server. Your server never needs to listen on a public IP — it only needs outbound internet access. The `cloudflared` daemon is the software that runs on your side and maintains that connection.

---

## 5. GOTCHAS & WAR STORIES

### The curl healthcheck that took the site down

**What happened:** The backend container's Docker healthcheck was configured as `CMD curl http://127.0.0.1:3001/api/health`. The Node.js base image does not include `curl`. So every healthcheck tick failed with `exec: curl: not found`, and the container was perpetually marked "unhealthy." The cloudflared service has `depends_on: backend: condition: service_healthy`. On the next full `docker compose up`, cloudflared refused to start because it was waiting for a "healthy" backend that would never arrive. The public API went down.

**The fix (commit a3a96c7):** Replace `curl` with Node itself — always present since it runs the app:
```
["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```
(`docker-compose.yml` lines 47–54)

**Lesson:** When writing a Docker healthcheck, use only tools that are guaranteed to be in the image. Check with `docker run --rm <image> which curl` first. Better yet, use the language runtime the app already runs in.

---

### The two Plex brown-outs from uncapped Rust compiles

**What happened (first incident):** `docker compose up -d --build transcoder` was run on the NAS to rebuild the transcoder image. A cold Rust workspace compile with no job cap spawned as many `rustc` processes as there were CPU threads. The 1-minute load average climbed to ~73 on a 6-thread machine (12× the core count). Plex, which runs on the same box, lost all its CPU time. Users' streams froze. SSH became unresponsive because sshd itself was starved. This made the runaway unkillable remotely — there was no way to send a kill signal because the channel to send it through was out of CPU. The brown-out lasted ~13 minutes.

**What happened (second incident):** A CPU-capped retry was tried (limiting to 2 jobs), but this time the build I/O-stormed the box just as badly — the compile still wrote enormous amounts of data to disk and thrashed the cache SSD, causing similar degradation.

**The fix:** `scripts/nas-safe-build.sh` — described in detail in section 7. The key insight: "slow is fine, silent is not, and the watchdog must not depend on SSH." The compose file also now has a `CARGO_BUILD_JOBS` build argument (`docker-compose.yml` line 348) that can be set to cap the compile for any direct build attempt.

**Lesson:** A 75-second load spike on a dedicated server is annoying. On a machine that also runs a real-time media server with no redundancy, the same spike is an outage. Always understand what else runs on your hardware.

---

### The cap_drop ALL crash-loop (gosu / setpriv "operation not permitted")

**What happened:** As part of a security hardening pass (audit 9-4), `cap_drop: ALL` was added to all containers. The recommender, glitchtip-db (Postgres), and glitchtip-redis containers all immediately started crash-looping. The recommender crashed 948 times before the cause was understood. The error was "Operation not permitted" from `gosu` (a tool that drops privileges at container startup).

**Root cause:** These containers follow a common pattern: start as root to set up data directories (chown, chmod), then drop to a non-root user via `gosu` or `setpriv`. The privilege drop itself (`setuid()`/`setgid()` system calls) requires the `SETUID` and `SETGID` capabilities. The chown step requires `CHOWN`. Removing ALL capabilities made these startup steps impossible.

**The fix:** Add back only the minimum needed caps per container:
- Recommender: `SETUID`, `SETGID`, `CHOWN`
- Postgres (glitchtip-db): `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`
- Redis (glitchtip-redis): `CHOWN`, `SETGID`, `SETUID`

(`docker-compose.yml` lines 179–195 for recommender; lines 575–585 for Postgres)

**Lesson:** `cap_drop: ALL` is the right security goal, but it is not "set and forget." Test a new image's startup script before deploying. The pattern of "start root, chown, then gosu-drop" is extremely common in official Docker Hub images. Check what the entrypoint actually does.

---

### The 2026-05-30 cloudflared 502 — the netns half-migration

**What happened:** A security hardening pass removed `network_mode: host` from cloudflared (correct — host networking would expose all the host's admin ports to a compromised tunnel image). The new config put cloudflared on the regular Docker bridge network. The accompanying step — changing the Cloudflare dashboard ingress origin from `http://localhost:3001` to `http://backend:3001` — was documented but never applied (it's a "token tunnel"; the ingress rules live in the Cloudflare dashboard, not a local config file). The public API immediately started returning 502.

**Symptom vs. red herring:** The cloudflared logs showed `dial tcp [::1]:3001: connect: connection refused`. The `[::1]` (IPv6 loopback) was misread as an IPv4/IPv6 mismatch. It was not. `[::1]:3001` was cloudflared dialing its *own* container's loopback, where nothing listens. The host has no IPv6 at all; Docker wasn't binding on `[::1]`. The diagnosis was simply: `localhost` inside cloudflared's container is cloudflared itself, not the backend.

**The fix (commit 8e575d9):** `network_mode: "service:backend"`. Now cloudflared shares the backend's network namespace. `localhost:3001` inside cloudflared resolves to the backend's listener. No dashboard change needed. Security win preserved. (See `ops-cloudflare-tunnel.md` and the incident postmortem.)

**Lesson:** A half-applied migration (change A without companion change B) can be more dangerous than doing nothing. When a `network_mode` changes, trace every service that connects to that container and verify whether their `localhost` references still resolve.

---

## 6. QUIZ BANK

**Q1.** You rebuild the backend container with `docker compose up -d --no-build --force-recreate backend`. Thirty seconds later, `https://api.theemeraldexchange.com/api/health` returns 502, but on the NAS, `curl http://127.0.0.1:3001/api/health` returns `{"ok":true}`. `docker ps` shows both `exchange-backend` and `exchange-cloudflared` as "Up". What is wrong and what is the single command to fix it?

**A1.** The cloudflared container's `network_mode: service:backend` binding is tied to the *specific container instance* that existed when cloudflared last started. Recreating the backend gave it a new container ID, breaking the netns reference — cloudflared is now pointing at a dead namespace. Both containers appearing "Up" is a false signal. Fix: `docker compose up -d --no-deps --force-recreate cloudflared`. This restarts cloudflared against the new backend instance's netns.

---

**Q2.** A new team member suggests adding a healthcheck to the backend using `CMD curl -fsS http://127.0.0.1:3001/api/health` because "curl is simpler." What specific failure mode does this introduce, and what should be used instead?

**A2.** The backend's base image (Node.js) does not ship `curl`. The healthcheck would fail on every tick with `exec: curl: not found`, marking the container permanently "unhealthy." Since `cloudflared` depends on `service_healthy` for the backend, it would refuse to start on the next `docker compose up`, taking down the public API. Use Node instead: `["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]` — Node is always present because it's the runtime the app runs in.

---

**Q3.** A new Rust service is added to the compose file. A developer tests the deploy by SSHing into the NAS and running `docker compose up -d --build new-service` directly. What is the risk, and what process should be used instead?

**A3.** An uncapped `docker compose build` will spawn one `rustc` process per CPU thread by default. On this 6-thread NAS, that can drive load to many times the core count, starving Plex (which also runs on the box) and potentially starving SSH itself — making the runaway unkillable remotely. The correct process is `scripts/nas-safe-build.sh new-service`, which: (a) discovers the box's spare cores at runtime, (b) caps `CARGO_BUILD_JOBS` to that number, (c) runs the build detached from the SSH session so a dropped connection can't orphan it, (d) launches an on-NAS watchdog that can abort without SSH if load or memory thresholds are exceeded, and (e) prints a heartbeat so the operator knows it's still making progress.

---

**Q4.** You add a new container to docker-compose.yml for a service that uses an official Docker Hub image. The image's entrypoint script runs as root, chowns `/data`, and then calls `gosu appuser /bin/my-service`. You apply `cap_drop: ALL` and `security_opt: no-new-privileges: true` as standard hardening. The container crash-loops. What is the most likely cause, and what is the minimum fix?

**A4.** The `gosu` privilege drop calls `setuid()`/`setgid()` system calls to switch from root to `appuser`. These calls require the `SETUID` and `SETGID` Linux capabilities. The chown step also requires `CHOWN`. With `cap_drop: ALL`, none of these are available, so `gosu` exits with "Operation not permitted." The minimum fix is to add back only the needed capabilities: `cap_add: [SETUID, SETGID, CHOWN]`. `no-new-privileges: true` can stay — it prevents the *running process* from gaining more privilege than the entrypoint started with; it does not prevent the entrypoint from dropping to a lower privilege.

---

**Q5.** The SPA is at `https://theemeraldexchange.com` (served by Netlify). The API is at `https://api.theemeraldexchange.com` (tunneled to the NAS). A developer is confused because they can see the SPA fine but every API call returns 502. They check `docker ps` on the NAS and all containers show "Up." Walk through the diagnostic steps in order.

**A5.**
1. Check the public API health endpoint directly: `https://api.theemeraldexchange.com/api/health`. If this 502s but the backend is "Up," the problem is in cloudflared's ability to reach the backend.
2. On the NAS, verify the backend is actually listening: `curl http://127.0.0.1:3001/api/health` → should return `{"ok":true}`. If this fails, the problem is the backend itself, not the tunnel.
3. Check cloudflared logs: `docker logs --tail 30 exchange-cloudflared`. Look for "Unable to reach the origin service" with `originService=http://localhost:3001`. If found, cloudflared cannot dial the backend's loopback.
4. Check the network mode: `docker inspect --format '{{.HostConfig.NetworkMode}}' exchange-cloudflared`. It should print `container:<backend-container-id>`. If it prints a bridge network name, the `network_mode: service:backend` line is missing or cloudflared was started before the backend — force-recreate cloudflared.
5. If the backend was recently recreated, force-recreate cloudflared: the netns reference is stale.

---

**Q6.** Why does `network_mode: service:backend` give cloudflared security advantages over `network_mode: host`, even though both modes allow cloudflared to reach `localhost:3001`?

**A6.** With `network_mode: host`, cloudflared shares the *host machine's* entire network namespace. This means a compromised cloudflared container can reach every service listening on the host's loopback: the recommender admin port (:8001), media-core (:8002), transcoder (:8003), and glitchtip (:8100) — all of which are intentionally bound to `127.0.0.1` only to prevent public access. With `network_mode: service:backend`, cloudflared instead shares only the *backend container's* network namespace. The only loopback-bound thing in that namespace is the backend on :3001. The host's loopback — and all those other admin ports — is an entirely different namespace and cannot be reached from inside cloudflared. The security benefit is isolation: a compromised tunnel can reach the backend (unavoidable — that's its job) but nothing else.

---

## 7. CODE-READING EXERCISE

### Guided walk: `scripts/nas-safe-build.sh`

**Goal:** Understand how the script prevents the Plex brown-out failure mode. We will trace one complete "safe build" from invocation to completion.

**Step 1 — Invocation and variables (lines 1–75)**

Read the header comment first (lines 1–50). Notice these phrases:
- "drove load to ~73 and brown-outed Plex for ~13 min" — this is not theoretical; it happened twice
- "a dropped/again-starved SSH session can never orphan it" — the failure mode from the first incident
- "TWO watchdogs" — the dual-layer abort strategy, explained next
- "launch-time memory floor" — a third guard: refuse to start into an already-stressed box

The script takes two arguments: `SERVICE` (which Docker Compose service to build) and `CRITICAL` (the container name to monitor; defaults to `Plex-Media-Server`). Then it defines helper functions: `say` (prints a timestamped log line) and `nas` (runs a command over SSH with a 25-second timeout — critically, it fails fast rather than hanging).

**Step 2 — Capacity discovery on the NAS (the `REMOTE` here-doc, starting ~line 90)**

The script SSHs to the NAS and runs a shell heredoc there. Find the line:
```bash
NPROC="$(nproc)"
```
This reads the NAS's actual core count at runtime — not a hardcoded value. Then:
```bash
RESERVE=$(( (NPROC + 1) / 2 ))
[ "$RESERVE" -lt 2 ] && RESERVE=2
JOBS=$(( NPROC - RESERVE ))
[ "$JOBS" -lt 1 ] && JOBS=1
```
On a 6-core box: RESERVE = 3, JOBS = 3. The build gets at most half the threads. This is conservative by design.

Then the memory floor check:
```bash
MEM_AVAIL_KB="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
if [ "$MEM_AVAIL_KB" -lt "$MIN_LAUNCH_MEM_KB" ] && [ -z "$FORCE_LOW_MEM" ]; then
  echo "ERR: MemAvailable..."; exit 5
fi
```
If the box already has less than ~1.5 GB free, the script refuses to start. Rust link steps eat gigabytes; starting into a low-memory state is how OOM-thrash wedges begin.

**Step 3 — Detached launch (still in the REMOTE heredoc)**

Find the `setsid bash -c` block. `setsid` creates a new session and process group — the build becomes a separate tree that outlives the SSH connection. `CARGO_BUILD_JOBS=$JOBS` is passed inline to cap the Rust compiler. `ionice -c3` (idle I/O priority) and `nice -n19` (lowest CPU priority) are belt-and-suspenders — the real CPU lever is `CARGO_BUILD_JOBS`, but this reduces the build's priority when competing with Plex for cycles.

The build's output goes to a logfile (`$LOG`). When the build finishes, its exit code goes to a sentinel file (`$DONE`). The mac-side heartbeat loop checks for this sentinel file.

**Step 4 — The on-NAS watchdog (still in REMOTE)**

Find the second `setsid` block, labeled "ON-NAS WATCHDOG." This is the critical safety layer. Read the comment above it:
> "The abort must NOT depend on SSH: overload starves sshd first"

This watchdog runs entirely on the NAS in a forked process. Its loop reads `/proc/loadavg` and `/proc/meminfo` using bash builtins (`read < /proc/...` — no fork, no exec). If load-per-core exceeds `ABORT_LOAD_PER_CORE` for `ABORT_SAMPLES` consecutive samples, or `MemAvailable` drops below `MIN_MEM_KB`, it calls `abort()`: writes `3` to the `$DONE` sentinel and sends `SIGTERM` then `SIGKILL` to the build's process group.

The `read -t 10 -u 9` sleep uses a FIFO file descriptor — this is the fork-free wait pattern. Standard `sleep` would require forking a new process; on an overloaded box, `fork()` itself can fail.

**Step 5 — The Mac-side heartbeat loop (after the SSH call returns)**

Back on your laptop, the script enters a `while :` loop. Every `HEARTBEAT_SECS` (20 seconds), it SSHs to the NAS and reads the load, the critical container status, and the last line of the build log. It prints this to your terminal so you can see the build progressing — or notice it stalling.

The Mac-side also checks the Plex container status (`crit` variable). If Plex goes unhealthy or absent, `abort_build` is called, which SSHs in and kills the build's process group.

**The layered redundancy:**
- On-NAS watchdog: fires even when SSH is starved (the most dangerous scenario)
- Mac-side watchdog: adds human-readable monitoring and Plex health gate
- Detached launch: SSH disconnect cannot orphan the build
- Memory floor: prevents starting into a pre-degraded state
- `CARGO_BUILD_JOBS` cap: limits parallelism regardless of the above

**Exercise question for the reader:** If the NAS load reaches 12.0 (2× per-core threshold on a 6-core box) and SSH is responding but slowly, which watchdog fires first, and why?

**Answer:** The on-NAS watchdog fires first because it runs locally on the NAS with a fork-free polling loop. It detects the overload condition within 10 seconds (one `read -t 10` wait cycle) and immediately kills the build process group — without waiting for the next SSH poll from the Mac, which might time out or be delayed by the very load it's trying to abort.

---

