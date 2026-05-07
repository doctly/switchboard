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

## About this fork

This fork exists because the upstream [doctly/switchboard](https://github.com/doctly/switchboard) is a solid foundation, but its design center is the individual developer on the public internet. I needed something that works in a different environment — corporate, offline-capable, and opinionated about what leaves the machine. The changes fall into a few themes:

### Keep everything local

The fork assumes you might not want your voice, your usage data, or your app talking to servers you didn't ask it to. So:

- **Voice dictation runs locally** via whisper.cpp. No cloud STT, no audio leaving the machine. The app manages the whisper-server process — model autodetection, PTT/toggle modes, AltGr-aware hotkeys, and bracketed-paste so long transcripts don't truncate in the terminal.
- **Auto-updates are removed.** The app never contacts GitHub or any update server. You control when to pull and rebuild.
- **Anthropic usage API is removed.** No rate-limit polling, no account metadata calls. The child `claude` process makes its own API calls; the app doesn't phone home on its own.
- **Analytics stay local.** Session stats, token counts, and activity heatmaps are all computed and stored in your SQLite database. Nothing is sent anywhere.

### Lock down the surface area

If this is going to run shell commands and manage file access on a corp machine, the attack surface matters:

- **Path guard** with an explicit whitelist (project directories + `~/.claude/`) and a deny list for credential files (`.ssh`, `.aws/credentials`, `.netrc`, `.gnupg`, SSH keys).
- **MCP auth** — per-session localhost WebSocket with constant-time token comparison, `0600` lockfiles, Origin-header rejection. Binds `127.0.0.1` only.
- **CSP** restricts `connect-src` to `'self'` and `ws(s)://127.0.0.1:*`. No external domains.
- **Renderer** runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- **Shell commands** to the Claude CLI are built with strict validation and POSIX single-quote escaping (`claude-cmd.js`). No string concatenation of user input into shell strings.
- **Deps pinned** to exact versions in `package-lock.json`. `npm install` is blocked by a `preinstall` guard — use `npm ci`.
- **Zero runtime egress** from the app itself. The only outbound call is `shell.openExternal` on a user-clicked link. The child `claude` process makes its own API calls — point it at your internal endpoint with `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`.

### Quality-of-life that compound over hours of use

These aren't architectural — they're the kind of thing you notice when you live in the app all day:

- **Profiles** — named configurations (env vars, API endpoints, model settings) you can assign per session. Switch between internal endpoints, models, or contexts without editing rc files.
- **Window bounds** — the window remembers where you put it, clamps to the active display, and survives restarts correctly even across multi-monitor setups. It doesn't save a maximized state that breaks on a different screen.
- **Taskbar flash** — when Claude needs approval or attention and you're alt-tabbed away, the taskbar (Windows) or dock (macOS) bounces so you don't miss it.
- **Light theme** — complete light-mode stylesheet for every panel (sidebar, viewer panels, session items, settings, dialogs). Not just a color-invert — each element was styled individually.
- **Status dots at a glance** — running, busy, response-ready, and needs-attention states are all visible from the sidebar without opening a terminal. The dots are large enough to actually see.

### Removed from upstream

- Auto-updates (`electron-updater`)
- Anthropic usage API (`claude-auth.js`, Rate-Limits panel)
- Upstream CI workflows (corp build pipeline is separate)

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
