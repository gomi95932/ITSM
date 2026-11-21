import type { Impact, Priority, Urgency } from './index.js';
import { SLA_TARGETS } from './sla.js';

export const PRIORITIES = ['P1','P2','P3','P4'] as const;
export const PRIORITY_LABELS: Record<Priority,string> = {P1:'重大',P2:'高',P3:'一般',P4:'低'};
export interface PriorityPolicy {
  matrix: Record<Impact,Record<Urgency,Priority>>;
  targets: Record<Priority,{response:number;resolution:number}>;
  criticalServices: string[];
  reviewMinutes: number;
}
export const DEFAULT_PRIORITY_POLICY: PriorityPolicy = {
  matrix: {COMPANY:{HIGH:'P1',MEDIUM:'P1',LOW:'P2'},DEPARTMENT:{HIGH:'P1',MEDIUM:'P2',LOW:'P3'},INDIVIDUAL:{HIGH:'P2',MEDIUM:'P3',LOW:'P4'}},
  targets: Object.fromEntries(PRIORITIES.map(p=>[p,{...SLA_TARGETS[p]}])) as PriorityPolicy['targets'],
  criticalServices: [], reviewMinutes:5,
};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function validPriorityPolicy(value:unknown):value is PriorityPolicy {
  if(!object(value)||!exact(value,['matrix','targets','criticalServices','reviewMinutes'])||!object(value.matrix)||!object(value.targets)
    ||!exact(value.matrix,['COMPANY','DEPARTMENT','INDIVIDUAL'])||!exact(value.targets,[...PRIORITIES])
    ||!Number.isInteger(value.reviewMinutes)||Number(value.reviewMinutes)<1||Number(value.reviewMinutes)>60
    ||!Array.isArray(value.criticalServices)||value.criticalServices.length>500||new Set(value.criticalServices).size!==value.criticalServices.length
    ||!value.criticalServices.every(v=>typeof v==='string'&&/^[A-Z0-9-]{3,40}$/.test(v)))return false;
  const impacts=['COMPANY','DEPARTMENT','INDIVIDUAL'],urgencies=['HIGH','MEDIUM','LOW'];
  for(const impact of impacts){const row=value.matrix[impact];
    if(!object(row)||!exact(row,urgencies)||!urgencies.every(u=>PRIORITIES.includes(row[u] as Priority)))return false;
    if(Number(String(row.HIGH).slice(1))>Number(String(row.MEDIUM).slice(1))||Number(String(row.MEDIUM).slice(1))>Number(String(row.LOW).slice(1)))return false;
  }
  for(const u of urgencies)for(let i=0;i<2;i++)if(Number(String((value.matrix[impacts[i]] as Record<string,unknown>)[u]).slice(1))>
    Number(String((value.matrix[impacts[i+1]] as Record<string,unknown>)[u]).slice(1)))return false;
  for(const [i,p] of PRIORITIES.entries()) {const t=value.targets[p];
    if(!object(t)||!exact(t,['response','resolution'])||![t.response,t.resolution].every(n=>Number.isInteger(n)&&Number(n)>0&&Number(n)<=43200)
      ||Number(t.response)>Number(t.resolution))return false;
    if(i){const previous=value.targets[PRIORITIES[i-1]] as Record<string,number>;
      if(previous.response>Number(t.response)||previous.resolution>Number(t.resolution))return false;}
  }
  return true;
}
export function evaluatePriority(policy:PriorityPolicy,impact:Impact,urgency:Urgency,serviceCode:string):Priority {
  return urgency==='HIGH'&&policy.criticalServices.includes(serviceCode)?'P1':policy.matrix[impact][urgency];
}
export interface PriorityEvidence {impact:Impact|null;urgency:Urgency|null;impactQuote:string|null;urgencyQuote:string|null}
export function validPriorityEvidence(value:unknown,text:string):value is PriorityEvidence {
  if(!object(value)||!exact(value,['impact','urgency','impactQuote','urgencyQuote']))return false;
  const quoted=(v:unknown)=>typeof v==='string'&&v.trim().length>=2&&v.length<=300&&text.includes(v);
  return (value.impact===null?value.impactQuote===null:['COMPANY','DEPARTMENT','INDIVIDUAL'].includes(String(value.impact))&&quoted(value.impactQuote))
    &&(value.urgency===null?value.urgencyQuote===null:['HIGH','MEDIUM','LOW'].includes(String(value.urgency))&&quoted(value.urgencyQuote));
}
