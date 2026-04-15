// schedule-ipc.js — IPC handlers and helpers for scheduled task creation
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SCHEDULE_COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');

const SCHEDULE_CREATOR_TEMPLATE = `---
name: create-switchboard-schedule
description: Create a new Switchboard scheduled task for this project
---

You are helping the user create a scheduled task in Switchboard. This task will run automatically on a cron schedule using Claude Code CLI in headless mode (-p flag).

## Instructions for the user

Welcome! I'll help you set up a scheduled task for this project. Tell me:
- **What** the task should do
- **When** it should run (e.g. "every weekday at 9am", "hourly", "every Sunday night")

I'll generate the schedule file and save it. You can always edit it later from the brain tab.

## How to create the task

Ask the user what the task should do and when it should run. Keep it conversational — one or two questions at a time, not all at once.

Once you have enough information, generate a cron expression from their description and confirm it in plain english (e.g. "That's every weekday at 9:00 AM").

## File format

Save to \`<project-root>/.claude/commands/schedule-<slug>.md\`:

\`\`\`markdown
---
name: <Human readable name>
cron: <5-field cron expression>
enabled: true
slug: <short-kebab-case-id>
cli:
  permission-mode: default
  # only include these if the user specified them:
  # model: <model>
  # max-budget-usd: <number>
  # allowed-tools: <comma-separated>
  # append-system-prompt: <extra context>
  # add-dirs: <comma-separated paths>
---

<The full prompt that will be sent to Claude when this task runs>
\`\`\`

## Rules

- The slug must be kebab-case, short, and descriptive
- The prompt in the body must be fully self-contained — it runs without any conversation history
- Default permission-mode is \`default\` unless the user asks for something else
- If the \`.claude/commands/\` directory doesn't exist, create it
- After saving, tell the user: "Your scheduled task is saved! It will appear in Switchboard's brain tab with a schedule icon. You can enable/disable it or edit the schedule from there."
- If the user wants to see existing schedules, list any \`schedule-*.md\` files in \`.claude/commands/\`
`;

const SCHEDULE_WELCOME_MESSAGE = `## Switchboard Scheduled Task Creator

Welcome! This session will help you create a **scheduled task** that runs automatically on a cron schedule using Claude Code.

### How it works
- Describe **what** you want the task to do and **when** it should run
- I'll generate a schedule file with the right cron expression and prompt
- The schedule file gets saved to this project's \`.claude/commands/\` directory as a command — so it can also be run manually from any Claude session using \`/schedule-<name>\`
- Once saved, it appears in the **brain tab** with a clock icon where you can edit it directly
- To edit, you can also ask use this schedule claude session to ask to edit existing commands.
- Switchboard runs matching schedules automatically in the background — each run creates a session grouped under the task's slug

### What you can configure
- **The prompt** — what Claude should do each time the task runs
- **The schedule** — any cron pattern (e.g. "every weekday at 9am", "hourly", "first Monday of the month")
- **CLI settings** — model, permission mode, budget cap, allowed tools, additional directories

### To get started
Just describe the task you have in mind, or try one of these:
- **"What are my existing schedules?"** — list just the scheduled tasks
- **"Edit schedule-hn-digest to run every 5 minutes instead of hourly"** — modify an existing schedule
- **"Create a task that runs the test suite every morning at 8am"** — create a new one
- **"Disable schedule-repo-health"** — toggle a schedule off`;

function ensureScheduleCreatorCommand() {
  try {
    const commandPath = path.join(SCHEDULE_COMMANDS_DIR, 'create-switchboard-schedule.md');
    if (!fs.existsSync(commandPath)) {
      fs.mkdirSync(SCHEDULE_COMMANDS_DIR, { recursive: true });
      fs.writeFileSync(commandPath, SCHEDULE_CREATOR_TEMPLATE);
    }
  } catch (err) {
    console.error('[schedule] Failed to create schedule command:', err);
  }
}

function init(log) {
  const { parseFrontmatter, createScheduleSession, buildScheduleCommand } = require('./schedule-runner');

  ipcMain.handle('get-schedule-creator-command', () => {
    try {
      const commandPath = path.join(SCHEDULE_COMMANDS_DIR, 'create-switchboard-schedule.md');
      ensureScheduleCreatorCommand();
      return fs.readFileSync(commandPath, 'utf8');
    } catch (err) {
      log.error('[schedule] Failed to read schedule command:', err);
      return null;
    }
  });

  ipcMain.handle('create-schedule-session', (_event, projectPath) => {
    try {
      ensureScheduleCreatorCommand();
      const commandPath = path.join(SCHEDULE_COMMANDS_DIR, 'create-switchboard-schedule.md');
      const systemPrompt = fs.readFileSync(commandPath, 'utf8');

      const sessionId = crypto.randomUUID();
      const msgId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
      const claudeProjectDir = path.join(PROJECTS_DIR, folder);

      fs.mkdirSync(claudeProjectDir, { recursive: true });
      const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);

      const snapshot = JSON.stringify({
        type: 'file-history-snapshot',
        messageId: msgId,
        snapshot: { messageId: msgId, trackedFileBackups: {}, timestamp },
        isSnapshotUpdate: false,
      });

      const assistantMsg = JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd: projectPath,
        sessionId,
        version: '1.0.0',
        gitBranch: 'main',
        slug: 'create-schedule',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: SCHEDULE_WELCOME_MESSAGE }] },
        uuid: msgId,
        timestamp,
      });

      fs.writeFileSync(jsonlPath, snapshot + '\n' + assistantMsg + '\n');
      log.info(`[schedule] Pre-created schedule session ${sessionId} for ${projectPath}`);

      return { sessionId, systemPrompt };
    } catch (err) {
      log.error('[schedule] Failed to create schedule session:', err);
      return null;
    }
  });
  ipcMain.handle('run-schedule-now', (_event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { meta, body } = parseFrontmatter(content);
      if (!body) return { ok: false, error: 'No prompt in schedule file' };

      // Derive project path from the file path: .../projectPath/.claude/commands/schedule-x.md
      const commandsDir = path.dirname(filePath);
      const dotClaudeDir = path.dirname(commandsDir);
      const projectPath = path.dirname(dotClaudeDir);

      const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
      const schedule = {
        file: path.basename(filePath),
        filePath,
        projectPath,
        folder,
        name: meta.name || path.basename(filePath),
        cron: meta.cron || '* * * * *',
        slug: meta.slug || path.basename(filePath, '.md').replace(/^schedule-/, ''),
        cli: meta.cli || {},
        prompt: body,
      };

      const { sessionId } = createScheduleSession(schedule);
      const cmd = buildScheduleCommand(sessionId, schedule);
      const { spawn } = require('child_process');

      const child = spawn('bash', ['-lc', cmd], {
        cwd: projectPath,
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      child.unref();

      child.on('exit', (code) => {
        log.info(`[schedule] Manual run ${schedule.name} finished (exit ${code})`);
      });
      child.on('error', (err) => {
        log.error(`[schedule] Manual run ${schedule.name} error:`, err.message);
      });

      log.info(`[schedule] Manual run triggered: ${schedule.name} (session ${sessionId})`);
      return { ok: true, sessionId };
    } catch (err) {
      log.error('[schedule] Failed to run schedule:', err);
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { ensureScheduleCreatorCommand, init };
