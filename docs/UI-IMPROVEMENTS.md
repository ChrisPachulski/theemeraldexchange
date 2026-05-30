# UI Improvements

Owner-facing UI audit and remediation plan. Findings span five dimensions — auth/sign-in, visual consistency, accessibility, responsive/mobile, and IA/navigation/feedback. The sign-in screen is the acute issue and gets a dedicated redesign section below.

> Note on the sign-in container: `.walkthrough__signin-buttons` (`src/components/walkthrough/Walkthrough.css:421-431`) has already been converted from the old `flex-wrap` row to a full-width vertical column stack (`flex-direction: column; gap: var(--s-3); align-items: stretch`). The remaining sign-in problem is therefore **hierarchy and disclosure**, not row-vs-column layout. Most other layout-conflict findings are resolved; what's left is the flat peer ordering of methods, the always-visible invite field, the duplicate render, and the off-token passkey sub-tree.

---

## 1. Bottom line — the 3 changes that most reduce the "clunky" feeling

In order of impact:

1. **Redesign the sign-in screen around one primary action + progressive disclosure** (Section 2). Today the block at `src/components/walkthrough/Walkthrough.tsx:39-95` shows an invite field, three co-equal sign-in buttons, a passkey-setup link, and a 3-sentence hint all at once, then renders the **entire block twice** on the same page (`Walkthrough.tsx:311` hero + `:340` foot). It reads as a settings panel, not a front door. This is the screen the owner flagged.

2. **Re-token the drift offenders and add a CI guard so it can't recur.** `PasskeyButtons.css` abandons the token system wholesale (raw `rgba`, `0.5rem` literals, a fabricated `--emerald-300` that falls back to a non-brand Tailwind green at `:11`), and **14 CSS custom properties are referenced but never defined** in `tokens.css`, each silently resolving to a hand-typed literal. Replace `#14181c` → `var(--surface)` across 8 files, rewrite `PasskeyButtons.css` against tokens, add the missing aliases to `:root`, and add a stylelint/grep guard that fails the build on any undeclared `var(--x)`. This is the mechanism behind the "ad-hoc values crept back in" feeling.

3. **Bring the IPTV surface up to the rest of the app's interaction bar.** IPTV playback grant failures are **silently swallowed** (`void playChannel(c)` discards the rejected promise — `LiveTab.tsx:124`, `VodTab.tsx:107`, `IptvSeriesTab.tsx:211`), the IPTV tabs have **no empty state** and bare lowercase `Loading…` / generic-red error text with no retry, M3U export pops a native `alert()` (`LiveTab.tsx:210-213`), and there is **no React error boundary anywhere** so a stale lazy-chunk after a redeploy white-screens the whole SPA (`App.tsx:84`). The Sonarr/Radarr tabs already prove the correct loading/error/empty pattern; extract and apply it.

---

## 2. Sign-in screen redesign (the acute issue)

### What's wrong now

`SignInBlock` (`Walkthrough.tsx:31-96`) declares no primary action. Reading top to bottom:

- **Invite field first**, always visible, even though its own label says `(first time only)` (`:43`) and the hint says returning members need "no code" (`:70-72`). The common case — a returning household member — must mentally skip the very first control every visit.
- **Three near-equal-weight buttons**: Plex and passkey literally share `.walkthrough__signin-button` (the filled emerald pill, `Walkthrough.css:433`), and Apple is built to match the same geometry. Nothing tells the eye where to click.
- **A fourth control style**: the passkey-setup toggle is an underlined emerald text-link (`PasskeyButtons.css:8-17`) — a distinct fourth treatment.
- **A 3-sentence hint paragraph** (`:69-74`) restating who-uses-what, which good structure would make self-evident.
- The whole thing **renders twice** (hero + foot).

### Design principle

For an invite-only household library, the **returning member is the overwhelmingly common case**, and the cross-platform passkey is their best path (Face ID / Touch ID / Windows Hello, no Plex account dependency). So: **one dominant "Sign in" button, everything else demoted or disclosed.**

### Proposed hierarchy

**Default (returning-member) state — what 95% of visits see:**

