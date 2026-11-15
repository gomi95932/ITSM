import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { type PoolClient } from 'pg';
import { P1_REVIEW_REMINDER_MINUTES, TICKET_ACTIONS, type ClassificationInput, type CreateTicketInput, type PriorityReviewInput, type PriorityReviewState, type TicketActionInput, type TicketFeedback, type TicketReceipt, type TicketStatus } from '@itsm/contracts';
import { transition } from './ticket-state.js';
import { Database } from './database.service.js';
import { AuthService, type AuthHeaders, type Identity } from './auth.service.js';
import { SlaService } from './sla.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ownershipDenial } from './ticket-ownership.js';
import { canDispatch, ROLE_AUTHORIZATION_LOCK } from './role-policy.js';

export function canViewRequestProgress(actorId: string, requesterId: string, serviceType: string): boolean {
  return actorId === requesterId && serviceType === 'REQ';
}

type TicketRow = {
  id: string; number: string; requester_id: string; owner_group_id: string;
  service_code: string; service_type: string; form_version: number; subject: string;
  description: string; fields: Record<string, unknown>; impact: string; urgency: string;
  priority: string; status: TicketStatus; version: number; created_at: Date; updated_at: Date;
  assignee_id: string | null; pending_group_id: string | null; pending_assignee_id: string | null;
  assignee_name?: string | null; pending_assignee_name?: string | null;
  priority_review_state: PriorityReviewState; priority_candidate_at: Date | null;
  priority_reviewed_at: Date | null; priority_reviewed_by: string | null; priority_review_reason: string | null;
  submitted_by_id: string; delegation_id: string | null; original_catalog_snapshot: Record<string,unknown>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = new Set(['contentClass', 'serviceCode', 'formVersion', 'subject', 'description', 'impact', 'urgency', 'fields', 'draftId', 'delegationId']);
const actionKeys = new Set(['contentClass', 'action', 'expectedVersion', 'comment', 'reason', 'dueAt', 'vendorReference', 'vendorOwner', 'resolutionCategory', 'evidence', 'targetGroupId', 'targetAssigneeId']);
const names = `(SELECT display_name FROM employees WHERE id=t.assignee_id) AS assignee_name,
  (SELECT display_name FROM employees WHERE id=t.pending_assignee_id) AS pending_assignee_name`;
const workAccess = `(owner_group_id IN (SELECT group_id FROM group_memberships WHERE employee_id=$1)
  OR owner_group_id IN (SELECT group_id FROM priority_reviewers WHERE employee_id=$1)
  OR (pending_assignee_id=$1 AND pending_group_id IN (SELECT group_id FROM group_memberships WHERE employee_id=$1)))`;
const delegatedAccess=(actor:string)=>`EXISTS(SELECT 1 FROM ticket_delegations d JOIN employees r ON r.id=d.requester_id
  WHERE d.id=t.delegation_id AND d.requester_id=t.requester_id AND d.delegate_id=${actor} AND r.active
    AND d.revoked_at IS NULL AND d.expires_at>now()
    AND EXISTS(SELECT 1 FROM group_memberships m WHERE m.employee_id=d.delegate_id))`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function validateBody(body: unknown): asserts body is CreateTicketInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'INVALID_TICKET' });
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !keys.has(k)) || typeof b.serviceCode !== 'string' || !/^[A-Z0-9-]{3,40}$/.test(b.serviceCode)
    || !Number.isInteger(b.formVersion) || typeof b.subject !== 'string' || !b.subject.trim() || b.subject.length > 200
    || typeof b.description !== 'string' || !b.description.trim() || b.description.length > 10000
    || !['COMPANY', 'DEPARTMENT', 'INDIVIDUAL'].includes(String(b.impact))
    || !['HIGH', 'MEDIUM', 'LOW'].includes(String(b.urgency))
    || (b.draftId !== undefined && (typeof b.draftId !== 'string' || !uuid.test(b.draftId)))
    || (b.delegationId !== undefined && (typeof b.delegationId !== 'string' || !uuid.test(b.delegationId)))
    || !b.fields || typeof b.fields !== 'object' || Array.isArray(b.fields) || JSON.stringify(b.fields).length > 16000)
    throw new BadRequestException({ code: 'INVALID_TICKET' });
}

