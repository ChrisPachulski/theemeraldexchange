
# Glossary: theemeraldexchange from First Principles

## WHAT & WHY

This codebase spans five technical domains: **streaming media** (HLS, codecs, transcoding), **web infrastructure** (SPAs, APIs, reverse proxies), **authentication & security** (OAuth, WebAuthn, JWE), **data & recommendations** (embeddings, vector DBs, collab filtering), and **self-hosted operations** (Docker, NAS, Cloudflare tunnels). A beginner hitting the README will encounter all of them in the first 5 minutes. This glossary translates each term into two levels: ELI5 (explain-like-I'm-five, zero jargon) and ELII (explain-like-I'm-an-intern, engineer-adjacent but still fast), then points to where it lives in the repo so learners can see it in context immediately.

---

## GLOSSARY

| Term | ELI5 | ELII | Where in Repo |
|------|------|------|---------------|
| **Allowlist** | A list of people/places you trust; everyone else is blocked. | Access control list (whitelist): explicit permit; default deny. | `server/middleware/` (CORS), `env.allowedOrigins`, members table in SQLite |
| **Bearer token** | A secret code you carry that proves who you are. | Stateless auth credential (OAuth access token, JWT); sent via `Authorization: Bearer <token>`. | `server/auth.ts`, Apple Sign-in device-pair flow |
| **Codec** | A recipe for squishing video into a smaller file and unsquishing it to watch. | Algorithm (H.264, HEVC, VP9) that encodes/decodes video frames; trade-off bitrate vs quality. | `crates/transcoder/`, `crates/media-core/` (video_codec enum) |
| **Container** | A wrapper that holds video, audio, subtitles, and metadata in one file. | Format (MP4, MKV, TS) that multiplexes streams + metadata; format ≠ codec. | `crates/media-core/`, `.file_extension` in database |
| **CORS** | Rules that say "JavaScript on Site A is allowed to talk to Site B." | Cross-Origin Resource Sharing; browser enforces same-origin policy; CORS headers (`Access-Control-Allow-Origin`) opt servers into exceptions. | `server/middleware/` (CORS), `env.allowedOrigins` |
| **CSRF** | A trick where Site X tricks your browser into making a bad request on Site Y. | Cross-Site Request Forgery; mitigated via state (Origin checks), CSRF tokens, or SameSite cookies. | `server/middleware/` (`requireSafeOrigin`), Origin gate on state-changing POSTs |
| **Docker Compose** | A config file that says "run these containers together with these settings." | Declarative container orchestration (docker-compose.yml); defines services, networks, volumes, env vars. | `/boot/config/plugins/appdata.backup/`, `compose.yml` on NAS |
| **Embed/Embedding** | A list of numbers that represent what a movie *feels like* (sad, action, romance). | Vector representation of semantic meaning (typically 384–1536 dims); used for similarity search. | `recommender/`, `sqlite-vec` embeddings, movie vectors for collab filtering |
| **EPG** | A TV guide that lists what's on each channel and when. | Electronic Program Guide (XML feed); maps channel IDs to programs + air times. | `server/services/iptv*.ts` (EPG), `ops-epg.md`, SAX parser for XML |
| **ffmpeg** | A tool that converts video from one format to another. | Universal media transcoder/remuxer; CLI that rewrites streams, applies filters, re-encodes. | `crates/transcoder/`, `scripts/`, Docker: `ffmpeg:latest` |
| **Forecast** | A guess about what you might watch next, based on what you've liked before. | Recommendation score (typically [0, 1]) from collab filtering + content features. | `recommender/`, `/api/suggestions`, `recommend()` function |
| **GrabEvent** | A notification that says "Sonarr/Radarr just grabbed a new episode/movie." | Signal event (grabbed, imported, renamed); drives `feedback` signal ingestion. | `server/`, `GrabEventType` enum, Sonarr/Radarr webhooks |
| **HLS** | A way to stream video by chopping it into tiny pieces, so if one breaks you don't lose the whole video. | HTTP Live Streaming; server creates `.m3u8` manifest + `.ts` segments; client fetches segments sequentially. | `crates/transcoder/`, `/api/transcode`, `Segment` struct |
| **Homelab** | A server you own and run at home (or your house), not rented from AWS/Azure. | Self-hosted infrastructure (NAS + Plex); owner retains data residency + control. | NAS at `theemeraldexchange.local`, `/mnt/user/appdata/` |
| **iGPU** | A tiny graphics chip built into your CPU that can speed up video processing. | Integrated GPU (Intel UHD/Iris, AMD Radeon); cheaper, lower power than discrete GPU. | `crates/transcoder/` VAAPI support, Intel Alder Lake on NAS |
| **IPTV** | A way to stream live TV channels through the internet instead of cable. | Live video + metadata protocol (m3u + EPG); no recording, just channels + guides. | `server/services/iptv*.ts`, `/api/iptv/*`, M3U playlists, Tvheadend |
| **JWE** | A secret message that's scrambled so only someone with the key can read it. | JSON Web Encryption (RFC 7516); encryptor encrypts plaintext → ciphertext. | `crates/emerald-contracts/`, Plex token encryption at rest |
| **JWT** | A signed message that says "this is who I am" and was signed by someone you trust. | JSON Web Token (RFC 7519); plaintext JSON + HMAC signature; can't be forged. | Apple Sign-in (RS256), JWE wrapper for Plex OAuth token |
| **Manifest** | A list that says "this video has segments 1, 2, 3... in this order, at these bitrates." | HLS playlist (.m3u8); indexes all segments + metadata (duration, bitrate, subtitles). | `crates/transcoder/`, `/api/transcode?title=X` returns manifest |
| **Middleware** | Code that runs on every request, like a bouncer checking IDs before you enter. | HTTP interceptor (before route handler); stacks compose: cors → csrf → auth → route. | `server/middleware/` |
| **Migrate/Migration** | Moving your data from the old schema to the new schema without losing anything. | SQL script that alters tables, adds columns, transforms data; idempotent (safe to re-run). | `server/services/db.ts` + `server/migrations/`, `*.sql` migration files, `db.run()` |
| **M3U** | A text file listing live TV channels with their stream URLs. | Playlist format (text); each line = channel name + stream URL (`#EXTINF`); consumed by players. | `server/services/iptv*.ts`, M3U playlists for Tvheadend |
| **NAS** | A box on your network that stores all your files and runs services. | Network-attached storage (Unraid in this case); CPU-shared between Plex, backend, recommender. | `root@theemeraldexchange.local`, 6-thread Celeron, `/mnt/user/appdata/` |
| **Netlify** | A service that hosts your website and rebuilds it automatically when you push code. | Static host + JAMstack CI/CD; serves compiled SPA, pulls from GitHub. | Frontend deployment target; Netlify builds & serves `src/` |
| **Origin** | The protocol + domain + port of a website (e.g., `https://example.com:443`). | HTTP origin tuple (`scheme://host:port`); used for same-origin policy + CORS. | `server/middleware/` (`requireSafeOrigin`), env.allowedOrigins |
| **OAuth** | A way for you to log in using your Google/Apple/Facebook account instead of making a password. | Delegated authorization (RFC 6749); user doesn't share password with app; identity provider (IdP) vouches. | Plex OAuth (PIN flow), Apple Sign-in |
| **Passkey** | A password you never have to type: your phone/computer unlocks it using your fingerprint. | WebAuthn credential (cross-platform); stored as private key on device; proves identity via challenge-response. | `server/routes/passkey.ts`, WebAuthn routes |
| **PIN Flow** | A way to sign in where you visit a website, get a PIN, show it to the app, and boom—you're in. | OAuth authorization code flow via out-of-band PIN; avoids typing on smart TV / native app. | `server/auth.ts`, Plex OAuth integration |
| **Proxy** | A middleman that receives requests, forwards them, and hands back the response. | HTTP interceptor that forwards traffic; can cache, rewrite, load-balance, or gate requests. | Backend `/api/transcode`, `/api/iptv/segment`, `/api/iptv/live` |
| **Radarr** | A tool that automatically finds and downloads movies you tell it to watch. | Arr-stack service (Sonarr for TV); monitors movies, grabs via SAB, imports to Plex. | `server/routes/radarr.ts`, webhooks, `GrabEvent` integration |
| **Remux** | Rewrapping a video in a new container without re-encoding; same content, different wrapper. | Stream copy (`-c:v copy -c:a copy`); low CPU, fast; only changes container, not codec. | `crates/transcoder/src/plan.rs`, `-c:v copy` for direct-play HLS |
| **Reverse proxy** | A server that pretends to BE the website you want to visit, but actually forwards to the real one. | Proxy that sits in front of origin servers; hides origin, load-balances, caches, gates traffic. | Cloudflare tunnel (`cloudflared` ↔ backend:3001) |
| **SSRF** | A trick where a hacker tricks your server into making a request to itself or another internal server. | Server-side request forgery; mitigated via request signing, allowlists on destination (scheme/host/port). | `server/routes/iptv.ts` (segment/live proxy), URL validation |
| **Segment** | One chunk of a video (a 2-second piece of a 1-hour movie). | HLS segment (.ts file); duration typically 2–10s; client fetches sequentially. | `crates/transcoder/`, segment generation + naming (seg_00000.ts) |
| **SHA-256** | A way to scramble text into a unique fingerprint; if text changes, fingerprint changes. | Cryptographic hash; deterministic, collision-resistant; used for file integrity + signing. | Token signing, playlist verification |
| **Signal** | A thumbs-up/thumbs-down, watch, or grab event that tells the system what you like. | Feedback event (like, dislike, watched, grab); scored by recommender + ingested into embeddings. | `server/routes/feedback.ts`, `server/services/watchSignal.ts`, `feedback` table |
| **Sonarr** | A tool that automatically finds and downloads TV episodes you tell it to watch. | Arr-stack service (for TV); monitors shows, grabs via SAB, imports to Plex; mirrors Radarr. | `server/routes/sonarr.ts`, webhooks, `GrabEvent` integration |
| **SPA** | A website that loads once, then uses JavaScript to change what you see without reloading. | Single-page application (React 19 in this case); client-side routing, API fetches. | `src/`, entry `src/main.tsx`, Vite bundler |
| **sqlite-vec** | An extension to SQLite that lets you store and search lists of numbers (embeddings) super fast. | Vector database layer; indexed dot-product search for similarity (`<->`). | `recommender/`, embedding search for recommendations |
| **SQLite** | A database file that lives on your computer; no separate server, no passwords. | Embedded relational DB (ACID); single-file, zero setup; used for members, tokens, library. | `server/services/db.ts` + `server/migrations/`, member allowlist, auth state, library metadata |
| **Stream** | Video/audio data flowing from server to your device as you watch. | Continuous bitstream; HLS uses segment fetches to simulate streaming. | Playback, transcode output, live IPTV channels |
| **Swagger/OpenAPI** | A way to document an API so people know what endpoints exist and what they return. | Machine-readable API spec (YAML/JSON); automates docs, client code generation. | `server/app.ts` (Hono), optional Swagger integration |
| **Token** | A secret that proves you have permission to do something. | Credential (JWT, Plex OAuth token, stream token); stateless (self-contained) or stateful (cached). | `server/auth.ts`, stream tokens, JWE-wrapped Plex token |
| **Transcode** | Converting a video from one format (e.g., HEVC) to another (e.g., H.264) for compatibility. | Decode + re-encode; CPU-intensive; needed when client can't play native codec. | `crates/transcoder/`, H.264/H.265 support matrix |
| **Tvheadend** | A server that streams live TV from an antenna/cable box and provides an EPG. | IPTV source (backend); provides M3U playlists + EPG XML. | IPTV input, `/api/iptv/` integration |
| **VAAPI** | A way to use your GPU to speed up video encoding/decoding. | Video Acceleration API (Intel/AMD); hardware codec support via `/dev/dri/renderD128`. | `crates/transcoder/`, h264_vaapi encode, hwaccel vaapi decode |
| **Vector** | A list of numbers representing one thing (a movie) so you can compare it to other lists numerically. | Embedding; used for math (dot product = similarity); bridges discrete features → continuous space. | `recommender/`, sqlite-vec, collab filtering |
| **Vite** | A tool that bundles your React code into fast, optimized JavaScript for the browser. | Frontend build tool + dev server; ES module-native, HMR, fast cold start. | `src/`, `vite.config.ts`, `npm run dev` |
| **WAL** | A log file that SQLite uses to track changes before writing them to the main database file. | Write-ahead log; ensures crashes don't corrupt the DB. | `server/services/db.ts` + `server/migrations/`, `.db-wal` files (transient), backup gotchas |
| **WebAuthn** | A standard that lets you sign in using your device's built-in security (fingerprint, face scan, USB key). | W3C standard (FIDO2); passwordless; private key never leaves device. | `server/routes/passkey.ts`, cross-platform passkeys |
| **Webhook** | A URL that another service calls to tell you something happened. | HTTP callback; Sonarr/Radarr call `/api/sonarr/event` when they grab. | `server/routes/sonarr.ts`, `server/routes/radarr.ts`, event ingestion |

