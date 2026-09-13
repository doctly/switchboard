const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createPreviewAssetUrl } = require('./preview-assets');

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
};

function previewType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_MIME_TYPES[ext]) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'text';
}

function previewLimit(filePath) {
  return ['image', 'pdf', 'pptx'].includes(previewType(filePath)) ? MAX_MEDIA_PREVIEW_BYTES : MAX_PREVIEW_BYTES;
}
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
  if (!stat.isFile() || stat.size > previewLimit(filePath)) return false;
  if (['image', 'pdf', 'pptx'].includes(previewType(filePath))) return true;
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
      previewType: viewable ? previewType(absolutePath) : null,
    };
  }).sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function readProjectFile(projectPath, relativePath) {
  const { root, resolved } = resolveProjectEntry(projectPath, relativePath);
  return readPreviewFile(resolved, root);
}

function readPreviewFile(filePath, projectRoot) {
  const stat = fs.statSync(filePath);
  if (!isViewableFile(filePath, stat)) {
    const error = new Error(stat.size > previewLimit(filePath)
      ? 'File is too large to preview'
      : 'File type cannot be previewed');
    if (stat.isFile()) error.code = 'PREVIEW_UNAVAILABLE';
    throw error;
  }
  const type = previewType(filePath);
  const result = { filePath, previewType: type, fileUrl: pathToFileURL(filePath).href };
  if (type === 'html') result.previewUrl = createPreviewAssetUrl(filePath, projectRoot);
  if (type === 'pptx') result.previewUrl = createPreviewAssetUrl(path.join(__dirname, 'public', 'pptx-preview.html'));
  if (type === 'image' || type === 'pdf' || type === 'pptx') {
    const mimeType = type === 'pdf' ? 'application/pdf'
      : type === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()];
    return { ...result, mimeType, base64: fs.readFileSync(filePath).toString('base64') };
  }
  return { ...result, content: fs.readFileSync(filePath, 'utf8') };
}

// Only called for a user opening a file, never for background preview reads.
async function openFileExternally(filePath, projectRoot, shell) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('File path must be absolute');
  let resolved = fs.realpathSync(filePath);
  if (projectRoot != null) {
    const { root } = resolveProjectEntry(projectRoot);
    resolved = resolveProjectEntry(root, path.relative(root, resolved)).resolved;
  }
  if (!fs.statSync(resolved).isFile()) throw new Error('Not a file');
  const error = await shell.openPath(resolved);
  if (error) throw new Error(error);
  return { filePath: resolved };
}

module.exports = {
  MAX_PREVIEW_BYTES,
  MAX_MEDIA_PREVIEW_BYTES,
  isViewableFile,
  listProjectDirectory,
  readProjectFile,
  readPreviewFile,
  openFileExternally,
  resolveProjectEntry,
};
