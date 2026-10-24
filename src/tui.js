#!/usr/bin/env node
'use strict';
// DeepForge TUI — a small menu over the full orchestrator. No Electron, no deps.
// Same engine as the desktop app (src/main/orchestrator + state + registry).
//
//   node src/tui.js [project-path]
//
// Flow: pick a project → pick what to do (start / finish roadmap / steer the
// architect / view plan / settings). A compact screen redrawn in place — it
// never scrolls a wall of text.

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { execFile } = require('child_process');

const orchestrator = require('./main/orchestrator');
const state = require('./main/state');
const registry = require('./main/registry');

// ---------------------------------------------------------------- colors
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const C = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = C('2'), bold = C('1');
const red = C('31'), green = C('32'), yellow = C('33'), blue = C('34'), cyan = C('36');

const PHASE_TEXT = {
  architect: '🧠 Architect is planning…',
  worker: '🔨 Worker is building…',
  gates: '✅ Running tests & checks…',
  review: '🔍 Reviewer is checking…',
  fix: '🩹 Fixing issues…',
  compact: '🧹 Tidying memory…'
};
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------------------------------------------------------------- state
let view = 'projects';   // projects | menu | plan | run
let sel = null;          // selected project path
let running = false;
let finished = false;    // a run ended; press a key to return to the menu
let status = 'idle';
let phase = null;
let cost = 0;
let cycle = 0;
let lastConn = false;
let prompting = false;
let spin = 0;
let tail = [];           // last few notable log lines for the run view
const LAST = path.join(os.homedir(), '.deepforge', 'tui-last.json');

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));

// ---------------------------------------------------------------- paint
const CLEAR = '\x1b[2J\x1b[3J\x1b[H', HOME = '\x1b[H', CLR_BELOW = '\x1b[J';
let painted = false;
function frame(lines) {
  process.stdout.write((painted ? HOME : CLEAR) + lines.join('\n') + '\n' + CLR_BELOW);
  painted = true;
}
function head(extra) {
  const conn = lastConn ? green('● claude') : yellow('○ claude?');
  return bold('DeepForge') + (sel ? '  ' + cyan(path.basename(sel)) : '') + (extra ? '  ' + extra : '') + '   ' + conn;
}
const bar = dim('─'.repeat(46));

function paint() {
  if (prompting) return;
  if (view === 'projects') return frame(viewProjects());
  if (view === 'menu') return frame(viewMenu());
  if (view === 'plan') return frame(viewPlan());
  if (view === 'run') return frame(viewRun());
}

function viewProjects() {
  const list = registry.list();
  projCache = list;
  const L = [' ' + head(), ' ' + bar, ''];
  if (!list.length) L.push('  ' + dim('No projects yet.'));
  else { L.push('  Pick a project:', ''); list.slice(0, 9).forEach((p, i) => L.push(`   ${bold(String(i + 1))}  ${p.name.padEnd(16)} ${dim(p.path)}`)); }
  L.push('', ' ' + dim('[1-9] open   [a] add by path   [r] refresh   [q] quit'));
  return L;
}

function viewMenu() {
  const plan = state.readPlan(sel);
  const c = (s) => plan.tasks.filter((t) => t.status === s).length;
  const counts = dim(`${c('doing')} doing · ${c('todo')} todo · ${c('done')} done` + (c('blocked') ? ' · ' + red(c('blocked') + ' blocked') : ''));
  return [
    ' ' + head(),
    ' ' + bar,
    '',
    '  What do you want to do?',
    '',
    `   ${bold('1')}  ▶  ${bold('Start')} — work all day`,
    `   ${bold('2')}  🏁 ${bold('Finish the roadmap')}`,
    `   ${bold('3')}  💬 ${bold('Tell the architect')} something`,
    `   ${bold('4')}  📋 View plan    ${counts}`,
    `   ${bold('5')}  ⚙  Settings`,
    '',
    ' ' + dim('[b] back to projects   [q] quit')
  ];
}

