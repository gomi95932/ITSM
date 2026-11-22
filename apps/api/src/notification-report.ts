export const notificationStates = ['PENDING', 'DISPATCHING', 'SENDING', 'DELIVERED', 'SIMULATED',
  'DEAD', 'REVIEW_REQUIRED', 'SKIPPED', 'OTHER'] as const;
export type NotificationState = typeof notificationStates[number];
export type NotificationFilter = NotificationState | 'ALL' | 'ATTENTION';
const reasons = new Set(['LIVE_DELIVERY_DISABLED', 'RECIPIENT_NOT_LINKED', 'TOKEN_FAILED',
  'HTTPS_DEEP_LINK_REQUIRED', 'DINGTALK_NOT_CONFIGURED', 'PROVIDER_UNAVAILABLE', 'DELIVERY_NOT_CONFIRMED',
  'RECIPIENT_NO_LONGER_AUTHORIZED', 'RECIPIENT_OUTSIDE_PILOT', 'DINGTALK_SEND_UNCONFIRMED', 'PROVIDER_RECIPIENT_CHANGED', 'LEGACY_DELIVERY_UNVERIFIED']);

export function notificationFilter(value: unknown): NotificationFilter | null {
  if (value === undefined) return 'ALL';
  return typeof value === 'string' && (value === 'ALL' || value === 'ATTENTION'
    || notificationStates.includes(value as NotificationState)) ? value as NotificationFilter : null;
}
export function notificationState(value: string): NotificationState {
  return notificationStates.includes(value as NotificationState) ? value as NotificationState : 'OTHER';
}
export function notificationReason(value: string | null): string | null {
  return value === null ? null : reasons.has(value) ? value : 'OTHER';
}
export type NotificationReportItem = {
  id: string; ticketId: string; number: string; eventAt: Date; updatedAt: Date;
  state: NotificationState; attempts: number; reason: string | null;
};
export function notificationNeedsAttention(item: Pick<NotificationReportItem, 'state' | 'attempts' | 'reason'>) {
  return ['DEAD', 'REVIEW_REQUIRED', 'OTHER'].includes(item.state)
    || (['PENDING', 'SENDING'].includes(item.state) && (item.attempts > 0 || item.reason !== null));
}
export function notificationMatches(item: NotificationReportItem, filter: NotificationFilter) {
  return filter === 'ALL' || (filter === 'ATTENTION' ? notificationNeedsAttention(item) : item.state === filter);
}
export function notificationMetrics(items: readonly NotificationReportItem[]) {
  const states = Object.fromEntries(notificationStates.map(state => [state, 0])) as Record<NotificationState, number>;
  const byReason = new Map<string, number>();
  for (const item of items) {
    states[item.state]++;
    if (item.reason !== null) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  }
  return { deliveries: items.length, tickets: new Set(items.map(item => item.ticketId)).size,
    attention: items.filter(notificationNeedsAttention).length, states,
    reasons: [...byReason].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)) };
}
