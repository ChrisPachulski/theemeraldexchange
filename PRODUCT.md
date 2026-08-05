# PRODUCT — The Emerald Exchange

<!-- impeccable:product-schema 1 -->

## Platform

web

Native iOS/tvOS clients (EmeraldKit, milestone M2) are the roadmap target;
the platform value flips to `adaptive` when they land with their own design
language. Until then the shipped product is the web SPA.

## Register

*Legacy note (kept by owner request, 2026-08-04). Deprecated: the current
schema replaces the register axis with per-surface visitor modes; nothing
reads this section anymore.*

**product** — design serves the application. This is a tool, used repeatedly, by
people who already know what they want when they open it.

## Product Purpose

An invite-only, self-hosted streaming platform — a Plex-style media experience
the household owns end to end. Members sign in, browse the library, watch live
and on-demand, and request new titles; the owner curates and administers. The
goal is a product good enough to ship as native iOS/tvOS clients through the
App Store, not a homelab launcher. The underlying services (the *arr stack, SAB,
IPTV providers, the transcoder) are implementation detail — never promoted,
linked, or visible from inside the experience.

## Positioning

An invite-only streaming product the household owns end to end — App-Store-grade
polish over a self-hosted stack, with member signals never leaving the NAS. Plex
sells slick but rented; the *arr stack is owned but operator-grade; this is both
owned and polished. (Owner-confirmed 2026-08-04.)

## Users

Identity comes from three parallel providers — Plex OAuth, Sign in with Apple,
and WebAuthn passkeys — all converging on one invite/members allowlist the owner
controls. Three audiences, treated identically once authorized:

- **The owner (you)** — technical, administers the library and invites. Uses
  this nightly to curate content and watch. Does not want operator UIs cluttering
  the experience just because they were built first.
- **Household member** — non-technical. Wants to sign in, watch, and occasionally
  request a new title; never wants jargon. If they trigger a destructive action,
  the system catches them (confirmation modal); it doesn't pretend they can't
  reach it.
- **Invited remote member** — same shape as a household member, reaching the
  service over the Cloudflare Tunnel rather than the LAN.

There is **no admin/family split** in the consumption surface. Same surface,
same affordances, for everyone authorized. Capability differences (owner-only
admin: invites, members, devices) are surfaced through gated routes and
confirmations, not hidden modes.

## Operating Context

- Self-hosted on the household NAS, which also runs the owner's Plex Media
  Server; reached over the LAN at home and through a Cloudflare Tunnel for
  invited remote members. Same product either way.
- Evening couch traffic is the primary scene (phone in a dim living room);
  daytime kitchen check-ins on a tablet are the secondary one. Sessions are
  short and intentional: find a title, add or play it, put the device down.
- The owner administers nightly from inside the same consumption surface;
  operator tooling (Sonarr/Radarr/SAB) stays outside the member experience
  per the recorded exceptions under Product Principles.
- Active surfaces (downloads, live playback) poll; everything else is
  request-driven, and polling pauses when the tab is hidden.

## Capabilities and Constraints

- Stack: React/TypeScript SPA (Vite) with a Node server (`server/`); Rust
  crates provide media-core and the transcoder (hardware VAAPI encode);
  a recommender sidecar handles personalization; `EmeraldKit/` is the Swift
  package staged for the M2 Apple clients.
- In-browser playback of the local library ships via transcoded HLS through
  media-core and the transcoder when `USE_MEDIA_CORE=1`.
- **Live** appears only when IPTV is enabled; **Users** is owner-only.
- No public sign-up exists or ever will; authorization is the invite/members
  allowlist by construction.
- The repository stays private until the first binary is distributed;
  redistribution is not granted (see LICENSE).

## Tone and personality

Considered. Quiet confidence. The kind of interface that could pass for a
private members' page rather than a homelab launcher. **Not** the busy operator
density of Sonarr/Radarr; **not** the marketing chrome of Plex's web app;
**not** the SaaS-cliché tile-grid of Homepage/Homarr. The product's name — *The
Emerald Exchange* — was chosen on purpose, and the design should earn it.

Voice: short, confident, no jargon. No "successfully added!" exclamations; just
"Severance — added to library." Every word earns its place.

## Anti-references

- **Sonarr/Radarr add pages** — calendar-pinned chrome, history tables, advanced
  settings exposed by default. Operator complexity leaking into a consumption
  surface.
- **Plex web** — gradient hero rows, "Discover" upsell tiles, marketing of
  content the household already owns. Slick but loud.
