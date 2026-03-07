const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const { getAllMeta, toggleStar, setName, setArchived } = require('./db');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));

// Active PTY sessions
const activeSessions = new Map();
const MAX_BUFFER_SIZE = 256 * 1024; // 256KB of output history per session

// GET /api/sessions/active - list running PTY sessions
app.get('/api/sessions/active', (req, res) => {
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) active.push(sessionId);
  }
  res.json(active);
});

// POST /api/sessions/:id/stop - kill PTY process
app.post('/api/sessions/:id/stop', (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session || session.exited) {
    return res.json({ ok: false, error: 'not running' });
  }
  session.pty.kill();
  res.json({ ok: true });
});

// POST /api/sessions/:id/star - toggle star
app.post('/api/sessions/:id/star', (req, res) => {
  const starred = toggleStar(req.params.id);
  res.json({ starred });
});

// POST /api/sessions/:id/rename - set display name
app.post('/api/sessions/:id/rename', (req, res) => {
  const name = req.body.name || null;
  setName(req.params.id, name);
  res.json({ name });
});

// POST /api/sessions/:id/archive - set archived flag
app.post('/api/sessions/:id/archive', (req, res) => {
  const archived = req.body.archived ? 1 : 0;
  setArchived(req.params.id, archived);
  res.json({ archived });
});

// GET /api/projects - list projects and their sessions
app.get('/api/projects', (req, res) => {
  try {
    const showArchived = req.query.archived === '1';
    const metaMap = getAllMeta();

    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);

    const projects = [];

    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      const indexPath = path.join(folderPath, 'sessions-index.json');
      let projectPath = '/' + folder.replace(/-/g, '/').replace(/^\//, '');
      let sessions = [];

      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
          if (index.originalPath) projectPath = index.originalPath;
          sessions = (index.entries || [])
            .filter(e => !e.isSidechain && (e.messageCount || 0) > 1
              && (!e.fullPath || fs.existsSync(e.fullPath)))
            .map(e => {
              const meta = metaMap.get(e.sessionId);
              return {
                sessionId: e.sessionId,
                summary: e.summary || e.firstPrompt || '(no summary)',
                firstPrompt: e.firstPrompt || '',
                created: e.created,
                modified: e.modified,
                messageCount: e.messageCount || 0,
                projectPath: e.projectPath || projectPath,
                name: meta?.name || null,
                starred: meta?.starred || 0,
                archived: meta?.archived || 0,
              };
            })
            .filter(s => showArchived || !s.archived)
            .sort((a, b) => new Date(b.modified) - new Date(a.modified));
        } catch (err) {
          console.error(`Error reading index for ${folder}:`, err.message);
        }
      }

      // Fallback: list .jsonl files
      if (sessions.length === 0) {
        try {
          const jsonlFiles = fs.readdirSync(folderPath)
            .filter(f => f.endsWith('.jsonl'));
          for (const file of jsonlFiles) {
            const sessionId = path.basename(file, '.jsonl');
            const stat = fs.statSync(path.join(folderPath, file));
            // Try to read first user message as summary; skip empty sessions
            let summary = '';
            try {
              const content = fs.readFileSync(path.join(folderPath, file), 'utf8');
              const lines = content.split('\n').filter(Boolean);
              for (const line of lines) {
                const entry = JSON.parse(line);
                if (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user')) {
                  const msg = entry.message;
                  const text = typeof msg === 'string' ? msg :
                    (typeof msg?.content === 'string' ? msg.content :
                    (msg?.content?.[0]?.text || ''));
                  if (text) {
                    summary = text.slice(0, 120);
                    break;
                  }
                }
              }
            } catch {}
            if (!summary) continue; // skip sessions with no user messages
            const meta = metaMap.get(sessionId);
            const s = {
              sessionId,
              summary,
              firstPrompt: summary,
              created: stat.birthtime.toISOString(),
              modified: stat.mtime.toISOString(),
              messageCount: 0,
              projectPath,
              name: meta?.name || null,
              starred: meta?.starred || 0,
              archived: meta?.archived || 0,
            };
            if (!showArchived && s.archived) continue;
            sessions.push(s);
          }
          sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
        } catch {}
      }

      if (sessions.length > 0) {
        projects.push({ folder, projectPath, sessions });
      }
    }

    // Sort projects by most recent session
    projects.sort((a, b) => {
      const aDate = a.sessions[0]?.modified || '';
      const bDate = b.sessions[0]?.modified || '';
      return new Date(bDate) - new Date(aDate);
    });

    res.json(projects);
  } catch (err) {
    console.error('Error listing projects:', err);
    res.status(500).json({ error: err.message });
  }
});

