# Context: ipc-bridge

**Purpose**: The trust boundary between the Electron main process (Node, full filesystem) and the renderer (Chromium, sandboxed). The renderer can only call what `preload.js` exposes via `contextBridge`; everything else is denied.

This file is the **canonical inventory** of the IPC surface. When you add a new IPC, you change three places — main handler, preload bridge, renderer caller — and every IPC name should appear here.

## Key files

| File | LOC | Role |
|---|---|---|
| `preload.js` | ~130 | The `contextBridge.exposeInMainWorld('api', {...})` block. Every renderer-facing function. |
| `main.js` | ~1850 | The `ipcMain.handle('<name>', ...)` and `ipcMain.on('<name>', ...)` handlers, scattered throughout. |

## Public surface (IPC inventory)

### Sessions (request/response)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `get-projects` | `(showArchived)` | `Project[]` | Sidebar payload. Reads from cache. |
| `get-active-sessions` | — | `Session[]` | Currently open PTY sessions |
| `get-active-terminals` | — | `Terminal[]` | Active PTY identifiers |
| `open-terminal` | `(id, projectPath, isNew, sessionOptions)` | `{ok, error?, mcpActive}` | Spawn or attach a PTY. |
| `stop-session` | `(id)` | `{ok}` | Kill the PTY for `id`. |
| `toggle-star` | `(id)` | `{ok}` | Star/unstar in session_meta. |
| `rename-session` | `(id, name)` | `{ok}` | Set customTitle. |
| `archive-session` | `(id, archived)` | `{ok}` | Move to archive. |
| `read-session-jsonl` | `(sessionId)` | `Entry[]` | Full transcript. |
| `read-subagent-jsonl` | `(parentSessionId, agentId)` | `Entry[]` | Subagent transcript. |
| `list-subagents` | `(parentSessionId)` | `Subagent[]` | All children of a parent. |
| `start-subagent-watch` | `(parentSessionId, agentId)` | `watchId` | Begin tailing. |
| `stop-subagent-watch` | `(watchId)` | `{ok}` | Tear down watch. |

### Projects + worktrees

| IPC | Args | Notes |
|---|---|---|
| `browse-folder` | — | Native folder picker |
| `add-project` | `(projectPath)` | Register a project (creates folder index) |
| `remove-project` | `(projectPath)` | Hide a project from sidebar |
| `remap-project` | `(oldPath, newPath)` | **Atomic JSONL `cwd` rewrite**, refuses if active sessions exist. See PR #20. |
| `delete-worktree` | `(worktreePath)` | `git worktree remove` |
| `worktree-status` | `(worktreePath)` | Dirty-file count |

### Tabs (Plans / Memory / .work-files / Stats)

| IPC | Returns |
|---|---|
| `get-plans` | `Plan[]` (reads `~/.claude/plans/*.md`) |
| `read-plan` / `save-plan` | content / `{ok}` |
| `get-memories` | `{global, projects}` |
| `read-memory` / `save-memory` | content / `{ok}` |
| `get-work-files` | `{projects: WorkFilesProject[]}` — **dedupes by projectPath** since PR #15. Walks `<projectPath>/.work-files/` recursively, capped at 200 files per project. |
| `read-work-file` / `delete-work-file` | content (with `.work-files/` path guard) / `{ok}` |
| `get-stats-from-db` | `{dailyActivity, totalMessages, totalSessions, firstSessionDate, lastComputedDate}` — heatmap source since PR #7 |
| `refresh-stats` | `{stats, usage}` — combined; calls `getDailyActivity` + `fetchAndTransformUsage` |
| `get-usage` | rate-limits payload from Claude `/usage` |
| `get-stats` | `~/.claude/stats-cache.json` raw (legacy; kept for fallback) |

### Search

| IPC | Args | Returns |
|---|---|---|
| `search` | `(type, query, titleOnly)` | FTS5 result rows. `type ∈ {session, subagent, plan, memory, work-file, null}` |
| `rebuild-cache` | — | Force a full re-index (heavy) |

### Settings

| IPC | Notes |
|---|---|
| `get-setting` / `set-setting` / `delete-setting` | Generic key/value over `settings` table |
| `get-effective-settings` | `(projectPath)` — resolves global + project overrides |
| `get-shell-profiles` | Configured shell list |
| `get-schedule-creator-command` / `create-schedule-session` / `run-schedule-now` | Schedule integration |

