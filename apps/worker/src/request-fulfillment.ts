import { type Pool, type PoolClient } from 'pg';
import { bounded, localBlock, matches, type RequestApprovalProvider } from './request-approval.js';

type Task = {id:string; approval_id:string; ticket_id:string; assignee_id:string; state:string;
  ready_until:Date; access_expires_at:Date|null; reviewed_at:Date|null;version:number};
type DeliveryCommand={id:string;approval_id:string;actor_id:string;operation:'PREPARE'|'DELIVER';expected_version:number;evidence_reference:string|null};
const evidence = (value:string) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$/.test(value);

async function transaction<T>(db:Pool, fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await db.connect();
  try {await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result;}
  catch(error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
}
async function event(client:PoolClient,task:Task,action:string,to:string,actor:string|null=null,ref:string|null=null,reason:string|null=null) {
  await client.query(`INSERT INTO request_fulfillment_events(fulfillment_id,actor_id,action,from_state,to_state,evidence_reference,reason_code,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,[task.id,actor,action,task.state,to,ref,reason]);
}
async function locked(client:PoolClient,approvalId:string) {
  await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
  const approval=(await client.query('SELECT * FROM request_approvals WHERE id=$1 FOR UPDATE',[approvalId])).rows[0];
  if (!approval) throw new Error('APPROVAL_NOT_FOUND');
  const task=(await client.query<Task>('SELECT * FROM request_fulfillments WHERE approval_id=$1 FOR UPDATE',[approvalId])).rows[0];
  approval.clock=(await client.query('SELECT clock_timestamp() AS clock')).rows[0].clock;
  return {approval,task};
}
async function operatorEligible(client:PoolClient,approvalId:string,id:string):Promise<boolean> {
  return (await client.query('SELECT request_delivery_operator_eligible($1,$2) AS eligible',[approvalId,id])).rows[0].eligible;
}
async function operator(client:PoolClient,id:string,group:string,approvalId:string) {
  const eligible=await client.query(`SELECT e.id FROM employees e JOIN group_memberships m ON m.employee_id=e.id
    JOIN support_groups g ON g.id=m.group_id AND g.enabled
    WHERE e.id=$1 AND e.active AND m.group_id=$2 FOR SHARE OF e,m,g`,[id,group]);
  if (!eligible.rowCount || !await operatorEligible(client,approvalId,id)) throw new Error('FULFILLMENT_OPERATOR_DENIED');
}
async function deliveryClock(client:PoolClient,approval:any,task?:Task):Promise<Date> {
  const clock:Date=(await client.query('SELECT clock_timestamp() AS clock')).rows[0].clock;
  if (task && task.ready_until<=clock) throw new Error('FULFILLMENT_NOT_READY');
  if (approval.expires_at<=clock) throw new Error('FULFILLMENT_APPROVAL_UNAVAILABLE');
  return clock;
}
async function authorized(client:PoolClient,approval:any,providerResult:any) {
  if (approval.state !== 'APPROVED' || !approval.last_verified_at || approval.lease_token || approval.expires_at <= approval.clock)
    throw new Error('FULFILLMENT_APPROVAL_UNAVAILABLE');
  if (providerResult.state !== 'APPROVED' || !matches(approval,providerResult)) throw new Error('FULFILLMENT_PROVIDER_NOT_APPROVED');
  const block=await localBlock(client,approval);
  if (block) throw new Error(block);
  if((await client.query('SELECT request_delivery_has_unresolved($1) AS blocked',[approval.id])).rows[0].blocked)
    throw new Error('DELIVERY_FAILURE_UNRESOLVED');
  const ticket=(await client.query('SELECT * FROM tickets WHERE id=$1 FOR SHARE',[approval.ticket_id])).rows[0];
  return ticket;
}
async function inspect(db:Pool,provider:RequestApprovalProvider,approvalId:string) {
  const row=(await db.query('SELECT provider_instance_id FROM request_approvals WHERE id=$1',[approvalId])).rows[0];
  if (!row?.provider_instance_id) throw new Error('FULFILLMENT_APPROVAL_UNAVAILABLE');
  return bounded(signal=>provider.inspect(row.provider_instance_id,signal));
}

async function commandGuard(client:PoolClient,command:DeliveryCommand|undefined,approvalId:string,actorId:string,operation:'PREPARE'|'DELIVER'){
  if(!command)return;
  await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
  const current=(await client.query(`SELECT *,expires_at<=clock_timestamp() AS expired FROM request_delivery_commands WHERE id=$1 FOR UPDATE`,[command.id])).rows[0];
  if(!current||current.state!=='PENDING')throw new Error('REQUEST_DELIVERY_COMMAND_FINISHED');
  if(current.approval_id!==approvalId||current.actor_id!==actorId||current.operation!==operation
    ||current.expected_version!==command.expected_version||current.evidence_reference!==command.evidence_reference)
    throw new Error('REQUEST_DELIVERY_COMMAND_MISMATCH');
  if(current.expired)throw new Error('REQUEST_DELIVERY_COMMAND_EXPIRED');
}
async function commandComplete(client:PoolClient,command:DeliveryCommand|undefined,taskId:string){
  if(!command)return;
  if(!(await client.query('SELECT expires_at>clock_timestamp() AS valid FROM request_delivery_commands WHERE id=$1',[command.id])).rows[0].valid)
    throw new Error('REQUEST_DELIVERY_COMMAND_EXPIRED');
  const version=(await client.query('SELECT version FROM request_fulfillments WHERE id=$1',[taskId])).rows[0].version;
  await client.query(`UPDATE request_delivery_commands SET state='SUCCEEDED',result=$2,completed_at=clock_timestamp() WHERE id=$1`,
    [command.id,JSON.stringify({taskId,version})]);
}

// The worker records manual-delivery facts; it never grants downstream access.
export async function prepareRequestFulfillment(db:Pool,provider:RequestApprovalProvider,approvalId:string,assigneeId:string,command?:DeliveryCommand):Promise<string> {
  const observed=await inspect(db,provider,approvalId);
  return transaction(db,async client=>{
    const {approval,task}=await locked(client,approvalId);
    await commandGuard(client,command,approvalId,assigneeId,'PREPARE');
    const ticket=await authorized(client,approval,observed);
    await operator(client,assigneeId,ticket.owner_group_id,approvalId);
    if(command&&(command.expected_version!==0||task))throw new Error('FULFILLMENT_VERSION_CONFLICT');
    if (task && (task.assignee_id !== assigneeId || task.state !== 'READY')) throw new Error('FULFILLMENT_ALREADY_EXISTS');
    const clock=await deliveryClock(client,approval,task);
    if (task) return task.id;
    const inserted=(await client.query<Task>(`INSERT INTO request_fulfillments(approval_id,ticket_id,assignee_id,ready_until,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,[approvalId,approval.ticket_id,assigneeId,approval.expires_at,clock])).rows[0];
    await event(client,inserted,'TASK_PREPARED','READY',assigneeId);
    await commandComplete(client,command,inserted.id);
    return inserted.id;
  });
}

