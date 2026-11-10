import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { TICKET_ACTIONS, type CreateTicketInput, type TicketActionInput, type TicketReceipt, type TicketStatus } from '@itsm/contracts';
import { transition } from './ticket-state.js';

type Identity = { id: string; groups: string[] };
type TicketRow = {
  id: string; number: string; requester_id: string; owner_group_id: string;
  service_code: string; service_type: string; form_version: number; subject: string;
  description: string; fields: Record<string, unknown>; impact: string; urgency: string;
  priority: string; status: TicketStatus; version: number; created_at: Date; updated_at: Date;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = new Set(['serviceCode', 'formVersion', 'subject', 'description', 'impact', 'urgency', 'fields']);
const actionKeys = new Set(['action', 'expectedVersion', 'comment', 'reason', 'dueAt', 'vendorReference', 'vendorOwner', 'resolutionCategory', 'evidence']);

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
export class TicketsService implements OnModuleDestroy {
  private readonly pool = new Pool({
    host: process.env.DB_HOST ?? 'db', port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'itsm', user: process.env.DB_USER ?? 'itsm',
    password: process.env.DB_PASSWORD,
  });

  async onModuleDestroy(): Promise<void> { await this.pool.end(); }

  async identity(devUser: string | undefined): Promise<Identity> {
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEV_AUTH !== 'true')
      throw new ServiceUnavailableException({ code: 'IDENTITY_PROVIDER_NOT_CONFIGURED' });
    if (!devUser || !/^[a-zA-Z0-9-]{1,80}$/.test(devUser)) throw new UnauthorizedException();
    const result = await this.pool.query('SELECT id FROM employees WHERE id = $1 AND active = true', [devUser]);
    if (!result.rowCount) throw new UnauthorizedException();
    const memberships = await this.pool.query<{ group_id: string }>('SELECT group_id FROM group_memberships WHERE employee_id = $1', [devUser]);
    return { id: devUser, groups: memberships.rows.map(r => r.group_id) };
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async requireActive(client: PoolClient, actor: Identity): Promise<void> {
    const active = await client.query('SELECT id FROM employees WHERE id=$1 AND active=true FOR SHARE', [actor.id]);
    if (!active.rowCount) throw new UnauthorizedException();
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

  private async record(client: PoolClient, ticket: TicketRow, actor: string, action: string, before: TicketStatus | null, detail: object, requestId: string): Promise<void> {
    const eventId = randomUUID();
    await client.query('INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [eventId, ticket.id, actor, action, before, ticket.status, JSON.stringify(detail), requestId]);
    await client.query('INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [ticket.id, eventId, actor, requestId, action, before ? JSON.stringify({ status: before }) : null, JSON.stringify({ status: ticket.status, version: ticket.version })]);
    await client.query('INSERT INTO outbox_events(ticket_id,event_id,kind,payload) VALUES ($1,$2,$3,$4)',
      [ticket.id, eventId, 'TICKET_CHANGED', JSON.stringify({ ticketId: ticket.id, eventId })]);
  }

  async create(actor: Identity, body: unknown, key: string, requestId: string): Promise<TicketReceipt> {
    validateBody(body);
    return this.transaction(async client => {
      await this.requireActive(client, actor);
      const previous = await this.claim(client, actor.id, 'create', key, body);
      if (previous) return previous as TicketReceipt;
      const catalog = await client.query<{ type: string; form_version: number; group_id: string; required_fields: string[] }>(
        'SELECT type, form_version, group_id, required_fields FROM service_catalog WHERE code=$1 AND published=true', [body.serviceCode]);
      if (!catalog.rowCount) throw new BadRequestException({ code: 'SERVICE_UNAVAILABLE' });
      const service = catalog.rows[0];
      if (body.formVersion !== service.form_version) throw new ConflictException({ code: 'FORM_VERSION_CONFLICT' });
      if (service.required_fields.some(field => !body.fields[field])) throw new BadRequestException({ code: 'REQUIRED_FIELDS_MISSING' });
      if (service.type !== 'INC') throw new ServiceUnavailableException({ code: 'REQUEST_APPROVAL_POLICY_NOT_CONFIGURED' });
      const numberResult = await client.query<{ n: string }>("SELECT nextval('ticket_number_seq')::text AS n");
      const number = `ITSM-${numberResult.rows[0].n.padStart(8, '0')}`;
      const created = await client.query<TicketRow>(`INSERT INTO tickets(number,requester_id,owner_group_id,service_code,service_type,form_version,subject,description,fields,impact,urgency,priority,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'QUEUED') RETURNING *`,
        [number, actor.id, service.group_id, body.serviceCode, service.type, body.formVersion, body.subject.trim(), body.description.trim(), JSON.stringify(body.fields), body.impact, body.urgency, priority(body.impact, body.urgency)]);
      const ticket = created.rows[0];
      await this.record(client, ticket, actor.id, 'SUBMIT_AND_ROUTE', null, { groupId: ticket.owner_group_id }, requestId);
      const response = this.receipt(ticket);
      await client.query('UPDATE api_idempotency SET response=$4 WHERE actor_id=$1 AND scope=$2 AND key=$3', [actor.id, 'create', key, JSON.stringify(response)]);
      return response;
    });
  }

  private receipt(row: TicketRow): TicketReceipt {
    return { id: row.id, number: row.number, status: row.status, version: row.version, ownerGroupId: row.owner_group_id };
  }

  private async accessible(client: PoolClient, actor: Identity, id: string, lock = false): Promise<TicketRow> {
    if (!uuid.test(id)) throw new NotFoundException();
    const result = await client.query<TicketRow>(`SELECT * FROM tickets WHERE id=$1 AND (requester_id=$2 OR owner_group_id IN
      (SELECT group_id FROM group_memberships WHERE employee_id=$2)) ${lock ? 'FOR UPDATE' : ''}`,
      [id, actor.id]);
    if (!result.rowCount) throw new NotFoundException();
    return result.rows[0];
  }

  async list(actor: Identity, mine: boolean, status: string | undefined, page: number, size: number): Promise<object> {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) throw new BadRequestException();
    if (status && !['NEW','QUEUED','IN_PROGRESS','WAITING_APPROVAL','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION','CLOSED','CANCELLED','REJECTED'].includes(status)) throw new BadRequestException();
    if (!mine && !actor.groups.length) throw new NotFoundException();
    const result = await this.pool.query<TicketRow>(`SELECT * FROM tickets WHERE ${mine ? 'requester_id=$1' : 'owner_group_id IN (SELECT group_id FROM group_memberships WHERE employee_id=$1)'}
      AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [actor.id, status ?? null, size, (page - 1) * size]);
    return { items: result.rows.map(row => this.publicTicket(row)), page, size };
  }

  private publicTicket(row: TicketRow): object {
    return { ...this.receipt(row), serviceCode: row.service_code, serviceType: row.service_type, formVersion: row.form_version,
      subject: row.subject, description: row.description, fields: row.fields, impact: row.impact, urgency: row.urgency,
      priority: row.priority, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async get(actor: Identity, id: string): Promise<object> {
    const client = await this.pool.connect();
    try {
      const ticket = await this.accessible(client, actor, id);
      const events = await client.query('SELECT action, from_status AS "fromStatus", to_status AS "toStatus", detail, created_at AS "createdAt" FROM ticket_events WHERE ticket_id=$1 ORDER BY created_at,id', [id]);
      const membership = await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2', [actor.id, ticket.owner_group_id]);
      const groupMember = !!membership.rowCount;
      return { ...this.publicTicket(ticket), events: groupMember ? events.rows : events.rows.map(event => ({
        action: event.action, fromStatus: event.fromStatus, toStatus: event.toStatus,
        detail: { comment: event.detail?.comment, reason: event.detail?.reason }, createdAt: event.createdAt,
      })) };
    } finally { client.release(); }
  }

  async action(actor: Identity, id: string, body: unknown, key: string, requestId: string): Promise<TicketReceipt> {
    validateAction(body);
    return this.transaction(async client => {
      await this.requireActive(client, actor);
      const ticket = await this.accessible(client, actor, id, true);
      const previous = await this.claim(client, actor.id, `action:${id}`, key, body);
      if (previous) return previous as TicketReceipt;
      if (ticket.version !== body.expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      const member = await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2', [actor.id, ticket.owner_group_id]);
      const role = ticket.requester_id === actor.id && ['ADD_INFO','CONFIRM','REOPEN','CANCEL'].includes(body.action)
        ? 'requester' : member.rowCount ? 'agent' : 'requester';
      const next = transition(ticket.status, role, body);
      const before = ticket.status;
      const updated = await client.query<TicketRow>('UPDATE tickets SET status=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [id, next]);
      await this.record(client, updated.rows[0], actor.id, body.action, before,
        { comment: body.comment, reason: body.reason, dueAt: body.dueAt, vendorReference: body.vendorReference, vendorOwner: body.vendorOwner, resolutionCategory: body.resolutionCategory, evidence: body.evidence }, requestId);
      const response = this.receipt(updated.rows[0]);
      await client.query('UPDATE api_idempotency SET response=$4 WHERE actor_id=$1 AND scope=$2 AND key=$3', [actor.id, `action:${id}`, key, JSON.stringify(response)]);
      return response;
    });
  }
}
