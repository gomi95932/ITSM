import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

const eligible=(t:any)=>!t.assignee_id&&!t.pending_assignee_id&&
  (t.status==='QUEUED'||t.service_type==='REQ'&&t.status==='IN_PROGRESS');
async function active(client:PoolClient,id:string|null){
  return !!id&&!!(await client.query('SELECT 1 FROM employees WHERE id=$1 AND active',[id])).rowCount;
}
const snapshot=(r:any)=>r?{coordinatorId:r.coordinator_id,triageStage:r.stage,triageReason:r.reason,
  triageGeneration:r.generation,triageDueAt:r.due_at,policyVersion:r.policy_version}:null;
async function record(client:PoolClient,t:any,r:any,action:string,actor='system:scheduler',previous:any=null){
  const event=randomUUID(),request=randomUUID(),detail={coordinatorId:r.coordinator_id,triageStage:r.stage,
    triageReason:r.reason,triageGeneration:r.generation,triageDueAt:r.due_at,policyVersion:r.policy_version};
  await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id)
    VALUES($1,$2,$3,$4,$5,$5,$6,$7)`,[event,t.id,actor,action,t.status,JSON.stringify(detail),request]);
  await client.query(`INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[t.id,event,actor,request,action,JSON.stringify(snapshot(previous)),JSON.stringify(detail)]);
  await client.query(`INSERT INTO outbox_events(ticket_id,event_id,kind,payload) VALUES($1,$2,'TICKET_CHANGED',$3)`,
    [t.id,event,JSON.stringify({ticketId:t.id,eventId:event})]);
}

// The caller holds the ticket lock. A policy snapshot remains stable until an explicit transfer.
export async function ensureTriage(client:PoolClient,ticketId:string,reason:string,actor='system:scheduler'):Promise<boolean>{
  const t=(await client.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE',[ticketId])).rows[0];
  if(!t||!eligible(t))return false;
  const old=(await client.query('SELECT * FROM ticket_triage_responsibilities WHERE ticket_id=$1 FOR UPDATE',[ticketId])).rows[0];
  if(old&&old.stage!=='COMPLETED')return true;
  const policy=(await client.query('SELECT * FROM triage_policy_versions ORDER BY version DESC LIMIT 1')).rows[0];
  if(!policy?.enabled)return false;
  const primary=await active(client,policy.primary_employee_id),backup=await active(client,policy.backup_employee_id);
  const stage=primary?'PRIMARY':backup?'BACKUP':'ESCALATED',coordinator=primary?policy.primary_employee_id:backup?policy.backup_employee_id:null;
  const r=(await client.query(`INSERT INTO ticket_triage_responsibilities
    (ticket_id,policy_version,primary_employee_id,backup_employee_id,reminder_minutes,coordinator_id,stage,reason,due_at)
    VALUES($1,$2,$3,$4,$5::integer,$6,$7,$8,CASE WHEN $6::text IS NULL THEN NULL ELSE clock_timestamp()+$5::integer*interval '1 minute' END)
    ON CONFLICT(ticket_id) DO UPDATE SET policy_version=EXCLUDED.policy_version,primary_employee_id=EXCLUDED.primary_employee_id,
      backup_employee_id=EXCLUDED.backup_employee_id,reminder_minutes=EXCLUDED.reminder_minutes,coordinator_id=EXCLUDED.coordinator_id,
      stage=EXCLUDED.stage,reason=EXCLUDED.reason,due_at=EXCLUDED.due_at,generation=ticket_triage_responsibilities.generation+1,
      checked_at=clock_timestamp(),updated_at=clock_timestamp() RETURNING *`,
    [ticketId,policy.version,policy.primary_employee_id,policy.backup_employee_id,policy.reminder_minutes,coordinator,stage,reason])).rows[0];
  await client.query('UPDATE tickets SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[ticketId]);
  await record(client,t,r,stage==='PRIMARY'?'TRIAGE_ASSIGNED':stage==='BACKUP'?'TRIAGE_TRANSFERRED':'TRIAGE_ESCALATED',actor,old);
  return true;
}

export async function completeTriage(client:PoolClient,ticketId:string,actor='system:scheduler'){
  const previous=(await client.query('SELECT * FROM ticket_triage_responsibilities WHERE ticket_id=$1 FOR UPDATE',[ticketId])).rows[0];
  const r=(await client.query(`UPDATE ticket_triage_responsibilities SET stage='COMPLETED',coordinator_id=NULL,due_at=NULL,
    generation=generation+1,updated_at=clock_timestamp() WHERE ticket_id=$1 AND stage<>'COMPLETED' RETURNING *`,[ticketId])).rows[0];
  if(r){const t=(await client.query('SELECT * FROM tickets WHERE id=$1',[ticketId])).rows[0];await record(client,t,r,'TRIAGE_COMPLETED',actor,previous);}
}

export async function maintainTriage(db:Pick<Pool,'query'|'connect'>){
  const candidates=await db.query(`SELECT ticket_id FROM ticket_triage_responsibilities WHERE stage<>'COMPLETED'
    ORDER BY checked_at,ticket_id LIMIT 100`);
  for(const {ticket_id} of candidates.rows){
    const c=await db.connect();
    try{
      await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock_shared(71820512)');
      const t=(await c.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE SKIP LOCKED',[ticket_id])).rows[0];
      if(t){
        if(!eligible(t))await completeTriage(c,t.id);
        else{
          const r=(await c.query(`SELECT *,clock_timestamp() AS clock FROM ticket_triage_responsibilities WHERE ticket_id=$1 FOR UPDATE`,[t.id])).rows[0];
          await c.query('UPDATE ticket_triage_responsibilities SET checked_at=clock_timestamp() WHERE ticket_id=$1',[t.id]);
          if(r.stage!=='ESCALATED'&&(!await active(c,r.coordinator_id)||r.due_at<=r.clock)){
            const backup=r.stage==='PRIMARY'&&await active(c,r.backup_employee_id)?r.backup_employee_id:null;
            const next=(await c.query(`UPDATE ticket_triage_responsibilities SET coordinator_id=$2,stage=$3,
              due_at=CASE WHEN $2::text IS NULL THEN NULL ELSE clock_timestamp()+reminder_minutes*interval '1 minute' END,
              generation=generation+1,updated_at=clock_timestamp() WHERE ticket_id=$1 RETURNING *`,
              [t.id,backup,backup?'BACKUP':'ESCALATED'])).rows[0];
            await c.query('UPDATE tickets SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[t.id]);
            await record(c,t,next,backup?'TRIAGE_TRANSFERRED':'TRIAGE_ESCALATED','system:scheduler',r);
          }
        }
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
}
