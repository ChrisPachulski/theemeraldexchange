
# Backend Telemetry, Notifications, Usage, Limits, Version — Teaching Dossier

## 1. WHAT

This backend module tells you when things break via Glitchtip (a self-hosted Sentry-compatible crash reporter), notifies the household of downloads via Discord webhooks, tracks who used how much Claude for recommendations, and exposes the server identity and capabilities to mobile apps during pairing. Together, these utilities make the system observable and integrate the household's existing workflows (Discord notifications) without leaking crash data or usage patterns to third parties.

## 2. WHY

**Mandatory self-hosted Glitchtip** — EEX mandates crash reporting because:
- **Crash-data islands**: errors never leave the NAS. A home media server is not a SaaS app; its errors are your private infrastructure, not product telemetry.
- **Privacy**: no third-party processor (no Sentry.io, no datadog, no rollbar). All crash metadata — play session IDs, Plex user IDs, DNS queries, IPTV streams, file paths — stays local.
- **Regulatory**: GDPR/CCPA compliance without inter-jurisdictional data transfers; the self-hoster is the sole data controller.
- **Why-chained**: client SDKs (iOS, web, recommender) all report to the same self-hoster-controlled Glitchtip project, so one admin dashboard gives the full system view.

## 3. MAP

Key files and DSN walkthrough:

| File | Lines | Role |
|------|-------|------|
| `server/routes/telemetry.ts` | 1–76 | DSN distribution endpoint; validates & returns `EEX_TELEMETRY_DSN` to authenticated clients |
| `server/services/serverTelemetry.ts` | 1–80 | Server-side fire-and-forget relay to Glitchtip; used when background tasks fail (recommender sidecar, etc.) |
| `server/routes/notifications.ts` | 1–354 | Discord webhook config for Sonarr/Radarr grabs; GET/POST/DELETE mutate both *arr services atomically |
| `server/routes/usage.ts` | 1–56 | Last-30-day Claude call summary per user; tracked in `data/usage.jsonl` (append-only) |
| `server/routes/devices.ts` | 1–60+ | Paired-device listing/revocation; audit trail in `device_tokens` + `device_token_revocations` |
| `server/routes/version.ts` | 1–62 | Public, unauthenticated `/api/version`; serves `server_id` + `auth_modes` + schema migration state |
| `crates/emerald-contracts/src/telemetry.rs` | — | Rust-side PII scrubbing schemas for Glitchtip payloads |
| `docs/operations/glitchtip-setup.md` | §1–§8 | Operational runbook: key generation, reverse-proxy choices, DSN creation, troubleshooting |

**DSN Distribution Walkthrough:**

```
1. Self-hoster runs deploy-nas.sh
2. Glitchtip boots, logs in, creates EEX project → generates DSN (e.g., https://abc123@errors.example.com/1)
3. Self-hoster sets EEX_TELEMETRY_DSN in .env.production
4. Backend restarts; /api/telemetry/config now returns { dsn, environment, release }
5. SPA (at browser init), iOS/tvOS (at boot), recommender (at startup) fetch /api/telemetry/config
6. Apps initialize their Sentry SDK with this DSN (no hard-coded DSN in binaries)
7. Client crashes POST to the DSN's ingest endpoint (resolves to Glitchtip)
8. Server-side errors (recommender sidecar down, media transcode failure) use serverTelemetry.reportServerEvent() → same Glitchtip project
```

## 4. PREREQUISITES

