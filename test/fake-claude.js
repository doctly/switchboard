#!/usr/bin/env node
// fake-claude.js — a stub of the `claude` CLI for Agent Teams tests.
//
// Parses the same argument surface the orchestrator generates
// (--session-id/--resume, --permission-mode, --append-system-prompt,
// positional boot prompt) and then ACTS like a worker or reviewer agent:
// it edits files, commits, writes reviews and performs the task-file status
// transitions of the file protocol — so the watcher/spawner pipeline can be
// exercised end-to-end with real files, real git worktrees and real child
// processes, no model required.
//
// Environment:
//   SB_PROJECT_ROOT   the orchestrated project (where .switchboard lives)
//   SB_FAKE_VERDICTS  comma list consumed per review, e.g. "changes_requested,approved"
//                     (state kept in .switchboard/fake-verdicts.state)
//   SB_FAKE_HOME      if set, also write a minimal session JSONL transcript
//                     under $SB_FAKE_HOME/.claude/projects/<encoded-cwd>/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id' || a === '--resume' || a === '--permission-mode'
      || a === '--append-system-prompt' || a === '--add-dir' || a === '--model') {
      out.flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) {
      out.flags[a.slice(2)] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, obj) {
  const tmp = file + '.tmp-fake';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function appendEvent(runDir, evt) {
  fs.appendFileSync(path.join(runDir, 'events.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...evt }) + '\n');
}

function git(args, cwd) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, windowsHide: true }).toString() };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.message) };
  }
}

// Write a minimal-but-plausible transcript so the Switchboard sidebar /
// JSONL viewer have something to show in UI tests.
function writeTranscript(home, cwd, sessionId, slug, lines) {
  try {
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(home, '.claude', 'projects', sanitized);
    fs.mkdirSync(dir, { recursive: true });
    const out = lines.map((text, i) => JSON.stringify({
      parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId, slug,
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: i % 2 === 0
        ? { role: 'user', content: text }
        : { role: 'assistant', content: [{ type: 'text', text }] },
      uuid: `fake-${sessionId}-${i}`, timestamp: new Date().toISOString(),
    })).join('\n') + '\n';
    fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), out);
  } catch {}
}

function nextVerdict(projectRoot) {
  const verdicts = (process.env.SB_FAKE_VERDICTS || 'approved').split(',').map(s => s.trim());
  const stateFile = path.join(projectRoot, '.switchboard', 'fake-verdicts.state');
  let used = 0;
  try { used = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}
  fs.writeFileSync(stateFile, String(used + 1));
  return verdicts[Math.min(used, verdicts.length - 1)];
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const sessionId = flags['session-id'] || flags.resume || 'unknown-session';
  const prompt = positional.join(' ');
  const projectRoot = process.env.SB_PROJECT_ROOT;
  const cwd = process.cwd();

  const m = prompt.match(/^\/sb-(work|review)\s+(\S+)\s+(\S+)/);
  if (!m || !projectRoot) {
    // Unknown boot prompt (e.g. master /sb-plan in a UI smoke test) — just
    // emit a transcript line and exit cleanly.
    if (process.env.SB_FAKE_HOME) {
      writeTranscript(process.env.SB_FAKE_HOME, cwd, sessionId, 'fake',
        [prompt || 'hello', 'fake-claude: nothing to do']);
    }
    process.exit(0);
  }
  const [, mode, runId, taskId] = m;
  const runDir = path.join(projectRoot, '.switchboard', 'runs', runId);
  const taskFile = path.join(runDir, 'tasks', `${taskId}.json`);
  const task = readJson(taskFile);

  if (mode === 'work') {
    // "Implement": create/modify a file, commit on the task branch.
    const implFile = path.join(cwd, `impl-${taskId}.txt`);
    const attempt = (task.attempts || 1);
    fs.writeFileSync(implFile, `implementation of ${taskId}, attempt ${attempt}\n`);
    if (fs.existsSync(path.join(cwd, '.git'))) {
      git(['add', '-A'], cwd);
      git(['-c', 'user.email=fake@test', '-c', 'user.name=fake-claude',
        'commit', '-m', `${taskId}: fake implementation (attempt ${attempt})`], cwd);
    }
    const fresh = readJson(taskFile);
    if (fresh.status === 'in_progress') {
      fresh.summary = `fake-claude implemented ${taskId} (attempt ${attempt})`;
      fresh.status = 'needs_review';
      writeJson(taskFile, fresh);
      appendEvent(runDir, { type: 'task-transition', task: taskId, from: 'in_progress', to: 'needs_review', actor: 'worker' });
      appendEvent(runDir, { type: 'note', actor: 'worker', task: taskId, text: fresh.summary });
    }
    if (process.env.SB_FAKE_HOME) {
      writeTranscript(process.env.SB_FAKE_HOME, cwd, sessionId, runId,
        [prompt, `Implemented ${taskId}; set needs_review.`]);
    }
  } else {
    // "Review": write a verdict file and transition the task.
    const n = (task.reviews || []).length + 1;
    const verdict = nextVerdict(projectRoot);
    const reviewRel = `reviews/${taskId}-${n}.md`;
    fs.mkdirSync(path.join(runDir, 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(runDir, reviewRel),
      `# Review ${n} of ${taskId}\n\nVerdict: **${verdict}**\n\n` +
      (verdict === 'approved'
        ? 'No blockers found by fake-claude.\n'
        : '- blocker: fake-claude demands a second attempt (test scenario).\n'));
    const fresh = readJson(taskFile);
    if (fresh.status === 'reviewing') {
      fresh.reviews = [...(fresh.reviews || []), { file: reviewRel, verdict }];
      fresh.status = verdict === 'approved' ? 'approved' : 'changes_requested';
      writeJson(taskFile, fresh);
      appendEvent(runDir, { type: 'task-transition', task: taskId, from: 'reviewing', to: fresh.status, actor: 'reviewer' });
    }
    if (process.env.SB_FAKE_HOME) {
      writeTranscript(process.env.SB_FAKE_HOME, cwd, sessionId, runId,
        [prompt, `Reviewed ${taskId}: ${verdict}.`]);
    }
  }
  process.exit(0);
}

main();
