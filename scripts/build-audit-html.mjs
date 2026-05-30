#!/usr/bin/env node
// build-audit-html.mjs — render the exhaustive production+parity audit to a
// single self-contained HTML file. Consumes the JSON returned by the
// eex-prod-audit workflow.
//
//   node scripts/build-audit-html.mjs <results.json> <out.html> [generatedISO] [headSha]
//
// The output inlines the full dataset as a JSON island so future sessions can
// re-filter/re-render without re-running the workflow.

import { readFileSync, writeFileSync } from 'node:fs'

const [, , inPath, outPath, generatedISO, headSha] = process.argv
if (!inPath || !outPath) {
  console.error('usage: build-audit-html.mjs <results.json> <out.html> [generatedISO] [headSha]')
  process.exit(1)
}

const data = JSON.parse(readFileSync(inPath, 'utf8'))
const generated = generatedISO || 'unknown'
const head = headSha || 'unknown'

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const sevRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1, refuted: 0 }

const findings = (data.findings || []).slice().sort((a, b) => {
  const ra = sevRank[a.verification_status === 'refuted' ? 'refuted' : a.effective_severity] ?? 0
  const rb = sevRank[b.verification_status === 'refuted' ? 'refuted' : b.effective_severity] ?? 0
  return rb - ra
})
const synth = data.synthesis || {}
const parity = data.parity || {}
const stats = data.stats || {}
const subs = data.subsystemMeta || []

const effCount = {}
for (const f of findings) {
  const k = f.verification_status === 'refuted' ? 'refuted' : f.effective_severity
  effCount[k] = (effCount[k] || 0) + 1
}
const activeFindings = findings.filter((f) => f.verification_status !== 'refuted')

const verdictBadge = {
  'not-production-ready': ['NOT PRODUCTION-READY', 'crit'],
  prototype: ['PROTOTYPE', 'high'],
  'approaching-production': ['APPROACHING PRODUCTION', 'med'],
  'production-ready': ['PRODUCTION-READY', 'ok'],
}[synth.production_verdict] || [String(synth.production_verdict || 'UNKNOWN').toUpperCase(), 'med']

function scorecardRows() {
  return (synth.scorecard || [])
    .map((s) => {
      const score = Math.max(0, Math.min(10, Number(s.score) || 0))
      const pct = score * 10
      const tone = score >= 7.5 ? 'ok' : score >= 5 ? 'med' : score >= 3 ? 'high' : 'crit'
      return `<div class="score-row">
        <div class="score-name">${esc(s.area)}</div>
        <div class="score-bar"><span class="score-fill ${tone}" style="width:${pct}%"></span></div>
        <div class="score-num ${tone}">${score.toFixed(1)}</div>
        <div class="score-why">${esc(s.rationale)}</div>
      </div>`
    })
    .join('\n')
}

function roadmapRows() {
  const tone = { P0: 'crit', P1: 'high', P2: 'med', P3: 'low' }
  return (synth.remediation_roadmap || [])
    .map(
      (r) => `<tr>
      <td><span class="pill ${tone[r.priority] || 'low'}">${esc(r.priority)}</span></td>
      <td>${esc(r.item)}</td>
      <td class="nowrap muted">${esc(r.effort)}</td>
      <td class="muted">${esc(r.rationale)}</td>
    </tr>`
    )
    .join('\n')
}

function parityRows() {
  const tone = { complete: 'ok', partial: 'med', stub: 'high', missing: 'crit' }
  return (parity.features || [])
    .map(
      (f) => `<tr data-status="${esc(f.eex_status)}">
      <td class="muted">${esc(f.category)}</td>
      <td>${esc(f.feature)}</td>
      <td><span class="pill ${tone[f.eex_status] || 'low'}">${esc(f.eex_status)}</span></td>
      <td class="mono small">${esc(f.evidence)}</td>
      <td class="muted small">${esc(f.notes)}</td>
    </tr>`
    )
    .join('\n')
}

