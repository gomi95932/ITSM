export type ResponsibilityInterval = {
  ticketId: string; number: string; revision: number; source: 'CREATED' | 'BASELINE' | 'CHANGE';
  recordedAt: Date; from: Date; until: Date; elapsedSeconds: number; clockAdjusted: boolean;
  groupName: string; assigneeId: string | null; assigneeName: string | null; status: string;
  pendingAcceptance: boolean; serviceCode: string; serviceType: 'INC' | 'REQ';
  historyOrigin: 'CREATED' | 'BASELINE'; firstRecordedAt: Date;
};

const terminal = new Set(['CLOSED', 'CANCELLED', 'REJECTED']);

export function intervalMetrics(items: readonly ResponsibilityInterval[]) {
  const active = items.filter(item => !terminal.has(item.status));
  const seconds = (rows: readonly ResponsibilityInterval[]) => rows.reduce((sum, item) => sum + item.elapsedSeconds, 0);
  return { tickets: new Set(items.map(item => item.ticketId)).size, intervals: items.length,
    activeWallSeconds: seconds(active), unassignedWallSeconds: seconds(active.filter(item => item.assigneeId === null)),
    pendingAcceptanceWallSeconds: seconds(active.filter(item => item.pendingAcceptance)),
    waitingUserWallSeconds: seconds(active.filter(item => item.status === 'WAITING_USER')),
    waitingVendorWallSeconds: seconds(active.filter(item => item.status === 'WAITING_VENDOR')),
    waitingApprovalWallSeconds: seconds(active.filter(item => item.status === 'WAITING_APPROVAL')),
    awaitingConfirmationWallSeconds: seconds(active.filter(item => item.status === 'PENDING_CONFIRMATION')),
    legacyBaselineTickets: new Set(items.filter(item => item.historyOrigin === 'BASELINE').map(item => item.ticketId)).size,
    clockAdjustedIntervals: items.filter(item => item.clockAdjusted).length };
}

export function historicalResponsibilitySummary(items: readonly ResponsibilityInterval[]) {
  const byOwner = new Map<string | null, ResponsibilityInterval[]>();
  for (const item of items) {
    const rows = byOwner.get(item.assigneeId);
    if (rows) rows.push(item); else byOwner.set(item.assigneeId, [item]);
  }
  return [...byOwner].map(([employeeId, rows]) => {
    const latest = rows.reduce((last, item) => item.recordedAt > last.recordedAt ? item : last);
    return { employeeId, name: latest.assigneeName,
      names: [...new Set(rows.map(item => item.assigneeName).filter((name): name is string => name !== null))],
      metrics: intervalMetrics(rows) };
  }).sort((a, b) => b.metrics.activeWallSeconds - a.metrics.activeWallSeconds
    || (a.employeeId ?? '').localeCompare(b.employeeId ?? ''));
}
