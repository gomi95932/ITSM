import {BadRequestException} from '@nestjs/common';
import type {CatalogNavigationEntry} from '@itsm/contracts';

const initialPaths:Record<string,string[]>={
  'INC-PC':['电脑与软件'],'INC-NET':['网络与远程访问'],
  'INC-MAIL':['账号与邮箱'],'INC-BIZ':['信息化系统'],
  'REQ-ACCOUNT':['账号与邮箱'],'REQ-PERM':['账号与权限'],
  'REQ-SOFT':['电脑与软件'],'REQ-DEVICE':['设备与资产'],
  'REQ-VPN':['网络与远程访问'],'REQ-SHARE':['文件共享与存储'],
  'REQ-GPU':['算力与AI服务'],'REQ-AI':['算力与AI服务'],
};
export function initialCatalogPath(code:string):string[]{return [...(initialPaths[code]??['其他服务'])];}
export function catalogNavigationInput(body:unknown):{expectedVersion:number;items:CatalogNavigationEntry[];reason:string;contentClass:'GENERAL'}{
  const invalid=()=>{throw new BadRequestException({code:'INVALID_CATALOG_NAVIGATION'});};
  if(!body||typeof body!=='object'||Array.isArray(body))return invalid();
  const row=body as Record<string,unknown>;
  if(Object.keys(row).some(k=>!['expectedVersion','items','reason','contentClass'].includes(k))
    ||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<1||row.contentClass!=='GENERAL'
    ||typeof row.reason!=='string'||!row.reason.trim()||row.reason.trim().length>500
    ||!Array.isArray(row.items)||row.items.length>2000)return invalid();
  const codes=new Set<string>();
  const items=row.items.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
    const item=value as Record<string,unknown>;
    if(Object.keys(item).some(k=>!['serviceCode','path','sortOrder'].includes(k))
      ||typeof item.serviceCode!=='string'||!item.serviceCode||item.serviceCode.length>100||codes.has(item.serviceCode)
      ||!Array.isArray(item.path)||item.path.length<1||item.path.length>2
      ||item.path.some(p=>typeof p!=='string'||!p.trim()||p.trim().length>80||/[\u0000-\u001f\u007f]/.test(p))
      ||!Number.isSafeInteger(item.sortOrder)||Number(item.sortOrder)<0||Number(item.sortOrder)>99999)return invalid();
    codes.add(item.serviceCode);
    return {serviceCode:item.serviceCode,path:(item.path as string[]).map(p=>p.trim()),sortOrder:item.sortOrder as number};
  });
  return {expectedVersion:row.expectedVersion as number,items,reason:row.reason.trim(),contentClass:'GENERAL'};
}
