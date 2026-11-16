export interface ServiceDomain {id:string;name:string;enabled:boolean}
export interface BusinessSystem {id:string;name:string;domainId:string;enabled:boolean}
export interface SupportPosition {id:string;name:string;domainId:string;groupId:string;enabled:boolean}
export interface PositionAppointment {
  id:string;positionId:string;employeeId:string;duty:'PRIMARY'|'BACKUP';
  validFrom:string;validTo:string;enabled:boolean;
}
export interface ServicePositionMapping {
  serviceCode:string;domainId:string;systemId:string|null;primaryPositionId:string;
  collaboratingPositionIds:string[];enabled:boolean;
}
export interface ServiceStructure {
  domains:ServiceDomain[];systems:BusinessSystem[];positions:SupportPosition[];
  appointments:PositionAppointment[];mappings:ServicePositionMapping[];
}
export interface ServiceStructureProposal {
  id:string;expectedVersion:number;config:ServiceStructure;reason:string;contentClass:'GENERAL';
}
export interface ServiceStructureChange {
  id:string;expectedVersion:number;config:ServiceStructure;proposedBy:string;reviewedBy:string|null;
  status:'PENDING'|'APPROVED'|'REJECTED';version:number;reason:string;reviewReason:string|null;
  createdAt:string;reviewedAt:string|null;
}
export interface ServiceStructureOptions {
  groups:{id:string;name:string}[];
  services:{code:string;name:string;groupId:string;type:string;published:boolean}[];
  people:{id:string;name:string;active:boolean;groups:string[];dingLinked:boolean}[];
}
export interface ServiceStructurePreview {
  serviceCode:string;groupId:string;primaryPositionId:string;enabled:boolean;
  candidates:{id:string;name:string;duty:'PRIMARY'|'BACKUP';dingLinked:boolean}[];
  warnings:string[];
}