function subsystemCards() {
  const tone = { 'production-grade': 'ok', functional: 'med', prototype: 'high', stub: 'crit' }
  return subs
    .map((s) => {
      const works = (s.what_works || []).map((w) => `<li>${esc(w)}</li>`).join('')
      return `<div class="card">
        <div class="card-head">
          <h3>${esc(s.subsystem)}</h3>
          <span class="pill ${tone[s.maturity] || 'low'}">${esc(s.maturity)}</span>
        </div>
        <p class="muted small">${esc(s.purpose)}</p>
        <p class="small"><strong>Maturity:</strong> ${esc(s.maturity_rationale)}</p>
        <div class="meta-line small muted">${s.files_reviewed_count} files reviewed &middot; ${s.finding_count} findings</div>
        ${works ? `<details><summary>What works</summary><ul class="small">${works}</ul></details>` : ''}
        ${s.plex_parity_notes ? `<details><summary>Plex parity notes</summary><p class="small muted">${esc(s.plex_parity_notes)}</p></details>` : ''}
      </div>`
    })
    .join('\n')
}

function findingRows() {
  return findings
    .map((f, i) => {
      const eff = f.verification_status === 'refuted' ? 'refuted' : f.effective_severity
      const pill = eff === 'critical' ? 'crit' : eff === 'high' ? 'high' : eff === 'medium' ? 'med' : eff === 'refuted' ? 'refuted' : 'low'
      return `<tr class="f-row" data-sev="${esc(eff)}" data-cat="${esc(f.category)}" data-sub="${esc(f._subsystem)}" data-status="${esc(f.verification_status)}" data-i="${i}">
        <td><span class="pill ${pill}">${esc(eff)}</span></td>
        <td>${esc(f.title)}</td>
        <td class="muted small nowrap">${esc(f.category)}</td>
        <td class="muted small">${esc(f._subsystem)}</td>
        <td class="mono small">${esc(f.file)}${f.line ? ':' + esc(f.line) : ''}</td>
        <td class="status-cell small">${esc(f.verification_status)}${f.verification_confidence ? ` <span class="muted">(${esc(f.verification_confidence)})</span>` : ''}</td>
      </tr>
      <tr class="f-detail" data-for="${i}" hidden><td colspan="6">
        <div class="detail-grid">
          <div><span class="lbl">Description</span><p>${esc(f.description)}</p></div>
          <div><span class="lbl">Evidence</span><pre class="mono">${esc(f.evidence)}</pre></div>
          <div><span class="lbl">Recommendation</span><p>${esc(f.recommendation)}</p></div>
          ${f.verification_reasoning ? `<div><span class="lbl">Verifier verdict — ${esc(f.verification_status)}${f.corrected_severity ? ` &rarr; ${esc(f.corrected_severity)}` : ''}</span><p class="muted">${esc(f.verification_reasoning)}</p></div>` : ''}
        </div>
      </td></tr>`
    })
    .join('\n')
}

