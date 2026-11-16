import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fulfillmentAction,fulfillmentFilter } from './fulfillment-policy.js';
const key='AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const body={expectedVersion:1,reference:'CHG-2026/123',contentClass:'GENERAL'};
test('fulfillment filters are strict, paginated and accept configurable groups',()=>{
  assert.deepEqual(fulfillmentFilter({}),{queue:'UNREVIEWED',group:'',page:1,size:20});
  assert.equal(fulfillmentFilter({queue:'ALL',group:'custom-domain_group',page:'2'}).page,2);
  for(const input of [{page:'0'},{page:'1.5'},{page:'1e2'},{page:['1']},{queue:'READY'},{group:'bad group'}])
    assert.throws(()=>fulfillmentFilter(input));
});
test('fulfillment commands require exact declared content, version, evidence and request key',()=>{
  assert.deepEqual(fulfillmentAction(body,key),{...body,key:key.toLowerCase()});
  for(const value of [null,{}, {...body,expectedVersion:0},{...body,reference:'bad text'},{...body,contentClass:'SECRET'},
    {...body,extra:'ignored?'},{...body,expectedVersion:1.1},{...body,expectedVersion:2147483648}])assert.throws(()=>fulfillmentAction(value,key));
  for(const invalid of ['',undefined,[], 'not-a-uuid'])assert.throws(()=>fulfillmentAction(body,invalid));
});
