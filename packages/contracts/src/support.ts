export type SupportChangeKind='GROUP_CREATE'|'GROUP_UPDATE'|'MEMBER_ADD'|'MEMBER_REMOVE';
export interface SupportChangeInput {
  id:string; kind:SupportChangeKind; groupId:string; employeeId?:string;
  config:{name:string;description:string}|Record<string,never>; expectedGroupVersion:number|null;
  reason:string; contentClass:'GENERAL';
}
export interface SupportChangeDecision {
  expectedVersion:number; decision:'APPROVE'|'REJECT'; reason:string; contentClass:'GENERAL';
}
export interface SupportGroupView {id:string;name:string;description:string;version:number;activeMembers:number}
export interface SupportChangeView {
  id:string;kind:SupportChangeKind;groupId:string;employeeId:string|null;employeeName:string|null;
  config:SupportChangeInput['config'];expectedGroupVersion:number|null;proposedBy:string;reviewedBy:string|null;
  status:'PENDING'|'APPROVED'|'REJECTED';reason:string;reviewReason:string|null;version:number;createdAt:string;reviewedAt:string|null;
}
export interface SupportMemberView {id:string;name:string;active:boolean;roles:string[];privileges:string[]}
