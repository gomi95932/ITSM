import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationFilter, notificationMatches, notificationMetrics, notificationReason, notificationState,
  type NotificationReportItem } from './notification-report.js';

const item = (state: NotificationReportItem['state'], overrides: Partial<NotificationReportItem> = {}): NotificationReportItem =>
  ({ id: 'delivery', ticketId: 'ticket', number: 'INC-1', eventAt: new Date(), updatedAt: new Date(), state,
    attempts: 0, reason: null, ...overrides });
test('notification filters reject repeated and unknown values', () => {
  assert.equal(notificationFilter(undefined), 'ALL');
  for (const value of ['ALL', 'ATTENTION', 'DEAD', 'REVIEW_REQUIRED', 'OTHER']) assert.equal(notificationFilter(value), value);
  for (const value of ['', 'failed', null, ['DEAD', 'PENDING'], {}]) assert.equal(notificationFilter(value), null);
});
test('notification report whitelists states and errors without exposing arbitrary provider content', () => {
  assert.equal(notificationState('PROVIDER_PRIVATE_STATE'), 'OTHER');
  assert.equal(notificationReason('Bearer secret'), 'OTHER');
  assert.equal(notificationReason('TOKEN_FAILED'), 'TOKEN_FAILED');
  assert.equal(notificationReason('RECIPIENT_OUTSIDE_PILOT'), 'RECIPIENT_OUTSIDE_PILOT');
  assert.equal(notificationReason(null), null);
});
test('notification metrics distinguish simulation, uncertain outcomes, skips and retries', () => {
  const rows = [item('DELIVERED'), item('SIMULATED'), item('DEAD'), item('REVIEW_REQUIRED'), item('SKIPPED'),
    item('PENDING'), item('SENDING'), item('DISPATCHING'), item('PENDING', { attempts: 1, reason: 'TOKEN_FAILED' }),
    item('SENDING', { reason: 'DELIVERY_NOT_CONFIRMED' }), item('OTHER', { ticketId: 'second-ticket' })];
  const metrics = notificationMetrics(rows);
  assert.equal(metrics.deliveries, 11); assert.equal(metrics.tickets, 2); assert.equal(metrics.attention, 5);
  assert.equal(metrics.states.DELIVERED, 1); assert.equal(metrics.states.SIMULATED, 1);
  assert.equal(metrics.states.SKIPPED, 1); assert.equal(metrics.states.PENDING, 2);
  assert.deepEqual(rows.filter(row => notificationMatches(row, 'ATTENTION')), [rows[2], rows[3], rows[8], rows[9], rows[10]]);
  assert.equal(rows.filter(row => notificationMatches(row, 'DEAD')).length, 1);
  assert.equal(rows.filter(row => notificationMatches(row, 'ALL')).length, 11);
  assert.equal(notificationMetrics([]).attention, 0);
});
