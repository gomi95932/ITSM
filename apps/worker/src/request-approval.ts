import { randomUUID } from 'node:crypto';
import { type Pool, type PoolClient } from 'pg';
import { serviceMinutes } from '@itsm/contracts';
import { type ApprovalSnapshot } from '@itsm/workflow';
export { enqueueRequestApproval, type ApprovalSnapshot } from '@itsm/workflow';

type Person = { employeeId: string; dingUserId: string };
type State = 'QUEUED' | 'CREATING' | 'CREATE_UNCERTAIN' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' | 'BLOCKED';
type Approval = { id: string; ticket_id: string; corp_id: string; snapshot: ApprovalSnapshot; expires_at: Date;
  state: State; provider_instance_id: string | null; attempts: number; lease_token: string | null; clock: Date; last_error: string | null };
export type ApprovalObservation = {
  instanceId: string; corpId: string; templateId: string; applicantDingUserId: string;
  approverDingUserIds: string[]; state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  requestBinding: {
    reference: string; serviceCode: string; formVersion: number; requestedValidityDays: number;
    request: ApprovalSnapshot['request'];
  };
};
// A real adapter must establish these bindings from authoritative provider data.
// Never fill requestBinding from the local ledger when the remote form omits it.
// Reference lookup is optional: an absent result never authorizes another create call.
export type RequestApprovalProvider = {
  create(input: { reference: string; corpId: string; snapshot: ApprovalSnapshot }, signal: AbortSignal): Promise<{ instanceId: string }>;
  inspect(instanceId: string, signal: AbortSignal): Promise<ApprovalObservation>;
  recoverCreated?(reference: string, snapshot: ApprovalSnapshot, signal: AbortSignal): Promise<{ instanceId: string } | null>;
};
const activeStates = ['QUEUED','CREATING','CREATE_UNCERTAIN','PENDING','APPROVED'];
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  : JSON.stringify(value) ?? 'null';

async function transaction<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function event(client: PoolClient, row: Approval, action: string, state: State, reason: string | null = null) {
  await client.query(`INSERT INTO request_approval_events(approval_id,action,from_state,to_state,reason_code) VALUES ($1,$2,$3,$4,$5)`,
    [row.id,action,row.state,state,reason]);
}
async function person(client: PoolClient, id: string, corp: string): Promise<Person> {
  const result = await client.query(`SELECT e.id,l.ding_user_id FROM employees e JOIN identity_links l ON l.employee_id=e.id
    WHERE e.id=$1 AND e.active AND l.corp_id=$2 FOR SHARE OF e,l`,[id,corp]);
  if (!result.rowCount) throw new Error('APPROVAL_IDENTITY_UNAVAILABLE');
  return {employeeId:result.rows[0].id,dingUserId:result.rows[0].ding_user_id};
}

export function approvalStageAllowed(status:string|undefined,previouslyApproved:boolean):boolean {
  return status==='WAITING_APPROVAL'||previouslyApproved&&['IN_PROGRESS','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION','CLOSED'].includes(status??'');
}

