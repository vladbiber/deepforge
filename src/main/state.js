'use strict';
const fs = require('fs');
const path = require('path');

const DIR = '.orchestrator';

function p(projectPath, ...rest) { return path.join(projectPath, DIR, ...rest); }

// Seed the persistent state layer. This is the SINGLE SOURCE OF TRUTH that
// survives across fresh contexts — agents reconstruct everything from here.
function ensure(projectPath, productGoal) {
  fs.mkdirSync(p(projectPath, 'briefs'), { recursive: true });
  const seed = (file, content) => {
    const fp = p(projectPath, file);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
  };

  seed('config.json', JSON.stringify({
    productGoal: productGoal || 'Describe the product to build (edit me).',
    // Agent backend: 'claude' (default, full agent) | 'codex' (full agent) |
    // 'ollama' (LOCAL, TEXT-ONLY — cannot edit files; planning roles only).
    provider: 'claude',
    autoRoute: true,
    model: '',
    effort: 'high',
    architectModel: '', // '' = Fable 5 (best planning/results). Set 'claude-sonnet-4-6' to cut tokens on long runs.
    reviewerModel: '',  // '' = Sonnet. Set 'claude-fable-5' for the strongest review.
    maxBudgetUsdPerAgent: 5,
    maxCyclesPerRun: 0,
    maxRunUsd: 0, // 0 = off. Set e.g. 20 to stop the whole run after ~$20 ESTIMATED usage (proxy for "don't burn too much of my limit").
    maxStallCycles: 3, // stop after N consecutive cycles with no committed work (rejected briefs / blocked tasks / no-op workers)
    compactEvery: 10,
    depthFirst: true,
    gates: { test: 'auto', build: 'auto', typecheck: 'auto' }
  }, null, 2));

  seed('plan.json', JSON.stringify({ nextId: 1, tasks: [] }, null, 2));
  seed('ROADMAP.md',
`# Roadmap

> Product goal: ${productGoal || '(define in config.json)'}

Capabilities — depth-first. Each must work end-to-end, tested and robust,
before the next is started. We build a FEW things excellently.

_The architect will populate this on the first cycle._
`);
  seed('STATE.md', `# Current State of the World\n\n_Empty project. Nothing built yet._\n`);
  seed('DECISIONS.md', `# Architectural Decisions (ADRs)\n\n_None yet._\n`);
  seed('DIRECTIVES.md', '');
  seed('SESSION.md', `# Session Handoff\n\nNothing started yet. Press Start to begin.\n`);
  return readConfig(projectPath);
}

function readConfig(projectPath) {
  try { return JSON.parse(fs.readFileSync(p(projectPath, 'config.json'), 'utf8')); }
  catch (_) { return {}; }
}
function updateConfig(projectPath, patch) {
  const merged = { ...readConfig(projectPath), ...patch };
  write(projectPath, 'config.json', JSON.stringify(merged, null, 2));
  return merged;
}
function read(projectPath, file) {
  try { return fs.readFileSync(p(projectPath, file), 'utf8'); } catch (_) { return ''; }
}
function write(projectPath, file, content) {
  const fp = p(projectPath, file);
  fs.mkdirSync(path.dirname(fp), { recursive: true }); // tolerate nested paths (briefs/, cycles/)
  fs.writeFileSync(fp, content);
}
function readPlan(projectPath) {
  try { return JSON.parse(fs.readFileSync(p(projectPath, 'plan.json'), 'utf8')); }
  catch (_) { return { nextId: 1, tasks: [] }; }
}
function writePlan(projectPath, plan) {
  write(projectPath, 'plan.json', JSON.stringify(plan, null, 2));
  renderPlanMd(projectPath, plan);
}
function renderPlanMd(projectPath, plan) {
  const order = ['doing', 'todo', 'blocked', 'done'];
  const buckets = {};
  for (const t of plan.tasks) (buckets[t.status] = buckets[t.status] || []).push(t);
  const lines = ['# Plan\n'];
  for (const status of order) {
    const arr = buckets[status] || [];
    if (!arr.length) continue;
    lines.push(`\n## ${status.toUpperCase()} (${arr.length})\n`);
    for (const t of arr) lines.push(`- **${t.id}** — ${t.title}  _(${t.capability || 'general'})_`);
  }
  write(projectPath, 'PLAN.md', lines.join('\n') + '\n');
}
function appendDecision(projectPath, text) {
  write(projectPath, 'DECISIONS.md', read(projectPath, 'DECISIONS.md') + '\n' + text + '\n');
}
function drainDirectives(projectPath) {
  const d = read(projectPath, 'DIRECTIVES.md').trim();
  if (d) write(projectPath, 'DIRECTIVES.md', '');
  return d;
}
function logCycle(projectPath, entry) {
  try { fs.appendFileSync(p(projectPath, 'log.jsonl'), JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); } catch (_) {}
}

module.exports = {
  DIR, ensure, readConfig, updateConfig, read, write,
  readPlan, writePlan, appendDecision, drainDirectives, logCycle
};
