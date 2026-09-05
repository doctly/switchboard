# Multi-harness sessions: adding OpenAI Codex

Design for letting a session be **Claude** or **Codex**, remembering which is
which, and resuming each with the right CLI.

Everything in "Verified facts" below was tested against `codex-cli 0.149.1`
installed locally, not read from docs.

---

## 1. Verified facts about Codex

| Thing | Claude Code | Codex CLI |
|---|---|---|
| Transcript location | `~/.claude/projects/<encoded-project>/<sessionId>.jsonl` | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl` |
| Grouping on disk | one dir per **project** | one dir per **date** (mixed projects) |
| Project path source | `cwd` on any line | `session_meta.payload.cwd` on line 1 |
| Session id | the file name | the file name's uuid suffix |
| Pre-assign session id | `claude --session-id <uuid>` | **not possible** |
| Resume | `claude --resume <id>` | `codex resume <id>` |
| Fork | `claude --resume <id> --fork-session` | `codex fork <id>` |
| Sub-agent transcripts | in a `subagents/` subdirectory | mixed in with the rest |
| Transcript written at launch | yes | **no — only on the first turn** |
| Resume writes | same file | same file (appends, id preserved) |

`CODEX_HOME` defaults to `~/.codex` and must be honoured if set.

### The rollout format

Line 1 is always `session_meta`:

```json
{"timestamp":"...","type":"session_meta","payload":{
  "session_id":"01a03f7c-...","cwd":"/Users/home/dev/foo",
  "originator":"codex_cli_rs","cli_version":"0.149.1","source":"cli"}}