export async function localBlock(client: PoolClient, row: Approval): Promise<string | null> {
  const previouslyApproved=row.state==='APPROVED'||!!(await client.query(`SELECT 1 FROM request_approval_events
    WHERE approval_id=$1 AND action='APPROVAL_RECONCILED' AND to_state='APPROVED' LIMIT 1`,[row.id])).rowCount;
  // The approval deadline does not shorten an already approved access term.
  if (!previouslyApproved && row.expires_at <= row.clock) return 'APPROVAL_EXPIRED';
  const ticket = (await client.query('SELECT * FROM tickets WHERE id=$1 FOR SHARE',[row.ticket_id])).rows[0];
  if (!approvalStageAllowed(ticket?.status,previouslyApproved)) return 'TICKET_NOT_AWAITING_APPROVAL';
  if (ticket.requester_id !== row.snapshot.applicant.employeeId || ticket.service_code !== row.snapshot.serviceCode
    || ticket.service_type !== 'REQ' || ticket.form_version !== row.snapshot.formVersion
    || canonical(ticket.catalog_snapshot) !== canonical(row.snapshot.catalog)
    || canonical({subject:ticket.subject,description:ticket.description,fields:ticket.fields}) !== canonical(row.snapshot.request))
    return 'APPROVAL_REQUEST_CHANGED';
  if (row.snapshot.submittedById !== undefined && (ticket.submitted_by_id !== row.snapshot.submittedById
    || (ticket.delegation_id ?? null) !== (row.snapshot.delegationId ?? null))) return 'APPROVAL_REQUEST_CHANGED';
  for (const expected of [row.snapshot.applicant,...row.snapshot.approvers]) {
    try {
      const current = await person(client,expected.employeeId,row.corp_id);
      if (current.dingUserId !== expected.dingUserId) return 'APPROVAL_IDENTITY_CHANGED';
    } catch (error) {
      if (error instanceof Error && error.message === 'APPROVAL_IDENTITY_UNAVAILABLE') return 'APPROVAL_PERSON_UNAVAILABLE';
      throw error;
    }
  }
  const expected = row.snapshot.managerMapping;
  if (expected) {
    const mapping = (await client.query(`SELECT m.* FROM request_manager_mappings m JOIN employees v ON v.id=m.verified_by
      WHERE m.employee_id=$1 AND m.review_before>now() AND v.active FOR SHARE OF m,v`,[row.snapshot.applicant.employeeId])).rows[0];
    if (!mapping || canonical({managerId:mapping.manager_id,sourceReference:mapping.source_reference,
      verifiedAt:mapping.verified_at.toISOString(),reviewBefore:mapping.review_before.toISOString()}) !== canonical(expected)) return 'APPROVAL_MANAGER_CHANGED';
  }
  return null;
}

