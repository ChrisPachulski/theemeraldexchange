# Plan 001: Lazy-load three.js so the entry chunk no longer ships ~600KB of WebGL for a brand glyph

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4132b9a..HEAD -- src/lib/animatedFavicon.ts src/lib/gemScene.ts src/components/atmosphere/EmeraldMark.tsx src/App.tsx src/main.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `4132b9a`, 2026-06-12

## Why this matters

The SPA's entry chunk (`dist/assets/index-*.js`) is ~849KB, and roughly
600KB of that is three.js — verified: `WebGLRenderer` appears only in the
entry chunk, in no lazy chunk. The only consumer of three.js in the entire
`src/` tree is `src/lib/gemScene.ts` (the 3D emerald brand mark), which is
pulled into the entry statically through two chains:

1. `src/main.tsx:8` → `mountAnimatedFavicon` → `animatedFavicon.ts:10` → `gemScene.ts:7` → `three`
2. `EmeraldMark.tsx:2` → `gemScene.ts` — and `EmeraldMark` is statically
   imported by app-shell components (`TopNav.tsx:7`, `HomeNav.tsx:3`,
   `LoadingPulse.tsx:1`), so it rides in the entry no matter which tab loads.

The app already lazy-loads every non-home tab specifically to keep the
initial bundle small (`App.tsx:20-37`), but three.js — the single largest
dependency — defeats that effort. Neither consumer needs three.js for first
paint: the favicon starts as a static SVG fallback by design, and
`EmeraldMark` already renders a bare `<canvas>` (with `aria-label`) that
stays gracefully blank whenever WebGL is unavailable. Loading the GemScene
asynchronously moves ~600KB out of the critical path; the gem simply starts
sparkling one network round-trip after first paint.

IMPORTANT context: the 3D WebGL brand mark itself is a deliberate,
owner-approved design decision. This plan must NOT remove, downgrade, or
visually change it — only defer when its code downloads.

## Current state

- `src/lib/gemScene.ts` — the only file importing `three` (`import * as THREE from 'three'` at line 7). Exports `GemSceneOptions` (line 127) and `class GemScene` (line 136). **No changes to this file.**
- `src/lib/animatedFavicon.ts` — static import at line 10:
  ```ts
  import { GemScene } from './gemScene'
  ```
  `mountAnimatedFavicon()` (line 28) guards: SSR bail (line 29), `navigator.webdriver` bail (line 37, keeps headless CI from crashing the GPU process), an idempotency flag (lines 38-39). It then builds a render canvas and boots `new GemScene({...})` inside a try/catch (lines 49-68) whose catch leaves the static SVG favicon alone. Everything below line 40 can run later without harm — the `<link rel="icon">` keeps the SVG until the first PNG frame is pumped (lines 77-81).
- `src/components/atmosphere/EmeraldMark.tsx` — static import at line 2. The component renders a `<canvas>` (lines 73-81) and boots the scene in a `useEffect` (lines 28-71): webdriver bail (line 38), `new GemScene({...})` in try/catch (lines 40-51), then visibility/reduced-motion listeners (lines 52-65), with cleanup removing listeners and calling `scene.dispose()` (lines 66-70). Effect deps: `[width, height, variant]`.
- `src/main.tsx:8 + 28` — imports and calls `mountAnimatedFavicon()` after render. **No changes needed here** (the lazy boundary moves inside `animatedFavicon.ts`).
- `src/App.tsx:20-24` — comment documenting what the initial bundle ships:
  ```
  // Non-home tabs are lazy-loaded so the initial JS bundle ships only the
  // always-visible shell (Kraken atmosphere, nav, brand mark, HomeTab) plus
  // three.js / react-dom. ...
  ```
  The "plus three.js" clause becomes false after this change — update the comment. (The Kraken atmosphere is CSS-only — `Kraken.tsx` imports nothing but `Kraken.css` — so nothing else in the shell needs three.)
