const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const PREVIEW_SCHEME = 'switchboard-preview';
const PREVIEW_SCHEMES = [{
  scheme: PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}];
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MIME_TYPES = {
  '.html': 'text/html', '.htm': 'text/html',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
// A preview receives an unguessable URL for its asset folder, never a file://
// URL or an IPC bridge. The handler only serves read-only web assets in it.
const rootsByToken = new Map();
const tokensByRoot = new Map();

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function createPreviewAssetUrl(filePath, projectRoot = path.dirname(filePath)) {
  const root = fs.realpathSync(projectRoot);
  const file = fs.realpathSync(filePath);
  if (!within(root, file)) throw new Error('Preview file is outside its asset folder');
  let token = tokensByRoot.get(root);
  if (!token) {
    token = randomBytes(24).toString('hex');
    tokensByRoot.set(root, token);
    rootsByToken.set(token, root);
  }
  const relative = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/');
  return `${PREVIEW_SCHEME}://${token}/${relative}`;
}

async function handlePreviewAssetRequest(request) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const fail = status => new Response(null, { status, headers });
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405);
  try {
    const url = new URL(request.url);
    const root = rootsByToken.get(url.hostname);
    if (url.protocol !== `${PREVIEW_SCHEME}:` || !root || url.username || url.password || url.port) return fail(404);
    const relative = decodeURIComponent(url.pathname.slice(1));
    // Do not expose dotfiles, repository metadata or hidden configuration.
    if (relative.split(/[\\/]/).some(part => part.startsWith('.'))) return fail(403);
    const candidate = path.resolve(root, relative);
    if (!within(root, candidate)) return fail(403);
    const resolved = await fs.promises.realpath(candidate);
    if (!within(root, resolved) || path.relative(root, resolved).split(path.sep).some(part => part.startsWith('.'))) return fail(403);
    const mimeType = MIME_TYPES[path.extname(resolved).toLowerCase()];
    if (!mimeType) return fail(403);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) return fail(404);
    if (stat.size > MAX_ASSET_BYTES) return fail(413);
    headers['Content-Type'] = mimeType;
    const body = request.method === 'HEAD' ? null : await fs.promises.readFile(resolved);
    return new Response(body, { headers });
  } catch {
    return fail(404);
  }
}

module.exports = { PREVIEW_SCHEME, PREVIEW_SCHEMES, MAX_ASSET_BYTES, createPreviewAssetUrl, handlePreviewAssetRequest };
