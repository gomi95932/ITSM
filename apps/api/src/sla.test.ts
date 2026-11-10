import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { DEFAULT_CALENDAR } from '@itsm/contracts';
import { SlaService } from './sla.service.js';

test('priority review cannot change a running SLA pause from 24x7 to office hours',async()=>{
  const calls:{sql:string;args:unknown[]}[]=[];
  const client={query:async(sql:string,args:unknown[])=>{
    calls.push({sql,args});
    return {rows:[{cycle:1,priority:'P1',paused_at:new Date('2026-11-07T15:00:00Z'),
      clock:new Date('2026-11-07T17:00:00Z'),calendar_snapshot:DEFAULT_CALENDAR,completed_at:null}]};
  }} as unknown as PoolClient;
  await new SlaService().action(client,'ticket','ADD_INFO','P2');
  assert.equal(calls[1]?.args[2],120);
});
