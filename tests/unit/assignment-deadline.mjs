import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignmentDeadline,DEFAULT_CALENDAR } from '../../packages/contracts/dist/index.js';

test('approved service calendar skips weekend while P1 uses continuous time',()=>{
  const friday=new Date('2026-11-20T09:55:00Z'); // Friday 17:55 in Shanghai.
  assert.equal(assignmentDeadline(friday,15,DEFAULT_CALENDAR).toISOString(),'2026-11-23T01:10:00.000Z');
  assert.equal(assignmentDeadline(friday,5,DEFAULT_CALENDAR,true).toISOString(),'2026-11-20T10:00:00.000Z');
});
test('a company holiday is not counted toward the deadline',()=>{
  const start=new Date('2026-11-23T01:00:00Z');
  assert.equal(assignmentDeadline(start,30,{...DEFAULT_CALENDAR,holidays:['2026-11-23']}).toISOString(),'2026-11-24T01:30:00.000Z');
});