1. **Primary, full-width emerald pill — "Sign in"** → triggers `passkeyLogin()`. The existing `.walkthrough__signin-button` filled-emerald look. This is the single dominant target.
2. **"More ways to sign in"** — a lightweight `<details>`/`<summary>` (or `useState` toggle) that, when opened, reveals **Plex** and **Apple** as *secondary* affordances styled as ghost/outline buttons (transparent background, `1px solid var(--border)`, `color: var(--text)`) — NOT the filled emerald pill. Capability preserved, visual co-equality removed.
3. **"First time here? Enter your invite code"** — a single text affordance. Opening it reveals the invite input **and** the first-time options (Set up a passkey / Continue with Plex / Continue with Apple), all sharing the one invite input. Since passkey-register, first-time-Plex, and first-time-Apple all consume the same invite code, they belong behind one disclosure, not three separate entry points.
4. **One short line** under the primary button: *"Invitation-only — members only."* The returning-vs-first-time guidance moves into structure, not prose.

**Foot instance:** do NOT render a second full copy. Render a single primary "Sign in" CTA that scrolls to / focuses the hero block. Halves the cognitive surface and reinforces one canonical sign-in location.

### ASCII sketch

```
DEFAULT (returning member — the happy path)
┌──────────────────────────────────────────────┐
│   The Emerald Exchange                        │  ← eyebrow
│   A private members' page for a               │  ← h1
│   household media library.                    │
│                                               │
│   ┌────────────────────────────────────────┐ │
│   │              Sign in                    │ │  ← PRIMARY, full-width
│   └────────────────────────────────────────┘ │     emerald pill → passkeyLogin()
│                                               │
│   ▸ More ways to sign in                      │  ← disclosure (collapsed)
│   ▸ First time here? Enter your invite code   │  ← disclosure (collapsed)
│                                               │
│   Invitation-only — members only.             │  ← one short line
└──────────────────────────────────────────────┘

"MORE WAYS TO SIGN IN" EXPANDED
│   ▾ More ways to sign in                      │
│   ┌────────────────────────────────────────┐ │
│   │  Continue with Plex                     │ │  ← SECONDARY: ghost/outline
│   └────────────────────────────────────────┘ │     (1px solid var(--border))
│   ┌────────────────────────────────────────┐ │
│   │   Continue with Apple                  │ │  ← Apple's required geometry
│   └────────────────────────────────────────┘ │
│   ▸ First time here? Enter your invite code   │

"FIRST TIME" EXPANDED
│   ▾ First time here? Enter your invite code   │
│   Invite code                                 │
│   ┌────────────────────────────────────────┐ │
│   │ Paste the code the owner sent you       │ │  ← invite input (one place)
│   └────────────────────────────────────────┘ │
│   Then choose how to sign in:                 │
│   [ Set up a passkey ] [ Plex ] [ Apple ]     │  ← equal-weight first-time
│                                                     options, share the code above
```

### Supporting cleanups inside the redesign

- **Standardize pending copy.** Plex shows `Waiting for Plex…`, Apple `Signing in…`, passkey `Waiting…`, register `Creating…` (`Walkthrough.tsx:64`, `AppleSignInButton.tsx:79`, `PasskeyButtons.tsx:43/:78`). Use one busy label and animate only the invoked button; render the others as plain dimmed `:disabled` (the `opacity:0.65` rule already exists).
- **Fix the duplicate static `id`.** `PasskeyButtons.tsx:61` hard-codes `id="passkey-handle"`; when both placements expand there are two of them (invalid HTML, breaks `label[for]`). Use `useId()`.
- **Re-token the passkey sub-tree** so the register card matches the Plex/Apple pills sitting inches away (see Section 3 visual-consistency items).

---

## 3. Prioritized issue table

