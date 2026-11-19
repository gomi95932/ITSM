import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export function fulfillmentReminderMinutes(value:string|undefined,fallback:number):number {
  if(value===undefined)return fallback;
  if(!/^[1-9][0-9]{0,4}$/.test(value)||Number(value)>10080)throw new Error('FULFILLMENT_REMINDER_MINUTES_INVALID');
  return Number(value);
}

// Signal, audit and outbox commit together; polling never changes a fulfillment's business version.
export async function maintainFulfillmentAttention(db:Pool,policy:{reviewMinutes:number;revokeMinutes:number}):Promise<void> {
  for(const minutes of [policy.reviewMinutes,policy.revokeMinutes])
    if(!Number.isInteger(minutes)||minutes<1||minutes>10080)throw new Error('FULFILLMENT_REMINDER_MINUTES_INVALID');
  const candidates=await db.query<{approval_id:string}>(`SELECT approval_id FROM request_fulfillment_attention_pending
    GROUP BY approval_id ORDER BY min(since_at),approval_id LIMIT 100`);
  for(const candidate of candidates.rows){
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
      await client.query('SELECT id FROM request_approvals WHERE id=$1 FOR UPDATE',[candidate.approval_id]);
      const task=(await client.query<{id:string;ticket_id:string}>(
        'SELECT id,ticket_id FROM request_fulfillments WHERE approval_id=$1 FOR UPDATE',[candidate.approval_id])).rows[0];
      if(task){
        const ticket=(await client.query('SELECT status,version FROM tickets WHERE id=$1 FOR SHARE',[task.ticket_id])).rows[0];
        const pending=await client.query<{kind:string;group_id:string;since_at:Date;escalate_at:Date|null}>(
          'SELECT kind,group_id,since_at,escalate_at FROM request_fulfillment_attention_pending WHERE fulfillment_id=$1 ORDER BY kind',[task.id]);
        for(const obligation of pending.rows){
          const event=randomUUID(),request=randomUUID(),action=`FULFILLMENT_${obligation.kind}`;
          const minutes=obligation.kind.startsWith('REVIEW_')?policy.reviewMinutes:policy.revokeMinutes;
          const escalateAt=obligation.escalate_at??new Date(obligation.since_at.getTime()+minutes*60000);
          await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id,created_at)
            VALUES($1,$2,'system:scheduler',$3,$4,$4,$5,$6,clock_timestamp())`,
            [event,task.ticket_id,action,ticket.status,JSON.stringify({fulfillmentId:task.id,ownerGroupId:obligation.group_id}),request]);
          await client.query(`INSERT INTO request_fulfillment_signals(fulfillment_id,group_id,kind,event_id,escalate_at)
            VALUES($1,$2,$3,$4,$5)`,[task.id,obligation.group_id,obligation.kind,event,escalateAt]);
          await client.query(`INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,after_value)
            VALUES($1,$2,'system:scheduler',$3,$4,$5)`,[task.ticket_id,event,request,action,
              JSON.stringify({fulfillmentId:task.id,ownerGroupId:obligation.group_id,escalateAt,version:ticket.version})]);
          await client.query(`INSERT INTO outbox_events(ticket_id,event_id,kind,payload)
            VALUES($1,$2,'TICKET_CHANGED',$3)`,[task.ticket_id,event,JSON.stringify({ticketId:task.ticket_id,eventId:event})]);
        }
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}
