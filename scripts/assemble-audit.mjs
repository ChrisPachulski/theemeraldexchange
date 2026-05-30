#!/usr/bin/env node
// assemble-audit.mjs — reconstruct the audit results object from the workflow
// journal (the synthesis agent wedged at the barrier 3x, so we rebuild the
// aggregate deterministically here). Enriches each finding with its adversarial
// verdict, computes stats, and writes docs/audit-results.json WITHOUT a
// synthesis block (added in a second step). Pass the synthesis JSON path as
// argv[2] to merge it in.
//
//   node scripts/assemble-audit.mjs <journal.jsonl> [synthesis.json]

import { readFileSync, writeFileSync } from 'node:fs'

const jlPath = process.argv[2]
const synthPath = process.argv[3]
const lines = readFileSync(jlPath, 'utf8').trim().split('\n').filter(Boolean)

const results = []
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.type === 'result' && e.result) results.push({ key: e.key, agentId: e.agentId, r: e.result })
}

const dossiers = []
const verdicts = []
let parity = null
let workflowSynth = null
for (const { r } of results) {
  if (r && r.production_verdict && r.scorecard) workflowSynth = r
  else if (r && Array.isArray(r.features) && typeof r.overall_parity_pct === 'number') parity = r
  else if (r && r.verdict && r.corrected_severity !== undefined) verdicts.push(r)
  else if (r && r.subsystem && Array.isArray(r.findings)) dossiers.push(r)
}

// Flatten findings with stable ids matching the workflow's scheme (di-fi).
const allFindings = []
dossiers.forEach((d, di) => {
  ;(d.findings || []).forEach((f, fi) => {
    allFindings.push({ ...f, _subsystem: d.subsystem, id: `${di}-${fi}` })
  })
})

// Verdicts in the journal are bare objects (no finding id). The workflow paired
// them by array index within the toVerify filter. We can't perfectly re-pair
// without the prompt, so match heuristically: a verdict enriches a finding when
// we process them in the SAME order the workflow built toVerify (critical/high,
// or any security). Build that ordered list identically.
const toVerify = allFindings.filter(
  (f) => f.severity === 'critical' || f.severity === 'high' || f.category === 'security',
)
// Pair by position (verdicts were pushed in completion order, not toVerify
// order — so positional pairing is approximate). To be safe, we DON'T fabricate
// a 1:1 mapping; instead we attach verdicts as an aggregate signal and keep
// each finding's original severity as effective, but mark whether the verify
// pass broadly confirmed findings.
const sevRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 }

const enriched = allFindings.map((f) => ({
  ...f,
  verification_status: 'unverified',
  verification_confidence: null,
  verification_reasoning: null,
  corrected_severity: null,
  effective_severity: f.severity,
}))

// Verdict aggregate (for the methodology footnote + honesty about the pairing).
const verdictAgg = { confirmed: 0, partial: 0, refuted: 0 }
for (const v of verdicts) {
  if (v.verdict === 'confirmed') verdictAgg.confirmed++
  else if (v.verdict === 'partial') verdictAgg.partial++
  else if (v.verdict === 'refuted') verdictAgg.refuted++
}

const bySeverity = {}
const byCategory = {}
const bySubsystem = {}
for (const f of enriched) {
  bySeverity[f.effective_severity] = (bySeverity[f.effective_severity] || 0) + 1
  byCategory[f.category] = (byCategory[f.category] || 0) + 1
  bySubsystem[f._subsystem] = (bySubsystem[f._subsystem] || 0) + 1
}

const subsystemMeta = dossiers.map((d) => ({
  subsystem: d.subsystem,
  purpose: d.purpose,
  maturity: d.maturity,
  maturity_rationale: d.maturity_rationale,
  what_works: d.what_works,
  plex_parity_notes: d.plex_parity_notes,
  files_reviewed_count: (d.files_reviewed || []).length,
  finding_count: (d.findings || []).length,
}))

let synthesis = null
if (synthPath) {
  synthesis = JSON.parse(readFileSync(synthPath, 'utf8'))
} else if (workflowSynth) {
  synthesis = workflowSynth
}

const out = {
  subsystemMeta,
  dossiers,
  parity,
  findings: enriched,
  synthesis,
  stats: {
    total: enriched.length,
    bySeverity,
    byCategory,
    bySubsystem,
    verdictAggregate: verdictAgg,
    verifiedCount: toVerify.length,
    note: 'Synthesis agent wedged at the parallel() barrier 3x; verdicts captured in aggregate (113 adversarial checks: ' +
      `${verdictAgg.confirmed} confirmed / ${verdictAgg.partial} partial / ${verdictAgg.refuted} refuted). ` +
      'Per-finding verdict pairing not reconstructable from the journal, so findings retain surveyor severity.',
  },
}

writeFileSync('docs/audit-results.json', JSON.stringify(out))

// Console summary for the operator.
const sevLine = ['critical', 'high', 'medium', 'low', 'info']
  .map((s) => `${s}:${bySeverity[s] || 0}`)
  .join('  ')
console.log('=== ASSEMBLED ===')
console.log('subsystems:', subsystemMeta.length, '| findings:', enriched.length)
console.log('severity  ', sevLine)
console.log('verdicts  ', `confirmed:${verdictAgg.confirmed} partial:${verdictAgg.partial} refuted:${verdictAgg.refuted} (of ${verdicts.length})`)
console.log('parity    ', parity ? Math.round(parity.overall_parity_pct) + '%' : 'MISSING')
console.log('synthesis ', synthesis ? 'present' : 'NEEDS SELF-WRITE')
console.log('wrote docs/audit-results.json')

// Emit per-subsystem maturity + top findings for the operator to write synthesis.
console.log('\n=== SUBSYSTEM MATURITY ===')
for (const s of subsystemMeta) {
  console.log(`[${s.maturity}] ${s.subsystem} — ${s.finding_count} findings`)
}
console.log('\n=== CRITICAL + HIGH FINDINGS ===')
const ch = enriched
  .filter((f) => f.severity === 'critical' || f.severity === 'high')
  .sort((a, b) => sevRank[b.severity] - sevRank[a.severity])
for (const f of ch) {
  console.log(`[${f.severity}] (${f.category}) ${f._subsystem} :: ${f.title} — ${f.file}${f.line ? ':' + f.line : ''}`)
}
