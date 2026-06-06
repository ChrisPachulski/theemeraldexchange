// scripts/autoloop/mesh.workflow.mjs
//
// ONE bounded improvement window of the pure-Claude mesh, as a Workflow script.
// Invoked by the /loop driver via the Workflow tool: { scriptPath: this-file }.
//
// IMPORTANT: Workflow scripts run in a restricted JS sandbox — NO fs / Node API.
// This file is PURE ORCHESTRATION (agent fan-out + structured returns). All
// persistence (node-state, dead-ends, iteration-log) and the guard/usage checks
// happen in the DRIVER turn (loop-prompt.md) and inside the agents themselves
// (agents have Bash/Read/Edit/Write; the executor uses isolation:'worktree').
//
// Flow (the real mesh + discovery forest):
//   Discover  : parallel Haiku leaves scan areas → pipeline Sonnet boolean-audit
//   Synthesize: Opus ranks survivors, picks ONE low-risk autonomous item
//   Execute   : Opus executor in an isolated worktree writes fix + tests, commits, pushes branch
//   Verify    : Sonnet tester summarizes gate result; Opus skeptic adversarially checks
//
// `args` (passed by the driver): { doneTitles: [...], existingBranches: "...",
//   immuneRules: "...", firstRun: true, repoRoot: "..." }

export const meta = {
  name: 'eex-autoloop-mesh',
  description: 'One bounded improvement window: discovery forest → audit → worktree fix → test → skeptic → branch',
  phases: [
    { title: 'Discover', detail: 'Haiku leaves scan areas; Sonnet boolean-audits each candidate' },
    { title: 'Synthesize', detail: 'Opus ranks survivors and picks one low-risk autonomous item' },
    { title: 'Execute', detail: 'Opus executor writes fix + tests in an isolated worktree, pushes a branch' },
    { title: 'Verify', detail: 'Sonnet tester + Opus skeptic adversarial check' },
  ],
}

// ROBUSTNESS: the /loop driver sometimes hands `args` as a JSON-ENCODED STRING rather
// than an object (the prompt shows it as a literal; an LLM driver tends to serialize it).
// When that happens, `args.scope` / `args.primaryObjective` / `args.baseBranch` are all
// undefined → the mesh silently runs with NO scope, NO objective mode, and the DEFAULT
// base (auto/integration) — which is exactly what made every self-improve window "drift"
// into product code. Parse it back so the args actually take effect. (Workflow docs warn
// args should be a real JSON value; this is the defensive net for when it isn't.)
const A = (typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : args) || {}
const DONE = (A.doneTitles || []).map((t) => `- ${t}`).join('\n') || '(none yet)'
const BRANCHES = A.existingBranches || '(none)'
const IMMUNE = A.immuneRules || '(no antibodies yet)'
// The integration branch is the loop's cumulative base (= main + confirmed work).
// The driver runs on it, so worktrees fork from it — fixes already made this
// session are present, so the forest cannot re-discover them. See ARCHITECTURE.md.
const BASE = A.baseBranch || 'auto/integration'
// Verification gate is PARAMETERIZED (agnostic): the EEX run uses ci-gate.sh
// (tsc/vitest); a self-improvement run targeting scripts/autoloop passes
// engine-gate.mjs (validates workflow scripts via the sandbox-wrap that plain
// `node --check` false-fails). Default preserves product-loop behavior.
const GATE = A.gateCmd || 'bash scripts/autoloop/ci-gate.sh'
// SCOPE = the run's PREFERRED focus (e.g. a self-improvement run → "scripts/autoloop/"),
// NOT a brick wall. Proactive, reasonable, low-risk ADJACENT work outside it is allowed
// and welcome — that's part of being useful. What is NEVER allowed (any run) is the
// dependency/build/CI/secret INFRA set: those are human decisions (IR-8) and were the
// genuinely-bad escapes on the first fire (package.json dep bumps). The deterministic
// gate below hard-blocks ONLY that infra set; SCOPE biases discovery, it doesn't forbid.
const SCOPE = A.scope || ''
// Hard-block set — infra/build/CI/secrets/deps. Out-of-scope-but-reasonable is fine; THIS is not.
const FORBIDDEN_RE = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Dockerfile|docker-compose[^/]*|compose\.ya?ml|tsconfig[^/]*\.json|vitest\.config\.[jt]s|\.env|\.github\/|deploy)/
const scopeRule = SCOPE
  ? `FOCUS: this run primarily improves \`${SCOPE}\`. PREFER candidates there. Reasonable, low-risk work in clearly-RELATED files just outside it is allowed when it's genuinely proactive (don't contort to stay inside). HARD RULE (any file): NEVER touch dependency/build/CI/secret infra — package.json, lockfiles, Dockerfile, compose, .github, tsconfig, vitest.config, .env, deploy scripts. Those are human decisions (IR-8).`
  : ''

