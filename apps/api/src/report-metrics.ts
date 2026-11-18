export type ReportOwnerScope = 'ALL' | 'UNASSIGNED' | 'PERSON';
export type ReportOwnerFilter = { ownerScope: ReportOwnerScope; employeeId: string | null };

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
  pendingAssigneeId: string | null;
};

const terminal = new Set(['CLOSED', 'CANCELLED', 'REJECTED']);

export function reportMetrics(items: readonly ReportMetricItem[]) {
  const ratings = items.filter(item => item.rating !== null).map(item => item.rating!);
  return { tickets: items.length, active: items.filter(i => !terminal.has(i.status)).length,
    pendingAcceptance: items.filter(i => !terminal.has(i.status) && i.pendingAssigneeId !== null).length,
    waitingUser: items.filter(i => i.status === 'WAITING_USER').length,
    waitingVendor: items.filter(i => i.status === 'WAITING_VENDOR').length,
    awaitingConfirmation: items.filter(i => i.status === 'PENDING_CONFIRMATION').length,
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
