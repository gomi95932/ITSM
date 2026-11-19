import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { maintainWaitingFollowUps } from './waiting-follow-up.js';

function fixture(failure?: string) {
  const queries: string[] = [];
  let released = 0;
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (failure && sql.includes(failure)) throw new Error('CI_TRANSACTION_FAILURE');
      return { rows: sql.startsWith('SELECT t.id,') ? [{ id:'ticket-1',owner_group_id:'group-1',status:'WAITING_USER',
        version:2,waiting_reason_code:'USER_INFORMATION',waiting_since:new Date('2026-01-01T00:00:00Z'),
        waiting_due_at:new Date('2026-01-02T00:00:00Z') }] : [] };
    },
    release() { released++; },
  } as unknown as PoolClient;
  const db = { async connect() { return client; } } as Pick<Pool,'connect'>;
  return { db,queries,released:()=>released };
}

test('waiting signal, event, audit and outbox commit together without changing ticket or SLA',async()=>{
  const state=fixture();
  await maintainWaitingFollowUps(state.db);
  assert.equal(state.queries[0],'BEGIN');
  assert.equal(state.queries.at(-1),'COMMIT');
  for (const table of ['ticket_events','ticket_waiting_signals','audit_logs','outbox_events'])
    assert.equal(state.queries.filter(sql=>sql.includes(`INSERT INTO ${table}`)).length,1);
  assert.ok(state.queries.some(sql=>sql.includes('LIMIT 100 FOR UPDATE OF t SKIP LOCKED')));
  assert.equal(state.queries.some(sql=>/UPDATE tickets|UPDATE sla_cycles|INSERT INTO sla_cycles/.test(sql)),false);
  assert.equal(state.released(),1);
});

test('any failed waiting write rolls back and always releases the connection',async()=>{
  for (const write of ['INSERT INTO ticket_events','INSERT INTO ticket_waiting_signals','INSERT INTO audit_logs','INSERT INTO outbox_events']) {
    const state=fixture(write);
    await assert.rejects(maintainWaitingFollowUps(state.db),/CI_TRANSACTION_FAILURE/);
    assert.equal(state.queries.at(-1),'ROLLBACK');
    assert.equal(state.queries.includes('COMMIT'),false);
    assert.equal(state.released(),1);
  }
});
