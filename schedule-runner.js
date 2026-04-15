// schedule-runner.js — Scan schedule-*.md files, match cron, build commands
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/** Parse YAML-like frontmatter from a markdown file (simple key: value parser). */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  let currentKey = null;
  const nested = {};

  for (const line of match[1].split('\n')) {
    if (currentKey && line.match(/^\s+/) && line.includes(':')) {
      const m = line.match(/^\s+([^:]+):\s*(.*)$/);
      if (m && !m[1].trim().startsWith('#')) {
        if (!nested[currentKey]) nested[currentKey] = {};
        nested[currentKey][m[1].trim()] = m[2].trim();
      }
      continue;
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (val === '' || val === undefined) {
        currentKey = key;
      } else {
        meta[key] = val;
        currentKey = null;
      }
    }
  }
  for (const [k, v] of Object.entries(nested)) {
    meta[k] = v;
  }
  return { meta, body: match[2].trim() };
}

// Check if a cron field matches a value. Supports *, ranges (1-5), lists (1,3,5), and steps.
function cronFieldMatches(field, value) {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(field, 10) === value;
}

/** Check if a 5-field cron expression matches the current time. */
function cronMatches(cronExpr, now) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  return (
    cronFieldMatches(minute, now.getMinutes()) &&
    cronFieldMatches(hour, now.getHours()) &&
    cronFieldMatches(dom, now.getDate()) &&
    cronFieldMatches(month, now.getMonth() + 1) &&
    cronFieldMatches(dow, now.getDay())
  );
}

/** Scan all projects for schedule-*.md files and return parsed schedule objects. */
function scanSchedules(log) {
  const schedules = [];
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return schedules;
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder.name);
      let projectPath = null;
      try {
        const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
        for (const jf of jsonlFiles) {
          const head = fs.readFileSync(path.join(folderPath, jf), 'utf8').slice(0, 4000);
          for (const line of head.split('\n').filter(Boolean)) {
            try {
              const entry = JSON.parse(line);
              if (entry.cwd) { projectPath = entry.cwd; break; }
            } catch {}
          }
          if (projectPath) break;
        }
      } catch {}
      if (!projectPath) continue;

      const commandsDir = path.join(projectPath, '.claude', 'commands');
      try {
        if (!fs.existsSync(commandsDir)) continue;
        const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('schedule-') && f.endsWith('.md'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');
            const { meta, body } = parseFrontmatter(content);
            if (!meta.cron || !body) continue;
            if (meta.enabled === 'false') continue;
            schedules.push({
              file, filePath: path.join(commandsDir, file),
              projectPath, folder: folder.name,
              name: meta.name || file, cron: meta.cron,
              slug: meta.slug || file.replace(/^schedule-/, '').replace(/\.md$/, ''),
              cli: meta.cli || {}, prompt: body,
            });
          } catch (err) {
            if (log) log.warn(`[schedule] Failed to parse ${file}:`, err.message);
          }
        }
      } catch {}
    }
  } catch (err) {
    if (log) log.error('[schedule] Error scanning schedules:', err);
  }
  return schedules;
}

/** Create a pre-seeded JSONL session file with user message and slug for grouping. */
function createScheduleSession(schedule) {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const claudeProjectDir = path.join(PROJECTS_DIR, schedule.folder);

  fs.mkdirSync(claudeProjectDir, { recursive: true });
  const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);

  const msgId = crypto.randomUUID();
  const lines = [
    JSON.stringify({ type: 'user', parentUuid: null, uuid: msgId, sessionId, cwd: schedule.projectPath, slug: schedule.slug, timestamp, message: { role: 'user', content: 'Scheduled Task: ' + schedule.prompt } }),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  return { sessionId, jsonlPath };
}

/** Build a claude CLI command string for a scheduled task. */
function buildScheduleCommand(sessionId, schedule) {
  let cmd = `claude --resume "${sessionId}" -p "Run the scheduled task"`;

  const cli = schedule.cli;
  cmd += ` --permission-mode "${cli['permission-mode'] || 'acceptEdits'}"`;
  if (cli.model) cmd += ` --model "${cli.model}"`;
  if (cli['max-budget-usd']) cmd += ` --max-budget-usd ${cli['max-budget-usd']}`;
  const allowedTools = cli['allowed-tools'] || 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch';
  cmd += ` --allowedTools "${allowedTools}"`;
  if (cli['append-system-prompt']) cmd += ` --append-system-prompt "${cli['append-system-prompt'].replace(/"/g, '\\"')}"`;
  if (cli['add-dirs']) {
    for (const dir of cli['add-dirs'].split(',').map(d => d.trim()).filter(Boolean)) {
      cmd += ` --add-dir "${dir}"`;
    }
  }

  return cmd;
}

/**
 * Start the cron loop. Checks every 60 seconds.
 * @param {object} log - Logger
 * @param {function} runCommand - Function to spawn a shell command: runCommand(cmd, cwd, name)
 * @returns {function} stop - Call to stop the scheduler
 */
function startScheduler(log, runCommand) {
  let running = true;
  const runningTasks = new Set();

  function tick() {
    if (!running) return;
    const now = new Date();
    const schedules = scanSchedules(log);

    for (const schedule of schedules) {
      if (!cronMatches(schedule.cron, now)) continue;
      const taskKey = `${schedule.folder}:${schedule.slug}`;
      if (runningTasks.has(taskKey)) {
        log.info(`[schedule] Skipping ${schedule.name} — still running from previous trigger`);
        continue;
      }

      log.info(`[schedule] Triggering: ${schedule.name} (${schedule.cron})`);
      try {
        const { sessionId } = createScheduleSession(schedule);
        const cmd = buildScheduleCommand(sessionId, schedule);

        runningTasks.add(taskKey);
        runCommand(cmd, schedule.projectPath, schedule.name, () => {
          runningTasks.delete(taskKey);
        });
      } catch (err) {
        log.error(`[schedule] Failed to run ${schedule.name}:`, err);
      }
    }
  }

  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  const initialTimer = setTimeout(() => {
    tick();
    const interval = setInterval(tick, 60 * 1000);
    initialTimer._interval = interval;
  }, msUntilNextMinute);

  return function stop() {
    running = false;
    clearTimeout(initialTimer);
    if (initialTimer._interval) clearInterval(initialTimer._interval);
  };
}

module.exports = { parseFrontmatter, cronMatches, scanSchedules, startScheduler, createScheduleSession, buildScheduleCommand };
