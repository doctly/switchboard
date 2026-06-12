# Context: session-cache

**Purpose**: index every Claude session JSONL on disk into a queryable SQLite cache so the sidebar renders without re-scanning `~/.claude/projects/` and so search is full-text. Watches the projects directory for changes and refreshes incrementally.

## Key files

| File | LOC | Role |
|---|---|---|
| `db.js` | ~450 | SQLite (better-sqlite3) schema + prepared statements. Owns `session_cache`, `session_meta`, `cache_meta`, `settings`, `search_fts` (FTS5 + trigram tokenizer). |
| `session-cache.js` | ~525 | Indexer + watcher. Reads `~/.claude/projects/<folder>/*.jsonl` (+ subagents subdir), populates rows, emits projects-changed events. |
| `read-session-file.js` | ~280 | Streaming JSONL reader. `readSessionFile()` (full) + `readSessionDisplayHeader()` (256 KB / 500 lines — cheap header for huge files). |
| `encode-project-path.js` | 14 | `/path/to/project` → `-path-to-project` folder name. Mirrors Claude CLI's encoding. |
| `derive-project-path.js` | 64 | Inverse: read `cwd` field from JSONL, derive original projectPath. **Collapses worktrees back to parent repo** via `resolveWorktreePath`. |

## Public surface

From `db.js`:

- **Sessions**: `getAllCached`, `getCachedByFolder(folder)`, `getCachedByParent(parentSessionId)`, `getCachedSession(sessionId)`, `upsertCachedSessions(rows[])`, `deleteCachedSession`, `deleteCachedFolder`
- **Meta**: `getMeta`, `getAllMeta`, `setName`, `toggleStar`, `setArchived` (session-level user state)
- **Folder meta**: `getFolderMeta`, `setFolderMeta(folder, projectPath, indexMtimeMs)` — tracks index freshness
- **Search**: `searchByType(type, query, limit, titleOnly)`, `upsertSearchEntries`, `deleteSearchType/Session/Folder`
- **Stats**: `getDailyActivity()` — `GROUP BY substr(modified, 1, 10)`, returns `[{date, messageCount, sessionCount}]` (heatmap source)
- **Settings**: `getSetting`, `setSetting`, `deleteSetting`
- **Misc**: `touchCachedModified(sessionId)` — 1-column UPDATE, cheap

From `session-cache.js`:

- `init(ctx)` — wire main process → cache (mainWindow ref for IPC events)
- `refreshFolder(folder, opts)` — opts `{files: Set<string>}` for targeted refresh (watcher payload). Defaults to full folder walk.
- `populateCacheFromFilesystem()` / `populateCacheViaWorker()` — initial scan / re-scan
- `buildProjectsFromCache(showArchived)` — produces the sidebar payload (sorted, grouped by project, missing flag computed here)
- `notifyRendererProjectsChanged()` — throttled (~1.5s leading-edge) push to renderer

From `derive-project-path.js`: `deriveProjectPath(folderPath)`, `resolveWorktreePath(cwd)`.

## Invariants

- **`modified` is always ISO8601 string** (`2026-05-22T20:59:33.000Z`). `substr(modified, 1, 10)` is the canonical "day" derivation. Don't switch to epoch ms without migrating.
- **`session_cache.folder` is the encoded form** (`-home-jean-baptiste-workspace`). Use `encodeProjectPath()` to derive it from an absolute path.
- **WAL mode is enabled on SQLite open** — multiple readers OK; serialise writes. Concurrent writers will fail with `SQLITE_BUSY`.
- **`refreshFolder` is idempotent** — calling it twice with the same `opts.files` is safe; the `filePathToDbId` inverted index makes lookups O(1).
- **Header-only refresh** (via `readSessionDisplayHeader`) merges with the cached row to preserve `textContent`, `aiTitle`, etc. Don't overwrite cached fields with `null` from a partial read.
- **FTS entries follow `{id, type, folder, title, body}`** shape. `type` is one of `'session'`, `'subagent'`, `'plan'`, `'memory'`, `'work-file'`. Mixing types within one upsert is fine.

## Non-obvious behaviors

- **`resolveWorktreePath` collapses `<repo>/.worktrees/<name>` → `<repo>`** when the parent dir exists. Consequence: many `~/.claude/projects/-home-...workspace-skaleet-ai--worktrees-X` folders derive to the same projectPath. Callers must dedupe (see `get-work-files` IPC for the pattern).
- **Two-table sidebar payload**: projects are aggregated, but each session row has its own `subagentType` field. A `null`/empty `subagentType` means it's a parent session; anything else (e.g. `'general-purpose'`, `'researcher'`) marks a subagent.
- **`fs.watch` debouncing**: the watcher batches per-folder events in a `pendingChanges = Map<folder, Set<filename> | true>` for ~200 ms before flushing to `refreshFolder`. A `true` value means "full walk needed" (rare path).
- **Stats `firstSessionDate`** is computed from `MIN(modified)`, not `MIN(created)`. Old sessions touched by recent reads keep their original `created` but their `modified` reflects the latest indexing — by design (the heatmap measures activity, not creation).

## If you change this, also check

- `derive-project-path.test.js` — covers the worktree-collapse + cwd extraction paths
- `db-daily-activity.test.js` — covers heatmap aggregation
- `read-session-file.test.js` — covers header parsing
- IPC consumers of cached payloads: `get-projects`, `get-active-sessions`, `search`, `get-stats-from-db`, `get-work-files`, `list-subagents`, `read-session-jsonl`
- Renderer: `public/sidebar.js` (consumes `buildProjectsFromCache` output), `public/stats-view.js` (consumes `getDailyActivity`)
- If you add a new `session_cache` column, update the SELECT in `getCachedByFolder` — it's `SELECT *` so additions land automatically, but the renderer needs to know about them.

## Schema reference

```
session_cache(sessionId PK, folder, projectPath, summary, firstPrompt,
              created, modified, messageCount, slug, aiTitle,
              parentSessionId, agentId, subagentType, description)
session_meta(sessionId PK, customTitle, starred, archived)
cache_meta(folder PK, projectPath, indexMtimeMs)
search_fts USING fts5(id, type, folder, title, body, tokenize='trigram')
search_map(id PK, type, folder)   -- backref for FTS delete
settings(key PK, value JSON)
```
