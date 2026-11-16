import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serviceCatalogChange } from './service-catalog-policy.js';
import { structureProposal } from './service-structure-policy.js';

const fixture=()=>({expectedVersion:0,code:'INC-LAB',type:'INC',name:' 研发实验服务 ',description:'实验设备维护',published:true,
  groupId:'custom-group',visibleGroups:[],sortOrder:10,fields:[{key:'device',label:'设备编号',required:true}],
  approval:null,maxValidityDays:null,initialPublisherId:null});
test('catalog metadata accepts arbitrary service names and strict controlled fields',()=>{
  assert.equal(serviceCatalogChange(fixture()).name,'研发实验服务');
  const value={...fixture(),expectedVersion:1,published:false};
  assert.equal(serviceCatalogChange(value).published,false);
});
test('catalog metadata rejects overposting, invalid versions, mismatched types and approval bypass',()=>{
  for(const patch of [{admin:true},{expectedVersion:-1},{expectedVersion:1.5},{code:'REQ-LAB'},
    {code:'INC-<script>'},{type:'GEN'},{name:'\u0000bad'},{sortOrder:-1},{sortOrder:100001},
    {visibleGroups:['a','a']},{groupId:'bad group'},{fields:[{key:'device',label:'设备',required:'yes'}]},
    {fields:[{key:'device',label:'设备',required:true,options:['a','a']}]},{initialPublisherId:'admin'},
    {approval:{templateId:'x',steps:[{role:'MANAGER'}]}},{maxValidityDays:30}])
    assert.throws(()=>serviceCatalogChange({...fixture(),...patch}));
});
test('new REQ requires explicit initial publisher and controlled approval; existing REQ forbids hidden reappointment',()=>{
  const value={...fixture(),type:'REQ',code:'REQ-LAB',initialPublisherId:'admin-a',maxValidityDays:30,
    approval:{templateId:'OA-LAB',steps:[{role:'MANAGER'}]}};
  assert.equal(serviceCatalogChange(value).initialPublisherId,'admin-a');
  assert.throws(()=>serviceCatalogChange({...value,initialPublisherId:null}));
  assert.throws(()=>serviceCatalogChange({...value,approval:{templateId:'OA-LAB',steps:[]}}));
  assert.throws(()=>serviceCatalogChange({...value,expectedVersion:2}));
  assert.equal(serviceCatalogChange({...value,expectedVersion:2,initialPublisherId:null}).expectedVersion,2);
});
test('structure proposal preserves validated catalog bundle and rejects unknown top-level data',()=>{
  const body={id:'a8caeb74-5f2c-4a30-bfb2-9ba2fae42e07',expectedVersion:1,config:{domains:[],systems:[],positions:[],appointments:[],mappings:[]},
    reason:'新增目录及岗位映射',contentClass:'GENERAL',catalogChange:fixture()};
  assert.equal(structureProposal(body).catalogChange?.code,'INC-LAB');
  assert.throws(()=>structureProposal({...body,approved:true}));
});