function validateAction(body: unknown): asserts body is TicketActionInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'INVALID_ACTION' });
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !actionKeys.has(k)) || !TICKET_ACTIONS.includes(b.action as TicketActionInput['action'])
    || !Number.isInteger(b.expectedVersion) || Number(b.expectedVersion) < 1
    || Object.entries(b).some(([k, v]) => k !== 'action' && k !== 'expectedVersion' && (typeof v !== 'string' || v.length > 2000)))
    throw new BadRequestException({ code: 'INVALID_ACTION' });
}

function priority(impact: string, urgency: string): string {
  const matrix: Record<string, Record<string, string>> = {
    COMPANY: { HIGH: 'P1', MEDIUM: 'P1', LOW: 'P2' },
    DEPARTMENT: { HIGH: 'P1', MEDIUM: 'P2', LOW: 'P3' },
    INDIVIDUAL: { HIGH: 'P2', MEDIUM: 'P3', LOW: 'P4' },
  };
  return matrix[impact][urgency];
}

@Injectable()
export class TicketsService {
  constructor(private readonly db: Database, private readonly auth: AuthService, private readonly sla: SlaService, private readonly intake: IntakePolicyService) {}
  private get pool() { return this.db.pool; }
  identity(headers: AuthHeaders, write = false) { return this.auth.identity(headers, write); }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  private async requireActive(client: PoolClient, actor: Identity): Promise<void> {
    const active = await client.query('SELECT id FROM employees WHERE id=$1 AND active=true FOR SHARE', [actor.id]);
    if (!active.rowCount) throw new UnauthorizedException();
  }

  private async delegation(client:PoolClient,actor:string,id:string,required=true):Promise<string | undefined> {
    const grant=await client.query(`SELECT d.requester_id FROM ticket_delegations d JOIN employees r ON r.id=d.requester_id
      JOIN group_memberships m ON m.employee_id=d.delegate_id
      WHERE d.id=$1 AND d.delegate_id=$2 AND r.active AND d.revoked_at IS NULL AND d.expires_at>now() FOR SHARE OF d,r,m`,[id,actor]);
    if(!grant.rowCount&&required)throw new ForbiddenException({code:'DELEGATION_REQUIRED'});
    return grant.rows[0]?.requester_id;
  }

  private async catalogFor(client:PoolClient,actor:string,requester:string,code:string,version:number,fields:Record<string,unknown>) {
    const catalog=await client.query(`SELECT * FROM service_catalog WHERE code=$1 AND published AND
      (visible_groups='[]'::jsonb OR (EXISTS(SELECT 1 FROM group_memberships WHERE employee_id=$2 AND visible_groups ? group_id)
        AND EXISTS(SELECT 1 FROM group_memberships WHERE employee_id=$3 AND visible_groups ? group_id))) FOR SHARE`,[code,actor,requester]);
    if(!catalog.rowCount)throw new BadRequestException({code:'SERVICE_UNAVAILABLE'});
    const service=catalog.rows[0];
    if(version!==service.form_version)throw new ConflictException({code:'FORM_VERSION_CONFLICT'});
    if((service.required_fields as string[]).some(field=>typeof fields[field]!=='string'||!String(fields[field]).trim()))
      throw new BadRequestException({code:'REQUIRED_FIELDS_MISSING'});
    const schema=service.field_schema as {key:string;options?:string[]}[];
    if(Object.keys(fields).some(key=>!schema.some(field=>field.key===key))||schema.some(field=>{
      const value=fields[field.key];return value!==undefined&&(typeof value!=='string'||value.length>500||(field.options&&!field.options.includes(value)));
    }))throw new BadRequestException({code:'INVALID_SERVICE_FIELDS'});
    if(!['INC','GEN'].includes(service.type))throw new ServiceUnavailableException({code:'REQUEST_APPROVAL_POLICY_NOT_CONFIGURED'});
    return service;
  }

