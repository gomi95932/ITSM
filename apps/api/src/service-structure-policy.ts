import { BadRequestException } from '@nestjs/common';
import type { ServiceStructure,ServiceStructureProposal } from '@itsm/contracts';
import { serviceCatalogChange } from './service-catalog-policy.js';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const timestamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
export const structureUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function invalid():never {throw new BadRequestException({code:'INVALID_SERVICE_STRUCTURE'});}
function rows(value:unknown,keys:string[],max:number){
  if(!Array.isArray(value)||value.length>max||!value.every(row=>object(row)&&exact(row,keys)))return invalid();
  return value as Record<string,unknown>[];
}
function unique(values:string[]){if(new Set(values).size!==values.length)invalid();}

export function serviceStructure(value:unknown):ServiceStructure {
  if(!object(value)||!exact(value,['domains','systems','positions','appointments','mappings'])||JSON.stringify(value).length>250000)invalid();
  const domains=rows(value.domains,['id','name','enabled'],200).map(row=>{
    if(!id(row.id)||!text(row.name,100)||typeof row.enabled!=='boolean')return invalid();
    return {id:row.id,name:row.name.trim(),enabled:row.enabled};
  });
  const systems=rows(value.systems,['id','name','domainId','enabled'],1000).map(row=>{
    if(!id(row.id)||!text(row.name,100)||!id(row.domainId)||typeof row.enabled!=='boolean')return invalid();
    return {id:row.id,name:row.name.trim(),domainId:row.domainId,enabled:row.enabled};
  });
  const positions=rows(value.positions,['id','name','domainId','groupId','enabled'],1000).map(row=>{
    if(!id(row.id)||!text(row.name,100)||!id(row.domainId)||!id(row.groupId)||typeof row.enabled!=='boolean')return invalid();
    return {id:row.id,name:row.name.trim(),domainId:row.domainId,groupId:row.groupId,enabled:row.enabled};
  });
  const appointments=rows(value.appointments,['id','positionId','employeeId','duty','validFrom','validTo','enabled'],3000).map(row=>{
    if(!id(row.id)||!id(row.positionId)||!id(row.employeeId)||!['PRIMARY','BACKUP'].includes(String(row.duty))
      ||!timestamp(row.validFrom)||!timestamp(row.validTo)||Date.parse(row.validTo)<=Date.parse(row.validFrom)
      ||Date.parse(row.validTo)-Date.parse(row.validFrom)>366*86400000||typeof row.enabled!=='boolean')return invalid();
    return {id:row.id,positionId:row.positionId,employeeId:row.employeeId,duty:row.duty as 'PRIMARY'|'BACKUP',
      validFrom:new Date(row.validFrom).toISOString(),validTo:new Date(row.validTo).toISOString(),enabled:row.enabled};
  });
  const mappings=rows(value.mappings,['serviceCode','domainId','systemId','primaryPositionId','collaboratingPositionIds','enabled'],1000).map(row=>{
    if(typeof row.serviceCode!=='string'||!/^[A-Z0-9-]{3,40}$/.test(row.serviceCode)||!id(row.domainId)
      ||(row.systemId!==null&&!id(row.systemId))||!id(row.primaryPositionId)||!Array.isArray(row.collaboratingPositionIds)
      ||row.collaboratingPositionIds.length>20||!row.collaboratingPositionIds.every(id)||typeof row.enabled!=='boolean')return invalid();
    unique(row.collaboratingPositionIds);
    if(row.collaboratingPositionIds.includes(row.primaryPositionId))invalid();
    return {serviceCode:row.serviceCode,domainId:row.domainId,systemId:row.systemId,primaryPositionId:row.primaryPositionId,
      collaboratingPositionIds:[...row.collaboratingPositionIds].sort(),enabled:row.enabled};
  });
  for(const collection of [domains,systems,positions,appointments])unique(collection.map(row=>row.id));
  unique(mappings.map(row=>row.serviceCode));
  const domainMap=new Map(domains.map(row=>[row.id,row])),systemMap=new Map(systems.map(row=>[row.id,row])),positionMap=new Map(positions.map(row=>[row.id,row]));
  for(const row of [...systems,...positions])if(!domainMap.has(row.domainId)||(row.enabled&&!domainMap.get(row.domainId)!.enabled))invalid();
  for(const row of appointments)if(!positionMap.has(row.positionId)||(row.enabled&&!positionMap.get(row.positionId)!.enabled))invalid();
  for(const row of mappings){
    const position=positionMap.get(row.primaryPositionId),system=row.systemId?systemMap.get(row.systemId):null;
    if(!domainMap.has(row.domainId)||!position||position.domainId!==row.domainId
      ||(row.systemId&&(!system||system.domainId!==row.domainId))||row.collaboratingPositionIds.some(key=>!positionMap.has(key)))invalid();
    if(row.enabled&&(!domainMap.get(row.domainId)!.enabled||!position.enabled||(system&&!system.enabled)
      ||row.collaboratingPositionIds.some(key=>!positionMap.get(key)!.enabled)))invalid();
  }
  return {domains:domains.sort((a,b)=>a.id.localeCompare(b.id)),systems:systems.sort((a,b)=>a.id.localeCompare(b.id)),
    positions:positions.sort((a,b)=>a.id.localeCompare(b.id)),appointments:appointments.sort((a,b)=>a.id.localeCompare(b.id)),
    mappings:mappings.sort((a,b)=>a.serviceCode.localeCompare(b.serviceCode))};
}

export function structureProposal(value:unknown):ServiceStructureProposal {
  if(!object(value)||!exact(value,['id','expectedVersion','config','reason','contentClass',...(Object.hasOwn(value,'catalogChange')?['catalogChange']:[])])||!structureUuid.test(String(value.id))
    ||!Number.isSafeInteger(value.expectedVersion)||(value.expectedVersion as number)<1||!text(value.reason,500)||value.contentClass!=='GENERAL')invalid();
  return {id:value.id as string,expectedVersion:value.expectedVersion as number,config:serviceStructure(value.config),reason:(value.reason as string).trim(),contentClass:'GENERAL',
    ...(Object.hasOwn(value,'catalogChange')?{catalogChange:serviceCatalogChange(value.catalogChange)}:{})};
}

export function preserveStructureIds(previous:ServiceStructure,next:ServiceStructure):void {
  for(const key of ['domains','systems','positions','appointments'] as const){
    const present=new Set(next[key].map(row=>row.id));
    if(previous[key].some(row=>!present.has(row.id)))throw new BadRequestException({code:'SERVICE_STRUCTURE_DISABLE_REQUIRED'});
  }
  const codes=new Set(next.mappings.map(row=>row.serviceCode));
  if(previous.mappings.some(row=>!codes.has(row.serviceCode)))throw new BadRequestException({code:'SERVICE_STRUCTURE_DISABLE_REQUIRED'});
}
