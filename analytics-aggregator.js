// analytics-aggregator.js — pure JSONL aggregation. No electron, no fs in
// the hot path: callers feed in raw line strings and stable context, the
// aggregator returns updated state. Lives at the project root so both the
// main process and the worker thread can require it. Pure → unit-testable.
//
// Schema produced (cache.totals):
//
//   byBackend[backendId] = {
//     sessions, turns,
//     inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
//     toolUseTurns,         // turns containing ≥1 tool_use block
//     subagentInvocations,  // count of tool_use blocks with name="Task"
//     errorTurns,           // turns containing ≥1 tool_result with is_error
//     models: { [modelName]: { turns, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } },
//     sessionIds: { [sessionId]: 1 },     // membership set for incremental session-count
//     firstSeen, lastSeen,
//   }
//   byDay["YYYY-MM-DD"] = {
//     turns, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
//     byBackend: { [backendId]: { turns, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } }
//   }
//
// "backendId" is either a profile id (from the session→profile map) or
// the literal string 'default' for unmapped sessions.

const SESSION_IDS_CAP = 10000;  // per-backend cap on the membership set
const DAY_RETENTION_DAYS = 365; // keep up to a year of daily buckets

function emptyState() {
  return {
    version: 1,
    byBackend: {},
    byDay: {},
    totals: {
      turns: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      toolUseTurns: 0, subagentInvocations: 0, errorTurns: 0,
    },
    recentSessions: {},  // sessionId -> { lastTimestamp, profileId, dominantModel, turns, totalTokens, projectPath }
  };
}

function newBackendBucket() {
  return {
    turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolUseTurns: 0, subagentInvocations: 0, errorTurns: 0,
    models: {},
    sessionIds: {},
    firstSeen: null,
    lastSeen: null,
  };
}

function newModelBucket() {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function newDayBucket() {
  return {
    turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    byBackend: {},
  };
}

function newDayBackendBucket() {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function dayKey(timestamp) {
  if (typeof timestamp !== 'string') return null;
  // Slice fast-path; works for ISO timestamps. Fall back to Date if not.
  if (timestamp.length >= 10 && timestamp[4] === '-' && timestamp[7] === '-') {
    return timestamp.slice(0, 10);
  }
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function minIso(a, b) { if (!a) return b; if (!b) return a; return a < b ? a : b; }
function maxIso(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }

// Process a single JSONL line for a session. `sessionId` is derived from
// the file name by the caller. `backendResolver(sessionId)` returns the
// backendId (a profile id or the literal 'default').
function processLine(line, sessionId, projectPath, backendResolver, state) {
  if (!line) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  if (!entry || entry.type !== 'assistant') return;
  const msg = entry.message;
  if (!msg) return;

  const usage = msg.usage || {};
  const inputT = usage.input_tokens || 0;
  const outputT = usage.output_tokens || 0;
  const cacheReadT = usage.cache_read_input_tokens || 0;
  const cacheCreateT = usage.cache_creation_input_tokens || 0;

  // Skip turns with no token data — these are usually content-free
  // streaming events that landed as separate assistant entries.
  if (inputT === 0 && outputT === 0 && cacheReadT === 0 && cacheCreateT === 0) return;

  const model = msg.model || 'unknown';
  const ts = entry.timestamp || null;
  const day = dayKey(ts);
  const backendId = backendResolver(sessionId) || 'default';

  // Tool-use scan over content blocks.
  let hasToolUse = false;
  let subagents = 0;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block && block.type === 'tool_use') {
        hasToolUse = true;
        if (block.name === 'Task') subagents++;
      }
    }
  }

  // Per-backend bucket.
  let b = state.byBackend[backendId];
  if (!b) b = state.byBackend[backendId] = newBackendBucket();
  b.turns++;
  b.inputTokens += inputT;
  b.outputTokens += outputT;
  b.cacheReadTokens += cacheReadT;
  b.cacheCreationTokens += cacheCreateT;
  if (hasToolUse) b.toolUseTurns++;
  b.subagentInvocations += subagents;
  if (ts) {
    b.firstSeen = minIso(b.firstSeen, ts);
    b.lastSeen = maxIso(b.lastSeen, ts);
  }
  // Session membership.
  if (!b.sessionIds[sessionId]) {
    b.sessionIds[sessionId] = 1;
    // Bound the set so it doesn't grow forever. Drop oldest insertion-order keys.
    const keys = Object.keys(b.sessionIds);
    if (keys.length > SESSION_IDS_CAP) {
      for (const k of keys.slice(0, keys.length - SESSION_IDS_CAP)) delete b.sessionIds[k];
    }
  }

  // Per-model bucket within backend.
  let m = b.models[model];
  if (!m) m = b.models[model] = newModelBucket();
  m.turns++;
  m.inputTokens += inputT;
  m.outputTokens += outputT;
  m.cacheReadTokens += cacheReadT;
  m.cacheCreationTokens += cacheCreateT;

  // By-day rollup.
  if (day) {
    let d = state.byDay[day];
    if (!d) d = state.byDay[day] = newDayBucket();
    d.turns++;
    d.inputTokens += inputT;
    d.outputTokens += outputT;
    d.cacheReadTokens += cacheReadT;
    d.cacheCreationTokens += cacheCreateT;
    let db = d.byBackend[backendId];
    if (!db) db = d.byBackend[backendId] = newDayBackendBucket();
    db.turns++;
    db.inputTokens += inputT;
    db.outputTokens += outputT;
    db.cacheReadTokens += cacheReadT;
    db.cacheCreationTokens += cacheCreateT;
  }

  // Top-level totals.
  state.totals.turns++;
  state.totals.inputTokens += inputT;
  state.totals.outputTokens += outputT;
  state.totals.cacheReadTokens += cacheReadT;
  state.totals.cacheCreationTokens += cacheCreateT;
  if (hasToolUse) state.totals.toolUseTurns++;
  state.totals.subagentInvocations += subagents;

  // Recent session entry — used by the UI's drill-down list.
  let rs = state.recentSessions[sessionId];
  if (!rs) rs = state.recentSessions[sessionId] = {
    sessionId, projectPath, profileId: backendId === 'default' ? null : backendId,
    dominantModel: model, turns: 0, totalTokens: 0, lastTimestamp: ts,
    firstTimestamp: ts,
  };
  rs.turns++;
  rs.totalTokens += inputT + outputT + cacheReadT + cacheCreateT;
  rs.lastTimestamp = maxIso(rs.lastTimestamp, ts);
  rs.firstTimestamp = minIso(rs.firstTimestamp, ts);
  // dominantModel = the most-recent model that produced a turn for this session
  rs.dominantModel = model;
}

