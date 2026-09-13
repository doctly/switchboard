const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MAX_ASSET_BYTES, createPreviewAssetUrl, handlePreviewAssetRequest } = require('../preview-assets');
const { readProjectFile } = require('../project-files');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-preview-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pages', 'demo #1.html'), '<h1>Demo</h1>');
  const preview = readProjectFile(root, 'pages/demo #1.html');
  const request = (relative, method = 'GET') => handlePreviewAssetRequest({ url: new URL(relative, preview.previewUrl).href, method });
  return { dir, root, preview, request };
}

test('HTML gets a scoped asset URL; relative CSS, modules and data can load without file access', async t => {
  const { root, preview, request } = setup(t);
  fs.writeFileSync(path.join(root, 'style.css'), 'body { color: teal }');
  fs.writeFileSync(path.join(root, 'app.mjs'), 'export const value = 42;');
  fs.writeFileSync(path.join(root, 'data.json'), '{"count":2}');
  assert.match(preview.previewUrl, /^switchboard-preview:\/\/[a-f0-9]{48}\/pages\/demo%20%231.html$/);
  const css = await request('../style.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css');
  assert.equal(css.headers.get('access-control-allow-origin'), '*');
  assert.equal(await css.text(), 'body { color: teal }');
  assert.equal((await request('../app.mjs')).headers.get('content-type'), 'text/javascript');
  assert.deepEqual(await (await request('../data.json')).json(), { count: 2 });
  assert.equal(createPreviewAssetUrl(path.join(root, 'pages/demo #1.html'), root), preview.previewUrl);
});

test('asset requests cannot write, read hidden/non-web files or leave the registered folder', async t => {
  const { dir, root, request } = setup(t);
  fs.writeFileSync(path.join(dir, 'outside.js'), 'secret');
  fs.writeFileSync(path.join(root, 'ok.js'), 'public');
  fs.writeFileSync(path.join(root, '.env.json'), '{"token":"secret"}');
  fs.writeFileSync(path.join(root, 'private.pem'), 'secret');
  fs.symlinkSync(path.join(dir, 'outside.js'), path.join(root, 'escape.js'));
  fs.symlinkSync(path.join(root, '.env.json'), path.join(root, 'hidden.json'));
  assert.equal((await request('../ok.js', 'POST')).status, 405);
  assert.equal(fs.readFileSync(path.join(root, 'ok.js'), 'utf8'), 'public');
  assert.equal((await request('../.env.json')).status, 403);
  assert.equal((await request('../private.pem')).status, 403);
  assert.equal((await request('../escape.js')).status, 403);
  assert.equal((await request('../hidden.json')).status, 403);
  assert.equal((await request('/..%2foutside.js')).status, 403);
  assert.equal((await request('/..%5coutside.js')).status, 403);
  assert.equal((await request('switchboard-preview://unknown/ok.js')).status, 404);
  assert.equal((await request('file://' + path.join(dir, 'outside.js'))).status, 404);
});

test('asset loader bounds reads, supports HEAD and uses distinct scopes per folder', async t => {
  const { dir, root, preview, request } = setup(t);
  const file = path.join(root, 'huge.png');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, MAX_ASSET_BYTES + 1);
  assert.equal((await request('../huge.png')).status, 413);
  const head = await request('demo%20%231.html', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await request('../pages')).status, 403);
  fs.writeFileSync(path.join(dir, 'other.html'), '<h1>Other</h1>');
  assert.notEqual(new URL(createPreviewAssetUrl(path.join(dir, 'other.html'))).hostname, new URL(preview.previewUrl).hostname);
  assert.throws(() => createPreviewAssetUrl(path.join(dir, 'other.html'), root), /outside/);
});
