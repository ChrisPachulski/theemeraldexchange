# The Emerald Exchange — Cutting-Edge UI Upgrade Spec

> Status: implementation-ready. Merges read-only recon of the implemented UI with 2025–2026 web-technique research.
> Code beats DESIGN.md when they disagree. Preserve, never strip, existing implementation choices.

## Through-line

We make The Emerald Exchange feel cutting-edge by upgrading the *mechanism* under the chrome — not by adding new visual language. The tool's contract is INSTANT nightly use, so every technique here is either (a) zero-cost CSS that replaces a hardcoded value with a token expression, (b) compositor-only motion (`transform`/`opacity`) that never blocks input, or (c) a native-API swap (View Transitions, `@starting-style`, `useOptimistic`) that deletes hand-rolled JS while making state changes read as intentional. The palette stays LOCKED — emerald (`oklch(0.62 0.180 158)`) remains the only saturated accent; every new shade is derived from it via `color-mix(in oklch, var(--emerald) …)` so nothing can escape hue 158. Motion is colorless by construction. The igloo.inc "ice-block / HUD pod" and activetheory "terminal-meets-cinema" registers get *sharper*, not louder: corner brackets, masked marquees, ASCII-glyph chips, and a single emerald scan-line — all additive ambient depth, never scroll-hijack, never a WebGL hero. The result is a 2026-grade build that an Awwwards judge reads as crafted and a tired admin reads as the same fast tool, only tighter.

---

## P0 — highest leverage, lowest brand risk (start here)

A bounded pass of ≤6 components can ship all of P0. Ordered for sequencing.

### P0.1 — Motion-token foundation + locked-accent derivation layer
- **Files:** `src/styles/tokens.css`, `src/styles/global.css`
- **Technique:** Animated `@property` registration + `color-mix(in oklch)` token derivation + `::selection`/`caret-color` accent.
- **Change sketch:**
  - In `tokens.css` add derived state tokens off the single locked accent (the codebase already uses this pattern in `DownloadsTab.css`/`UsersTab.css`):
    `--emerald-hover: color-mix(in oklch, var(--emerald) 88%, var(--bg));`
    `--emerald-ghost: color-mix(in oklch, var(--emerald) 12%, transparent);`
    `--hairline-emerald: color-mix(in oklch, var(--emerald) 18%, transparent);`
  - Add an `--elev-card` multi-layer shadow token (1px contact + tight mid + wide ambient + neutral inset frost top-edge) for ice-block depth.
  - Register two typed props for later items: `@property --focus-glow { syntax:'<number>'; initial-value:0; inherits:false }` and `@property --hud-sweep { syntax:'<angle>'; initial-value:0deg; inherits:false }`.
  - In `global.css` add `::selection { background: color-mix(in oklch, var(--emerald) 30%, transparent); color: var(--text); }` and `caret-color: var(--emerald)` on text inputs.
- **Effort:** S · **Brand risk:** none
- **Brand-safety:** Every new value is `color-mix` *off* `var(--emerald)`/neutrals — mathematically cannot leave hue 158 or introduce a second accent. Does not redefine any LOCKED token.

### P0.2 — Purge hardcoded hex; route through tokens
- **Files:** `src/components/search/MediaCard.css` (`#14181c`), `src/components/search/TrendingRow.css` (`#14181c` ×2, `rgba(64,224,160,…)` ×2), `src/components/queue/QueueRow.css` (`#14181c`)
- **Technique:** `color-mix(in oklch)` + token substitution (DESIGN.md hard rule: never `#000`/`#fff`/raw hex).
- **Change sketch:** Replace `#14181c` → `var(--surface)`. Replace `rgba(64, 224, 160, α)` → `oklch(0.62 0.180 158 / α)` (or `color-mix(in oklch, var(--emerald) …%, transparent)`) so the rings/pips scale with the token system. Leave `IptvPlayer.module.css` hex for P2 (higher brand risk).
- **Effort:** S · **Brand risk:** low
- **Brand-safety:** Pure substitution toward existing LOCKED tokens — strictly *increases* palette compliance; no visual register change.

