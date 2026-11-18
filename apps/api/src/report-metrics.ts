import type { TicketWaiting } from '@itsm/contracts';

export type ReportOwnerScope = 'ALL' | 'UNASSIGNED' | 'PERSON';
export type ReportOwnerFilter = { ownerScope: ReportOwnerScope; employeeId: string | null };
export type ReportServiceFilter = { serviceCode: string | null };

export function reportServiceFilter(value: unknown): ReportServiceFilter | null {
  if (value === undefined) return { serviceCode: null };
  return typeof value === 'string' && value.length <= 200 && value.trim() === value && value.length > 0
    ? { serviceCode: value } : null;
}

export function reportOwnerFilter(scope: unknown, employeeId: unknown): ReportOwnerFilter | null {
  const ownerScope = scope === undefined ? 'ALL' : scope;
  if (ownerScope !== 'ALL' && ownerScope !== 'UNASSIGNED' && ownerScope !== 'PERSON') return null;
  if (ownerScope === 'PERSON') {
    if (typeof employeeId !== 'string' || !employeeId.trim() || employeeId.length > 200) return null;
    return { ownerScope, employeeId };
  }
  return employeeId === undefined ? { ownerScope, employeeId: null } : null;
}

export type ReportMetricItem = {
  status: string; reopenCount: number; rating: number | null; overdueEver: boolean; unapprovedCalendar: boolean;
  firstResponse: { responded: boolean; overdue: boolean } | null;
  resolution: { completed: boolean; overdue: boolean } | null;
  assigneeId: string | null; assigneeName: string | null; assigneeActive: boolean | null;
  pendingAssigneeId: string | null; acceptedHandoverCount: number;
  waiting: TicketWaiting | null;
};

const terminal = new Set(['CLOSED', 'CANCELLED', 'REJECTED']);

export function reportMetrics(items: readonly ReportMetricItem[]) {
  const ratings = items.filter(item => item.rating !== null).map(item => item.rating!);
  return { tickets: items.length, active: items.filter(i => !terminal.has(i.status)).length,
    pendingAcceptance: items.filter(i => !terminal.has(i.status) && i.pendingAssigneeId !== null).length,
    waitingUser: items.filter(i => i.status === 'WAITING_USER').length,
    waitingVendor: items.filter(i => i.status === 'WAITING_VENDOR').length,
    waitingFollowUpOverdue: items.filter(i => i.waiting?.followUpOverdue === true).length,
    waitingUnrecorded: items.filter(i => i.waiting?.reason === 'UNRECORDED').length,
    awaitingConfirmation: items.filter(i => i.status === 'PENDING_CONFIRMATION').length,
    acceptedHandovers: items.reduce((total, item) => total + item.acceptedHandoverCount, 0),
    responded: items.filter(i => i.firstResponse?.responded).length,
    firstResponseOverdue: items.filter(i => i.firstResponse?.overdue).length,
    resolved: items.filter(i => i.resolution?.completed).length,
    resolutionOverdue: items.filter(i => i.resolution?.overdue).length,
    overdueTickets: items.filter(i => i.overdueEver).length,
    reopenedTickets: items.filter(i => i.reopenCount > 0).length,
    rated: ratings.length,
    satisfactionAverage: ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 100) / 100 : null,
    unapprovedCalendarTickets: items.filter(i => i.unapprovedCalendar).length };
}

export function waitingSummary(items: readonly ReportMetricItem[]) {
  const groups = new Map<string, { status: string; reason: TicketWaiting['reason']; tickets: number; followUpOverdue: number | null }>();
  for (const item of items) {
    if (!item.waiting || !['WAITING_USER','WAITING_VENDOR'].includes(item.status)) continue;
    const key = `${item.status}:${item.waiting.reason}`;
    const group = groups.get(key) ?? { status: item.status, reason: item.waiting.reason, tickets: 0,
      followUpOverdue: item.waiting.reason === 'UNRECORDED' ? null : 0 };
    group.tickets++;
    if (item.waiting.followUpOverdue === true && group.followUpOverdue !== null) group.followUpOverdue++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (b.followUpOverdue ?? 0) - (a.followUpOverdue ?? 0) || b.tickets - a.tickets
    || a.status.localeCompare(b.status) || a.reason.localeCompare(b.reason));
}

export function ownerMatches(item: Pick<ReportMetricItem, 'assigneeId'>, filter: ReportOwnerFilter): boolean {
  return filter.ownerScope === 'ALL' || (filter.ownerScope === 'UNASSIGNED'
    ? item.assigneeId === null : item.assigneeId === filter.employeeId);
}

export function responsibilitySummary(items: readonly ReportMetricItem[]) {
  const byOwner = new Map<string | null, ReportMetricItem[]>();
  for (const item of items) {
    const rows = byOwner.get(item.assigneeId);
    if (rows) rows.push(item); else byOwner.set(item.assigneeId, [item]);
  }
  return [...byOwner].map(([employeeId, rows]) => ({ employeeId,
    name: rows[0].assigneeName, active: rows[0].assigneeActive, metrics: reportMetrics(rows) }))
    .sort((a, b) => b.metrics.active - a.metrics.active || b.metrics.tickets - a.metrics.tickets
      || (a.employeeId ?? '').localeCompare(b.employeeId ?? ''));
}

export function serviceMatches(item: { serviceCode: string }, filter: ReportServiceFilter): boolean {
  return filter.serviceCode === null || item.serviceCode === filter.serviceCode;
}

export function serviceSummary(items: readonly (ReportMetricItem & { serviceCode: string; serviceName: string })[]) {
  const byService = new Map<string, typeof items[number][]>();
  for (const item of items) {
    const rows = byService.get(item.serviceCode);
    if (rows) rows.push(item); else byService.set(item.serviceCode, [item]);
  }
  return [...byService].map(([serviceCode, rows]) => ({ serviceCode, name: rows[0].serviceName,
    metrics: reportMetrics(rows) })).sort((a, b) => b.metrics.active - a.metrics.active
      || b.metrics.tickets - a.metrics.tickets || a.serviceCode.localeCompare(b.serviceCode));
}
