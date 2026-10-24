'use strict';

// All prompts live here. They encode the three things that make DeepForge work:
// (1) freshness — every agent is told it has no memory beyond the files given;
// (2) depth — structure forces concrete files + verifiable acceptance criteria;
// (3) anti-hallucination — agents are told objective gates + a reviewer will check.

function fence(label, body) {
  return `\n===== ${label} =====\n${(body && String(body).trim()) || '(empty)'}\n===== END ${label} =====\n`;
}

// Cap a growing injected block so a long run doesn't let one ever-appending file
// (esp. DECISIONS.md, which grows by one ADR per task) inflate EVERY architect
// call. Keeps the most-recent tail (what matters for the next decision) and marks
// the trim visibly — never a silent cap. Compaction still rewrites the full file.
function clampTail(body, maxChars) {
  const s = (body && String(body).trim()) || '';
  if (s.length <= maxChars) return s;
  return `[… ${s.length - maxChars} older chars trimmed for token efficiency — full history is on disk and is compacted periodically …]\n\n` + s.slice(-maxChars);
}

function architectPrompt({ productGoal, roadmap, plan, state, decisions, directives, depthFirst, finishRoadmap, lastOutcome }) {
  const open = plan.tasks.filter((t) => t.status === 'todo' || t.status === 'blocked');
  const done = plan.tasks.filter((t) => t.status === 'done');
  // Titles only, recent last — deterministic ground truth of what was already
  // built, so a fresh architect can't re-emit finished work when STATE.md drifts.
  const doneList = done.slice(-40).map((t) => `${t.id}: ${t.title}`).join('\n');
  return [
    `You are the ARCHITECT of a software project. You run in a FRESH context every cycle and have NO memory beyond the files below. Reconstruct your understanding entirely from them.`,
    `PRODUCT GOAL:\n${productGoal}`,
    `Progress so far: ${done.length} task(s) completed.`,
    doneList ? fence('ALREADY COMPLETED TASKS (do NOT redo these)', doneList) : '',
    lastOutcome ? fence('PREVIOUS CYCLE OUTCOME — the last cycle produced NO committed work; do not repeat this failure', lastOutcome) : '',
    `Your job THIS cycle: decide the SINGLE next task to build, OR extend the roadmap, OR declare done/blocked. Think about what most advances a genuinely good product.`,
    finishRoadmap
      ? `MODE: FINISH THE ROADMAP. Work ONLY through the EXISTING roadmap below — do NOT invent new capabilities or use "extend_roadmap"/"roadmap_additions". Identify roadmap items that are not yet done or not yet robust (the roadmap may be a long changelog: look for unchecked "[ ]"/"[~]" items, "remaining"/"TODO"/"what's next" sections, and anything STATE says is incomplete) and advance them one task at a time. When EVERY roadmap item is genuinely built, tested, and hardened, return {"action":"done"} with a reason. Do not pad with busywork to avoid finishing.`
      : `MODE: WORK ALL DAY. You may extend the roadmap with genuinely valuable capabilities when existing ones are solid.`,
    depthFirst
      ? `DEPTH-FIRST POLICY (mandatory): Before adding any NEW capability, verify existing ones are complete, tested, and robust. Prefer deepening and hardening what exists over adding shallow new features. Build a FEW things excellently — never many things poorly. Actively resist the urge to pad the roadmap with busywork; an idle architect inventing trivial tasks is the failure mode to avoid.`
      : '',
    `Every task you emit MUST be deep and concrete: real target file paths, interfaces/contracts to respect, unambiguous instructions, and >= 2 VERIFIABLE acceptance criteria. A vague task will be auto-rejected and waste a whole cycle.`,
    `EFFICIENCY (model routing): classify each task's "complexity" HONESTLY so it runs on the smallest capable model — "trivial" (mechanical: rename, copy, config, tiny additive content) runs on a small fast model; "standard" (normal feature work) on a mid model; "complex" (architecture, tricky algorithms, cross-cutting changes) on the most powerful model. Set "skip_review": true ONLY for trivial mechanical tasks where an independent review adds nothing — this saves a whole agent. Default to "standard" + skip_review false when unsure.`,
    fence('ROADMAP.md', roadmap),
    fence('CURRENT STATE OF THE WORLD', state),
    fence('DECISIONS / ADRs (most recent)', clampTail(decisions, 6000)),
    fence('OPEN TASKS (todo/blocked)', JSON.stringify(open, null, 2)),
    directives ? fence('USER DIRECTIVES — apply NOW, they override your defaults', directives) : '',
    `Respond with STRICT JSON ONLY (no prose, no markdown fences), exactly this shape:
{
  "action": "work" | "extend_roadmap" | "done" | "blocked",
  "reason": "required for done/blocked",
  "roadmap_additions": ["capability line", "..."],
  "state_update": "rewritten STATE.md if something material changed, else null",
  "task": {
    "title": "imperative, specific",
    "capability": "which roadmap capability this advances",
    "complexity": "trivial | standard | complex",
    "skip_review": false,
    "rationale": "why THIS task now (depth-first justification)",
    "depth_note": "why this deepens rather than sprawls",
    "files": ["concrete/path.ext", "..."],
    "contracts": "interfaces/types/APIs the worker must respect, or 'none'",
    "brief": "detailed, unambiguous instructions for a fresh worker who knows nothing else",
    "acceptance_criteria": ["verifiable criterion 1", "verifiable criterion 2"]
  }
}
"task" is required only when action is "work". Output JSON only.`
  ].filter(Boolean).join('\n\n');
}

