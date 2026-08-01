const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexMtimeMs } = require('../folder-index-state');
const { deriveProjectPath } = require('../derive-project-path');
const { readSessionFile, enumerateSessionFiles } = require('../read-session-file');

const PROJECTS_DIR = workerData.projectsDir;

function readFolderFromFilesystem(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) return null;
  const sessions = [];
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    try {
      const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
      if (s) sessions.push(s);
    } catch {}
  }

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
