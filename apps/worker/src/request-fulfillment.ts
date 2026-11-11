import { type Pool, type PoolClient } from 'pg';
import { bounded, localBlock, matches, type RequestApprovalProvider } from './request-approval.js';

type Task = {id:string; approval_id:string; ticket_id:string; assignee_id:string; state:string;
  ready_until:Date; access_expires_at:Date|null; reviewed_at:Date|null};
const evidence = (value:string) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$/.test(value);

async function transaction<T>(db:Pool, fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await db.connect();
  try {await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result;}
  catch(error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
}
async function event(client:PoolClient,task:Task,action:string,to:string,actor:string|null=null,ref:string|null=null,reason:string|null=null) {
  await client.query(`INSERT INTO request_fulfillment_events(fulfillment_id,actor_id,action,from_state,to_state,evidence_reference,reason_code)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,[task.id,actor,action,task.state,to,ref,reason]);
}
async function locked(client:PoolClient,approvalId:string) {
  const approval=(await client.query('SELECT *,now() AS clock FROM request_approvals WHERE id=$1 FOR UPDATE',[approvalId])).rows[0];
  if (!approval) throw new Error('APPROVAL_NOT_FOUND');
  const task=(await client.query<Task>('SELECT * FROM request_fulfillments WHERE approval_id=$1 FOR UPDATE',[approvalId])).rows[0];
  return {approval,task};
}
async function operator(client:PoolClient,id:string,group:string,approval:any,delivery:boolean) {
  const eligible=await client.query(`SELECT e.id FROM employees e JOIN group_memberships m ON m.employee_id=e.id
    WHERE e.id=$1 AND e.active AND m.group_id=$2 FOR SHARE OF e,m`,[id,group]);
  if (!eligible.rowCount || (delivery && [approval.snapshot.applicant,...approval.snapshot.approvers]
    .some((person:{employeeId:string})=>person.employeeId===id))) throw new Error('FULFILLMENT_OPERATOR_DENIED');
}
async function authorized(client:PoolClient,approval:any,providerResult:any) {
  if (approval.state !== 'APPROVED' || !approval.last_verified_at || approval.lease_token || approval.expires_at <= approval.clock)
    throw new Error('FULFILLMENT_APPROVAL_UNAVAILABLE');
  if (providerResult.state !== 'APPROVED' || !matches(approval,providerResult)) throw new Error('FULFILLMENT_PROVIDER_NOT_APPROVED');
  const block=await localBlock(client,approval);
  if (block) throw new Error(block);
  const ticket=(await client.query('SELECT * FROM tickets WHERE id=$1 FOR SHARE',[approval.ticket_id])).rows[0];
  return ticket;
}
async function inspect(db:Pool,provider:RequestApprovalProvider,approvalId:string) {
  const row=(await db.query('SELECT provider_instance_id FROM request_approvals WHERE id=$1',[approvalId])).rows[0];
  if (!row?.provider_instance_id) throw new Error('FULFILLMENT_APPROVAL_UNAVAILABLE');
  return bounded(signal=>provider.inspect(row.provider_instance_id,signal));
}

// Internal only: no employee route or real downstream grant is exposed by this module.
export async function prepareRequestFulfillment(db:Pool,provider:RequestApprovalProvider,approvalId:string,assigneeId:string):Promise<string> {
  const observed=await inspect(db,provider,approvalId);
  return transaction(db,async client=>{
    const {approval,task}=await locked(client,approvalId);
    const ticket=await authorized(client,approval,observed);
    await operator(client,assigneeId,ticket.owner_group_id,approval,true);
    if (task) {
      if (task.assignee_id !== assigneeId || task.state !== 'READY') throw new Error('FULFILLMENT_ALREADY_EXISTS');
      return task.id;
    }
    const inserted=(await client.query<Task>(`INSERT INTO request_fulfillments(approval_id,ticket_id,assignee_id,ready_until)
      VALUES ($1,$2,$3,$4) RETURNING *`,[approvalId,approval.ticket_id,assigneeId,approval.expires_at])).rows[0];
    await event(client,inserted,'TASK_PREPARED','READY',assigneeId);
    return inserted.id;
  });
}

// Called only after an operator has performed the manual grant in the target system.
// A reference to the external change record is required; never store credentials as evidence.
export async function recordRequestDelivery(db:Pool,provider:RequestApprovalProvider,approvalId:string,actorId:string,reference:string):Promise<void> {
  if (!evidence(reference)) throw new Error('FULFILLMENT_EVIDENCE_REQUIRED');
  const observed=await inspect(db,provider,approvalId);
  await transaction(db,async client=>{
    const {approval,task}=await locked(client,approvalId);
    if (!task || task.state !== 'READY' || task.assignee_id !== actorId || task.ready_until <= approval.clock)
      throw new Error('FULFILLMENT_NOT_READY');
    const ticket=await authorized(client,approval,observed);
    await operator(client,actorId,ticket.owner_group_id,approval,true);
    await client.query(`UPDATE request_fulfillments SET state='DELIVERED',delivered_at=now(),
      access_expires_at=now()+($2::integer * interval '1 day'),updated_at=now() WHERE id=$1`,
      [task.id,approval.snapshot.requestedValidityDays]);
    await event(client,task,'DELIVERY_RECORDED','DELIVERED',actorId,reference);
  });
}

// A second operator checks the actual downstream grant; approval and delivery evidence alone are not a review.
export async function reviewRequestDelivery(db:Pool,approvalId:string,reviewerId:string,reference:string):Promise<void> {
  if (!evidence(reference)) throw new Error('FULFILLMENT_EVIDENCE_REQUIRED');
  await transaction(db,async client=>{
    const {approval,task}=await locked(client,approvalId);
    if (!task || !['DELIVERED','REVOKE_DUE'].includes(task.state) || task.reviewed_at)
      throw new Error('FULFILLMENT_REVIEW_UNAVAILABLE');
    if (reviewerId === task.assignee_id) throw new Error('FULFILLMENT_OPERATOR_DENIED');
    const ticket=(await client.query('SELECT owner_group_id FROM tickets WHERE id=$1 FOR SHARE',[approval.ticket_id])).rows[0];
    await operator(client,reviewerId,ticket.owner_group_id,approval,true);
    await client.query('UPDATE request_fulfillments SET reviewed_at=now(),reviewed_by=$2,updated_at=now() WHERE id=$1',
      [task.id,reviewerId]);
    await event(client,task,'DELIVERY_REVIEWED',task.state,reviewerId,reference);
  });
}

// Callback hints, withdrawal, termination and time limits all create a human revocation obligation.
export async function maintainRequestFulfillments(db:Pool):Promise<void> {
  const ids=(await db.query(`SELECT approval_id FROM request_fulfillments WHERE state IN ('READY','DELIVERED')
    ORDER BY updated_at,id LIMIT 100`)).rows.map(row=>row.approval_id as string);
  for (const id of ids) await transaction(db,async client=>{
    const {approval,task}=await locked(client,id);
    if (!task || !['READY','DELIVERED'].includes(task.state)) return;
    const block=await localBlock(client,approval);
    const reason=block || (approval.state !== 'APPROVED' || !approval.last_verified_at ? 'APPROVAL_NO_LONGER_VERIFIED' : null)
      || (task.state === 'READY' && task.ready_until <= approval.clock ? 'DELIVERY_WINDOW_EXPIRED' : null)
      || (task.state === 'DELIVERED' && task.access_expires_at! <= approval.clock ? 'ACCESS_TERM_EXPIRED' : null);
    if (!reason) {
      // Advance healthy rows so later tasks are not starved by the 100-row batch limit.
      await client.query('UPDATE request_fulfillments SET updated_at=now() WHERE id=$1',[task.id]);
      return;
    }
    const state=task.state === 'READY' ? 'BLOCKED' : 'REVOKE_DUE';
    await client.query('UPDATE request_fulfillments SET state=$2,reason_code=$3,updated_at=now() WHERE id=$1',[task.id,state,reason]);
    await event(client,task,state === 'BLOCKED' ? 'TASK_BLOCKED' : 'REVOCATION_REQUIRED',state,null,null,reason);
  });
}

export async function recordRequestRevocation(db:Pool,approvalId:string,actorId:string,reference:string):Promise<void> {
  if (!evidence(reference)) throw new Error('FULFILLMENT_EVIDENCE_REQUIRED');
  await transaction(db,async client=>{
    const {approval,task}=await locked(client,approvalId);
    if (!task || !['DELIVERED','REVOKE_DUE'].includes(task.state)) throw new Error('FULFILLMENT_NOT_DELIVERED');
    const ticket=(await client.query('SELECT owner_group_id FROM tickets WHERE id=$1 FOR SHARE',[approval.ticket_id])).rows[0];
    await operator(client,actorId,ticket.owner_group_id,approval,false);
    await client.query("UPDATE request_fulfillments SET state='REVOKED',revoked_at=now(),updated_at=now() WHERE id=$1",[task.id]);
    await event(client,task,'REVOCATION_RECORDED','REVOKED',actorId,reference);
  });
}
