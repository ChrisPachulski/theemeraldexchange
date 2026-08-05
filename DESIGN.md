---
name: The Emerald Exchange
description: Invite-only household streaming — terminal-meets-cinema chrome over a deep emerald dark
colors:
  bg: "oklch(0.16 0.012 158)"
  surface: "oklch(0.20 0.014 158)"
  surface-2: "oklch(0.24 0.016 158)"
  border: "oklch(0.30 0.020 158)"
  text: "oklch(0.94 0.008 158)"
  text-muted: "oklch(0.70 0.012 158)"
  text-subtle: "oklch(0.52 0.014 158)"
  emerald: "oklch(0.62 0.180 158)"
  emerald-dim: "oklch(0.45 0.130 158)"
  emerald-bg: "oklch(0.30 0.080 158)"
  danger: "oklch(0.62 0.180 25)"
  danger-dim: "oklch(0.45 0.130 25)"
  frost: "oklch(0.94 0.008 158 / 0.06)"
  frost-stronger: "oklch(0.94 0.008 158 / 0.10)"
  ink: "oklch(0.04 0 0 / 0.55)"
  scrim: "oklch(0.06 0.005 158 / 0.72)"
typography:
  display:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, -apple-system, SF Pro Display, Inter, sans-serif"
    fontSize: "3rem"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, -apple-system, SF Pro Display, Inter, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, SF Pro Text, Inter, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, -apple-system, SF Pro Display, Inter, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "0.14em"
  mono:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    letterSpacing: "0.04em"
rounded:
  sm: "6px"
  md: "12px"
  lg: "14px"
  xl: "18px"
  pod: "500px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
  s-7: "48px"
  s-8: "72px"
  s-9: "96px"
components:
  button-primary:
    backgroundColor: "{colors.emerald}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pod}"
    padding: "12px 24px"
  button-primary-hover:
    backgroundColor: "{colors.emerald-dim}"
  button-cancel:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pod}"
    padding: "12px 24px"
  badge-in-library:
    backgroundColor: "{colors.emerald-dim}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pod}"
    padding: "3px 8px"
  select:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "12px"
  modal-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "32px"
---

# Design System: The Emerald Exchange

## Overview

**Creative North Star: "The Kraken's Jewel Box"**

The deep guards one emerald: atmospheric menace outside, precise jewel-case
order inside. A live kraken drifts in near-black water behind everything;
floating over it, frost-glass chrome holds the household's library with the
quiet confidence of a private members' page. The register is
terminal-meets-cinema — geometric display type tracked wide in the chrome,
mono glyph punctuation (`->`, `--`, `[ ]`) in the telemetry — stolen from
igloo.inc (frozen-cathedral depth, HUD chrome, ice-block geometry) and
activetheory.net (pure-black cinema, 500px-radius pills, ASCII texture),
without their WebGL-gated prerequisites. This is a tool used nightly at
9:42pm on a couch: the chrome carries the reference, the function stays
instant.

Both ends of the day exist (dim living room on a phone; sunlit kitchen on a
tablet — see "Physical scene" below), but the evening case is where the
design lives. **Dark only, no light theme in V1** — a well-tinted dark UI is
legible in both lights.

**Key Characteristics:**
- One locked emerald accent over tinted-neutral surfaces all built on hue 158
- Frost-glass chrome (backdrop-blur) earned only by floating over the moving kraken
- Ice-block cards: frost top-edge highlight, deep cool shadow, jewel-case emerald border
- Pill silhouettes (500px radius) for chrome; 14px rectangles for content
- Mono ASCII glyphs as texture, never as iconography
- Motion is cinematic but subtle: one easing curve, opacity/transform only

## Colors

A single saturated emerald carries every accent; everything else is a tinted
neutral built from the same hue family (h=158). The palette is **LOCKED** —
the product's name is a promise, and the emerald never changes.

### Primary
- **Cut Emerald** (`--emerald`, oklch(0.62 0.180 158)): the one jewel. Primary
  action buttons, the In-Library badge family, progress-bar fill, focus rings,
  active-state text, hover borders. Committed strategy: rare enough to matter.