async function projectApproval(client:PoolClient,row:Approval,state:State) {
  if(!['APPROVED','REJECTED'].includes(state))return;
  const ticket=(await client.query("SELECT * FROM tickets WHERE id=$1 AND service_type='REQ' FOR UPDATE",[row.ticket_id])).rows[0];
  if(ticket?.status!=='WAITING_APPROVAL')return;
  const next=state==='APPROVED'?'IN_PROGRESS':'REJECTED',action=state==='APPROVED'?'REQUEST_APPROVED':'REQUEST_REJECTED';
  const updated=(await client.query(`UPDATE tickets SET status=$2,version=version+1,updated_at=clock_timestamp(),
    pending_group_id=NULL,pending_assignee_id=NULL,assignment_kind=NULL,
    assignment_state=CASE WHEN pending_assignee_id IS NOT NULL THEN 'CANCELLED' ELSE assignment_state END,
    assignment_offered_at=NULL,assignment_due_at=NULL,assignment_policy_version_id=NULL WHERE id=$1 RETURNING version`,[ticket.id,next])).rows[0];
  const cycle=(await client.query(`SELECT *,clock_timestamp() AS clock FROM sla_cycles WHERE ticket_id=$1
    ORDER BY cycle DESC LIMIT 1 FOR UPDATE`,[ticket.id])).rows[0];
  if(cycle&&!cycle.completed_at){
    if(cycle.paused_at&&cycle.pause_reason==='APPROVAL'){
      const minutes=serviceMinutes(cycle.paused_at,cycle.clock,cycle.calendar_snapshot,cycle.priority==='P1');
      await client.query(`UPDATE sla_cycles SET paused_at=NULL,pause_reason=NULL,paused_minutes=paused_minutes+$3
        WHERE ticket_id=$1 AND cycle=$2`,[ticket.id,cycle.cycle,minutes]);
    }
    if(state==='REJECTED')await client.query('UPDATE sla_cycles SET completed_at=clock_timestamp() WHERE ticket_id=$1 AND cycle=$2',[ticket.id,cycle.cycle]);
  }
  const eventId=randomUUID(),requestId=randomUUID();
  const detail={reason:state==='APPROVED'?'审批已通过，等待工程师接单与交付':'申请未获审批通过'};
  await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id)
    VALUES($1,$2,'system:approval',$3,$4,$5,$6,$7)`,[eventId,ticket.id,action,ticket.status,next,JSON.stringify(detail),requestId]);
  await client.query(`INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value)
    VALUES($1,$2,'system:approval',$3,$4,$5,$6)`,[ticket.id,eventId,requestId,action,
    JSON.stringify({status:ticket.status,version:ticket.version}),JSON.stringify({status:next,version:updated.version})]);
  await client.query(`INSERT INTO outbox_events(ticket_id,event_id,kind,payload) VALUES($1,$2,'TICKET_CHANGED',$3)`,
    [ticket.id,eventId,JSON.stringify({ticketId:ticket.id,eventId})]);
}
async function block(client: PoolClient, row: Approval, reason: string) {
  const state = reason === 'APPROVAL_EXPIRED' ? 'EXPIRED' : 'BLOCKED';
  await client.query(`UPDATE request_approvals SET state=$2,last_error=$3,last_verified_at=NULL,updated_at=now() WHERE id=$1`,[row.id,state,reason]);
  await event(client,row,'APPROVAL_BLOCKED',state,reason);
}

export async function maintainRequestApprovals(db: Pool): Promise<void> {
  await transaction(db,async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const rows = await client.query<Approval>(`SELECT *,now() AS clock FROM request_approvals WHERE state=ANY($1::text[])
      ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`,[activeStates]);
    for (const row of rows.rows) {
      const reason = await localBlock(client,row);
      if (reason) await block(client,row,reason);
      else await client.query('UPDATE request_approvals SET updated_at=now() WHERE id=$1',[row.id]);
    }
  });
}

// The caller must first authenticate/decrypt the callback, check freshness and derive the stable event ID.
// A callback is only a wake-up hint. Its claimed outcome is deliberately not an input.
export async function queueVerifiedApprovalHint(client: PoolClient, input: { corpId: string; instanceId: string; eventId: string }): Promise<boolean> {
  if (![input.corpId,input.instanceId,input.eventId].every(identifier)) throw new Error('INVALID_APPROVAL_HINT');
  const found = await client.query<Approval>('SELECT * FROM request_approvals WHERE corp_id=$1 AND provider_instance_id=$2 FOR UPDATE',[input.corpId,input.instanceId]);
  const row = found.rows[0]; if (!row) return false;
  const inserted = await client.query(`INSERT INTO request_approval_hints(corp_id,event_id,approval_id) VALUES ($1,$2,$3)
    ON CONFLICT DO NOTHING RETURNING event_id`,[input.corpId,input.eventId,row.id]);
  if (!inserted.rowCount) return false;
  if (!activeStates.includes(row.state)) {
    await event(client,row,'VERIFIED_CALLBACK_HINT',row.state);
    return true;
  }
  // A newer hint fences in-flight observations and revokes approval evidence until reinspection.
  const state = row.state === 'APPROVED' ? 'PENDING' : row.state;
  await client.query(`UPDATE request_approvals SET next_at=now(),state=$2,last_verified_at=NULL,
    lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,[row.id,state]);
  await event(client,row,'VERIFIED_CALLBACK_HINT',state);
  return true;
}