```

**The session id is the file name's uuid, not `session_meta.session_id`.**
That field is the *lineage root* and is repeated by every resume and fork of a
conversation — on this machine six rollout files share one value, which would
collide on `session_cache.sessionId`. The file name's uuid is unique per
rollout, is what `codex resume <id>` accepts (verified), and is what codex's own
`session_index.jsonl` keys on.

Subsequent lines carry a `type` and a `payload.type`:

- `response_item` / `message` with a `role` → **the authoritative text**
- `event_msg` / `user_message`, `agent_message` → a duplicate copy of the same
  turns, emitted by some versions only
- `event_msg` / `token_count`, `task_started`, `task_complete` → bookkeeping
- `response_item` / `message`, `reasoning`, `custom_tool_call`, `custom_tool_call_output`
- `turn_context`, `world_state` → per-turn config

Count **only** `response_item` messages: it is present in all 53 rollouts on
this machine while `event_msg` is missing from 6, and counting both would double
every turn. Skip `role: 'developer'` (CLI scaffolding) and skip user messages
opening with a simple XML tag — codex injects `<environment_context>`,
`<recommended_plugins>`, `<turn_aborted>`, `<transcript>` as user turns, and
across every rollout on disk no genuine prompt starts with one.

Timestamps are ISO-8601 UTC, so the same first/last scan Claude's parser already
does works unchanged.

---

## 2. The one hard constraint

**Codex has no `--session-id`.** Switchboard's whole new-session flow depends on
knowing the id *before* spawning:

```js
const sessionId = crypto.randomUUID();     // app.js launchNewSession
claudeArgs.push('--session-id', sessionId) // main.js open-terminal
```

Worse, the rollout file does not exist until the user sends their first
message — a launched-but-unused Codex session leaves no trace on disk at all.

So a new Codex session must be **launched under a temporary id and promoted to
its real id later**.

### Sub-agent rollouts are not sessions

Codex records sub-agent threads as ordinary rollout files, but refuses to resume
one:

```
cannot resume an unloaded multi-agent v2 sub-agent through its parent;
resume the parent first, or use thread/read to inspect it
```

They are marked in `session_meta` by any of `thread_source: 'subagent'`,
`parent_thread_id`, `agent_path`, `agent_nickname` — not all together, and older
rollouts carry none. `forked_from_id` is **not** one of them: a fork is a real
session.

The indexer skips them. Claude's subagent transcripts are already excluded (they
live in a `subagents/` subdirectory the indexer never scans), so this keeps the
two consistent, and it avoids sidebar rows whose only action always fails. Of 54
rollouts here, 23 are dropped this way or for having no user turn, leaving 31.

### The handshake

`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` is copied verbatim into
`session_meta.payload.originator`. Verified:

```
env CODEX_INTERNAL_ORIGINATOR_OVERRIDE=switchboard_probe_1 codex
→ {"session_id":"01a03f7c-...","originator":"switchboard_probe_1"}
```

That gives an exact, race-free marker:

1. Renderer makes a temp uuid, same as today.
2. Main spawns codex with `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=switchboard-<tempId>`.
3. The codex watcher sees a new rollout, reads line 1, matches `originator`.
4. Main sends `session-detected(tempId, realId)`.

Step 4 needs no new renderer code — `app.js:208 onSessionDetected` already
re-keys `openSessions`, `activeSessionId`, and the header. It is currently dead
code (nothing in main emits it). This revives it.

The tag is `switchboard_<uuid with hyphens stripped>`. The charset matters: the
value is forwarded as an HTTP header, and the binary carries an "ignoring
invalid thread originator header value" path, so it is kept to `[a-z0-9_]`.

**Fallback, required.** The env var is internal and may be removed. If no
rollout matches the originator, fall back to: a rollout whose `cwd` equals the
session's `projectPath`, started after the spawn (with a few seconds of clock
skew allowed). It explicitly refuses a rollout tagged for a *different*
switchboard launch, which is the one case two concurrent new sessions could
steal each other's transcript.

**Backstops.** The watcher is the fast path, but a dropped `fs.watch` event
would strand a session under its temporary id forever, so `get-projects` also
sweeps — only while something is actually waiting, and only over transcripts
touched since the launch.

---

## 3. Structure: a harness adapter

Today the transcript format, the on-disk layout, and the launch command are
hardcoded across `main.js`, `session-cache.js`, `read-session-file.js`, and
`workers/scan-projects.js`. Add `harnesses/` with one module per CLI and a
registry:

```
harnesses/index.js     → { claude, codex }, getHarness(id), availableHarnesses()
harnesses/claude.js    → today's behaviour, moved not rewritten
harnesses/codex.js     → new
```

Each adapter exports:

```js
{
  id: 'codex',
  label: 'Codex',
  available(),                       // does its home dir / binary exist
  sessionsRoot(),                    // dir to scan and fs.watch
  listFolders(),                     // folder keys under that root
  folderPath(folder),                // key → absolute dir
  readSessionFile(filePath, folder), // → the same session shape as today
  transcriptPath(session),           // → absolute .jsonl path
  buildLaunch({ sessionId, isNew, projectPath, options }),
                                     // → { cmd, args, env }
}
```

`readSessionFile` must keep returning the exact object
`upsertCachedSessions` already writes, so `session-cache.js` needs no shape
changes — only `readSessionFile(...)` → `getHarness(row.runtime).readSessionFile(...)`.

### Folder keys

`session_cache.folder` becomes a namespaced key:

- Claude: `<encoded-project>` — **unchanged**, no migration
- Codex: `codex/2026/08/26`

`encodeProjectPath` output is `[a-zA-Z0-9-]+` only, so a key containing `/`
can never collide with an existing Claude row. One helper resolves both:

```js
function folderPath(folder) {
  return folder.startsWith('codex/')
    ? path.join(CODEX_SESSIONS_DIR, folder.slice(6))
    : path.join(PROJECTS_DIR, folder);
}
```

Date-keyed folders work with the existing incremental machinery for free:
`getFolderIndexMtimeMs` gates on newest `.jsonl` mtime, so only today's and
yesterday's dirs are ever rescanned. Old dirs cost one `stat`.

`cache_meta.projectPath` is meaningless for a date folder (many projects per
day) — store `NULL`. It is only read by the empty-project backfill in
`buildProjectsFromCache`, which already skips nulls.

---

## 4. Data model and migration

### Naming: `harnesses/` in code, `runtime` in the schema

The module namespace is `harnesses/`, not `agents/`, because **`agent` is already
taken**: `feat/subagent-support` adds `parentSessionId`, `agentId`, `subagentType`
to `session_cache`, where `agentId` means a Claude *subagent*. "Harness" is also
the accurate word — what varies is the CLI program wrapping the model.

The column is `runtime`, not `harness`, for a different reason: **it already
exists.** A build from a parallel branch left `runtime TEXT DEFAULT 'claude'` and
`sessionFile TEXT` in real databases (confirmed against a live db_version-5 DB:
859 rows, `runtime = 'claude'` throughout, `sessionFile` null throughout). Those
are exactly the two columns this design needs, with exactly the right semantics,
so they are adopted rather than shadowed by a second pair that would drift.

The names differ between layer and schema, which is a small price for not
carrying two columns that mean the same thing.

Two columns on `session_cache`:

```sql
ALTER TABLE session_cache ADD COLUMN runtime TEXT DEFAULT 'claude';
ALTER TABLE session_cache ADD COLUMN sessionFile TEXT;
```

- `runtime` — which CLI owns this session. The default means every existing row
  is correct with no backfill. `NOT NULL` is deliberately omitted: the parallel
  branch's column is nullable, and requiring it would force a table rebuild on
  DBs that already have data. Reads go through `getHarness()`, which treats null
  as Claude.
- `sessionFile` — absolute transcript path. Needed because a Codex filename is
  `rollout-<ts>-<id>.jsonl`, not `<id>.jsonl`. `NULL` on old rows, and
  `transcriptPath()` falls back to `PROJECTS_DIR/folder/sessionId.jsonl`.

Both go in the **schema reconciliation block** (`db.js`, the `PRAGMA
table_info` section), not the numbered `migrations` array. That block already
exists precisely because db_version can't be trusted across branches, and its
comment says so.

`session_meta` (name, starred, archived) is keyed by sessionId alone and needs
no change — a renamed or pinned Codex session works on day one.

### What an existing user sees on upgrade

- **No cache wipe. No re-index of Claude sessions.** Both columns are
  defaulted or nullable, so nothing is invalidated.
- Every existing session keeps its row and gets the Claude icon.
- On first reconcile, `~/.codex/sessions` is scanned and past Codex sessions
  appear in the sidebar, grouped into the right projects by their `cwd`.
- If Codex isn't installed, `available()` is false: no scan, no watcher, and
  the "+" menu doesn't offer Codex. Nothing errors.

The one visible change for a Codex user is that their existing Codex history
shows up. That is the feature, not a regression.

---

## 5. Launch, resume, fork

`harnesses/codex.js buildLaunch`:

| Case | Args |
|---|---|
| new | `codex` (+ `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`) |
| resume | `codex resume <sessionId>` |
| fork | `codex fork <sessionId>` |

Option mapping — Codex has different vocabulary, so it needs its own
dialog fields rather than reusing Claude's permission modes:

| Switchboard | Claude | Codex |
|---|---|---|
| permission | `--permission-mode <m>` | `--ask-for-approval on-request\|never` |
| skip safety | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| model | — | `--model <m>` (`codexModel`) |
| sandbox | — | `--sandbox read-only\|workspace-write\|danger-full-access` |
| extra dirs | `--add-dir` | `--add-dir` (same) |
| pre-launch cmd | prepended | prepended (same) |
| worktree | `--worktree` | not supported — hide the field |

`cwd` is set by the PTY spawn, as today; `-C/--cd` is not needed.

New settings keys (`SETTING_DEFAULTS`, global + per project):
`defaultAgent`, `codexSandbox`, `codexApproval`, `codexModel`. Adding keys is
backward-compatible — `get-effective-settings` starts from `SETTING_DEFAULTS`
and only overrides defined values.

---

## 6. UI

**Sidebar icon.** `buildSessionItem` already prepends a `.terminal-badge` for
`type === 'terminal'`. Same slot, driven by `session.runtime`: Claude glyph,
Codex glyph, or the terminal glyph. Add `is-codex` next to `is-terminal`.

**New-session popover.** Rows are generated from a `get-harnesses` IPC rather
than hardcoded, so a machine without codex installed simply never sees it. It
renders Claude immediately and re-renders when main answers, so it never appears
empty.

**Config dialog.** Takes a runtime. Codex gets sandbox / approval / model;
Claude keeps permission mode / worktree / Chrome. They are not translations of
each other — showing Claude's controls for a codex session would offer settings
that are silently dropped at launch.

**Resume.** No UI change. `openSession` reads `session.runtime` from the row and
main dispatches on it.

---

## 7. What stays Claude-only

Gate these on `runtime === 'claude'` rather than trying to generalise now:

- **MCP / IDE emulation** — `--ide`, `CLAUDE_CODE_SSE_PORT`, `mcp-bridge.js`.
  Codex has its own MCP model; skip it entirely for Codex sessions.
- **Fork / plan-accept detection** — `session-transitions.js` matches on
  `forkedFrom`, `planContent`, and `slug`, none of which exist in a rollout.
  Codex `fork` is an explicit command, so no detection is needed.
(Busy-state was on this list until the TUI was probed — see below.)
- **Scheduled tasks** — `schedule-runner.js`, `createScheduleSession`.
- **Stats view** — reads `~/.claude/stats-cache.json`.
- **Slug grouping** — no slug in a rollout, so Codex sessions render ungrouped.

### Activity: working, waiting, blocked

Probed from a live session rather than guessed. Codex uses **the same terminal
title protocol as Claude**: a braille spinner frame (U+2800–U+28FF) prefixes the
title while a turn runs. The difference is idle — Claude marks it with `✳`,
codex simply drops the prefix, so for codex "not a spinner" *is* idle. Reading
it as "no information" would leave sessions spinning in the sidebar forever, and
treating a plain Claude title the same way would end a busy state early. Hence
`parseTitleState` per harness.

The other two states arrive as OSC 9, but only if notifications are on, so the
launch forces them:

```
-c tui.notifications=true
-c tui.notification_method="osc9"
-c tui.notification_condition="always"
```

Same reasoning as `TERM_PROGRAM=iTerm.app` for Claude — the signal is what drives
the sidebar. `unfocused` would suppress exactly the case that matters. Passed as
`-c` overrides, so the user's own `config.toml` is untouched.

Codex sends two kinds, with wording nothing like Claude's:

| Payload | Means |
|---|---|
| `Approval requested: <command>` | blocked on the user |
| the agent's final message | turn finished, response waiting |

So classification moves into the harness too, and main hands the renderer a
*kind* rather than the renderer re-deriving one from text. Verified end to end:
busy at 7.5s, idle + `kind=idle` at 13.2s carrying the answer, `kind=attention`
at 30.3s carrying the approval request.

**JSONL viewer** has a real Codex path rather than a gate — see step 7. The
mapping is exact enough that all 96 tool calls in a real rollout pair with their
results, and the existing renderer needed no change.

---

## 8. Implementation order

Each step leaves the app working.

1. **`harnesses/` + move Claude into it.** Pure refactor, no behaviour change.
   Existing tests must still pass.
2. **DB columns + `folderPath()` helper.** Still Claude-only; proves the
   migration is a no-op on a real DB.
3. **Codex indexer.** `harnesses/codex.js readSessionFile`, folder listing,
   watcher on `$CODEX_HOME/sessions`. Past Codex sessions appear, read-only.
4. **Resume.** `codex resume <id>` from a sidebar click. This is the first
   point the feature is useful. `codex resume` accepts the same flags as a
   fresh launch, so one option mapping covers both. Enumerated values are
   validated against what the CLI accepts rather than interpolated — they come
   from stored settings, which outlive the codex version that understood them.
   The sidebar badge moves here from step 6: without it there is no way to tell
   which row is which, so resume cannot be tested by hand.
5. **New session + originator handshake.** Temp id, `session-detected`,
   the cwd/mtime fallback. `onSessionDetected` in the renderer already existed
   but was dead code (nothing emitted it) and did not re-key `pendingSessions`,
   so the temp id kept being re-injected as a phantom row — fixed alongside.
6. **UI.** Agent picker in the popover, icon in the sidebar, Codex fields in
   the config dialog.
7. **Fork + JSONL viewer.** A fork runs on the CLI that wrote the session it
   forks, not the default — `codex fork` cannot continue a Claude transcript.
   The viewer is fed by a per-harness `toViewerEntries`, so it never learns a
   second transcript format: a codex tool call becomes a `tool_use` block, its
   output a `tool_result` keyed by the same call id, and a reasoning summary a
   `thinking` block. Claude's is identity. Normalising in main rather than the
   renderer keeps the viewer ignorant of which CLI wrote the file.

### Tests worth writing

- `harnesses/codex.js readSessionFile` against a fixture rollout (session_meta,
  user_message, agent_message, tool calls) → asserts summary, counts, cwd, times.
- `folderPath()` round-trip for both namespaces, including a project path that
  hits the 200-char hash branch of `encodeProjectPath`.
- Originator matching: right file among several created in the same second,
  and the cwd/mtime fallback when originator is absent.
- A migration test in the style of `test/db-schema-reconcile.test.js`: open a
  pre-upgrade DB, run reconciliation, assert existing rows read back with
  `runtime = 'claude'` and that nothing was deleted.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` is internal and may vanish | cwd + birthtime fallback, always present |
| `codex migrate-rollouts` suggests sessions may move to sqlite thread history | rollout dir is still written by 0.149.1; adapter isolates the change to one file |
| Codex prompts "do you trust this directory?" on first launch in a new dir | user answers in the terminal, same as Claude's trust prompt |
| A launched-but-unused Codex session leaves no file | it stays a pending row and is cleaned up by the existing pending reconciliation |
