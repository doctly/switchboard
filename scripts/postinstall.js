#!/usr/bin/env node
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Install native dependencies for Electron
try {
  execSync('npx electron-builder install-app-deps', { stdio: 'inherit' });
} catch (err) {
  console.error('electron-builder install-app-deps failed:', err.message);
  // Fallback: rebuild only better-sqlite3 for Electron (node-pty uses prebuilds)
  console.log('Attempting fallback: rebuilding better-sqlite3 for Electron...');
  try {
    execSync('npx @electron/rebuild -f -m . -o better-sqlite3', { stdio: 'inherit' });
    console.log('Fallback rebuild succeeded.');
  } catch (err2) {
    console.error('Fallback rebuild also failed:', err2.message);
  }
}

// macOS/Linux: ad-hoc codesign native modules & fix node-pty permissions
if (process.platform !== 'win32') {
  // Ad-hoc codesign all .node files so macOS doesn't block them
  try {
    const nodeModules = path.join(__dirname, '..', 'node_modules');
    findFiles(nodeModules, '.node').forEach(file => {
      try {
        execFileSync('codesign', ['--sign', '-', '--force', file], { stdio: 'ignore' });
      } catch {}
    });
  } catch {}

  // Ensure node-pty spawn-helper is executable
  const spawnHelperGlob = path.join(
    __dirname, '..', 'node_modules', 'node-pty', 'prebuilds'
  );
  if (fs.existsSync(spawnHelperGlob)) {
    try {
      findFiles(spawnHelperGlob, 'spawn-helper').forEach(file => {
        fs.chmodSync(file, 0o755);
      });
    } catch {}
  }
}

function findFiles(dir, suffix) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const safeName = entry.name.replace(/[\\/]/g, '');
      const full = dir + path.sep + safeName;
      if (entry.isDirectory()) {
        results.push(...findFiles(full, suffix));
      } else if (safeName.endsWith(suffix)) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}
