# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (compiles native modules node-pty and better-sqlite3)
npm install

# Start the app (bundles CodeMirror, then launches Electron with hot-reload)
npm start

# Faster iteration after first run (skips CodeMirror bundle step)
npm run electron

# Rebundle CodeMirror only (needed after editing public/codemirror-setup.js)
npm run bundle:codemirror

# Run tests
npm test

# Run a single test file
node --test test/folder-index-state.test.js

# Build for distribution
npm run build:mac     # DMG + zip (arm64 + x64)
npm run build:win     # NSIS installer
npm run build:linux   # AppImage + deb
```

Tests use Node's built-in `node:test` runner — no Jest or Mocha.

## Architecture

Switchboard is an **Electron app** that acts as a session manager and IDE emulator for Claude Code CLI. The app has the standard Electron split:

- **Main process** (`main.js`) — all Node.js/filesystem/PTY logic. Communicates with the renderer via IPC.
- **Renderer process** (`public/`) — plain HTML/CSS/JS, no framework. Receives `window.api` from the preload bridge.
- **Preload** (`preload.js`) — context bridge that exposes `window.api` to the renderer. Every IPC channel is declared here.

### Data flow

1. Claude Code stores sessions as `.jsonl` files under `~/.claude/projects/<encoded-path>/`.
2. `main.js` watches this directory for changes and keeps a **SQLite cache** (`~/.switchboard/switchboard.db` via `db.js`) of session metadata and a full-text search index.
3. The cache is populated either via a **Worker thread** (`workers/scan-projects.js`) on first load or incrementally via `session-cache.js` when the watcher detects `.jsonl` changes.
4. The renderer calls `window.api.getProjects()` → IPC → `buildProjectsFromCache()` to get the project/session tree.

### Key modules

| File                                     | Role                                                                                                                                                       |
|------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `db.js`                                  | SQLite schema, migrations, all DB read/write helpers                                                                                                       |
| `session-cache.js`                       | In-memory + DB cache management; incremental folder refresh                                                                                                |
| `session-transitions.js`                 | Detects fork/plan-accept transitions in active PTY sessions by watching for new `.jsonl` files                                                             |
| `mcp-bridge.js`                          | Per-session WebSocket MCP server — registers Switchboard as a VS Code–compatible IDE so Claude CLI sends diffs/file-opens here instead of to a real editor |
| `derive-project-path.js`                 | Decodes encoded folder names back to filesystem paths                                                                                                      |
| `encode-project-path.js`                 | Encodes a filesystem path to the `~/.claude/projects/<folder>` naming convention                                                                           |
| `shell-profiles.js`                      | Shell discovery (zsh, bash, WSL) and argument construction for PTY spawning                                                                                |
| `schedule-runner.js` / `schedule-ipc.js` | Cron-style scheduled task support                                                                                                                          |
| `workers/scan-projects.js`               | Worker thread for initial full-scan of `~/.claude/projects/`                                                                                               |
| `public/app.js`                          | Renderer entry point; top-level state and routing between sidebar views                                                                                    |
| `public/sidebar.js`                      | Left sidebar: project/session list, search, starred/archived filters                                                                                       |
| `public/terminal-manager.js`             | xterm.js terminal instances, PTY attach/detach, grid view                                                                                                  |
| `public/viewer-panel.js`                 | Right panel: file viewer + diff review UI (CodeMirror)                                                                                                     |
| `public/codemirror-setup.js`             | CodeMirror bundle entry (dev dependency; output is `public/codemirror-bundle.js`)                                                                          |

### IDE emulation (MCP bridge)

When a Claude session starts, `main.js` calls `startMcpServer()` which binds a WebSocket server on a random port and writes a lock file to `~/.claude/ide/`. Claude CLI discovers this file and connects, treating Switchboard as an IDE. File diffs proposed by Claude arrive as `openDiff` MCP calls, which `main.js` forwards to the renderer via `mcp-open-diff` IPC. The renderer shows them in `viewer-panel.js`. The user's accept/reject/edit decision comes back as `mcpDiffResponse` IPC → `resolvePendingDiff()`.

### Settings

Settings are stored in SQLite (`settings` table) keyed by `"global"` or `"project:<path>"`. Defaults are defined in `SETTING_DEFAULTS` in `main.js`. The renderer always calls `getEffectiveSettings(projectPath)` to get merged global+project values.

### Session identity and fork detection

When a new Claude session is spawned with `--fork-session` or a plan is accepted, a new `.jsonl` file appears with a different session UUID. `session-transitions.js` monitors active PTY sessions for new files in their project folder and matches them to the correct parent via `forkedFrom` or `parentSessionId` fields in the JSONL. Once matched, it re-keys the active session map and notifies the renderer.
