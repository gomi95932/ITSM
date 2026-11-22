export const API_PREFIX = 'api/v1';
export * from './priority.js';
export * from './priority-sla.js';
export * from './service-structure.js';
export * from './service-structure-template.js';
export * from './waiting.js';
export { DEFAULT_CALENDAR, SLA_TARGETS, serviceMinutes, validServiceCalendar, type ServiceCalendar } from './sla.js';
export { assignmentDeadline } from './assignment.js';
export type {SupportChangeKind,SupportChangeInput,SupportChangeDecision,SupportGroupView,SupportChangeView,SupportMemberView,SupportStructureView,SupportMembersView,SupportPeopleView,SupportAuditView,SupportDependencyKind,SupportDependenciesView} from './support.js';

export interface HealthResponse {
  status: 'ok';
  service: 'itsm-api';
}

export const TICKET_STATUSES = ['NEW', 'QUEUED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'WAITING_USER', 'WAITING_VENDOR', 'PENDING_CONFIRMATION', 'CLOSED', 'CANCELLED', 'REJECTED'] as const;
export type TicketStatus = typeof TICKET_STATUSES[number];
export const WORK_QUEUES = ['all', 'assigned', 'incoming', 'outgoing', 'unassigned'] as const;
export type WorkQueue = typeof WORK_QUEUES[number];
export type WorkQueueCounts = Record<WorkQueue, number>;
export interface TicketListResponse {
  items: TicketView[];
  page: number;
  size: number;
  total: number;
  counts: Partial<Record<TicketStatus, number>>;
  workQueues?: WorkQueueCounts;
}
export const TICKET_ACTIONS = ['ACCEPT', 'REQUEST_INFO', 'ADD_INFO', 'WAIT_VENDOR', 'RESUME_VENDOR', 'RESOLVE', 'CONFIRM', 'REOPEN', 'CANCEL', 'REASSIGN', 'INITIATE_HANDOVER', 'ACCEPT_HANDOVER', 'DECLINE_HANDOVER', 'CANCEL_HANDOVER', 'ASSIGN_OFFER', 'ACCEPT_OFFER', 'DECLINE_OFFER', 'CANCEL_OFFER', 'CONTINUATION_PROPOSE', 'CONTINUATION_APPROVE', 'CONTINUATION_REJECT', 'CONTINUATION_REVOKE'] as const;
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
  requestedValidityDays?: number;
}

export interface TicketActionInput {
  contentClass: 'GENERAL';
  action: TicketAction;
  expectedVersion: number;
  comment?: string;
  reason?: string;
  dueAt?: string;
  waitingReason?: import('./waiting.js').WaitReason;
  vendorReference?: string;
  vendorOwner?: string;
  resolutionCategory?: string;
  evidence?: string;
  targetGroupId?: string;
  targetAssigneeId?: string;
  continuationId?: string;
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
export interface CatalogItem { code: string; name: string; description: string; type: TicketType; formVersion: number; fields: CatalogField[]; available: boolean; maxValidityDays?: number | null }
export const MANAGED_ROLE_CODES=['PLATFORM_ADMIN','DISPATCHER','GROUP_LEAD'] as const;
export type ManagedRoleCode=typeof MANAGED_ROLE_CODES[number];
export interface RoleBindingInput {
  id:string; employeeId:string; roleCode:ManagedRoleCode; groupId:string|null;
  validFrom:string; validTo:string; reason:string; contentClass:'GENERAL';
}
export interface RoleDecisionInput { expectedVersion:number; reason:string; decision?:'APPROVE'|'REJECT'; contentClass:'GENERAL' }
export interface RoleBindingView extends Omit<RoleBindingInput,'contentClass'> {
  employeeName:string; groupName:string|null; status:'PENDING'|'ACTIVE'|'REJECTED'|'REVOKED'; source:'REVIEW'|'BOOTSTRAP';
  requestedBy:string; reviewedBy:string|null; revokedBy:string|null; reviewReason:string|null; revokeReason:string|null;
  version:number; effective:boolean; createdAt:string;
}
export interface SessionUser { id: string; name: string; groups: string[]; priorityReviewGroups?: string[]; csrfToken?: string; canManageRoles?:boolean; canManageRouting?:boolean }
export interface TicketView extends TicketReceipt {
  serviceCode: string; serviceType: TicketType; subject: string; description: string;
  priority: Priority; impact: Impact; urgency: Urgency; fields: Record<string, unknown>;
  initialPriority?: Priority; priorityPolicyVersion?: number;
  canChangePriority?: boolean; canSuggestPriority?: boolean;
  createdAt: string; updatedAt: string; requesterId: string;
  submittedById: string; originalServiceCode: string;
  canCorrectClassification?: boolean; canAddInfo?: boolean;
  canDispatchQueued?: boolean;
  canAssignOffer?: boolean;
  canClaim?: boolean;
  canProcess?: boolean;
  requestCompletionReady?: boolean;
  ownerContinuityRequired?: boolean;
  canManageContinuity?: boolean;
  continuations?: {id:string;employeeId:string;proposedBy:string;status:string;expiresAt:string;reason:string;current:boolean;effective:boolean}[];
  priorityReviewState: PriorityReviewState;
  priorityCandidateAt: string | null;
  priorityReviewedAt: string | null;
  priorityReviewedBy: string | null;
  priorityReviewReason: string | null;
  canReviewPriority?: boolean;
  canFeedback?: boolean;
  waiting?: import('./waiting.js').TicketWaiting | null;
  feedback?: TicketFeedback | null;
  priorityAlert?: { reviewersAvailable: boolean; overdue: boolean; notificationMode: string; deliveries: Record<string, number> };
  events?: { action: string; actorId?:string; actorName?:string; fromStatus: string | null; toStatus: string; detail: Record<string, string>; createdAt: string }[];
  sla?: { cycle: number; priority: Priority; responseTarget: number; resolutionTarget: number; responseMinutes: number; resolutionMinutes: number; responded: boolean; completed: boolean; paused: boolean; pauseReason?:'USER'|'APPROVAL'|null; breached: boolean;
    obligations?: {id:string;priority:string;responseTarget:number;resolutionTarget:number;responseMinutes:number;resolutionMinutes:number;breached:boolean}[] }[];
  requestProgress?: {
    cancellation?: 'NOT_SENT' | 'OA_CONFIRMATION_REQUIRED' | 'OA_CREATION_UNCERTAIN' | 'OA_CLOSED';
    approval: { state: string; updatedAt: string } | null;
    fulfillment: { state: string; deliveredAt: string | null; accessExpiresAt: string | null; revokedAt: string | null; reviewedAt: string | null; updatedAt: string } | null;
  };
}

export interface TicketReceipt {
  id: string;
  number: string;
  status: TicketStatus;
  version: number;
  ownerGroupId: string;
  ownerGroupName?: string | null;
  assigneeId: string | null;
  assigneeName?: string | null;
  pendingGroupId: string | null;
  pendingAssigneeId: string | null;
  pendingAssigneeName?: string | null;
  assignmentKind?: 'OFFER' | 'HANDOVER' | null;
  assignmentState?: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'INVALIDATED' | null;
  assignmentDueAt?: string | null;
  assignmentPolicyVersionId?: string | null;
}
export * from './fulfillment.js';
