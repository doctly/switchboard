const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexMtimeMs } = require('../folder-index-state');

const PROJECTS_DIR = workerData.projectsDir;

function deriveProjectPath(folderPath, folder) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const firstLine = fs.readFileSync(path.join(folderPath, e.name), 'utf8').split('\n')[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          if (parsed.cwd) return parsed.cwd;
        }
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(folderPath, e.name);
      try {
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          let jsonlPath;
          if (sf.isFile() && sf.name.endsWith('.jsonl')) {
            jsonlPath = path.join(subDir, sf.name);
          } else if (sf.isDirectory() && sf.name === 'subagents') {
            const agentFiles = fs.readdirSync(path.join(subDir, 'subagents')).filter(f => f.endsWith('.jsonl'));
            if (agentFiles.length > 0) jsonlPath = path.join(subDir, 'subagents', agentFiles[0]);
          }
          if (jsonlPath) {
            const firstLine = fs.readFileSync(jsonlPath, 'utf8').split('\n')[0];
            if (firstLine) {
              const parsed = JSON.parse(firstLine);
              if (parsed.cwd) return parsed.cwd;
            }
          }
        }
      } catch {}
    }
  } catch {}
  // No cwd found — return null so callers can skip this folder
  return null;
}

function readFolderFromFilesystem(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) return null;
  const sessions = [];
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  try {
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const filePath = path.join(folderPath, file);
      const sessionId = path.basename(file, '.jsonl');
      const stat = fs.statSync(filePath);
      let summary = '';
      let messageCount = 0;
      let textContent = '';
      let slug = null;
      let customTitle = null;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          const entry = JSON.parse(line);
          if (entry.slug && !slug) slug = entry.slug;
          if (entry.type === 'custom-title' && entry.customTitle) {
            customTitle = entry.customTitle;
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
            if (text) summary = text.slice(0, 120);
          }
          if (text && textContent.length < 8000) {
            textContent += text.slice(0, 500) + '\n';
          }
        }
      } catch {}
      if (!summary || messageCount < 1) continue;
      sessions.push({
        sessionId, folder, projectPath,
        summary, firstPrompt: summary,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        messageCount, textContent, slug, customTitle,
      });
    }
  } catch {}

  return { folder, projectPath, sessions, indexMtimeMs };
}

// Scan all folders
try {
  const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.git')
    .map(d => d.name);

  const results = [];
  for (let i = 0; i < folders.length; i++) {
    if (i % 5 === 0 || i === folders.length - 1) {
      parentPort.postMessage({ type: 'progress', text: `Scanning projects (${i + 1}/${folders.length})\u2026` });
    }
    const result = readFolderFromFilesystem(folders[i]);
    if (result) results.push(result);
  }
  parentPort.postMessage({ ok: true, results });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
