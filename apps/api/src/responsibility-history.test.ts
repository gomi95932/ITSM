import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historicalResponsibilitySummary, intervalMetrics, type ResponsibilityInterval } from './responsibility-history.js';

const interval = (changes: Partial<ResponsibilityInterval> = {}): ResponsibilityInterval => ({ ticketId: 'ticket-a',
  number: 'INC-1', revision: 1, source: 'CREATED', recordedAt: new Date('2026-11-18T01:00:00Z'),
  from: new Date('2026-11-18T01:00:00Z'), until: new Date('2026-11-18T01:01:00Z'), elapsedSeconds: 60,
  clockAdjusted: false, groupName: 'Service desk', assigneeId: 'agent-a', assigneeName: 'Engineer A',
  status: 'IN_PROGRESS', pendingAcceptance: false, serviceCode: 'INC-BIZ', serviceType: 'INC',
  historyOrigin: 'CREATED', firstRecordedAt: new Date('2026-11-18T01:00:00Z'), ...changes });

test('history counts distinct tickets and wall occupancy without treating waiting as labor or terminal time as active', () => {
  const items = [interval({ assigneeId: null, assigneeName: null, pendingAcceptance: true }),
    interval({ status: 'WAITING_USER', pendingAcceptance: true }), interval({ status: 'WAITING_VENDOR' }),
    interval({ status: 'WAITING_APPROVAL' }), interval({ status: 'PENDING_CONFIRMATION' }),
    ...['CLOSED', 'REJECTED', 'CANCELLED'].map(status => interval({ status, elapsedSeconds: 600, pendingAcceptance: true }))];
  assert.deepEqual(intervalMetrics(items), { tickets: 1, intervals: 8, activeWallSeconds: 300, unassignedWallSeconds: 60,
    pendingAcceptanceWallSeconds: 120, waitingUserWallSeconds: 60, waitingVendorWallSeconds: 60,
    waitingApprovalWallSeconds: 60, awaitingConfirmationWallSeconds: 60, legacyBaselineTickets: 0, clockAdjustedIntervals: 0 });
});

test('baseline uncertainty and same-person name snapshots survive aggregation without current employee lookup', () => {
  const items = [interval({ historyOrigin: 'BASELINE', source: 'BASELINE', clockAdjusted: true }),
    interval({ revision: 2, source: 'CHANGE', historyOrigin: 'BASELINE', assigneeName: 'Renamed engineer',
      recordedAt: new Date('2026-11-18T02:00:00Z'), elapsedSeconds: 30 }),
    interval({ ticketId: 'ticket-b', assigneeId: 'agent-b', assigneeName: 'Former engineer', elapsedSeconds: 10 })];
  const summary = historicalResponsibilitySummary(items);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].employeeId, 'agent-a');
  assert.equal(summary[0].name, 'Renamed engineer');
  assert.deepEqual(summary[0].names, ['Engineer A', 'Renamed engineer']);
  assert.equal(summary[0].metrics.legacyBaselineTickets, 1);
  assert.equal(summary[0].metrics.clockAdjustedIntervals, 1);
  assert.equal(intervalMetrics(items).tickets, 2);
  assert.equal(intervalMetrics(items).activeWallSeconds, 100);
  assert.equal(intervalMetrics([]).activeWallSeconds, 0);
  assert.deepEqual(historicalResponsibilitySummary([]), []);
});
