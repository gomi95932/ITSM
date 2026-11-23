import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

type Snapshot={serviceCode:string;policyVersion:number;primaryMinutes:number;backupMinutes:number;positionId:string|null;groupId:string};
type Run={id:string;state:string;snapshot:Snapshot};
const terminal=(status:string)=>['CLOSED','CANCELLED','REJECTED','PENDING_CONFIRMATION'].includes(status);

async function record(client:PoolClient,row:any,action:string,detail:object,previous:any=row){
  const eventId=randomUUID(),requestId=randomUUID(),actor='system:scheduler';
  const ownership=(value:any)=>({status:value.status,version:value.version,ownerGroupId:value.owner_group_id,
    assigneeId:value.assignee_id,pendingAssigneeId:value.pending_assignee_id,assignmentState:value.assignment_state,
    assignmentDueAt:value.assignment_due_at});
  await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[eventId,row.id,actor,action,previous.status,row.status,JSON.stringify(detail),requestId]);
  await client.query(`INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[row.id,eventId,actor,requestId,action,JSON.stringify(ownership(previous)),JSON.stringify(ownership(row))]);
  await client.query(`INSERT INTO outbox_events(ticket_id,event_id,kind,payload) VALUES($1,$2,'TICKET_CHANGED',$3)`,
    [row.id,eventId,JSON.stringify({ticketId:row.id,eventId})]);
}

async function finish(client:PoolClient,run:Run,state:string,attemptState:string){
  await client.query('UPDATE automatic_dispatch_runs SET state=$2,checked_at=clock_timestamp() WHERE id=$1',[run.id,state]);
  await client.query(`UPDATE automatic_dispatch_attempts SET state=$2,finished_at=clock_timestamp()
    WHERE run_id=$1 AND state='PENDING'`,[run.id,attemptState]);
}

// Caller holds the ticket lock and the shared authorization lock. All changes commit with the business action.
export async function initializeAutomaticDispatch(client:PoolClient,ticketId:string):Promise<void>{
  const row=(await client.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE',[ticketId])).rows[0];
  if(!row||terminal(row.status)||row.assignee_id||row.pending_assignee_id)return;
  const policy=(await client.query(`SELECT * FROM automatic_dispatch_policies WHERE service_code=$1
    ORDER BY version DESC LIMIT 1`,[row.service_code])).rows[0];
  if(!policy?.enabled)return;
  const snapshot:Snapshot={serviceCode:row.service_code,policyVersion:policy.version,primaryMinutes:policy.primary_minutes,
    backupMinutes:policy.backup_minutes,positionId:row.service_routing_snapshot?.primaryPositionId??null,groupId:row.owner_group_id};
  await client.query(`INSERT INTO automatic_dispatch_runs(ticket_id,snapshot,state) VALUES($1,$2,'WAITING')
    ON CONFLICT(ticket_id) DO NOTHING`,[ticketId,JSON.stringify(snapshot)]);
  await advanceAutomaticDispatch(client,ticketId);
}

export async function automaticDispatchAction(client:PoolClient,ticketId:string,action:string):Promise<void>{
  const run=(await client.query<Run>('SELECT * FROM automatic_dispatch_runs WHERE ticket_id=$1 FOR UPDATE',[ticketId])).rows[0];
  if(!run||!['WAITING','OFFERED','ESCALATED'].includes(run.state))return;
  if(action==='DECLINE_OFFER'&&run.state==='OFFERED'){
    await client.query(`UPDATE automatic_dispatch_attempts SET state='DECLINED',finished_at=clock_timestamp()
      WHERE run_id=$1 AND state='PENDING'`,[run.id]);
    await advanceAutomaticDispatch(client,ticketId);
  }else if(['ACCEPT','ACCEPT_OFFER','FORCE_TAKEOVER'].includes(action)){
    await finish(client,run,'ACCEPTED',action==='ACCEPT_OFFER'?'ACCEPTED':'CANCELLED');
    await client.query(`UPDATE ticket_routing_alerts SET resolved_at=clock_timestamp() WHERE ticket_id=$1
      AND reason='AUTO_DISPATCH_EXHAUSTED' AND resolved_at IS NULL`,[ticketId]);
  }else if(['ASSIGN_OFFER','CANCEL_OFFER','REASSIGN','INITIATE_HANDOVER','CLASSIFICATION_CORRECTED','CANCEL','CONFIRM','RESOLVE'].includes(action)){
    await finish(client,run,['CANCEL','CONFIRM','RESOLVE'].includes(action)?'STOPPED':'MANUAL','CANCELLED');
    await client.query(`UPDATE ticket_routing_alerts SET resolved_at=clock_timestamp() WHERE ticket_id=$1
      AND reason='AUTO_DISPATCH_EXHAUSTED' AND resolved_at IS NULL`,[ticketId]);
  }
}

// Ticket -> run lock order is shared by the API and every scheduler. A candidate is offered at most once per run.
export async function advanceAutomaticDispatch(client:PoolClient,ticketId:string):Promise<boolean>{
  let row=(await client.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE',[ticketId])).rows[0];
  const run=(await client.query<Run>('SELECT * FROM automatic_dispatch_runs WHERE ticket_id=$1 FOR UPDATE',[ticketId])).rows[0];
  if(!row||!run||!['WAITING','OFFERED','ESCALATED'].includes(run.state))return false;
  await client.query('UPDATE automatic_dispatch_runs SET checked_at=clock_timestamp() WHERE id=$1',[run.id]);
  if(terminal(row.status)){await finish(client,run,'STOPPED','CANCELLED');return true;}
  if(row.assignee_id){await finish(client,run,'ACCEPTED','ACCEPTED');return false;}
  if(run.state==='ESCALATED')return true;
  if(row.status==='WAITING_APPROVAL')return true;
  if(!['QUEUED','IN_PROGRESS'].includes(row.status)){await finish(client,run,'MANUAL','CANCELLED');return false;}
  if(row.service_code!==run.snapshot.serviceCode||row.owner_group_id!==run.snapshot.groupId
    ||(row.service_routing_snapshot?.primaryPositionId??null)!==run.snapshot.positionId){
    await finish(client,run,'MANUAL','CANCELLED');return false;
  }
  const pending=(await client.query(`SELECT * FROM automatic_dispatch_attempts WHERE run_id=$1 AND state='PENDING'`,[run.id])).rows[0];
  if(row.pending_assignee_id){
    if(!pending||row.assignment_kind!=='OFFER'||row.pending_assignee_id!==pending.employee_id){
      await finish(client,run,'MANUAL','CANCELLED');return false;
    }
    const validity=(await client.query(`SELECT
      service_position_eligible($1,$2,$3) AND EXISTS(SELECT 1 FROM position_appointments a
        JOIN support_positions p ON p.id=a."positionId" JOIN service_domains d ON d.id=p."domainId"
        JOIN support_groups g ON g.id=p."groupId" AND g.enabled
        JOIN employees e ON e.id=a."employeeId" AND e.active
        JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=p."groupId"
        WHERE a."positionId"=$4 AND a."employeeId"=$2 AND a.duty=$5 AND a.enabled AND p.enabled AND d.enabled
          AND p."groupId"=$3 AND a."validFrom"<=clock_timestamp() AND (a."validTo" IS NULL OR a."validTo">clock_timestamp())) AS valid,
      $6::timestamptz<=clock_timestamp() AS expired`,[JSON.stringify(row.service_routing_snapshot),pending.employee_id,
        row.owner_group_id,run.snapshot.positionId,pending.duty,row.assignment_due_at])).rows[0];
    if(validity.valid&&!validity.expired)return true;
    const previous=row,state=validity.valid?'EXPIRED':'INVALIDATED';
    row=(await client.query(`UPDATE tickets SET pending_assignee_id=NULL,pending_group_id=NULL,assignment_kind=NULL,
      assignment_state=$2,assignment_due_at=NULL,assignment_offered_at=NULL,assignment_policy_version_id=NULL,
      version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[ticketId,state])).rows[0];
    await client.query('UPDATE automatic_dispatch_attempts SET state=$2,finished_at=clock_timestamp() WHERE id=$1',[pending.id,state]);
    await record(client,row,state==='EXPIRED'?'ASSIGNMENT_EXPIRED':'OWNERSHIP_RECOVERED',
      {automatic:true,runId:run.id,reason:state==='EXPIRED'?'CANDIDATE_DID_NOT_ACCEPT':'CANDIDATE_NO_LONGER_ELIGIBLE',
        targetAssigneeId:previous.pending_assignee_id,targetGroupId:previous.pending_group_id,assignmentDueAt:previous.assignment_due_at},previous);
  }else if(pending){
    // An unrecognized manual clear must never silently start another invitation.
    await finish(client,run,'MANUAL','CANCELLED');return false;
  }
  const candidate=(await client.query(`SELECT a."employeeId" AS employee_id,a.duty FROM position_appointments a
    JOIN support_positions p ON p.id=a."positionId" JOIN service_domains d ON d.id=p."domainId"
    JOIN support_groups g ON g.id=p."groupId" AND g.enabled JOIN employees e ON e.id=a."employeeId" AND e.active
    JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=g.id
    WHERE a."positionId"=$1 AND p."groupId"=$2 AND a.enabled AND p.enabled AND d.enabled
      AND a.duty IN ('PRIMARY','BACKUP') AND a."validFrom"<=clock_timestamp() AND (a."validTo" IS NULL OR a."validTo">clock_timestamp())
      AND service_position_eligible($3,e.id,g.id)
      AND NOT EXISTS(SELECT 1 FROM automatic_dispatch_attempts v WHERE v.run_id=$4 AND v.employee_id=e.id)
      AND (a.duty='BACKUP' OR NOT EXISTS(SELECT 1 FROM automatic_dispatch_attempts v WHERE v.run_id=$4 AND v.duty='BACKUP'))
    ORDER BY CASE a.duty WHEN 'PRIMARY' THEN 0 ELSE 1 END,a."validFrom",a.id,e.id LIMIT 1`,
    [run.snapshot.positionId,row.owner_group_id,JSON.stringify(row.service_routing_snapshot),run.id])).rows[0];
  if(!candidate){
    await finish(client,run,'ESCALATED','CANCELLED');
    const previous=row;
    row=(await client.query('UPDATE tickets SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',[ticketId])).rows[0];
    await client.query(`INSERT INTO ticket_routing_alerts(ticket_id,reason,owner_group_id)
      VALUES($1,'AUTO_DISPATCH_EXHAUSTED',$2) ON CONFLICT(ticket_id) DO UPDATE SET reason=EXCLUDED.reason,
      owner_group_id=EXCLUDED.owner_group_id,opened_at=clock_timestamp(),last_checked_at=clock_timestamp(),resolved_at=NULL`,[ticketId,row.owner_group_id]);
    await record(client,row,'OWNERSHIP_ESCALATION_REQUIRED',{automatic:true,runId:run.id,
      reason:'AUTO_DISPATCH_EXHAUSTED',ownerGroupId:row.owner_group_id,policyVersion:run.snapshot.policyVersion},previous);
    return true;
  }
  const minutes=candidate.duty==='PRIMARY'?run.snapshot.primaryMinutes:run.snapshot.backupMinutes,previous=row;
  row=(await client.query(`UPDATE tickets SET pending_group_id=owner_group_id,pending_assignee_id=$2,assignment_kind='OFFER',
    assignment_state='PENDING',assignment_offered_at=clock_timestamp(),assignment_due_at=clock_timestamp()+$3*interval '1 minute',
    assignment_policy_version_id=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[ticketId,candidate.employee_id,minutes])).rows[0];
  await client.query(`INSERT INTO automatic_dispatch_attempts(run_id,employee_id,duty,state,offered_at,due_at)
    SELECT $1,$2,$3,'PENDING',assignment_offered_at,assignment_due_at FROM tickets WHERE id=$4`,
    [run.id,candidate.employee_id,candidate.duty,ticketId]);
  await client.query("UPDATE automatic_dispatch_runs SET state='OFFERED' WHERE id=$1",[run.id]);
  await record(client,row,'ASSIGN_OFFER',{automatic:true,runId:run.id,duty:candidate.duty,policyVersion:run.snapshot.policyVersion,
    receiveMinutes:minutes,targetGroupId:row.pending_group_id,targetAssigneeId:row.pending_assignee_id,
    assignmentVersion:row.version,assignmentDueAt:row.assignment_due_at},previous);
  return true;
}

export async function maintainAutomaticDispatch(db:Pick<Pool,'connect'|'query'>):Promise<void>{
  const candidates=await db.query(`SELECT ticket_id FROM automatic_dispatch_runs WHERE state IN ('WAITING','OFFERED')
    ORDER BY checked_at,ticket_id LIMIT 100`);
  for(const {ticket_id} of candidates.rows){
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
      const locked=await client.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE SKIP LOCKED',[ticket_id]);
      if(locked.rowCount)await advanceAutomaticDispatch(client,ticket_id);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}