// USE THE INTERNET (mirrors the repo/global CLAUDE.md "research before asserting" directive,
// which Workflow SUBAGENTS do NOT inherit automatically — so it must be stated in-prompt).
// For ANY external/objective fact — library/API/framework behavior, version-specific syntax,
// a config option, an error meaning, "is this still the current way" — these agents must
// consult authoritative docs FIRST rather than rely on (possibly stale) training memory.
// They can reach WebSearch / WebFetch and the context7 MCP docs tool on demand (load schemas
// via ToolSearch). Looking it up is the default reflex, not a last resort.
const WEB_RULE = 'USE THE INTERNET — verify external facts before acting. For any library/API/framework behavior, version-specific syntax, config flag, deprecation, or error meaning, run WebSearch and read the authoritative/vendor docs (or use the context7 MCP tool for library docs; load tool schemas via ToolSearch if needed) BEFORE implementing or judging from memory. Training knowledge may be out of date; ground every external claim in what the current docs ACTUALLY say. Do this proactively, not only when stuck.'

// GOALS.md drives WHAT to work on (Part A class ladder + Part B roadmap weighting);
// hotspots.json drives WHERE (defect concentration: change-freq × size). Selection =
// gate → highest non-empty class → rank by hotspotScore × roadmap-fit. Effort is a
// tiebreaker, never a divisor. See GOALS.md + the 2026-06-01 literature consultation
// (project_autoloop_value_model_evidence): confidence is a GATE not a multiplier, a
// lexicographic class ladder beats a blended score, reviewer attention is the scarce
// resource, and hotspot targeting is the leg that turns "safe" work into "high-value".
const GOALS = A.goals || '(no GOALS.md provided — fall back to broad discovery)'
// PRIMARY_OBJECTIVE (optional) — a SPECIFIC backlog item this window must implement
// (e.g. the driver's merit-state `topOpen` + its full spec). When set, the mesh enters
// OBJECTIVE MODE: the discoverable classes collapse to {signal-fix, objective} so the
// forest CANNOT surface trivia. A reproduced red signal still preempts (it always
// outranks grooming); otherwise the only legal pick is implementing THIS objective, or a
// clean dry window. This is the deterministic cure for the drift where free-roam
// discovery ignored the steer and returned mechanical busywork — there is simply no
// trivial candidate in the pool to pick. Plain prose steering was advisory and got
// ignored twice; this makes the steer structural.
const PRIMARY_OBJECTIVE = (A.primaryObjective || '').toString().trim()
const OBJECTIVE_MODE = PRIMARY_OBJECTIVE.length > 0
const HOTSPOTS = Array.isArray(A.hotspots) ? A.hotspots : []
const HOTLIST = HOTSPOTS.slice(0, 20).map((h) => `${h.file} (rev=${h.revisions}, loc=${h.loc}, score=${h.score})`).join('\n') || '(no hotspot data — treat files equally)'
const HOTMAP = new Map(HOTSPOTS.map((h) => [h.file, h.score]))
function scoreFor(file) {
  if (!file) return 0
  if (HOTMAP.has(file)) return HOTMAP.get(file)
  for (const [f, s] of HOTMAP) { if (f.endsWith(file) || file.endsWith(f)) return s }
  return 0
}

