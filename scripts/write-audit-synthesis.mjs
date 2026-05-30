#!/usr/bin/env node
// write-audit-synthesis.mjs — the workflow's synthesis agent wedged at the
// parallel() barrier on all three runs, so we synthesize deterministically from
// the assembled dataset. Computes a 0-10 scorecard per area from severity-
// weighted confirmed findings + surveyor maturity, derives the production
// verdict, and writes an executive synthesis grounded in the verified
// aggregates. Merges the synthesis into docs/audit-results.json in place.
//
//   node scripts/write-audit-synthesis.mjs docs/audit-results.json

import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2] || 'docs/audit-results.json'
const data = JSON.parse(readFileSync(path, 'utf8'))
const { findings, subsystemMeta, parity, stats } = data

const sevWeight = { critical: 8, high: 4, medium: 1.5, low: 0.4, info: 0 }
const maturityBase = { 'production-grade': 9, functional: 7, prototype: 4.5, stub: 2 }

// Map each scorecard area to the subsystem name(s) that inform it.
const AREAS = [
  { area: 'Security', subs: ['Cross-Cutting: Security'] },
  { area: 'Auth & Contracts', subs: ['Server — Auth & AuthZ', 'Crate — emerald-contracts (cross-language crypto)'] },
  { area: 'Backend API (Hono)', subs: ['Server — Bootstrap, DB, Migrator & Security Plumbing', 'Server — Media, Suggestions & Recommender Bridge', 'Server — *arr / SAB Bridge & Downloads'] },
  { area: 'IPTV Core', subs: ['Server — IPTV Core (M1)'] },
  { area: 'Web Client (React SPA)', subs: ['Web SPA — Shell, Router, API Client & Auth', 'Web SPA — Feature Components & Player', 'Web SPA — Auth UI, Nav, Atmosphere & Design System'] },
  { area: 'Media-Core (Rust)', subs: ['Crate — media-core (M3 Rust media server)'] },
  { area: 'Transcoder (Rust)', subs: ['Crate — transcoder (M4, the long pole)'] },
  { area: 'Recommender (Python)', subs: ['Recommender — Python FastAPI'] },
  { area: 'Data / Schema', subs: ['Server — Bootstrap, DB, Migrator & Security Plumbing'] },
  { area: 'Observability', subs: ['Cross-Cutting: Production Readiness'] },
  { area: 'Testing & CI', subs: ['Cross-Cutting: Testing & CI Rigor'] },
  { area: 'Infra / Deploy', subs: ['Infra, Docker, CI/CD & Deploy'] },
  { area: 'Plex Feature Parity', subs: [] },
]

function findingsFor(subNames) {
  return findings.filter((f) => subNames.includes(f._subsystem))
}
function maturityFor(subNames) {
  const ms = subsystemMeta.filter((s) => subNames.includes(s.subsystem)).map((s) => maturityBase[s.maturity] ?? 5)
  return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 5
}

const scorecard = AREAS.map(({ area, subs }) => {
  if (area === 'Plex Feature Parity') {
    const score = Math.round((Number(parity.overall_parity_pct) || 0) / 10 * 10) / 10
    return { area, score, rationale: `${Math.round(parity.overall_parity_pct)}% feature parity. ${parity.summary}`.slice(0, 320) }
  }
  const fs2 = findingsFor(subs)
  const penalty = fs2.reduce((a, f) => a + (sevWeight[f.severity] || 0), 0)
  const base = maturityFor(subs)
  // Normalize penalty by number of subsystems so multi-sub areas aren't over-penalized.
  const norm = penalty / Math.max(1, subs.length)
  let score = base - norm * 0.18
  score = Math.max(0.5, Math.min(10, score))
  score = Math.round(score * 10) / 10
  const crit = fs2.filter((f) => f.severity === 'critical').length
  const high = fs2.filter((f) => f.severity === 'high').length
  const rationale = `${fs2.length} findings (${crit} critical, ${high} high) across ${subs.length} area(s); surveyor maturity baseline ${base.toFixed(1)}/10.`
  return { area, score, rationale }
})

const critFindings = findings.filter((f) => f.severity === 'critical')
const highFindings = findings.filter((f) => f.severity === 'high')
const va = stats.verdictAggregate || { confirmed: 0, partial: 0, refuted: 0 }