- **Deep-Water Emerald** (`--emerald-dim`, oklch(0.45 0.130 158)): hover-down
  state for primary actions; badge fill.
- **Emerald Shadow** (`--emerald-bg`, oklch(0.30 0.080 158)): tinted-fill
  background for active toggle segments and category chips.
- Derived accent states (additions only, mathematically unable to leave hue
  158): `--emerald-hover` (color-mix 88% emerald + 12% white),
  `--emerald-ghost` (12% emerald over transparent), `--hairline-emerald`
  (30% emerald hairline borders).

### Neutral
- **Abyssal Green-Black** (`--bg`, oklch(0.16 0.012 158)): the page dark; the
  water the kraken swims in. Faint emerald cast, never pure black.
- **Slate Depth** (`--surface`, oklch(0.20 0.014 158)): cards, modal panels,
  chrome fills.
- **Risen Slate** (`--surface-2`, oklch(0.24 0.016 158)): hover surfaces,
  inputs, secondary buttons, progress-bar tracks.
- **Cold Seam** (`--border`, oklch(0.30 0.020 158)): hairline dividers and
  resting borders.
- **Frost White** (`--text`, oklch(0.94 0.008 158)): primary text, faint warm
  cast, never pure white.
- **Sea Mist** (`--text-muted`, oklch(0.70 0.012 158)): secondary text.
- **Drowned Grey** (`--text-subtle`, oklch(0.52 0.014 158)): placeholders,
  captions, resting glyphs.

### Destructive
- **Warning Coral** (`--danger`, oklch(0.62 0.180 25)): destructive action
  buttons only — same lightness and chroma as the emerald, opposite hue, so
  danger reads as the accent's mirror. `--danger-dim` (oklch(0.45 0.130 25))
  is its hover-down.

### Atmosphere
- **Frost** (`--frost`, 6% white) and **Frost Stronger** (`--frost-stronger`,
  10%): the inset top-edge highlight on every ice-block surface; stronger on
  hover.
- **Ink** (`--ink`, 55% near-black): the deep cool shadow under cards and
  panels.
- **Scrim** (`--scrim`, 72% tinted near-black): modal backdrops
  (`dialog::backdrop`).

### Named Rules
**The Locked Palette Rule.** The OKLCH values above never change without an
explicit palette discussion. Additions must derive from `--emerald` or a
neutral via color-mix; a second accent hue cannot exist.

**The No-Absolutes Rule.** Never `#000` or `#fff`. Never gradient text. Never
side-stripe colored borders.

**The Mirror-Danger Rule.** Destructive red is the emerald's exact mirror
(same L and C, hue 25) — danger looks like family, not like a foreign alert
system.

## Typography

**Display Font:** Space Grotesk (with system-ui fallback) — the free analogue
to NB Architekt; geometric, slightly condensed, holds up bold. Loaded from
Google Fonts today (weights 400-700, `display=swap`); self-hosting the woff2
is recorded debt to pay before any public or native ship.
**Body Font:** system stack (SF Pro Text / Inter) — read-speed and zero bundle.
**Mono Font:** system mono stack (SF Mono / JetBrains Mono / Menlo).

**Character:** condensed-tight display against wide-tracked uppercase chrome;
the contrast between the two is what makes the system read as one piece
across screens. Mono carries telemetry and ASCII texture.

### Hierarchy
- **Display** (700, 3rem / `--t-2xl`, 1.05, -0.02em): search hero prompt,
  splash empty states; modal titles step down to `--t-xl` (2.25rem). 2rem on
  viewports ≤520px.
- **Title** (600, 1.125rem / `--t-md`, 1.2, -0.01em): card titles, queue
  filenames' band; tab content headings at `--t-lg` (1.5rem).
- **Body** (400, 1rem / `--t-base`, 1.5): overviews, descriptions, anything
  read at length. Steps down to `--t-sm` (0.875rem) for secondary text and
  table cells.
