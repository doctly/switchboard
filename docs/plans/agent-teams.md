# Switchboard Agent Teams — Design & Implementation Plan

**Status:** accepted, implementation in progress · **Date:** 2026-06-10

> **Revisions (post-review, 2026-06-10):**
> 1. **Full automation is the default.** After `/sb-plan` finishes, no human input is required at the
>    task level: `policy` defaults are `autoSpawnWorkers: true`, `autoSpawnReviewers: true`,
>    `autoMerge: true` (master merges approved tasks and runs gates), `maxAttempts: 3`. Reviewers are
>    automatically spawned as separate sessions with their own role profile (different model/context).
>    Human override stays possible from the GUI, but is never required.
> 2. **MCP control surface deferred, not rejected.** Files remain the source of truth. Because
>    Switchboard itself is a long-lived process, it *could* reliably host an MCP server later as a
>    convenience API over the same files; that becomes an additive Phase-5 item.
> 3. **Testing strategy hardened.** A `fake-claude` CLI harness (Node script mimicking `claude`'s
>    argument surface, JSONL transcript writing, and scripted task-file actions) drives a true
>    end-to-end lifecycle test: ready → worker spawn → needs_review → reviewer spawn → approved →
>    master nudge, against a real temp git repo with real worktrees.
> 4. Agent-pack templates are embedded in `orch-templates.js` (packaging parity with the existing
>    schedule-creator template) and installed into the target project at run creation.

## 1. Goal

Extend Switchboard so a state-of-the-art "master" model (Fable/Opus on Anthropic) can produce a deep
plan, decompose it into layered, granular tasks, and hand implementation off to teams of cheaper/faster
worker sessions (e.g. DeepSeek) running **as real, separate Claude Code sessions** — each visible in
Switchboard, each isolated in a git worktree, each reviewed before merge. Switchboard visualizes the
whole world: plan tree, backlog, live teams, reviews, merges.

Three principles agreed up front:

1. **The file system is the orchestration state.** No stateful MCP server, no orchestration brain
   inside Switchboard. The master agent reads/writes plan and task files in the target repo; everything
   else reacts to those files. The master can be compacted, restarted, or resumed at any time and
   re-derive the world from disk.
2. **Workers are visible PTY sessions.** Every worker/reviewer is a normal Switchboard terminal running
   `claude` with a per-role profile (which is how the base URL / model gets swapped). You can watch,
   type into, and stop any of them. JSONL transcripts work exactly as today.
3. **Switchboard stays a visual aid + thin executor.** Its only new active duty is a *spawn service*
   (turn "task ready" files into terminals) and a *watcher* (turn file changes into GUI state). All
   decisions stay with the master agent and with you.

## 2. What we already have (verified in code)

| Capability | Where | Notes |
|---|---|---|
| Per-session provider/model via env | `profiles.js`, `public/profile-presets.js` | Profiles set `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`; presets exist for Anthropic, DeepSeek (`https://api.deepseek.com/anthropic`), GLM, OpenRouter. Applied at PTY spawn (`main.js:1189–1204`). |
| Session spawn with options | `main.js:1027–1370`, `claude-cmd.js` | `openTerminal(id, projectPath, isNew, sessionOptions)` already supports `--session-id`, `--resume`, `--fork-session`, permission mode, worktree name, add-dirs. |
| Session ↔ profile persistence | `session-profiles.js` | sessionId → profileId map; sidebar badges. |
| JSONL indexing + grouping | `session-cache.js`, `read-session-file.js`, `db.js` | SQLite cache, FTS, `slug`-based grouping in the sidebar. |
| Fork/plan-accept detection | `session-transitions.js` | Re-keys PTY/MCP/profile when session IDs change. |
| Headless runs | `schedule-runner.js` | Already builds `claude -p` commands with `--permission-mode`, `--allowed-tools`, `--model`, `--append-system-prompt`. |
| Multi-terminal UI | `public/grid-view.js`, `terminal-manager.js` | Grid of live terminals with focus management — the seed of the "team view". |
| Busy/idle detection | `main.js:1251–1309` | OSC parsing gives per-session busy state — reusable as worker activity signal. |
| Worktree awareness | `derive-project-path.js` | Already strips `/.claude-worktrees/<name>` when deriving project paths. |

