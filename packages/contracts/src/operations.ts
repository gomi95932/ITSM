import { DEFAULT_PRIORITY_POLICY, validPriorityPolicy, type PriorityPolicy } from './priority.js';

export interface OperationsConfig {
  siteEnforced: boolean;
  sites: { id: string; name: string; enabled: boolean }[];
  employeeSites: { employeeId: string; homeSiteId: string; siteIds: string[] }[];
  groupSites: { groupId: string; siteIds: string[] }[];
  positionSites: { positionId: string; siteIds: string[] }[];
  serviceSites: { serviceCode: string; siteIds: string[] }[];
  siteRoutes: { serviceCode: string; siteId: string; positionId: string }[];
  slaTemplates: { id: string; name: string; enabled: boolean; targets: PriorityPolicy['targets'] }[];
  serviceSlas: { serviceCode: string; templateId: string }[];
}
export const EMPTY_OPERATIONS: OperationsConfig = { siteEnforced:false, sites:[], employeeSites:[], groupSites:[],
  positionSites:[], serviceSites:[], siteRoutes:[], slaTemplates:[], serviceSlas:[] };
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const code=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z0-9-]{3,40}$/.test(v);
const label=(v:unknown)=>typeof v==='string'&&!!v.trim()&&v.length<=100&&!/[\x00-\x1f\x7f]/.test(v);
const unique=(v:string[])=>new Set(v).size===v.length;
export function validOperationsConfig(value:unknown):value is OperationsConfig {
  if(!object(value)||!exact(value,Object.keys(EMPTY_OPERATIONS))||typeof value.siteEnforced!=='boolean'
    ||JSON.stringify(value).length>500000)return false;
  const shape:Record<string,string[]>={sites:['id','name','enabled'],employeeSites:['employeeId','homeSiteId','siteIds'],
    groupSites:['groupId','siteIds'],positionSites:['positionId','siteIds'],serviceSites:['serviceCode','siteIds'],
    siteRoutes:['serviceCode','siteId','positionId'],slaTemplates:['id','name','enabled','targets'],serviceSlas:['serviceCode','templateId']};
  for(const [key,keys] of Object.entries(shape))if(!Array.isArray(value[key])||(value[key] as unknown[]).length>3000
    ||!(value[key] as unknown[]).every(row=>object(row)&&exact(row,keys)))return false;
  const c=value as unknown as OperationsConfig;
  if(!c.sites.every(s=>id(s.id)&&label(s.name)&&typeof s.enabled==='boolean')||!unique(c.sites.map(s=>s.id)))return false;
  const enabledSites=new Set(c.sites.filter(s=>s.enabled).map(s=>s.id));
  for(const key of ['employeeSites','groupSites','positionSites','serviceSites'] as const){
    const field={employeeSites:'employeeId',groupSites:'groupId',positionSites:'positionId',serviceSites:'serviceCode'}[key];
    const rows=c[key] as unknown as Record<string,unknown>[];
    if(!unique(rows.map(r=>String(r[field])))||!rows.every(r=>(field==='serviceCode'?code(r[field]):id(r[field]))
      &&Array.isArray(r.siteIds)&&r.siteIds.length>0&&r.siteIds.length<=200&&r.siteIds.every(s=>typeof s==='string'&&enabledSites.has(s))
      &&unique(r.siteIds as string[])))return false;
  }
  if(!c.employeeSites.every(e=>id(e.homeSiteId)&&e.siteIds.includes(e.homeSiteId)))return false;
  if(!unique(c.siteRoutes.map(r=>`${r.serviceCode}:${r.siteId}`))||!c.siteRoutes.every(r=>code(r.serviceCode)&&enabledSites.has(r.siteId)
    &&id(r.positionId)&&c.serviceSites.some(s=>s.serviceCode===r.serviceCode&&s.siteIds.includes(r.siteId))
    &&c.positionSites.some(p=>p.positionId===r.positionId&&p.siteIds.includes(r.siteId))))return false;
  if(!unique(c.slaTemplates.map(t=>t.id))||!c.slaTemplates.every(t=>id(t.id)&&label(t.name)&&typeof t.enabled==='boolean'
    &&validPriorityPolicy({...DEFAULT_PRIORITY_POLICY,targets:t.targets})))return false;
  if(!unique(c.serviceSlas.map(s=>s.serviceCode))||!c.serviceSlas.every(s=>code(s.serviceCode)
    &&c.slaTemplates.some(t=>t.id===s.templateId&&t.enabled)))return false;
  return true;
}
