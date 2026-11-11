import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldAutoClose } from './auto-close.js';

const now = new Date('2026-11-11T12:00:00Z');

test('confirmation timer starts at the resolution, regardless of later ticket updates', () => {
  const resolved = new Date(now.getTime() - 73 * 3600000);
  assert.equal(shouldAutoClose('PENDING_CONFIRMATION', resolved, now, 72), true);
  assert.equal(shouldAutoClose('PENDING_CONFIRMATION', new Date(now.getTime() - 71 * 3600000), now, 72), false);
  assert.equal(shouldAutoClose('IN_PROGRESS', resolved, now, 72), false);
});

test('missing completion time or disabled/invalid policy cannot auto-close', () => {
  assert.equal(shouldAutoClose('PENDING_CONFIRMATION', null, now, 72), false);
  assert.equal(shouldAutoClose('PENDING_CONFIRMATION', now, now, 0), false);
  assert.equal(shouldAutoClose('PENDING_CONFIRMATION', now, now, Number.NaN), false);
});
