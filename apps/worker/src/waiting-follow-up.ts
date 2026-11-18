import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

// The ticket lock serializes polling with waiting changes; reminders do not mutate business versions or SLA.
export async function maintainWaitingFollowUps(db: Pick<Pool,'connect'>): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const pending = await client.query<{ id:string; owner_group_id:string; status:string; version:number;
      waiting_reason_code:string; waiting_since:Date; waiting_due_at:Date }>(`SELECT t.id,t.owner_group_id,t.status,t.version,
        t.waiting_reason_code,t.waiting_since,t.waiting_due_at FROM tickets t
      JOIN support_groups g ON g.id=t.owner_group_id AND g.enabled
      WHERE t.status IN ('WAITING_USER','WAITING_VENDOR') AND t.waiting_due_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM ticket_waiting_signals s WHERE s.ticket_id=t.id AND s.group_id=t.owner_group_id
          AND s.waiting_since=t.waiting_since AND s.waiting_due_at=t.waiting_due_at AND s.waiting_reason_code=t.waiting_reason_code)
      ORDER BY t.waiting_due_at,t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED`);
    for (const ticket of pending.rows) {
      const event = randomUUID(), request = randomUUID(), action = `${ticket.status}_FOLLOW_UP_DUE`;
      const detail = { ownerGroupId:ticket.owner_group_id, waitingReason:ticket.waiting_reason_code,
        waitingSince:ticket.waiting_since, dueAt:ticket.waiting_due_at };
      await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id,created_at)
        VALUES($1,$2,'system:scheduler',$3,$4,$4,$5,$6,clock_timestamp())`,
      [event,ticket.id,action,ticket.status,JSON.stringify(detail),request]);
      await client.query(`INSERT INTO ticket_waiting_signals(ticket_id,group_id,waiting_status,waiting_reason_code,waiting_since,waiting_due_at,event_id)
        SELECT id,owner_group_id,status,waiting_reason_code,waiting_since,waiting_due_at,$2 FROM tickets WHERE id=$1`,[ticket.id,event]);
      await client.query(`INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,after_value)
        VALUES($1,$2,'system:scheduler',$3,$4,$5)`,[ticket.id,event,request,action,JSON.stringify({ ...detail, version:ticket.version })]);
      await client.query(`INSERT INTO outbox_events(ticket_id,event_id,kind,payload)
        VALUES($1,$2,'TICKET_CHANGED',$3)`,[ticket.id,event,JSON.stringify({ ticketId:ticket.id,eventId:event })]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