// Called only after an operator has performed the manual grant in the target system.
// A reference to the external change record is required; never store credentials as evidence.
export async function recordRequestDelivery(db:Pool,provider:RequestApprovalProvider,approvalId:string,actorId:string,reference:string,command?:DeliveryCommand):Promise<void> {
  if (!evidence(reference)) throw new Error('FULFILLMENT_EVIDENCE_REQUIRED');
  const observed=await inspect(db,provider,approvalId);
  await transaction(db,async client=>{
    const {approval,task}=await locked(client,approvalId);
    await commandGuard(client,command,approvalId,actorId,'DELIVER');
    if(command&&(!task||task.version!==command.expected_version))throw new Error('FULFILLMENT_VERSION_CONFLICT');
    if (!task || task.state !== 'READY' || task.assignee_id !== actorId || task.ready_until <= approval.clock)
      throw new Error('FULFILLMENT_NOT_READY');
    const ticket=await authorized(client,approval,observed);
    await operator(client,actorId,ticket.owner_group_id,approvalId);
    const clock=await deliveryClock(client,approval,task);
    await client.query(`UPDATE request_fulfillments SET state='DELIVERED',delivered_at=$3,
      access_expires_at=$3::timestamptz+($2::integer * interval '1 day'),updated_at=$3 WHERE id=$1`,
      [task.id,approval.snapshot.requestedValidityDays,clock]);
    await event(client,task,'DELIVERY_RECORDED','DELIVERED',actorId,reference);
    await commandComplete(client,command,task.id);
  });
}

const commandErrors=new Set(['FULFILLMENT_OPERATOR_DENIED','FULFILLMENT_APPROVAL_UNAVAILABLE','FULFILLMENT_PROVIDER_NOT_APPROVED',
  'DELIVERY_FAILURE_UNRESOLVED',
  'FULFILLMENT_NOT_READY','FULFILLMENT_VERSION_CONFLICT','FULFILLMENT_ALREADY_EXISTS','REQUEST_DELIVERY_COMMAND_EXPIRED',
  'TICKET_NOT_AWAITING_APPROVAL','APPROVAL_REQUEST_CHANGED','APPROVAL_IDENTITY_CHANGED','APPROVAL_PERSON_UNAVAILABLE','APPROVAL_MANAGER_CHANGED']);

