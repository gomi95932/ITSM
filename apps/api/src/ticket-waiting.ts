import { waitReasonMatches, type TicketWaiting } from '@itsm/contracts';

export type WaitingRow = {
  status: string;
  waiting_reason_code: string | null;
  waiting_since: Date | null;
  waiting_due_at: Date | null;
};

export function ticketWaiting(row: WaitingRow, asOf: Date): TicketWaiting | null {
  const action = row.status === 'WAITING_USER' ? 'REQUEST_INFO' : row.status === 'WAITING_VENDOR' ? 'WAIT_VENDOR' : null;
  if (!action) return null;
  if (!waitReasonMatches(action, row.waiting_reason_code) || !row.waiting_since || !row.waiting_due_at)
    return { reason: 'UNRECORDED', since: null, dueAt: null, followUpOverdue: null };
  return { reason: row.waiting_reason_code, since: row.waiting_since.toISOString(),
    dueAt: row.waiting_due_at.toISOString(), followUpOverdue: row.waiting_due_at.getTime() <= asOf.getTime() };
}

export function isWaitingDeadline(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
