// schedule-runner.js — Scan schedule-*.md files and run them on cron match
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/** Parse YAML-like frontmatter from a markdown file (simple key: value parser). */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  let currentKey = null;
  let currentIndent = null;
  const nested = {};

  for (const line of match[1].split('\n')) {
    // Nested key (indented under a parent like cli:)
    if (currentKey && line.match(/^\s+/) && line.includes(':')) {
      const m = line.match(/^\s+([^:]+):\s*(.*)$/);
      if (m) {
        if (!nested[currentKey]) nested[currentKey] = {};
        const val = m[2].trim();
        // Skip commented-out lines
        if (!m[1].trim().startsWith('#')) {
          nested[currentKey][m[1].trim()] = val;
        }
      }
      continue;
    }

    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (val === '' || val === undefined) {
        // Possible parent key for nested values (e.g. cli:)
        currentKey = key;
      } else {
        meta[key] = val;
        currentKey = null;
      }
    }
  }

  // Merge nested objects
  for (const [k, v] of Object.entries(nested)) {
    meta[k] = v;
  }

  return { meta, body: match[2].trim() };
}

// Check if a cron field matches a value. Supports *, ranges (1-5), lists (1,3,5), and steps.
function cronFieldMatches(field, value) {
  if (field === '*') return true;

  // Step: */5
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }

  // List: 1,3,5
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }

  // Range: 1-5
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

/** Derive the project folder name used by Claude for JSONL storage. */
function projectToFolder(projectPath) {
  return projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
}

/** Scan all projects for schedule-*.md files and return parsed schedule objects. */
function scanSchedules(log) {
  const schedules = [];
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return schedules;
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const folder of folders) {
      // Derive the actual project path from the folder name
      const folderPath = path.join(PROJECTS_DIR, folder.name);
      let projectPath = null;
      try {
        // Try reading a session file to get the cwd
        const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
        for (const jf of jsonlFiles) {
          const head = fs.readFileSync(path.join(folderPath, jf), 'utf8').slice(0, 4000);
          const lines = head.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.cwd) { projectPath = entry.cwd; break; }
            } catch {}
          }
          if (projectPath) break;
        }
      } catch {}
      if (!projectPath) continue;

      // Look for schedule-*.md in {projectPath}/.claude/commands/
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
              file,
              filePath: path.join(commandsDir, file),
              projectPath,
              folder: folder.name,
              name: meta.name || file,
              cron: meta.cron,
              slug: meta.slug || file.replace(/^schedule-/, '').replace(/\.md$/, ''),
              cli: meta.cli || {},
              prompt: body,
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

/** Create a pre-seeded JSONL session file for a scheduled task run. */
function createScheduleSession(schedule) {
  const sessionId = crypto.randomUUID();
  const msgId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const claudeProjectDir = path.join(PROJECTS_DIR, schedule.folder);

  fs.mkdirSync(claudeProjectDir, { recursive: true });
  const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);

  const snapshot = JSON.stringify({
    type: 'file-history-snapshot',
    messageId: msgId,
    snapshot: { messageId: msgId, trackedFileBackups: {}, timestamp },
    isSnapshotUpdate: false,
  });

  const userMsg = JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: schedule.projectPath,
    sessionId,
    version: '1.0.0',
    gitBranch: 'main',
    slug: schedule.slug,
    type: 'user',
    message: { role: 'user', content: schedule.prompt },
    uuid: msgId,
    timestamp,
    todos: [],
    permissionMode: schedule.cli['permission-mode'] || 'default',
  });

  fs.writeFileSync(jsonlPath, snapshot + '\n' + userMsg + '\n');
  return { sessionId, jsonlPath };
}

/** Build the claude CLI command for a scheduled task. */
function buildScheduleCommand(sessionId, schedule) {
  let cmd = `claude --resume "${sessionId}" -p "${schedule.prompt.replace(/"/g, '\\"')}"`;

  const cli = schedule.cli;
  cmd += ` --permission-mode "${cli['permission-mode'] || 'default'}"`;
  if (cli.model) cmd += ` --model "${cli.model}"`;
  if (cli['max-budget-usd']) cmd += ` --max-budget-usd ${cli['max-budget-usd']}`;
  if (cli['allowed-tools']) cmd += ` --allowedTools "${cli['allowed-tools']}"`;
  if (cli['append-system-prompt']) cmd += ` --append-system-prompt "${cli['append-system-prompt'].replace(/"/g, '\\"')}"`;
  if (cli['add-dirs']) {
    for (const dir of cli['add-dirs'].split(',').map(d => d.trim()).filter(Boolean)) {
      cmd += ` --add-dir "${dir}"`;
    }
  }

  return cmd;
}

/** Start the cron loop. Checks every 60 seconds. Returns a cleanup function. */
function startScheduler(log) {
  let running = true;
  const runningTasks = new Set(); // track currently running task slugs to avoid overlap

  function tick() {
    if (!running) return;
    const now = new Date();
    const schedules = scanSchedules(log);

    for (const schedule of schedules) {
      if (!cronMatches(schedule.cron, now)) continue;
      // Avoid running same schedule twice simultaneously
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
        const child = spawn('bash', ['-lc', cmd], {
          cwd: schedule.projectPath,
          stdio: 'ignore',
          detached: true,
          env: { ...process.env, FORCE_COLOR: '0' },
        });

        child.on('exit', (code) => {
          runningTasks.delete(taskKey);
          log.info(`[schedule] ${schedule.name} finished (exit ${code})`);
        });

        child.on('error', (err) => {
          runningTasks.delete(taskKey);
          log.error(`[schedule] ${schedule.name} error:`, err.message);
        });

        child.unref();
      } catch (err) {
        log.error(`[schedule] Failed to run ${schedule.name}:`, err);
      }
    }
  }

  // Run check every 60 seconds, aligned to the start of each minute
  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  const initialTimer = setTimeout(() => {
    tick();
    const interval = setInterval(tick, 60 * 1000);
    // Store for cleanup
    initialTimer._interval = interval;
  }, msUntilNextMinute);

  return function stop() {
    running = false;
    clearTimeout(initialTimer);
    if (initialTimer._interval) clearInterval(initialTimer._interval);
  };
}

module.exports = { parseFrontmatter, cronMatches, scanSchedules, startScheduler, createScheduleSession, buildScheduleCommand };
