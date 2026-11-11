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
export type TicketType = 'INC' | 'REQ' | 'GEN';
export type Impact = 'COMPANY' | 'DEPARTMENT' | 'INDIVIDUAL';
export type Urgency = 'HIGH' | 'MEDIUM' | 'LOW';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type PriorityReviewState = 'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED' | 'ADJUSTED';
export const P1_REVIEW_REMINDER_MINUTES = 5;
export interface PriorityReviewInput {
  contentClass: 'GENERAL'; expectedVersion: number; priority: Priority; reason: string;
}
export interface ClassificationInput {
  contentClass: 'GENERAL'; expectedVersion: number; serviceCode: string;
  formVersion: number; fields: Record<string, unknown>; reason: string;
}
export interface DelegationView {
  id: string; requesterId: string; requesterName: string; delegateId: string; delegateName: string;
  expiresAt: string; revokedAt: string | null; active: boolean;
}

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
  delegationId?: string;
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

export interface TicketFeedbackInput {
  contentClass: 'GENERAL';
  rating: number;
  comment?: string;
}

export interface TicketFeedback {
  rating: number;
  comment: string | null;
  createdAt: string;
}

export interface CatalogField { key: string; label: string; required: boolean; options?: string[] }
export interface CatalogItem { code: string; name: string; description: string; type: TicketType; formVersion: number; fields: CatalogField[]; available: boolean }
export interface SessionUser { id: string; name: string; groups: string[]; priorityReviewGroups?: string[]; csrfToken?: string }
export interface TicketView extends TicketReceipt {
  serviceCode: string; serviceType: TicketType; subject: string; description: string;
  priority: Priority; impact: Impact; urgency: Urgency; fields: Record<string, unknown>;
  createdAt: string; updatedAt: string; requesterId: string;
  submittedById: string; originalServiceCode: string;
  canCorrectClassification?: boolean; canAddInfo?: boolean;
  priorityReviewState: PriorityReviewState;
  priorityCandidateAt: string | null;
  priorityReviewedAt: string | null;
  priorityReviewedBy: string | null;
  priorityReviewReason: string | null;
  canReviewPriority?: boolean;
  canFeedback?: boolean;
  feedback?: TicketFeedback | null;
  priorityAlert?: { reviewersAvailable: boolean; overdue: boolean; notificationMode: string; deliveries: Record<string, number> };
  events?: { action: string; fromStatus: string | null; toStatus: string; detail: Record<string, string>; createdAt: string }[];
  sla?: { cycle: number; priority: Priority; responseTarget: number; resolutionTarget: number; responseMinutes: number; resolutionMinutes: number; responded: boolean; completed: boolean; paused: boolean; breached: boolean }[];
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
