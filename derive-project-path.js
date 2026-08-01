const fs = require('fs');
const path = require('path');

function extractCwdFromJsonl(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

// Maps a worktree cwd to its parent repo path. Exported for callers that need
// the parent ↔ worktree relationship. Deliberately NOT applied in
// deriveProjectPath: the sidebar nests worktree projects under their parent by
// matching the full worktree projectPath, so collapsing at index time would
// erase the worktree grouping (and break worktree-scoped actions like delete).
function resolveWorktreePath(cwd) {
  if (!cwd) return cwd;
  // Detect worktree paths: <project>/.claude-worktrees/<name>, <project>/.worktrees/<name>, or <project>/.claude/worktrees/<name>
  const worktreeMatch = cwd.match(/^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/[^/]+\/?$/);
  if (worktreeMatch) {
    const parent = worktreeMatch[1];
    if (fs.existsSync(parent)) return parent;
  }
  return cwd;
}

function deriveProjectPath(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = extractCwdFromJsonl(path.join(folderPath, e.name));
        if (cwd) return cwd;
      }
    }
    // Check session subdirectories (UUID folders with subagent .jsonl files)
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
            const cwd = extractCwdFromJsonl(jsonlPath);
            if (cwd) return cwd;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = { deriveProjectPath, resolveWorktreePath };