- **Label** (500, 0.75rem / `--t-xs`, 0.14em tracking, uppercase, display
  face): eyebrow labels, buttons, tab pills, badges, toasts — the chrome
  voice.
- **Mono** (400, 0.875rem, 0.04em on HUD micro-type, `tnum` on): filenames,
  sizes (4.2 GB), ETAs, MB/s, `[ 47% ]` statuses — anything that benefits
  from numeric alignment.

Weight roles are tokenized: 400 `--w-body`, 500 `--w-ui`, 600 `--w-title`,
700 `--w-display`. Weight contrast carries hierarchy when scale alone
doesn't. The scale steps at a 1.25 ratio (`--t-xs` 0.75rem → `--t-2xl` 3rem)
— never flat.

### Named Rules
**The Two-Voices Rule.** Display speaks tight (-0.02em) at size; chrome
speaks wide (0.14em) in uppercase at `--t-xs`. Nothing speaks in between.

**The ASCII Texture Rule.** Mono glyphs are inline texture, always at
`--text-subtle` unless carrying meaning: `->` before action labels (never
the Unicode arrow), `--` between paired metadata (`Severance -- 2022 --
Apple TV`), `<<` `>>` as prev/next markers, `[ ]` around micro-status
(`[ DOWNLOADING ]`). Texture, never iconography — buttons stay buttons.

## Layout

Content is a centered column capped at 1040px (`--content-max`). Chrome
floats: three fixed clusters share one horizontal band at the viewport top
(inset `--pod-inset` 16px, 8px on ≤520px) — brand stack left, tab pills
center, Watch + user menu right — all at `z-index: var(--z-nav)`. The pill
for the tab you are on is removed from the band entirely (the page you are
already on is not a navigation action); a quiet mono "you are here" label
sits under the brand for wayfinding.

On the catalog tabs (TV, Movies) the search input lives in a fixed dock at
the viewport bottom, floating over the result grid on a soft top-fading
gradient so the kraken atmosphere bleeds through rather than being cut by a
hard chrome edge. Content beneath hero search starts at `--hero-pad-top`
(132px; 96px on ≤520px).

Spacing runs a 4pt scale from `--s-1` (4px) to `--s-9` (96px). Vary, do not
repeat: card-to-card gaps `--s-4`, inside cards `--s-3`, modal outer `--s-6`
with `--s-4` between fields, `--s-7` of breathing room between chrome and
page content. Result cards are poster-led and asymmetric — title and
metadata flow beside the poster, never stacked uniformly under it. Long
grids use `content-visibility: auto` with a matched `contain-intrinsic-size`
so off-screen cards skip paint with zero visual change.

Breakpoints observed: 520px (chrome tightens, type steps down) and 720px
(modals move from top-anchored to centered).

## Elevation & Depth

Depth is atmospheric, not material: no grey drop-shadow ladder. Surfaces are
ice blocks floating over dark water — each capped by an inset 1px frost
highlight on its top edge (`--frost`; `--frost-stronger` on hover) and
anchored by a deep cool shadow built from `--ink`. The canonical stack is
tokenized as `--elev-card`: 1px contact line, tight mid shadow, wide
ambient, frost inset.

Cards and queue rows add a jewel-case setting: a 4px near-black outer ring
(`0 0 0 4px oklch(0 0 0 / 0.45)`) separating the opaque slate panel from the
moving kraken behind it; on hover the ring warms to 35%-alpha emerald.

### Shadow Vocabulary
- **Card rest** (`inset 0 1px 0 var(--frost-stronger), 0 0 0 4px oklch(0 0 0 / 0.45), 0 14px 30px -22px var(--ink)`): media cards, queue rows.
- **Card hover** (ring becomes `0 0 0 4px oklch(62% 0.18 158 / 0.35)`, ambient deepens to `0 18px 36px -22px`): surface also steps to `--surface-2`. No scale transforms.
- **Chrome pill** (`inset 0 1px 0 var(--frost), 0 18px 40px -22px var(--ink)`): nav tab pills, toasts; hover adds an emerald bloom (`0 0 24px -8px` 45%-alpha emerald).
- **Modal** (`inset 0 1px 0 var(--frost), 0 30px 60px -28px var(--ink)`): add/confirm panels over the `--scrim` backdrop.

