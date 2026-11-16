import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supportDecision,supportIndependentReview,supportProposal } from './support-policy.js';

const proposal={id:'a8caeb74-5f2c-4a30-bfb2-9ba2fae42e07',kind:'MEMBER_ADD',groupId:'service-desk',employeeId:'agent-1',
  config:{},expectedGroupVersion:1,reason:' Reviewed roster ',contentClass:'GENERAL'};
test('support proposals are strict, canonical and versioned',()=>{
  assert.equal(supportProposal(proposal).reason,'Reviewed roster');
  for(const patch of [{canReview:true},{kind:'UNKNOWN'},{expectedGroupVersion:null},{config:{active:true}},
    {employeeId:12},{id:12},{contentClass:'SECURITY_SENSITIVE'},{reason:'\u0000invalid'}])
    assert.throws(()=>supportProposal({...proposal,...patch}));
  const create={...proposal,kind:'GROUP_CREATE',employeeId:undefined,expectedGroupVersion:null,config:{name:' Network ',description:' Operations '}};
  assert.deepEqual(supportProposal(create).config,{name:'Network',description:'Operations'});
  assert.throws(()=>supportProposal({...create,employeeId:'agent-1'}));
  assert.throws(()=>supportProposal({...create,config:{name:'Network',description:'',fallbackGroupId:null}}));
});
test('support decisions cannot overpost and require an independent reviewer',()=>{
  const input={expectedVersion:1,decision:'APPROVE',reason:' Independent review ',contentClass:'GENERAL'};
  assert.equal(supportDecision(input).reason,'Independent review');
  assert.throws(()=>supportDecision({...input,version:2}));
  assert.throws(()=>supportDecision({...input,expectedVersion:1.5}));
  assert.equal(supportIndependentReview('admin-a','admin-a','engineer'),false);
  assert.equal(supportIndependentReview('engineer','admin-a','engineer'),false);
  assert.equal(supportIndependentReview('admin-b','admin-a','engineer'),true);
});
test('group lifecycle proposals have no employee, implicit migration or privilege restoration payload',()=>{
  for(const kind of ['GROUP_DISABLE','GROUP_RESTORE']){
    const input={...proposal,kind,employeeId:undefined};
    assert.deepEqual(supportProposal(input),{id:input.id,kind,groupId:input.groupId,config:{},expectedGroupVersion:1,
      reason:'Reviewed roster',contentClass:'GENERAL'});
    for(const patch of [{employeeId:'agent-1'},{config:{restoreMembers:true}},{config:{enabled:false}},{expectedGroupVersion:null}])
      assert.throws(()=>supportProposal({...input,...patch}));
  }
});