### P0.3 — Same-document View Transitions for tab / filter / mode swaps
- **Files:** `src/App.tsx` (or the tab/router state owner), `src/components/tabs/TvTab.tsx`, `src/components/tabs/MediaTab.tsx`, `src/components/library/LibraryFilters.tsx`, plus one shared `src/styles/transitions.css`
- **Technique:** `document.startViewTransition()` (same-document, Baseline newly-available Oct 2025; Safari 18+/iOS 18+).
- **Change sketch:** Wrap tab/mode/filter `setState` in a tiny `withViewTransition(cb)` helper that feature-detects `document.startViewTransition` and falls back to a plain `cb()`. Give persistent shell (`.top-nav`, search dock) a stable `view-transition-name` so they stay pinned while content cross-fades. In `transitions.css`: `::view-transition-old(root), ::view-transition-new(root) { animation-duration: 180ms; animation-timing-function: var(--ease); }`. Gate behind `@media (prefers-reduced-motion: no-preference)` (the API does NOT auto-respect it) — under reduce, skip the call entirely so swaps are instant.
- **Effort:** M · **Brand risk:** low
- **Brand-safety:** Cross-fade animates only opacity of snapshots; introduces zero color. Older iOS hard-swaps (graceful no-op). Durations stay ≤200ms so the tool never feels delayed.

### P0.4 — `@starting-style` enter/exit on modals, toast, confirm
- **Files:** `src/components/detail/DetailModal.css`, `src/components/confirm/ConfirmModal.css`, `src/components/add/AddSeriesModal.css`, `src/components/toast/Toast.css`
- **Technique:** `@starting-style` + `transition-behavior: allow-discrete` (Chrome 121+, Safari 17.5+/iOS 17.5+ — the broadest-support technique here).
- **Change sketch:** On the open state add `transition: opacity 160ms var(--ease), transform 160ms var(--ease), overlay 160ms allow-discrete, display 160ms allow-discrete;` and `@starting-style { opacity: 0; transform: translateY(8px); }`. Add the matching closed rule so toasts/modals now animate *out* too (recon flagged abrupt exits everywhere). Backdrop stays the locked `--scrim`; surface stays `--surface`/`--surface-2`. Reduced-motion: the existing token collapse already zeroes durations.
- **Effort:** M · **Brand risk:** none
- **Brand-safety:** Motion is opacity+translateY only; uses existing `--ease` and locked scrim/surface tokens. Deletes React "wait-then-unmount" hacks rather than adding chrome.

### P0.5 — React 19 `useOptimistic` on high-frequency writes
- **Files:** `src/components/queue/QueueRow.tsx`, `src/components/search/MediaCard.tsx`, `src/components/search/FeedbackDots.css` (pending style), a new `src/lib/useOptimisticMutation.ts`
- **Technique:** React 19 `useOptimistic` + `useActionState` pending flag (stack is already React 19).
- **Change sketch:** Wrap mark-watched / add-to-queue / feedback-dot / favorite mutations so the row updates the instant the user taps; style the pending row at `--text-subtle` (vs `--text`) and let React auto-revert on failure. Use the `useActionState` pending flag to disable double-submits.
- **Effort:** M · **Brand risk:** none
- **Brand-safety:** No visual language added beyond a token opacity shift between `--text` and `--text-subtle`. This is the single biggest "feels instant" lever for a nightly tool.

### P0.6 — `content-visibility` + `contain` on long lists
- **Files:** `src/components/search/MediaCard.css`, `src/components/search/ResultGrid.tsx` (row wrapper), `src/components/library/*` row/card CSS
- **Technique:** `content-visibility: auto` + `contain-intrinsic-size` + `contain: content` (Baseline newly-available Sept 2025; Safari 18+/iOS 18+, Chrome 85+).
- **Change sketch:** On each card/row wrapper: `content-visibility: auto; contain-intrinsic-size: <known card w> 220px; contain: content;`. Purely a rendering hint — zero visual change to the ice-block geometry. Do NOT apply to text users search within in-page (poster cards are fine).
- **Effort:** S · **Brand risk:** none
- **Brand-safety:** No paint/color change whatsoever — it only lets the browser skip off-screen paint, making iPad scroll instant.

---

## P1 — strong polish, slightly more surface (after P0)

Count: **9**

