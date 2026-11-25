import type { TicketAction, TicketStatus } from '@itsm/contracts';

export interface Ownership {
  status: TicketStatus;
  assignee_id: string | null;
  pending_assignee_id: string | null;
  assignment_kind?: 'OFFER' | 'HANDOVER' | null;
  service_type?: string;
}

export function ownershipDenial(ticket: Ownership, actor: string, member: boolean, action: TicketAction, administratorDispatch=false): string | undefined {
  if (action === 'ACCEPT') {
    if (!member) return 'OWNER_GROUP_REQUIRED';
    if (ticket.assignee_id) return 'TICKET_ALREADY_ASSIGNED';
    if (ticket.pending_assignee_id) return 'HANDOVER_PENDING';
  } else if (['ACCEPT_HANDOVER', 'DECLINE_HANDOVER','ACCEPT_OFFER','DECLINE_OFFER'].includes(action)) {
    if (ticket.pending_assignee_id !== actor || ticket.assignment_kind !== (action.endsWith('OFFER') ? 'OFFER' : 'HANDOVER'))
      return 'HANDOVER_TARGET_REQUIRED';
  } else if (['REASSIGN', 'CANCEL_HANDOVER', 'ASSIGN_OFFER','CANCEL_OFFER','REQUEST_INFO', 'WAIT_VENDOR', 'RESUME_VENDOR', 'RESOLVE'].includes(action)) {
    const queuedRouting = !ticket.assignee_id && (ticket.status === 'QUEUED'||ticket.service_type==='REQ'&&ticket.status==='IN_PROGRESS')
      && ['REASSIGN', 'CANCEL_HANDOVER','ASSIGN_OFFER','CANCEL_OFFER'].includes(action);
    if (!member && !(administratorDispatch && queuedRouting)) return 'OWNER_GROUP_REQUIRED';
    if (action === 'ASSIGN_OFFER' && ticket.assignee_id) return 'TICKET_ALREADY_ASSIGNED';
    if (ticket.assignee_id !== actor && !queuedRouting) return 'PERSONAL_OWNER_REQUIRED';
    if (['REASSIGN','ASSIGN_OFFER'].includes(action) && ticket.pending_assignee_id) return 'HANDOVER_PENDING';
    if (action === 'CANCEL_HANDOVER' && (!ticket.pending_assignee_id || ticket.assignment_kind !== 'HANDOVER')) return 'HANDOVER_NOT_PENDING';
    if (action === 'CANCEL_OFFER' && (!ticket.pending_assignee_id || ticket.assignment_kind !== 'OFFER')) return 'OFFER_NOT_PENDING';
  }
  return undefined;
}
