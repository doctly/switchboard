const path = require('path');
const fs = require('fs');
const { readSubagentMeta } = require('./read-session-file');

/**
 * Fork / plan-accept detection for active PTY sessions.
 * Call init(ctx) once with shared context.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log, rekeyMcpServer;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  rekeyMcpServer = ctx.rekeyMcpServer;
}

// --- Subagent spawn / completion detection ---

/** Walk <folder>/<sessionId>/subagents/ and detect new or completed subagent files.
 *  Mutates session.knownSubagents (Map<agentId, { mtimeMs, completed }>).
 *  Emits IPC 'subagent-spawned' and 'subagent-completed' via mainWindow. */
function detectSubagentTransitions(sessionId, session, folderPath) {
  const subagentsDir = path.join(folderPath, sessionId, 'subagents');
  let files;
  try {
    files = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return; // directory doesn't exist yet — normal
  }

  // First walk for this session: pre-populate knownSubagents with every
  // existing file silently so we don't flood the renderer with spawn/complete
  // events for agents that already finished before Switchboard started watching.
  // Files modified in the last 60s get a normal lifecycle; older ones are
  // recorded as already-completed without IPC.
  const isBootstrap = !session.knownSubagents;
  if (isBootstrap) {
    session.knownSubagents = new Map();
  }

  const mainWindow = getMainWindow();
  const now = Date.now();
  const STABLE_MS = 30000; // 30 seconds of no mtime advance → completed
  const BOOTSTRAP_LIVE_MS = 60000; // file modified in last 60s = still alive at boot

  for (const file of files) {
    // agent-<agentId>.jsonl
    const m = file.match(/^agent-(.+)\.jsonl$/);
    if (!m) continue;
    const agentId = m[1];
    const filePath = path.join(subagentsDir, file);

    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const mtimeMs = stat.mtimeMs;

    const known = session.knownSubagents.get(agentId);

    if (!known) {
      if (isBootstrap) {
        // Cold-start initialization — record silently without firing IPC.
        // Treat recently-modified files as still-active so they can complete
        // through the normal lifecycle; treat older ones as already done.
        const looksAlive = (now - mtimeMs) < BOOTSTRAP_LIVE_MS;
        session.knownSubagents.set(agentId, {
          mtimeMs,
          completed: !looksAlive,
          _completedAt: looksAlive ? null : now,
        });
        continue;
      }
      // First sighting post-bootstrap — real spawn event
      const meta = readSubagentMeta(filePath) || {};
      session.knownSubagents.set(agentId, { mtimeMs, completed: false });
      log.info(`[subagent-spawn] parent=${sessionId} agentId=${agentId} type=${meta.agentType || 'unknown'}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('subagent-spawned', {
          parentSessionId: sessionId,
          agentId,
          subagentType: meta.agentType || null,
          description: meta.description || null,
        });
      }
    } else if (!known.completed) {
      if (mtimeMs !== known.mtimeMs) {
        // File is still being written — update mtime, reset stability clock
        known.mtimeMs = mtimeMs;
        known._stableStart = null;
      } else {
        // mtime stable — start or continue stability timer
        if (!known._stableStart) {
          known._stableStart = now;
        } else if (now - known._stableStart >= STABLE_MS) {
          known.completed = true;
          log.info(`[subagent-complete] parent=${sessionId} agentId=${agentId}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('subagent-completed', {
              parentSessionId: sessionId,
              agentId,
            });
          }
        }
      }
    }
  }

  // GC: remove completed entries after 5 minutes to avoid unbounded growth
  const GC_TTL = 5 * 60 * 1000;
  for (const [agentId, state] of session.knownSubagents) {
    if (state.completed && state._completedAt && now - state._completedAt > GC_TTL) {
      session.knownSubagents.delete(agentId);
    }
    if (state.completed && !state._completedAt) {
      state._completedAt = now;
    }
  }
}

// --- Fork / plan-accept detection ---

/** Read first few lines of a new .jsonl to extract signals.
 *  Skips file-history-snapshot lines which can be very large (tens of KB)
 *  and reads up to 512KB to find the first user/assistant entry. */
function readNewSessionSignals(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(524288);
    const bytesRead = fs.readSync(fd, buf, 0, 524288, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    const lines = head.split('\n').filter(Boolean);
    let forkedFrom = null;
    let planContent = false;
    let slug = null;
    let parentSessionId = null;
    let hasSnapshots = false;
    for (const line of lines) {
      const entry = JSON.parse(line);
      // Skip snapshot lines — they carry no fork/session signals
      if (entry.type === 'file-history-snapshot') { hasSnapshots = true; continue; }
      if (entry.forkedFrom) forkedFrom = entry.forkedFrom.sessionId;
      if (entry.planContent) planContent = true;
      if (entry.slug && !slug) slug = entry.slug;
      // --fork-session copies messages with original sessionId
      if (entry.sessionId && !parentSessionId) parentSessionId = entry.sessionId;
      // Stop after finding a user or assistant message
      if (entry.type === 'user' || entry.type === 'assistant') break;
    }
    return { forkedFrom, planContent, slug, parentSessionId, hasSnapshots };
  } catch {
    return { forkedFrom: null, planContent: false, slug: null, parentSessionId: null, hasSnapshots: false };
  }
}

/** Read tail of old session file for ExitPlanMode and slug */
function readOldSessionTail(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const readSize = Math.min(size, 8192);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const hasExitPlanMode = tail.includes('ExitPlanMode');
    // Extract slug from tail (last occurrence)
    let slug = null;
    const slugMatches = tail.match(/"slug"\s*:\s*"([^"]+)"/g);
    if (slugMatches) {
      const last = slugMatches[slugMatches.length - 1].match(/"slug"\s*:\s*"([^"]+)"/);
      if (last) slug = last[1];
    }
    return { hasExitPlanMode, slug };
  } catch {
    return { hasExitPlanMode: false, slug: null };
  }
}

