# DESIGN — The Emerald Exchange

## Register

**product** — informs all subsequent calls. See [PRODUCT.md](./PRODUCT.md).

## References (extreme inspiration)

Two studios, both gating their work on advanced WebGL, both using the same
typographic family. We're stealing the chrome, not the chrome's prerequisites.

- **igloo.inc** — atmospheric depth, frozen-cathedral palette, **HUD pods** as
  navigation, **constellation/network overlay** as decorative subtext,
  ice-block geometry on cards.
- **activetheory.net** — pure-black cinema, **pill chips at 500px radius**,
  **ASCII glyph punctuation** (`->`, `--`, `<<`, `>>`), **marquee** project
  rolls, NB Architekt-style geometric display type, terminal-meets-cinema
  texture.

What we don't take: WebGL hero scenes, scroll-hijacking, brand wordmarks at
40vw. This is a tool used nightly, not a portfolio reel — the chrome carries
the reference; the function stays instant. (The narrow, owner-approved
atmosphere exceptions — the WebGL brand mark, the kraken video, and the
dormant Beacon gem video — are recorded under "Recorded exceptions" below.)

## Physical scene (forces theme)

> Owner sits on the couch at 9:42pm with their iPhone, living room dim, TV playing background music, dinner cleared. They want to find one specific show they thought of mid-conversation, add it, and put the phone down. *Or* — partner picks up the iPad in the kitchen mid-morning, sun through the window, wonders whether the new season of something has finished downloading.

Both ends of the day exist. Evening is the heavier traffic. **Theme: dark default, no light theme in V1** — anything we'd build for the kitchen scene would be a low-value light-mode toggle that bloats the surface; a well-tinted dark UI is legible in both lights, and the evening case is where the design lives.

## Color strategy — locked

**Committed and locked.** The product's name commits us — *Emerald* in the URL is a promise. Restrained would betray it. Drenched would suffocate. **The palette never changes.**

One saturated emerald carries the accent — primary buttons, the "In Library" badge, the mode toggle's active segment, the progress-bar fill, the focus ring. Everything else is a tinted neutral built from the same hue family.

### OKLCH palette

```
--bg            oklch(0.16 0.012 158)    /* near-black, faint emerald cast */
--surface       oklch(0.20 0.014 158)    /* one step up — modal, card surfaces */
--surface-2     oklch(0.24 0.016 158)    /* hover, secondary surfaces */
--border        oklch(0.30 0.020 158)    /* subtle dividers */
--text          oklch(0.94 0.008 158)    /* primary text, faint warm cast */
--text-muted    oklch(0.70 0.012 158)    /* secondary text */
--text-subtle   oklch(0.52 0.014 158)    /* placeholders, captions */

--emerald       oklch(0.62 0.180 158)    /* the accent — primary actions, in-library, progress */
--emerald-dim   oklch(0.45 0.130 158)    /* hover-down for accent on dark */
--emerald-bg    oklch(0.30 0.080 158)    /* tinted-fill backgrounds for accent surfaces */

--danger        oklch(0.62 0.180 25)     /* destructive action button — same lightness/chroma as emerald, opposite hue */
--danger-dim    oklch(0.45 0.130 25)
```

New in this revision (additions only — the values above are LOCKED):

```
--frost         oklch(0.94 0.008 158 / 0.06)    /* top-edge highlight on ice-block surfaces */
--ink           oklch(0.04 0 0 / 0.5)           /* deep cool shadow under cards / modal backdrop */
--scrim         oklch(0.06 0.005 158 / 0.72)    /* modal backdrop fill */
```

**Never `#000` or `#fff`.** Never gradient text. Never side-stripe colored borders.

## Typography — display lift

We add ONE display face for chrome and large headings. Body text stays system
for read-speed and for keeping the bundle near zero.

```
font-family-display: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, sans-serif;
font-family-body:    ui-sans-serif, system-ui, -apple-system, "SF Pro Text", "Inter", sans-serif;
font-family-mono:    ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", monospace;
```

Space Grotesk is the canonical free analogue to NB Architekt — geometric
proportions, slightly condensed feel, holds up bold. Loaded today from
Google Fonts (`index.html` preconnects to fonts.googleapis.com/gstatic and
pulls weights 400–700 with `display=swap`). Self-hosting the woff2 files
remains the intended end state — it drops the third-party request before
any public or native ship — and is recorded debt, not a settled choice.