1. **Tab/mode/filter shared-element card morph** — `MediaCard.css`, `ResultGrid.tsx`, `DetailModal.tsx`: `view-transition-name: media-card-${id}` on tapped card morphing into the detail header; `view-transition-class` + a single `::view-transition-group` rule for grid re-sorts. Enhancement on top of P0.3. *Safari `match-element` is newer — fall back to plain cross-fade.* (M, low)
2. **Neutral-at-rest card borders + layered elevation** — `MediaCard.css`, `TrendingRow.css`: swap always-on emerald border for `--border` at rest, flip to `--emerald` only on `:hover`/`:focus-visible`; replace 4px glow halo with the `--elev-card` token + `--frost-stronger` on hover. Restores DESIGN.md "emerald scarce" rule. (M, low)
3. **Scroll-driven entrance reveals on the browse grid** — `MediaCard.css`: `animation-timeline: view()` with `animation-range: entry 0% cover 25%`, opacity 0.7→1 + 8px translateY, wrapped in `@supports (animation-timeline: view())` and `prefers-reduced-motion: no-preference`. Browse grid ONLY — never search input or tab bar. *Progressive enhancement: iOS <26 / older Chromium see static cards.* (M, low)
4. **Compositor focus pulse on search input** — `SearchInput.css`: remove the `backdrop-filter: blur(6px)` (glassmorphism only belongs on HUD pods); rely on solid `var(--surface)`. Replace diffuse halo with tight `outline: 2px solid var(--emerald); outline-offset: 2px;` and animate the registered `--focus-glow` number for a 150ms emerald box-shadow spread on `:focus-visible`. (M, low)
5. **HUD pods: corner-bracket frame + `@property` conic sweep** — `src/components/nav/TopNav.css`, new `src/components/hud/HudFrame.css`: masked pseudo-element drawing only L-shaped corner brackets at `--border`; active pod gets a slow ~12s `--hud-sweep` conic emerald arc. Reproduces igloo "targeting reticle" with no continuous colored border. (M, low)
6. **Sticky-nav stuck state** — `TopNav.css`: `@container scroll-state(stuck: top)` adds a 1px `--border` hairline + tinted blur once the HUD detaches. *Chrome 133+ only — pure progressive enhancement; both stuck/un-stuck states must be acceptable on iOS where it never fires.* (S, none)
7. **Mask-faded marquee status strip** — new `src/components/hud/Marquee.tsx`: duplicate track, single transform keyframe, `-webkit-mask-image` edge fade, mono `--text-subtle` text with `->` separators for continue-watching / recently-added. Frozen under reduced-motion. (M, low)
8. **ASCII-glyph pill chips** — `src/components/library/LibraryFilters.css`, `ModeToggle.css`, `AiToggle.css`: `border-radius: 500px` (already locked) chips carrying leading mono glyphs (`-> Movies`, `sort <<`); selected = 1px emerald inset outline (not filled pill) to keep emerald scarce. Add `:focus-visible { outline: 2px solid var(--emerald); outline-offset: 2px; }` everywhere recon flagged it missing. (S, low)
9. **Content-aware skeletons + intent prefetch** — `MediaCard`/`ResultGrid`/`TrendingRow`: skeleton geometry that mirrors the real ice-block card, slow opacity pulse (NOT a moving gradient sweep — reads as noise on dark HUD) tinted strictly `--surface`→`--surface-2`; `onPointerEnter` (under `pointer:fine`) data prefetch so the skeleton often never appears. (M, low)

---

## P2 — deeper / higher-touch work (later)

Count: **7**

