# Context engineering — Switchboard

Five sub-system docs, ~150 lines each, written for AI agents who need to make a focused change without re-reading 1800 LOC of `main.js`.

## When to read which

| Touching this area | Read |
|---|---|
| SQLite, indexing, search, heatmap aggregation, fs.watch | [session-cache](session-cache.md) |
| Cron schedules, schedule `.md` files, `claude --resume -p` spawn | [schedule-runner](schedule-runner.md) |
| Subagent sidebar grouping, transcript view, parent→child wiring | [subagent-observability](subagent-observability.md) |
| Plans/Memory/.work-files tabs, CodeMirror panel, format/delete buttons | [viewer-panel](viewer-panel.md) |
| New IPC, preload bridge changes, renderer ↔ main protocol | [ipc-bridge](ipc-bridge.md) |
| File-trigger watcher, harness input injection, idle-wait | [trigger-watcher](trigger-watcher.md) |

## Reading order for a new contributor (~30 min)

1. **`ipc-bridge`** — gives you the public surface of the whole app in one page
2. **`session-cache`** — gives you the data model
3. **`subagent-observability`** — the #1 fork-specific feature, touches everything
4. **`viewer-panel`** — the reusable read/edit-file framework
5. **`schedule-runner`** — least-cross-cutting; safe to skip if you're not touching schedules

## What's NOT in these contexts (intentionally)

- **Terminal management** — xterm.js + node-pty integration in `public/terminal-manager.js`. Not yet documented because it's largely upstream code with minor extensions. If you're working there, read the file directly.
- **MCP / IDE emulation** — file diff panel, OSC 8 hyperlinks, etc. Lives in `public/file-panel.js` and `main.js` MCP bridge handlers. Not yet documented; in-flight upstream work.
- **Settings UI** — per-project + global, lives in `public/settings-panel.js`. Mostly self-contained, low coupling.
- **Sidebar rendering details** — covered piecemeal in subagent-observability + session-cache; the full sidebar is `public/sidebar.js`. If you're doing UI work there, expect to read the file.
- **Build / electron-builder** — covered in [README.md](../../README.md). Not a code area an agent typically modifies.

## Updating these docs

When a feature lands, the corresponding context doc should change in the same PR. **If you can't decide which context owns a change, it probably means a new sub-system is emerging — write a new doc instead of stretching an existing one.**

Pre-existing observations / nits found while writing these docs are captured in [_issues.md](_issues.md). They're not blockers but worth a follow-up when adjacent work happens.