// SIGNALS (the PROACTIVITY leg, from signals.mjs) — real, reproduced,
// evidence-bearing work items: a red CI job, a recurring-fix file, a TODO/FIXME,
// or anything a per-repo adapter surfaced (error tracker, issues, perf budget).
// Each discovery leaf is SEEDED with the real signals for its class so the forest
// works on what is actually broken/needed, not what it can imagine by code-shape.
// When the signal queue is dry, the leaves fall back to code-scan (coverage = floor).
// See signals.mjs + ARCHITECTURE.md "Signal ingestion".
const SIGNALS = Array.isArray(A.signals) ? A.signals : []
const SIGBYCLASS = new Map()
for (const s of SIGNALS) {
  const k = s.class || 'signal-fix'
  if (!SIGBYCLASS.has(k)) SIGBYCLASS.set(k, [])
  SIGBYCLASS.get(k).push(s)
}
function signalsBlock(classKey) {
  const items = SIGBYCLASS.get(classKey) || []
  if (!items.length) return ''
  return [
    `REAL REPRODUCED SIGNALS for this class — PREFER THESE over anything you imagine by reading code.`,
    `They are already evidenced and carry an objective gate; pick from here first:`,
    ...items.slice(0, 6).map((s) => `  • [sev ${s.severity}] ${s.title}${s.file ? ` (file: ${s.file})` : ''}\n      evidence: ${s.evidence}\n      gate: ${s.gate}`),
    `A reproduced signal is high-merit by definition — for the signal-fix class it need NOT target a hotspot file (the red itself is the justification). For other classes still prefer hotspots.`,
  ].join('\n')
}

// Evidence-derived work-class ladder (GOALS.md Part A), highest priority first.
// One Haiku discovery leaf per class; synth picks within the HIGHEST non-empty class.
const SIGNAL_FIX_CLASS = { key: 'signal-fix', desc: 'Fix a REPRODUCED failure that is RED right now (a failing test, a crash, a type error, a lint/sanitizer error). NEVER speculative bug-hunting — only an already-failing signal you can show go red→green.' }
const CLASSES = OBJECTIVE_MODE
  // OBJECTIVE MODE: signal-fix may preempt (a red is always higher-merit); otherwise the
  // ONLY discoverable work is implementing the specific objective. No trivial classes are
  // offered, so the forest cannot drift to busywork — it implements the objective or goes dry.
  ? [
      SIGNAL_FIX_CLASS,
      { key: 'objective', desc: `Implement EXACTLY this assigned backlog objective and NOTHING else:\n${PRIMARY_OBJECTIVE}\n\nProduce the concrete file change(s) that implement it PLUS the verification that proves it (a red→green test, a measurable delta, or a newly-passing gate). If the objective is ALREADY fully implemented (verify before claiming so), return autonomous=false / a dry window — do NOT substitute unrelated cleanup. Do NOT invent a different task; this window is dedicated to the objective above.` },
    ]
  : [
      SIGNAL_FIX_CLASS,
      { key: 'mechanical', desc: 'A mechanical, SEMANTICS-PRESERVING change at a hotspot file: codemod, dead-code removal, deprecation migration, safe lint-autofix. Behavior must be provably unchanged.' },
      { key: 'gated-test', desc: 'A test improvement at a hotspot file that BUILDS, passes reliably, STRICTLY increases coverage, AND would catch a real regression. Coverage on a COLD file does not count.' },
      { key: 'devex', desc: 'A cognitive-load / feedback-loop improvement at a hotspot: stronger types, de-flake a flaky test, speed up CI runtime, fill a doc gap that blocks understanding.' },
      { key: 'dep-hygiene', desc: 'Dependency/security hygiene, BATCHED and confidence-scored (never a single trivial bump). Lowest priority — only when the classes above are empty.' },
    ]