### Named Rules
**The Earned Glass Rule.** Backdrop-blur exists only because the kraken
moves behind the chrome — frost-on-glass over live video is the literal
metaphor. Reserved for floating chrome (nav pills, user menu, replay button,
alphabet rail, sticky toolbars, toasts, the search dock panel) and modal
scrims. Never a default card or content-surface treatment.

**The Motion Floor Rule.** One easing everywhere:
`cubic-bezier(0.16, 1, 0.3, 1)` (`--ease`). Durations 140/220/280ms
(`--dur-fast/mid/slow`). Animate opacity and transform only — never layout
properties. No bounce, no spring, no elastic. Dialogs and toasts enter and
exit via `@starting-style` + `allow-discrete` transitions, gated behind
`prefers-reduced-motion: no-preference`; reduced motion collapses all
durations to 0.01ms and keeps instant swaps. Two registered `@property`
tokens (`--focus-glow`, `--hud-sweep`) exist for compositor-safe tweens,
gated the same way.

## Shapes

Pill where it can pill, ice block where it can't. Chrome primitives — nav
pills, buttons, toggles, badges, toasts, progress bars — take the 500px
radius (`--r-pod`), Active Theory's signature. Content surfaces stay
rectangular with substantial rounding: cards and search panels at 14px
(`--r-lg`), modal panels at 18px (`--r-xl`), inputs, selects, and queue rows
at 12px (`--r-md`), small inline buttons and badges at 6px (`--r-sm`).

The recurring silhouette is the ice block: an opaque slate rectangle, frost
catching its top edge, dark water shadow beneath, set in a thin emerald
bezel. The In-Library badge deliberately breaks its poster's corner (offset
-8px past the edge) — a small interrupt that earns attention.

## Components

### Buttons
- **Shape:** full pill (500px radius); label voice (display face, `--t-xs`,
  500, 0.14em tracking, uppercase), `--s-3` × `--s-5` padding.
