# Plan 004: Resume-or-start-over prompt parity for the IPTV VOD and Series tabs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4132b9a..HEAD -- src/components/tabs/VodTab.tsx src/components/tabs/IptvSeriesTab.tsx src/components/media/MediaPlayer.tsx src/lib/hooks/useIptvHistory.ts src/index.css`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: direction (UX consistency)
- **Planned at**: commit `4132b9a`, 2026-06-12

## Why this matters

The Movies/TV tabs' local-media player (`MediaPlayer`) asks
"Resume from H:MM:SS / Start from beginning" before anything plays when a
saved watch position exists. The IPTV VOD tab and IPTV Series tab —
the other two resumable surfaces in the same SPA — silently auto-resume:
they read the saved row and pass `startPositionSecs` straight into the
player. A household member who refreshed mid-movie sees playback jump to a
position they didn't choose, with no way to start over short of manually
seeking to 0. Same app, two resume behaviors. This plan gives the IPTV tabs
the identical prompt, sharing one component so the UX can't drift again.

A second, structural payoff: both IPTV tabs carry byte-identical
local copies of `ResumeRow` / `resumePercent` / `resumePosition`
(`VodTab.tsx:17-32` ≡ `IptvSeriesTab.tsx:17-31`) — undeliberate
duplication that moves to one shared home.

Deliberate scope cut: this plan does NOT replace the IPTV tabs' native
browser controls with the app-drawn `MediaControls` bar. IPTV VOD
timelines are progressive/absolute already (no `-ss` session offset), so
native controls show correct times there. Controls-bar unification is a
separate decision with real risk; do not attempt it here.

## Current state

- **The exemplar prompt** — `src/components/media/MediaPlayer.tsx:118-130`
  (inside `MediaPlayerView`):
  ```tsx
  {promptingResume && (
    <div className="iptv-tab__status media-resume" role="group" aria-label="Resume playback">
      <p>You were partway through this title.</p>
      <div className="media-resume__choices">
        <button className="iptv-tab__retry" type="button" onClick={onResume}>
          Resume from {formatPlaybackTime(resumePromptSecs)}
        </button>
        <button className="iptv-tab__retry" type="button" onClick={onStartOver}>
          Start from beginning
        </button>
      </div>
    </div>
  )}
  ```
  with `promptingResume = !error && !streamGrant && resumePromptSecs != null`
  (line 84), `resumePromptSecs?: number | null` prop (line 40), and
  `formatPlaybackTime` imported from `./playbackSession`. The CSS lives in
  `src/index.css:153-154` (`.media-resume p`, `.media-resume__choices`).
- **VodTab** (`src/components/tabs/VodTab.tsx`):
  - duplicated helpers at lines 17-32:
    ```ts
    type ResumeRow = {
      position_secs: number
      duration_secs: number | null
      completed: number
    }
    function resumePercent(row: ResumeRow | undefined): number | null { ... }
    function resumePosition(row: ResumeRow | undefined): number | undefined {
      if (!row || row.completed || row.position_secs <= 0) return undefined
      return row.position_secs
    }
    ```
  - play flow at lines 99-120 — the grant is minted FIRST, then the saved
    position is attached:
    ```ts
    const playVod = async (vod: VodDto) => {
      const itemId = vod.stream_id.toString()
      const attempt = async () => {
        const grant = await iptvApi.grantVod(itemId)
        setPlaying({
          grant,
          title: vod.name,
          itemId,
          startPositionSecs: resumePosition(history.get(`vod:${itemId}`)),
        })
      }
      try {
        await attempt()
      } catch (err) {
        const payload = concurrencyPayloadFromError(err)
        if (payload) {
          setConcurrencyError(payload)
          setPendingPlay(() => attempt)
          return
        }
        throw err
      }
    ```
  - the player modal (lines 38-71, `PlayerModal`) renders `IptvPlayer` with
    `startPositionSecs={playing.startPositionSecs}` (line 66); resume bars
    on cards use `resumePercent(history.get(favKey))` (line 139).
  - `history` comes from `useIptvHistoryIndex()` (line 91), keyed
    `vod:<itemId>`.
