import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fulfillmentReminderMinutes,maintainFulfillmentAttention } from './fulfillment-attention.js';
import type { Pool } from 'pg';

test('reminder intervals are bounded integer minutes, not arbitrary durations',()=>{
  assert.equal(fulfillmentReminderMinutes(undefined,1440),1440);
  for(const value of ['1','60','10080'])assert.equal(fulfillmentReminderMinutes(value,60),Number(value));
  for(const value of ['','0','-1','1.5','1e3','060','10081','Infinity',' 60'])
    assert.throws(()=>fulfillmentReminderMinutes(value,60),/FULFILLMENT_REMINDER_MINUTES_INVALID/);
});

test('invalid internal policy fails before any database work',async()=>{
  const db={} as Pool;
  for(const minutes of [0,-1,1.1,10081,NaN,Infinity])
    await assert.rejects(maintainFulfillmentAttention(db,{reviewMinutes:minutes,revokeMinutes:60}),/FULFILLMENT_REMINDER_MINUTES_INVALID/);
});
