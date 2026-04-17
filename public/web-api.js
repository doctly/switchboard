/**
 * Web mode API shim — implements the same window.api interface as preload.js
 * but uses fetch() and WebSocket instead of Electron IPC.
 *
 * Loaded by index.html only when window.api has not already been set by
 * Electron's preload script.
 */
(function () {
  if (window.api) return; // Electron mode — preload already set this up

  // ── Token ────────────────────────────────────────────────────────────
  // Read token from ?token= query param, localStorage, or prompt the user.

  function getToken() {
    const u = new URL(location.href);
    const qToken = u.searchParams.get('token');
    if (qToken) { localStorage.setItem('sb_token', qToken); return qToken; }
    return localStorage.getItem('sb_token') || '';
  }

  function promptToken() {
    const t = prompt('Enter your Switchboard access token:');
    if (t) { localStorage.setItem('sb_token', t); return t; }
    return '';
  }

  let token = getToken();
  if (!token) token = promptToken();

  // ── HTTP invoke ──────────────────────────────────────────────────────

  async function invoke(channel, ...args) {
    const res = await fetch('/api/invoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ channel, args }),
    });
    if (res.status === 401) {
      token = promptToken();
      if (token) return invoke(channel, ...args);
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }

  // ── WebSocket ────────────────────────────────────────────────────────

  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
    location.host + '/?token=' + encodeURIComponent(token);

  let ws = null;
  let wsReady = false;
  const wsQueue = [];
  const eventListeners = {}; // event → [callback, ...]

  function wsSend(msg) {
    const str = JSON.stringify(msg);
    if (ws && wsReady) {
      ws.send(str);
    } else {
      wsQueue.push(str);
    }
  }

  function connectWs() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsReady = true;
      for (const msg of wsQueue.splice(0)) ws.send(msg);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'event') {
        const cbs = eventListeners[msg.event] || [];
        for (const cb of cbs) cb(...(msg.args || []));
      }
    };

    ws.onclose = () => {
      wsReady = false;
      // Reconnect after a short back-off
      setTimeout(connectWs, 2000);
    };

    ws.onerror = () => { ws.close(); };
  }

  connectWs();

  function on(event, callback) {
    if (!eventListeners[event]) eventListeners[event] = [];
    eventListeners[event].push(callback);
  }

  // ── window.api ────────────────────────────────────────────────────────

  window.api = {
    // Invoke (request-response)
    getPlans:              ()                   => invoke('get-plans'),
    readPlan:              (f)                  => invoke('read-plan', f),
    savePlan:              (fp, c)              => invoke('save-plan', fp, c),
    getStats:              ()                   => invoke('get-stats'),
    refreshStats:          ()                   => invoke('refresh-stats'),
    getUsage:              ()                   => invoke('get-usage'),
    getMemories:           ()                   => invoke('get-memories'),
    readMemory:            (fp)                 => invoke('read-memory', fp),
    saveMemory:            (fp, c)              => invoke('save-memory', fp, c),
    getProjects:           (showArchived)       => invoke('get-projects', showArchived),
    getActiveSessions:     ()                   => invoke('get-active-sessions'),
    getActiveTerminals:    ()                   => invoke('get-active-terminals'),
    stopSession:           (id)                 => invoke('stop-session', id),
    toggleStar:            (id)                 => invoke('toggle-star', id),
    renameSession:         (id, name)           => invoke('rename-session', id, name),
    archiveSession:        (id, a)              => invoke('archive-session', id, a),
    openTerminal:          (id, pp, isNew, so)  => invoke('open-terminal', id, pp, isNew, so),
    search:                (t, q, to)           => invoke('search', t, q, to),
    readSessionJsonl:      (id)                 => invoke('read-session-jsonl', id),

    // Settings
    getSetting:            (k)                  => invoke('get-setting', k),
    setSetting:            (k, v)               => invoke('set-setting', k, v),
    deleteSetting:         (k)                  => invoke('delete-setting', k),
    getEffectiveSettings:  (pp)                 => invoke('get-effective-settings', pp),
    getShellProfiles:      ()                   => invoke('get-shell-profiles'),

    browseFolder:          ()                   => invoke('browse-folder'),
    addProject:            (pp)                 => invoke('add-project', pp),
    removeProject:         (pp)                 => invoke('remove-project', pp),
    openExternal:          (url)                => { window.open(url, '_blank', 'noopener'); },

    // Send (fire-and-forget, over WebSocket)
    sendInput:             (id, data)           => wsSend({ type: 'terminal-input', sessionId: id, data }),
    resizeTerminal:        (id, cols, rows)     => wsSend({ type: 'terminal-resize', sessionId: id, cols, rows }),
    closeTerminal:         (id)                 => wsSend({ type: 'close-terminal', sessionId: id }),

    // Listeners (server → client, over WebSocket)
    onTerminalData:        (cb) => on('terminal-data',        (id, d)        => cb(id, d)),
    onSessionDetected:     (cb) => on('session-detected',     (tid, rid)     => cb(tid, rid)),
    onProcessExited:       (cb) => on('process-exited',       (id, code)     => cb(id, code)),
    onTerminalNotification:(cb) => on('terminal-notification',(id, msg)      => cb(id, msg)),
    onCliBusyState:        (cb) => on('cli-busy-state',       (id, busy)     => cb(id, busy)),
    onSessionForked:       (cb) => on('session-forked',       (old, next)    => cb(old, next)),
    onProjectsChanged:     (cb) => on('projects-changed',     ()             => cb()),
    onStatusUpdate:        (cb) => on('status-update',        (text, type)   => cb(text, type)),

    // File drag-and-drop — not available in web mode
    getPathForFile:        () => '',

    // Platform
    platform: (() => {
      const p = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
      return p.includes('win') ? 'win32' : p.includes('mac') ? 'darwin' : 'linux';
    })(),

    // App version
    getAppVersion:         ()       => invoke('get-app-version'),

    // Auto-updater — not available in web mode
    updaterCheck:          ()       => Promise.resolve({ available: false, web: true }),
    updaterDownload:       ()       => Promise.resolve(null),
    updaterInstall:        ()       => Promise.resolve(null),
    onUpdaterEvent:        ()       => {},

    // MCP bridge (server → client)
    onMcpOpenDiff:         (cb) => on('mcp-open-diff',       (id, did, d)   => cb(id, did, d)),
    onMcpOpenFile:         (cb) => on('mcp-open-file',       (id, d)        => cb(id, d)),
    onMcpCloseAllDiffs:    (cb) => on('mcp-close-all-diffs', (id)           => cb(id)),
    onMcpCloseTab:         (cb) => on('mcp-close-tab',       (id, did)      => cb(id, did)),

    // MCP bridge (client → server, over WebSocket)
    mcpDiffResponse: (sessionId, diffId, action, editedContent) =>
      wsSend({ type: 'mcp-diff-response', sessionId, diffId, action, editedContent }),

    readFileForPanel:      (fp)     => invoke('read-file-for-panel', fp),
    saveFileForPanel:      (fp, c)  => invoke('save-file-for-panel', fp, c),
    watchFile:             (fp)     => invoke('watch-file', fp),
    unwatchFile:           (fp)     => invoke('unwatch-file', fp),
    onFileChanged:         (cb)     => on('file-changed', (fp) => cb(fp)),
  };
})();
