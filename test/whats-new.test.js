const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANNOUNCEMENT_KEY,
  SLIDES,
  shouldShowAnnouncement,
  markAnnouncementDismissed,
  wrappedSlideIndex,
} = require('../public/whats-new');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('Project View announcement shows until it is dismissed', () => {
  const storage = memoryStorage();
  assert.equal(shouldShowAnnouncement(storage), true);
  markAnnouncementDismissed(storage);
  assert.equal(storage.getItem(ANNOUNCEMENT_KEY), '1');
  assert.equal(shouldShowAnnouncement(storage), false);
});

test('screenshot navigation wraps in both directions', () => {
  assert.equal(SLIDES.length, 4);
  assert.equal(wrappedSlideIndex(0, -1), 3);
  assert.equal(wrappedSlideIndex(3, 1), 0);
  assert.equal(wrappedSlideIndex(1, 1), 2);
});