const cats = [...new Set(findings.map((f) => f.category))].sort()
const subNames = [...new Set(findings.map((f) => f._subsystem))].sort()

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>theemeraldexchange — Production &amp; Plex-Parity Audit</title>
<style>
  :root{
    --bg:oklch(0.16 0.012 158);--surface:oklch(0.20 0.014 158);--surface-2:oklch(0.24 0.016 158);
    --border:oklch(0.30 0.020 158);--text:oklch(0.94 0.008 158);--muted:oklch(0.70 0.012 158);
    --subtle:oklch(0.52 0.014 158);--em:oklch(0.62 0.180 158);--em-bg:oklch(0.30 0.080 158);
    --crit:oklch(0.62 0.18 25);--high:oklch(0.70 0.16 55);--med:oklch(0.80 0.14 95);
    --low:oklch(0.62 0.05 158);--ok:oklch(0.66 0.16 158);
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"SF Pro Text",Inter,sans-serif;-webkit-font-smoothing:antialiased}
  .mono{font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace}
  .small{font-size:.82rem}.muted{color:var(--muted)}.subtle{color:var(--subtle)}.nowrap{white-space:nowrap}
  a{color:var(--em)}
  .wrap{max-width:1180px;margin:0 auto;padding:0 24px}
  header.hero{padding:56px 0 28px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,var(--em-bg)10%,transparent 90%)}
  .eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:.72rem;color:var(--em)}
  h1{font-family:"Space Grotesk",ui-sans-serif,system-ui;font-weight:700;font-size:2.4rem;margin:.2em 0 .1em;letter-spacing:-.01em}
  h2{font-family:"Space Grotesk",ui-sans-serif,system-ui;font-size:1.5rem;margin:2.2em 0 .6em;letter-spacing:-.01em}
  h3{font-size:1.05rem;margin:0}
  .verdict{display:inline-flex;align-items:center;gap:10px;margin-top:14px;padding:10px 18px;border-radius:500px;font-weight:700;letter-spacing:.04em;border:1px solid var(--border)}
  .verdict.crit{background:color-mix(in oklab,var(--crit),transparent 80%);color:var(--crit)}
  .verdict.high{background:color-mix(in oklab,var(--high),transparent 82%);color:var(--high)}
  .verdict.med{background:color-mix(in oklab,var(--med),transparent 84%);color:var(--med)}
  .verdict.ok{background:color-mix(in oklab,var(--ok),transparent 82%);color:var(--ok)}
  .subhead{color:var(--muted);max-width:70ch;margin-top:10px}
  .statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-top:26px}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px}
  .stat .n{font-size:1.7rem;font-weight:700;font-family:"Space Grotesk",system-ui}
  .stat .l{font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:var(--subtle)}
  .stat.crit .n{color:var(--crit)}.stat.high .n{color:var(--high)}.stat.med .n{color:var(--med)}.stat.ok .n{color:var(--ok)}
  section{padding:6px 0}
  .prose{max-width:80ch;color:var(--text)}.prose p{margin:.7em 0;white-space:pre-wrap}
  .pill{display:inline-block;padding:2px 10px;border-radius:500px;font-size:.72rem;font-weight:600;letter-spacing:.03em;text-transform:uppercase;border:1px solid transparent}
  .pill.crit{background:color-mix(in oklab,var(--crit),transparent 82%);color:var(--crit);border-color:color-mix(in oklab,var(--crit),transparent 55%)}
  .pill.high{background:color-mix(in oklab,var(--high),transparent 84%);color:var(--high);border-color:color-mix(in oklab,var(--high),transparent 60%)}
  .pill.med{background:color-mix(in oklab,var(--med),transparent 86%);color:var(--med);border-color:color-mix(in oklab,var(--med),transparent 62%)}
  .pill.low{background:var(--surface-2);color:var(--muted);border-color:var(--border)}
  .pill.ok{background:color-mix(in oklab,var(--ok),transparent 84%);color:var(--ok);border-color:color-mix(in oklab,var(--ok),transparent 60%)}
  .pill.refuted{background:var(--surface-2);color:var(--subtle);border-color:var(--border);text-decoration:line-through}
  .score-row{display:grid;grid-template-columns:180px 1fr 46px;grid-template-areas:"name bar num" "why why why";gap:6px 14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
  .score-name{grid-area:name;font-weight:500}.score-bar{grid-area:bar;height:9px;background:var(--surface-2);border-radius:500px;overflow:hidden}
  .score-fill{display:block;height:100%;border-radius:500px}
  .score-fill.ok{background:var(--ok)}.score-fill.med{background:var(--med)}.score-fill.high{background:var(--high)}.score-fill.crit{background:var(--crit)}
  .score-num{grid-area:num;text-align:right;font-weight:700;font-family:"Space Grotesk",system-ui}
  .score-num.ok{color:var(--ok)}.score-num.med{color:var(--med)}.score-num.high{color:var(--high)}.score-num.crit{color:var(--crit)}
  .score-why{grid-area:why;color:var(--muted);font-size:.82rem}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--subtle);padding:8px 10px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg)}
  td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
  .f-row{cursor:pointer}.f-row:hover{background:var(--surface)}
  .detail-grid{display:grid;gap:14px;padding:6px 4px 14px;background:var(--surface);border-radius:12px}
  .lbl{font-size:.68rem;text-transform:uppercase;letter-spacing:.12em;color:var(--em);display:block;margin-bottom:3px}
  pre.mono{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px;overflow:auto;font-size:.78rem;white-space:pre-wrap;word-break:break-word;margin:0}
  .controls{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0;align-items:center;position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:5}
  .controls select,.controls input{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:7px 11px;font:inherit;font-size:.85rem}
  .controls input{flex:1;min-width:180px}
  .cardgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;margin-top:12px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:inset 0 1px 0 oklch(0.94 0.008 158/.05)}
  .card-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
  details{margin-top:8px}summary{cursor:pointer;color:var(--em);font-size:.82rem}
  ul{margin:.4em 0;padding-left:1.1em}li{margin:.2em 0}
  .gauge{display:flex;align-items:center;gap:18px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;margin-top:10px}
  .gauge .big{font-size:3rem;font-weight:700;font-family:"Space Grotesk",system-ui;color:var(--em)}
  .toc{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
  .toc a{padding:6px 13px;border:1px solid var(--border);border-radius:500px;text-decoration:none;color:var(--muted);font-size:.8rem}
  .toc a:hover{border-color:var(--em);color:var(--text)}
  footer{margin:60px 0 40px;padding-top:20px;border-top:1px solid var(--border);color:var(--subtle);font-size:.8rem}
  .risk{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin:8px 0}
</style>
</head>
<body>
<header class="hero"><div class="wrap">
  <div class="eyebrow">Production Readiness &amp; Plex-Parity Audit</div>
  <h1>theemeraldexchange</h1>
  <div class="verdict ${verdictBadge[1]}">${esc(verdictBadge[0])}</div>
  <p class="subhead">Exhaustive, adversarially-verified audit of the committed codebase on branch <span class="mono">m3-media-core</span> (HEAD <span class="mono">${esc(head)}</span>). Every subsystem deep-read in full; every high-impact finding independently re-verified against source.</p>
  <div class="statgrid">
    <div class="stat"><div class="n">${activeFindings.length}</div><div class="l">Active findings</div></div>
    <div class="stat crit"><div class="n">${effCount.critical || 0}</div><div class="l">Critical</div></div>
    <div class="stat high"><div class="n">${effCount.high || 0}</div><div class="l">High</div></div>
    <div class="stat med"><div class="n">${effCount.medium || 0}</div><div class="l">Medium</div></div>
    <div class="stat"><div class="n">${effCount.low || 0}</div><div class="l">Low</div></div>
    <div class="stat"><div class="n">${effCount.refuted || 0}</div><div class="l">Refuted</div></div>
    <div class="stat"><div class="n">${Math.round(Number(parity.overall_parity_pct) || 0)}%</div><div class="l">Plex parity</div></div>
    <div class="stat"><div class="n">${subs.length}</div><div class="l">Areas audited</div></div>
  </div>
  <nav class="toc">
    <a href="#summary">Executive Summary</a>
    <a href="#scorecard">Scorecard</a>
    <a href="#parity">Plex Parity</a>
    <a href="#roadmap">Remediation</a>
    <a href="#findings">All Findings</a>
    <a href="#subsystems">Subsystems</a>
  </nav>
</div></header>

<main class="wrap">

<section id="summary">
  <h2>Executive Summary</h2>
  <div class="prose"><p>${esc(synth.executive_summary)}</p></div>
  <h3 style="margin-top:1.4em">Verdict rationale</h3>
  <div class="prose"><p class="muted">${esc(synth.verdict_rationale)}</p></div>
  <h3 style="margin-top:1.4em">Is it a Plex replacement?</h3>
  <div class="prose"><p class="muted">${esc(synth.plex_replacement_assessment)}</p></div>
  ${(synth.top_risks || []).length ? `<h3 style="margin-top:1.4em">Top risks</h3>${synth.top_risks.map((r) => `<div class="risk">${esc(r)}</div>`).join('')}` : ''}
</section>

<section id="scorecard">
  <h2>Scorecard</h2>
  ${scorecardRows()}
</section>

<section id="parity">
  <h2>Plex Feature Parity</h2>
  <div class="gauge"><div class="big">${Math.round(Number(parity.overall_parity_pct) || 0)}%</div><div class="muted">${esc(parity.summary)}</div></div>
  ${(parity.critical_gaps || []).length ? `<h3 style="margin-top:1.2em">Critical gaps</h3><ul>${parity.critical_gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
  <div class="controls">
    <select id="parityFilter" onchange="filterParity()">
      <option value="">All statuses</option>
      <option value="complete">Complete</option>
      <option value="partial">Partial</option>
      <option value="stub">Stub</option>
      <option value="missing">Missing</option>
    </select>
  </div>
  <table id="parityTable">
    <thead><tr><th>Category</th><th>Feature</th><th>Status</th><th>Evidence</th><th>Notes</th></tr></thead>
    <tbody>${parityRows()}</tbody>
  </table>
</section>

<section id="roadmap">
  <h2>Remediation Roadmap</h2>
  <table>
    <thead><tr><th>Pri</th><th>Item</th><th>Effort</th><th>Rationale</th></tr></thead>
    <tbody>${roadmapRows()}</tbody>
  </table>
</section>

<section id="findings">
  <h2>All Findings <span class="muted small">(${findings.length} total, click a row to expand)</span></h2>
  <div class="controls">
    <select id="fSev" onchange="filterFindings()">
      <option value="">All severities</option>
      <option value="critical">Critical</option><option value="high">High</option>
      <option value="medium">Medium</option><option value="low">Low</option>
      <option value="info">Info</option><option value="refuted">Refuted</option>
    </select>
    <select id="fCat" onchange="filterFindings()">
      <option value="">All categories</option>
      ${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
    </select>
    <select id="fSub" onchange="filterFindings()">
      <option value="">All areas</option>
      ${subNames.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
    </select>
    <input id="fSearch" type="search" placeholder="Search title / file / evidence…" oninput="filterFindings()">
  </div>
  <table id="findingsTable">
    <thead><tr><th>Severity</th><th>Title</th><th>Category</th><th>Area</th><th>File</th><th>Verified</th></tr></thead>
    <tbody>${findingRows()}</tbody>
  </table>
</section>

<section id="subsystems">
  <h2>Subsystem Dossiers</h2>
  <div class="cardgrid">${subsystemCards()}</div>
</section>

</main>

<footer class="wrap">
  <p><strong>Methodology.</strong> 13 subsystem deep-reads + 5 cross-cutting dimension audits + a Plex feature-parity matrix, run as a parallel agent workflow over the full committed tree. Every critical/high/security finding was independently re-verified against source by an adversarial verifier (confirmed / partial / refuted). Refuted findings are retained but greyed out and struck through. Generated ${esc(generated)} from branch m3-media-core @ ${esc(head)}.</p>
  <p class="subtle">Stats: ${esc(JSON.stringify(stats))}</p>
</footer>

<script type="application/json" id="auditData">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>
function filterFindings(){
  var sev=document.getElementById('fSev').value, cat=document.getElementById('fCat').value,
      sub=document.getElementById('fSub').value, q=document.getElementById('fSearch').value.toLowerCase();
  document.querySelectorAll('#findingsTable tr.f-row').forEach(function(r){
    var ok=(!sev||r.dataset.sev===sev)&&(!cat||r.dataset.cat===cat)&&(!sub||r.dataset.sub===sub);
    if(ok&&q){ ok=r.textContent.toLowerCase().indexOf(q)>=0; }
    r.hidden=!ok;
    var d=document.querySelector('#findingsTable tr.f-detail[data-for="'+r.dataset.i+'"]');
    if(d&&!ok){ d.hidden=true; }
  });
}
function filterParity(){
  var v=document.getElementById('parityFilter').value;
  document.querySelectorAll('#parityTable tbody tr').forEach(function(r){ r.hidden=v&&r.dataset.status!==v; });
}
document.querySelectorAll('#findingsTable tr.f-row').forEach(function(r){
  r.addEventListener('click',function(){
    var d=document.querySelector('#findingsTable tr.f-detail[data-for="'+r.dataset.i+'"]');
    if(d){ d.hidden=!d.hidden; }
  });
});
</script>
</body>
</html>`

writeFileSync(outPath, html)
console.log('wrote', outPath, '(' + Math.round(html.length / 1024) + ' KB)')
console.log('findings:', findings.length, '| active:', activeFindings.length, '| parity:', Math.round(Number(parity.overall_parity_pct) || 0) + '%')
