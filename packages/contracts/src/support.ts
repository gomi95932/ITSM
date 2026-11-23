export type SupportChangeKind='GROUP_CREATE'|'GROUP_UPDATE'|'GROUP_DISABLE'|'GROUP_RESTORE'|'MEMBER_ADD'|'MEMBER_REMOVE';
export interface SupportChangeInput {
  id:string; kind:SupportChangeKind; groupId:string; employeeId?:string;
  config:{name:string;description:string}|Record<string,never>; expectedGroupVersion:number|null;
  reason:string; contentClass:'GENERAL';
}
export interface SupportChangeDecision {
  expectedVersion:number; decision:'APPROVE'|'REJECT'; reason:string; contentClass:'GENERAL';
}
export interface SupportGroupView {id:string;name:string;description:string;version:number;activeMembers:number;enabled:boolean}
export type SupportDependencyKind='TICKET'|'APPROVAL'|'FULFILLMENT'|'KNOWLEDGE'|'POSITION'|'APPOINTMENT'|'CATALOG'|'FALLBACK'|'ASSIGNMENT_POLICY';
export interface SupportDependenciesView {
  group:SupportGroupView;total:number;
  items:{kind:SupportDependencyKind;total:number;references:{id:string;name:string}[];hasMore:boolean}[];
}
export interface SupportChangeView {
  managementMode?:'REVIEW'|'ADMIN_DIRECT';
  id:string;kind:SupportChangeKind;groupId:string;employeeId:string|null;employeeName:string|null;
  config:SupportChangeInput['config'];expectedGroupVersion:number|null;proposedBy:string;reviewedBy:string|null;
  status:'PENDING'|'APPROVED'|'REJECTED';reason:string;reviewReason:string|null;version:number;createdAt:string;reviewedAt:string|null;
}
export interface SupportMemberView {id:string;name:string;active:boolean;roles:string[];privileges:string[]}
export interface SupportStructureView {
  groups:SupportGroupView[];groupsHasMore:boolean;items:SupportChangeView[];proposalsHasMore:boolean;
  canManageGroups:boolean;canReview:boolean;
}
export interface SupportMembersView {group:SupportGroupView;items:SupportMemberView[];total:number;page:number;size:number}
export interface SupportPeopleView {items:{id:string;name:string}[];hasMore:boolean}
export interface SupportAuditView {
  actorId:string;action:string;beforeValue:unknown;afterValue:unknown;reason:string;createdAt:string;
}