/** Detect fork or plan-accept transitions for active PTY sessions in a folder */
function detectSessionTransitions(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  let currentFiles;
  try {
    currentFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  for (const [sessionId, session] of [...activeSessions]) {
    // Run subagent detection for all non-exited, non-terminal sessions in this folder
    if (!session.exited && !session.isPlainTerminal && session.projectFolder === folder) {
      const effectiveSessionId = session.realSessionId || sessionId;
      detectSubagentTransitions(effectiveSessionId, session, folderPath);
    }

    if (session.exited || session.isPlainTerminal || !session.knownJsonlFiles || session.projectFolder !== folder) {
      if (!session.exited && !session.isPlainTerminal && session.forkFrom) {
        log.info(`[fork-detect] skipped session=${sessionId} forkFrom=${session.forkFrom||'none'} reason=${session.exited ? 'exited' : session.isPlainTerminal ? 'terminal' : !session.knownJsonlFiles ? 'noKnown' : 'folderMismatch('+session.projectFolder+' vs '+folder+')'}`);
      }
      continue;
    }

    const newFiles = currentFiles.filter(f => !session.knownJsonlFiles.has(f));

    if (newFiles.length > 0) log.debug(`[detect] session=${sessionId} forkFrom=${session.forkFrom||'none'} folder=${folder} newFiles=${newFiles.length} knownCount=${session.knownJsonlFiles.size} currentCount=${currentFiles.length}`);

    if (newFiles.length === 0) continue;

    const emptyFiles = new Set(); // files with no signals yet (still being written)

    for (const newFile of newFiles) {
      const newFilePath = path.join(folderPath, newFile);
      const newId = path.basename(newFile, '.jsonl');
      const signals = readNewSessionSignals(newFilePath);

      // File exists but has no parseable content yet — skip and retry next cycle
      // But if the file's mtime is older than 1 hour, treat it as stale and archive it
      if (!signals.forkedFrom && !signals.parentSessionId && !signals.slug && !signals.planContent) {
        // Fork file with only snapshots (no user turn yet) — match immediately
        if (signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
          log.info(`[detect] session=${sessionId} matching snapshot-only fork file=${newId}`);
          // Fall through to matching logic — will match via the fork-snapshot path below
        } else {
          let stale = false;
          try {
            const mtime = fs.statSync(path.join(folderPath, newFile)).mtimeMs;
            if (Date.now() - mtime > 3600000) stale = true;
          } catch {}
          if (stale) {
            log.info(`[detect] session=${sessionId} archiving stale empty file=${newId}`);
          } else {
            emptyFiles.add(newFile);
          }
          continue;
        }
      }

      if (session.forkFrom) {
        log.info(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=${session.forkFrom}`);
      } else {
        log.debug(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=none`);
      }

      let matched = false;

      // Fork: forkedFrom.sessionId matches this active PTY or the session it was forked from
      if (signals.forkedFrom === sessionId || (session.forkFrom && signals.forkedFrom === session.forkFrom)) {
        matched = true;
      }
      // --fork-session: new file's parentSessionId matches the forkFrom source,
      // and the new file's name (newId) differs from both our PTY id and the source
      if (!matched && session.forkFrom && signals.parentSessionId === session.forkFrom && newId !== session.forkFrom) {
        matched = true;
      }
      // Fork file with only snapshots — no user turn yet, but this session is waiting for a fork
      if (!matched && signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
        matched = true;
      }

      if (session.forkFrom && !matched) {
        log.info(`[detect] session=${sessionId} NO MATCH for newFile=${newId} forkFrom=${session.forkFrom} parentSessionId=${signals.parentSessionId||'null'} forkedFrom=${signals.forkedFrom||'null'}`);
      }

      // Plan-accept: shared slug + planContent + old session has ExitPlanMode
      if (!matched && signals.planContent && signals.slug) {
        const oldFilePath = path.join(folderPath, sessionId + '.jsonl');
        const oldTail = readOldSessionTail(oldFilePath);
        if (oldTail.hasExitPlanMode && oldTail.slug === signals.slug) {
          // Temporal check: new file created within 30s of old file's last modification
          try {
            const oldMtime = fs.statSync(oldFilePath).mtimeMs;
            const newMtime = fs.statSync(newFilePath).mtimeMs;
            if (Math.abs(newMtime - oldMtime) < 30000) {
              matched = true;
            }
          } catch {}
        }
      }

      if (matched) {
        log.info(`[session-transition] ${sessionId} → ${newId} (${signals.forkedFrom || session.forkFrom ? 'fork' : 'plan-accept'})`);
        session.knownJsonlFiles = new Set(currentFiles);
        session.realSessionId = newId;
        // Update slug from new session
        if (signals.slug) session.sessionSlug = signals.slug;
        activeSessions.delete(sessionId);
        activeSessions.set(newId, session);
        // Re-key MCP server to match new session ID
        rekeyMcpServer(sessionId, newId);
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-forked', sessionId, newId);
        }
        break; // Only one transition per session per flush
      }
    }

    // Update known files, but exclude empty ones so they get rechecked next cycle
    const updated = new Set(currentFiles);
    for (const f of emptyFiles) updated.delete(f);
    session.knownJsonlFiles = updated;
  }
}


module.exports = { init, detectSessionTransitions, detectSubagentTransitions };