Display is reserved for: brand wordmark, search hero prompt, modal eyebrow
labels, tab labels in the HUD pod, large empty-state titles. Everywhere else
keeps system body for nightly-use legibility.

Mono is reserved for: filenames in the Downloads queue, sizes (4.2 GB), ETAs,
MB/s — anything that benefits from numeric alignment — and for the **ASCII
glyph punctuation** we use (`->`, `--`, `<<`, `>>`).

### Scale (1.25 ratio between steps — never flat)

```
--t-xs     0.75rem   /* captions, badges, HUD micro-type */
--t-sm     0.875rem  /* secondary text, table cells */
--t-base   1rem      /* body */
--t-md     1.125rem  /* tab labels, modal titles, queue filename */
--t-lg     1.5rem    /* search input, tab content headings */
--t-xl     2.25rem   /* nav brand mark, splash empty states */
--t-2xl    3rem      /* search hero prompt — "what are you looking for" register */
```

Weights: 300 / 400 (body), 500 (UI/labels), 600 (titles), 700 (display
wordmark, search hero). Weight contrast carries hierarchy when scale alone
doesn't.

Tracking pattern (signature move): tight on display headings, **wide
uppercase** on chrome eyebrow labels (`letter-spacing: 0.14em`), slightly
loose on HUD micro-type (`0.04em`). The contrast between display
condensed-tight and uppercase-tracked-wide is what makes the system feel of-
a-piece across screens.

## ASCII glyph punctuation (signature)

Used sparingly as inline visual texture. Always in mono, always at
`--text-subtle` unless they're carrying meaning.

- `->` before action labels in copy ("→" not allowed; use the literal ASCII)
- `--` between paired metadata (`Severance -- 2022 -- Apple TV`)
- `<<` `>>` as previous/next markers in marquees and history strips
- `[ ]` brackets around micro-status (`[ DOWNLOADING ]`)

These are texture, not iconography. Never replace a button's affordance with
brackets — buttons stay buttons.

## Spacing & rhythm

Vary, do not repeat. Same padding everywhere reads as monotony.

```
--s-1   4px
--s-2   8px
--s-3   12px
--s-4   16px
--s-5   24px
--s-6   32px
--s-7   48px
--s-8   72px
--s-9   96px
```

- **HUD pod vs page**: `s-7` vertical breathing above page content (the pod
  floats with margin around it)
- **Card-to-card gaps**: `s-4`
- **Inside cards**: `s-3`
- **Modal**: `s-6` outer, `s-4` between fields
- **Search dock pad**: `s-7` above the input inside the fixed bottom dock
  (`s-5` below), tightening one step on narrow viewports

## Radii — pill where it can pill

Active Theory's signature is the 500px radius pill on chips. We adopt it for
chips and HUD primitives; cards stay rectangular with substantial 14px
rounding (the ice-block silhouette).

```
--r-sm   6px     /* small inline buttons, badges */
--r-md   12px    /* selects, inline inputs, queue rows */
--r-lg   14px    /* media cards, search panel */
--r-xl   18px    /* modal panels */
--r-pod  500px   /* HUD pod nav, mode-toggle pill, In-library badge */
```

## Layout philosophy

- **Floating HUD pod** for the top nav. Not a sticky bar — a pill-shaped
  capsule, centered, with internal hairline dividers between brand · tabs ·
  Watch. Pinned to the viewport top with a small inset, gets a subtle
  backdrop-blur (earned glassmorphism — see the glassmorphism law under
  anti-patterns for where else blur is permitted).
- **No card-grid monotony.** Search result cards: poster-led, asymmetric.
  Title and metadata flow alongside the poster, not stacked uniformly under
  it. The "In Library" badge breaks the card edge slightly — small visual
  interrupt that earns attention. Cards have an **ice-block silhouette**: top
  edge picks up a frost highlight, bottom drops a cool shadow.
- **Search-as-dock on TV/Movies tabs.** The search input lives in a fixed
  dock at the viewport bottom (`tv-tab__dock`), floating over the result
  grid on a soft top-fading gradient so the kraken atmosphere bleeds
  through instead of being cut by a hard chrome edge. The input itself is a
  panel (rounded `--r-lg`), not a hairline-bottomed text field. The
  original top-hero treatment (a large display-weight prompt above the
  input) survives as `SearchInput`'s optional `prompt`, currently unused.
- **No nested cards.** Modals sit on `--surface`; their content sits directly
  on it, not in nested boxes.