function viewPlan() {
  const plan = state.readPlan(sel);
  const by = (s) => plan.tasks.filter((t) => t.status === s);
  const L = [' ' + head(cyan('plan')), ' ' + bar, ''];
  const doing = by('doing'), todo = by('todo'), blocked = by('blocked');
  if (doing.length) { L.push('  ' + yellow('▸ now')); doing.forEach((t) => L.push(`    ${dim(t.id)} ${trunc(t.title, 42)}`)); L.push(''); }
  if (todo.length) { L.push('  ' + dim('• next')); todo.slice(0, 5).forEach((t) => L.push(`    ${dim(t.id)} ${trunc(t.title, 42)}`)); if (todo.length > 5) L.push('    ' + dim(`+${todo.length - 5} more`)); L.push(''); }
  if (blocked.length) { L.push('  ' + red('✖ blocked')); blocked.slice(0, 3).forEach((t) => L.push(`    ${dim(t.id)} ${trunc(t.title, 42)}`)); L.push(''); }
  L.push('  ' + green(`✓ ${by('done').length} done`));
  if (!plan.tasks.length) L.push('  ' + dim('No tasks yet — press Start and the architect plans the first one.'));
  L.push('', ' ' + dim('[any key] back'));
  return L;
}

function viewRun() {
  const st = { running: green, stopping: yellow, done: green, blocked: red }[status] || dim;
  const spinner = running ? cyan(SPIN[spin % SPIN.length]) : (status === 'done' ? green('✓') : status === 'blocked' ? red('⚠') : '·');
  const now = running ? (PHASE_TEXT[phase] || 'Working…') : (status === 'done' ? 'All planned work complete.' : status === 'blocked' ? 'Blocked — see lines below.' : 'Stopped.');
  const L = [
    ' ' + head(st('● ' + status)),
    ' ' + bar,
    '',
    `  ${spinner}  ${bold(cycle ? 'Cycle ' + cycle : 'Starting')} · ${now}`,
    '  ' + dim('~$' + cost.toFixed(2) + ' est.'),
    ''
  ];
  for (const t of tail.slice(-6)) L.push('   ' + t);
  L.push('');
  L.push(' ' + dim(running ? '[x] stop   [d] steer the architect' : '[any key] back to menu'));
  return L;
}

// ---------------------------------------------------------------- helpers
let projCache = [];
function selectProject(p) {
  const cfg = state.ensure(p);
  registry.add(p, cfg && cfg.name);
  sel = p;
  try { fs.mkdirSync(path.dirname(LAST), { recursive: true }); fs.writeFileSync(LAST, JSON.stringify({ path: p })); } catch (_) {}
  view = 'menu';
  paint();
}

function pushTail(level, msg) {
  if (level === 'route') return; // model-routing noise — keep the panel clean
  const mark = { success: green('✓'), error: red('✖'), warn: yellow('!'), agent: cyan('▸'), gate: blue('·'), info: dim('·') }[level] || dim('·');
  tail.push(mark + ' ' + trunc(msg, 60));
  if (tail.length > 12) tail.shift();
}

function ask(title, q) {
  return new Promise((resolve) => {
    prompting = true;
    stopKeys();
    process.stdout.write(CLEAR);
    process.stdout.write(' ' + head() + '\n ' + bar + '\n\n' + (title ? ' ' + title + '\n\n' : ''));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(' ' + q, (answer) => {
      rl.close();
      prompting = false;
      startKeys();
      resolve((answer || '').trim());
    });
  });
}

async function addByPath() {
  const ans = await ask('Add a project', 'Paste a folder path (blank cancels): ');
  painted = false;
  if (!ans) { paint(); return; }
  const target = ans.replace(/^~(?=\/|$)/, os.homedir());
  if (!fs.existsSync(target)) { view = 'projects'; paint(); pushTailFlash(red('No such folder: ' + target)); return; }
  selectProject(path.resolve(target));
}
function pushTailFlash(msg) { process.stdout.write('\n ' + msg + '\n'); }

async function steer() {
  const t = await ask('Steer the architect', 'Message (queued for the next cycle): ');
  painted = false;
  if (t) {
    const prev = state.read(sel, 'DIRECTIVES.md');
    state.write(sel, 'DIRECTIVES.md', (prev ? prev + '\n' : '') + t);
    pushTail('info', '→ directive queued');
  }
  paint();
}

async function settings() {
  const cfg = state.readConfig(sel);
  const keep = (v, a) => (a === '' ? v : a);
  const goal = keep(cfg.productGoal, await ask('Settings — product goal', `Goal [${dim(trunc(cfg.productGoal || '', 40))}]: `));
  const autoRoute = (keep(cfg.autoRoute !== false ? 'y' : 'n', (await ask('Settings — model routing', `Auto-route models per task? y/n [${cfg.autoRoute !== false ? 'y' : 'n'}]: `)).toLowerCase())) === 'y';
  const effort = keep(cfg.effort || 'high', (await ask('Settings — effort', `Effort low/medium/high [${cfg.effort || 'high'}]: `)).toLowerCase());
  const model = keep(cfg.model || '', await ask('Settings — model', `Force model — blank=auto, claude-fable-5 (best results), claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5 [${cfg.model || 'auto'}]: `));
  const maxCycles = parseInt(keep(String(cfg.maxCyclesPerRun || 0), await ask('Settings — cycles', `Max cycles per run, 0 = all day [${cfg.maxCyclesPerRun || 0}]: `)), 10) || 0;
  const depthFirst = (keep(cfg.depthFirst !== false ? 'y' : 'n', (await ask('Settings — depth', `Depth-first (harden before new features)? y/n [${cfg.depthFirst !== false ? 'y' : 'n'}]: `)).toLowerCase())) === 'y';
  state.updateConfig(sel, { productGoal: goal, autoRoute, effort, model: model.trim(), maxCyclesPerRun: maxCycles, depthFirst });
  painted = false;
  paint();
}

