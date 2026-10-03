// The field book's days: small hours belong to the night before, and one sitting is never split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keeping } from '../src/ui/journal.js';

const at = (d, hh, mm = 0) => new Date(2026, 9, d, hh, mm).getTime();

test('small hours belong to the night before', () => {
  const created = at(3, 20);
  assert.equal(keeping(at(3, 21, 30), created).label, 'the first night');
  assert.equal(keeping(at(4, 2), created).label, 'the first night');
  assert.equal(keeping(at(4, 9), created).label, 'the second morning');
  assert.equal(keeping(at(5, 18), created).label, 'the third evening');
});

test('a sitting that runs on past four stays in its own night', () => {
  const created = at(3, 3, 53), since = created;
  assert.equal(keeping(at(3, 3, 59), created, since).label, 'the first night');
  assert.equal(keeping(at(3, 4, 0), created, since).label, 'the first night');
  assert.equal(keeping(at(3, 5, 59), created, since).label, 'the first night');
  assert.equal(keeping(at(3, 6, 30), created, since).label, 'the first morning');
  // the same hour, come to fresh after a gap, is the next day
  assert.equal(keeping(at(3, 4, 0), created, at(3, 4, 0)).label, 'the second morning');
  // a very long sitting turns the day at noon
  assert.equal(keeping(at(3, 12, 30), created, since).label, 'the second afternoon');
});