export async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(controller.signal),new Promise<never>((_,reject) => {
      timeout = setTimeout(() => {controller.abort(); reject(new Error('APPROVAL_PROVIDER_TIMEOUT'));},10000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}
export function matches(row: Approval, observed: ApprovalObservation): boolean {
  return !!observed && observed.instanceId === row.provider_instance_id && observed.corpId === row.corp_id
    && observed.templateId === row.snapshot.templateId && observed.applicantDingUserId === row.snapshot.applicant.dingUserId
    && Array.isArray(observed.approverDingUserIds)
    && canonical(observed.approverDingUserIds) === canonical(row.snapshot.approvers.map(item => item.dingUserId))
    && canonical(observed.requestBinding) === canonical({reference:row.id,serviceCode:row.snapshot.serviceCode,
      formVersion:row.snapshot.formVersion,requestedValidityDays:row.snapshot.requestedValidityDays,request:row.snapshot.request})
    && ['PENDING','APPROVED','REJECTED','WITHDRAWN'].includes(observed.state);
}

export async function processNextRequestApproval(db: Pool, provider: RequestApprovalProvider): Promise<boolean> {
  const claimed = await transaction(db,async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const row = (await client.query<Approval>(`SELECT *,now() AS clock FROM request_approvals WHERE state=ANY($1::text[])
      AND next_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[activeStates])).rows[0];
    if (!row) return null;
    const reason = await localBlock(client,row);
    if (reason) {await block(client,row,reason); return null;}
    const state = row.state === 'QUEUED' ? 'CREATING' : row.state === 'CREATING' ? 'CREATE_UNCERTAIN' : row.state;
    const token = randomUUID();
    await client.query(`UPDATE request_approvals SET state=$2,lease_token=$3,lease_until=now()+interval '60 seconds',
      attempts=attempts+1,creation_attempts=creation_attempts+CASE WHEN state='QUEUED' THEN 1 ELSE 0 END,
      next_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1`,[row.id,state,token]);
    if (state !== row.state) await event(client,row,state === 'CREATING' ? 'CREATE_DISPATCHED' : 'CREATE_LEASE_LOST',state);
    return {...row,state:state as State,lease_token:token,attempts:row.attempts+1};
  });
  if (!claimed) return false;
  let instanceId: string | undefined;
  let observed: ApprovalObservation | undefined;
  let failed = false;
  try {
    if (claimed.state === 'CREATING') {
      instanceId = (await bounded(signal => provider.create({reference:claimed.id,corpId:claimed.corp_id,snapshot:claimed.snapshot},signal))).instanceId;
      if (!identifier(instanceId)) throw new Error('INVALID_PROVIDER_INSTANCE');
    } else if (claimed.state === 'CREATE_UNCERTAIN') {
      instanceId = (await bounded(signal => provider.recoverCreated?.(claimed.id,claimed.snapshot,signal) ?? Promise.resolve(null)))?.instanceId;
      if (instanceId !== undefined && !identifier(instanceId)) throw new Error('INVALID_PROVIDER_INSTANCE');
    } else observed = await bounded(signal => provider.inspect(claimed.provider_instance_id!,signal));
  } catch { failed = true; }
  await transaction(db,async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const row = (await client.query<Approval>('SELECT *,now() AS clock FROM request_approvals WHERE id=$1 FOR UPDATE',[claimed.id])).rows[0];
    if (!row || row.lease_token !== claimed.lease_token) return;
    if (instanceId && !failed && !row.provider_instance_id) {
      await client.query('UPDATE request_approvals SET provider_instance_id=$2,updated_at=clock_timestamp() WHERE id=$1',[row.id,instanceId]);
      row.provider_instance_id = instanceId;
      if (row.last_error==='REQUEST_CANCELLED') await event(client,row,'CREATE_RECEIPT_AFTER_CANCELLATION',row.state,'REQUEST_CANCELLED');
    }
    const reason = activeStates.includes(row.state) ? await localBlock(client,row) : null;
    if (reason) await block(client,row,reason);
    else if (activeStates.includes(row.state)) {
      let state: State; let error: string | null = null;
      if (failed) {state = row.provider_instance_id ? 'PENDING' : 'CREATE_UNCERTAIN'; error = 'PROVIDER_UNAVAILABLE';}
      else if (!row.provider_instance_id) {state = row.attempts >= 10 ? 'BLOCKED' : 'CREATE_UNCERTAIN'; error = 'CREATE_UNRESOLVED';}
      else if (!observed) state = 'PENDING';
      else if (!matches(row,observed)) {state = 'BLOCKED'; error = 'PROVIDER_BINDING_MISMATCH';}
      else if (observed.state === 'PENDING' && (await client.query(`SELECT 1 FROM request_approval_events
        WHERE approval_id=$1 AND action='APPROVAL_RECONCILED' AND to_state='APPROVED' LIMIT 1`,[row.id])).rowCount) {
        state = 'BLOCKED'; error = 'PROVIDER_STATE_REGRESSION';
      }
      else state = observed.state;
      await client.query(`UPDATE request_approvals SET state=$2,last_error=$3,last_verified_at=CASE WHEN $4 THEN now() ELSE NULL END,
        next_at=CASE WHEN $5 THEN now() ELSE now()+interval '30 seconds' END,updated_at=now() WHERE id=$1`,
        [row.id,state,error,!!observed && !error,!!instanceId && !observed]);
      await event(client,row,'APPROVAL_RECONCILED',state,error);
      if(!error)await projectApproval(client,row,state);
    }
    await client.query('UPDATE request_approvals SET lease_token=NULL,lease_until=NULL WHERE id=$1',[row.id]);
  });
  return true;
}
