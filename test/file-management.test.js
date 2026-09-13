const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { manageProjectEntry } = require('../file-management');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-file-actions-'));
  const root = path.join(temp, 'project');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const calls = [];
  const dependencies = {
    shell: {
      showItemInFolder: file => calls.push(['reveal', file]),
      openPath: async file => { calls.push(['open', file]); return ''; },
      trashItem: async file => { calls.push(['trash', file]); fs.renameSync(file, path.join(temp, 'trashed')); },
    },
    confirmTrash: async () => true,
  };
  const run = (rel, action, name) => manageProjectEntry(root, rel, action, name, dependencies);
  return { temp, root, calls, dependencies, run };
}

test('rename preserves file bytes and directory contents and never overwrites an existing entry', async t => {
  const { root, run } = fixture(t);
  fs.mkdirSync(path.join(root, 'source'));
  fs.writeFileSync(path.join(root, 'source', 'notes.md'), 'keep my work');
  const renamed = await run('source', 'rename', 'renamed');
  assert.equal(renamed.newRelativePath, 'renamed');
  assert.equal(fs.readFileSync(path.join(root, 'renamed', 'notes.md'), 'utf8'), 'keep my work');
  await run(path.join('renamed', 'notes.md'), 'rename', 'draft.md');
  fs.writeFileSync(path.join(root, 'renamed', 'taken.md'), 'other work');
  await assert.rejects(run(path.join('renamed', 'draft.md'), 'rename', 'taken.md'), /already exists/);
  assert.equal(fs.readFileSync(path.join(root, 'renamed', 'taken.md'), 'utf8'), 'other work');
  assert.equal(fs.readFileSync(path.join(root, 'renamed', 'draft.md'), 'utf8'), 'keep my work');
});

test('file actions reject project roots, traversal, invalid names and unknown operations', async t => {
  const { root, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'notes.md'), 'keep');
  for (const rel of ['', '.', 'folder/..', '../project', '../outside', path.join(root, 'notes.md')]) {
    await assert.rejects(run(rel, 'trash'));
  }
  for (const name of ['', '.', '..', '../outside', 'nested/name', 'nested\\name', 'bad\0name']) {
    await assert.rejects(run('notes.md', 'rename', name));
  }
  await assert.rejects(run('notes.md', 'erase'), /Unknown/);
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), 'keep');
});

test('cancelled deletion leaves files intact; confirmed deletion uses the OS trash', async t => {
  const { root, temp, calls, dependencies, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'notes.md'), 'recoverable');
  dependencies.confirmTrash = async () => false;
  assert.equal((await run('notes.md', 'trash')).cancelled, true);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(root, 'notes.md')), true);
  dependencies.confirmTrash = async () => true;
  await run('notes.md', 'trash');
  assert.equal(calls[0][0], 'trash');
  assert.equal(fs.readFileSync(path.join(temp, 'trashed'), 'utf8'), 'recoverable');
});

test('trash errors propagate without falling back to permanent deletion', async t => {
  const { root, dependencies, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'notes.md'), 'keep');
  dependencies.shell.trashItem = async () => { throw new Error('Trash unavailable'); };
  await assert.rejects(run('notes.md', 'trash'), /Trash unavailable/);
  assert.equal(fs.existsSync(path.join(root, 'notes.md')), true);
});

test('reveal selects the item; opening is limited to folders', async t => {
  const { root, calls, run } = fixture(t);
  fs.mkdirSync(path.join(root, 'folder'));
  fs.writeFileSync(path.join(root, 'notes.md'), 'keep');
  await run('notes.md', 'reveal');
  await run('folder', 'open-folder');
  assert.deepEqual(calls.map(call => call[0]), ['reveal', 'open']);
  await assert.rejects(run('notes.md', 'open-folder'), /Not a folder/);
});

test('symlink operations affect the link and reject escapes through parent directories', { skip: process.platform === 'win32' }, async t => {
  const { root, temp, run } = fixture(t);
  fs.writeFileSync(path.join(temp, 'outside.txt'), 'outside work');
  fs.symlinkSync(path.join(temp, 'outside.txt'), path.join(root, 'link'));
  await run('link', 'rename', 'renamed-link');
  assert.equal(fs.lstatSync(path.join(root, 'renamed-link')).isSymbolicLink(), true);
  await run('renamed-link', 'trash');
  assert.equal(fs.readFileSync(path.join(temp, 'outside.txt'), 'utf8'), 'outside work');
  fs.symlinkSync(temp, path.join(root, 'escape'));
  await assert.rejects(run('escape/outside.txt', 'trash'), /outside/);
  fs.symlinkSync(path.join(temp, 'missing'), path.join(root, 'dangling'));
  fs.writeFileSync(path.join(root, 'notes.md'), 'keep');
  await assert.rejects(run('notes.md', 'rename', 'dangling'), /already exists/);
});

test('replacing an item during confirmation cannot trash its replacement', async t => {
  const { root, calls, dependencies, run } = fixture(t);
  const file = path.join(root, 'notes.md');
  fs.writeFileSync(file, 'original');
  dependencies.confirmTrash = async () => {
    fs.renameSync(file, path.join(root, 'original.md'));
    fs.writeFileSync(file, 'replacement');
    return true;
  };
  await assert.rejects(run('notes.md', 'trash'), /item changed/);
  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
});