- Build tooling: Vite 8. Dynamic `import()` automatically produces a separate chunk; no `manualChunks` config exists or is needed (`vite.config.ts` has no `build` section).
- Repo conventions: TypeScript strict; `import type` for type-only imports; eslint includes `react-hooks` rules — effects with async boots must handle unmount-before-resolve. Comment style is heavy and explanatory — match it (see the existing comments in both files).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `npm ci`                 | exit 0              |
| Typecheck | `npx tsc -b`             | exit 0, no errors   |
| Tests     | `npm test`               | all pass (~1800 vitest tests) |
| Lint      | `npm run lint`           | exit 0              |
| SPA build | `npm run build:spa`      | exit 0, writes `dist/` |

## Scope

**In scope** (the only files you should modify):
- `src/lib/animatedFavicon.ts`
- `src/components/atmosphere/EmeraldMark.tsx`
- `src/App.tsx` (comment at lines 20-24 only)

**Out of scope** (do NOT touch, even though they look related):
- `src/lib/gemScene.ts` — no changes; it stays the sole three.js importer.
- `src/main.tsx` — keep the static import of `mountAnimatedFavicon`; the function itself becomes lazy inside.
- `vite.config.ts` — no manualChunks; Vite's automatic dynamic-import splitting is sufficient.
- `package.json` — three.js stays a dependency.
- Any visual property of the gem (colors, fov, exposure, animation) — the mark is an owner-approved design element.

## Git workflow