### File panel (IDE mode)

| IPC | Args |
|---|---|
| `read-file-for-panel` / `save-file-for-panel` | Arbitrary file IO inside the user's projects |
| `watch-file` / `unwatch-file` | fs.watch wrapper, emits `file-changed` event |

### Misc

| IPC | Notes |
|---|---|
| `open-external` | Opens https:// URLs in OS browser |
| `clipboard-write-text` | Main-process clipboard write (Wayland fix, PR #18) |
| `get-app-version` | From package.json |
| `updater-check` / `updater-download` / `updater-install` | electron-updater |

### Send (fire-and-forget, renderer → main)

| IPC | Notes |
|---|---|
| `terminal-input` | Forward keypress to PTY |
| `terminal-resize` | Resize PTY columns/rows |
| `close-terminal` | Renderer signals tab closed |
| `mcp-diff-response` | Diff accept/reject from MCP IDE mode |

### Events (main → renderer)

`terminal-data`, `session-detected`, `process-exited`, `terminal-notification`, `cli-busy-state`, `session-forked`, `subagent-spawned`, `subagent-completed`, `subagent-watch-event`, `projects-changed`, `status-update`, `file-changed`, `mcp-open-diff`, `mcp-open-file`, `mcp-close-all-diffs`, `mcp-close-tab`, `updater-event`

## Invariants

- **No `nodeIntegration` in renderer**. The renderer can only call what's in `window.api`. `contextIsolation: true` is mandatory in BrowserWindow options.
- **Every IPC must validate its arguments** at the main-side handler. The renderer is trusted-ish (single user, single window) but a compromised renderer should not be able to escape the user's working directories.
- **Path-touching IPCs (`read-work-file`, `delete-work-file`, `read-memory`, etc.) MUST guard their paths**. Pattern: `path.resolve(input).includes('/.work-files/')` for the work-files IPC. Audit every new path IPC.
- **Trust boundary is the contextBridge call**. Anything passed across must survive structured-clone serialization. No functions, no DOM nodes, no class instances — only plain JSON.
- **Async handlers return promises**. Renderer uses `await window.api.foo(...)`. Throws cross the boundary as rejected promises; return `{ok, error}` if you want graceful failure handling on the renderer side.

## Non-obvious behaviors

- **`preload.js` is the *single* surface the renderer sees**. If you add `ipcMain.handle('xyz', ...)` but forget to add `xyz: () => ipcRenderer.invoke('xyz')` in preload, the renderer can't call it. Symptom: `window.api.xyz is not a function`.
- **Webcontents `send` events vs `invoke`**: `invoke`/`handle` is request-response (returns a promise). `send`/`on` is fire-and-forget (no return). Pick based on whether the caller needs the result.
- **`webUtils.getPathForFile(file)`** is the only way to get the absolute path of a drag-and-dropped file in Electron 28+. Exposed at `window.api.getPathForFile`.
- **Updater events use a single `onUpdaterEvent(type, data)` callback** for all 5+ event types — different from the per-event onSubagentSpawned/Completed pattern. Inconsistency tax.

## If you change this, also check

- **Three places per new IPC**: handler in `main.js`, bridge entry in `preload.js`, caller in `public/*.js` (and maybe `eslint.config.js` if you expose a new global).
- `eslint.config.js` `rendererCrossFileGlobals` — renderer functions exposed across `<script>` tags must be declared
- Any new event needs both an `ipcRenderer.on` in preload and an `mainWindow.webContents.send` in main
- If you change argument shapes, the renderer callers break silently (no type check) — search for callers before changing signatures

## How to add a new IPC

1. `main.js`: `ipcMain.handle('my-thing', (_event, arg1, arg2) => { /* validate, do, return */ })` — place near related handlers, not at random.
2. `preload.js`: `myThing: (arg1, arg2) => ipcRenderer.invoke('my-thing', arg1, arg2)` — add to the alphabetical-ish block.
3. Renderer: `const result = await window.api.myThing(...)`
4. Test: prefer a unit test for the main-side logic (extract to a pure function the handler calls); jsdom integration tests for renderer side.
5. Document here.