| Issue | Dimension | Severity | Effort | Fix |
|---|---|---|---|---|
| Sign-in has no primary action; 3 co-equal buttons + invite field + setup link + hint | auth-signin | High | Medium | One primary "Sign in" (passkey) pill; demote Plex/Apple to ghost under "More ways"; gate invite behind "First time?" disclosure. `Walkthrough.tsx:57-67`, `Walkthrough.css:433` |
| Invite field rendered first, always, despite "(first time only)" | auth-signin | High | Medium | Gate behind first-time disclosure; default to returning-member mode. `Walkthrough.tsx:41-56` |
| Entire SignInBlock rendered twice on one page | auth-signin | Medium | Small | Hero keeps full block; foot becomes a single CTA that focuses the hero. `Walkthrough.tsx:311,340` |
| `PasskeyButtons.css` abandons tokens (raw rgba, rem literals, fake `--emerald-300`) | visual-consistency | High | Small | Rewrite against tokens mirroring `InvitesPanel.css`; `--emerald-300`→`var(--emerald)`. `PasskeyButtons.css:11,29,31` |
| 14 `var(--x)` names referenced but never defined in `tokens.css` | visual-consistency | High | Medium | Add aliases to `:root` for real gaps; rename typos; add CI guard rejecting undeclared tokens. |
| Two competing card surfaces: `--surface` vs hardcoded `#14181c` (8 files) | visual-consistency | High | Small | Find-replace `#14181c`→`var(--surface)`, `#1c2127`→`var(--surface-2)`. `MediaCard.css:11`, `TrendingRow.css:111` |
| IPTV player modal is hand-rolled `role="dialog"` div: no focus trap, no Escape, no focus restore | accessibility | High | Medium | Convert to native `<dialog>`+`showModal()` like `DetailModal.tsx:128-142`. `VodTab.tsx:169`, `LiveTab.tsx`, `IptvSeriesTab.tsx` |
| `outline:none` on sign-in video stage + invite input kills keyboard focus ring | accessibility | High | Quick-win | Remove `outline:none`; let global ring apply or set `2px solid var(--emerald)`. `Walkthrough.css:231-235,410-413` |
| IPTV playback grant failures silently swallowed (`void playChannel`) | ia-nav-feedback | High | Small | Add toast + `.catch(...)` to play handlers. `LiveTab.tsx:124`, `VodTab.tsx:107`, `IptvSeriesTab.tsx:211` |
| IPTV tabs have no empty state | ia-nav-feedback | High | Small | Add `count===0` branch reusing `.tv-tab__empty` (EmeraldMark + message). `LiveTab.tsx:111-170` |
| No React error boundary; stale lazy-chunk white-screens whole SPA | ia-nav-feedback | High | Medium | Add class ErrorBoundary (logs Glitchtip, branded reload card) wrapping Suspense. `App.tsx:84` |
| No safe-area-inset handling; `viewport-fit=cover` missing | responsive-mobile | High | Small | Add `viewport-fit=cover`; pad fixed chrome with `env(safe-area-inset-*)`. `index.html:6`, `HomeTab.css:217`, `TvTab.css:60` |
| Modals use raw `100vh` → bottom action bar hidden under iOS URL bar | responsive-mobile | High | Small | Switch to `100dvh` with `100vh` fallback. `DetailModal.css:8-9,693-695`, `AddSeriesModal.css:4-5` |
| IPTV bottom toolbar (search+select+export) no wrap, no mobile breakpoint | responsive-mobile | High | Small | `flex-wrap:wrap`; search `flex:1 1 100%`; `min-width:0` on select. `index.css:133-142` |
| Tap targets below 44px; `.top-nav__tab` shrinks to 38/40px on phones | responsive-mobile | High | Medium | Add `min-height:44px` to shared pill/button classes; introduce `--tap-min:44px`. `TopNav.css:202,215` |
| Primary tablist hides active tab → no `aria-selected`, no `aria-controls` | ia-nav-feedback | Medium | Small | Switch to `<nav>` + `aria-current="page"` (matches the hide-active design). `TopNav.tsx:71,100-124` |
| Native `alert()` for M3U export | ia-nav-feedback | Medium | Quick-win | Route through existing Toast. `LiveTab.tsx:210-213` |
| IPTV loading/error off-brand (bare text, no retry) | ia-nav-feedback | Medium | Small | Use `LoadingPulse` + error card with `refetch()`. `LiveTab.tsx:108-109` |
| Duplicate static `id="passkey-handle"` (block renders twice) | accessibility | Medium | Quick-win | `useId()`. `PasskeyButtons.tsx:57,61` |
| Add modals missing `aria-labelledby` | accessibility | Medium | Quick-win | Wire `<h2 id>` to `<dialog aria-labelledby>` like DetailModal. `AddMovieModal.tsx:122-143` |
| IPTV search inputs/selects placeholder-only, no accessible name | accessibility | Medium | Quick-win | Add `type="search"`+`aria-label`. `VodTab.tsx:146`, `LiveTab.tsx:187` |
| Text-subtle (3.54:1) + Add-modal primary label on solid emerald (2.72:1) below AA | accessibility | Medium | Small | Bump info text to `--text-muted`; switch Add primary to `--emerald-bg` scheme. `AddSeriesModal.css:233-236` |
| Passkey setup is a 3rd disclosure level with duplicate hint copy | auth-signin | Medium | Medium | Fold into the single "First time" disclosure. `PasskeyButtons.tsx:46-94` |
| iOS zoom-on-focus: invite + IPTV fields <16px | responsive-mobile | Medium | Quick-win | `@media(max-width:720px){input,select,textarea{font-size:16px}}`. `Walkthrough.css:397` |
| Hover-only TrendingRow dismiss/reason unreachable on touch | responsive-mobile | Medium | Small | Wrap hover-hide in `@media(hover:hover)`; show at reduced opacity on coarse pointers. `TrendingRow.css:118,213` |
| TrendingRow off-brand greens/blue, live on sign-in screen | visual-consistency | Medium | Small | Map liked→`var(--emerald)`, drop sky-blue. `TrendingRow.css:234,260,263` |
| Hardcoded transition durations bypass motion tokens + reduced-motion | visual-consistency | Medium | Small | Replace `120ms`/`180ms` with `var(--dur-fast/mid) var(--ease)`. `DevicesPanel.css:118`, `InvitesPanel.css:224` |
| `--s-lg`/`--s-xs` undefined → brand-mark margin silently collapses on hero | visual-consistency | Medium | Quick-win | Use real scale: `margin:0 0 var(--s-5) calc(-1*var(--s-1))`. `Walkthrough.css:173` |
| IPTV sub-nav + Media kind toggle are local state, not URL (not deep-linkable) | ia-nav-feedback | Medium | Medium | Promote IPTV sub-tab to a hash segment. `IptvTab.tsx:16`, `MediaTab.tsx:31-33` |
| Add-modal info span: `tabIndex=0` no role, CSS-only tooltip | accessibility | Low | Small | Add role / convert to `<button>` with `aria-describedby`. `AddMovieModal.tsx:133-140` |
| DetailModal close `:focus-visible` square ring on round button | accessibility | Low | Quick-win | Add `:focus-visible{...border-radius:50%}`. `DetailModal.css:59-82` |
| 3-sentence sign-in hint restates the controls | auth-signin | Medium | Quick-win | Cut to one line; move guidance into structure. `Walkthrough.tsx:69-74` |
| `border-radius:999px` in 27 selectors vs token `--r-pod` | visual-consistency | Low | Quick-win | Replace all with `var(--r-pod)`. `HomeTab.css:197`, `AiToggle.css:10` |
| Redundant literal fallbacks on existing tokens (3 greens, 2 reds) | visual-consistency | Low | Quick-win | Drop fallbacks: bare `var(--danger)`/`var(--emerald)`/`var(--text)`. `DevicesPanel.css:135` |
| Toast single-slot, no severity, no Undo; errors announced politely | ia-nav-feedback | Low | Medium | Add `variant` (assertive for error) + optional `action` for Undo. `Toast.tsx:10-23` |
| Inconsistent labels: "Downloads"/"Downloader", "Movies" means 2 things | ia-nav-feedback | Low | Quick-win | Centralize on `ROUTE_LABEL`; disambiguate IPTV "Movies"/"Series". `HomeTab.tsx:12`, `IptvTab.tsx:10-13` |
| Pending copy inconsistent across sign-in buttons | auth-signin | Low | Small | One busy label; animate only the invoked button. `Walkthrough.tsx:64`, `AppleSignInButton.tsx:79` |
| `src/index.css` IPTV block is a pre-token global stylesheet (glass, cold greys) | visual-consistency | Medium | Large | Migrate to tokens; extract into co-located `iptv/*.css`. `index.css:17/39/66/189` |
| No shared Button primitive; PasskeyButtons borrows Walkthrough classes | visual-consistency | Medium | Large | Extract `.btn`/`<Button>` system (primary/provider/ghost/danger). `PasskeyButtons.tsx:39,62` |
| IPTV player track selectors tiny, dark-on-dark, sub-44px | responsive-mobile | Low | Quick-win | `min-height:44px`, `font-size:16px`. `IptvPlayer.module.css:21-34` |
| IPTV sub-nav row crowds on phones (no wrap) | responsive-mobile | Low | Quick-win | `flex-wrap:wrap`; drop ConnectionsWidget to own line ≤520px. `index.css:12-15,38` |
| HomeTab bottom pills shrink below tap size with 4 admin entries | responsive-mobile | Low | Quick-win | Force 2-col grid ≤480px; `min-height:44px`. `HomeTab.css:291-303` |
| DownloadsTab has no all-clear idle empty state | ia-nav-feedback | Low | Small | Add idle empty state with CTA to TV/Movies tab. `DownloadsTab.tsx:125-131,410` |

