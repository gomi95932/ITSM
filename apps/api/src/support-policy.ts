import { BadRequestException } from '@nestjs/common';
import type { MemberPrivilegesInput,SupportChangeInput,SupportChangeDecision } from '@itsm/contracts';
import { validEmployeeId } from '@itsm/contracts';

export const supportUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const supportId=(value:unknown):value is string=>typeof value==='string'&&value.length<=100&&/^[a-zA-Z0-9_-]+$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const only=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&value.length<=max
  &&(empty||!!value.trim())&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const version=(value:unknown)=>Number.isSafeInteger(value)&&(value as number)>0;
const invalid=()=>new BadRequestException({code:'INVALID_SUPPORT_CHANGE'});

export function supportProposal(body:unknown):SupportChangeInput {
  if(!object(body)||!only(body,['id','kind','groupId','employeeId','config','expectedGroupVersion','reason','contentClass'])
    ||typeof body.id!=='string'||!supportUuid.test(body.id)||!supportId(body.groupId)||body.contentClass!=='GENERAL'
    ||!text(body.reason,500)||!object(body.config))throw invalid();
  const group=body.kind==='GROUP_CREATE'||body.kind==='GROUP_UPDATE';
  const lifecycle=body.kind==='GROUP_DISABLE'||body.kind==='GROUP_RESTORE';
  if(!group&&!lifecycle&&body.kind!=='MEMBER_ADD'&&body.kind!=='MEMBER_REMOVE')throw invalid();
  if(body.kind==='GROUP_CREATE'?body.expectedGroupVersion!==null:!version(body.expectedGroupVersion))throw invalid();
  if(group){
    if(body.employeeId!==undefined||!only(body.config,['name','description'])||!text(body.config.name,100)
      ||!text(body.config.description,1000,true))throw invalid();
  }else if(lifecycle){
    if(body.employeeId!==undefined||Object.keys(body.config).length)throw invalid();
  }else if(!validEmployeeId(body.employeeId)||Object.keys(body.config).length)throw invalid();
  return {id:body.id.toLowerCase(),kind:body.kind as SupportChangeInput['kind'],groupId:body.groupId,
    ...(group||lifecycle?{}:{employeeId:body.employeeId as string}),
    config:group?{name:(body.config.name as string).trim(),description:(body.config.description as string).trim()}:{},
    expectedGroupVersion:body.expectedGroupVersion as number|null,reason:body.reason.trim(),contentClass:'GENERAL'};
}

export function supportDecision(body:unknown):SupportChangeDecision {
  if(!object(body)||!only(body,['expectedVersion','decision','reason','contentClass'])||!version(body.expectedVersion)
    ||!['APPROVE','REJECT'].includes(String(body.decision))||!text(body.reason,500)||body.contentClass!=='GENERAL')throw invalid();
  return {expectedVersion:body.expectedVersion as number,decision:body.decision as SupportChangeDecision['decision'],
    reason:body.reason.trim(),contentClass:'GENERAL'};
}

export function supportIndependentReview(actor:string,proposer:string,subject:string|null):boolean {
  return actor!==proposer&&actor!==subject;
}

export function memberPrivilegesInput(body:unknown):MemberPrivilegesInput {
  const invalid=()=>new BadRequestException({code:'INVALID_MEMBER_PRIVILEGES'});
  if(!object(body)||!only(body,['id','expectedGroupVersion','privileges','catalogServiceCodes','reason','contentClass'])
    ||typeof body.id!=='string'||!supportUuid.test(body.id)||!version(body.expectedGroupVersion)
    ||!text(body.reason,500)||body.contentClass!=='GENERAL'
    ||!Array.isArray(body.privileges)||body.privileges.length>3
    ||body.privileges.some(v=>!['P1_REVIEW','KNOWLEDGE_EDIT','KNOWLEDGE_REVIEW'].includes(v))
    ||new Set(body.privileges).size!==body.privileges.length
    ||!Array.isArray(body.catalogServiceCodes)||body.catalogServiceCodes.length>2000
    ||body.catalogServiceCodes.some(v=>typeof v!=='string'||!v.length||v.length>100||!text(v,100)||v!==v.trim())
    ||new Set(body.catalogServiceCodes).size!==body.catalogServiceCodes.length)throw invalid();
  return {id:body.id.toLowerCase(),expectedGroupVersion:body.expectedGroupVersion as number,
    privileges:[...body.privileges].sort() as MemberPrivilegesInput['privileges'],catalogServiceCodes:[...body.catalogServiceCodes].sort(),
    reason:body.reason.trim(),contentClass:'GENERAL'};
}
