import { BadRequestException } from '@nestjs/common';
import type { ServiceCatalogChange } from '@itsm/contracts';
import { validEmployeeId } from '@itsm/contracts';
import { validateRequestCatalogPublish } from './request-catalog.service.js';

const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
function invalid():never{throw new BadRequestException({code:'INVALID_SERVICE_CATALOG'});}

export function serviceCatalogChange(value:unknown):ServiceCatalogChange {
  const keys=['expectedVersion','code','type','name','description','published','groupId','visibleGroups','sortOrder','fields','approval','maxValidityDays','initialPublisherId'];
  if(!plain(value)||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key))
    ||!Number.isSafeInteger(value.expectedVersion)||(value.expectedVersion as number)<0
    ||!['INC','REQ'].includes(String(value.type))||typeof value.code!=='string'
    ||!new RegExp(`^${value.type}-[A-Z0-9-]{1,36}$`).test(value.code)
    ||!text(value.name,100)||!text(value.description,500)||typeof value.published!=='boolean'||!id(value.groupId)
    ||!Array.isArray(value.visibleGroups)||value.visibleGroups.length>30||!value.visibleGroups.every(id)
    ||new Set(value.visibleGroups).size!==value.visibleGroups.length||!Number.isSafeInteger(value.sortOrder)
    ||(value.sortOrder as number)<0||(value.sortOrder as number)>100000)invalid();
  const req=value.type==='REQ';
  if(!req&&(value.approval!==null||value.maxValidityDays!==null||value.initialPublisherId!==null))invalid();
  if(req&&((value.expectedVersion===0&&!validEmployeeId(value.initialPublisherId))||(value.expectedVersion!==0&&value.initialPublisherId!==null)))invalid();
  // Both entry types use the same controlled field schema; REQ retains its existing approval validator.
  const checked=validateRequestCatalogPublish({contentClass:'GENERAL',expectedVersion:Math.max(1,value.expectedVersion as number),
    name:value.name,description:value.description,groupId:value.groupId,visibleGroups:value.visibleGroups,fields:value.fields,
    approval:req?value.approval:{templateId:'NOT-APPLICABLE',steps:[{role:'MANAGER'}]},maxValidityDays:req?value.maxValidityDays:1});
  return {expectedVersion:value.expectedVersion as number,code:value.code,type:value.type as 'INC'|'REQ',name:checked.name.trim(),
    description:checked.description.trim(),published:value.published,groupId:checked.groupId,visibleGroups:[...checked.visibleGroups].sort(),
    sortOrder:value.sortOrder as number,fields:checked.fields,approval:req?checked.approval:null,
    maxValidityDays:req?checked.maxValidityDays:null,initialPublisherId:value.initialPublisherId as string|null};
}