function startRun(mode) {
  view = 'run';
  finished = false;
  tail = [];
  cycle = 0;
  cost = 0;
  painted = false;
  paint();
  orchestrator.start(sel, mode); // fire-and-forget; events stream back
}

// ---------------------------------------------------------------- keys
async function onKey(str, key) {
  if (prompting) return;
  if (key && key.ctrl && key.name === 'c') return quit();
  const k = (key && key.name) || str;

  if (view === 'projects') {
    if (/^[1-9]$/.test(k)) { const p = projCache[parseInt(k, 10) - 1]; if (p) selectProject(p.path); return; }
    if (k === 'a') return addByPath();
    if (k === 'r') { painted = false; return paint(); }
    if (k === 'q') return quit();
    return;
  }
  if (view === 'menu') {
    if (k === '1') return startRun('allday');
    if (k === '2') return startRun('roadmap');
    if (k === '3') return steer();
    if (k === '4') { view = 'plan'; painted = false; return paint(); }
    if (k === '5') return settings();
    if (k === 'b') { view = 'projects'; sel = null; painted = false; return paint(); }
    if (k === 'q') return quit();
    return;
  }
  if (view === 'plan') { view = 'menu'; painted = false; return paint(); }
  if (view === 'run') {
    if (running) {
      if (k === 'x') { orchestrator.requestStop(); return; }
      if (k === 'd') return steer();
    } else { view = 'menu'; painted = false; return paint(); }
  }
}

let keysOn = false;
function startKeys() { if (process.stdin.isTTY) process.stdin.setRawMode(true); if (!keysOn) { process.stdin.on('keypress', onKey); keysOn = true; } }
function stopKeys() { if (keysOn) { process.stdin.removeListener('keypress', onKey); keysOn = false; } if (process.stdin.isTTY) process.stdin.setRawMode(false); }

function quit() {
  if (running) orchestrator.requestStop();
  process.stdout.write('\x1b[?25h\n'); // restore cursor
  setTimeout(() => process.exit(0), running ? 300 : 0);
}

// ---------------------------------------------------------------- engine events
orchestrator.on('log', ({ level, msg }) => {
  const m = /── Cycle (\d+) ──/.exec(msg); if (m) cycle = parseInt(m[1], 10);
  pushTail(level, msg);
  if (view === 'run') paint();
});
orchestrator.on('phase', (p) => { phase = p; if (view === 'run') paint(); });
orchestrator.on('cost', (c) => { cost = c.total || 0; if (view === 'run') paint(); });
orchestrator.on('status', (s) => {
  status = s;
  running = (s === 'running' || s === 'stopping');
  if (!running && (s === 'stopped' || s === 'done' || s === 'blocked')) finished = true;
  if (view === 'run') paint();
});

function checkConn() { execFile('claude', ['--version'], { timeout: 8000, shell: process.platform === 'win32' }, (err) => { lastConn = !err; if (!prompting) paint(); }); }

// ---------------------------------------------------------------- boot
(function main() {
  if (!process.stdin.isTTY) { process.stdout.write('DeepForge TUI needs an interactive terminal.\n'); process.exit(1); }
  const argPath = process.argv[2];
  let p = argPath ? path.resolve(argPath) : null;
  if (!p) { try { p = JSON.parse(fs.readFileSync(LAST, 'utf8')).path; } catch (_) {} }

  process.stdout.write('\x1b[?25l'); // hide cursor for a cleaner menu
  readline.emitKeypressEvents(process.stdin);
  startKeys();
  process.stdin.resume();

  if (p && fs.existsSync(p)) selectProject(p); else { view = 'projects'; paint(); }
  checkConn();

  const ticker = setInterval(() => { if (view === 'run' && running) { spin++; paint(); } }, 200);
  ticker.unref();
  process.on('exit', () => process.stdout.write('\x1b[?25h'));
})();
