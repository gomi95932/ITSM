export const API_PREFIX = 'api/v1';
export { DEFAULT_CALENDAR, SLA_TARGETS, serviceMinutes, type ServiceCalendar } from './sla.js';

export interface HealthResponse {
  status: 'ok';
  service: 'itsm-api';
}

export const TICKET_STATUSES = ['NEW', 'QUEUED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'WAITING_USER', 'WAITING_VENDOR', 'PENDING_CONFIRMATION', 'CLOSED', 'CANCELLED', 'REJECTED'] as const;
export type TicketStatus = typeof TICKET_STATUSES[number];
export const TICKET_ACTIONS = ['ACCEPT', 'REQUEST_INFO', 'ADD_INFO', 'WAIT_VENDOR', 'RESOLVE', 'CONFIRM', 'REOPEN', 'CANCEL', 'REASSIGN', 'ACCEPT_HANDOVER', 'DECLINE_HANDOVER', 'CANCEL_HANDOVER'] as const;
export type TicketAction = typeof TICKET_ACTIONS[number];
export type TicketType = 'INC' | 'REQ';
export type Impact = 'COMPANY' | 'DEPARTMENT' | 'INDIVIDUAL';
export type Urgency = 'HIGH' | 'MEDIUM' | 'LOW';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export interface CreateTicketInput {
  contentClass: 'GENERAL';
  serviceCode: string;
  formVersion: number;
  subject: string;
  description: string;
  impact: Impact;
  urgency: Urgency;
  fields: Record<string, unknown>;
  draftId?: string;
}

export interface TicketActionInput {
  contentClass: 'GENERAL';
  action: TicketAction;
  expectedVersion: number;
  comment?: string;
  reason?: string;
  dueAt?: string;
  vendorReference?: string;
  vendorOwner?: string;
  resolutionCategory?: string;
  evidence?: string;
  targetGroupId?: string;
  targetAssigneeId?: string;
}

export interface CatalogField { key: string; label: string; required: boolean; options?: string[] }
export interface CatalogItem { code: string; name: string; description: string; type: TicketType; formVersion: number; fields: CatalogField[]; available: boolean }
export interface SessionUser { id: string; name: string; groups: string[]; csrfToken?: string }
export interface TicketView extends TicketReceipt {
  serviceCode: string; serviceType: TicketType; subject: string; description: string;
  priority: Priority; impact: Impact; urgency: Urgency; fields: Record<string, unknown>;
  createdAt: string; updatedAt: string; requesterId: string;
  events?: { action: string; fromStatus: string | null; toStatus: string; detail: Record<string, string>; createdAt: string }[];
  sla?: { cycle: number; responseTarget: number; resolutionTarget: number; responseMinutes: number; resolutionMinutes: number; responded: boolean; completed: boolean; paused: boolean; breached: boolean }[];
}

export interface TicketReceipt {
  id: string;
  number: string;
  status: TicketStatus;
  version: number;
  ownerGroupId: string;
  assigneeId: string | null;
  assigneeName?: string | null;
  pendingGroupId: string | null;
  pendingAssigneeId: string | null;
  pendingAssigneeName?: string | null;
}
