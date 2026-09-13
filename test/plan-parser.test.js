const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePlan, parseTodos, toggleLine, appendItem, tickedTexts } = require('../public/plan-parser');

const TRACKER = `# Feature plan tracker

## Phase 1: Groundwork
- [x] Read the code
- [x] Write the design

## [ ] Phase 2: Build
- [x] Database
- [ ] Renderer
  - [ ] nested item counts too

## Phase 3: Ship
- [ ] Release notes

## [x] Phase 4: Follow-ups
`;

test('parsePlan reads level-2 headings as phases and knows which is next', () => {
  const plan = parsePlan(TRACKER);
  assert.equal(plan.total, 4);
  assert.deepEqual(plan.phases.map(p => p.title), ['Phase 1: Groundwork', 'Phase 2: Build', 'Phase 3: Ship', 'Phase 4: Follow-ups']);
  assert.deepEqual(plan.phases.map(p => p.done), [true, false, false, true], 'all items ticked, heading unticked, open, heading ticked');
  assert.deepEqual(plan.phases.map(p => `${p.ticked}/${p.items.length}`), ['2/2', '1/3', '0/1', '0/0']);
  assert.equal(plan.done, 2);
  assert.equal(plan.next.title, 'Phase 2: Build');
  assert.equal(plan.phases[1].line, 6, 'heading line is recorded for ticking');
  assert.equal(plan.phases[1].items[1].line, 8);
});

test('parsePlan with no headings treats top-level items as phases; empty input is empty', () => {
  const plan = parsePlan('- [x] first\n- [ ] second\n  - [ ] nested\n');
  assert.deepEqual(plan.phases.map(p => [p.title, p.done]), [['first', true], ['second', false]]);
  assert.equal(plan.next.title, 'second');
  assert.deepEqual(parsePlan(''), { phases: [], done: 0, total: 0, next: null });
  assert.deepEqual(parsePlan(null).phases, []);
});

test('parseTodos lists every checkbox with its line', () => {
  const items = parseTodos('# Todos\r\n\r\n- [ ] one\r\n* [x] two\r\nplain text\r\n');
  assert.deepEqual(items, [{ line: 2, text: 'one', done: false }, { line: 3, text: 'two', done: true }]);
});

test('toggleLine flips one item or heading and leaves the rest untouched', () => {
  const item = toggleLine(TRACKER, 8, true);
  assert.equal(item.ok, true);
  assert.equal(item.text, 'Renderer');
  assert.equal(item.content.split('\n')[8], '- [x] Renderer');
  assert.equal(item.content.length, TRACKER.length, 'same size, one character changed');

  const heading = toggleLine(TRACKER, 6, true);
  assert.equal(heading.content.split('\n')[6], '## [x] Phase 2: Build');
  const plain = toggleLine(TRACKER, 2, true);
  assert.equal(plain.content.split('\n')[2], '## [x] Phase 1: Groundwork', 'a heading without a box gets one');
  assert.equal(toggleLine(TRACKER, 1, true).ok, false, 'blank line is not a checkbox');
  assert.equal(toggleLine(TRACKER, 999, true).ok, false);
});

test('appendItem starts an empty file with a heading and appends a line', () => {
  assert.equal(appendItem('', 'Add ledger', 'Site todos'), '# Site todos\n\n- [ ] Add ledger\n');
  assert.equal(appendItem('# T\n- [ ] a', 'b'), '# T\n- [ ] a\n- [ ] b\n');
});

test('tickedTexts diffs which items and phases got done', () => {
  const before = tickedTexts(TRACKER);
  const after = tickedTexts(toggleLine(toggleLine(TRACKER, 8, true).content, 6, true).content);
  const newly = [...after].filter(t => !before.has(t));
  assert.deepEqual(newly.sort(), ['Phase 2: Build', 'Renderer']);
});
