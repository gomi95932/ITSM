import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogTreeInput} from './catalog-tree-policy.js';
import {initialCatalogTree} from './catalog-tree-bootstrap.js';

const root={id:'business',parentId:null,kind:'CATEGORY',name:'信息化系统',enabled:true,sortOrder:0,systemId:null,serviceCode:null};
const system={id:'erp',parentId:'business',kind:'SYSTEM',name:'ERP系统',enabled:true,sortOrder:0,systemId:'erp-id',serviceCode:null};
const service={id:'erp-incident',parentId:'erp',kind:'SERVICE',name:'登录与使用故障',enabled:true,sortOrder:0,systemId:null,serviceCode:'INC-ERP'};
const input=(nodes:unknown[])=>({expectedVersion:0,navigationVersion:1,structureVersion:1,reason:'目录整理',contentClass:'GENERAL',nodes});

test('bootstrap keeps ERP and generic incident distinct while drafting future items',()=>{
  const nodes=initialCatalogTree([
    {code:'INC-BIZ',name:'信息化系统故障',systemId:null},
    {code:'INC-ERP',name:'ERP 故障',systemId:'erp-id'},
    {code:'INC-SRM',name:'SRM 故障',systemId:'srm-id'},
  ],[{id:'erp-id',name:'ERP',enabled:true},{id:'srm-id',name:'SRM',enabled:true}],[]);
  assert.deepEqual(catalogTreeInput(input(nodes)).nodes,nodes);
  const erp=nodes.find(n=>n.serviceCode==='INC-ERP')!;
  assert.equal(nodes.find(n=>n.id===erp.parentId)?.systemId,'erp-id');
  assert.equal(nodes.find(n=>n.id===nodes.find(n=>n.serviceCode==='INC-BIZ')?.parentId)?.name,'其他或不确定系统');
  assert.equal(nodes.filter(n=>n.kind==='SERVICE'&&n.name==='权限申请'&&n.serviceCode===null).length,11);
  assert.equal(nodes.filter(n=>n.serviceCode==='INC-ERP').length,1);
});

test('tree rejects duplicate identities, ambiguous labels, invalid parentage and enabled drafts',()=>{
  const valid=[root,system,service];
  assert.equal(catalogTreeInput(input(valid)).nodes.length,3);
  for(const nodes of [
    [...valid,{...service,id:'duplicate',name:'另一个事项'}],
    [...valid,{...system,id:'duplicate',name:'重复系统'}],
    [...valid,{...service,id:'duplicate',serviceCode:null}],
    [root,{...system,enabled:false},service],
    [root,system,{...service,serviceCode:null}],
    [root,{...system,parentId:null},service],
    [root,system,{...service,parentId:'erp-incident'}],
    [root,system,{...service,parentId:'missing'}],
  ])assert.throws(()=>catalogTreeInput(input(nodes)));
  const draft={...service,id:'draft',name:'权限申请',enabled:false,serviceCode:null};
  assert.equal(catalogTreeInput(input([...valid,draft])).nodes.length,4);
});

test('non-system second-level categories support simple services',()=>{
  const second={...root,id:'uncertain',parentId:'business',name:'其他或不确定系统'};
  const leaf={...service,id:'generic',parentId:'uncertain',name:'业务系统故障待分类',serviceCode:'INC-BIZ'};
  assert.equal(catalogTreeInput(input([root,second,leaf])).nodes.length,3);
});
