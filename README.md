# Switchboard

Your command center for CLI coding sessions.

Switchboard is a desktop app that gives you a unified view of all your coding agent sessions across every project. Launch, resume, fork, and monitor sessions from a single window — no more juggling terminal tabs or digging through `~/.claude/projects` and `~/.codex/sessions` to find that one conversation from last week.

![Switchboard](build/screenshot.png)

### Supported CLIs

| | Claude Code (`claude`) | Codex (`codex`) |
|---|---|---|
| Browse & search history | ✅ | ✅ |
| Resume a session | ✅ | ✅ |
| Start a new session | ✅ | ✅ |
| Fork a session | ✅ | ✅ |
| Read in the message viewer | ✅ | ✅ |
| Status & activity indicators | ✅ | ✅ |
| IDE emulation (diff review) | ✅ | — |
| Plans & memory files | ✅ | — |

Sessions from both CLIs share one sidebar, each row marked with its own logo. A
fork runs on the CLI that wrote the session being forked.

Turn either CLI off under **CLI Agents** in Settings. A switched-off CLI is not
scanned, not watched, not offered when you start a session, and its sessions are
hidden — but its history is kept, so switching it back on restores everything
straight away. At least one CLI always stays on.

### Key Features

- **Session Browser** — All your sessions from every supported CLI, organized by folder, searchable by content
- **Projects** — Group the work, not the folders: a project has a folder on disk with a brief the agent reads, a plan, a todo list, and the sessions filed under it
- **Built-in Terminal** — Connect to running sessions or launch new ones without leaving the app
- **Project Tasks & Server Logs** — Run `.vscode/tasks.json` commands from a compact project or worktree menu and view their live logs in the built-in terminal
- **Status Notifications** — In-app alerts when a session is waiting for permission approval or user input
- **Fork & Resume** — Branch off from any point in a session's history
- **Full-Text Search** — Find any session by what was discussed, not just when it happened
- **Per-CLI Launch Options** — Claude sessions offer permission mode, worktree and Chrome; Codex sessions offer sandbox policy, approval policy and model. Set them per session, per project, or globally
- **IDE Emulation** (Claude only) — Switchboard acts as an IDE for Claude CLI, showing file diffs and opens in a side panel where you can accept, reject, or edit changes before they're applied. Supports both inline and side-by-side diff views. Disable this in Global Settings if you prefer Claude to use your own editor (VS Code, Cursor, etc.)
- **Plans & Memory** (Claude only) — Browse and edit your plan files and CLAUDE.md memory in one place
- **Activity Stats** — Heatmap of your coding activity across all projects
- **Session Names** (Claude only) — Picks up session names from Claude Code's `/rename` command automatically

## Project Tasks and Server Logs

Switchboard can run the commands in a project's `.vscode/tasks.json` without
requiring a debugger. Use it for development servers, workers, asset watchers,
test suites, or any other long-running project command whose output you want to
keep beside your coding sessions.

- **Compact task launcher** — A play button appears in each project header. In
  worktree headers it appears between the hide and new-session buttons when you
  hover, and stays visible while a task is running.
- **Live, retained logs** — Running a task keeps the menu open and shows its
  state on the row. Clicking a task that has run opens its terminal in the
  main pane; inside a project it opens beside the session list. Output is
  retained when you switch to another session or task, and the selected task
  view is restored after a renderer reload.
- **Independent lifecycle** — Tasks run separately from Claude and Codex
  sessions. Stop or restart them from the terminal header without altering an
  agent transcript.
- **Project and worktree scope** — Commands run with the selected project or
  worktree as `${workspaceFolder}`. A worktree inherits its parent project's
  tasks when it has no `.vscode/tasks.json` of its own; a worktree-local file
  overrides the inherited one.
- **Compound stacks** — `dependsOn` tasks can start several services in
  parallel, making one-click API + worker + frontend stacks possible. Stopping
  the compound stops its child tasks.

For example:

```jsonc
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "API server",
      "type": "process",
      "command": "${workspaceFolder}/.venv/bin/python",
      "args": ["-m", "uvicorn", "app.main:app", "--reload"],
      "options": { "cwd": "${workspaceFolder}" },
      "isBackground": true
    },
    {
      "label": "Frontend",
      "type": "npm",
      "script": "dev",
      "isBackground": true
    },
    {
      "label": "Full stack",
      "dependsOn": ["API server", "Frontend"],
      "dependsOrder": "parallel"
    }
  ]
}
```

Switchboard reads JSON with comments and trailing commas and currently supports
`shell`, `process`, and `npm` tasks, `dependsOn`/`dependsOrder`, task working
directories and environment variables, platform overrides, and an optional
`options.envFile`. Common workspace, home, path-separator, and `${env:NAME}`
variables are expanded. Debug adapters, breakpoints, VS Code command/input
variables, and problem-matcher diagnostics are outside the current scope; the
feature is intentionally focused on running commands and seeing their logs.

## Projects

The Sessions tab groups sessions by the folder they run in. The Projects tab
groups them by the work they belong to.

| | What it is |
|---|---|
| **Project** | A piece of work with a folder on disk. Everything else about it is optional. |
| **Track** | A line of effort inside a project, with its own sessions. Optional. |
| **Session** | Exactly what it is today, plus the project it belongs to. |
| **Folder** | What the Sessions tab shows: a path on disk. A project can attach any number. |

Every project gets a real folder under `~/Switchboard/` (change it under
**Projects Folder** in Global Settings). Switchboard writes a starter brief into
`CLAUDE.md` and `AGENTS.md` there. The brief tells the agent where the
project's files go, and the agent creates them when it first needs them: a
plan the user asks for goes to `plan.md` in whatever form fits,
`plan-tracker.md` is kept beside it as phases with checkboxes so Switchboard
can show progress, follow-ups go to `todos.md`, and anything worth remembering
across sessions goes to `memory.md`. None of them is read at the start of a
session, only when the plan or the todos come up. The brief also lists the
attached folders and tells the agent to read each folder's own instructions
before changing files there. Attaching or detaching a folder updates that
list; the rest of the brief is yours to edit.

Sessions start in the project folder by default. A project or a track can
choose an attached folder instead. Wherever a project session starts,
Switchboard passes the project folder and every attached folder to the CLI as
extra directories, so the agent can read and edit all of them. Claude also
loads the `CLAUDE.md` from each of those directories. Codex only reads
`AGENTS.md` from the folder it starts in, so a Codex session that starts in
an attached folder does not see the project brief. Codex also refuses to
start with extra directories unless its sandbox is `workspace-write` or
`danger-full-access`, so Switchboard's global default for Codex is
`workspace-write`. Choose "Default" in Settings to hand the choice back to
codex's own config; under read-only the extra directories are left off, since
read-only can read every path anyway.

The Projects tab lists projects only. Selecting one opens its **Overview**
page: the brief, the plan's progress, open todos, attached folders, and one
card per track with its latest sessions. Opening a session from there switches
to working mode: a slim project strip on top, a session list beside the
terminal, and the plan and todo counts at the foot of the list. The list can
be grouped by **Time** (today, yesterday, this week...), **Track**, or
**State** (needs input, running, idle). Each row shows the title, the track,
the CLI, its age and message count. Right-click a project, track, or session
for its actions. Projects and sessions are ordered by their last event: a
session started, finished a turn, asked for something, or was opened. A
session that is still working does not move while its transcript grows, so
two working sessions hold their places instead of leapfrogging. Archived
sessions sit in a closed "Archived" line at the foot of the list and under a
track card's foot; one click opens them, dimmed, in place. The
**Settings** tab is a list of rows: the name, the start
folder, folders, the worktree branch, and the tracks. Changes save as you
make them. Folder rows show the branch each folder is on, read from git when
the page opens, and "modified" when it has uncommitted changes.

![Project View overview](build/project-view-overview.png)

![Project View session workspace](build/project-view-session.png)