export async function processNextRequestDelivery(db:Pool,provider:RequestApprovalProvider):Promise<boolean>{
  const command=(await db.query<DeliveryCommand>(`SELECT id,approval_id,actor_id,operation,expected_version,evidence_reference
    FROM request_delivery_commands WHERE state='PENDING' ORDER BY created_at,id LIMIT 1`)).rows[0];
  if(!command)return false;
  try{
    if(command.operation==='PREPARE')await prepareRequestFulfillment(db,provider,command.approval_id,command.actor_id,command);
    else await recordRequestDelivery(db,provider,command.approval_id,command.actor_id,command.evidence_reference!,command);
  }catch(error){
    const message=error instanceof Error?error.message:'';
    if(message!=='REQUEST_DELIVERY_COMMAND_FINISHED')await transaction(db,async client=>{
      const {approval}=await locked(client,command.approval_id);
      const ticket=(await client.query('SELECT id,status FROM tickets WHERE id=$1 FOR SHARE',[approval.ticket_id])).rows[0];
      const rejected=await client.query(`UPDATE request_delivery_commands
        SET state='REJECTED',error_code=$2,completed_at=clock_timestamp() WHERE id=$1 AND state='PENDING' RETURNING id`,
        [command.id,commandErrors.has(message)?message:'DELIVERY_VERIFICATION_FAILED']);
      if(!rejected.rowCount||command.operation!=='DELIVER')return;
      const eventId=(await client.query(`INSERT INTO ticket_events(ticket_id,actor_id,action,from_status,to_status,detail,request_id)
        VALUES($1,$2,'DELIVERY_FAILURE_REQUIRED',$3,$3,$4,gen_random_uuid()) RETURNING id`,
        [ticket.id,command.actor_id,ticket.status,JSON.stringify({commandId:command.id})])).rows[0].id;
      await client.query(`INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value)
        SELECT ticket_id,id,actor_id,request_id,action,$2::jsonb,$3::jsonb FROM ticket_events WHERE id=$1`,
        [eventId,JSON.stringify({commandId:command.id,state:'PENDING'}),JSON.stringify({commandId:command.id,state:'REJECTED'})]);
      await client.query(`INSERT INTO outbox_events(ticket_id,event_id,kind,payload)
        VALUES($1,$2,'TICKET_CHANGED',$3)`,[ticket.id,eventId,JSON.stringify({ticketId:ticket.id,eventId})]);
    });
  }
  return true;
}

// A second operator checks the actual downstream grant; approval and delivery evidence alone are not a review.
export async function reviewRequestDelivery(db:Pool,approvalId:string,reviewerId:string,reference:string):Promise<void> {
  await db.query("SELECT perform_request_fulfillment_action($1,$2,'REVIEW',$3)",[approvalId,reviewerId,reference]);
}

// Callback hints, withdrawal, termination and time limits all create a human revocation obligation.
export async function maintainRequestFulfillments(db:Pool):Promise<void> {
  const ids=(await db.query(`SELECT approval_id FROM request_fulfillments WHERE state IN ('READY','DELIVERED')
    ORDER BY updated_at,id LIMIT 100`)).rows.map(row=>row.approval_id as string);
  for (const id of ids) await transaction(db,async client=>{
    const {approval,task}=await locked(client,id);
    if (!task || !['READY','DELIVERED'].includes(task.state)) return;
    const block=await localBlock(client,approval);
    const operatorLost=task.state==='READY' && !await operatorEligible(client,id,task.assignee_id);
    const clock:Date=(await client.query('SELECT clock_timestamp() AS clock')).rows[0].clock;
    const reason=block || (approval.state !== 'APPROVED' || !approval.last_verified_at ? 'APPROVAL_NO_LONGER_VERIFIED' : null)
      || (operatorLost ? 'DELIVERY_OPERATOR_UNAVAILABLE' : null)
      || (task.state === 'READY' && task.ready_until <= clock ? 'DELIVERY_WINDOW_EXPIRED' : null)
      || (task.state === 'DELIVERED' && task.access_expires_at! <= clock ? 'ACCESS_TERM_EXPIRED' : null);
    if (!reason) {
      // Advance healthy rows so later tasks are not starved by the 100-row batch limit.
      await client.query('UPDATE request_fulfillments SET updated_at=$2 WHERE id=$1',[task.id,clock]);
      return;
    }
    const state=task.state === 'READY' ? 'BLOCKED' : 'REVOKE_DUE';
    await client.query('UPDATE request_fulfillments SET state=$2,reason_code=$3,updated_at=$4 WHERE id=$1',[task.id,state,reason,clock]);
    await event(client,task,state === 'BLOCKED' ? 'TASK_BLOCKED' : 'REVOCATION_REQUIRED',state,null,null,reason);
  });
}

export async function recordRequestRevocation(db:Pool,approvalId:string,actorId:string,reference:string):Promise<void> {
  await db.query("SELECT perform_request_fulfillment_action($1,$2,'REVOKE',$3)",[approvalId,actorId,reference]);
}