Claude Code mechanics we'll lean on (verified against current docs):

- `claude --session-id <uuid> "<boot prompt>"` lets us pin the session UUID at spawn, so the task file
  can record it *before* the JSONL exists — no fragile detection needed for workers.
- `--append-system-prompt-file` injects per-role guidance (style guide, review rubric) without touching
  the repo's CLAUDE.md.
- `git worktree` isolation is proven; Claude Code itself uses `.claude/worktrees/`.
- Env vars are per-process, so two terminals can simultaneously talk to Anthropic and DeepSeek.
- JSONL transcripts land in `~/.claude/projects/<encoded-cwd>/` — a worktree cwd encodes to a
  *different* folder than the main repo, which we must normalize (see §6.4).

## 3. Architecture

```
┌────────────────────────── target repo ──────────────────────────┐
│  .switchboard/                                                  │
│    guidelines.md            ← code style + review rubric        │
│    runs/<run-id>/                                               │
│      run.json               ← roles→profiles, limits, status    │
│      plan.md                ← master's detailed plan            │
│      tasks/<task-id>.json   ← spec, status, deps, sessions      │
│      reviews/<task>-<n>.md  ← reviewer verdicts                 │
│      events.jsonl           ← append-only audit log             │
└──────────────▲──────────────────────────────▲───────────────────┘
       reads/writes                     reads/writes
┌──────────────┴─────────────┐   ┌──────────────┴──────────────────┐
│ Master session (Fable/Opus)│   │ Worker/reviewer sessions        │
│ /sb-plan /sb-orchestrate   │   │ (DeepSeek/GLM/etc profiles)     │
│ plans, decomposes, decides │   │ /sb-work /sb-review boot cmds   │
└──────────────▲─────────────┘   └──────────────▲──────────────────┘
        PTY + nudges                    PTY spawn w/ profile env
┌──────────────┴────────────────────────────────┴──────────────────┐
│ Switchboard main process                                         │
│  orchestrator-watcher.js  → watch .switchboard/runs, parse, IPC  │
│  orchestrator-spawner.js  → ready task → worktree + PTY session  │
│  worktree-manager.js      → git worktree add/remove/list         │
│  db.js (+orch tables)     → index runs/tasks for GUI + history   │
├──────────────────────────────────────────────────────────────────┤
│ Renderer: Orchestration view (plan tree · board · team grid)     │
│           Sidebar run-grouping (children collapsed under run)    │
└──────────────────────────────────────────────────────────────────┘
```

The file protocol is the *only* coupling. The master never calls Switchboard; Switchboard never makes
decisions. Either side can be restarted and the run continues from disk.

## 4. The file protocol (source of truth)

### 4.1 `run.json`

```json
{
  "id": "2026-06-10-auth-refactor",
  "title": "Auth refactor",
  "status": "active",            // draft | active | paused | done | abandoned
  "masterSessionId": "uuid",
  "integrationBranch": "teams/auth-refactor",
  "roles": {
    "master":   { "profileId": "anthropic-fable" },
    "worker":   { "profileId": "deepseek", "maxConcurrent": 4 },
    "reviewer": { "profileId": "anthropic-opus", "maxConcurrent": 2 }
  },
  "policy": { "autoSpawnWorkers": true, "autoSpawnReviewers": true, "autoMerge": false }
}
```

### 4.2 `tasks/<task-id>.json`

