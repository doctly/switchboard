const path = require('path');
const fs = require('fs');

/** Subagent transcripts land under <folder>/<parentSessionId>/subagents/agent-<agentId>.jsonl.
 *  We surface them as first-class rows with a synthetic sessionId so they're addressable
 *  exactly like top-level sessions (search, archive, rename, etc).
 */
function subagentSessionId(parentSessionId, agentId) {
  if (parentSessionId.includes(':')) throw new TypeError(`parentSessionId must not contain ':': ${parentSessionId}`);
  if (agentId.includes(':')) throw new TypeError(`agentId must not contain ':': ${agentId}`);
  return `sub:${parentSessionId}:${agentId}`;
}

/** Resolve the absolute jsonl path for a row from session_cache.
 *  Works for both top-level sessions and subagents. */
function resolveJsonlPath(projectsDir, row) {
  if (!row || !row.folder) return null;
  if (row.parentSessionId && row.agentId) {
    return path.join(projectsDir, row.folder, row.parentSessionId, 'subagents', `agent-${row.agentId}.jsonl`);
  }
  return path.join(projectsDir, row.folder, row.sessionId + '.jsonl');
}

/** Read sidecar { agentType, description } if present. */
function readSubagentMeta(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/** A user turn that contains ONLY tool_result blocks isn't a real message —
 *  it's the harness feeding tool output back to the model. Counting these
 *  inflates per-day message counts dramatically (observed 116991 msg/day).
 *  Returns true only when content is a non-empty array whose every item is a
 *  {type:'tool_result'} block. */
function isToolResultOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(c => c && c.type === 'tool_result');
}

/** Pure helper: given an array of raw JSONL lines (strings) and a fallback date
 *  (YYYY-MM-DD, used when a line has no usable timestamp), accumulate per-(date,
 *  model) metrics. Returns an array of:
 *    { date, model, messageCount, toolCallCount, inputTokens, outputTokens,
 *      cacheReadTokens, cacheCreationTokens }
 *  Tokens and tool calls are only attributed to assistant lines; synthetic /
 *  model-less assistant lines bucket under model '' (counted as a message but
 *  with zero tokens). User turns that are purely tool_result aren't counted as
 *  messages. Non-message line types are ignored entirely.
 */
function extractDailyMetrics(lines, fallbackDate) {
  const map = new Map();
  const bucket = (date, model) => {
    const key = `${date}|${model}`;
    let m = map.get(key);
    if (!m) {
      m = {
        date, model,
        messageCount: 0, toolCallCount: 0,
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
      };
      map.set(key, m);
    }
    return m;
  };

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = typeof entry.timestamp === 'string' && entry.timestamp.length >= 10
      ? entry.timestamp.slice(0, 10)
      : fallbackDate;

    const isAssistant = entry.type === 'assistant' ||
      (entry.type === 'message' && entry.role === 'assistant');
    const isUser = entry.type === 'user' ||
      (entry.type === 'message' && entry.role === 'user');

    if (isAssistant) {
      let model = entry.message?.model || '';
      if (model === '<synthetic>') model = '';
      const m = bucket(ts, model);
      m.messageCount += 1;
      if (model) {
        const usage = entry.message?.usage || {};
        m.inputTokens += usage.input_tokens | 0;
        m.outputTokens += usage.output_tokens | 0;
        m.cacheReadTokens += usage.cache_read_input_tokens | 0;
        m.cacheCreationTokens += usage.cache_creation_input_tokens | 0;
      }
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_use') m.toolCallCount += 1;
        }
      }
    } else if (isUser) {
      if (isToolResultOnly(entry.message?.content)) continue;
      bucket(ts, '').messageCount += 1;
    }
  }

  return Array.from(map.values());
}

/** Parse a single .jsonl file into a session object (or null if invalid).
 *  opts.parentSessionId — if set, treat as a subagent transcript and stamp the
 *  parent reference into the returned row.
 */
function readSessionFile(filePath, folder, projectPath, opts = {}) {
  const fileBase = path.basename(filePath, '.jsonl');
  const isSubagent = Boolean(opts.parentSessionId);
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let slug = null;
    let customTitle = null;
    let aiTitle = null;
    let agentId = null;
    let sidechainSeen = false;
    for (const line of lines) {
      // Per-line try/catch: a JSONL file being written concurrently by a live
      // Claude CLI session can have its tail captured mid-write — one truncated
      // line should not invalidate the whole file. Skip the malformed line and
      // keep parsing.
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.agentId && !agentId) agentId = entry.agentId;
      if (entry.isSidechain) sidechainSeen = true;
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      }
      if (entry.type === 'user' || entry.type === 'assistant' ||
          (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
        messageCount++;
      }
      const msg = entry.message;
      const text = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        // Skip local command messages (! prefix) — use the next real user message
        if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
          // Use scheduled task name if present
          const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
        }
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }
    if (!summary || messageCount < 1) return null;

    const fallbackDate = stat.mtime.toISOString().slice(0, 10);
    const dailyMetrics = extractDailyMetrics(lines, fallbackDate);

    if (isSubagent) {
      // Sidechain marker must be present — otherwise the file lives under a
      // subagents/ directory but isn't actually a subagent transcript. Bail.
      if (!sidechainSeen) return null;
      if (!agentId) {
        // Fall back to filename: agent-<id>.jsonl
        const m = fileBase.match(/^agent-(.+)$/);
        if (m) agentId = m[1];
      }
      if (!agentId) return null;
      const meta = readSubagentMeta(filePath) || {};
      const subagentType = meta.agentType || null;
      const description = meta.description || null;
      return {
        sessionId: subagentSessionId(opts.parentSessionId, agentId),
        folder, projectPath,
        summary: description || summary,
        firstPrompt: summary,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        messageCount, textContent, slug, customTitle, aiTitle,
        parentSessionId: opts.parentSessionId,
        agentId,
        subagentType,
        description,
        dailyMetrics,
      };
    }

    return {
      sessionId: fileBase, folder, projectPath,
      summary, firstPrompt: summary,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle, aiTitle,
      dailyMetrics,
    };
  } catch {
    return null;
  }
}