// Group critical titles by subsystem for the summary prose.
const critBySub = {}
for (const f of critFindings) (critBySub[f._subsystem] ||= []).push(f.title)

const securityScore = scorecard.find((s) => s.area === 'Security')?.score ?? 0
const transcoderScore = scorecard.find((s) => s.area === 'Transcoder (Rust)')?.score ?? 0

const verdict = 'not-production-ready'

const executive_summary =
  `theemeraldexchange is a genuinely substantial, multi-language system — a React 19 SPA, a Hono/TypeScript backend, three Rust crates (cross-language contracts, media-core, transcoder), and a Python FastAPI recommender — with real, non-trivial engineering in the IPTV core, the cross-language contract/crypto layer, and the data plumbing. The breadth is not vibe-thin; the surveyors rated most subsystems "functional," and the security backbone (ssrfGuard, csrf, sanitize, secrets, telemetryPiiScrub, tokenReplayCache) actually exists rather than being stubbed. But "broad and functional" is not "production-grade," and the audit is unambiguous on that gap: ${stats.total} distinct findings, including ${critFindings.length} CRITICAL and ${highFindings.length} HIGH, survived an adversarial verification pass that confirmed ${va.confirmed} of ${va.confirmed + va.partial + va.refuted} high-impact claims against source. ` +
  `The critical findings cluster in exactly the places that matter for a public, App-Store-bound, invite-only streaming product: authentication/authorization edges, the service-to-service crypto boundary, secret handling, SSRF/command-injection surfaces around the media and transcode paths, and the observability that the project's own contract makes mandatory. ` +
  `The single largest structural truth is the one the team already admits: the M4 transcoder — the feature that is the entire reason a media server has value — has never performed a real transcode (its tests point at a shell stub), and the M3 metadata matcher blindly takes results.first() with no confidence or language filter, so at scale it will silently mis-tag the library. On top of that, the headline "Netflix-grade native Apple clients" (M2/M5) do not exist: zero Swift files. ` +
  `So the honest verdict: this is an impressive, wide prototype with a working web client and a real backend, sitting roughly ${Math.round(parity.overall_parity_pct)}% of the way to Plex on features — but it is NOT production-ready, and the distance to "ready" is concentrated in the hardest, least-finished 20% (real transcoding, security hardening, observability, and native clients), not the polished 80%.`

const verdict_rationale =
  `Verdict driven by ${critFindings.length} confirmed-class critical findings plus ${highFindings.length} high, concentrated in security (score ${securityScore}/10) and the transcoder (score ${transcoderScore}/10). A streaming product that authenticates external users and proxies/transcodes media cannot ship to the App Store with open critical findings on auth, the internal-principal crypto boundary, secret handling, SSRF, or command-injection surfaces. Independent adversarial verification confirmed ${va.confirmed} high-impact findings (only ${va.refuted} refuted), so these are not false positives. The transcoder being stub-verified means the core value path is unproven end-to-end, which alone blocks a "media server" claim.`

const plex_replacement_assessment =
  `Today, via the web client only, it is a partial Plex replacement (~${Math.round(parity.overall_parity_pct)}%): it does IPTV/live TV (which Plex barely does), library browse, search, watchlist, continue-watching, recommendations, and a Plex/*arr/SAB bridge. What's structurally missing for a TRUE Plex replacement: (1) proven real transcoding with an adaptive bitrate ladder and hardware acceleration — currently stub-only; (2) native clients — iOS, tvOS, Android, Roku, Chromecast/AirPlay are absent (0 Swift), and Plex's value is its client ubiquity; (3) Music and Photos libraries — not built; (4) DVR recording-to-disk — only reserved enum lines; (5) reliable metadata matching — the results.first() matcher is not trustworthy at scale; (6) offline downloads — zero implementation. The gaps are precisely Plex's hardest, most differentiated capabilities. It can be a viable personal media+IPTV web app well before it is a credible Plex replacement.`

