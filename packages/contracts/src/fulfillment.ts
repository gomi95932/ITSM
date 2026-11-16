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
