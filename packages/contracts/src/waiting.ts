export const USER_WAIT_REASONS = ['USER_INFORMATION', 'USER_AVAILABILITY'] as const;
export const VENDOR_WAIT_REASONS = ['VENDOR_SUPPORT', 'VENDOR_PARTS', 'VENDOR_CHANGE'] as const;
export type WaitReason = typeof USER_WAIT_REASONS[number] | typeof VENDOR_WAIT_REASONS[number];
export interface TicketWaiting {
  reason: WaitReason | 'UNRECORDED';
  since: string | null;
  dueAt: string | null;
  followUpOverdue: boolean | null;
}

export function waitReasonMatches(action: string, reason: unknown): reason is WaitReason {
  return typeof reason === 'string' && (action === 'REQUEST_INFO'
    ? (USER_WAIT_REASONS as readonly string[]).includes(reason)
    : action === 'WAIT_VENDOR' && (VENDOR_WAIT_REASONS as readonly string[]).includes(reason));
}
