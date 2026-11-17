import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fulfillmentAction,fulfillmentFilter,requestDeliveryAction } from './fulfillment-policy.js';
const key='AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const body={expectedVersion:1,reference:'CHG-2026/123',contentClass:'GENERAL'};
test('fulfillment filters are strict, paginated and accept configurable groups',()=>{
  assert.deepEqual(fulfillmentFilter({}),{queue:'UNREVIEWED',group:'',page:1,size:20});
  assert.equal(fulfillmentFilter({queue:'ALL',group:'custom-domain_group',page:'2'}).page,2);
  for(const input of [{page:'0'},{page:'1.5'},{page:'1e2'},{page:['1']},{queue:'READY'},{group:'bad group'}])
    assert.throws(()=>fulfillmentFilter(input));
});
test('first-delivery commands require exact intent and actual manual-delivery confirmation',()=>{
  const prepare={expectedVersion:0,contentClass:'GENERAL'};
  const deliver={...body,actualDeliveryConfirmed:true};
  assert.deepEqual(requestDeliveryAction(prepare,key,'PREPARE'),{...prepare,key:key.toLowerCase(),reference:null});
  assert.deepEqual(requestDeliveryAction(deliver,key,'DELIVER'),{...body,key:key.toLowerCase()});
  for(const value of [null,{}, {...prepare,expectedVersion:1},{...prepare,reference:'EXTRA'},
    {...prepare,contentClass:'SECRET'},{...prepare,expectedVersion:-1}])assert.throws(()=>requestDeliveryAction(value,key,'PREPARE'));
  for(const value of [body,{...deliver,actualDeliveryConfirmed:false},{...deliver,actualDeliveryConfirmed:'true'},
    {...deliver,expectedVersion:0},{...deliver,expectedVersion:1.1},{...deliver,expectedVersion:2147483648},
    {...deliver,reference:'bad text'},{...deliver,extra:1},{...deliver,contentClass:'SECRET'}])assert.throws(()=>requestDeliveryAction(value,key,'DELIVER'));
  for(const invalid of ['',undefined,[], 'not-a-uuid'])assert.throws(()=>requestDeliveryAction(prepare,invalid,'PREPARE'));
});
test('fulfillment commands require exact declared content, version, evidence and request key',()=>{
  assert.deepEqual(fulfillmentAction(body,key),{...body,key:key.toLowerCase()});
  for(const value of [null,{}, {...body,expectedVersion:0},{...body,reference:'bad text'},{...body,contentClass:'SECRET'},
    {...body,extra:'ignored?'},{...body,expectedVersion:1.1},{...body,expectedVersion:2147483648}])assert.throws(()=>fulfillmentAction(value,key));
  for(const invalid of ['',undefined,[], 'not-a-uuid'])assert.throws(()=>fulfillmentAction(body,invalid));
});
