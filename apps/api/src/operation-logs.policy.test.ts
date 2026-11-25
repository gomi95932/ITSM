import test from 'node:test';
import assert from 'node:assert/strict';
import {operationLogChanges,operationLogFilters,operationLogSnapshot,redactLogText} from './operation-logs.policy.js';

test('operation log filters bound paging, validate dates and treat query text literally',()=>{
  assert.equal(operationLogFilters({q:"%' OR 1=1 --",from:'2026-11-24T08:00:00+08:00'}).from,'2026-11-24T00:00:00.000Z');
  for(const input of [{module:'unknown'},{result:'SUCCESS'},{actor:['a','b']},{page:'0'},{size:'101'},
    {from:'2026-02-30T00:00:00Z'},{from:'2026-11-25T00:00:00Z',to:'2026-11-24T00:00:00Z'},{extra:'x'}]){
    assert.throws(()=>operationLogFilters(input));
  }
});
test('operation log snapshots exclude credentials and ticket content while preserving configuration differences',()=>{
  assert.deepEqual(operationLogSnapshot({status:'CLOSED',description:'private ticket',password:'secret',fields:{value:'private'}},'tickets'),{status:'CLOSED'});
  const snapshot=operationLogSnapshot({employeeSites:[{employeeId:'fixture',homeSiteId:'hq',siteIds:['hq']}],token:'secret',
    reason:'token=fixture-secret',description:'sk-fixture123456789'},'operations');
  assert.equal(JSON.stringify(snapshot).includes('fixture-secret'),false);
  assert.equal(JSON.stringify(snapshot).includes('sk-fixture'),false);
  assert.equal(redactLogText('Bearer fixture-token'),'[已隐藏凭据]');
  const before={positions:[{id:'a',name:'Old'},{id:'b',name:'Other'}]};
  const after={positions:[{id:'b',name:'Other'},{id:'a',name:'New'}]};
  assert.deepEqual(operationLogChanges(before,after).changes,[{field:'positions[a].name',before:'Old',after:'New'}]);
  assert.equal(operationLogChanges({rows:[]},{rows:[{serviceCode:'A',siteId:'x'},{serviceCode:'A',siteId:'y'}]}).changes.length,1);
  assert.equal(operationLogChanges(Object.fromEntries(Array.from({length:201},(_,i)=>[i,0])),Object.fromEntries(Array.from({length:201},(_,i)=>[i,1]))).changesTruncated,true);
});
test('member privilege audit snapshots preserve explicit grants while excluding arbitrary data',()=>{
  assert.deepEqual(operationLogSnapshot({employeeId:'agent-1',privileges:['P1_REVIEW'],catalogServiceCodes:['REQ-ACCOUNT'],
    authToken:'hidden',fields:{private:'hidden'}},'roles'),
    {employeeId:'agent-1',privileges:['P1_REVIEW'],catalogServiceCodes:['REQ-ACCOUNT'],fields:{}});
});