Before reading this code, know:
- **What error tracking is** (ELI5): "Error tracking" = collecting crashes & exceptions from production code, showing them in a dashboard, grouping by type so you spot patterns. Sentry.io is the industry-standard; Glitchtip is a self-hosted clone.
- **Sentry DSN format**: `https://<projectKey>@<host>/<projectId>` is a URL that apps use to ship events. The key is not secret (apps send it to untrusted networks); it only authorizes writes to that one project.
- **Why separate telemetry routes from auth routes**: `/api/telemetry/config` is protected (`requireAuth`); only logged-in clients can fetch the DSN. An unauthenticated caller can't retrieve it (so it doesn't leak in network logs). But once fetched, the DSN is sent client-side in plaintext (Sentry SDK design; there's no safer way without backend-proxying every crash event).
- **Discord webhooks**: a URL that Sonarr/Radarr can POST to when a grab starts or download completes. The dashboard *configures* the webhook URL on Sonarr/Radarr; Sonarr/Radarr then make the outbound POST (no dashboard SSRF risk).

## 5. GOTCHAS & WAR STORIES

1. **`/api/version` is unauthenticated and deployed-vs-HEAD drifts detector.** Apple apps call it during PIN-pair (before they have an auth token). The returned `release` field is `env.EEX_RELEASE` (set at build time in CI). Compare live `/api/version` against `HEAD` to spot a stale deployed container: if `release` is old, the backend wasn't restarted after a git push.

2. **Glitchtip session tracking must be disabled (`autoSessionTracking: false`)** in every SDK (Hono, Python, Swift). Glitchtip doesn't implement the Sentry sessions API; session envelopes are silently dropped. Omitting this flag wastes SDK bandwidth on every app launch and adds noise in logs.

3. **`EEX_TELEMETRY_DSN` unset = intentional 503 on `/api/telemetry/config`.** This is NOT a server error; it's "telemetry not yet configured." The first deploy intentionally crash-loops the backend if DSN is missing, but deploy-nas.sh skips the health gate during bootstrap so Glitchtip itself still comes up. Self-hoster sees the 503, knows to finish glitchtip-setup.md, then re-run deploy-nas.sh.

4. **Discord webhook mutation is serialized via `discordMutationTail` promise chain.** This prevents race: if two requests try to POST the webhook URL simultaneously, only one will actually mutate (the other awaits). If both tried to mutate, we'd stack duplicate webhooks.

5. **Usage log is append-only (`data/usage.jsonl`).** No updates; each Claude call (or error) appends a fresh line. The usage routes summarize the last 30 days on-read. This is immutable-log design: no risk of partial writes, no db locks, auditable forever.

6. **Device revocation is idempotent (INSERT OR IGNORE).** Revoking a device twice doesn't error. The `device_token_revocations` table marks it revoked; on next request, `verifyDeviceToken` sees the revocation and fails the device (app falls back to PIN re-pair). The original `device_tokens` row stays for audit.

7. **`/api/version` schema state returns "present:false" only if the DB file doesn't exist.** If it exists but the `schema_migrations` table is missing, schema.current is null (no migrations run yet). This lets the app distinguish "never initialized" from "misconfigured db path."

8. **Discord webhook URL validation is regex-only, not SSRF-guarded.** The dashboard doesn't make the HTTP call; Sonarr/Radarr do. So we only validate the hostname (discord.com or discordapp.com); no isPublicHttpsUpstream() call needed. If the dashboard ever does make the call, that comment says to add the guard.

## 6. QUIZ BANK

**Q1: A user reports "I get a 503 on /api/telemetry/config." The backend is otherwise healthy. What's the most likely cause, and how do you fix it?**
A: `EEX_TELEMETRY_DSN` is not set in `.env.production`. The backend is intentionally returning 503 (not an error, a signal that telemetry is not yet configured). Fix: follow glitchtip-setup.md §3–§4 to create a Glitchtip project and DSN, set `EEX_TELEMETRY_DSN`, then re-run `deploy-nas.sh`.

**Q2: You notice the iOS app keeps sending telemetry events to the old server (`errors.old.example.com`) even though you changed `EEX_TELEMETRY_DSN` to point to the new Glitchtip (`errors.new.example.com`). What went wrong?**
A: The iOS app cached the DSN at boot. The DSN is fetched once during app init and not re-checked. The app must be force-killed and re-launched to call `/api/telemetry/config` again and pick up the new DSN. (SPA: restart the browser. iOS: swipe-close and reopen from home screen.)

**Q3: The Discord webhook test fires successfully, but the household stops getting notifications on actual grabs. Which of the following is most likely NOT the cause?**
- A: Sonarr/Radarr API is down (list would fail, webhook test would not work).
- B: The Discord channel was deleted after the webhook was configured.
- C: Sonarr/Radarr restarted and lost the notification config.
- D: The webhook URL is wrong.
**A: A.** If Sonarr API is down, the webhook test (POST to `/api/v3/notification/{id}/test`) would fail with a 502/503 before the channel was ever deleted (B) or URL was wrong (D). Restarting Sonarr/Radarr can lose in-memory state but the dashboard's POST persists the config to the API, so C is less likely than B or D. The test endpoint is a real endpoint; a broken URL would fail the test.

**Q4: You want to track how many Claude calls each household member made this week. Which endpoint and which time-range should you use?**
A: `GET /api/usage/admin` (admin-only, all users) and calculate `Date.now() - 7 * 24 * 60 * 60 * 1000` (7 days). The route's hardcoded 30-day window is only for /me; the raw log is in `GET /api/usage/log` (default limit 50, max 200) and each line's timestamp is exact.

**Q5: A mobile app is trying to pair but the PIN endpoint returns `accepting_device_pairs: false`. Why might this be, and is it a blocker?**
A: The backend env var `deviceTokenSecret` is not set, so `env.deviceTokenSecret` is falsy. This gates pairing: mobile devices require the secret to encrypt device tokens. Fix: set `deviceTokenSecret` in `.env.production` (generate via `openssl rand -hex 32`), restart, and retry. Yes, it's a blocker; the PIN flow can't proceed without it.

## 7. CODE-READING EXERCISE

**Guided File Walk: `server/routes/telemetry.ts`**

Start with the docstring (lines 1–11). It tells you: this is §15.2 (section 15.2 of the contract), it's a DSN distribution point, and DSN is not a secret.

Lines 17–18: Create a Hono router. Telemetry is a sub-router mounted in the main app.

Lines 19–75: The single endpoint, `GET /config` with `requireAuth` guard.

Lines 20–35: Fetch `EEX_TELEMETRY_DSN` from the env. If missing, 503 + error detail. **Why 503?** The service (telemetry) is defined but its dependency (Glitchtip configured + DSN set) is missing. 5xx signals "temporary," which is correct — the next deploy-nas.sh will fix it.

Lines 37–68: Validate the DSN is a well-formed URL. Two checks:
1. Can it parse as a URL? Catch parse errors.
2. Does it use http or https? Reject file://, ftp://, etc.

**Why?** A misconfigured DSN (e.g., `glitchtip.local/1` without the scheme) would silently fail in the SDK at init time. The self-hoster would see no error and assume telemetry is working. Validating here means a bad DSN surfaces immediately as a 500 on this endpoint, so the operator gets feedback during bootstrap.

Lines 70–75: Return the DSN + environment (prod vs staging, based on `env.isProd`) + release tag. This is the payload the SDK init reads. **Note:** no secret material here. The `dsn` is the URL itself; the embedded project key is intentionally public (Sentry design).

**Key insight:** The route is *distribution only*. The backend doesn't do any error reporting itself here — it just answers "here's where you should send your telemetry." Server-side reporting is in `services/serverTelemetry.ts` (fire-and-forget, best-effort, never blocks).

---

**Next readings:**
- `server/services/serverTelemetry.ts` (how the server relays errors).
- `crates/emerald-contracts/src/telemetry.rs` (PII scrubbing schemas).
- `docs/operations/glitchtip-setup.md` (operational reality).