- **Primary:** Cut Emerald fill, Frost White text. A mono `->` trails the
  label (Active Theory's arrow); hover steps the fill down to Deep-Water
  Emerald and slides the arrow 2px right.
- **Cancel / Secondary:** Risen Slate fill, 1px Cold Seam border; hover
  fills to `--border`.
- **Destructive:** Warning Coral fill, confirm modals only.
- **Disabled:** 0.6 opacity, `not-allowed` cursor; busy state drops the
  arrow.

### Nav pills (tab chrome)
- Individual pills, one per *other* tab (the current tab's pill is hidden).
  78%-alpha Slate Depth fill with `backdrop-filter: blur(14px)
  saturate(140%)`, 1px Cold Seam border, frost inset, deep ink shadow.
- Hover: text and border go Cut Emerald, 1px lift, emerald bloom in the
  shadow. Focus-visible: 2px emerald outline, 2px offset. Min-height 44px
  (touch target).

### Mode toggle (chips)
- Pill container (80%-alpha surface, frost inset) holding two pill segments.
  Active segment fills Emerald Shadow; its mono `tnum` count chip colors the
  number Cut Emerald. Inactive segments are Sea Mist, warming to Frost White
  on hover.

### Cards (media card / ice block)
- Grid: 108px 3:4 poster (12px radius) beside flowing title + meta +
  overview. Opaque Slate Depth panel, 14px radius, 1px Cut Emerald border,
  the jewel-case shadow stack (see Elevation). Hover steps the surface up
  and warms the ring emerald; active nudges 1px down. No scale on hover.
- **In-Library badge:** pill breaking the poster's top-right corner by 8px;
  Deep-Water Emerald fill, uppercase 0.14em label with a glowing 5px dot,
  soft emerald shadow.

### Inputs / Fields
- **Search panel:** the input lives in a panel (14px radius, 88%-alpha
  surface, 6px blur, frost inset), not a bare text field. The field itself
  is chromeless display type at `--t-lg` 600; placeholder matches typed text
  exactly except color (Drowned Grey). Focus is carried by the panel:
  `:focus-within` turns the border Cut Emerald and adds a 4px 12%-alpha
  emerald halo; the input's own outline is suppressed.
- **Selects:** Risen Slate fill, 12px radius, 1px Cold Seam border, custom
  SVG caret; hover border Drowned Grey, focus border Cut Emerald.
- **Errors:** small Warning Coral text on a dim red tinted fill
  (oklch(0.30 0.080 25)), 12px radius.

### Modals
- Panels at 18px radius, `--s-6` padding, Slate Depth fill, frost inset +
  30px ink drop, over the `--scrim` backdrop. Eyebrow `[ ADD TO LIBRARY ]`
  in Cut Emerald label voice; display title; inline label-column fields.
  Enter/exit: 160ms translate-and-scale fade via `@starting-style`.
- Confirm modals: Cancel is default-focused; Enter does not submit; only
  ESC and Cancel close, only an explicit Confirm click executes.
  Destructive confirm buttons wear Warning Coral.
- Every modal takes a complete a11y contract via one of two sanctioned
  mechanisms: native `<dialog>` + `showModal()` (with `useDialogDismiss`) —
  AddMovieModal, AddSeriesModal, ConfirmModal, DetailModal — or
  `role="dialog"` + `useModalA11y` (trap + Escape + focus restore) —
  EpisodePicker, MediaPlayer, ConcurrencyLimitModal, ConnectionsWidget, the
  fullscreen IPTV player. No third pattern.

### Queue row (telemetry strip)
- Same jewel-case panel as cards (12px radius). Top line: mono filename `--`
  category chip (Emerald Shadow pill, Cut Emerald label) `--` mono `tnum`
  size. Below: full-width 4px progress track (Risen Slate) with Cut Emerald
  fill whose leading edge carries a 1px brighter inset highlight — reads as
  "live" without a glow halo (too noisy at 3s poll updates). Status in mono
  uppercase: `[ 47% ]`, `[ PAUSED ]`. Paused rows drop to 0.7 opacity and
  color their status emerald.

### Toast
- Bottom-center pill: 88%-alpha surface, 10px blur, label voice, frost
  inset + ink shadow. Slides up 8px on enter, animates out on dismiss.
  Copy register: "Severance — added to library." No exclamations.

### Signature: the atmosphere pair
- **EmeraldMark** — the brand mark is a live Three.js brilliant-cut gem
  (`src/lib/gemScene.ts`), a single centred stone rendered beside the
  wordmark in both navs and driving the animated favicon.
- **Kraken** — the page background is a full-screen video loop
  (`public/kraken.webm`/`.mp4` on Home; the calmer `resting` variant on
  inner tabs), no pointer-events, behind everything. The static SVG
  constellation (`Constellation.tsx`) stays in the tree unmounted as the
  fallback atmosphere.

## Do's and Don'ts

### Do:
- **Do** derive every new color via color-mix off `--emerald` or a neutral;
  the frontmatter values are locked.
- **Do** give every floating surface the frost top-edge inset — it is the
  system's fingerprint.
- **Do** use the mono ASCII glyph set (`->`, `--`, `<<`, `>>`, `[ ]`) at
  `--text-subtle` for texture, and the literal ASCII `->` (never `→`) on
  primary action labels.
- **Do** keep 44px minimum touch targets on chrome pills and gate all
  enter/exit motion behind `prefers-reduced-motion: no-preference`.
- **Do** give every modal its a11y contract through one of the two
  sanctioned mechanisms (see Modals).
- **Do** default Cancel, and never let Enter submit a destructive action.

### Don't:
- **Don't** use `#000`, `#fff`, gradient text, or side-stripe borders
  (`border-left: 4px solid` accent). Ever.
- **Don't** apply backdrop-blur to content surfaces — glass is earned only
  by floating chrome over the moving kraken and by modal scrims.
- **Don't** animate layout properties, add bounce/spring/elastic, or exceed
  the 140/220/280ms duration set.
- **Don't** standardize result cards into identical grids or stack titles
  uniformly under posters; cards stay poster-led and asymmetric.
- **Don't** nest cards: modal content sits directly on `--surface`.
- **Don't** reach for a modal first — a surface earns one only when the
  task is genuinely modal (committing an add, confirming a destructive
  action, focused detail/selection/playback).
- **Don't** use em dashes in UI copy (comma, semicolon, period, parens),
  and don't write "successfully!" toasts.
- **Don't** add WebGL beyond the two recorded exceptions below; no scroll
  scenes, no hero scenes. Hero-metric templates (big number, small label,
  sparkline) have no place here.
- **Don't** add new raw hex literals (see recorded debt below).

## References (extreme inspiration)

Two studios, both gating their work on advanced WebGL, both using the same
typographic family. We're stealing the chrome, not the chrome's
prerequisites.

- **igloo.inc** — atmospheric depth, frozen-cathedral palette, HUD chrome as
  navigation, constellation/network overlay as decorative subtext, ice-block
  geometry on cards.
- **activetheory.net** — pure-black cinema, pill chips at 500px radius,
  ASCII glyph punctuation (`->`, `--`, `<<`, `>>`), marquee project rolls,
  NB Architekt-style geometric display type, terminal-meets-cinema texture.

What we don't take: WebGL hero scenes, scroll-hijacking, brand wordmarks at
40vw. This is a tool used nightly, not a portfolio reel — the chrome carries
the reference; the function stays instant.

## Physical scene (forces theme)

> Owner sits on the couch at 9:42pm with their iPhone, living room dim, TV
> playing background music, dinner cleared. They want to find one specific
> show they thought of mid-conversation, add it, and put the phone down.
> *Or* — partner picks up the iPad in the kitchen mid-morning, sun through
> the window, wonders whether the new season of something has finished
> downloading.

Both ends of the day exist. Evening is the heavier traffic. Anything built
for the kitchen scene alone would be a low-value light-mode toggle that
bloats the surface.

## Recorded exceptions (owner-approved)

Deliberate, bounded departures; ceilings, not precedents.

- **WebGL emerald brand mark** (`src/lib/gemScene.ts` / `EmeraldMark`): the
  product's name promises a jewel and a static SVG read as clip-art.
  Originally a three-gem row, consolidated to a single centred gem in
  `36fc64c` (the row read as a noisy green stripe at mark sizes); the scene
  keeps a `gemCount` option but every placement renders the single variant.
  Scope: the mark and favicon only.
- **Kraken video atmosphere** (`Kraken.tsx`): the live background loop that
  supersedes the static constellation; it is also why backdrop-blur extends
  beyond a single nav pod (see The Earned Glass Rule).

## Recorded debt

- **Hex literals bypassing tokens:** ~97 occurrences across 12 CSS files at
  last count (`grep -rEo '#[0-9a-fA-F]{3,8}\b' src --include='*.css'`),
  chiefly `src/index.css` (~64), `auth/AppleSignInButton.css` (~7 — Apple's
  mandated branding, likely permanent), `player/IptvPlayer.css`,
  `auth/InvitesPanel.css`, `auth/DevicesPanel.css`, `tabs/UsersTab.css`.
  Tracked migration toward the token palette; permits no new hex.
- **Space Grotesk via Google Fonts:** self-host the woff2 before any public
  or native ship.

## What "done" looks like visually

A first-time visitor on a phone, opens the dashboard. The kraken drifts in
the dark behind everything. Floating emerald-flecked chrome hovers at the
top — the live gem turning beside `EMERALD EXCHANGE`, the tab pills, `WATCH
->` at the right. They tap into TV Shows; the search panel waits in a dock
at the bottom of the scene. They start typing — three poster cards land
quietly, ice-block silhouette, frost catching their top edges. One has a
pill `[ IN LIBRARY ]` badge breaking its corner. They tap it. A
confirmation panel lifts off the surface. The interaction took 14 seconds
and felt like the only natural thing to have happened.
