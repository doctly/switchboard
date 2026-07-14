const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseRemoteListing,
  cwdToDisplay,
  diffChangedSessions,
  decodeFramedFiles,
  remoteJsonlCatArgs,
} = require('../remote-index');
const { parseRemoteProjectPath, remoteProjectPath } = require('../remote-hosts');

// --- parseRemoteListing ---

test('parseRemoteListing parses path, mtime, folder, sessionId, cwd', () => {
  const p = '/home/u/.claude/projects/-home-u-proj/aaa.jsonl';
  const r = parseRemoteListing(`${p}\t1700000000\t"cwd":"/home/u/proj"`);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].sessionId, 'aaa');
  assert.strictEqual(r[0].folder, '-home-u-proj');
  assert.strictEqual(r[0].path, p);
  assert.strictEqual(r[0].cwd, '/home/u/proj');
  assert.strictEqual(r[0].mtimeMs, 1700000000000);
  assert.strictEqual(r[0].modified, new Date(1700000000000).toISOString());
});

test('parseRemoteListing skips blank lines and lines with too few fields', () => {
  const p = '/home/u/.claude/projects/-p/x.jsonl';
  const input = [
    '',
    `${p}\t1700000000\t"cwd":"/p"`,
    '   ',
    '/only/one/field',
    '/two\t123',
  ].join('\n');
  const r = parseRemoteListing(input);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].sessionId, 'x');
});

test('parseRemoteListing yields empty cwd when the cwd field is absent/garbage', () => {
  const p = '/home/u/.claude/projects/-p/y.jsonl';
  const r = parseRemoteListing(`${p}\t1700000000\t`);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].cwd, '');
});

// --- cwdToDisplay ---

test('cwdToDisplay maps home-relative cwds to ~ and leaves outside paths absolute', () => {
  assert.strictEqual(cwdToDisplay('/home/u', '/home/u'), '~');
  assert.strictEqual(cwdToDisplay('/home/u/proj', '/home/u'), '~/proj');
  assert.strictEqual(cwdToDisplay('/home/u/a/b', '/home/u'), '~/a/b');
  assert.strictEqual(cwdToDisplay('/opt/work', '/home/u'), '/opt/work');
  assert.strictEqual(cwdToDisplay('', '/home/u'), '~');
});

// --- parseRemoteProjectPath (inverse of remoteProjectPath) ---

test('parseRemoteProjectPath round-trips with remoteProjectPath', () => {
  for (const [label, dir] of [['gpu', '~/proj'], ['web-1', '~'], ['h', '/abs/path']]) {
    const pp = remoteProjectPath(label, dir);
    const parsed = parseRemoteProjectPath(pp);
    assert.strictEqual(parsed.hostLabel, label);
    assert.strictEqual(parsed.remotePath, dir);
  }
  assert.strictEqual(parseRemoteProjectPath('/Users/x/proj'), null);
});

// --- diffChangedSessions ---

test('diffChangedSessions detects new, changed, and vanished sessions', () => {
  const listing = [
    { sessionId: 'a', modified: 'M1' },
    { sessionId: 'b', modified: 'M2' },
    { sessionId: 'c', modified: 'M3' },
  ];
  const cached = [
    { sessionId: 'a', modified: 'M1' },   // unchanged
    { sessionId: 'b', modified: 'OLD' },  // changed
    { sessionId: 'd', modified: 'X' },    // vanished
  ];
  const r = diffChangedSessions(listing, cached);
  assert.deepStrictEqual(r.toFetch.map(e => e.sessionId).sort(), ['b', 'c']);
  assert.deepStrictEqual(r.toDelete, ['d']);
});

// --- decodeFramedFiles ---

test('decodeFramedFiles splits by byte length, immune to marker in content', () => {
  const c1 = 'line1\nline2\n';
  const c2 = 'SWBF 99 /fake.jsonl\ninner\n'; // content that looks like a header
  const buf = Buffer.concat([
    Buffer.from(`SWBF ${Buffer.byteLength(c1)} /a.jsonl\n`), Buffer.from(c1),
    Buffer.from(`SWBF ${Buffer.byteLength(c2)} /b.jsonl\n`), Buffer.from(c2),
  ]);
  const r = decodeFramedFiles(buf);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].path, '/a.jsonl');
  assert.strictEqual(r[0].content, c1);
  assert.strictEqual(r[1].path, '/b.jsonl');
  assert.strictEqual(r[1].content, c2);
});

test('decodeFramedFiles handles multibyte content by byte length', () => {
  const c = 'héllo✓ world\n';
  const buf = Buffer.concat([
    Buffer.from(`SWBF ${Buffer.byteLength(c)} /m.jsonl\n`), Buffer.from(c),
  ]);
  const r = decodeFramedFiles(buf);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].content, c);
});

// --- remoteJsonlCatArgs (live View messages) ---

test('remoteJsonlCatArgs builds a BatchMode cat over the control socket with a safe path', () => {
  const host = { source: 'config', alias: 'gpu', id: 'h1' };
  const args = remoteJsonlCatArgs(host, '/tmp/s.sock', '-home-u-proj', 'R1');
  assert.ok(args.includes('gpu'), 'targets the host alias');
  assert.ok(args.some(a => a === 'BatchMode=yes'), 'never blocks on a prompt');
  const cmd = args[args.length - 1];
  assert.strictEqual(cmd, `cat "$HOME/.claude/projects/"'-home-u-proj'/'R1'.jsonl`);
});

test('decodeFramedFiles ignores an incomplete trailing frame and empty input', () => {
  assert.deepStrictEqual(decodeFramedFiles(Buffer.from('')), []);
  const c1 = 'ok\n';
  const buf = Buffer.concat([
    Buffer.from(`SWBF ${Buffer.byteLength(c1)} /a.jsonl\n`), Buffer.from(c1),
    Buffer.from('SWBF 500 /truncated.jsonl\nonly a little'), // claims 500 bytes, has few
  ]);
  const r = decodeFramedFiles(buf);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].path, '/a.jsonl');
});