- **Atmospheric overlay**: the live atmosphere is the kraken video loop
  (recorded exception below) playing behind everything, no pointer-events.
  The original static-SVG constellation (faint network of dots and lines,
  CSS-only 80s drift, drift removed at `prefers-reduced-motion`) remains in
  the tree (`Constellation.tsx` + the `.constellation` rules in
  `global.css`) but is currently unmounted — it is the fallback atmosphere
  if the video ever has to go, not a second simultaneous layer.

## Motion — atmospheric, still subtle

Slightly slower than V1 to feel cinematic, never theatrical.

- **Easing:** `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out-quint) for everything
- **Duration:** 180–280ms for state changes (hover, modal open, toast slide-in)
- **Constellation drift:** 80s translateX, infinite, alternates (spec kept
  for the dormant SVG fallback; the shipped atmosphere is the kraken loop)
- **No animation of layout properties.** Use opacity and transform only
- **No bounce, no spring, no elastic**

## Components — first-pass principles

- **HUD pod nav**: floating pill (`--r-pod`), `surface` with `backdrop-filter:
  blur(14px)` and a hairline `border` at low alpha. Brand wordmark left in
  display weight 700 with very tight tracking. Tab labels uppercase tracked
  wide. The active tab is not marked — it is removed from the pill entirely
  (the page you are already on is not a navigation action), with a quiet
  "you are here" label under the brand wordmark for wayfinding. Watch sits
  at the right with a 1px hairline divider before it, the gem glyph +
  "Watch" label, and a small `->` mono glyph trailing (a recorded PRODUCT.md
  exception: it opens Plex's web client until native playback reaches
  parity).
- **Search panel**: input in a panel (rounded `--r-lg`), no
  bottom-border-only treatment, docked at the viewport bottom on the
  catalog tabs. Empty input shows `letter-spacing: 0.04em` placeholder.
  The optional display-700 `--t-2xl` prompt above the input is retained in
  the component (`SearchInput`'s `prompt`) but not currently rendered.
- **Result card / ice block**: poster (3:4) left, title + meta + overview
  right. Outer container has the ice-block treatment: subtle inset top
  highlight via box-shadow (`inset 0 1px 0 var(--frost)`) plus an outer cool
  drop. Hover lifts the frost highlight (no scale).
- **Mode toggle**: pill (`--r-pod`) with two segments. Active segment fills
  with `--emerald-bg`, count badge inside the active segment uses
  `--emerald` for the number.
- **In-library badge**: pill (`--r-pod`), wide uppercase tracking, breaks the
  poster corner.
- **Add modal**: large rounded panel (`--r-xl`), subtle frost-edge inset,
  eyebrow `[ ADD TO LIBRARY ]` in uppercase tracked + `--emerald`, three
  selects inline, primary "Add to library ->" with the ASCII arrow trailing.
- **Confirm modal**: same lift treatment. Cancel default-focused. Destructive
  in `--danger`. ESC = cancel. Enter does NOT submit — only ESC and Cancel
  click close, only Confirm click executes.
- **Queue row / telemetry strip**: filename (mono) `--` category (mono
  `--text-subtle`) `--` size right-aligned. Progress bar full-width below
  with an emerald fill that has a 1px brighter leading edge (no glow halo —
  too noisy at 3 Hz updates). Status mono uppercase: `[ 47% ]`, `[ PAUSED ]`.
- **Toast**: bottom-center pill, `surface` fill, `--text` content, generous
  shadow.

## Anti-patterns this design refuses

(Impeccable shared design laws plus product-specific.)

- Side-stripe borders (`border-left: 4px solid` accent on cards/list rows). Never.
- Gradient text. Never.
- **Glassmorphism by default.** Backdrop-blur is reserved for floating
  chrome that sits over the moving kraken atmosphere — the HUD pod, the user
  menu, the replay button, the alphabet rail, sticky toolbars — and for
  modal scrims at low radius (frost-on-glass over live video is the literal
  metaphor). Never as a default card or content-surface treatment.
- Hero-metric template (big number, small label, sparkline). Has no place here.
- Identical card grids. Search results vary by content; the chrome should not standardize them into sameness.
- Modal-as-first-thought. Modals are the exception, never the default — a
  surface earns one only when its task is genuinely modal (committing an
  add, confirming a destructive action, focused detail/selection/playback).
  Every modal must take a complete a11y contract — focus trap, Escape,
  `aria-modal` semantics, and a scrim — via one of two sanctioned
  mechanisms:
  - **Native `<dialog>` + `showModal()`** (the platform supplies the trap
    and Escape; `useDialogDismiss` owns open/close + deferred unmount):
    AddMovieModal, AddSeriesModal, ConfirmModal, DetailModal.
  - **`role="dialog"` div + `useModalA11y`** (the shared hook supplies the
    trap + Escape + focus restore): EpisodePicker, MediaPlayer,
    ConcurrencyLimitModal, the IPTV connections panel
    (`ConnectionsWidget`), and the fullscreen IPTV players in
    VodTab / LiveTab / IptvSeriesTab. As of the 2026-06 hardening wave
    every `role="dialog"` surface in the tree takes `useModalA11y` —
    including the connections panel, whose missing trap was the previously
    recorded debt (paid down in `628a7ac`).
  Recorded debt, not silent license: raw hex color literals still bypass
  the OKLCH tokens at real scale — ~97 occurrences across 12 CSS files at
  last count (`grep -rEo '#[0-9a-fA-F]{3,8}\b' src --include='*.css'`).
  The main offenders: `src/index.css` (~64, including the `iptv-conn-*`
  modal styles), `auth/AppleSignInButton.css` (~7 — Apple's mandated
  button branding, likely permanent), `player/IptvPlayer.css`,
  `auth/InvitesPanel.css`, `auth/DevicesPanel.css` (~5 each), and
  `tabs/UsersTab.css` (4). This is tracked debt to migrate toward the
  token palette (Apple branding excepted); it permits no new hex.
- Em dashes in copy. (Comma, semicolon, period, parens.)
- WebGL hero scenes. Three.js stays out of layout and content surfaces. The
  owner-approved atmosphere exceptions below (the WebGL brand mark, the
  kraken video, the dormant Beacon) are the ceiling, not a wedge — no
  scroll scenes, no WebGL heroes.

## Recorded exceptions (owner-approved)

The laws above describe the system this doc locks; these are the deliberate,
bounded departures the owner has approved. They are recorded so doc and tree
agree — they set ceilings, not precedents.

- **WebGL emerald brand mark.** The brand mark is a live Three.js
  brilliant-cut gem scene (`src/lib/gemScene.ts`, rendered by `EmeraldMark`
  in both navs and driving the animated favicon). Originally a three-gem
  row, consolidated to a single centred gem in `36fc64c` (the row read as
  a noisy green stripe at mark sizes); the scene keeps a `gemCount` option
  but every placement renders the single variant. It earns its WebGL: the
  product's name promises a jewel, and a static SVG read as clip-art.
  Scope: the mark and favicon only.
- **Kraken video atmosphere.** The page background is a full-screen video
  loop (`Kraken.tsx`: `kraken.webm`/`.mp4` on Home, a calmer `resting`
  variant on inner tabs), playing behind everything with no pointer-events.
  It supersedes the static-SVG constellation as the live atmosphere; the
  constellation stays in the tree as the fallback. Floating chrome over the
  moving video is also why backdrop-blur extends beyond the HUD pod (see
  the glassmorphism law above).
- **Beacon gem video (dormant).** A live-action alpha-cutout emerald loop
  (`src/components/atmosphere/Beacon.tsx`, `public/gem.webm` — two phase-
  offset `<video>` elements cross-faded so the loop seam never shows),
  originally pinned top-right as the prize the kraken reaches for. It is
  **currently unmounted**: the App mount was dropped in the home-page
  redesign (`faf29ca`) and its walkthrough stage was replaced by the
  single WebGL gem (`36fc64c`). Like the constellation, it stays in the
  tree (component + shipped assets) as recorded atmosphere inventory —
  remounting it is an owner decision, not a license this doc grants.

## What "done" looks like visually

A first-time visitor on a phone, opens the dashboard. The kraken drifts in
the dark behind everything. A floating emerald-flecked pod hovers at the
top — the live gem turning beside `EMERALD EXCHANGE`, `TV SHOWS · MOVIES ·
DOWNLOADS`, `WATCH ->` at the right. They tap into TV Shows; the search
panel waits in a dock at the bottom of the scene. They start typing —
three poster cards land quietly, ice-block silhouette, frost catching their
top edges. One has a pill `[ IN LIBRARY ]` badge breaking its corner. They
tap it. A confirmation panel lifts off the surface. The interaction took 14
seconds and felt like the only natural thing to have happened.