![Project View new session menu](build/project-view-new-session-menu.png)

![Project View plan and todos](build/project-view-plan.png)

- **New project** — Name it, pick a template, and attach the folders it works
  in. The dialog shows what Create will make: the project folder and its
  files, each worktree on its branch, and the tracks the template adds. Start
  sessions from the overview; they are filed under the project and still show
  under their folder in the Sessions tab.
- **Tracks** — Optional lines of work inside a project, each with its own
  sessions, start folder and CLI. A track card's "Resume latest" reopens its
  most recent session; "New" starts one there.
- **Plan tab** — The phases in `plan-tracker.md` with their items, the todos,
  and which sessions started or finished each one. Tick items in place, or
  start a session on a phase or a todo: it opens with that item as its first
  prompt, filed under the project. A plan written in Claude Code's plan mode
  can be adopted into a project from the Plans list.
- **Templates** — New project offers Feature, Research and Customer. A
  template is a folder under the app's data directory with a
  `template.json` (name, description, tracks) and the files a new project
  starts with; its `CLAUDE.md` becomes the top of the brief. Edit them or add
  your own from Global Settings.
- **Worktrees** — Attaching a plain folder uses it where it is. Attaching a
  git repository asks how the project should work in it: as it is, on
  whatever branch is checked out, or with its own checkout under the project
  folder (`repos/<name>`), on one branch shared
  by every worktree in the project, or one you name per repository. The
  worktree inherits the repository's `.vscode/tasks.json`. For Codex,
  Switchboard writes an `AGENTS.override.md` into the worktree carrying the
  project brief (and the repository's own `AGENTS.md`), excluded from git.
  Marking a project done offers to remove its worktrees; branches stay.
- **Move to project** — Any session row has a move action. Nothing is filed
  until you launch it from a project or move it there.
- **Play button** — A project's task menu combines the `.vscode/tasks.json`
  tasks from every attached folder.
- **Mark as done** — Done projects drop to the bottom, collapsed. Removing a
  project only forgets it; the folder and the sessions stay on disk.

## Session Grid Overview

Toggle the grid overview from the sidebar for a bird's-eye view of all your open sessions at once, grouped by project.

![Session Grid Overview](build/screenshot-grid.png)

- **Live terminals** — Every open session renders its full terminal in a card, so you can monitor multiple agents simultaneously, whichever CLI each one is running.
- **Status at a glance** — Each card shows a running/stopped/busy indicator dot and last-activity timestamp.
- **Click to focus, double-click to expand** — Click a card header to focus it; double-click to switch back to single-terminal view for that session.
- **Persistent** — Grid preference is saved across restarts.

## File Preview Side Panel & Claude IDE MCP Emulator

Switchboard can act as an IDE for your Claude Code sessions. This one is Claude-only — it speaks Claude CLI's own IDE protocol, and Codex sessions are launched without it. When enabled, Claude's file opens and proposed edits appear in a side panel next to the terminal instead of being sent to an external editor.

![IDE Emulation](build/screenshot-ide.png)

- **Diff review** — When Claude proposes a file change, it shows up as a diff in the side panel. You can review the changes and accept or reject them directly.
- **Inline & side-by-side** — Toggle between inline (unified) and side-by-side diff views. Your preference is remembered across sessions.
- **Partial acceptance** — In inline mode, you can accept or reject individual chunks within a diff, then submit the final result.
- **File viewer** — Clickable file links in terminal output (OSC 8 hyperlinks) open in the side panel with syntax highlighting.

To disable IDE emulation entirely (e.g. if you want Claude to use VS Code or Cursor instead), uncheck **IDE Emulation** in **Global Settings**. This stops Switchboard from registering as an IDE, so Claude CLI will discover and connect to your real editor. Changes take effect on new sessions — running sessions are not affected.

## Status Notifications

Switchboard monitors all your sessions in the background — Claude and Codex alike — and shows status indicators in the sidebar so you can tell at a glance which sessions need attention, even when you're working in a different one.

![Status Notifications](build/screenshot-notifications.png)

- **Waiting for input** — A session that needs your response is highlighted so you don't miss it.
- **Permission approval** — When a session is blocked waiting for a permission grant or an approval, its badge lets you know immediately. Switchboard reads each CLI's own wording, so Claude's permission prompts and Codex's approval requests both register.
- **Activity indicators** — See which sessions are actively running, idle, or finished.

## Editor

| Shortcut | Action |
|----------|--------|
| `Cmd+F` / `Ctrl+F` | Find in file (also works in terminal) |
| `Cmd+G` / `Ctrl+G` | Go to line |

## Download

Grab the latest release for your platform:

**[Download Switchboard](https://github.com/doctly/switchboard/releases/latest)**

- **macOS**: `.dmg` (Apple Silicon & Intel)
- **Windows**: `.exe` installer
- **Linux**: `.AppImage`, `.deb`, or `.pacman` (Arch/Manjaro)

## Prerequisites

- **Node.js** 20+
- **npm** 10+
- Platform build tools for native modules:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential`, `python3` (`sudo apt install build-essential python3`)
  - **Windows**: Visual Studio Build Tools or `npm install -g windows-build-tools`

## Development Setup

```bash
# Install dependencies (runs postinstall automatically)
npm install

# Start the app
npm start
```

`npm start` bundles CodeMirror and launches Electron. For faster iteration after the first run:

```bash
npm run electron
```

## Building

All build commands bundle CodeMirror first, then invoke electron-builder.

```bash
# Current platform
npm run build

# Platform-specific
npm run build:mac     # DMG + zip (arm64 + x64)
npm run build:win     # NSIS installer (x64 + arm64)
npm run build:linux   # AppImage + deb + pacman (x64 + arm64)
```

Output goes to `dist/`.

### Building on Arch / Manjaro

The `deb` and `pacman` targets are built via the `fpm` binary bundled by
electron-builder, which links against `libcrypt.so.1`. Arch ships `libxcrypt`
without that legacy ABI, so install the compat shim once:

```bash
sudo pacman -S libxcrypt-compat
```

`AppImage` builds without it.

The pacman package is published as **`switchboard-doctly`** rather than
`switchboard` because the Arch `extra` repo already ships a package named
`switchboard` (elementary OS's Pantheon Control Center). Renaming avoids the
file-conflict that would block installation alongside it. The app itself is
still called Switchboard everywhere users see it — only the package identity
changes. Uninstall later with `sudo pacman -R switchboard-doctly`.

## Releasing

Releases are driven by git tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow builds for all platforms and publishes to GitHub Releases. You can also release locally:

```bash
npm run release   # builds + publishes to GitHub Releases
```

Set `GH_TOKEN` in your environment (a GitHub personal access token with `repo` scope).

## Auto-Updates

The app uses `electron-updater` to check for updates from GitHub Releases on launch and every 4 hours. Updates are only checked in packaged builds (not during development). The flow:

1. App auto-downloads updates in the background
2. A toast notification appears when the update is ready
3. User can restart immediately or dismiss (installs on next quit)

## Code Signing

For distribution, set these environment variables:

- **macOS**: `CSC_LINK` (p12 certificate) and `CSC_KEY_PASSWORD`, or sign via Keychain
- **Windows**: `CSC_LINK` and `CSC_KEY_PASSWORD` for EV/OV code signing
- Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing (CI artifact builds)

The macOS build uses custom entitlements (`build/entitlements.mac.plist`) to allow JIT and unsigned memory execution, required by native modules (node-pty, better-sqlite3).

## Project Structure

```
main.js            Electron main process
preload.js         Context bridge (IPC bindings)
db.js              SQLite session cache & metadata
harnesses/         Per-CLI modules (claude, codex) + registry
public/            Renderer (HTML/CSS/JS)
scripts/           Build & postinstall scripts
build/             Icons, entitlements, builder resources
.github/workflows/ CI/CD
```
