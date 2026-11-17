import { BadRequestException } from '@nestjs/common';
import type { FulfillmentQueue,RequestDeliveryOperation } from '@itsm/contracts';

export const fulfillmentUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function fulfillmentFilter(input:{queue?:unknown;group?:unknown;page?:unknown}) {
  const {queue='UNREVIEWED',group='',page='1'}=input;
  if(typeof queue!=='string'||!['UNREVIEWED','REVOKE_DUE','ALL'].includes(queue)
    ||typeof group!=='string'||(group!==''&&!/^[A-Za-z0-9_-]{1,100}$/.test(group))
    ||typeof page!=='string'||!/^[1-9]\d{0,4}$/.test(page))
    throw new BadRequestException({code:'INVALID_FULFILLMENT_FILTER'});
  return {queue:queue as FulfillmentQueue,group,page:Number(page),size:20};
}
export function fulfillmentAction(value:unknown,key:unknown) {
  if(typeof key!=='string'||!fulfillmentUuid.test(key))throw new BadRequestException({code:'FULFILLMENT_KEY_REQUIRED'});
  if(!value||typeof value!=='object'||Array.isArray(value))throw new BadRequestException({code:'INVALID_FULFILLMENT_ACTION'});
  const body=value as Record<string,unknown>;
  if(Object.keys(body).length!==3||!Object.hasOwn(body,'expectedVersion')||!Object.hasOwn(body,'reference')||!Object.hasOwn(body,'contentClass')
    ||!Number.isSafeInteger(body.expectedVersion)||(body.expectedVersion as number)<1||(body.expectedVersion as number)>2147483647
    ||typeof body.reference!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$/.test(body.reference)||body.contentClass!=='GENERAL')
    throw new BadRequestException({code:'INVALID_FULFILLMENT_ACTION'});
  return {key:key.toLowerCase(),expectedVersion:body.expectedVersion as number,reference:body.reference,contentClass:'GENERAL' as const};
}
export function requestDeliveryAction(value:unknown,key:unknown,operation:RequestDeliveryOperation){
  if(typeof key!=='string'||!fulfillmentUuid.test(key))throw new BadRequestException({code:'FULFILLMENT_KEY_REQUIRED'});
  if(!value||typeof value!=='object'||Array.isArray(value))throw new BadRequestException({code:'INVALID_DELIVERY_ACTION'});
  const body=value as Record<string,unknown>,keys=operation==='PREPARE'?['expectedVersion','contentClass']:['expectedVersion','reference','contentClass','actualDeliveryConfirmed'];
  if(Object.keys(body).length!==keys.length||!keys.every(k=>Object.hasOwn(body,k))||body.contentClass!=='GENERAL'
    ||!Number.isSafeInteger(body.expectedVersion)||(body.expectedVersion as number)>2147483647
    ||(operation==='PREPARE'?body.expectedVersion!==0:(body.expectedVersion as number)<1)
    ||(operation==='DELIVER'&&(body.actualDeliveryConfirmed!==true||typeof body.reference!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$/.test(body.reference))))
    throw new BadRequestException({code:'INVALID_DELIVERY_ACTION'});
  return {key:key.toLowerCase(),expectedVersion:body.expectedVersion as number,reference:operation==='DELIVER'?body.reference as string:null,contentClass:'GENERAL' as const};
}