- Branch: `advisor/001-split-threejs-entry`
- Conventional-commit style matching `git log` (e.g. `perf(spa): lazy-load three.js gem scene out of the entry chunk`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record the baseline entry-chunk size

```bash
npm run build:spa
ls -la dist/assets/index-*.js
grep -l 'WebGLRenderer' dist/assets/*.js
```

**Verify**: the entry chunk (`index-*.js`) is ~849KB and is the file
containing `WebGLRenderer`. Record both numbers for the final comparison.

### Step 2: Make `animatedFavicon.ts` import GemScene dynamically

Replace the static import (line 10) with a type-only import (type imports
are erased at build time and do not pin the chunk):

```ts
import type { GemScene } from './gemScene'
```

Inside `mountAnimatedFavicon()`, keep all the early bails (SSR, webdriver,
idempotency flag) exactly where they are — they must run synchronously so
the once-flag is set before any await. Then wrap everything from the
render-canvas creation down in a dynamic import continuation:

```ts
void import('./gemScene')
  .then(({ GemScene }) => {
    // ...existing body from `const renderCanvas = ...` down, unchanged,
    // except `new GemScene(...)` now uses the destructured class...
  })
  .catch((err) => {
    console.warn('[favicon] gem scene chunk failed to load; static SVG fallback stays', err)
  })
```

The local `let scene: GemScene` annotation keeps working via the type-only
import. Do not change the pump/visibility logic.

**Verify**: `npx tsc -b` → exit 0. `npm run lint` → exit 0.

### Step 3: Make `EmeraldMark.tsx` boot the scene asynchronously

Replace the static value import (line 2) with a type-only import:

```ts
import type { GemScene } from '../../lib/gemScene'
```

Rework the `useEffect` (lines 28-71) so the scene boots after a dynamic
import, with unmount-before-resolve handled:

```ts
useEffect(() => {
  const canvas = canvasRef.current
  if (!canvas) return
  if (typeof navigator !== 'undefined' && navigator.webdriver) return
  let cancelled = false
  let scene: GemScene | null = null
  let teardown: (() => void) | null = null
  void import('../../lib/gemScene').then(({ GemScene: GemSceneCtor }) => {
    if (cancelled) return
    try {
      scene = new GemSceneCtor({ canvas, width, height, gemCount: ..., fov: ... })
    } catch (err) {
      console.warn('[EmeraldMark] WebGL init failed', err)
      return
    }
    // ...existing syncMotion + listener wiring, assigning a remover
    // function to `teardown`...
  })
  return () => {
    cancelled = true
    teardown?.()
    scene?.dispose()
  }
}, [width, height, variant])
```

Preserve the existing behaviors exactly: the webdriver bail comment block,
`prefers-reduced-motion` handling (`scene.stop(); scene.renderAt(0)`),
visibilitychange pause, and `scene.dispose()` on unmount. The canvas
element and its `aria-label`/`role` stay untouched, so the pre-boot frame
is identical to today's WebGL-unavailable fallback.

**Verify**: `npx tsc -b` → exit 0. `npm run lint` → exit 0 (the
react-hooks rules must be satisfied without suppressions).

### Step 4: Update the App.tsx bundle comment

At `src/App.tsx:20-24`, the comment currently claims the initial bundle
ships "three.js / react-dom". Update it to reflect that three.js now loads
in its own lazy chunk via the gem scene (keep the rest of the comment).

**Verify**: `grep -n 'three' src/App.tsx` → only the updated comment, no
new imports.

### Step 5: Build and confirm the split

```bash
npm run build:spa
grep -l 'WebGLRenderer' dist/assets/*.js
ls -la dist/assets/index-*.js dist/assets/gemScene-*.js 2>/dev/null || ls -la dist/assets/*.js
```

**Verify**:
- `WebGLRenderer` appears in exactly one chunk and that chunk is NOT
  `index-*.js` (it will be named after the gemScene module).
- The new `index-*.js` is at least 500KB smaller than the Step-1 baseline.

### Step 6: Run the full gate

```bash
npm test && npx tsc -b && npm run lint
```

**Verify**: all green. Pay attention to
`src/components/walkthrough/Walkthrough.test.tsx` (renders EmeraldMark) and
any test rendering TopNav/HomeNav/LoadingPulse — they must still pass; in
jsdom the dynamic import resolves and the GemScene constructor throws into
the existing try/catch, same as before.

## Test plan

- Existing suites are the regression net (Walkthrough + nav component
  tests render EmeraldMark; the favicon module is not directly tested).
- Add one new test file `src/components/atmosphere/EmeraldMark.test.tsx`
  (model the setup after `src/components/media/MediaControls.dom.test.tsx`
  — jsdom + @testing-library/react):
  1. renders a `canvas` with `aria-label="The Emerald Exchange"` immediately
     (before any dynamic import settles);
  2. unmounting immediately after mount does not throw or log unhandled
     rejections (covers the unmount-before-import-resolves path: render,
     unmount, then `await Promise.resolve()` a few times / `vi.waitFor`).
- Verification: `npm test -- EmeraldMark` → new tests pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc -b` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm test` exits 0, including the new EmeraldMark tests
- [ ] `npm run build:spa` exits 0
- [ ] `grep -l 'WebGLRenderer' dist/assets/*.js` outputs exactly one file, and it is NOT `dist/assets/index-*.js`
- [ ] `grep -c "from 'three'" -r src --include='*.ts' --include='*.tsx'` still returns matches only in `src/lib/gemScene.ts`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- After Step 5, `WebGLRenderer` still appears in the entry chunk — that
  means another static import chain to three.js exists; find it with
  `grep -rn "gemScene\|from 'three'" src --include='*.ts*'` and report it
  rather than chasing it.
- Satisfying the react-hooks lint rules for the async effect requires an
  eslint-disable comment — report the conflict instead of suppressing.
- Entry-chunk shrink is less than 400KB (the split didn't capture what was
  expected).

## Maintenance notes

- Any future placement of the gem mark must import GemScene **dynamically**
  (or render `EmeraldMark`, which now does it internally). A single static
  `import { GemScene }` from app-shell code drags three.js back into the
  entry — worth a grep in review whenever `gemScene` shows up in a diff.
- If a second WebGL feature ever lands, consider giving three.js an
  explicit `manualChunks` entry so both features share one chunk; today
  Vite's automatic splitting is enough because gemScene is the only
  consumer.
- Reviewer should scrutinize: the unmount-before-resolve path in
  EmeraldMark (no listener leaks, no dispose-on-null), and that the favicon
  idempotency flag is still set synchronously (double-call of
  `mountAnimatedFavicon` must not double-boot after the await).