1. **IptvPlayer palette compliance** — `src/components/player/IptvPlayer.tsx`, `IptvPlayer.module.css`: replace `#000/#171717/#f5f5f5/#ffb4ab` with `--bg/--surface/--text/--danger`; style native `select`s as emerald pill buttons; full-width emerald accent line under video. **Brand risk: high** — restyling a working player; verify playback E2E before/after. (L, high)
2. **`linear()` spring settle on dock/press-release** — `tokens.css` + nav pod CSS: `--spring-settle` inside `@supports (animation-timing-function: linear(0,1))` with cubic-bezier fallback; one tactile beat on HUD pod dock only, never on fast-toggled controls (reversing-shortening-factor artifact). (M, none)
3. **Pointer-adaptive magnetic hover** — `MediaCard`/`TopNav` CSS: gate lift/cursor-follow behind `@media (hover:hover) and (pointer:fine)`; coarse-pointer gets press-based `:active { transform: scale(0.97); filter: brightness(1.06); }`. Prevents stuck `:hover` on iOS. (M, none)
4. **OffscreenCanvas constellation field + battery gating** — `src/components/atmosphere/Constellation.tsx` (or new `AtmosphereField`): 40–80 node emerald/border field via `transferControlToOffscreen`; rAF gated on IntersectionObserver + visibilitychange, `pixelRatio ≤ 2`, 30fps ambient cap, static frame under reduced-motion. Loosely phase-lock Beacon/gem/constellation to one master timer. (L, low)
5. **Scroll-progress HUD scan-line on long detail pages** — `DetailModal.css`/detail view: 2px `--emerald` low-alpha line driven by `animation-timeline: scroll(root block)`, `scaleX 0→1`. *Safari 18+/iOS 18+; decorative no-op below.* (S, low)
6. **`text-wrap: balance`/`pretty` typographic rag** — display titles get `balance`; synopsis/empty-state copy get `pretty`. *`pretty` is enhancement-only (iOS 26+); `balance` safe on iOS 17.5+.* (S, none)
7. **Static `feTurbulence` grain overlay** — new `src/components/atmosphere/GrainOverlay`: build-time-baked data-URI fractalNoise, `position:fixed`, opacity ~3–5%, `mix-blend-mode: soft-light`, `pointer-events:none`. Kills OKLCH banding on OLED. **Must stay static** (never animate — battery). Gate behind a perf flag. (M, low)

---

## Guardrails (restate before any implementation)

**Locked palette — never edit, never add a second accent:**
- `--bg oklch(0.16 0.012 158)`, `--surface 0.20`, `--surface-2 0.24`, `--border 0.30`, `--text 0.94`. `--emerald oklch(0.62 0.180 158)` is the ONLY saturated accent. `--danger` = same L/C, hue 25.
- Never `#000`/`#fff`/raw hex. Never gradient text. Never side-stripe colored borders. Dark default ONLY — no light theme.
- All new shades derive via `color-mix(in oklch, var(--emerald) …)` / neutrals → cannot escape hue 158.

**Motion discipline:**
- Animate only `transform` and `opacity` (compositor-safe). `will-change` only during interaction, never standing/global.
- Use the locked `--ease cubic-bezier(0.16, 1, 0.3, 1)`; durations stay 120–240ms. No bounce/spring on click-to-open (spring reserved for future drag affordances). No scroll-hijack, no WebGL hero, no brand wordmark at 40vw.
- WebGL stays scoped to the existing 3-emerald brand mark only.

**`prefers-reduced-motion`:** The token collapse already zeroes `--dur-*`. View Transitions do NOT auto-respect it — gate `startViewTransition` and any `::view-transition-*` animation behind `@media (prefers-reduced-motion: no-preference)` and skip the call under reduce. Scroll-driven and grain effects must short-circuit to a static end-state.

**iOS Safari support (primary target = iPhone/iPad):**
- *Safe now:* `@starting-style`/`allow-discrete` (17.5+), same-document View Transitions (18+), `color-mix`/`@property`/`::selection` (16.4+), `content-visibility`/`contain` (18+), OffscreenCanvas (16.4+), `text-wrap: balance` (17.5+).
- *Progressive enhancement — design the fallback to be acceptable:* `animation-timeline: view()/scroll()` (iOS 26+), `view-transition-name: match-element` (Safari 18.4+), `@container scroll-state(stuck)` (Chrome 133+ ONLY, never on iOS), `text-wrap: pretty` (iOS 26+), Speculation Rules (Chromium only).
- Dual-declare `-webkit-backdrop-filter`/`-webkit-mask-image`. Cap concurrent `backdrop-filter` glass layers to a handful (modals/palette/sticky nav) — never on scrolling grid tiles.

**Sequencing for a ≤6-component bounded pass:** Start P0.1 → P0.2 (token + hex hygiene, no behavior change) → P0.6 (perf, invisible) → P0.4 (modal enter/exit) → P0.3 (view transitions) → P0.5 (optimistic). Each is independently shippable and verifiable; re-run the real build/typecheck from scratch before declaring done — never trust a green self-report.
