import { type PoolClient } from 'pg';

type Person = { employeeId: string; dingUserId: string };
type Approver = Person & { role: string };
export type ApprovalSnapshot = {
  serviceCode: string; formVersion: number; templateId: string; requestedValidityDays: number;
  applicant: Person; approvers: Approver[]; catalog: Record<string, unknown>;
  request: { subject: string; description: string; fields: Record<string, unknown> };
  submittedById?: string; delegationId?: string | null;
  managerMapping?: { managerId: string; sourceReference: string; verifiedAt: string; reviewBefore: string };
};

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  : JSON.stringify(value) ?? 'null';

async function person(client: PoolClient, id: string, corp: string): Promise<Person> {
  const result = await client.query(`SELECT e.id,l.ding_user_id FROM employees e JOIN identity_links l ON l.employee_id=e.id
    WHERE e.id=$1 AND e.active AND l.corp_id=$2 FOR SHARE OF e,l`,[id,corp]);
  if (!result.rowCount) throw new Error('APPROVAL_IDENTITY_UNAVAILABLE');
  return {employeeId:result.rows[0].id,dingUserId:result.rows[0].ding_user_id};
}

// The caller owns the creation transaction. This module is server-only and never calls the OA provider.
export async function enqueueRequestApproval(client: PoolClient, input: {
  ticketId: string; corpId: string; expiresAt: Date; requestedValidityDays: number;
}): Promise<string> {
  if (!identifier(input.corpId) || !(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())
    || !Number.isInteger(input.requestedValidityDays) || input.requestedValidityDays < 1) throw new Error('INVALID_APPROVAL_INTENT');
  const ticket = (await client.query(`SELECT *,now() AS clock FROM tickets WHERE id=$1 FOR UPDATE`,[input.ticketId])).rows[0];
  if (!ticket || ticket.service_type !== 'REQ' || ticket.status !== 'WAITING_APPROVAL') throw new Error('TICKET_NOT_AWAITING_APPROVAL');
  const prior = (await client.query('SELECT * FROM request_approvals WHERE ticket_id=$1',[ticket.id])).rows[0];
  if (prior) {
    if (prior.corp_id !== input.corpId || prior.expires_at.getTime() !== input.expiresAt.getTime()
      || prior.snapshot.requestedValidityDays !== input.requestedValidityDays) throw new Error('APPROVAL_INTENT_CONFLICT');
    return prior.id;
  }
  if (input.expiresAt <= ticket.clock) throw new Error('APPROVAL_ALREADY_EXPIRED');
  const service = (await client.query(`SELECT c.published,c.form_version,v.snapshot FROM service_catalog c
    JOIN request_catalog_versions v ON v.service_code=c.code AND v.form_version=$2 WHERE c.code=$1 FOR SHARE OF c`,
    [ticket.service_code,ticket.form_version])).rows[0];
  const catalog = service?.snapshot;
  if (!service?.published || service.form_version !== ticket.form_version || !catalog?.approval?.steps?.length
    || !identifier(catalog.approval.templateId) || !Number.isInteger(catalog.maxValidityDays)
    || input.requestedValidityDays > catalog.maxValidityDays || canonical(ticket.catalog_snapshot) !== canonical(catalog))
    throw new Error('APPROVAL_CATALOG_NOT_READY');
  const applicant = await person(client,ticket.requester_id,input.corpId);
  const approvers: Approver[] = [];
  let managerMapping: ApprovalSnapshot['managerMapping'];
  for (const step of catalog.approval.steps as { role: string; approverId?: string }[]) {
    let id = step.approverId;
    if (step.role === 'MANAGER') {
      const mapping = (await client.query(`SELECT m.* FROM request_manager_mappings m JOIN employees v ON v.id=m.verified_by
        WHERE m.employee_id=$1 AND m.review_before>now() AND v.active FOR SHARE OF m,v`,[applicant.employeeId])).rows[0];
      if (!mapping || mapping.review_before < input.expiresAt) throw new Error('APPROVAL_MANAGER_MAPPING_UNAVAILABLE');
      id = mapping.manager_id;
      managerMapping = {managerId:id!,sourceReference:mapping.source_reference,verifiedAt:mapping.verified_at.toISOString(),reviewBefore:mapping.review_before.toISOString()};
    }
    if (!id || id === applicant.employeeId || id === ticket.submitted_by_id || approvers.some(item => item.employeeId === id))
      throw new Error('APPROVAL_SEPARATION_REQUIRED');
    approvers.push({...await person(client,id,input.corpId),role:step.role});
  }
  const snapshot: ApprovalSnapshot = {serviceCode:ticket.service_code,formVersion:ticket.form_version,
    templateId:catalog.approval.templateId,requestedValidityDays:input.requestedValidityDays,applicant,approvers,catalog,
    request:{subject:ticket.subject,description:ticket.description,fields:ticket.fields},
    submittedById:ticket.submitted_by_id,delegationId:ticket.delegation_id,
    ...(managerMapping ? {managerMapping} : {})};
  const result = await client.query(`INSERT INTO request_approvals(ticket_id,corp_id,snapshot,expires_at)
    VALUES ($1,$2,$3,$4) RETURNING id`,[ticket.id,input.corpId,JSON.stringify(snapshot),input.expiresAt]);
  await client.query(`INSERT INTO request_approval_events(approval_id,action,from_state,to_state)
    VALUES ($1,'APPROVAL_QUEUED','QUEUED','QUEUED')`,[result.rows[0].id]);
  await client.query(`UPDATE sla_cycles SET paused_at=clock_timestamp(),pause_reason='APPROVAL'
    WHERE ticket_id=$1 AND cycle=(SELECT max(cycle) FROM sla_cycles WHERE ticket_id=$1)
      AND completed_at IS NULL AND paused_at IS NULL`,[ticket.id]);
  return result.rows[0].id;
}