---

## 4. Quick wins (small effort, high impact — knock these out first)

These are mechanical or near-mechanical and each removes a visible defect. **16 quick-wins:**

1. **Remove `outline:none` on the sign-in video stage + invite input** — restores the keyboard focus ring on the flagged screen. `Walkthrough.css:231-235,410-413`.
2. **Native `alert()` → Toast** for M3U export. `LiveTab.tsx:210-213`.
3. **`useId()` for the passkey input id** — kills the duplicate-`id` invalid-HTML bug. `PasskeyButtons.tsx:57,61`.
4. **Add `aria-labelledby` to the Add modals** — wire `<h2 id>` to `<dialog>`. `AddMovieModal.tsx:122-143`, `AddSeriesModal.tsx:199,219`.
5. **`aria-label` + `type="search"` on the 3 IPTV search inputs and their category selects.** `VodTab.tsx:146`, `LiveTab.tsx:187`, `IptvSeriesTab.tsx:159`.
6. **Global `@media(max-width:720px){input,select,textarea{font-size:16px}}`** — kills iOS zoom-on-focus everywhere.
7. **Cut the 3-sentence sign-in hint to one line.** `Walkthrough.tsx:69-74`.
8. **Fix the hero brand-mark margin** — `--s-lg`/`--s-xs` don't exist; use `var(--s-5)`/`var(--s-1)`. `Walkthrough.css:173`.
9. **`border-radius:999px` → `var(--r-pod)`** across the 27 selectors. One canonical pill radius.
10. **Drop literal fallbacks on guaranteed tokens** (`var(--danger,#d04949)` → `var(--danger)`, etc.) — removes the three-greens/two-reds hazard.
11. **Centralize nav labels** on `ROUTE_LABEL`; disambiguate IPTV "Movies"/"Series". `HomeTab.tsx:8-14`, `IptvTab.tsx:10-13`.
12. **DetailModal close `:focus-visible` round ring.** `DetailModal.css:59-82`.
13. **IPTV sub-nav `flex-wrap:wrap`**; drop ConnectionsWidget to its own line ≤520px. `index.css:12-15,38`.
14. **HomeTab bottom pills → 2-col grid ≤480px + `min-height:44px`.** `HomeTab.css:291-303`.
15. **IPTV track selectors `min-height:44px; font-size:16px`** (also fixes iOS zoom). `IptvPlayer.module.css:21-34`.
16. **`--emerald-300` → `var(--emerald)`** in the passkey toggle (the smallest slice of the larger re-token). `PasskeyButtons.css:11`.