/** Enumerate every jsonl in a project folder: top-level sessions plus any
 *  subagent transcripts under <folder>/<parentSessionId>/subagents/*.jsonl
 *  (or directly under <folder>/<parentSessionId>/*.jsonl for legacy layouts).
 *  Returns [{ filePath, sessionId, parentSessionId|null }]. */
function enumerateSessionFiles(folderPath) {
  const out = [];
  let topEntries;
  try {
    topEntries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch { return out; }

  // Top-level .jsonl files = ordinary sessions
  for (const e of topEntries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({
        filePath: path.join(folderPath, e.name),
        sessionId: path.basename(e.name, '.jsonl'),
        parentSessionId: null,
      });
    }
  }

  // UUID subdirs may hold subagent transcripts
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    const parentSessionId = e.name;
    const subDir = path.join(folderPath, parentSessionId);
    // Preferred layout: subagents/ subfolder
    const subagentsDir = path.join(subDir, 'subagents');
    try {
      if (fs.statSync(subagentsDir).isDirectory()) {
        for (const f of fs.readdirSync(subagentsDir)) {
          if (!f.endsWith('.jsonl')) continue;
          out.push({
            filePath: path.join(subagentsDir, f),
            sessionId: path.basename(f, '.jsonl'),
            parentSessionId,
          });
        }
        continue;
      }
    } catch {}
    // Fallback: jsonl directly in the UUID dir (older CLI versions)
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        out.push({
          filePath: path.join(subDir, f),
          sessionId: path.basename(f, '.jsonl'),
          parentSessionId,
        });
      }
    } catch {}
  }

  return out;
}

/** Lightweight refresh path. Reads only the first ~256 KB / 500 lines of a
 *  jsonl file to extract display-level metadata (summary, slug, titles,
 *  agentId). Does NOT compute textContent or messageCount — the caller is
 *  expected to merge with the cached row for unchanged fields. Designed so
 *  the fs.watch flush can update a live 200+ MB host-session JSONL in ~ms
 *  instead of seconds.
 *
 *  Returns the same shape as the display subset of readSessionFile() so it
 *  can be merged into a cached row before upsert. Returns null if the chunk
 *  doesn't yet contain a usable first-user-message.
 */
function readSessionDisplayHeader(filePath, opts = {}) {
  const fileBase = path.basename(filePath, '.jsonl');
  const isSubagent = Boolean(opts.parentSessionId);
  const MAX_BYTES = 256 * 1024;
  const MAX_LINES = 500;
  try {
    const stat = fs.statSync(filePath);
    const readLen = Math.min(MAX_BYTES, stat.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readLen);
    const n = fs.readSync(fd, buf, 0, readLen, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf8', 0, n);
    const lines = text.split('\n');
    // Drop the potentially-partial last line unless we read the whole file
    if (n < stat.size) lines.pop();

    let summary = '';
    let slug = null, customTitle = null, aiTitle = null, agentId = null;
    let sidechainSeen = false;
    let lineCount = 0;
    for (const line of lines) {
      if (!line) continue;
      if (++lineCount > MAX_LINES) break;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.agentId && !agentId) agentId = entry.agentId;
      if (entry.isSidechain) sidechainSeen = true;
      if (entry.type === 'custom-title' && entry.customTitle && !customTitle) customTitle = entry.customTitle;
      if (entry.type === 'ai-title' && entry.aiTitle && !aiTitle) aiTitle = entry.aiTitle;
      const msg = entry.message;
      const txt = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        if (txt && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(txt)) {
          const taskMatch = txt.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : txt.slice(0, 120);
        }
      }
    }

    if (!summary) return null;

    if (isSubagent) {
      if (!sidechainSeen) return null;
      if (!agentId) {
        const m = fileBase.match(/^agent-(.+)$/);
        if (m) agentId = m[1];
      }
      if (!agentId) return null;
      const meta = readSubagentMeta(filePath) || {};
      return {
        sessionId: subagentSessionId(opts.parentSessionId, agentId),
        summary: meta.description || summary,
        firstPrompt: summary,
        modified: stat.mtime.toISOString(),
        slug, customTitle, aiTitle,
        parentSessionId: opts.parentSessionId,
        agentId,
        subagentType: meta.agentType || null,
        description: meta.description || null,
      };
    }

    return {
      sessionId: fileBase,
      summary, firstPrompt: summary,
      modified: stat.mtime.toISOString(),
      slug, customTitle, aiTitle,
    };
  } catch {
    return null;
  }
}

module.exports = { readSessionFile, readSessionDisplayHeader, subagentSessionId, resolveJsonlPath, readSubagentMeta, enumerateSessionFiles, extractDailyMetrics, isToolResultOnly };
