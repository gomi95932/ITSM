import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preserveStructureIds,serviceStructure,structureProposal } from './service-structure-policy.js';

function fixture(){return {
  domains:[{id:'custom-domain',name:' 自定义研发服务 ',enabled:true}],
  systems:[{id:'custom-system',name:'实验系统',domainId:'custom-domain',enabled:true}],
  positions:[{id:'custom-position',name:'研发运维',domainId:'custom-domain',groupId:'custom-group',enabled:true}],
  appointments:[{id:'appointment-a',positionId:'custom-position',employeeId:'employee-a',duty:'PRIMARY',
    validFrom:'2026-11-17T08:00:00+08:00',validTo:'2026-12-17T08:00:00+08:00',enabled:true}],
  mappings:[{serviceCode:'INC-CUSTOM',domainId:'custom-domain',systemId:'custom-system',primaryPositionId:'custom-position',collaboratingPositionIds:[],enabled:true}],
};}
test('arbitrary domains, systems and positions are data, not fixed business enums',()=>{
  const config=serviceStructure(fixture());
  assert.equal(config.domains[0].name,'自定义研发服务');
  assert.equal(config.appointments[0].validFrom,'2026-11-17T00:00:00.000Z');
  assert.equal(config.mappings[0].serviceCode,'INC-CUSTOM');
  assert.deepEqual(serviceStructure(config),config);
});
test('directory employee identities can hold appointments without widening structure identifiers',()=>{
  const input=fixture(),employeeId=`ding:${'a'.repeat(64)}`;
  input.appointments[0].employeeId=employeeId;
  assert.equal(serviceStructure(input).appointments[0].employeeId,employeeId);
  for(const invalid of ['ding:abc',`ding:${'A'.repeat(64)}`,`${employeeId}\n`]){
    input.appointments[0].employeeId=invalid;assert.throws(()=>serviceStructure(input));
  }
  input.appointments[0].employeeId=employeeId;input.positions[0].groupId=employeeId;
  assert.throws(()=>serviceStructure(input));
});
test('structure rejects overposting, dangling references and enabled children of disabled parents',()=>{
  for(const mutate of [
    (c:any)=>{c.roles=[];},(c:any)=>{c.domains.push({...c.domains[0]});},
    (c:any)=>{c.positions[0].domainId='missing';},(c:any)=>{c.systems[0].domainId='missing';},
    (c:any)=>{c.appointments[0].positionId='missing';},(c:any)=>{c.domains[0].enabled=false;},
    (c:any)=>{c.positions[0].enabled=false;},(c:any)=>{c.systems[0].enabled=false;},
    (c:any)=>{c.mappings[0].collaboratingPositionIds=['missing'];},
    (c:any)=>{c.mappings[0].collaboratingPositionIds=['custom-position'];},
    (c:any)=>{c.appointments[0].validTo=c.appointments[0].validFrom;},
    (c:any)=>{c.appointments[0].duty='ADMIN';},(c:any)=>{c.domains[0].name='\u0000bad';},
  ]){const input=fixture();mutate(input);assert.throws(()=>serviceStructure(input));}
});
test('appointments support permanent and multi-year terms with precise date errors',()=>{
  const permanent=fixture();permanent.appointments[0].validTo=null as any;
  assert.equal(serviceStructure(permanent).appointments[0].validTo,null);
  const years=fixture();years.appointments[0].validTo='2029-11-21T08:00:00+08:00';
  assert.equal(serviceStructure(years).appointments[0].validTo,'2029-11-21T00:00:00.000Z');
  for(const [patch,code] of [
    [{validFrom:''},'SERVICE_STRUCTURE_APPOINTMENT_START_INVALID'],
    [{validTo:''},'SERVICE_STRUCTURE_APPOINTMENT_END_INVALID'],
    [{validTo:'invalid'},'SERVICE_STRUCTURE_APPOINTMENT_END_INVALID'],
    [{validTo:'2026-11-17T00:00:00Z'},'SERVICE_STRUCTURE_APPOINTMENT_PERIOD_INVALID'],
    [{validTo:'2025-11-17T00:00:00Z'},'SERVICE_STRUCTURE_APPOINTMENT_PERIOD_INVALID'],
  ] as const){
    const input=fixture();Object.assign(input.appointments[0],patch);
    assert.throws(()=>serviceStructure(input),(error:any)=>{
      assert.deepEqual(error.getResponse(),{code,appointmentId:'appointment-a'});return true;
    });
  }
  const missing=fixture();delete (missing.appointments[0] as any).validTo;
  assert.throws(()=>serviceStructure(missing),'missing end must be explicit null, not an implicit permanent grant');
});
test('published identifiers survive renaming and disabling, but cannot be hard deleted',()=>{
  const previous=serviceStructure(fixture()),next=structuredClone(previous);
  next.domains[0].name='新责任域名称';
  for(const key of ['domains','systems','positions','appointments','mappings'] as const)next[key].forEach(row=>row.enabled=false);
  assert.doesNotThrow(()=>preserveStructureIds(previous,serviceStructure(next)));
  for(const key of ['domains','systems','positions','appointments','mappings'] as const){
    const missing=structuredClone(previous);missing[key]=[];
    assert.throws(()=>preserveStructureIds(previous,missing));
  }
});
test('proposals carry strict optimistic version, stable request id and a general-content declaration',()=>{
  const input={id:'a8caeb74-5f2c-4a30-bfb2-9ba2fae42e07',expectedVersion:1,config:fixture(),reason:' 配置研发服务 ',contentClass:'GENERAL'};
  assert.equal(structureProposal(input).reason,'配置研发服务');
  for(const patch of [{expectedVersion:0},{expectedVersion:1.5},{id:'bad'},{contentClass:'SECRET'},{reason:''},{approved:true}])
    assert.throws(()=>structureProposal({...input,...patch}));
});