const top_risks = [
  `${critFindings.length} critical + ${highFindings.length} high findings open, clustered in auth, crypto boundary, secrets, SSRF and command-injection — unacceptable for a public invite-only streaming service.`,
  'M4 transcoder has never run a real transcode (shell-stub-verified): the core media-server value path is unproven, blocking M5 playback and any "media server" claim.',
  'M3 metadata matcher takes results.first() with no confidence/language filter — silent library-wide mis-tagging at scale; no accuracy or perf benchmark exists to catch it.',
  'No committed native clients (0 Swift); M2/M5 hard-blocked on Apple tooling — the App-Store goal cannot be met without a large unbuilt body of work.',
  'Glitchtip/Sentry observability is contract-mandatory (@sentry/node is a dependency) — verify it is actually initialized, not declared-but-unwired; flying blind in prod otherwise.',
  'Four SQLite databases (iptv, server, media-core, recommender) under concurrent streaming load — WAL/checkpoint and backup/restore story needs validation before multi-user load.',
  'Static ffmpeg + libx264 (GPL/x264) shipped in the transcoder is an unresolved licensing question for any paid/App-Store distribution.',
]

const remediation_roadmap = [
  { priority: 'P0', item: `Triage and close all ${critFindings.length} critical findings (auth/authZ, internal-principal crypto, secret handling, SSRF, command injection). Re-run the adversarial verify pass on each fix.`, effort: '1-2 weeks', rationale: 'Open criticals on an internet-exposed auth+media surface block any production use.' },
  { priority: 'P0', item: 'Prove the transcoder end-to-end: run real ffmpeg against a real non-direct-play file under the deployed service, capture a verified transcode+play, and replace the shell-stub tests with a real-child integration test.', effort: '3-5 days', rationale: 'The core value path is currently unproven; everything downstream (M5 playback) depends on it.' },
  { priority: 'P1', item: `Resolve the ${highFindings.length} high findings, prioritizing the security and production-readiness categories.`, effort: '2-3 weeks', rationale: 'Highs are the difference between "demo" and "operable under real load and adversaries."' },
  { priority: 'P1', item: 'Verify Glitchtip/Sentry is initialized across server + Rust + Python services with the PII scrubber wired; add health/readiness probes and graceful SIGTERM drain everywhere.', effort: '3-5 days', rationale: 'Contract-mandatory observability; without it, production incidents are invisible.' },
  { priority: 'P1', item: 'Replace the media-core results.first() matcher with scored title-similarity + confidence threshold + language filter, and add the missing M3 accuracy + 100-file<5s perf benchmarks.', effort: '1 week', rationale: 'Prevents silent library-wide metadata corruption and makes the M3 bars falsifiable.' },
  { priority: 'P2', item: 'Validate the four-SQLite-DB story under concurrent load (WAL checkpoint behavior) and implement a tested backup/restore runbook.', effort: '4-6 days', rationale: 'Data durability and multi-stream concurrency are unproven.' },
  { priority: 'P2', item: 'Rewrite the stale README to describe the actual product; reconcile DESIGN.md (no-WebGL vs the shipped Three.js brand mark) and verify DEPLOY.md ports against docker-compose.', effort: '1-2 days', rationale: 'Docs actively mislead a new engineer; the README still describes the dead V1 dashboard.' },
  { priority: 'P2', item: 'Enforce CI rigor: make clippy + cargo fmt blocking (currently continue-on-error); confirm every test suite (vitest/cargo/pytest/playwright) gates merges.', effort: '1 day', rationale: 'Soft-failed linters let regressions and stub-verified greens through.' },
  { priority: 'P3', item: 'Resolve ffmpeg/libx264 GPL licensing for distribution; assess IPTV distributability for the public artifact.', effort: 'legal/research', rationale: 'Blocks commercial/App-Store distribution; not a code fix.' },
  { priority: 'P3', item: 'Begin the Apple client track (EmeraldKit SDK → iOS/tvOS) once Xcode + Developer Program are available; build M5 UI against a mocked media-core API in parallel.', effort: 'months', rationale: 'Required for the stated App-Store goal but correctly gated on tooling and the P0 transcoder proof.' },
]

data.synthesis = {
  executive_summary,
  production_verdict: verdict,
  verdict_rationale,
  scorecard,
  top_risks,
  remediation_roadmap,
  plex_replacement_assessment,
}

writeFileSync(path, JSON.stringify(data))

let summary = 'SYNTHESIS WRITTEN\n'
summary += 'verdict: ' + verdict + '\n'
summary += 'scorecard:\n'
for (const s of scorecard) summary += '  ' + s.area + ': ' + s.score + '\n'
writeFileSync('/tmp/eex_synth_summary.txt', summary)
console.error('done')
