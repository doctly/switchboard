# Context: subagent-observability

**Purpose**: Surface Claude's subagent runs (child tasks spawned via the `Agent` tool) in the Switchboard sidebar with parent→child grouping, live status badges, and a read-only transcript viewer. Avoid the original mistake of treating subagents as resumable sessions — they're ephemeral and re-resuming corrupts their context.

This is the **#1 fork-specific feature** (upstream PR #47 still pending). It pervades many files rather than living in a single module.

## Key files (by layer)

### Indexing (main → DB)

| File | Role |
|---|---|
| `session-cache.js` | `enumerateSessionFiles(folderPath)` walks `<folder>/*.jsonl` AND `<folder>/<parentSessionId>/subagents/*.jsonl` (+ legacy `<folder>/<parentSessionId>/*.jsonl`). Sets `subagentType` from JSONL metadata. |
| `db.js` | `session_cache` row has `parentSessionId`, `agentId`, `subagentType` columns. `getCachedByParent(parentSessionId)` returns all children. |
| `read-session-file.js` | `readSessionDisplayHeader()` extracts `agentId` + `isSidechain` flags from the first 256 KB. |

### IPC bridge (main ↔ renderer)

| IPC | What it does |
|---|---|
| `read-subagent-jsonl(parentSessionId, agentId)` | Returns parsed JSONL entries for the transcript view |
| `list-subagents(parentSessionId)` | Returns all subagent rows for a parent (used by the sidebar nesting) |
| `start-subagent-watch(parentSessionId, agentId)` | Begin tailing the subagent's JSONL; emits `subagent-watch-event` per change |
| `stop-subagent-watch(watchId)` | Tear down the watch |
| Events (main → renderer): `subagent-spawned`, `subagent-completed`, `subagent-watch-event` | Live status changes |

### UI

| File | Role |
|---|---|
| `public/sidebar.js` | Renders the "Orphan subagents" collapsible group; nests subagents under their parent in worktree/session groups; click handler routes subagent items to the transcript view. |
| `public/jsonl-viewer.js` | `showSubagentTranscript(session)` — read-only render of the subagent's JSONL with `mergeLocalCommandEntries` + `renderJsonlEntry` + a "Resume in terminal anyway" escape banner. |

## Public surface (for code that wants to integrate)

- From renderer code: `window.api.readSubagentJsonl`, `window.api.listSubagents`, `window.api.startSubagentWatch`, `window.api.stopSubagentWatch`, listeners `window.api.onSubagentSpawned/Completed/WatchEvent`
- From renderer JS: `showSubagentTranscript(session)` (cross-file global, declared in `eslint.config.js` rendererCrossFileGlobals)
- From sidebar UI: subagent rows carry `dataset.subagent = true` and `dataset.parentId = parentSessionId` for downstream wiring

## Invariants

- **A subagent click MUST NOT spawn `claude --resume`.** The opener routing in `sidebar.js` checks `item.dataset.subagent && session.parentSessionId` and dispatches to `showSubagentTranscript` instead of `openSession`. **If you add a new sidebar opener path, replicate this discriminator.**
- **`subagentType` is the canonical "is-subagent" signal**: non-null/non-empty string. The agent type itself (e.g. `'frontend-implementer'`, `'researcher'`) is human-meaningful but the *presence* of the value is what matters for routing.
- **Subagent JSONLs are at `<folder>/<parentSessionId>/subagents/<agentId>.jsonl`**, NOT at `<folder>/<agentId>.jsonl`. There's also a legacy layout `<folder>/<parentSessionId>/<agentId>.jsonl`. **Always use `enumerateSessionFiles()` to walk both layouts.**
- **Watchers are scoped per `(parentSessionId, agentId)`**: don't share a watcher across subagents — `start-subagent-watch` returns a `watchId` that's unique per call.
- **Watch cleanup is mandatory** when the transcript view is closed. `drainViewerWatches()` (in `jsonl-viewer.js`) walks `activeViewerWatches` and calls `stopSubagentWatch` for each. Forgetting this leaks `fs.watch` handles.

## Non-obvious behaviors

- **The parent JSONL doesn't contain the subagent's text** — it just records a `subagent-spawn` event. The actual conversation lives in the child JSONL. The viewer pieces them together via `mergeLocalCommandEntries`.
- **Orphan subagents** (no findable parent in cache) are surfaced in a dedicated `.orphan-subagents` group in the sidebar, **collapsed by default**. State is persisted per-project in `localStorage['orphanExpanded:' + projectPath]`.
- **Subagent status badges**: derived from the most recent JSONL line — `isSidechain: true` means active, completion is inferred from mtime stability (see PR #48 observability follow-up).
- **The "Resume in terminal anyway" button** in the transcript view bypasses the routing and calls the original `openSession` opener. This is intentional — for the rare debugging case where a user genuinely wants to re-enter the subagent's session.

## If you change this, also check

- `eslint.config.js` `rendererCrossFileGlobals` — must list any new renderer-global functions (e.g. `showSubagentTranscript`, `drainViewerWatches`) or lint fails on `no-undef`
- `test/dom-subagent-transcript.test.js` — 4 tests covering the routing branch + transcript render
- `test/dom-sidebar.test.js` — covers orphan group rendering
- `public/sidebar.js:771` (the routing branch) — the one-line decision that makes the whole feature work
- IPC handler security: `read-subagent-jsonl` MUST validate that `agentId` and `parentSessionId` are filename-safe (see `resolveJsonlPath` calls in main.js — fixed in PR #8 hardening)

## History

- Upstream PR #47: original subagent indexing + search (still open upstream, merged on fork)
- Upstream PR #48: live transitions, status badges
- Fork PR #9: subagent click → transcript view (replaces resume-in-terminal default)
- Fork PR #8: security hardening on subagent IPCs + watch drain on viewer close