// Process a chunk of newline-delimited JSON for a session, returning the
// number of bytes consumed (in UTF-8). Caller advances the watermark by
// that amount. Lines past the last newline are NOT consumed (incomplete).
function processChunk(text, sessionId, projectPath, backendResolver, state) {
  if (!text || text.length === 0) return 0;
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) return 0;  // no complete line
  const complete = text.slice(0, lastNewline);
  for (const line of complete.split('\n')) {
    if (line) processLine(line, sessionId, projectPath, backendResolver, state);
  }
  // Bytes consumed = utf8 byte length of the complete part, plus the newline.
  return Buffer.byteLength(complete, 'utf8') + 1;
}

// Pure post-processing for cache serialization: drop ancient daily buckets.
function pruneDays(state, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString().slice(0, 10);
  for (const day of Object.keys(state.byDay)) {
    if (day < cutoff) delete state.byDay[day];
  }
}

// Derived metrics used by the UI. Pure transform over a backend bucket.
function deriveBackendMetrics(b) {
  const sessions = Object.keys(b.sessionIds).length;
  const totalInputCount = b.inputTokens + b.cacheReadTokens;
  return {
    sessions,
    turns: b.turns,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheReadTokens: b.cacheReadTokens,
    cacheCreationTokens: b.cacheCreationTokens,
    toolUseTurns: b.toolUseTurns,
    subagentInvocations: b.subagentInvocations,
    errorTurns: b.errorTurns,
    cacheHitRate: totalInputCount > 0 ? b.cacheReadTokens / totalInputCount : 0,
    outputInputRatio: b.inputTokens > 0 ? b.outputTokens / b.inputTokens : 0,
    toolUseDensity: b.turns > 0 ? b.toolUseTurns / b.turns : 0,
    subagentRate: b.turns > 0 ? b.subagentInvocations / b.turns : 0,
    avgTurnsPerSession: sessions > 0 ? b.turns / sessions : 0,
    firstSeen: b.firstSeen,
    lastSeen: b.lastSeen,
    models: b.models,
  };
}

module.exports = {
  emptyState,
  processLine,
  processChunk,
  pruneDays,
  deriveBackendMetrics,
  DAY_RETENTION_DAYS,
  SESSION_IDS_CAP,
};
