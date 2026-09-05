const fs = require('fs');
const path = require('path');

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.db', '.dmg', '.dll', '.doc',
  '.docx', '.dylib', '.eot', '.exe', '.gif', '.gz', '.ico', '.jar', '.jpeg',
  '.jpg', '.mov', '.mp3', '.mp4', '.o', '.otf', '.pdf', '.png', '.ppt', '.pptx',
  '.pyc', '.rar', '.so', '.sqlite', '.sqlite3', '.tar', '.tiff', '.ttf', '.wav',
  '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.xz', '.zip',
]);

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function resolveProjectEntry(projectPath, relativePath = '') {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new Error('Project path must be absolute');
  }
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error('Invalid project-relative path');
  }

  const root = fs.realpathSync(projectPath);
  const candidate = path.resolve(root, relativePath);
  if (!isWithinRoot(root, candidate)) {
    throw new Error('Path is outside the project folder');
  }
  const resolved = fs.realpathSync(candidate);
  if (!isWithinRoot(root, resolved)) {
    throw new Error('Path is outside the project folder');
  }
  return { root, resolved };
}

function isViewableFile(filePath, stat) {
  if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return false;
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  if (!stat.size) return true;

  const sampleSize = Math.min(stat.size, 8192);
  const sample = Buffer.allocUnsafe(sampleSize);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, sample, 0, sampleSize, 0);
  } finally {
    fs.closeSync(fd);
  }
  return !sample.includes(0);
}

function listProjectDirectory(projectPath, relativePath = '') {
  const { root, resolved } = resolveProjectEntry(projectPath, relativePath);
  const directoryStat = fs.lstatSync(resolved);
  if (!directoryStat.isDirectory()) throw new Error('Path is not a directory');

  return fs.readdirSync(resolved, { withFileTypes: true }).map(dirent => {
    const absolutePath = path.join(resolved, dirent.name);
    const stat = fs.lstatSync(absolutePath);
    const entryRelativePath = path.relative(root, absolutePath);
    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    let viewable = false;
    if (type === 'file') {
      try { viewable = isViewableFile(absolutePath, stat); } catch {}
    }
    return {
      name: dirent.name,
      relativePath: entryRelativePath,
      type,
      size: stat.size,
      viewable,
    };
  }).sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function readProjectFile(projectPath, relativePath) {
  const { resolved } = resolveProjectEntry(projectPath, relativePath);
  const stat = fs.lstatSync(resolved);
  if (!isViewableFile(resolved, stat)) {
    throw new Error(stat.size > MAX_PREVIEW_BYTES
      ? 'File is too large to preview'
      : 'File type cannot be previewed');
  }
  return { filePath: resolved, content: fs.readFileSync(resolved, 'utf8') };
}

module.exports = {
  MAX_PREVIEW_BYTES,
  isViewableFile,
  listProjectDirectory,
  readProjectFile,
  resolveProjectEntry,
};