// WebSocket handler
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const sessionId = params.get('sessionId');
  const projectPath = params.get('projectPath');

  if (!sessionId || !projectPath) {
    ws.send('\r\nError: missing sessionId or projectPath\r\n');
    ws.close();
    return;
  }

  // Check for existing active session — reattach
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    // The existing ptyProcess.onData handler already sends to all sockets
    // in session.sockets, so we just add this socket — no extra onData needed.
    session.sockets.add(ws);

    // If TUI is in alternate screen mode, switch client into it before redraw
    // so xterm.js uses the alt buffer (no stray cursor on the normal buffer)
    if (session.altScreen && ws.readyState === 1) {
      ws.send('\x1b[?1049h');
    }

    let firstResize = true;
    ws.on('message', msg => {
      const msgStr = msg.toString();
      try {
        const parsed = JSON.parse(msgStr);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          session.pty.resize(parsed.cols, parsed.rows);
          // After the client's first resize, nudge to guarantee SIGWINCH
          // even if dimensions matched. This forces the TUI to fully redraw.
          if (firstResize) {
            firstResize = false;
            setTimeout(() => {
              try {
                session.pty.resize(parsed.cols + 1, parsed.rows);
                setTimeout(() => {
                  try { session.pty.resize(parsed.cols, parsed.rows); } catch {}
                }, 50);
              } catch {}
            }, 50);
          }
          return;
        }
      } catch {}
      session.pty.write(msgStr);
    });

    ws.on('close', () => {
      session.sockets.delete(ws);
      cleanupIfDone(sessionId);
    });
    return;
  }

  // Spawn new PTY
  const isNew = params.get('new') === '1';
  if (!fs.existsSync(projectPath)) {
    ws.send(`\r\nError: project directory no longer exists: ${projectPath}\r\n`);
    ws.close();
    return;
  }
  const cwd = projectPath;
  const shell = process.env.SHELL || '/bin/zsh';

  // Snapshot existing .jsonl files before spawning (for new session detection)
  let existingJsonl = new Set();
  if (isNew) {
    const projFolder = Object.keys(PROJECTS_DIR).length ? '' :
      fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .find(name => {
          const decoded = '/' + name.replace(/-/g, '/').replace(/^\//, '');
          return decoded === projectPath || projectPath.startsWith(decoded);
        });
    // Find the .claude/projects folder for this project
    const projectDirName = projectPath.replace(/\//g, '-').replace(/^-/, '-');
    const claudeProjectDir = path.join(PROJECTS_DIR, projectDirName);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        existingJsonl = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }
  }

  const claudeCmd = isNew ? 'claude' : `claude --resume "${sessionId}"`;
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, ['-l', '-c', claudeCmd], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    ws.send(`\r\nError spawning PTY: ${err.message}\r\n`);
    ws.close();
    return;
  }

  const session = {
    pty: ptyProcess, sockets: new Set([ws]), exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath,
  };
  activeSessions.set(sessionId, session);

  ptyProcess.onData(data => {
    // Track alternate screen mode (used by TUI apps like Claude Code)
    if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) session.altScreen = true;
    if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) session.altScreen = false;

    // Append to output buffer for replay on reattach
    session.outputBuffer.push(data);
    session.outputBufferSize += data.length;
    while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
      session.outputBufferSize -= session.outputBuffer.shift().length;
    }

    for (const sock of session.sockets) {
      if (sock.readyState === 1) sock.send(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    for (const sock of session.sockets) {
      if (sock.readyState === 1) {
        sock.send(`\r\n[Process exited with code ${exitCode}]\r\n`);
        sock.close();
      }
    }
    activeSessions.delete(session.realSessionId || sessionId);
  });

  // For new sessions, detect the real session ID by watching for new .jsonl files
  if (isNew) {
    const projectDirName = projectPath.replace(/\//g, '-').replace(/^-/, '-');
    const claudeProjectDir = path.join(PROJECTS_DIR, projectDirName);
    let detectAttempts = 0;
    const detectInterval = setInterval(() => {
      detectAttempts++;
      if (detectAttempts > 30 || session.exited) { clearInterval(detectInterval); return; }
      try {
        const current = fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'));
        const newFile = current.find(f => !existingJsonl.has(f));
        if (newFile) {
          clearInterval(detectInterval);
          const realId = path.basename(newFile, '.jsonl');
          session.realSessionId = realId;
          // Re-key in activeSessions so the real ID is used for reattach/status
          activeSessions.delete(sessionId);
          activeSessions.set(realId, session);
          // Notify all connected clients
          for (const sock of session.sockets) {
            if (sock.readyState === 1) {
              sock.send(JSON.stringify({ type: 'session-detected', sessionId: realId }));
            }
          }
        }
      } catch {}
    }, 1000);
  }

  ws.on('message', msg => {
    const msgStr = msg.toString();
    try {
      const parsed = JSON.parse(msgStr);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        ptyProcess.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {}
    ptyProcess.write(msgStr);
  });

  ws.on('close', () => {
    session.sockets.delete(ws);
    cleanupIfDone(sessionId);
  });
});

function cleanupIfDone(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  if (session.sockets.size === 0 && session.exited) {
    activeSessions.delete(sessionId);
  }
}

server.listen(PORT, () => {
  console.log(`Claude Session Browser running at http://localhost:${PORT}`);
});