  private async claim(client: PoolClient, actor: string, scope: string, key: string, body: unknown): Promise<unknown | undefined> {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const hash = createHash('sha256').update(canonical(body)).digest('hex');
    await client.query('INSERT INTO api_idempotency(actor_id, scope, key, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [actor, scope, key, hash]);
    const result = await client.query<{ request_hash: string; response: unknown }>(
      'SELECT request_hash, response FROM api_idempotency WHERE actor_id=$1 AND scope=$2 AND key=$3 FOR UPDATE', [actor, scope, key]);
    if (result.rows[0].request_hash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
    return result.rows[0].response ?? undefined;
  }

  private async record(client: PoolClient, ticket: TicketRow, actor: string, action: string, before: TicketStatus | null, detail: object, requestId: string, previous?: TicketRow): Promise<void> {
    const eventId = randomUUID();
    await client.query('INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [eventId, ticket.id, actor, action, before, ticket.status, JSON.stringify(detail), requestId]);
    await client.query('INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [ticket.id, eventId, actor, requestId, action, before ? JSON.stringify({ status: before, ...(previous ? this.auditValue(previous) : {}) }) : null, JSON.stringify(this.auditValue(ticket))]);
    await client.query('INSERT INTO outbox_events(ticket_id,event_id,kind,payload) VALUES ($1,$2,$3,$4)',
      [ticket.id, eventId, action.startsWith('P1_') ? 'P1_ALERT' : 'TICKET_CHANGED', JSON.stringify({ ticketId: ticket.id, eventId })]);
  }

  async create(actor: Identity, body: unknown, key: string, requestId: string): Promise<TicketReceipt> {
    validateBody(body);
    await this.intake.requireGeneral(actor.id, body as unknown as Record<string, unknown>, 'ticket-create');
    return this.transaction(async client => {
      await this.requireActive(client, actor);
      const requester=body.delegationId ? (await this.delegation(client,actor.id,body.delegationId))! : actor.id;
      const previous = await this.claim(client, actor.id, 'create', key, body);
      if (previous) return previous as TicketReceipt;
      if (body.draftId) {
        const draft = await client.query('SELECT id FROM voice_drafts WHERE id=$1 AND employee_id=$2 AND expires_at>now() AND ticket_id IS NULL FOR UPDATE',[body.draftId,actor.id]);
        if (!draft.rowCount) throw new ConflictException({ code:'DRAFT_EXPIRED' });
      }
      const service=await this.catalogFor(client,actor.id,requester,body.serviceCode,body.formVersion,body.fields);
      const numberResult = await client.query<{ n: string }>("SELECT nextval('ticket_number_seq')::text AS n");
      const number = `ITSM-${numberResult.rows[0].n.padStart(8, '0')}`;
      const created = await client.query<TicketRow>(`INSERT INTO tickets(number,requester_id,owner_group_id,service_code,service_type,form_version,subject,description,fields,impact,urgency,priority,status,priority_review_state,priority_candidate_at,submitted_by_id,delegation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'QUEUED',CASE WHEN $12='P1' THEN 'PENDING' ELSE 'NOT_REQUIRED' END,CASE WHEN $12='P1' THEN now() ELSE NULL END,$13,$14) RETURNING *`,
        [number, requester, service.group_id, body.serviceCode, service.type, body.formVersion, body.subject.trim(), body.description.trim(), JSON.stringify(body.fields), body.impact, body.urgency, priority(body.impact, body.urgency),actor.id,body.delegationId??null]);
      const ticket = created.rows[0];
      if (body.draftId) await client.query('UPDATE voice_drafts SET ticket_id=$2 WHERE id=$1',[body.draftId,ticket.id]);
      await client.query('UPDATE tickets SET catalog_snapshot=$2,original_catalog_snapshot=$2,original_fields=fields WHERE id=$1', [ticket.id,JSON.stringify({ code: body.serviceCode, name: service.name, formVersion: service.form_version, fields: service.field_schema })]);
      await this.sla.start(client,ticket.id,ticket.priority);
      await this.record(client, ticket, actor.id, 'SUBMIT_AND_ROUTE', null, { groupId: ticket.owner_group_id,requesterId:requester,submittedById:actor.id,delegationId:body.delegationId??null,serviceCode:body.serviceCode }, requestId);
      if (ticket.priority_review_state === 'PENDING') {
        await client.query("INSERT INTO priority_review_signals(ticket_id,kind) VALUES ($1,'CANDIDATE')",[ticket.id]);
        await this.record(client,ticket,actor.id,'P1_CANDIDATE',ticket.status,{ priority:'P1',reviewState:'PENDING',responseStarted:true },requestId,ticket);
      }
      const response = this.receipt(ticket);
      await client.query('UPDATE api_idempotency SET response=$4 WHERE actor_id=$1 AND scope=$2 AND key=$3', [actor.id, 'create', key, JSON.stringify(response)]);
      return response;
    });
  }

  private receipt(row: TicketRow): TicketReceipt {
    return { id: row.id, number: row.number, status: row.status, version: row.version, ownerGroupId: row.owner_group_id,
      assigneeId: row.assignee_id, pendingGroupId: row.pending_group_id, pendingAssigneeId: row.pending_assignee_id,
      ...(row.assignee_name !== undefined ? { assigneeName: row.assignee_name } : {}),
      ...(row.pending_assignee_name !== undefined ? { pendingAssigneeName: row.pending_assignee_name } : {}) };
  }

  private auditValue(row: TicketRow): object {
    return { ...this.receipt(row),priority:row.priority,priorityReviewState:row.priority_review_state,
      serviceCode:row.service_code,serviceType:row.service_type,formVersion:row.form_version,
      requesterId:row.requester_id,submittedById:row.submitted_by_id,delegationId:row.delegation_id,
      priorityCandidateAt:row.priority_candidate_at,priorityReviewedAt:row.priority_reviewed_at,
      priorityReviewedBy:row.priority_reviewed_by,priorityReviewReason:row.priority_review_reason };
  }

  private async accessible(client: PoolClient, actor: Identity, id: string, lock = false): Promise<TicketRow> {
    if (!uuid.test(id)) throw new NotFoundException();
    const result = await client.query<TicketRow>(`SELECT t.*,${names} FROM tickets t WHERE id=$1 AND (requester_id=$2 OR owner_group_id IN
      (SELECT group_id FROM group_memberships WHERE employee_id=$2) OR (pending_assignee_id=$2 AND pending_group_id IN
      (SELECT group_id FROM group_memberships WHERE employee_id=$2)) OR owner_group_id IN
      (SELECT group_id FROM priority_reviewers WHERE employee_id=$2) OR ${delegatedAccess('$2')}) ${lock ? 'FOR UPDATE OF t' : ''}`,
      [id, actor.id]);
    if (!result.rowCount) throw new NotFoundException();
    return result.rows[0];
  }

  async list(actor: Identity, mine: boolean, status: string | undefined, page: number, size: number): Promise<object> {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) throw new BadRequestException();
    if (status && !['NEW','QUEUED','IN_PROGRESS','WAITING_APPROVAL','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION','CLOSED','CANCELLED','REJECTED'].includes(status)) throw new BadRequestException();
    if (!mine && !actor.groups.length && !actor.priorityReviewGroups?.length) throw new NotFoundException();
    const mineAccess=`(requester_id=$1 OR ${delegatedAccess('$1')})`;
    const result = await this.pool.query<TicketRow>(`SELECT t.*,${names} FROM tickets t WHERE ${mine ? mineAccess : workAccess}
      AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [actor.id, status ?? null, size, (page - 1) * size]);
    const summary = await this.pool.query(`SELECT status,count(*)::integer AS count FROM tickets t WHERE ${mine ? mineAccess : workAccess} GROUP BY status`,[actor.id]);
    const counts = Object.fromEntries(summary.rows.map(row=>[row.status,row.count]));
    const total = status ? counts[status] ?? 0 : summary.rows.reduce((sum,row)=>sum+row.count,0);
    return { items: result.rows.map(row => this.publicTicket(row)), page, size, total, counts };
  }

  private publicTicket(row: TicketRow): object {
    return { ...this.receipt(row), requesterId: row.requester_id, serviceCode: row.service_code, serviceType: row.service_type, formVersion: row.form_version,
      submittedById:row.submitted_by_id,originalServiceCode:row.original_catalog_snapshot?.code??row.service_code,
      subject: row.subject, description: row.description, fields: row.fields, impact: row.impact, urgency: row.urgency,
      priority: row.priority, priorityReviewState:row.priority_review_state,priorityCandidateAt:row.priority_candidate_at,
      priorityReviewedAt:row.priority_reviewed_at,priorityReviewedBy:row.priority_reviewed_by,priorityReviewReason:row.priority_review_reason,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async get(actor: Identity, id: string): Promise<object> {
    const client = await this.pool.connect();
    try {
      const ticket = await this.accessible(client, actor, id);
      const events = await client.query('SELECT action, from_status AS "fromStatus", to_status AS "toStatus", detail, created_at AS "createdAt" FROM ticket_events WHERE ticket_id=$1 ORDER BY created_at,id', [id]);
      const membership = await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2', [actor.id, ticket.owner_group_id]);
      const reviewer = await client.query('SELECT 1 FROM priority_reviewers WHERE employee_id=$1 AND group_id=$2',[actor.id,ticket.owner_group_id]);
      const groupMember = !!membership.rowCount || ticket.pending_assignee_id === actor.id || !!reviewer.rowCount;
      const alerts = groupMember && ticket.priority_candidate_at ? await client.query(`SELECT d.state,count(*)::integer AS count
        FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id WHERE o.ticket_id=$1 AND o.kind='P1_ALERT' GROUP BY d.state`,[id]) : null;
      const available = groupMember && ticket.priority_candidate_at ? await client.query(`SELECT 1 FROM priority_reviewers r
        JOIN employees e ON e.id=r.employee_id WHERE r.group_id=$1 AND e.active AND e.id<>$2 AND e.id<>$3 LIMIT 1`,[ticket.owner_group_id,ticket.requester_id,ticket.submitted_by_id]) : null;
      const delegated=!!ticket.delegation_id && await this.delegation(client,actor.id,ticket.delegation_id,false)===ticket.requester_id;
      const feedbackVisible=actor.id===ticket.requester_id || !!membership.rowCount;
      const feedback=feedbackVisible ? await client.query<{rating:number;comment:string|null;createdAt:Date}>(
        'SELECT rating,comment,created_at AS "createdAt" FROM ticket_feedback WHERE ticket_id=$1',[id]) : null;
      const requestProgress = canViewRequestProgress(actor.id, ticket.requester_id, ticket.service_type)
        ? await client.query(`SELECT a.state AS approval_state,a.updated_at AS approval_updated_at,
            f.state AS fulfillment_state,f.delivered_at,f.access_expires_at,f.revoked_at,f.reviewed_at,f.updated_at AS fulfillment_updated_at
          FROM request_approvals a LEFT JOIN request_fulfillments f ON f.approval_id=a.id
          WHERE a.ticket_id=$1`, [id])
        : null;
      const progressRow = requestProgress?.rows[0];
      const dispatcher=!!membership.rowCount&&await canDispatch(client,actor.id,ticket.owner_group_id);
      return { ...this.publicTicket(ticket),canAddInfo:actor.id===ticket.requester_id||delegated,
        canDispatchQueued:dispatcher,
        ...(canViewRequestProgress(actor.id, ticket.requester_id, ticket.service_type) ? { requestProgress: {
          approval: progressRow ? { state: progressRow.approval_state, updatedAt: progressRow.approval_updated_at }
            : null,
          fulfillment: progressRow?.fulfillment_state ? {
            state: progressRow.fulfillment_state,
            deliveredAt: progressRow.delivered_at,
            accessExpiresAt: progressRow.access_expires_at,
            revokedAt: progressRow.revoked_at,
            reviewedAt: progressRow.reviewed_at,
            updatedAt: progressRow.fulfillment_updated_at,
          } : null,
        } } : {}),
        canFeedback:actor.id===ticket.requester_id && ticket.service_type==='INC' && ticket.status==='CLOSED' && !feedback?.rowCount,
        feedback:feedback?.rows[0] ?? null,
        canCorrectClassification:!!membership.rowCount && ['QUEUED','IN_PROGRESS','WAITING_USER','WAITING_VENDOR'].includes(ticket.status)
          && !ticket.pending_assignee_id && (ticket.assignee_id===actor.id||(!ticket.assignee_id&&ticket.status==='QUEUED'&&dispatcher)),
        canReviewPriority:!!reviewer.rowCount && actor.id!==ticket.requester_id && actor.id!==ticket.submitted_by_id
          && ticket.priority_review_state==='PENDING' && !['CLOSED','CANCELLED','REJECTED'].includes(ticket.status),
        ...(alerts ? { priorityAlert:{ reviewersAvailable:!!available?.rowCount,
          overdue:ticket.priority_review_state==='PENDING' && !!ticket.priority_candidate_at && Date.now()-ticket.priority_candidate_at.getTime()>=P1_REVIEW_REMINDER_MINUTES*60000,
          notificationMode:process.env.NOTIFICATION_MODE ?? 'disabled',deliveries:Object.fromEntries(alerts.rows.map(r=>[r.state,r.count])) } } : {}),
        sla: await this.sla.view(client,id), events: groupMember ? events.rows : events.rows.map(event => ({
        action: event.action, fromStatus: event.fromStatus, toStatus: event.toStatus,
        detail: { comment: event.detail?.comment, reason: event.detail?.reason }, createdAt: event.createdAt,
      })) };
    } finally { client.release(); }
  }

  async feedback(actor:Identity,id:string,body:unknown,key:string,requestId:string):Promise<TicketFeedback> {
    if(!body||typeof body!=='object'||Array.isArray(body))throw new BadRequestException({code:'INVALID_FEEDBACK'});
    const input=body as Record<string,unknown>;
    if(Object.keys(input).some(k=>!['contentClass','rating','comment'].includes(k))
      || typeof input.rating!=='number' || !Number.isInteger(input.rating) || input.rating<1 || input.rating>5
      || (input.comment!==undefined && (typeof input.comment!=='string'||input.comment.length>1000)))
      throw new BadRequestException({code:'INVALID_FEEDBACK'});
    await this.intake.requireGeneral(actor.id,input,'ticket-feedback');
    return this.transaction(async client=>{
      await this.requireActive(client,actor);
      const ticket=await this.accessible(client,actor,id,true);
      if(ticket.requester_id!==actor.id)throw new ForbiddenException({code:'FEEDBACK_REQUESTER_REQUIRED'});
      const previous=await this.claim(client,actor.id,`feedback:${id}`,key,input);
      if(previous)return previous as TicketFeedback;
      if(ticket.service_type!=='INC'||ticket.status!=='CLOSED')throw new ConflictException({code:'FEEDBACK_NOT_AVAILABLE'});
      const exists=await client.query('SELECT 1 FROM ticket_feedback WHERE ticket_id=$1',[id]);
      if(exists.rowCount)throw new ConflictException({code:'FEEDBACK_ALREADY_SUBMITTED'});
      const saved=await client.query<{rating:number;comment:string|null;createdAt:Date}>(
        'INSERT INTO ticket_feedback(ticket_id,requester_id,rating,comment) VALUES ($1,$2,$3,$4) RETURNING rating,comment,created_at AS "createdAt"',
        [id,actor.id,input.rating,(input.comment as string|undefined)?.trim()||null]);
      await this.record(client,ticket,actor.id,'FEEDBACK_SUBMITTED',ticket.status,{rating:input.rating},requestId,ticket);
      const response:TicketFeedback={...saved.rows[0],createdAt:saved.rows[0].createdAt.toISOString()};
      await client.query('UPDATE api_idempotency SET response=$4 WHERE actor_id=$1 AND scope=$2 AND key=$3',
        [actor.id,`feedback:${id}`,key,JSON.stringify(response)]);
      return response;
    });
  }

  async reviewPriority(actor: Identity,id: string,body: unknown,key: string,requestId: string): Promise<TicketReceipt> {
    const input=body as PriorityReviewInput;
    if (!input || typeof input!=='object' || Array.isArray(input)
      || Object.keys(input).some(k=>!['contentClass','expectedVersion','priority','reason'].includes(k))
      || !Number.isInteger(input.expectedVersion) || input.expectedVersion<1
      || !['P1','P2','P3','P4'].includes(input.priority) || typeof input.reason!=='string' || !input.reason.trim() || input.reason.length>2000)
      throw new BadRequestException({ code:'INVALID_PRIORITY_REVIEW' });
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'priority-review');
    return this.transaction(async client=>{
      await this.requireActive(client,actor);
      const ticket=await this.accessible(client,actor,id,true);
      const reviewer=await client.query('SELECT 1 FROM priority_reviewers WHERE employee_id=$1 AND group_id=$2 FOR SHARE',[actor.id,ticket.owner_group_id]);
      if (!reviewer.rowCount || actor.id===ticket.requester_id || actor.id===ticket.submitted_by_id) throw new ForbiddenException({ code:'PRIORITY_REVIEWER_REQUIRED' });
      const previous=await this.claim(client,actor.id,`priority-review:${id}`,key,input);
      if (previous) return previous as TicketReceipt;
      if (ticket.version!==input.expectedVersion) throw new ConflictException({ code:'VERSION_CONFLICT' });
      if (ticket.priority_review_state!=='PENDING' || ['CLOSED','CANCELLED','REJECTED'].includes(ticket.status))
        throw new ConflictException({ code:'PRIORITY_REVIEW_NOT_PENDING' });
      // The active SLA snapshot remains unchanged, including its original P1 clock and breach history.
      const updated=await client.query<TicketRow>(`UPDATE tickets SET priority=$2,priority_review_state=$3,priority_reviewed_by=$4,
        priority_reviewed_at=now(),priority_review_reason=$5,version=version+1 WHERE id=$1 RETURNING *`,
        [id,input.priority,input.priority==='P1' ? 'CONFIRMED' : 'ADJUSTED',actor.id,input.reason.trim()]);
      await this.record(client,updated.rows[0],actor.id,'PRIORITY_REVIEWED',ticket.status,
        { reason:input.reason.trim(),oldPriority:ticket.priority,priority:input.priority,activeSlaPolicy:'PRESERVE_SNAPSHOT' },requestId,ticket);
      const response=this.receipt(updated.rows[0]);
      await client.query('UPDATE api_idempotency SET response=$4 WHERE actor_id=$1 AND scope=$2 AND key=$3',[actor.id,`priority-review:${id}`,key,JSON.stringify(response)]);
      return response;
    });
  }

  async classify(actor:Identity,id:string,body:unknown,key:string,requestId:string):Promise<TicketReceipt> {
    const input=body as ClassificationInput;
    if(!input||typeof input!=='object'||Array.isArray(input)
      ||Object.keys(input).some(k=>!['contentClass','expectedVersion','serviceCode','formVersion','fields','reason'].includes(k))
      ||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1||typeof input.serviceCode!=='string'||!/^[A-Z0-9-]{3,40}$/.test(input.serviceCode)
      ||!Number.isInteger(input.formVersion)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000
      ||!input.fields||typeof input.fields!=='object'||Array.isArray(input.fields)||JSON.stringify(input.fields).length>16000)
      throw new BadRequestException({code:'INVALID_CLASSIFICATION'});
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'classification');
    return this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
      await this.requireActive(client,actor);
      const ticket=await this.accessible(client,actor,id,true);
      const member=await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2 FOR SHARE',[actor.id,ticket.owner_group_id]);
      if(!member.rowCount||!(ticket.assignee_id===actor.id||(!ticket.assignee_id&&ticket.status==='QUEUED')))
        throw new ForbiddenException({code:'CLASSIFICATION_OWNER_REQUIRED'});
      if(!ticket.assignee_id&&!await canDispatch(client,actor.id,ticket.owner_group_id))
        throw new ForbiddenException({code:'DISPATCH_ROLE_REQUIRED'});
      const previous=await this.claim(client,actor.id,`classification:${id}`,key,input);
      if(previous)return previous as TicketReceipt;
      if(ticket.version!==input.expectedVersion)throw new ConflictException({code:'VERSION_CONFLICT'});
      if(!['QUEUED','IN_PROGRESS','WAITING_USER','WAITING_VENDOR'].includes(ticket.status)||ticket.pending_assignee_id)
        throw new ConflictException({code:'CLASSIFICATION_NOT_ALLOWED'});
      const service=await this.catalogFor(client,actor.id,ticket.requester_id,input.serviceCode,input.formVersion,input.fields);
      if(service.group_id!==ticket.owner_group_id)throw new ConflictException({code:'CLASSIFICATION_HANDOVER_REQUIRED'});
      if(input.serviceCode===ticket.service_code)throw new ConflictException({code:'CLASSIFICATION_UNCHANGED'});
      const snapshot={code:service.code,name:service.name,formVersion:service.form_version,fields:service.field_schema};
      // A correction never transfers ownership, restarts SLA or overwrites the original classification.
      const updated=await client.query<TicketRow>(`UPDATE tickets SET service_code=$2,service_type=$3,form_version=$4,fields=$5,
        catalog_snapshot=$6,version=version+1 WHERE id=$1 RETURNING *`,[id,service.code,service.type,service.form_version,JSON.stringify(input.fields),JSON.stringify(snapshot)]);
      await this.record(client,updated.rows[0],actor.id,'CLASSIFICATION_CORRECTED',ticket.status,
        {reason:input.reason.trim(),oldServiceCode:ticket.service_code,serviceCode:service.code,oldFields:ticket.fields,fields:input.fields},requestId,ticket);
      const response=this.receipt(updated.rows[0]);
      await client.query('UPDATE api_idempotency SET response=$4 WHERE actor_id=$1 AND scope=$2 AND key=$3',[actor.id,`classification:${id}`,key,JSON.stringify(response)]);
      return response;
    });
  }

  async action(actor: Identity, id: string, body: unknown, key: string, requestId: string): Promise<TicketReceipt> {
    validateAction(body);
    await this.intake.requireGeneral(actor.id, body as unknown as Record<string, unknown>, 'ticket-action');
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
      await this.requireActive(client, actor);
      const ticket = await this.accessible(client, actor, id, true);
      const member = await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2 FOR SHARE', [actor.id, ticket.owner_group_id]);
      const delegatedInfo=body.action==='ADD_INFO' && !!ticket.delegation_id
        && await this.delegation(client,actor.id,ticket.delegation_id,false)===ticket.requester_id;
      if(['ADD_INFO','CONFIRM','REOPEN','CANCEL'].includes(body.action) && ticket.requester_id!==actor.id && !delegatedInfo)
        throw new ForbiddenException({code:'TICKET_ACTION_NOT_AUTHORIZED'});
      if(!ticket.assignee_id&&ticket.status==='QUEUED'&&['REASSIGN','CANCEL_HANDOVER'].includes(body.action)
        &&!await canDispatch(client,actor.id,ticket.owner_group_id))throw new ForbiddenException({code:'DISPATCH_ROLE_REQUIRED'});
      const previous = await this.claim(client, actor.id, `action:${id}`, key, body);
      if (previous) return previous as TicketReceipt;
      if (ticket.version !== body.expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      const denial = ownershipDenial(ticket, actor.id, !!member.rowCount, body.action);
      if (denial) throw new ConflictException({ code: denial });
      if(ticket.requester_id!==actor.id && !delegatedInfo && !member.rowCount && ticket.pending_assignee_id!==actor.id)
        throw new ForbiddenException({code:'TICKET_ACTION_NOT_AUTHORIZED'});
      const role = (ticket.requester_id === actor.id && ['ADD_INFO','CONFIRM','REOPEN','CANCEL'].includes(body.action)) || delegatedInfo
        ? 'requester' : 'agent';
      const next = transition(ticket.status, role, body);
      let group = ticket.owner_group_id, assignee = ticket.assignee_id;
      let pendingGroup = ticket.pending_group_id, pendingAssignee = ticket.pending_assignee_id;
      if (body.action === 'ACCEPT') assignee = actor.id;
      if (body.action === 'REASSIGN') {
        const target = await client.query(`SELECT e.id FROM employees e JOIN group_memberships m ON m.employee_id=e.id
          WHERE e.id=$1 AND m.group_id=$2 AND e.active FOR SHARE OF e,m`, [body.targetAssigneeId, body.targetGroupId]);
        if (!target.rowCount || body.targetAssigneeId === actor.id) throw new BadRequestException({ code: 'INVALID_HANDOVER_TARGET' });
        pendingGroup = body.targetGroupId!; pendingAssignee = body.targetAssigneeId!;
      }
      if (['ACCEPT_HANDOVER','DECLINE_HANDOVER'].includes(body.action)) {
        const target = await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2 FOR SHARE', [actor.id, pendingGroup]);
        if (!target.rowCount) throw new ConflictException({ code: 'HANDOVER_TARGET_REQUIRED' });
        if (body.action === 'ACCEPT_HANDOVER') { group = pendingGroup!; assignee = actor.id; }
      }
      if (['ACCEPT_HANDOVER','DECLINE_HANDOVER','CANCEL_HANDOVER'].includes(body.action) || ['CLOSED','CANCELLED','REJECTED'].includes(next)) {
        pendingGroup = null; pendingAssignee = null;
      }
      const before = ticket.status;
      const updated = await client.query<TicketRow>(`UPDATE tickets SET status=$2,owner_group_id=$3,assignee_id=$4,pending_group_id=$5,
        pending_assignee_id=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [id, next, group, assignee, pendingGroup, pendingAssignee]);
      await this.sla.action(client,id,body.action,ticket.priority);
      await this.record(client, updated.rows[0], actor.id, body.action, before,
        { comment: body.comment, reason: body.reason, dueAt: body.dueAt, vendorReference: body.vendorReference, vendorOwner: body.vendorOwner, resolutionCategory: body.resolutionCategory, evidence: body.evidence,
          ...(body.action === 'REASSIGN' || body.action.endsWith('_HANDOVER') ? { oldGroupId: ticket.owner_group_id, oldAssigneeId: ticket.assignee_id,
            targetGroupId: body.targetGroupId ?? ticket.pending_group_id, targetAssigneeId: body.targetAssigneeId ?? ticket.pending_assignee_id } : {}) }, requestId, ticket);
      if (body.action==='ACCEPT_HANDOVER' && group!==ticket.owner_group_id && ticket.priority_review_state==='PENDING')
        await this.record(client,updated.rows[0],actor.id,'P1_REVIEW_ROUTED',next,{ oldGroupId:ticket.owner_group_id,targetGroupId:group },requestId,ticket);
      const response = this.receipt(updated.rows[0]);
      await client.query('UPDATE api_idempotency SET response=$4 WHERE actor_id=$1 AND scope=$2 AND key=$3', [actor.id, `action:${id}`, key, JSON.stringify(response)]);
      return response;
    });
  }
}
