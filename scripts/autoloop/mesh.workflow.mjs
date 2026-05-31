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

const A = args || {}
const DONE = (A.doneTitles || []).map((t) => `- ${t}`).join('\n') || '(none yet)'
const BRANCHES = A.existingBranches || '(none)'
const IMMUNE = A.immuneRules || '(no antibodies yet)'

// Areas the forest scans. Each is a narrow, read-only Haiku probe.
const AREAS = [
  'open items in docs/PRODUCTION-READINESS-2026-05-30.md',
  'M1.5/M1 loose ends in docs/ROADMAP-STATUS.md (e.g. /api/version schema block, .gitattributes, untested UI)',
  'M3 media-core measurement gaps (perf <5s/100 files, >=95% match accuracy harness)',
  'dependency hygiene (unpinned base images, missing lockfiles, audit gaps)',
  'test coverage holes in server/ and src/',
  'type-safety / dead-code / lint debt',
]

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
  },
}

const PICK = {
  type: 'object',
  required: ['title', 'instructions', 'autonomous', 'risk'],
  properties: {
    title: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    instructions: { type: 'string' },
    autonomous: { type: 'boolean' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
}

const FIX = {
  type: 'object',
  required: ['changed', 'summary'],
  properties: {
    changed: { type: 'boolean' },
    branch: { type: 'string' },
    pushed: { type: 'boolean' },
    summary: { type: 'string' },
    testsAdded: { type: 'string' },
    error: { type: 'string' },
  },
}

const CHECK = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    findings: { type: 'string' },
    verdict: { type: 'string' },
  },
}

// ---- Discover: forest of Haiku leaves → Sonnet boolean audit (pipeline) ----
phase('Discover')
const audited = await pipeline(
  AREAS,
  (area) => agent(
    [
      `You are a read-only discovery leaf in an autonomous improvement loop for this repo.`,
      `Scan ONLY this area: ${area}.`,
      `Propose up to 3 concrete improvements that are autonomous (code/tests/docs/deps — no Apple, no hardware, no deploy, no secrets), and mark each one's risk.`,
      `Do NOT propose anything already done:\n${DONE}`,
      `Avoid known dead-ends / honor these antibodies:\n${IMMUNE}`,
      `Existing in-flight branches: ${BRANCHES}`,
    ].join('\n'),
    { model: 'haiku', phase: 'Discover', label: `scan`, schema: CAND },
  ),
  // Sonnet boolean-audit each candidate set down to the survivors.
  (found, area) => agent(
    [
      `You are a strict auditor. Here are candidate improvements for "${area}":`,
      JSON.stringify(found.candidates || []),
      `Return keep=true ONLY if the single best one is real, correct, genuinely valuable, low-risk, autonomous, and not already done (${DONE}).`,
      `Otherwise keep=false. If keep=true, set title to that single best candidate's title.`,
    ].join('\n'),
    { model: 'sonnet', phase: 'Discover', label: `audit`, schema: VERDICT },
  ),
)

const survivors = audited.filter(Boolean).filter((v) => v.keep && v.title).map((v) => v.title)
log(`forest: ${survivors.length} survivor(s) from ${AREAS.length} areas`)
if (!survivors.length) {
  return { action: 'nothing_to_do', survivors: 0 }
}

// ---- Synthesize: Opus picks the single highest-value item ----
phase('Synthesize')
const pick = await agent(
  [
    `You are the synthesis root of an autonomous improvement loop. Survivor improvement titles:`,
    survivors.map((s) => `- ${s}`).join('\n'),
    `Pick the SINGLE highest value × lowest risk one. Read the repo as needed to write precise instructions.`,
    `It MUST be autonomous and low-risk. Produce exact implementation instructions INCLUDING the tests to add/strengthen (tests matter more than the change).`,
    `Never touch deploy config, secrets, or unrelated files.`,
  ].join('\n'),
  { model: 'opus', phase: 'Synthesize', label: 'synth', schema: PICK },
)
if (!pick || pick.autonomous === false || pick.risk !== 'low') {
  return { action: 'skipped_risky', pick }
}

// ---- Execute: Opus executor in an ISOLATED WORKTREE ----
phase('Execute')
const fix = await agent(
  [
    `Implement this improvement in your isolated worktree checkout of the repo.`,
    `Title: ${pick.title}`,
    `Instructions: ${pick.instructions}`,
    `Target files (guide): ${(pick.files || []).join(', ') || 'as needed'}`,
    `Make a focused, correct change and ADD/STRENGTHEN TESTS for it.`,
    `Then: create branch auto/<timestamp>-<short-slug>, stage only your changed paths, commit with a clear message, and 'git push -u origin <branch>'.`,
    `NEVER touch main. NEVER deploy. Keep the diff tight. Report the branch name, whether push succeeded, and a one-paragraph summary + the tests you added.`,
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
      `On branch ${fix.branch || '(the pushed auto/* branch)'}, run the fast gate for what changed:`,
      `npm run lint; npx tsc --noEmit; npx tsc -p server/tsconfig.json; npm run test (and cargo clippy/test if Rust changed).`,
      `Report ok=true only if the relevant gate passes. Summarize failures if any.`,
    ].join('\n'),
    { model: 'sonnet', phase: 'Verify', label: 'tester', schema: CHECK },
  ),
  () => agent(
    [
      `You are an adversarial skeptic who did NOT write this change: "${pick.title}".`,
      `Summary: ${fix.summary}`,
      `Find the single weakest link — is the change correct, are the tests meaningful or do they just rubber-stamp the code, any regression risk? Be specific.`,
      `Return ok=true only if it genuinely holds up; verdict = your one-line judgement.`,
    ].join('\n'),
    { model: 'opus', phase: 'Verify', label: 'skeptic', schema: CHECK },
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
  confirmed: !!(test && test.ok && skeptic && skeptic.ok),
}