- **IptvSeriesTab** (`src/components/tabs/IptvSeriesTab.tsx`): same shape —
  duplicated helpers at 17-31, `IptvPlayer ... startPositionSecs` at
  99-102, grant-then-attach at ~158
  (`startPositionSecs: resumePosition(history.get(\`series_episode:${itemId}\`))`),
  resume bars at 267-280. History keys are `series_episode:<episode_id>`.
- **The shared row type already exists**: `HistoryRow` in
  `src/lib/api/iptv.ts:268-276`:
  ```ts
  export type HistoryRow = {
    sub: string
    kind: IptvHistoryKind
    item_id: string
    position_secs: number
    duration_secs: number | null
    watched_at: string
    completed: number
  }
  ```
  and `src/lib/hooks/useIptvHistory.ts` already imports it and exports
  `useIptvHistory` (line 8), `useIptvHistoryIndex` (line 16),
  `useReportPosition` (line 25). The tabs' local `ResumeRow` is a
  structural subset of `HistoryRow` — the helpers can take
  `Pick<HistoryRow, 'position_secs' | 'duration_secs' | 'completed'>`.
- **Why prompt BEFORE granting**: `iptvApi.grantVod` mints a stream grant
  that holds a concurrency slot (cap `IPTV_MAX_CONCURRENT_STREAMS`) with a
  TTL. The MediaPlayer pattern (prompt first, grant after the choice) is
  the correct order here too — don't burn a slot while the user reads the
  prompt. The saved position is known from `history` before any grant.
- Repo conventions: function components + hooks, props-typed inline,
  `useModalA11y` for dialogs, vitest + @testing-library for `.dom.test.tsx`
  files (exemplar: `src/components/media/MediaPlayer.dom.test.tsx`),
  explanatory comments. The eslint react-hooks/immutability rules are
  strict — no mutating props.

## Commands you will need

| Purpose   | Command                                  | Expected on success |
|-----------|------------------------------------------|---------------------|
| Install   | `npm ci`                                 | exit 0              |
| Typecheck | `npx tsc -b`                             | exit 0              |
| Tests     | `npm test`                               | all pass            |
| Targeted  | `npm test -- VodTab` / `-- IptvSeriesTab` / `-- ResumePrompt` / `-- MediaPlayer` | all pass |
| Lint      | `npm run lint`                           | exit 0              |

## Scope

**In scope** (the only files you should modify/create):
- `src/components/media/ResumePrompt.tsx` (create — shared component)
- `src/components/media/ResumePrompt.test.tsx` (create)
- `src/components/media/MediaPlayer.tsx` (swap inline prompt block for the shared component — markup-identical)
- `src/lib/hooks/useIptvHistory.ts` (hoist `resumePercent` / `resumePosition`)
- `src/components/tabs/VodTab.tsx`
- `src/components/tabs/IptvSeriesTab.tsx`
- `src/components/tabs/VodTab.dom.test.tsx` (create)
- `src/index.css` — only if the prompt needs a modal-context tweak; prefer no change

**Out of scope** (do NOT touch, even though they look related):
- `src/components/player/IptvPlayer.tsx` — no changes; it already accepts `startPositionSecs`.
- `src/components/media/MediaControls.tsx` and `nativeControls` wiring — the IPTV tabs keep native controls (deliberate; see Why this matters).
- `src/components/media/playbackSession.ts` — `formatPlaybackTime` is imported as-is.
- `src/components/tabs/LiveTab.tsx` / live IPTV — live streams have no resume concept.
- The Movies/TV tabs (`MoviesTab.tsx`, `TvTab.tsx`) and `useMediaLibrary.ts` — their resume path is the already-shipped MediaPlayer flow.
- Backend (`server/`) — watch-history routes already exist and are consumed unchanged.

## Git workflow

