import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCompanyServiceStructureTemplate,COMPANY_SERVICE_STRUCTURE_TEMPLATE } from '@itsm/contracts';
import type { ServiceStructure } from '@itsm/contracts';
import { preserveStructureIds,serviceStructure } from './service-structure-policy.js';

const empty=():ServiceStructure=>({domains:[],systems:[],positions:[],appointments:[],mappings:[]});
const groups=[{id:'infra-group',name:'基础设施组'},{id:'apps-group',name:'信息系统组'}];
const selection=[{domainId:'it-infrastructure',groupId:'infra-group'},{domainId:'information-systems',groupId:'apps-group'}];
const initial=()=>addCompanyServiceStructureTemplate(empty(),groups,selection);

test('company template offers two domains, eleven systems and fifteen positions without real appointments or live routing',()=>{
  const current=empty(),result=addCompanyServiceStructureTemplate(current,groups,selection);
  assert.deepEqual(current,empty());assert.deepEqual(result.conflicts,[]);
  assert.equal(result.added.length,28);assert.equal(result.config.domains.length,2);
  assert.equal(result.config.systems.length,11);assert.equal(result.config.positions.length,15);
  assert.deepEqual(result.config.appointments,[]);assert.deepEqual(result.config.mappings,[]);
  for(const key of ['domains','systems','positions'] as const)assert.ok(result.config[key].every(row=>!row.enabled));
  assert.ok(result.config.positions.filter(row=>row.domainId==='tpl-it-infrastructure').every(row=>row.groupId==='infra-group'));
  assert.ok(result.config.positions.filter(row=>row.domainId==='tpl-information-systems').every(row=>row.groupId==='apps-group'));
  assert.deepEqual(result.config.systems.map(row=>row.name),['ERP','SRM','WMS','OA','AGV','PDM','COST','HUB','TB','钉钉','邮件']);
  assert.doesNotThrow(()=>serviceStructure(result.config));
});

test('template may be imported by domain and repeated without duplicate ids or implicit group changes',()=>{
  const infra=addCompanyServiceStructureTemplate(empty(),groups,[selection[0]]);
  assert.equal(infra.added.length,5);assert.equal(infra.config.systems.length,0);
  const complete=addCompanyServiceStructureTemplate(infra.config,groups,selection);
  assert.equal(complete.added.length,23);assert.equal(complete.retained.length,5);
  const repeated=addCompanyServiceStructureTemplate(complete.config,groups,selection.map(row=>({...row,groupId:'infra-group'})));
  assert.deepEqual(repeated.config,complete.config);assert.equal(repeated.added.length,0);
  assert.equal(repeated.retained.length,28);assert.equal(repeated.conflicts.length,0);
});

test('reimport preserves custom names, disabled states, current appointments, extra domains and service references',()=>{
  const current=initial().config;
  current.domains[0].name='基础平台服务';current.domains[0].enabled=true;
  current.positions[0].name='桌面支持';current.positions[0].groupId='apps-group';current.positions[0].enabled=true;
  current.domains.push({id:'new-domain',name:'第三自定义域',enabled:true});
  current.systems.push({id:'new-system',name:'新业务系统',domainId:'new-domain',enabled:true});
  current.appointments.push({id:'real-appointment',positionId:current.positions[0].id,employeeId:'real-employee',duty:'PRIMARY',
    validFrom:'2026-11-17T00:00:00Z',validTo:'2026-12-17T00:00:00Z',enabled:true});
  current.mappings.push({serviceCode:'INC-EXISTING',domainId:current.domains[0].id,systemId:null,
    primaryPositionId:current.positions[0].id,collaboratingPositionIds:[],enabled:true});
  const snapshot=structuredClone(current),result=addCompanyServiceStructureTemplate(current,groups,selection);
  assert.deepEqual(result.config,snapshot);assert.deepEqual(current,snapshot);
  assert.equal(result.added.length,0);assert.equal(result.conflicts.length,0);
  assert.doesNotThrow(()=>preserveStructureIds(current,serviceStructure(result.config)));
  result.config.domains[0].name='local change';assert.equal(current.domains[0].name,'基础平台服务');
});

test('same names with different ids and conflicting stable-id parents fail atomically',()=>{
  for(const setup of [
    (config:ServiceStructure)=>config.domains.push({id:'existing-domain',name:'IT 基础设施运维',enabled:false}),
    (config:ServiceStructure)=>config.systems.push({id:'existing-system',name:' ＥＲＰ ',domainId:'custom-domain',enabled:false}),
    (config:ServiceStructure)=>config.positions.push({id:'tpl-position-network',name:'Existing network',domainId:'custom-domain',groupId:'infra-group',enabled:false}),
    (config:ServiceStructure)=>config.systems.push({id:'tpl-system-wms',name:'Existing WMS',domainId:'custom-domain',enabled:false}),
    (config:ServiceStructure)=>config.positions.push({id:'custom-helpdesk',name:'Helpdesk 工程师',domainId:'custom-domain',groupId:'infra-group',enabled:false}),
  ]){
    const current=empty();current.domains.push({id:'custom-domain',name:'自定义域',enabled:false});setup(current);
    const snapshot=structuredClone(current),result=addCompanyServiceStructureTemplate(current,groups,selection);
    assert.ok(result.conflicts.some(row=>row.reason==='NAME'||row.reason==='DOMAIN'));
    assert.deepEqual(result.config,snapshot);assert.deepEqual(current,snapshot);assert.deepEqual(result.added,[]);
  }
});

test('template rejects missing groups, unknown or duplicated selections without partial changes',()=>{
  for(const choices of [[...selection,{domainId:'unknown',groupId:'infra-group'}],[selection[0],selection[0]],
    [selection[0],{domainId:'information-systems',groupId:'missing'}]]){
    const result=addCompanyServiceStructureTemplate(empty(),groups,choices);
    assert.ok(result.conflicts.length>0);assert.deepEqual(result.config,empty());assert.deepEqual(result.added,[]);
  }
  const result=addCompanyServiceStructureTemplate(empty(),groups,[]);
  assert.deepEqual(result.config,empty());assert.equal(result.added.length,0);
  assert.equal(COMPANY_SERVICE_STRUCTURE_TEMPLATE.length,2);
});