```json
{
  "id": "T-014",
  "title": "Add rate limiter to login endpoint",
  "kind": "leaf",                 // epic | chunk | leaf — layered decomposition
  "parent": "C-03",
  "dependsOn": ["T-011"],
  "status": "ready",
  "spec": "tasks/T-014.spec.md",  // full self-contained spec for a small-context worker
  "filesHint": ["src/auth/login.js", "test/auth/login.test.js"],
  "acceptance": ["rate limit 5/min/IP", "existing tests pass", "new test covers lockout"],
  "worktree": ".switchboard/worktrees/T-014",
  "branch": "task/T-014-rate-limiter",
  "role": "worker",
  "sessionIds": ["uuid-of-worker-session"],
  "attempts": 1,
  "reviews": [{ "file": "reviews/T-014-1.md", "verdict": "changes_requested" }]
}
```

**Status machine** (single source of truth for both agents and GUI):

```
draft → ready → spawning → in_progress → needs_review → reviewing
      → changes_requested (→ in_progress) → approved → merging → done
                                                    ↘ failed / blocked
```

Ownership rules to avoid races:
- One writer per transition: master owns `draft→ready` and `approved→merging→done`; Switchboard owns
  `ready→spawning→in_progress` (it performed the spawn and knows the sessionId); the worker owns
  `in_progress→needs_review`; the reviewer owns `reviewing→approved|changes_requested`.
- All writes are atomic (write temp file, rename). `events.jsonl` is append-only and is the audit
  trail the GUI timeline and the master's catch-up both read.

### 4.3 Why files beat a stateful MCP server here

- Survives crashes/compaction of any party; the master re-reads the world on `/sb-orchestrate`.
- Versionable with the code (plan and specs are reviewable artifacts in the PR).
- Every agent already has first-class file tools; zero new protocol for models of any size.
- Switchboard's existing strengths (file watching, JSONL indexing) extend naturally.

## 5. The agent pack (skills shipped by Switchboard)

A set of commands Switchboard installs into the target project's `.claude/commands/` (or a plugin) when
a run is created. These encode the methodology; Switchboard stays dumb.

| Command | Run by | Does |
|---|---|---|
| `/sb-plan <goal>` | master | Deep codebase study → `plan.md` + top-level chunks (`kind: epic/chunk`). Plan includes integration strategy, validation layers, risk register. |
| `/sb-decompose <chunk-id>` | master | Breaks a chunk into leaf tasks. Hard rules: one concern per task (~one file of functionality + its tests), self-contained spec (small models must not need repo-wide context), explicit acceptance criteria, file hints, dependency edges. Avoid mock-heavy designs; prefer real seams. |
| `/sb-orchestrate` | master | The run loop: read tasks + events, mark unblocked tasks `ready`, react to `needs_review`/`changes_requested`/`approved`, drive merges into the integration branch, run layer-validation gates, re-plan if drift detected. Idles when nothing to do; Switchboard nudges it (see §6.2). |
| `/sb-work <task-id>` | worker | Boot command: read spec + `guidelines.md`, implement in its worktree, run lint/tests, self-review against acceptance criteria, set `needs_review`, summarize in events. |
| `/sb-review <task-id>` | reviewer | Adversarial multi-lens review of the task branch diff: correctness, security, maintainability, lint/style vs `guidelines.md`, spec conformance ("is this the right approach", not just "does it work"). Verdict file + status transition. Modeled on the Codex adversarial-review pattern. |
| `/sb-merge <task-id>` | master/merge worker | Rebase task branch onto integration branch, resolve trivial conflicts, run the layer's validation suite, mark `done`, delete worktree (via a request Switchboard fulfils). |

Per-role system prompts are injected with `--append-system-prompt-file` pointing at generated files
under `.switchboard/runs/<id>/prompts/` — so workers boot with the style guide and "stay inside your
worktree, only touch your task" constraints baked in, regardless of which model is behind the profile.

**Layered validation:** chunks declare a validation command (e.g. `npm test`, a smoke script). The
master only marks a chunk complete when all its leaf tasks are merged *and* the chunk gate passes on
the integration branch — this is what keeps the app working as layers build up and catches drift early.

