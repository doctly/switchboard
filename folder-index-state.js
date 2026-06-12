const fs = require('fs');
const { enumerateSessionFiles } = require('./read-session-file');

function getFolderIndexMtimeMs(folderPath) {
  let indexMtimeMs = 0;

  try {
    indexMtimeMs = fs.statSync(folderPath).mtimeMs;
  } catch {
    return 0;
  }

  // Stat every transcript this folder would index — top-level sessions AND
  // subagent transcripts under <folder>/<id>/subagents/ — using the same
  // enumeration as refreshFolder. Session files are appended in place, which
  // bumps the file mtime but often leaves the containing directory mtime
  // unchanged; and a folder whose ONLY change was a subagent transcript would
  // be missed entirely if we only readdir'd the top level.
  try {
    for (const { filePath } of enumerateSessionFiles(folderPath)) {
      try {
        const fileMtimeMs = fs.statSync(filePath).mtimeMs;
        if (fileMtimeMs > indexMtimeMs) indexMtimeMs = fileMtimeMs;
      } catch {}
    }
  } catch {}

  return indexMtimeMs;
}

module.exports = { getFolderIndexMtimeMs };
