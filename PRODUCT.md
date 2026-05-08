# PRODUCT — The Emerald Exchange

## Register

**product** — design serves the application. This is a tool, used repeatedly, by people who already know what they want when they open it.

## Product purpose

A unified media dashboard at `http://theemeraldexchange.local` that **replaces** the operator-grade UIs of Sonarr, Radarr, and SAB for the people who live in this household. One bookmark. Find a show, find a movie, see what's downloading, open Plex. The dashboard is the experience — the underlying apps are not promoted, linked, or visible from inside it. If they're ever needed for true admin tasks, the operator (the household's owner) knows the ports.

## Users

Three audiences, treated identically:

- **The owner (you)** — technical, familiar with the *arr stack and SAB. Uses this nightly to add new content and peek at the queue. Does not want the operator UIs cluttering the experience just because they were built first.
- **Partner / household member** — non-technical. Wants Plex, occasionally wants a new show added, never wants jargon. If they accidentally click a destructive button, the system catches them (confirmation modal); it doesn't pretend they can't reach it.
- **Brother (future, mutual-backup arrangement)** — same shape as the owner, but accessing remotely once Tailscale routes are in place. Not load-bearing for V1.

There is **no admin/family split** in the UI. Same surface, same affordances, for everyone. Differences in capability are surfaced through confirmations, not hidden modes.

## Tone and personality

Considered. Quiet confidence. The kind of interface that could pass for a private members' page rather than a homelab launcher. **Not** the busy operator density of Sonarr/Radarr; **not** the marketing chrome of Plex's web app; **not** the SaaS-cliché tile-grid of Homepage/Homarr. The product's name — *The Emerald Exchange* — was chosen on purpose, and the design should earn it.

Voice: short, confident, no jargon. No "successfully added!" exclamations; just "Severance — added to library." Every word earns its place.

## Anti-references

- **Sonarr/Radarr add-series pages** — calendar-pinned chrome, history tables, "Series Folder Format" advanced settings exposed by default. Operator complexity leaking into a consumption surface.
- **Plex web** — gradient hero rows, "Discover" upsell tiles, marketing of content the household already owns. Slick but loud.
- **Homepage / Homarr** — tile grids of identical cards with logo + title + URL. Generic homelab vibe. Functional, but the design itself is a category cliché.
- **Netflix request flows** — infinite-scroll movie databases, "Trending now" rails, recommendation engines. Not what this is.
- **Plex Dashboard / Tautulli** — operator stats and graphs masquerading as "for users."

## Strategic principles

1. **The dashboard is the experience.** No links to Sonarr/Radarr/SAB inside it. No fallback to "open in full app." If the dashboard can't do something a household user reasonably needs, that's a bug to fix, not a link to add.
2. **One unified UI.** No admin/family toggle. Same surface for every visitor. Capability is gated by confirmation, never by hidden modes.
3. **Smart defaults make adding one click.** Quality profile, root folder, monitor strategy — pre-populated from the underlying service's existing configuration. The choosers are visible (not hidden), but the user shouldn't need to touch them on the happy path.
4. **Destructive is recoverable.** Every pause/delete/remove surfaces a confirmation modal. Cancel is the default; Enter does not submit.
5. **Search is the verb.** TV and Movies tabs are search surfaces, not browse surfaces. No "trending," no "popular this week," no recommendation rails. The user already knows what they want when they open the tab.
6. **Live where it matters, static where it doesn't.** Downloads tab polls every 3 seconds; everything else is request-driven. Polling pauses when the tab is hidden.

## Surface map (V1)

```
Watch (→ Plex)   ·   TV   ·   Movies   ·   Downloads
```

Four tabs. No fifth admin tab. No settings panel in V1 (defaults inherit from the underlying services).

## Out of scope (V1)

Episode picker, calendar view, settings panel, Tautulli stats, home tab with widgets, Netlify production deploy. All deferred to V2 or later. Listed in the plan file at `~/.claude/plans/instead-could-we-robust-journal.md`.
