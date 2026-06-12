# Context: trigger-watcher

**Purpose**: lets external harness scripts inject keyboard input into open PTY sessions without any Electron IPC.  The primary use case is the token-usage harness calling `/compact` on a session when it detects a high context-window fill.

## Key files

| File | LOC | Role |
|---|---|---|
| `trigger-watcher.js` | ~175 | The entire module: directory setup, `fs.watch` listener, idle-wait logic, PTY write, result file. |
| `main.js` (wiring) | 15 | `require('./trigger-watcher').start(ctx)` in the `app.whenReady` block, right after `startScheduler`. |

## Public surface

### `start(ctx)` → `{ close() }`

Starts the watcher.  Call once at app boot.

```js
require('./trigger-watcher').start({
  log,                         // electron-log compatible
  getPtyForSession(sessionId), // → { ptyProcess } | null
  isSessionBusy(sessionId),    // → boolean
});
```

`getPtyForSession` returns `null` when the session is unknown or has already exited.
`isSessionBusy` reads `session._cliBusy` — the same flag that tracks OSC 0 title-change spinner chars.

The returned `{ close() }` handle is not held by `main.js` (no graceful-close needed — Electron kills the process, and `persistent: false` is not set so the watcher keeps the event loop alive naturally).

## Trigger file contract

Drop a file at `SWITCHBOARD_TRIGGERS_DIR/<uuid>.json` (default `~/.switchboard/triggers/`):

```json
{
  "sessionId": "abc-123-def",
  "command": "/compact",
  "wait": "idle",
  "timeout_ms": 120000
}
```

Fields:
- `sessionId` — must match a key in `activeSessions` (`main.js`)
- `command` — written verbatim as `command + '\r'` to the PTY
- `wait` — `"none"` (default) | `"idle"`.  `"idle"` polls `isSessionBusy` every 100 ms until the session goes idle or the timeout fires.
- `timeout_ms` — optional positive integer, ≤ 600 000 ms.  Overrides both the env var and the default for this trigger only.  On invalid value → `{ok:false, error:"invalid timeout_ms"}`, semaphore released, no PTY write.

**Timeout precedence**: per-trigger `timeout_ms` > `SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS` env var > compiled default (300 000 ms).

Result written to `SWITCHBOARD_TRIGGERS_DIR/processed/<uuid>.result.json`:

```json
{ "ok": true,  "sessionId": "...", "command": "...", "sent_at": "...", "waited_ms": 320 }
{ "ok": false, "error": "<reason>", "sessionId": "..." }
```

Trigger file is **deleted** after processing (success or failure).

## Invariants

- **Never throws out of the watcher callback** — every error path lands in the result file.
- **Deduplication via `inFlight` Set** — noisy `rename` events for the same file (common on Linux inotify) are coalesced; a file is processed at most once per appearance.
- **`accessSync` guard** — the `rename` event fires both on file creation and deletion; the existence check prevents processing a deletion event.
- **Directories ignored** — non-`*.json` filenames and any name containing `/` or `path.sep` are skipped.
- **Invalid `timeout_ms` releases the semaphore** — validation happens before the session look-up and before acquiring an idle-wait slot; a bad value produces a result file and returns without counting against `MAX_INFLIGHT`.

## Non-obvious behaviors

- **OSC-title-based busy detection**: `session._cliBusy` is set to `true` by the OSC 0 handler in `main.js` when the title starts with a Braille spinner char (U+2800–U+28FF), and back to `false` when the ✳ idle char (U+2733) appears.  The trigger watcher reuses this flag directly via `isSessionBusy`.
- **`wait:"none"` sends even if busy** — it is the caller's responsibility to choose the right wait strategy. The harness should use `"idle"` for `/compact` to avoid injecting into a mid-response stream.
- **Timeout env var for tests** — `SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS` lets tests use a 200 ms timeout instead of 30 s, making the idle-timeout test fast.
- **`persistent: true` on `fs.watch`** — the watcher keeps the Node event loop alive, matching the pattern of all other persistent watchers in `main.js` (projects watcher, subagent watcher).

## Change-also checklist

- If you rename `_cliBusy` on `session` in `main.js`, update `isSessionBusy` in the `start(ctx)` wiring block.
- If you rename `activeSessions` or change the structure (`session.pty` → `session.ptyProcess`), update both `getPtyForSession` and `isSessionBusy` in the wiring block.
- Tests live in `test/trigger-watcher.test.js`.  They use `SWITCHBOARD_TRIGGERS_DIR` env override — do not hardcode paths there.
- The convention doc for harness script authors lives at `~/.skaleet-ai/conventions/how-to/switchboard-trigger.md`.
