import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServiceStructure } from '@itsm/contracts';
import type { Database } from './database.service.js';
import type { IntakePolicyService } from './intake-policy.service.js';
import { ServiceStructureService } from './service-structure.service.js';

const config=():ServiceStructure=>({
  domains:[{id:'it',name:'IT',enabled:true}],systems:[],
  positions:[{id:'desk',name:'Desk',domainId:'it',groupId:'service-desk',enabled:true}],
  appointments:[{id:'duty',positionId:'desk',employeeId:'engineer',duty:'PRIMARY',
    validFrom:'2026-01-01T00:00:00.000Z',validTo:'2026-12-31T00:00:00.000Z',enabled:true}],mappings:[],
});
const reordered=(value:unknown):unknown=>Array.isArray(value)?value.map(reordered):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reordered(item)])):value;
const service=new ServiceStructureService({} as Database,{} as IntakePolicyService) as unknown as {
  proposer(client:unknown,actor:string,previous:ServiceStructure,next:ServiceStructure):Promise<void>;
  affected(previous:ServiceStructure,next:ServiceStructure):Set<string>;
};
const lead={query:async(sql:string)=>sql.includes("role_code='PLATFORM_ADMIN'")?{rowCount:0,rows:[]}
  :{rowCount:1,rows:[{group_id:'service-desk'}]}};
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'getResponse' in error
  &&typeof error.getResponse==='function'&&error.getResponse().code===expected;

test('JSON object key order does not turn a scoped appointment change into a structural change',async()=>{
  const previous=reordered(config()) as ServiceStructure,next=config();next.appointments[0].duty='BACKUP';
  await assert.doesNotReject(service.proposer(lead,'lead',previous,next));
  next.appointments[0].employeeId='lead';
  await assert.rejects(service.proposer(lead,'lead',previous,next),code('SELF_APPOINTMENT_NOT_ALLOWED'));
  next.positions[0].name='Unauthorized rename';
  await assert.rejects(service.proposer(lead,'lead',previous,next),code('APPOINTMENT_SCOPE_REQUIRED'));
});
test('unchanged appointments outside the lead group stay unchanged after a JSONB round trip',async()=>{
  const previous=config();previous.positions[0].groupId='other-group';
  await assert.doesNotReject(service.proposer(lead,'lead',reordered(previous) as ServiceStructure,previous));
  const next=structuredClone(previous);next.appointments[0].duty='BACKUP';
  await assert.rejects(service.proposer(lead,'lead',reordered(previous) as ServiceStructure,next),code('APPOINTMENT_SCOPE_REQUIRED'));
});
test('independent-review subjects only include real structure or appointment changes',()=>{
  const next=config(),previous=reordered(next) as ServiceStructure;
  assert.deepEqual([...service.affected(previous,next)],[]);
  next.appointments[0].employeeId='replacement';
  assert.deepEqual([...service.affected(previous,next)].sort(),['engineer','replacement']);
});
