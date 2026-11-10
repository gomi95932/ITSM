import type { TicketAction, TicketStatus } from '@itsm/contracts';

export interface Ownership {
  status: TicketStatus;
  assignee_id: string | null;
  pending_assignee_id: string | null;
}

export function ownershipDenial(ticket: Ownership, actor: string, member: boolean, action: TicketAction): string | undefined {
  if (action === 'ACCEPT') {
    if (!member) return 'OWNER_GROUP_REQUIRED';
    if (ticket.assignee_id) return 'TICKET_ALREADY_ASSIGNED';
    if (ticket.pending_assignee_id) return 'HANDOVER_PENDING';
  } else if (['ACCEPT_HANDOVER', 'DECLINE_HANDOVER'].includes(action)) {
    if (ticket.pending_assignee_id !== actor) return 'HANDOVER_TARGET_REQUIRED';
  } else if (['REASSIGN', 'CANCEL_HANDOVER', 'REQUEST_INFO', 'WAIT_VENDOR', 'RESOLVE'].includes(action)) {
    if (!member) return 'OWNER_GROUP_REQUIRED';
    const queuedRouting = !ticket.assignee_id && ticket.status === 'QUEUED' && ['REASSIGN', 'CANCEL_HANDOVER'].includes(action);
    if (ticket.assignee_id !== actor && !queuedRouting) return 'PERSONAL_OWNER_REQUIRED';
    if (action === 'REASSIGN' && ticket.pending_assignee_id) return 'HANDOVER_PENDING';
    if (action === 'CANCEL_HANDOVER' && !ticket.pending_assignee_id) return 'HANDOVER_NOT_PENDING';
  }
  return undefined;
}