## 6. Switchboard backend changes

### 6.1 `orchestrator-watcher.js` (new)

- `fs.watch` (recursive) on each open project's `.switchboard/runs/`, debounced; parse `run.json`,
  task files, tail `events.jsonl`.
- Maintains in-memory run state; pushes `orchestration-updated` IPC deltas to the renderer.
- Mirrors state into new SQLite tables (`orch_runs`, `orch_tasks`, `orch_events`) for history,
  cross-restart GUI, and joining tasks to `session_cache` rows via sessionIds.

### 6.2 `orchestrator-spawner.js` (new)

- On task `ready` (when `run.policy.autoSpawn*` and concurrency caps allow):
  1. Ensure worktree: `git worktree add <path> -b <branch> <integrationBranch>` (via new
     `worktree-manager.js`, path-guarded like existing fs access).
  2. Generate a session UUID; write it into the task file with status `spawning`.
  3. Spawn through the **existing** `openTerminal` path with
     `sessionOptions = { profileId: roles[task.role].profileId, cwd: worktreePath, sessionId,
     initialPrompt: "/sb-work T-014", appendSystemPromptFile, permissionMode: "acceptEdits" }`.
     (`claude-cmd.js` needs a new validated `initialPrompt` argument — quoted prompt after flags.)
  4. Status → `in_progress`; record in events.
- On `needs_review` → same flow with the reviewer role/profile (reviewer gets the main repo or a
  read-only checkout of the branch).
- **Master nudges:** when a status the master cares about changes and the master PTY is idle (we
  already track busy/idle via OSC), send a single line into the master's PTY:
  `"[switchboard] T-014 → needs_review; T-009 → approved. Run /sb-orchestrate."` This is the
  event-driven alternative to the master burning tokens polling — Switchboard acts as a messenger,
  not a brain. (Fallback: master polls on a timer if nudging is disabled.)
- Concurrency, retry caps (`attempts`), and a global kill-switch (`run.status = paused` stops all
  spawning instantly).

### 6.3 `claude-cmd.js` / spawn-path extensions

- Add `initialPrompt` (validated/escaped) and `appendSystemPromptFile` support.
- Allow `cwd` ≠ registered project folder when it's a child of the project (worktrees live under
  `.switchboard/worktrees/`), with path-guard checks.

### 6.4 Keep the sessions sidebar sane (explicit requirement)

- Extend `derive-project-path.js` to strip `/.switchboard/worktrees/<task>` like it already strips
  `/.claude-worktrees/<name>` — child transcripts index under the parent project.
- Tag orchestration sessions: workers/reviewers get `slug = run-id` via the pre-seeded JSONL trick
  `schedule-runner.js` already uses (or matched post-hoc by sessionId from task files).
- Sidebar: sessions whose IDs belong to a run render **collapsed under one run row** by default
  (reuse the existing slug-group UI), with a setting "hide team sessions from the main list" so your
  day-to-day session list stays exactly as it is today. Core sessions are untouched.

### 6.5 IPC additions (preload.js)

`orchestration:list-runs`, `orchestration:get-run(runId)`, `orchestration:run-action(runId, action)`
(pause/resume/abandon), `orchestration:task-action(taskId, action)` (retry, force-review, open
worktree, approve/reject — GUI actions are written *into the task files*, so even human overrides go
through the same protocol the master reads), plus the `orchestration-updated` push channel.

## 7. GUI: the Orchestration view

New top-level view (alongside Sessions/Plans/Brain in `plans-memory-view.js` navigation), per run:

1. **Run header** — title, status, progress (n/m leaf tasks done per chunk), active session count,
   role→profile badges (so you can see at a glance "master: Fable · workers: DeepSeek"), pause/resume.
2. **Plan pane** — `plan.md` rendered (existing markdown/viewer-panel machinery) beside a collapsible
   **task tree** (epic → chunk → leaf) with status-colored nodes; this is the "state of the world vs
   the overarching plan" picture.
