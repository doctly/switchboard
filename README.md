# Switchboard

Desktop app for managing local Claude Code CLI sessions. Hardened fork for corp / offline use.

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

### Voice dictation (fork addition)
- Local whisper.cpp integration — managed whisper-server process, nothing leaves the machine
- Push-to-talk and toggle dictation modes
- Configurable hotkey with AltGr-aware modifier matching
- Transcript preview and inline error display
- Bracketed-paste injection so long transcripts don't truncate
- Auto-detects `C:\whisper-cpp\` and project-root `models/` for model files

### Profiles system (fork addition)
- Named configuration profiles per session: env vars, API endpoints, model settings
- Profile presets for common setups
- Per-session override of `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and other env vars
- Profile icons and visual identity in the sidebar

### Analytics (fork addition)
- Session-level usage stats: token counts, model usage, tool call frequency
- Activity heatmap and aggregated charts
- Aggregation worker for background stat crunching

### Scheduled tasks (fork addition)
- Create recurring Claude Code tasks with cron expressions
- AI-selected permission grants and auto-accept edits
- Sidebar icon for task monitoring

## Changes from upstream

This fork adds significant functionality on top of [doctly/switchboard](https://github.com/doctly/switchboard):

| Area | What changed |
|------|-------------|
| **Voice** | Local whisper.cpp dictation with PTT/toggle, model autodetection, transcript preview, AltGr hotkeys, bracketed-paste injection |
| **Profiles** | Full session-profile system with env-var overrides, presets, and profile icons |
| **Analytics** | Session stats aggregation, usage charts, activity heatmap |
| **Window** | Bounds clamping to display work area, normal-bounds persistence, multi-monitor support, hard caps + contract tests |
| **Taskbar** | Flash on attention/approval prompts when window isn't focused |
| **Light theme** | Complete light-mode stylesheet for sidebar, viewer panels, session items, settings, dialogs |
| **Path guard** | IPC file-path whitelist with deny list for credentials and sensitive files |
| **MCP auth** | Per-session localhost WebSocket with constant-time token comparison, 0600 lockfiles |
| **Branding** | Runtime skin/branding loader with `SWITCHBOARD_SKIN` env var support |
| **CSP** | Content-Security-Policy restricting connect-src to self + localhost WebSocket |
| **Build** | `build-and-run` scripts for one-command build + launch per platform |
| **Scheduled tasks** | Cron-based recurring Claude tasks with sidebar integration |
| **Security** | IPC hardening, sandboxed renderer, context isolation, no auto-updates, no usage API calls |

### Removed from upstream
- **Auto-updates** — `electron-updater` removed; the app never contacts GitHub
- **Anthropic usage API** — `claude-auth.js` and Rate-Limits panel removed
- **CI workflows** — upstream `.github/workflows/` removed (corp build pipeline is separate)

## Offline / corp posture

- **No auto-updates.** The app never contacts GitHub.
- **No Anthropic usage API.** Rate-limits and account panels are removed.
- **CSP** restricts `connect-src` to `'self'` + `ws(s)://127.0.0.1:*`.
- **Renderer** runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- **IPC path access** goes through a whitelist (project dirs + `~/.claude/`) with a deny list for `.credentials.json`, `.ssh`, `.aws/credentials`, `.netrc`, `.gnupg`, `id_rsa/id_ed25519`.
- **Shell commands** to the Claude CLI are built with strict validation + POSIX single-quote escaping (`claude-cmd.js`).
- **MCP WebSocket** binds `127.0.0.1` only; auth token compared in constant time; lockfile `0600`; Origin-header connections rejected.
- **Deps pinned** to exact versions in `package-lock.json`. `npm install` is blocked by a `preinstall` guard — use `npm ci`.

Outbound network:

- **Zero runtime egress** from Switchboard itself (other than `shell.openExternal` on a user-clicked terminal link).
- The child `claude` process makes its own calls; point it at your internal endpoint with `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in `~/.zshrc`. `window.api.reloadShellEnv()` re-sources rc files without an app restart.

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