---

## CLUSTERS

### **Web & Frontend**
SPA, Vite, Middleware, CORS, Origin, CSRF, Proxy, Allowlist, Token, Bearer Token, Swagger/OpenAPI

### **Authentication & Security**
OAuth, PIN Flow, WebAuthn, Passkey, JWT, JWE, Token, CSRF, CORS, Origin, SHA-256

### **Media & Streaming**
HLS, Manifest, Segment, Codec, Container, Transcode, Remux, ffmpeg, Stream, VAAPI, iGPU, Tvheadend, IPTV, M3U, EPG, GrabEvent

### **Database & Data**
SQLite, Migrate/Migration, WAL, Embed/Embedding, Vector, sqlite-vec, Signal

### **Infrastructure & Operations**
NAS, Docker Compose, Homelab, Reverse Proxy, Cloudflare (via memory), Netlify, Sonarr, Radarr, SSRF, Proxy

### **Recommendation System**
Forecast, Signal, Embed/Embedding, Vector, sqlite-vec, Collab Filtering (implicit)

---

## QUIZ BANK

**Q1: A user watches "Barbie" (HEVC, which their iPhone doesn't support). Explain the request path.**
*A: Browser calls `/api/transcode?title=barbie`. Backend checks codec support; HEVC ∉ iPhone. Transcoder decodes (decode: HEVC), re-encodes H.264 (H.264_vaapi on iGPU), wraps in HLS (Manifest + Segments). Returns m3u8; player fetches segments. Each segment is a .ts chunk ≈2s long.*

**Q2: A Sonarr webhook fires saying "The Office S07E01 imported." What happens?**
*A: Sonarr POST→`/api/sonarr/event`. Backend parses GrabEvent (imported status). Signal ingester marks episode as grabbed. Feedback table updates. Recommender re-scores: this signal boosts "The Office" relevance + co-engagement weight (users who like it). Next refresh, suggestion strip reranks.*

**Q3: Why is `Origin: https://badsite.com` on a POST to `/api/feedback` rejected?**
*A: Middleware checks `requireSafeOrigin`. Origin not in `env.allowedOrigins` → 403 CSRF. Browser same-origin allows `<form>` CSRF (GET + POST redirect). API-only clients (native app, SPA) send Origin header; server gates state-change. This blocks malicious website tricks.*

**Q4: The Plex OAuth token is encrypted at rest (JWE) but the bearer token (JWT from passkey) is NOT. Why?**
*A: Plex token = long-lived refresh token; compromise = full Plex access. JWE (encrypted) protects it in SQLite. Passkey session JWT = short-lived (hours), signed only; stolen JWT is time-bound + user can revoke device. Trade-off: encryption cost vs risk window.*

**Q5: A new member joins. They see 817 movies in the catalog but only 50 in the "Trending" strip. Why?**
*A: `/api/suggestions?mode=trending` fetches from recommender. Recommender scores all 817 but returns only top-N (≈20) hits. Backend applies filterRecommenderSafe (allowlist + MPAA rating). Render layer slices to ~8. Collisions (franchise rules, dup IDs) drop count further. Next: improve recall in recommender, not padding.*

**Q6: You SSH in and see `/scratch/seg_00001.ts` files from a crashed transcode session. Why keep the logs but purge segments?**
*A: Segments are transient (part of active HLS stream). Logs debug why encoding failed (GOP, filter, codec support). Session reap daemon (`transcoder`) auto-deletes `/scratch` after 30s idle. Logs ship to Glitchtip (telemetry) before deletion. Segments pollute `/scratch` (tmpfs, limited RAM); purge early.*

