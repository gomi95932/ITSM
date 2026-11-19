export type FulfillmentState='READY'|'DELIVERED'|'REVOKE_DUE'|'REVOKED'|'BLOCKED';
export type FulfillmentQueue='UNREVIEWED'|'REVOKE_DUE'|'ALL';
export type FulfillmentAction='REVIEW'|'REVOKE';
export interface FulfillmentItem {
  id:string;ticketId:string;number:string;subject:string;serviceName:string;groupId:string;groupName:string;
  assigneeName:string;requesterName:string;state:FulfillmentState;version:number;reasonCode:string|null;
  deliveredAt:string|null;accessExpiresAt:string|null;reviewedAt:string|null;reviewerName:string|null;revokedAt:string|null;
  canReview:boolean;canRevoke:boolean;
}
export interface FulfillmentDetail extends FulfillmentItem {
  events:{id:string;action:string;fromState:FulfillmentState|null;toState:FulfillmentState;actorName:string|null;reference:string|null;createdAt:string}[];
  eventsHasMore:boolean;
}
export interface FulfillmentList {
  items:FulfillmentItem[];total:number;page:number;size:number;
  groups:{id:string;name:string}[];
  counts:{unreviewed:number;revokeDue:number;all:number};
}
export type RequestDeliveryOperation='PREPARE'|'DELIVER';
export type DeliveryFailureOutcome='NOT_GRANTED'|'REVOKED';
export interface DeliveryFailureResolution {
  commandId:string;outcome:DeliveryFailureOutcome;reference:string;resolvedAt:string;
}
export interface DeliveryFailureItem {
  id:string;ticketId:string;number:string;subject:string;groupId:string;groupName:string;
  operatorName:string;reference:string;failedAt:string;canResolve:boolean;
  resolution:(DeliveryFailureResolution&{verifierName:string})|null;
}
export interface DeliveryFailureList {
  items:DeliveryFailureItem[];groups:{id:string;name:string}[];total:number;page:number;size:number;
}
export interface RequestDeliveryReceipt {
  id:string;operation:RequestDeliveryOperation;state:'PENDING'|'SUCCEEDED'|'REJECTED';
  result:{taskId:string;version:number}|null;errorCode:string|null;createdAt:string;completedAt:string|null;
}
export interface RequestDeliveryItem {
  approvalId:string;ticketId:string;number:string;subject:string;serviceName:string;groupId:string;groupName:string;
  requesterName:string;approvalState:string;deadline:string;taskId:string|null;taskState:FulfillmentState|null;
  version:number;assigneeName:string|null;canPrepare:boolean;canDeliver:boolean;command:RequestDeliveryReceipt|null;
}
export interface RequestDeliveryList {
  enabled:boolean;items:RequestDeliveryItem[];groups:{id:string;name:string}[];total:number;page:number;size:number;
}
