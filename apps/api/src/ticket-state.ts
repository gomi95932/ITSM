import { BadRequestException, ConflictException } from '@nestjs/common';
import type { TicketActionInput, TicketStatus } from '@itsm/contracts';

export type ActorRole = 'requester' | 'agent';

export function transition(status: TicketStatus, role: ActorRole, input: TicketActionInput): TicketStatus {
  const { action } = input;
  const agent = role === 'agent';
  const allowed: Partial<Record<TicketStatus, Partial<Record<string, TicketStatus>>>> = agent
    ? {
        QUEUED: { ACCEPT: 'IN_PROGRESS' },
        IN_PROGRESS: { REQUEST_INFO: 'WAITING_USER', WAIT_VENDOR: 'WAITING_VENDOR', RESOLVE: 'PENDING_CONFIRMATION' },
        WAITING_VENDOR: { RESOLVE: 'PENDING_CONFIRMATION' },
      }
    : {
        NEW: { CANCEL: 'CANCELLED' },
        QUEUED: { CANCEL: 'CANCELLED' },
        WAITING_USER: { ADD_INFO: 'IN_PROGRESS' },
        PENDING_CONFIRMATION: { CONFIRM: 'CLOSED', REOPEN: 'IN_PROGRESS' },
      };
  const next = allowed[status]?.[action];
  if (!next) throw new ConflictException({ code: 'INVALID_TRANSITION' });
  if (action === 'REQUEST_INFO' && (!input.comment?.trim() || !validFutureDate(input.dueAt)))
    throw new BadRequestException({ code: 'INFO_REQUEST_REQUIRES_QUESTION_AND_DUE_DATE' });
  if (action === 'WAIT_VENDOR' && (!input.vendorReference?.trim() || !input.comment?.trim()))
    throw new BadRequestException({ code: 'VENDOR_REFERENCE_REQUIRED' });
  if (action === 'WAIT_VENDOR' && !input.vendorOwner?.trim())
    throw new BadRequestException({ code: 'VENDOR_OWNER_REQUIRED' });
  if (action === 'ADD_INFO' && !input.comment?.trim())
    throw new BadRequestException({ code: 'SUPPLEMENT_REQUIRED' });
  if (action === 'RESOLVE' && (!input.comment?.trim() || !input.resolutionCategory?.trim() || !input.evidence?.trim()))
    throw new BadRequestException({ code: 'RESOLUTION_DETAILS_REQUIRED' });
  if (action === 'REOPEN' && !input.reason?.trim())
    throw new BadRequestException({ code: 'REOPEN_REASON_REQUIRED' });
  return next;
}

function validFutureDate(value: string | undefined): boolean {
  return !!value && !Number.isNaN(Date.parse(value)) && Date.parse(value) > Date.now();
}
