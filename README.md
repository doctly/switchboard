# Switchboard

Desktop app for managing local Claude Code CLI sessions. This is a fork of [doctly/switchboard](https://github.com/doctly/switchboard) — see below for what's different and why.

## Changes from upstream

This fork exists because upstream's design center is the individual developer on the public internet. I needed something that works in a different environment — corporate, offline-capable, and opinionated about what leaves the machine.

### What's been added

| Area | What changed |
|------|-------------|
| **Voice dictation** | Local whisper.cpp integration — managed whisper-server process, nothing leaves the machine. PTT/toggle modes, AltGr-aware hotkeys, transcript preview, bracketed-paste injection, model autodetection. |
| **Profiles** | Named configuration profiles per session with env-var overrides, presets, and profile icons. Switch between internal endpoints, models, or contexts without editing rc files. |
| **Analytics** | Session-level usage stats, token counts, model usage, tool call frequency. Activity heatmap, aggregated charts, background aggregation worker. All stored locally in SQLite. |
| **Window bounds** | Remembers where you put it, clamps to the active display, survives restarts across multi-monitor setups. Doesn't save a maximized state that breaks on a different screen. Hard caps + 17 contract tests. |
| **Taskbar flash** | Flashes the Windows taskbar / bounces the macOS dock when Claude needs approval or attention and the window isn't focused. |
| **Light theme** | Complete light-mode stylesheet for every panel — sidebar, viewer panels, session items, settings, dialogs. Each element styled individually, not a color-invert. |
| **Status dots** | Running, busy, response-ready, and needs-attention states visible from the sidebar. Dots enlarged for actual visibility. |
| **Scheduled tasks** | Cron-based recurring Claude Code tasks with AI-selected permissions, auto-accept edits, and sidebar integration. |
| **Skins / branding** | Runtime skin loader with `SWITCHBOARD_SKIN` env var support. Drop in icons, colors, and product name per build. |
| **Build-and-run** | One-command build + launch per platform (`npm run build-and-run`). No hunting for the output binary. |

### What's been hardened

| Area | What changed |
|------|-------------|
| **Path guard** | IPC file-path whitelist (project dirs + `~/.claude/`) with deny list for credential files (`.ssh`, `.aws/credentials`, `.netrc`, `.gnupg`, SSH keys). |
| **MCP auth** | Per-session localhost WebSocket with constant-time token comparison, `0600` lockfiles, Origin-header rejection. Binds `127.0.0.1` only. |
| **CSP** | `connect-src` restricted to `'self'` and `ws(s)://127.0.0.1:*`. No external domains. |
| **Renderer** | Sandboxed with context isolation, no Node integration. |
| **Shell commands** | Built with strict validation and POSIX single-quote escaping (`claude-cmd.js`). No string concatenation of user input into shell strings. |
| **Deps** | Pinned to exact versions in `package-lock.json`. `npm install` blocked by a preinstall guard — use `npm ci`. |
| **No auto-updates** | `electron-updater` removed. The app never contacts GitHub or any update server. |
| **No usage API** | `claude-auth.js` and Rate-Limits panel removed. The child `claude` process makes its own API calls; the app doesn't phone home. |
| **Zero runtime egress** | The only outbound call from the app itself is `shell.openExternal` on a user-clicked link. |

## Core features

### Session management
- Browse, launch, resume, and fork Claude Code sessions across projects
- Full-text search across session history (titles, summaries, and message content)
- Project grouping with collapse/expand, archive, and reorder
- Worktree-aware sidebar — nested session groups for git worktrees
- Star and archive sessions for triage
- Filter toggles: starred, archived, running, today

### Terminal & diff review
- Built-in xterm.js terminal with WebGL rendering, search, and web links
- MCP-based diff/file review panel — view patches and file changes inline
- JSONL viewer for browsing raw conversation logs with collapsible tool results
- Plans viewer (`CLAUDE.md` plans directory) and Memory viewer in side panels

### Real-time session status
Switchboard parses OSC escape sequences from each Claude CLI PTY and surfaces state:

- **Busy / idle** — spinner indicator on sidebar entries when Claude is processing
- **Attention needed** — orange ripple badge when Claude needs approval, permission, or attention
- **Taskbar flash** — Windows taskbar / macOS dock bounces when attention is needed and the window isn't focused
- **Response ready** — blue dot when Claude finishes and has unread output
- **Status bar** — free-form status messages from the main process

## Build / run

```bash
npm ci                          # reproducible install; npm install is blocked
npm start                       # bundles codemirror + runs electron in dev mode
npm run build-and-run           # build for current platform + open the app
npm test                        # node --test
```

Platform-specific builds:

```bash
npm run build:mac               # macOS (DMG + zip, both archs)
npm run build:win               # Windows (NSIS installer)
npm run build:linux             # Linux (AppImage + deb)
npm run build-and-run:win       # Windows portable build + launch
npm run build-and-run:mac       # macOS build + open .app
npm run build-and-run:linux     # Linux build + launch AppImage
```

Output in `dist/`.

## Reskin / rebrand

Skins live under `skins/<name>/` — see [`skins/README.md`](skins/README.md) for the full workflow. Quick version:

```bash
cp -r skins/switchboard skins/<name>
$EDITOR skins/<name>/branding.json        # edit productName, appId, ...
# drop in icon.png / icon.icns / icon.ico / dmg-background.png
SWITCHBOARD_SKIN=<name> npm run build:mac
```

`skins/*` other than `skins/switchboard/` is git-ignored, so private skins stay local.

## Env vars

| Var | Purpose |
|-----|---------|
| `ANTHROPIC_BASE_URL` | Private Anthropic gateway for the child `claude` process |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | Token for the child `claude` process |
| `CLAUDE_CONFIG_DIR` | Override `~/.claude` |
| `SWITCHBOARD_SKIN` | Skin name under `skins/<name>/` (default `switchboard`) |
| `SWITCHBOARD_BRANDING` | Absolute path to a skin directory or `branding.json` (overrides `SWITCHBOARD_SKIN`) |
| `SWITCHBOARD_ALLOW_NPM_INSTALL=1` | Bypass the preinstall guard to add a new dep |

## Prereqs

- Node.js 20+, npm 10+
- Native build tools: Xcode CLT (macOS), `build-essential python3` (Linux), VS Build Tools (Windows)
- Optional: [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for local voice dictation

## Layout

```
main.js                 Electron main process
preload.js              IPC bridge
db.js                   SQLite cache + settings
path-guard.js           IPC file path whitelist
claude-cmd.js           Shell-escaped claude CLI command builder
mcp-bridge.js           Per-session localhost MCP WebSocket server
mcp-auth.js             MCP token auth
branding.js             Runtime branding loader
profiles.js             Session profile management
session-profiles.js     Per-session profile bindings
whisper-manager.js      Local whisper.cpp process manager
analytics.js            Session analytics collector
analytics-aggregator.js Background stats aggregation worker
window-bounds.js        Window bounds with display clamping + multi-monitor
skins/<name>/           Branding assets (default: skins/switchboard/)
public/                 Renderer (HTML/CSS/JS)
scripts/                Build helpers (branding, icons, codesign, build-and-run)
test/                   node:test suites
```
