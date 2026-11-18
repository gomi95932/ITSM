import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerMatches, reportMetrics, reportOwnerFilter, reportServiceFilter, responsibilitySummary,
  serviceMatches, serviceSummary, type ReportMetricItem } from './report-metrics.js';

const item = (changes: Partial<ReportMetricItem> = {}): ReportMetricItem => ({ status: 'IN_PROGRESS', reopenCount: 0,
  rating: null, overdueEver: false, unapprovedCalendar: false, firstResponse: null, resolution: null,
  assigneeId: 'agent-a', assigneeName: 'Engineer A', assigneeActive: true, pendingAssigneeId: null,
  acceptedHandoverCount: 0, ...changes });

test('personal report filters are explicit and cannot combine an identity with all or unassigned', () => {
  assert.deepEqual(reportOwnerFilter(undefined, undefined), { ownerScope: 'ALL', employeeId: null });
  assert.deepEqual(reportOwnerFilter('UNASSIGNED', undefined), { ownerScope: 'UNASSIGNED', employeeId: null });
  assert.deepEqual(reportOwnerFilter('PERSON', 'agent-a'), { ownerScope: 'PERSON', employeeId: 'agent-a' });
  for (const [scope, employee] of [['ALL', 'agent-a'], ['UNASSIGNED', 'agent-a'], ['PERSON', undefined],
    ['PERSON', ''], ['PERSON', ' '], ['PERSON', 'x'.repeat(201)], ['TEAM', undefined], [['ALL'], undefined], ['PERSON', ['agent-a']]])
    assert.equal(reportOwnerFilter(scope, employee), null);
  assert.equal(ownerMatches(item(), { ownerScope: 'PERSON', employeeId: 'agent-b' }), false);
  assert.equal(ownerMatches(item(), { ownerScope: 'PERSON', employeeId: 'agent-a' }), true);
});

test('offered candidates are never counted as accepted owners and disabled owners remain visible', () => {
  const rows = [item(), item({ assigneeId: null, assigneeName: null, assigneeActive: null, status: 'QUEUED', pendingAssigneeId: 'agent-b' }),
    item({ assigneeId: 'agent-c', assigneeName: 'Former engineer', assigneeActive: false, pendingAssigneeId: 'agent-b' }),
    item({ status: 'CLOSED', rating: 5, resolution: { completed: true, overdue: false } })];
  const summary = responsibilitySummary(rows);
  assert.deepEqual(new Set(summary.map(row => row.employeeId)), new Set(['agent-a', 'agent-c', null]));
  assert.equal(summary.find(row => row.employeeId === null)?.metrics.pendingAcceptance, 1);
  assert.equal(summary.find(row => row.employeeId === 'agent-c')?.active, false);
  assert.equal(summary.find(row => row.employeeId === 'agent-a')?.metrics.tickets, 2);
  assert.equal(summary.find(row => row.employeeId === 'agent-a')?.metrics.active, 1);
  assert.equal(ownerMatches(rows[1], { ownerScope: 'UNASSIGNED', employeeId: null }), true);
});

test('personal metrics use the same whole-ticket SLA, feedback and terminal-state rules as group totals', () => {
  const rows = [item({ status: 'WAITING_USER', overdueEver: true, reopenCount: 2,
    firstResponse: { responded: true, overdue: true } }),
  item({ status: 'WAITING_VENDOR', pendingAssigneeId: 'agent-b' }),
  item({ status: 'PENDING_CONFIRMATION', rating: 4, resolution: { completed: true, overdue: true } }),
  ...['CLOSED', 'CANCELLED', 'REJECTED'].map(status => item({ status, pendingAssigneeId: 'agent-b' }))];
  const metrics = reportMetrics(rows);
  assert.equal(metrics.tickets, 6);
  assert.equal(metrics.active, 3);
  assert.equal(metrics.pendingAcceptance, 1, 'terminal records do not create outstanding acceptance obligations');
  assert.equal(metrics.waitingUser, 1); assert.equal(metrics.waitingVendor, 1); assert.equal(metrics.awaitingConfirmation, 1);
  assert.equal(metrics.responded, 1); assert.equal(metrics.firstResponseOverdue, 1);
  assert.equal(metrics.resolved, 1); assert.equal(metrics.resolutionOverdue, 1);
  assert.equal(metrics.overdueTickets, 1); assert.equal(metrics.reopenedTickets, 1);
  assert.equal(metrics.satisfactionAverage, 4);
  assert.deepEqual(responsibilitySummary(rows)[0].metrics, metrics);
  assert.equal(reportMetrics([]).satisfactionAverage, null);
  assert.deepEqual(responsibilitySummary([]), []);
});

test('service filtering rejects ambiguous input and unknown codes select no other service', () => {
  assert.deepEqual(reportServiceFilter(undefined), { serviceCode: null });
  assert.deepEqual(reportServiceFilter('INC-WMS'), { serviceCode: 'INC-WMS' });
  for (const value of ['', ' ', ' INC-WMS', 'INC-WMS ', ['INC-WMS'], {}, null, 1, 'x'.repeat(201)])
    assert.equal(reportServiceFilter(value), null);
  assert.equal(serviceMatches({ serviceCode: 'INC-WMS' }, { serviceCode: null }), true);
  assert.equal(serviceMatches({ serviceCode: 'INC-WMS' }, { serviceCode: 'INC-ERP' }), false);
});

test('service aggregates retain distinct codes, complete metrics and recorded handover totals', () => {
  const rows = [{ ...item({ acceptedHandoverCount: 2 }), serviceCode: 'INC-WMS', serviceName: 'Shared name' },
    { ...item({ status: 'CLOSED', acceptedHandoverCount: 1, rating: 4 }), serviceCode: 'INC-WMS', serviceName: 'Shared name' },
    { ...item({ status: 'QUEUED', assigneeId: null, pendingAssigneeId: 'agent-b' }), serviceCode: 'INC-ERP', serviceName: 'Shared name' }];
  const summary = serviceSummary(rows);
  assert.equal(summary.length, 2, 'catalog display names are not stable grouping keys');
  const wms = summary.find(row => row.serviceCode === 'INC-WMS')!;
  assert.equal(wms.metrics.acceptedHandovers, 3);
  assert.equal(wms.metrics.tickets, 2);
  assert.equal(wms.metrics.satisfactionAverage, 4);
  assert.equal(summary.find(row => row.serviceCode === 'INC-ERP')?.metrics.acceptedHandovers, 0);
  assert.equal(reportMetrics(rows).acceptedHandovers, 3);
  assert.equal(responsibilitySummary(rows).find(row => row.employeeId === 'agent-a')?.metrics.acceptedHandovers, 3);
  assert.equal(reportMetrics([]).acceptedHandovers, 0);
  assert.deepEqual(serviceSummary([]), []);
});
