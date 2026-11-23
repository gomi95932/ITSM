import type { Pool,PoolClient } from 'pg';
import { ownershipCandidatesQuery } from './ownership-query.js';
import {advanceAutomaticDispatch} from '@itsm/workflow';

type RecordOwnership=(client:PoolClient,row:any,action:string,detail:object,from:string,to:string,previous?:any)=>Promise<void>;

export async function recoverOwnership(db:Pool,record:RecordOwnership) {
  async function transaction(fn:(client:PoolClient)=>Promise<void>){
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await client.query("SET LOCAL application_name='itsm-worker:ownership'");
      await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
      await fn(client);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  // Select cheaply, then re-read authority inside one transaction per ticket.
  const candidates=await db.query(ownershipCandidatesQuery);
  for(const candidate of candidates.rows)await transaction(async client=>{
    const result=await client.query(`SELECT t.* FROM tickets t WHERE t.id=$1
      AND t.status NOT IN ('CLOSED','CANCELLED','REJECTED') FOR UPDATE OF t SKIP LOCKED`,[candidate.id]);
    const row=result.rows[0];
    if(!row)return;
    await client.query('UPDATE tickets SET ownership_checked_at=clock_timestamp() WHERE id=$1',[row.id]);
    if(await advanceAutomaticDispatch(client,row.id))return;
    const valid = async (employee:string|null,group:string|null) => !employee || !!(await client.query(`SELECT e.id FROM employees e
      JOIN group_memberships m ON m.employee_id=e.id WHERE e.id=$1 AND e.active AND m.group_id=$2 FOR SHARE OF e,m`,[employee,group])).rowCount;
    const groupAvailable = async (group:string) => !!(await client.query(`SELECT e.id FROM employees e
      JOIN group_memberships m ON m.employee_id=e.id WHERE e.active AND m.group_id=$1
      AND service_position_eligible($2,e.id,$1)
      ORDER BY e.id LIMIT 1 FOR SHARE OF e,m`,[group,JSON.stringify(row.service_routing_snapshot)])).rowCount;
    const ownerValid = await valid(row.assignee_id,row.owner_group_id);
    const ownerQualified=!row.assignee_id||(await client.query<{eligible:boolean}>(
      'SELECT ticket_processing_eligible($1,$2) AS eligible',[row.id,row.assignee_id])).rows[0].eligible;
    const targetValid = await valid(row.pending_assignee_id,row.pending_group_id) && (!row.pending_assignee_id ||
      (await client.query('SELECT service_position_eligible($1,$2,$3) AS eligible',
        [JSON.stringify(row.service_routing_snapshot),row.pending_assignee_id,row.pending_group_id])).rows[0].eligible);
    let group = row.owner_group_id as string;
    const available = await groupAvailable(group);
    const mapped=Object.keys(row.service_routing_snapshot).length>0;
    if(row.assignee_id&&ownerValid&&!ownerQualified&&available){
      const alert=await client.query(`INSERT INTO ticket_routing_alerts(ticket_id,reason,owner_group_id)
        VALUES($1,'OWNER_APPOINTMENT_REQUIRED',$2) ON CONFLICT(ticket_id) DO UPDATE SET reason=EXCLUDED.reason,
        owner_group_id=EXCLUDED.owner_group_id,opened_at=CASE WHEN ticket_routing_alerts.resolved_at IS NOT NULL THEN now() ELSE ticket_routing_alerts.opened_at END,
        last_checked_at=now(),resolved_at=NULL WHERE ticket_routing_alerts.resolved_at IS NOT NULL
          OR ticket_routing_alerts.reason<>'OWNER_APPOINTMENT_REQUIRED' RETURNING ticket_id`,[row.id,group]);
      if(alert.rowCount)await record(client,row,'OWNERSHIP_ESCALATION_REQUIRED',
        {reason:'OWNER_APPOINTMENT_REQUIRED',ownerGroupId:group},row.status,row.status);
      await client.query('UPDATE ticket_routing_alerts SET last_checked_at=now() WHERE ticket_id=$1',[row.id]);
    }
    if (!available && mapped) {
      const alert=await client.query(`INSERT INTO ticket_routing_alerts(ticket_id,reason,owner_group_id)
        VALUES($1,'NO_POSITION_COVERAGE',$2) ON CONFLICT(ticket_id) DO UPDATE SET reason='NO_POSITION_COVERAGE',
        owner_group_id=EXCLUDED.owner_group_id,opened_at=CASE WHEN ticket_routing_alerts.resolved_at IS NOT NULL THEN now() ELSE ticket_routing_alerts.opened_at END,
        last_checked_at=now(),resolved_at=NULL
        WHERE ticket_routing_alerts.resolved_at IS NOT NULL OR ticket_routing_alerts.reason<>'NO_POSITION_COVERAGE' RETURNING ticket_id`,[row.id,group]);
      if(alert.rowCount)await record(client,row,'OWNERSHIP_ESCALATION_REQUIRED',{reason:'NO_POSITION_COVERAGE',ownerGroupId:group},row.status,row.status);
      await client.query('UPDATE ticket_routing_alerts SET last_checked_at=now() WHERE ticket_id=$1',[row.id]);
    }
    if (!available && !mapped) {
      const visited = new Set<string>([group]);
      while (true) {
        const next = (await client.query<{ fallback_group_id:string|null }>(
          'SELECT fallback_group_id FROM support_groups WHERE id=$1',[group])).rows[0]?.fallback_group_id;
        if (!next || visited.has(next)) break;
        visited.add(next);
        group = next;
        if (await groupAvailable(group)) break;
      }
      if (!(await groupAvailable(group))) {
        const existing = await client.query<{ resolved_at:Date|null }>(
          'SELECT resolved_at FROM ticket_routing_alerts WHERE ticket_id=$1 FOR UPDATE',[row.id]);
        if (existing.rowCount) await client.query(`UPDATE ticket_routing_alerts SET owner_group_id=$2,
          opened_at=CASE WHEN resolved_at IS NOT NULL THEN now() ELSE opened_at END,
          last_checked_at=now(),resolved_at=NULL WHERE ticket_id=$1`,[row.id,row.owner_group_id]);
        else await client.query(`INSERT INTO ticket_routing_alerts(ticket_id,reason,owner_group_id)
          VALUES ($1,'NO_ACTIVE_FALLBACK',$2)`,[row.id,row.owner_group_id]);
        if (!existing.rowCount || existing.rows[0]?.resolved_at) await record(client,row,'OWNERSHIP_ESCALATION_REQUIRED',{
          reason:'NO_ACTIVE_FALLBACK',ownerGroupId:row.owner_group_id,
        },row.status,row.status);
        group = row.owner_group_id;
      }
    }
    const moved = group !== row.owner_group_id;
    if (!moved && available && ownerQualified) await client.query("UPDATE ticket_routing_alerts SET resolved_at=now() WHERE ticket_id=$1 AND resolved_at IS NULL AND reason<>'AUTO_DISPATCH_EXHAUSTED'",[row.id]);
    if (!moved && ownerValid && targetValid) return;
    const updated = await client.query(`UPDATE tickets SET owner_group_id=$2,assignee_id=$3,pending_group_id=NULL,pending_assignee_id=NULL,
      assignment_kind=NULL,assignment_state=CASE WHEN pending_assignee_id IS NOT NULL THEN 'INVALIDATED' ELSE assignment_state END,
      assignment_due_at=NULL,assignment_offered_at=NULL,assignment_policy_version_id=NULL,
      version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,group,moved ? null : ownerValid ? row.assignee_id : null]);
    await record(client,updated.rows[0],'OWNERSHIP_RECOVERED',{
      reason:moved ? 'OWNER_GROUP_UNAVAILABLE' : ownerValid ? 'HANDOVER_TARGET_UNAVAILABLE' : 'ASSIGNEE_UNAVAILABLE',
      oldOwnerGroupId:row.owner_group_id,oldAssigneeId:row.assignee_id,oldPendingAssigneeId:row.pending_assignee_id,
    },row.status,row.status,row);
    if (moved) await client.query('UPDATE ticket_routing_alerts SET resolved_at=now() WHERE ticket_id=$1 AND resolved_at IS NULL',[row.id]);
  });
  await transaction(async client=>{
    await client.query(`UPDATE ticket_routing_alerts a SET resolved_at=now() FROM tickets t
      WHERE a.ticket_id=t.id AND a.resolved_at IS NULL AND t.status IN ('CLOSED','CANCELLED','REJECTED')`);
    await client.query('DELETE FROM auth_sessions WHERE employee_id IN (SELECT id FROM employees WHERE NOT active)');
  });
}
