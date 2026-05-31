#!/usr/bin/env node
// scripts/autoloop/node-state.mjs
//
// THE COMBINATION LOCK — the uniform node contract. Every actor at every tier
// (Supervisor → Governors → Orchestrator → Teams → Members) is a Node obeying
// this one contract, so ANY node can be swapped and the effort still flows:
//   * each successor inherits the predecessor's state + handoff (resume)
//   * every node reports a compact rollup UPWARD to its parent
//   * the uppermost node persists too → launchd can rebuild the mesh after a
//     full machine restart
//
// Persistence tree mirrors the topology tree:
//   <meshDir>/<tier>/<nodeId>/
//       state.json            continuously-written node state
//       handoff.md            written on degrade/rotate/stop; successor reads first
//       up/<childId>.md       rollups this node's CHILDREN pushed up to it
//   A node reports up by writing into its PARENT's up/ dir:
//       <parentDir>/up/<nodeId>.md
//
// API:
//   const n = new Node({ meshDir, tier, nodeId, parentDir });
//   n.init({ objective });               // create dirs, seed state, adopt handoff
//   n.update({ progress, decisions });   // merge+persist state.json
//   n.writeHandoff({ where, next, avoid, snapshot });
//   n.reportUp({ status, summary });     // compact rollup to parent
//   n.childrenRollups();                 // read up/*.md this node received
//   n.adopt();                           // load own last state + predecessor handoff

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function utcNow() { return new Date().toISOString(); }
function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export class Node {
  constructor({ meshDir, tier, nodeId, parentDir = null }) {
    if (!meshDir || !tier || !nodeId) throw new Error('Node requires {meshDir, tier, nodeId}');
    this.meshDir = meshDir;
    this.tier = tier;
    this.nodeId = nodeId;
    this.dir = path.join(meshDir, tier, nodeId);
    this.statePath = path.join(this.dir, 'state.json');
    this.handoffPath = path.join(this.dir, 'handoff.md');
    this.upDir = path.join(this.dir, 'up');
    this.parentDir = parentDir;
    this.state = null;
  }

  _ensureDirs() {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.upDir, { recursive: true });
  }

  // Create dirs, adopt any predecessor state/handoff, seed fresh fields.
  init({ objective = '', inheritedFrom = null, parentId = null } = {}) {
    this._ensureDirs();
    const prior = readJson(this.statePath);
    this.state = {
      node_id: this.nodeId,
      tier: this.tier,
      parent_id: parentId ?? prior?.parent_id ?? null,
      inherited_from: inheritedFrom ?? prior?.node_id ?? null,
      objective: objective || prior?.objective || '',
      progress: prior?.progress || [],
      decisions: prior?.decisions || [],
      open_items: prior?.open_items || [],
      created_at: prior?.created_at || utcNow(),
      updated_at: utcNow(),
      status: 'active',
    };
    this._persist();
    return this;
  }

  _persist() {
    this._ensureDirs();
    this.state.updated_at = utcNow();
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  // Merge partial fields into state and persist. Arrays append; scalars replace.
  update(partial = {}) {
    if (!this.state) this.adopt();
    for (const [k, v] of Object.entries(partial)) {
      if (Array.isArray(this.state[k]) && Array.isArray(v)) this.state[k].push(...v);
      else this.state[k] = v;
    }
    this._persist();
    return this.state;
  }

  // On degrade/rotate/stop: the successor reads this FIRST.
  writeHandoff({ where = '', next = '', avoid = [], snapshot = {} } = {}) {
    this._ensureDirs();
    const md = [
      `# Handoff — ${this.tier}/${this.nodeId}`,
      `_written ${utcNow()}_`,
      '',
      '## Where I am',
      where || (this.state?.progress?.slice(-5).map((p) => `- ${p}`).join('\n')) || '(none)',
      '',
      '## Next step',
      next || '(unspecified)',
      '',
      '## Avoid (dead-ends)',
      (Array.isArray(avoid) && avoid.length) ? avoid.map((a) => `- ${a}`).join('\n') : '(none)',
      '',
      '## Live snapshot',
      '```json',
      JSON.stringify(snapshot, null, 2),
      '```',
      '',
    ].join('\n');
    writeFileSync(this.handoffPath, md);
    if (this.state) { this.state.status = 'handed_off'; this._persist(); }
  }

  // Compact rollup pushed UP into the parent's up/ dir.
  reportUp({ status = 'active', summary = '' } = {}) {
    if (!this.parentDir) return false;
    const upDir = path.join(this.parentDir, 'up');
    mkdirSync(upDir, { recursive: true });
    const md = [
      `# ${this.tier}/${this.nodeId} — ${status}`,
      `_updated ${utcNow()}_`,
      '',
      summary || (this.state?.progress?.slice(-3).map((p) => `- ${p}`).join('\n')) || '(no summary)',
      '',
    ].join('\n');
    writeFileSync(path.join(upDir, `${this.nodeId}.md`), md);
    return true;
  }

  // Read the rollups this node's children pushed up to it.
  childrenRollups() {
    if (!existsSync(this.upDir)) return [];
    return readdirSync(this.upDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ child: f.replace(/\.md$/, ''), text: readFileSync(path.join(this.upDir, f), 'utf8') }));
  }

  // Resume: load own last state + predecessor handoff text (if any).
  adopt() {
    this.state = readJson(this.statePath) || null;
    const predecessorHandoff = existsSync(this.handoffPath)
      ? readFileSync(this.handoffPath, 'utf8') : null;
    return { state: this.state, predecessorHandoff };
  }
}

// ---- CLI (self-test) ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const meshDir = process.argv[2] || path.join(process.cwd(), '.autoloop', 'mesh');
  // parent
  const sup = new Node({ meshDir, tier: 'supervisor', nodeId: 'sup-1' });
  sup.init({ objective: 'self-test supervisor' });
  // child reporting up to parent
  const orch = new Node({ meshDir, tier: 'orchestrator', nodeId: 'orch-1', parentDir: sup.dir });
  orch.init({ objective: 'self-test orchestrator', parentId: 'sup-1' });
  orch.update({ progress: ['did a thing'] });
  orch.reportUp({ status: 'active', summary: 'orchestrator alive, 1 step done' });
  orch.writeHandoff({ where: 'mid self-test', next: 'verify rollups', avoid: ['nothing'] });
  const adopted = orch.adopt();
  const rollups = sup.childrenRollups();
  process.stdout.write(JSON.stringify({
    ok: !!adopted.state && !!adopted.predecessorHandoff && rollups.length === 1,
    orchState: adopted.state?.node_id,
    handoffPresent: !!adopted.predecessorHandoff,
    supSawChildren: rollups.map((r) => r.child),
  }, null, 2) + '\n');
}