3. **Board pane** — kanban columns mirroring the status machine (Backlog · Ready · In progress ·
   Review · Merging · Done · Blocked). Cards show task title, files hint, attempt count, live
   busy-spinner if a session is attached. Click → focus the live terminal, or open the JSONL viewer
   for finished sessions, or open the branch diff (reuse file-panel's diff component against the
   worktree).
4. **Team grid** — the existing `grid-view.js` filtered to the run's live sessions: watch all workers
   typing at once, click into any to intervene.
5. **Timeline** — rendered `events.jsonl` (spawns, reviews, merges, gate results) for audit.

Phase-2 GUI niceties: cost/token roll-up per run (parse usage from JSONL entries we already index),
chunk gate results, "re-plan requested" alerts from the master.

## 8. Delivery phases

**Phase 0 — Spike (1–2 days of work).** Prove the risky seams before building:
- Spawn `claude --session-id <uuid> "/sb-work T-001"` in a worktree with the DeepSeek profile from
  Switchboard; confirm transcript lands where expected and profile env applies.
- Confirm `--append-system-prompt-file` + initial prompt + pinned session-id compose.
- Manually walk one task through the status machine with hand-written files.

**Phase 1 — File protocol + agent pack.** Schema docs, `/sb-plan`, `/sb-decompose`, `/sb-work`,
`/sb-review`, `/sb-orchestrate` commands, `guidelines.md` template, prompts generation. Usable with
*manual* spawning (you open worker terminals yourself) — proves the methodology end-to-end with zero
GUI risk.

**Phase 2 — Backend plumbing.** Watcher, spawner, worktree manager, DB tables, claude-cmd extensions,
sidebar grouping/hiding, IPC. Auto-spawn now works; runs survive Switchboard restarts.

**Phase 3 — Orchestration view.** Run header, plan tree, board, team grid, timeline.

**Phase 4 — Review & merge hardening.** Multi-lens adversarial review (parallel reviewers with
distinct lenses for security/maintainability/lint), chunk validation gates, auto-merge policy,
changes-requested loop (resume the original worker session with reviewer feedback via `--resume`).

**Phase 5 — Polish.** Cost roll-ups, re-planning flows (master revises plan mid-run), failure
recovery UX, profile presets per role, templates for common run shapes.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| File-watch races between master/workers/Switchboard | Single-writer-per-transition rule; atomic rename writes; append-only events; watcher debounce. |
| Small-model workers wandering outside their task | Self-contained specs, worktree confinement, `--append-system-prompt-file` constraints, reviewer gate, attempt caps. |
| Worktree JSONLs fragmenting the sidebar | §6.4 path normalization + run-grouping + hide toggle (explicit requirement). |
| Master context blow-up on long runs | State lives on disk; `/sb-orchestrate` is restartable; nudge-driven rather than polling. |
| Many simultaneous PTYs/xterms on screen | Concurrency caps per role; grid already virtualizes reasonably; only attach renderer terminals for visible sessions (reattach buffer already exists). |
| Windows specifics (worktree paths, fs.watch recursion) | `fs.watch` recursive is supported on Windows; path-guard already handles win32 paths; spike validates worktrees on D:. |
| DeepSeek/alt-provider quirks in interactive mode | Profiles already battle-tested in Switchboard; spike re-verifies with `--session-id` + initial prompt; stability flags already in presets. |
| Merge conflicts between parallel tasks | Decomposer biases toward disjoint file sets; dependency edges serialize known overlaps; merge step rebases + runs gates; conflicts escalate to master (or you). |

## 10. Explicitly out of scope (for now)

- Running workers headless/detached (the visible-PTY decision can be revisited later; the protocol
  doesn't care how a session was spawned).
- Cross-machine/remote teams.
- Replacing Claude Code's own subagents/workflows — those remain available *inside* any session;
  this system orchestrates *between* sessions.