- **Homepage / Homarr** — tile grids of identical cards. Generic homelab vibe.
- **Plex Dashboard / Tautulli** — operator stats masquerading as "for users."

## Product Principles

1. **The app is the experience.** No links to the underlying services inside it.
   No "open in full app" fallback. If the client can't do something a member
   reasonably needs, that's a bug to fix, not a link to add.

   *Recorded exception (2026-06-10, owner-approved):* the **Watch** entry in the
   nav (`HomeNav`/`TopNav`) opens Plex's hosted web client (app.plex.tv) in a
   new tab. Native in-browser playback has shipped (transcoded HLS through
   media-core and the transcoder, played by `MediaPlayer`) but has not yet
   reached parity with Plex's client. Watch stays as a deliberate,
   transitional affordance until native playback reaches feature parity —
   resume everywhere, subtitle support, and downloads-in-progress visibility —
   at which point it is removed. This exception is bounded to the Watch entry;
   it licenses no other link to an underlying service.

   *Recorded exception (2026-06-11, owner-approved):* the **"Play in Plex"
   per-title link** in `DetailModal` (deep-link or title-search into
   app.plex.tv for in-library titles, via `usePlexLinks`). Same rationale and
   same bound as the Watch entry: transitional, member-facing (playback is
   not an operator action), and removed when native playback reaches parity —
   resume everywhere plus subtitle support. It is the only per-title external
   link permitted; it licenses nothing else.

   *Recorded exception (2026-06-11, owner-approved):* the **admin apps links**
   (Sonarr / Radarr / SAB) in the user menu (`UserMenu`). These are operator
   tooling, not part of the member experience: they render for the
   **admin role only** (gated on `isAdmin`, which follows `effectiveRole` —
   an admin previewing as a user loses them with the rest of the admin
   chrome), and they are explicitly not member-facing. They do not weaken
   principle 1 for members: no member-visible surface links to an underlying
   service. The gate must never widen beyond the admin role.
2. **One unified UI.** No admin/family toggle on the consumption surface.
   Owner-only administration lives behind authorized routes, gated by the members
   allowlist — never by a hidden client mode.
3. **Invite-gated by construction.** No public sign-up. A user is authorized only
   if their identity is on the members allowlist; the Plex token is encrypted at
   rest and invite redemption is atomic and race-safe.
4. **Destructive is recoverable.** Every pause/delete/remove surfaces a
   confirmation modal. Cancel is the default; Enter does not submit destructive
   actions.
5. **Local-first personalization.** Recommendation runs on the household's own
   recommender sidecar; member signals never leave the NAS.
6. **Live where it matters, static where it doesn't.** Active surfaces (downloads,
   live playback) poll; everything else is request-driven. Polling pauses when
   the tab is hidden.

## Surface map

```
Home   ·   TV   ·   Movies   ·   Live   ·   Downloads   ·   Users
```

The consumption tabs are shared; **Users** (invites/members/devices) is
owner-only and bounces non-admins home; **Live** appears only when IPTV is
enabled. There is no separate "Media" tab: the local-library experience is
folded into **TV** and **Movies** (the `useMediaLibrary` hooks plus
`MediaPlayer`), which light up in-browser playback affordances when
media-core is mounted (`USE_MEDIA_CORE=1`). One catalog surface per content
type — a member never has to know whether a title plays from the local
library or is merely tracked.

## Evidence on Hand

- Real brand and atmosphere assets in the tree: the kraken video loops
  (`public/kraken.webm`/`.mp4`, calmer `public/resting.webm`/`.mp4`,
  `public/kraken-poster.jpg`), the WebGL gem scene (`src/lib/gemScene.ts`,
  rendered by `EmeraldMark`), brand files under `public/brand/`, and legal
  pages (`public/privacy.html`, `public/support.html`).
- The real content is the household's own media library, served live through
  the running stack; screenshots and demos can use it directly.
- There are no testimonials, case studies, press mentions, or external
  customers — this is a private household product. Future work must not
  fabricate any.

## Roadmap

M1 (IPTV core) and M1.5 (the cross-service contract gate) shipped. M3 (the
Rust media-core) is live in enforce mode and M4 (the transcoder) is deployed
with hardware VAAPI encode — the web SPA already plays the local library
through them. M2 brings the Apple clients (the App-Store target) and M5 the
native media clients; both remain ahead. The repository is public so the
self-host installer can fetch from it; redistribution is not granted (see
LICENSE).
