import { BadRequestException, ConflictException } from '@nestjs/common';
import { waitReasonMatches, type TicketActionInput, type TicketStatus } from '@itsm/contracts';
import { isWaitingDeadline } from './ticket-waiting.js';

export type ActorRole = 'requester' | 'agent';

export function transition(status: TicketStatus, role: ActorRole, input: Omit<TicketActionInput, 'contentClass'>, serviceType?: string): TicketStatus {
  const { action } = input;
  const agent = role === 'agent';
  const allowed: Partial<Record<TicketStatus, Partial<Record<string, TicketStatus>>>> = agent
    ? {
        QUEUED: { ACCEPT: 'IN_PROGRESS', REASSIGN: 'QUEUED', ASSIGN_OFFER: 'QUEUED' },
        IN_PROGRESS: { ACCEPT: 'IN_PROGRESS', REQUEST_INFO: 'WAITING_USER', WAIT_VENDOR: 'WAITING_VENDOR', RESOLVE: 'PENDING_CONFIRMATION', REASSIGN: 'IN_PROGRESS', ASSIGN_OFFER:'IN_PROGRESS' },
        WAITING_USER: { ACCEPT: 'WAITING_USER', REASSIGN: 'WAITING_USER' },
        WAITING_VENDOR: { ACCEPT: 'WAITING_VENDOR', RESUME_VENDOR: 'IN_PROGRESS', RESOLVE: 'PENDING_CONFIRMATION', REASSIGN: 'WAITING_VENDOR' },
        PENDING_CONFIRMATION: { ACCEPT: 'PENDING_CONFIRMATION', REASSIGN: 'PENDING_CONFIRMATION' },
      }
    : {
        NEW: { CANCEL: 'CANCELLED' },
        QUEUED: { CANCEL: 'CANCELLED' },
        ...(serviceType === 'REQ' ? { WAITING_APPROVAL: { CANCEL: 'CANCELLED' } } : {}),
        WAITING_USER: { ADD_INFO: 'IN_PROGRESS' },
        PENDING_CONFIRMATION: { CONFIRM: 'CLOSED', REOPEN: 'IN_PROGRESS' },
      };
  const handover = ['INITIATE_HANDOVER','CONTINUATION_PROPOSE','CONTINUATION_APPROVE','CONTINUATION_REJECT','CONTINUATION_REVOKE','ACCEPT_HANDOVER','DECLINE_HANDOVER','CANCEL_HANDOVER','ACCEPT_OFFER','DECLINE_OFFER','CANCEL_OFFER'].includes(action);
  const active = ['QUEUED','IN_PROGRESS','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION'].includes(status);
  if(action==='FORCE_TAKEOVER'){
    if(!agent||!active)throw new ConflictException({code:'INVALID_TRANSITION'});
    if(!input.targetGroupId||!input.targetAssigneeId||!input.reason?.trim())throw new BadRequestException({code:'TAKEOVER_DETAILS_REQUIRED'});
    return status==='QUEUED'?'IN_PROGRESS':status;
  }
  const next = agent && handover && active ? ['ACCEPT_HANDOVER','ACCEPT_OFFER'].includes(action) && status === 'QUEUED' ? 'IN_PROGRESS' : status : allowed[status]?.[action];
  if (!next) throw new ConflictException({ code: 'INVALID_TRANSITION' });
  if (action === 'ACCEPT' && !input.comment?.trim()) throw new BadRequestException({ code: 'HUMAN_RESPONSE_REQUIRED' });
  if (['REASSIGN','INITIATE_HANDOVER'].includes(action) && (!input.targetGroupId || !input.targetAssigneeId || !input.reason?.trim())) throw new BadRequestException({ code: 'REASSIGN_DETAILS_REQUIRED' });
  if (action.startsWith('CONTINUATION_') && !input.reason?.trim()) throw new BadRequestException({code:'CONTINUATION_REASON_REQUIRED'});
  if (action === 'ASSIGN_OFFER' && (!input.targetAssigneeId || !input.reason?.trim())) throw new BadRequestException({ code: 'ASSIGN_OFFER_DETAILS_REQUIRED' });
  if (action === 'ACCEPT_HANDOVER' && !input.comment?.trim()) throw new BadRequestException({ code: 'HUMAN_RESPONSE_REQUIRED' });
  if (action === 'ACCEPT_OFFER' && !input.comment?.trim()) throw new BadRequestException({ code: 'HUMAN_RESPONSE_REQUIRED' });
  if (['DECLINE_HANDOVER','CANCEL_HANDOVER','DECLINE_OFFER','CANCEL_OFFER'].includes(action) && !input.reason?.trim()) throw new BadRequestException({ code: 'HANDOVER_REASON_REQUIRED' });
  if (action === 'REQUEST_INFO' && (!input.comment?.trim() || !isWaitingDeadline(input.dueAt)))
    throw new BadRequestException({ code: 'INFO_REQUEST_REQUIRES_QUESTION_AND_DUE_DATE' });
  if (action === 'WAIT_VENDOR' && (!input.vendorReference?.trim() || !input.comment?.trim()))
    throw new BadRequestException({ code: 'VENDOR_REFERENCE_REQUIRED' });
  if (action === 'WAIT_VENDOR' && !input.vendorOwner?.trim())
    throw new BadRequestException({ code: 'VENDOR_OWNER_REQUIRED' });
  if (action === 'WAIT_VENDOR' && !isWaitingDeadline(input.dueAt))
    throw new BadRequestException({ code: 'WAITING_FOLLOW_UP_REQUIRED' });
  if (['REQUEST_INFO','WAIT_VENDOR'].includes(action) && !waitReasonMatches(action, input.waitingReason))
    throw new BadRequestException({ code: 'WAITING_REASON_REQUIRED' });
  if (!['REQUEST_INFO','WAIT_VENDOR'].includes(action) && input.waitingReason !== undefined)
    throw new BadRequestException({ code: 'INVALID_WAITING_REASON' });
  if (action === 'ADD_INFO' && !input.comment?.trim())
    throw new BadRequestException({ code: 'SUPPLEMENT_REQUIRED' });
  if (action === 'RESUME_VENDOR' && !input.comment?.trim())
    throw new BadRequestException({ code: 'VENDOR_RESUME_COMMENT_REQUIRED' });
  if (action === 'RESOLVE' && (!input.comment?.trim() || !input.resolutionCategory?.trim() || !input.evidence?.trim()))
    throw new BadRequestException({ code: 'RESOLUTION_DETAILS_REQUIRED' });
  if (action === 'REOPEN' && !input.reason?.trim())
    throw new BadRequestException({ code: 'REOPEN_REASON_REQUIRED' });
  return next;
}
