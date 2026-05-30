# PRODUCT — The Emerald Exchange

## Register

**product** — design serves the application. This is a tool, used repeatedly, by
people who already know what they want when they open it.

## Product purpose

An invite-only, self-hosted streaming platform — a Plex-style media experience
the household owns end to end. Members sign in, browse the library, watch live
and on-demand, and request new titles; the owner curates and administers. The
goal is a product good enough to ship as native iOS/tvOS clients through the
App Store, not a homelab launcher. The underlying services (the *arr stack, SAB,
IPTV providers, the transcoder) are implementation detail — never promoted,
linked, or visible from inside the experience.

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

## Strategic principles

1. **The app is the experience.** No links to the underlying services inside it.
   No "open in full app" fallback. If the client can't do something a member
   reasonably needs, that's a bug to fix, not a link to add.
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
Home   ·   TV   ·   Movies   ·   Media   ·   Live   ·   Downloads   ·   Users
```

The consumption tabs are shared; **Users** (invites/members/devices) is
owner-only and bounces non-admins home. **Media** appears when media-core is
mounted (`USE_MEDIA_CORE=1`); **Live** when IPTV is enabled.

## Roadmap

M1 (IPTV core) shipped. M1.5 is the cross-service contract gate. M2 brings the
Apple clients (the App-Store target), M3 the Rust media-core, M4 the transcoder,
M5 the native clients. The repository stays private until the first binary is
distributed; redistribution is not granted (see LICENSE).
