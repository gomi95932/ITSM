import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dingtalkRequestApproval} from './dingtalk-request-approval.js';
import type {ApprovalSnapshot} from './request-approval.js';

const snapshot:ApprovalSnapshot={serviceCode:'REQ-TEST',formVersion:1,templateId:'process-1',requestedValidityDays:7,
  applicant:{employeeId:'person-1',dingUserId:'ding-1'},approvers:[{employeeId:'person-2',dingUserId:'ding-2',role:'MANAGER'}],
  catalog:{},request:{subject:'Access request',description:'Approved test scope',fields:{scope:'test'}}};
const binding=()=>({reference:'approval-1',corpId:'corp-1',templateId:'process-1',serviceCode:'REQ-TEST',formVersion:1,
  requestedValidityDays:7,request:structuredClone(snapshot.request)});
const detail=()=>({success:'true',result:{originatorUserId:'ding-1',approverUserIds:['ding-2'],
  createTime:'2026-11-17T00:00:00Z',status:'COMPLETED',result:'agree',
  formComponentValues:[{name:'ITSM_REQUEST_BINDING',value:JSON.stringify(binding())}]}});
const signal=()=>new AbortController().signal;
function fixture(value:unknown=detail(),pages:unknown[]=[{success:true,result:{list:['instance-1']}}]){
  const calls:Array<{path:string;method:string;body?:object;token:string}>=[];
  const provider=dingtalkRequestApproval({corpId:'corp-1',token:async()=> 'private-token',transport:async(path,options)=>{
    calls.push({path,...options});
    return path.includes('/instanceIds/query')?pages.shift():options.method==='POST'?{instanceId:'instance-1'}:value;
  }});
  return {provider,calls};
}

test('create uses immutable request content, explicit ordered approvers and a single provider call',async()=>{
  const {provider,calls}=fixture();
  assert.deepEqual(await provider.create({reference:'approval-1',corpId:'corp-1',snapshot},signal()),{instanceId:'instance-1'});
  assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');
  const body=calls[0].body as any;
  assert.equal(body.processCode,'process-1');assert.equal(body.originatorUserId,'ding-1');
  assert.deepEqual(body.approvers,[{actionType:'NONE',userIds:['ding-2']}]);
  assert.deepEqual(JSON.parse(body.formComponentValues[0].value),binding());
  await assert.rejects(provider.create({reference:'approval-1',corpId:'other-corp',snapshot},signal()),/BINDING_UNVERIFIED/);
  assert.equal(calls.length,1);
});

test('inspect reads the remote form and proves instance membership in that template',async()=>{
  const value=detail();const remote=binding();remote.request.fields.scope='changed remotely';
  value.result.formComponentValues[0].value=JSON.stringify(remote);
  const {provider,calls}=fixture(value);
  const observation=await provider.inspect('instance-1',signal());
  assert.equal(observation.state,'APPROVED');
  assert.equal(observation.requestBinding.request.fields.scope,'changed remotely');
  assert.equal(calls[0].path,'/v1.0/workflow/processInstances?processInstanceId=instance-1');
  assert.equal((calls[1].body as any).processCode,'process-1');
  assert.deepEqual(observation.approverDingUserIds,['ding-2']);
});

test('missing, duplicate and malformed bindings never fall back to local snapshot data',async()=>{
  for(const mutate of [
    (v:any)=>{v.result.formComponentValues=[];},
    (v:any)=>{v.result.formComponentValues.push(v.result.formComponentValues[0]);},
    (v:any)=>{v.result.formComponentValues[0].value='not JSON';},
    (v:any)=>{v.result.formComponentValues[0].value=JSON.stringify({...binding(),corpId:'other'});},
    (v:any)=>{v.result.formComponentValues[0].value=JSON.stringify({...binding(),request:null});},
    (v:any)=>{delete v.result.approverUserIds;},
    (v:any)=>{v.result.createTime='invalid';},
    (v:any)=>{v.success='false';},
    (v:any)=>{v.result.status='UNKNOWN';},
    (v:any)=>{v.result.result='unknown';},
  ]){const value=detail();mutate(value);await assert.rejects(fixture(value).provider.inspect('instance-1',signal()),/BINDING_UNVERIFIED/);}
});

test('template query paginates and rejects absent instance, failed pages and cyclic cursors',async()=>{
  const first={success:true,result:{list:[],nextToken:'100'}};
  const {provider,calls}=fixture(detail(),[first,{success:'true',result:{list:['instance-1']}}]);
  assert.equal((await provider.inspect('instance-1',signal())).state,'APPROVED');
  assert.equal((calls[2].body as any).nextToken,100);
  for(const pages of [
    [{success:true,result:{list:['different']}}],
    [first,{success:true,result:{list:['instance-1'],nextToken:'100'}}],
    [first,{success:false,result:{list:['instance-1']}}],
    [{success:true,result:{list:['instance-1'],nextToken:'invalid'}}],
  ])await assert.rejects(fixture(detail(),pages).provider.inspect('instance-1',signal()),/BINDING_UNVERIFIED/);
});

test('known provider states are explicit and changed approvers are not overwritten',async()=>{
  for(const [status,result,expected] of [['RUNNING','','PENDING'],['TERMINATED','','WITHDRAWN'],['COMPLETED','refuse','REJECTED']]){
    const value=detail();value.result.status=status;value.result.result=result;value.result.approverUserIds=['replacement'];
    const observation=await fixture(value).provider.inspect('instance-1',signal());
    assert.equal(observation.state,expected);assert.deepEqual(observation.approverDingUserIds,['replacement']);
  }
});

test('unknown create outcomes are never retried by the adapter and secrets are not embedded in errors',async()=>{
  let attempts=0;
  const provider=dingtalkRequestApproval({corpId:'corp-1',token:async()=> 'private-token',transport:async()=>{
    attempts++;throw new Error('isolated transport failure');
  }});
  await assert.rejects(provider.create({reference:'approval-1',corpId:'corp-1',snapshot},signal()));
  assert.equal(attempts,1);assert.equal(provider.recoverCreated,undefined);
});