- Branch: `advisor/004-iptv-resume-prompt`
- Conventional commits, one per step where sensible (e.g. `refactor(iptv): hoist resume helpers into useIptvHistory`, `feat(iptv): resume-or-start-over prompt for VOD and series playback`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the shared `ResumePrompt` component

Create `src/components/media/ResumePrompt.tsx` rendering EXACTLY the markup
of the MediaPlayer block quoted in Current state (same class names
`iptv-tab__status media-resume`, `media-resume__choices`,
`iptv-tab__retry`; same `role="group"` and aria-label; same copy):

```tsx
import { formatPlaybackTime } from './playbackSession'

type Props = {
  resumeSecs: number
  onResume: () => void
  onStartOver: () => void
}
export function ResumePrompt({ resumeSecs, onResume, onStartOver }: Props) { ... }
```

Then in `MediaPlayer.tsx`, replace the inline `{promptingResume && (...)}`
JSX with `{promptingResume && <ResumePrompt resumeSecs={resumePromptSecs} ... />}`,
keeping `promptingResume`'s definition and the `onResume`/`onStartOver`
handlers untouched. The rendered DOM must be identical — the existing
MediaPlayer DOM tests are the proof.

**Verify**: `npm test -- MediaPlayer` → all existing tests pass unchanged.
`npx tsc -b` → exit 0.

### Step 2: Hoist the duplicated resume helpers

In `src/lib/hooks/useIptvHistory.ts`, export:

```ts
export type ResumeFields = Pick<HistoryRow, 'position_secs' | 'duration_secs' | 'completed'>
export function resumePercent(row: ResumeFields | undefined): number | null { ... }
export function resumePosition(row: ResumeFields | undefined): number | undefined { ... }
```

Bodies copied verbatim from `VodTab.tsx:23-32`. Delete the local
`ResumeRow` type + both helper functions from `VodTab.tsx` (lines 17-32)
and `IptvSeriesTab.tsx` (lines 17-31); import from the hook module instead.

**Verify**: `npx tsc -b` → exit 0; `npm run lint` → exit 0;
`grep -rn 'function resumePercent\|function resumePosition' src/components/tabs/` → no matches.

### Step 3: Prompt-before-grant in VodTab

Add a pre-grant prompt state to `VodTab`:

```ts
const [resumeChoice, setResumeChoice] = useState<{
  vod: VodDto
  resumeSecs: number
} | null>(null)
```

Rework `playVod` (currently lines 99-120): compute
`const resumeSecs = resumePosition(history.get(`vod:${vod.stream_id}`))`
FIRST. If `resumeSecs != null`, `setResumeChoice({ vod, resumeSecs })` and
return — no grant yet. Otherwise proceed as today (grant, then
`setPlaying({ ..., startPositionSecs: undefined })`).

Refactor the existing grant logic into a helper
`startPlayback(vod: VodDto, startPositionSecs: number | undefined)` that
preserves the concurrency-retry contract exactly: on
`concurrencyPayloadFromError(err)` → `setConcurrencyError(payload)` +
`setPendingPlay(() => attempt)` where `attempt` re-runs with the SAME
chosen offset (lines 110-119 today).

Render the prompt when `resumeChoice != null` — inside the same modal
chrome the player uses so focus trapping and Escape behave (reuse the
`PlayerModal` wrapper pattern at lines 38-71: a `role="dialog"` div via
`useModalA11y`, title = the VOD name, close button → `setResumeChoice(null)`),
with `<ResumePrompt resumeSecs={...} onResume={...} onStartOver={...} />`
as the body. `onResume` → `startPlayback(vod, resumeSecs)`; `onStartOver` →
`startPlayback(vod, undefined)`; both also clear `resumeChoice`.

Behavior notes the implementation must honor:
- Completed rows and `position_secs <= 0` never prompt
  (`resumePosition` already returns `undefined` for them).
- The card resume bars (`resumePercent` at line 139) are untouched.
- Start-over must pass `undefined` (NOT 0) so `IptvPlayer` treats it as a
  fresh start, matching today's no-history call shape.

**Verify**: `npx tsc -b`, `npm run lint` → exit 0. Manual trace: grep the
file to confirm `iptvApi.grantVod` is now reachable only from
`startPlayback`.

### Step 4: Same change in IptvSeriesTab

Apply the Step-3 pattern to `IptvSeriesTab.tsx`: prompt state keyed on the
episode (`history.get(\`series_episode:${episode_id}\`)`), grant deferred
until the choice, concurrency-retry preserved, episode resume bars
(lines 267-280) untouched.

**Verify**: `npx tsc -b`, `npm run lint` → exit 0.

### Step 5: Tests

1. `src/components/media/ResumePrompt.test.tsx` — renders the formatted
   time (`resumeSecs=2036` → "33:56" via `formatPlaybackTime`), fires both
   callbacks, has `role="group"`.
2. `src/components/tabs/VodTab.dom.test.tsx` — model the harness on
   `src/components/media/MediaPlayer.dom.test.tsx` (vitest + jsdom +
   @testing-library/react; mock `iptvApi` and the hooks the tab uses —
   `useIptvVod`, `useIptvCategories`, `useIptvFavoriteSet`,
   `useIptvHistoryIndex`, etc. with `vi.mock`). Cases:
   a. history row exists (`position_secs: 600, completed: 0`) → clicking a
      VOD card shows "Resume from 10:00" and `iptvApi.grantVod` has NOT
      been called;
   b. clicking "Resume from 10:00" → `grantVod` called once; player mounts
      with `startPositionSecs === 600`;
   c. clicking "Start from beginning" → `grantVod` called once; player
      mounts with `startPositionSecs === undefined`;
   d. no history row → clicking the card grants immediately, no prompt.
3. (Series tab gets its behavior through the identical pattern; a separate
   `IptvSeriesTab.dom.test.tsx` is optional — add it only if the
   implementation diverged from VodTab structurally.)

**Verify**: `npm test -- ResumePrompt` and `npm test -- VodTab` → pass.

### Step 6: Full gate

```bash
npm test && npx tsc -b && npm run lint
```

**Verify**: all green, including every pre-existing MediaPlayer/IptvPlayer
suite.

## Test plan

Covered in Step 5. The MediaPlayer DOM suite doubles as the
regression proof that extracting `ResumePrompt` changed nothing for the
local-media path.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/components/media/ResumePrompt.tsx` exists and `MediaPlayer.tsx` renders it (no inline duplicate of the prompt markup: `grep -c 'You were partway' src/components/media/*.tsx` returns exactly 1, in ResumePrompt.tsx)
- [ ] `grep -rn 'function resumePercent\|function resumePosition' src/components/tabs/` → no matches (helpers hoisted)
- [ ] In VodTab and IptvSeriesTab, `grantVod`/episode grant is invoked only after the prompt choice when a resume row exists (asserted by VodTab.dom.test.tsx case a-c)
- [ ] `npm test` exits 0 (including all pre-existing suites)
- [ ] `npx tsc -b` and `npm run lint` exit 0
- [ ] `git diff --name-only` ⊆ the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- Preserving the concurrency-retry contract (`pendingPlay` re-attempt after
  the ConcurrencyLimitModal) turns out to conflict with deferring the
  grant — report the conflict with the relevant code rather than redesigning
  the retry flow.
- The MediaPlayer DOM tests fail after Step 1 — the extraction was supposed
  to be markup-identical; don't adapt the tests to new markup.
- You find the IPTV series episode grant works differently from
  `grantVod` in a way that breaks the deferred-grant pattern (e.g. the
  grant must exist before the episode list renders).

## Maintenance notes

- Any FUTURE resumable surface should render `ResumePrompt` and the
  hoisted helpers — a new local "resume from" markup or a re-inlined
  `resumePosition` in a tab is a review flag.
- If the IPTV tabs ever move to the app-drawn `MediaControls` bar (the
  deliberate scope cut here), the prompt wiring from this plan is already
  in the right place — only the player chrome changes.
- Reviewer should scrutinize: the concurrency-retry path re-attempts with
  the SAME chosen offset (not re-reading history, which may have changed);
  and that no grant is minted while the prompt is on screen.