function workerPrompt({ productGoal, task, state }) {
  return [
    `You are a focused implementation WORKER in a FRESH context. Implement ONE task to a high standard, then stop. You have no memory beyond what is below — do not assume anything else.`,
    `PRODUCT GOAL (context only):\n${productGoal}`,
    fence('PROJECT STATE — what already exists', state),
    `TASK: ${task.title}`,
    `CAPABILITY: ${task.capability}`,
    `TARGET FILES (work within these; create them if missing): ${JSON.stringify(task.files)}`,
    `CONTRACTS TO RESPECT:\n${task.contracts || 'none'}`,
    fence('DETAILED BRIEF', task.brief),
    `ACCEPTANCE CRITERIA — your work MUST satisfy ALL of these (they will be checked):\n${(task.acceptance_criteria || []).map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`,
    `RULES:
- Implement with real depth: handle edge cases, validate inputs at boundaries, leave NO TODOs or stubs.
- Stay within the target files unless a contract genuinely forces a change elsewhere.
- If a test/build command exists, run it and make sure your work passes before finishing.
- Do NOT claim success you did not achieve. Objective gates (tests/build/typecheck) and an independent skeptical reviewer will verify everything.
Implement now.`
  ].join('\n\n');
}

function reviewerPrompt({ task, diff, gateResults }) {
  return [
    `You are an INDEPENDENT, SKEPTICAL REVIEWER in a fresh context. The worker ALWAYS claims success — your job is to catch shallowness, missing edge cases, swallowed errors, stubbed logic, and unmet acceptance criteria.`,
    `TASK: ${task.title}`,
    `ACCEPTANCE CRITERIA:\n${(task.acceptance_criteria || []).map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`,
    fence('OBJECTIVE GATE RESULTS', JSON.stringify(gateResults, null, 2)),
    fence('GIT DIFF OF THE WORK', diff),
    `Judge whether the work is genuinely complete and deep — not merely compiling. Respond with STRICT JSON ONLY:
{
  "verdict": "pass" | "reopen",
  "met_criteria": [true, false, ...],
  "issues": ["specific, actionable problems that must be fixed"],
  "summary": "one-line verdict"
}
Use "reopen" only when there are concrete, fixable problems. Output JSON only.`
  ].join('\n\n');
}

function fixPrompt({ task, issues, gateResults }) {
  const fails = ((gateResults && gateResults.results) || []).filter((r) => !r.pass);
  return [
    `You are a WORKER in a fresh context FIXING a task that failed verification. Fix ONLY the listed problems — do not expand scope or add features.`,
    `TASK: ${task.title}`,
    fence('TARGET FILES', JSON.stringify(task.files)),
    fence('ACCEPTANCE CRITERIA', (task.acceptance_criteria || []).join('\n')),
    fails.length ? fence('FAILING GATES — fix these first', fails.map((r) => `[${r.name}]\n${r.output}`).join('\n\n')) : '',
    (issues && issues.length) ? fence('REVIEWER ISSUES', issues.map((s, i) => `${i + 1}. ${s}`).join('\n')) : '',
    `Fix every listed problem with a REAL solution. Never mask failures, disable tests, or weaken assertions to make gates pass. Then stop.`
  ].filter(Boolean).join('\n\n');
}

function compactorPrompt({ state, decisions, plan }) {
  return [
    `You are a STATE COMPACTOR in a fresh context. The persistent state files have grown noisy. Rewrite them tight and accurate so future fresh agents read a clean picture — this prevents the state layer itself from rotting over a long project.`,
    fence('CURRENT STATE', state),
    fence('DECISIONS', decisions),
    fence('PLAN SUMMARY', JSON.stringify({ done: plan.tasks.filter((t) => t.status === 'done').length, total: plan.tasks.length }, null, 2)),
    `Respond with STRICT JSON ONLY:
{
  "state": "rewritten STATE.md — accurate current reality, concise, no raw history dump",
  "decisions": "rewritten DECISIONS.md — keep live ADRs, drop superseded/dead ones"
}
Output JSON only.`
  ].join('\n\n');
}

module.exports = { architectPrompt, workerPrompt, reviewerPrompt, fixPrompt, compactorPrompt };
