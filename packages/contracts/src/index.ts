export const API_PREFIX = 'api/v1';

export interface HealthResponse {
  status: 'ok';
  service: 'itsm-api';
}

export const TICKET_STATUSES = ['NEW', 'QUEUED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'WAITING_USER', 'WAITING_VENDOR', 'PENDING_CONFIRMATION', 'CLOSED', 'CANCELLED', 'REJECTED'] as const;
export type TicketStatus = typeof TICKET_STATUSES[number];
export const TICKET_ACTIONS = ['ACCEPT', 'REQUEST_INFO', 'ADD_INFO', 'WAIT_VENDOR', 'RESOLVE', 'CONFIRM', 'REOPEN', 'CANCEL'] as const;
export type TicketAction = typeof TICKET_ACTIONS[number];
export type TicketType = 'INC' | 'REQ';
export type Impact = 'COMPANY' | 'DEPARTMENT' | 'INDIVIDUAL';
export type Urgency = 'HIGH' | 'MEDIUM' | 'LOW';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export interface CreateTicketInput {
  serviceCode: string;
  formVersion: number;
  subject: string;
  description: string;
  impact: Impact;
  urgency: Urgency;
  fields: Record<string, unknown>;
}

export interface TicketActionInput {
  action: TicketAction;
  expectedVersion: number;
  comment?: string;
  reason?: string;
  dueAt?: string;
  vendorReference?: string;
  vendorOwner?: string;
  resolutionCategory?: string;
  evidence?: string;
}

export interface TicketReceipt {
  id: string;
  number: string;
  status: TicketStatus;
  version: number;
  ownerGroupId: string;
}
