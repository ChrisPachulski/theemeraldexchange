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
the reference; the function stays instant.

## Physical scene (forces theme)

> Owner sits on the couch at 9:42pm with their iPhone, living room dim, TV playing background music, dinner cleared. They want to find one specific show they thought of mid-conversation, add it, and put the phone down. *Or* — partner picks up the iPad in the kitchen mid-morning, sun through the window, wonders whether the new season of something has finished downloading.

Both ends of the day exist. Evening is the heavier traffic. **Theme: dark default, no light theme in V1** — anything we'd build for the kitchen scene would be a low-value light-mode toggle that bloats the surface; a well-tinted dark UI is legible in both lights, and the evening case is where the design lives.

## Color strategy — locked

**Committed and locked.** The product's name commits us — *Emerald* in the URL is a promise. Restrained would betray it. Drenched would suffocate. **The palette never changes.**

One saturated emerald carries the accent — primary buttons, the "In Library" badge, the active tab indicator, the progress-bar fill, the focus ring. Everything else is a tinted neutral built from the same hue family.

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
proportions, slightly condensed feel, holds up bold. Loaded via the static
`/fonts/space-grotesk-*.woff2` files we self-host (no Google Fonts request,
no CLS, font-display:swap).

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
- **Search hero pad**: `s-9` above on first paint (declarative space)

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
  backdrop-blur (the ONE earned glassmorphism — this surface warrants it).
- **No card-grid monotony.** Search result cards: poster-led, asymmetric.
  Title and metadata flow alongside the poster, not stacked uniformly under
  it. The "In Library" badge breaks the card edge slightly — small visual
  interrupt that earns attention. Cards have an **ice-block silhouette**: top
  edge picks up a frost highlight, bottom drops a cool shadow.
- **Search-as-hero on TV/Movies tabs.** A large display-weight prompt
  ("What are you tracking?") sits above the input with generous space. The
  input itself is a panel (rounded `--r-lg`), not a hairline-bottomed text
  field.
- **No nested cards.** Modals sit on `--surface`; their content sits directly
  on it, not in nested boxes.
- **Atmospheric overlay**: a fixed-position decorative SVG renders a faint
  constellation/network of dots and lines at ~6% opacity, drifts via
  transform over 80s. Behind everything, no pointer-events. Adds depth
  without weight. Disabled at `prefers-reduced-motion`.

## Motion — atmospheric, still subtle

Slightly slower than V1 to feel cinematic, never theatrical.

- **Easing:** `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out-quint) for everything
- **Duration:** 180–280ms for state changes (hover, modal open, toast slide-in)
- **Constellation drift:** 80s linear translateX, infinite, alternates
- **No animation of layout properties.** Use opacity and transform only
- **No bounce, no spring, no elastic**

## Components — first-pass principles

- **HUD pod nav**: floating pill (`--r-pod`), `surface` with `backdrop-filter:
  blur(14px)` and a hairline `border` at low alpha. Brand wordmark left in
  display weight 700 with very tight tracking. Tab labels uppercase tracked
  wide. Active tab marker = an emerald **dot** below the label, animated on
  the X axis. Watch sits at the right with a 1px hairline divider before it,
  the gem glyph + "Watch" label, and a small `->` mono glyph trailing.
- **Search hero**: prompt + input. Prompt in display 700 at `--t-2xl`,
  generous letter-spacing-tight, `--text` color. Input below in a panel
  (rounded `--r-lg`), no bottom-border-only treatment. Empty input shows
  `letter-spacing: 0.04em` placeholder.
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
- **Glassmorphism by default.** Backdrop-blur is allowed on the HUD pod
  ONLY (it's the navigation that floats over content; frost-on-glass is the
  literal metaphor). Modals use a solid scrim, not blur.
- Hero-metric template (big number, small label, sparkline). Has no place here.
- Identical card grids. Search results vary by content; the chrome should not standardize them into sameness.
- Modal-as-first-thought. Add and Confirm are the only two modals. Everything else inlines or doesn't exist.
- Em dashes in copy. (Comma, semicolon, period, parens.)
- WebGL hero scenes. The constellation overlay is a static SVG with one
  transform animation. Three.js stays out.

## What "done" looks like visually

A first-time visitor on a phone, opens the dashboard. A floating emerald-
flecked HUD pod hovers at the top — `THE EMERALD EXCHANGE · TV · MOVIES ·
DOWNLOADS · WATCH ->`. The body asks `What are you tracking?` in big
display type. They start typing — three poster cards land quietly, ice-block
silhouette, frost catching their top edges. One has a pill `[ IN LIBRARY ]`
badge breaking its corner. They tap it. A confirmation panel lifts off the
surface. Behind everything, a constellation of pinpoints drifts at the speed
of moss. The interaction took 14 seconds and felt like the only natural
thing to have happened.