if (OBJECTIVE_MODE) log(`OBJECTIVE MODE — discoverable classes collapsed to {signal-fix, objective}; no trivia can be picked`)
// All class keys that may legally appear (for schema enums + the deterministic gate).
const CLASS_ENUM = ['signal-fix', 'mechanical', 'gated-test', 'devex', 'dep-hygiene', 'objective']

const CAND = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'autonomous', 'risk'],
        properties: {
          title: { type: 'string' },
          class: { type: 'string', enum: CLASS_ENUM },
          hotspotFile: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
          autonomous: { type: 'boolean' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['keep'],
  properties: {
    keep: { type: 'boolean' },
    reason: { type: 'string' },
    title: { type: 'string' },
    class: { type: 'string', enum: CLASS_ENUM },
    hotspotFile: { type: 'string' },
  },
}

const PICK = {
  type: 'object',
  required: ['title', 'instructions', 'autonomous', 'risk', 'delta'],
  properties: {
    title: { type: 'string' },
    class: { type: 'string', enum: CLASS_ENUM },
    hotspotScore: { type: 'number' },
    valueRationale: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    instructions: { type: 'string' },
    autonomous: { type: 'boolean' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    delta: { type: 'string' },
  },
}

const FIX = {
  type: 'object',
  required: ['changed', 'summary', 'delta'],
  properties: {
    changed: { type: 'boolean' },
    branch: { type: 'string' },
    pushed: { type: 'boolean' },
    summary: { type: 'string' },
    testsAdded: { type: 'string' },
    delta: { type: 'string' },
    error: { type: 'string' },
  },
}

const CHECK = {
  type: 'object',
  required: ['ok', 'passToPass', 'failToPass'],
  properties: {
    ok: { type: 'boolean' }, // aggregate: passToPass && failToPass
    passToPass: { type: 'boolean' }, // pre-existing engine suite stayed green
    failToPass: { type: ['boolean', 'string'] }, // new test(s) went red→green (boolean or description)
    findings: { type: 'string' },
    verdict: { type: 'string' },
  },
}

// SKEPTIC schema (backlog V1.1) — distinct from CHECK so the adversary must
// separate PLAUSIBLE (the gate is green) from VALID (the change is semantically
// correct AND the tests are meaningful, not rubber-stamping). [G1, Passerine]:
// passing the test is plausible; correctness is a separate, lower bar. A change
// confirms only on VALID — see isConfirmed below.
const SKEPTIC = {
  type: 'object',
  required: ['plausible', 'valid', 'validityRationale'],
  properties: {
    plausible: { type: 'boolean' }, // gate green / tests pass on their face
    valid: { type: 'boolean' },     // semantically correct AND tests are meaningful
    validityRationale: { type: 'string' }, // concrete WHY it is (or is not) valid
    ok: { type: 'boolean' },        // back-compat mirror of `valid`
    findings: { type: 'string' },
    verdict: { type: 'string' },
  },
}

// Inline TWIN of scripts/autoloop/confirm.mjs:isConfirmed — the canonical, unit-
// tested predicate. Workflow scripts run in a sandbox that forbids `import`, so
// the logic is duplicated here; confirm.test.mjs pins this twin to the canonical
// version (drift guard). CONFIRMED iff:
// - the gate is green (test.ok === true), AND
// - both regression guard dimensions pass: PASS_TO_PASS (pre-existing tests stayed green) and
//   FAIL_TO_PASS (new tests went red→green), AND
// - the skeptic asserts VALIDITY with a rationale (semantic correctness is separate from gate), AND
// - a measured delta is present (fix.delta truthy, V1.3 assured-improvement gate).
// A green gate + green new test alone is NOT enough if a pre-existing test broke (regression).
// A green gate + VALID skeptic is still not confirmed if there is NO measured delta (V1.3).
function isConfirmed(r = {}) {
  const { test, skeptic, fix } = r
  const gateGreen = test && test.ok === true
  const passToPass = test && test.passToPass === true // pre-existing suite stayed green
  const failToPass = test && (test.failToPass === true || (typeof test.failToPass === 'string' && test.failToPass.trim().length > 0)) // new test went red→green
  const valid = skeptic && skeptic.valid === true
  const rationale =
    skeptic && typeof skeptic.validityRationale === 'string' && skeptic.validityRationale.trim().length > 0
  const delta = fix && typeof fix.delta === 'string' && fix.delta.trim().length > 0 // measured improvement (V1.3)
  return !!(gateGreen && passToPass && failToPass && valid && rationale && delta)
}

// ---- Discover: ONE Haiku leaf per work-class, scanning hotspots → Sonnet gate ----
phase('Discover')
const audited = await pipeline(
  CLASSES,
  (c) => agent(
    [
      `You are a read-only discovery leaf in an autonomous improvement loop for this repo.`,
      `Find up to 3 concrete improvements of EXACTLY this work-class:`,
      `  class "${c.key}": ${c.desc}`,
      `TARGET THE HOTSPOTS — the highest defect-density files (change-frequency × size). Prefer work in/near these; IGNORE cold, rarely-changed files (coverage/refactors there are near-zero value):`,
      HOTLIST,
      `Roadmap priorities to favor (GOALS.md Part B):\n${GOALS}`,
      `Each candidate MUST be autonomous (code/tests/docs/deps — NO Apple, hardware, deploy, secrets, CI/.github, Dockerfile, tsconfig, vitest.config, package.json), low-risk, and have an OBJECTIVE VERIFICATION GATE it can pass: a test that goes red→green, a measurable coverage gain on a hotspot, or a build/lint that newly passes. If you cannot name the gate, do not propose it.`,
      WEB_RULE,
      scopeRule,
      `Set class="${c.key}" and hotspotFile to the primary target file (use a path from the hotspot list when possible).`,
      `Do NOT propose anything already done:\n${DONE}`,
      `Avoid known dead-ends / honor these antibodies:\n${IMMUNE}`,
      `Existing in-flight branches: ${BRANCHES}`,
    ].join('\n'),
    { model: 'haiku', phase: 'Discover', label: `scan:${c.key}`, schema: CAND },
  ),
  // Sonnet gate: verifiability FIRST, abstain when unsure (a dry window is correct).
  (found, c) => agent(
    [
      `You are a strict auditor for work-class "${c.key}". Candidates:`,
      JSON.stringify(found.candidates || []),
      `Return keep=true for the SINGLE best candidate ONLY if ALL hold: it is real, correct, genuinely valuable, low-risk, autonomous, not already done, targets a hotspot file, AND it has an OBJECTIVE verification gate it can pass (a red→green test, a measurable coverage gain, or a newly-passing build/lint).`,
      scopeRule ? `${scopeRule} keep=false ONLY if the candidate touches the forbidden infra set; a reasonable out-of-\`${SCOPE}\` pick that's clearly related is OK.` : '',
      `If you cannot confirm the verification gate, keep=false — ABSTAIN. A clean dry window is a CORRECT, valued outcome; reviewer attention is scarce, so NEVER pass a weak candidate just to keep volume up.`,
      `Not already done:\n${DONE}`,
      `ANTIBODY GATE — keep=false if the best candidate matches any VERIFIED antibody by symptom/root-cause (not just title). Antibodies marked unverified/advisory are HINTS ONLY — weigh them, but do NOT hard-drop a correct, gate-passing candidate solely because an unverified antibody mentions it (the IR-4 lesson: an unverified antibody was empirically false):\n${IMMUNE}`,
      `If keep=true, set title, class="${c.key}", and hotspotFile to the primary target file.`,
    ].join('\n'),
    { model: 'sonnet', phase: 'Discover', label: `audit:${c.key}`, schema: VERDICT },
  ),
)

// Survivors carry their class + hotspot score (defect concentration).
const survivors = audited.filter(Boolean).filter((v) => v.keep && v.title).map((v) => ({
  title: v.title, class: v.class, file: v.hotspotFile || '', score: scoreFor(v.hotspotFile),
}))
log(`forest: ${survivors.length} survivor(s) across ${CLASSES.length} classes`)
if (!survivors.length) {
  return { action: 'nothing_to_do', survivors: 0 }
}

// Lexicographic CLASS LADDER: the highest-priority class with a survivor wins
// (evidence: a SapFix-style ordered ladder beats a blended numeric score). Within
// it, pre-rank by hotspot score; synth applies roadmap-fit (GOALS Part B) on top.
let chosenClass = null
for (const c of CLASSES) { if (survivors.some((s) => s.class === c.key)) { chosenClass = c.key; break } }
const pool = survivors.filter((s) => s.class === chosenClass).sort((a, b) => b.score - a.score).slice(0, 5)
log(`class ladder → "${chosenClass}" (${pool.length} candidate(s); top hotspot score ${pool[0]?.score ?? 0})`)

// ---- Synthesize: Opus picks ONE from the class-filtered, hotspot-ranked pool ----
phase('Synthesize')
const pick = await agent(
  [
    `You are the synthesis root. The work-class for this window is ALREADY chosen by the priority ladder: "${chosenClass}". Do not switch classes.`,
    OBJECTIVE_MODE
      ? `THIS WINDOW IS DEDICATED TO A SPECIFIC OBJECTIVE — do NOT substitute any other work:\n${PRIMARY_OBJECTIVE}\nIf the chosen class is "objective", your pick MUST implement exactly this; if it is already fully implemented, return autonomous=false (a dry window is correct — never pad with unrelated cleanup). If the chosen class is "signal-fix", a reproduced red is preempting the objective this window — fix the red.`
      : '',
    `Candidates in this class, pre-ranked by hotspot score (defect concentration; higher = more defect-prone):`,
    pool.map((s) => `- [hotspot ${s.score}] ${s.title} (file: ${s.file || 'n/a'})`).join('\n'),
    `Pick the SINGLE best one. Default to the higher hotspot score UNLESS GOALS.md Part B roadmap weighting clearly favors a lower-scored candidate — then justify it in valueRationale.`,
    `Roadmap weighting (GOALS.md Part B):\n${GOALS}`,
    `DROP any candidate already done or matching a VERIFIED antibody:\n${DONE}\n${IMMUNE}`,
    `If, after dropping, nothing genuinely valuable AND verifiable remains, return autonomous=false with title="(dry window — no gate-passing candidate)" and empty instructions. Abstaining is the CORRECT outcome; never force a pick.`,
    `Otherwise write exact implementation instructions INCLUDING the verification that will PROVE it (the red→green test, the measurable coverage delta, or the newly-passing build/lint). Set class="${chosenClass}", hotspotScore to the chosen candidate's score, valueRationale (one line: why this, tied to hotspot + roadmap), and delta (REQUIRED: concrete description of the measured improvement gate: which test goes red→green, exact coverage delta % with before/after numbers, or which named mutant is killed). No delta ⇒ dry window.`,
    WEB_RULE,
    `Never touch deploy config, secrets, CI/.github, Dockerfile, tsconfig, vitest.config, or unrelated files. Keep the diff TIGHT — reviewer attention is the scarce resource.`,
    scopeRule ? `${scopeRule} Drop only candidates that touch the forbidden infra set; if nothing reasonable remains, return autonomous=false.` : '',
  ].join('\n'),
  { model: 'opus', phase: 'Synthesize', label: 'synth', schema: PICK },
)
if (!pick || pick.autonomous === false || pick.risk !== 'low') {
  return { action: 'skipped_risky', pick, chosenClass }
}

// DETERMINISTIC INFRA GATE (defense in depth, pre-execute). Prose rules are
// advisory — an LLM synth has ignored them. This is the cheap early cut BEFORE the
// expensive executor/verify stages, but it ONLY blocks the dependency/build/CI/
// secret infra set (package.json, lockfiles, .github, Dockerfile, tsconfig,
// vitest.config, .env, deploy). Out-of-SCOPE-but-reasonable work is allowed — being
// proactive beyond a strict path is fine; touching infra is not (IR-8).
{
  const files = (pick.files || []).map((f) => String(f))
  const infra = files.filter((f) => FORBIDDEN_RE.test(f))
  if (infra.length) {
    log(`INFRA GATE: rejecting pick "${pick.title}" — touches human-owned infra: ${infra.join(', ')}`)
    return { action: 'out_of_scope', pick, chosenClass, forbidden: infra }
  }
}

// DETERMINISTIC OBJECTIVE GATE (defense in depth, pre-execute). When the driver set a
// PRIMARY_OBJECTIVE, the ONLY legal picks are implementing that objective ('objective')
// or preempting with a reproduced red ('signal-fix'). Anything else means the synth
// drifted to invented work despite the collapsed class set — reject it to a dry window
// rather than commit trivia. This is the structural guarantee that the "#1" failure mode
// (mesh ignores the steer → trivia, driver must rescue) CANNOT recur: with an objective
// set, the mesh implements it or abstains; it can never hand back busywork.
if (OBJECTIVE_MODE && pick.class !== 'objective' && pick.class !== 'signal-fix') {
  log(`OBJECTIVE GATE: rejecting pick "${pick.title}" (class=${pick.class}) — a primary objective is set; only 'objective' or 'signal-fix' may land. Abstaining (dry).`)
  return { action: 'off_objective', pick, chosenClass, objective: PRIMARY_OBJECTIVE }
}

// ---- Execute: Opus executor in an ISOLATED WORKTREE ----
phase('Execute')
const fix = await agent(
  [
    `Implement this improvement in your isolated worktree checkout of the repo.`,
    `Title: ${pick.title}`,
    `Instructions: ${pick.instructions}`,
    `Target files (guide): ${(pick.files || []).join(', ') || 'as needed'}`,
    `CRITICAL FIRST STEP — base your branch on the '${BASE}' tip, not main. Use '${BASE}' VERBATIM —`,
    `do NOT substitute another branch (e.g. auto/integration) even if the task text mentions one. The`,
    `isolated worktree forks from main (stale), causing duplicate-helper conflicts (IR-9). BEFORE editing, run:`,
    `    git fetch origin --quiet && git checkout -B auto/<timestamp>-<short-slug> origin/${BASE}`,
    `so your branch starts from the cumulative '${BASE}' tip and builds on what's already there.`,
    WEB_RULE,
    `Then make a focused, correct change and ADD/STRENGTHEN TESTS for it (tests matter more than the change).`,
    `Then: stage ONLY your changed paths, commit with a clear message, and 'git push -u origin <branch>'.`,
    `NEVER touch main (the human promotes integration→main). NEVER deploy. Keep the diff tight. Report the`,
    `branch name, whether push succeeded, a one-paragraph summary + the tests you added, and DELTA (REQUIRED):`,
    `  the MEASURED improvement gate that proves this works: e.g. "test X now passes red→green", "coverage on`,
    `  hotspot-file.ts increased 34% → 56% (+22pp)", or "mutant #7 (null-deref) now killed". This delta is the`,
    `  proof a change is not speculative — it gates whether the change lands.`,
    scopeRule ? `${scopeRule} Prefer editing within \`${SCOPE}\`; a related adjacent file is OK if it's the right fix. NEVER edit the forbidden infra set — if the task needs that, make NO edits and report changed=false with the reason.` : '',
  ].join('\n'),
  { model: 'opus', phase: 'Execute', label: 'executor', isolation: 'worktree', schema: FIX },
)
if (!fix || !fix.changed) {
  return { action: 'no_changes', pick, fix }
}

// ---- Verify: Sonnet tester + Opus skeptic (adversarial) ----
phase('Verify')
const [test, skeptic] = await parallel([
  () => agent(
    [
      `Independently verify branch ${fix.branch || '(the pushed auto/* branch)'} with the EXACT gate.`,
      `Do NOT trust the executor's self-report — agents have shipped false greens. Verify in a THROWAWAY`,
      `git worktree so you never disturb the driver's checkout:`,
      `    git fetch origin --quiet`,
      `    WT="$(mktemp -d)/verify"; git worktree add --force "$WT" "${fix.branch || 'FETCH_HEAD'}"`,
      `    ( cd "$WT" && ${GATE} ); rc=$?`,
      `    git worktree remove --force "$WT" 2>/dev/null || true`,
      `The gate (\`${GATE}\`) is the single source of truth. For ci-gate.sh that means tsc -b + server`,
      `tsc + eslint + test:coverage (catches the IR-7 type errors 'tsc --noEmit' misses) + cargo when Rust`,
      `changed; for engine-gate.mjs it means every engine file parses under its real loader (workflow-wrap`,
      `+ node --check + bash -n + json). Run any sibling tests the change touches too.`,
      `REGRESSION GUARD (V1.2): Report BOTH dimensions distinctly:`,
      `  • passToPass: boolean — did the PRE-EXISTING engine test suite stay green? (PASS→PASS, no regressions)`,
      `  • failToPass: boolean|string — did the NEW tests added by the change go red→green? (FAIL→PASS on the new test)`,
      `  • ok: aggregate — true ONLY if BOTH passToPass=true AND failToPass=true/non-empty.`,
      `A change that makes the new test pass but silently breaks a pre-existing test is NOT ok.`,
      `On failure, put the failing command + first errors in findings. Set verdict to your summary.`,
    ].join('\n'),
    { model: 'sonnet', phase: 'Verify', label: 'tester', schema: CHECK },
  ),
  () => agent(
    [
      `You are an adversarial skeptic who did NOT write this change: "${pick.title}".`,
      `Summary: ${fix.summary}`,
      `Distinguish TWO separate judgements (do not conflate them):`,
      `  • plausible = does the gate pass / do the tests go green on their face? (a low bar)`,
      `  • valid     = is the change SEMANTICALLY CORRECT and are the tests MEANINGFUL`,
      `                (they exercise the real behavior, not rubber-stamp the implementation)?`,
      `Evidence [Passerine @ Google]: a patch that passes the bug's test is merely plausible;`,
      `semantic correctness is a separate, strictly-lower number. GREEN IS NOT CORRECT.`,
      `Find the single weakest link — correctness, test meaningfulness, regression risk. Be specific.`,
      `Set valid=true ONLY if you can give a concrete validityRationale for why it is genuinely`,
      `correct; if a green gate is the ONLY evidence, that is plausible=true, valid=false. When in`,
      `doubt, valid=false. Also set ok (back-compat) = valid. verdict = your one-line judgement.`,
    ].join('\n'),
    { model: 'opus', phase: 'Verify', label: 'skeptic', schema: SKEPTIC },
  ),
])

return {
  action: 'branch_created',
  pick,
  branch: fix.branch,
  pushed: fix.pushed,
  summary: fix.summary,
  testsAdded: fix.testsAdded,
  test,
  skeptic,
  fix,
  // V1.1: confirm on VALIDITY, not a green gate alone.
  // V1.2: regression guard (PASS_TO_PASS + FAIL_TO_PASS) is a first-class gate.
  // V1.3: measured delta (fix.delta) is required — plausible≠valid≠assured-improvement.
  confirmed: isConfirmed({ test, skeptic, fix }),
}
