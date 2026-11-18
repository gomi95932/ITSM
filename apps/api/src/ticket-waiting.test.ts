import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWaitingDeadline, ticketWaiting, type WaitingRow } from './ticket-waiting.js';

const clock = new Date('2026-11-18T10:00:00.000Z');
const row: WaitingRow = {status:'WAITING_VENDOR',waiting_reason_code:'VENDOR_SUPPORT',
  waiting_since:new Date('2026-11-17T10:00:00.000Z'),waiting_due_at:clock};

test('waiting view uses the supplied database clock and retains unknown legacy metadata', () => {
  assert.deepEqual(ticketWaiting(row,clock),{reason:'VENDOR_SUPPORT',since:row.waiting_since!.toISOString(),
    dueAt:clock.toISOString(),followUpOverdue:true});
  assert.equal(ticketWaiting(row,new Date(clock.getTime()-1))?.followUpOverdue,false);
  for(const data of [{...row,waiting_reason_code:null,waiting_since:null,waiting_due_at:null},
    {...row,waiting_reason_code:'USER_INFORMATION'}, {...row,waiting_reason_code:'arbitrary provider text'}])
    assert.deepEqual(ticketWaiting(data,clock),{reason:'UNRECORDED',since:null,dueAt:null,followUpOverdue:null});
  assert.equal(ticketWaiting({...row,status:'CLOSED'},clock),null);
});

test('waiting deadline accepts canonical absolute timestamps only', () => {
  assert.equal(isWaitingDeadline(clock.toISOString()),true);
  for(const value of [undefined,null,0,'','yesterday','2026-11-18T10:00','2026-02-30T10:00:00.000Z','infinity',
    '2026-11-18T10:00:00Z','2026-11-18T18:00:00.000+08:00'])
    assert.equal(isWaitingDeadline(value),false);
});