---

## 5. Larger redesigns (need an owner design decision)

These change a shared pattern or introduce a new system; do not start before a decision.

1. **Sign-in screen redesign (Section 2).** The owner decision: confirm **passkey-as-primary** for returning members (vs Plex-as-primary), and confirm the two-disclosure structure ("More ways" + "First time?"). Everything downstream — which method is the filled pill, what collapses, the foot becoming a single CTA — follows from that one call. High severity, but it's a design choice, not a mechanical fix.

2. **Extract a shared Button primitive / design-system component layer.** Today the sign-in control group is half-styled by `Walkthrough.css` and half by `PasskeyButtons.css` via borrowed class names (`PasskeyButtons.tsx:39,62`); there is **no `<Button>` or `.btn` primitive anywhere**. A `.btn` base + `--primary`/`--provider`/`--ghost`/`--danger` variants (token-driven) would unify the sign-in group and the Invites/Devices buttons and kill the cross-component class borrowing. Decision needed: component (`<Button>`) vs CSS-only (`components.css`), and the variant taxonomy.

3. **Migrate the `src/index.css` IPTV block off the pre-token global stylesheet.** 84 of 214 lines are pre-token IPTV styling — `rgba(255,255,255,...)` frosted glass, `#101010/#181818` cold-grey surfaces, white text, a blue `#79d7ff` focus ring (`index.css:189`) that contradicts the global emerald `:focus-visible` and the "solid scrim, only the HUD pod blurs" rule in `global.css:133`. The right move is to extract it into co-located `src/components/iptv/*.css` and delete it from the global import, but that touches the player/detail surfaces and the earned-glassmorphism design rule — needs an owner call on the glass treatment for the media-playback paths.

4. **Toast severity + Undo model.** Adding `variant: 'success'|'error'|'info'` (driving color + `aria-live` assertive-for-error) and an optional `action` ({label,onClick}) so "removed from library" can offer Undo (`Toast.tsx:10-23`). Decision: do we want Undo semantics app-wide (re-add via the same mutation), or just the accessibility fix (assertive errors)?

5. **URL-addressable sub-navigation.** Promoting the IPTV sub-tab (Channels/Movies/Series) and the Media kind toggle from local `useState` into the hash route (`IptvTab.tsx:16`, `MediaTab.tsx:31-33`) so they survive refresh, work with back/forward, and are shareable. Decision: hash segment (`#/live/movies`) vs query (`#/live?sub=movies`), and whether to keep the instant (no-transition) switch.
