import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, NotFoundException, Param, Post } from '@nestjs/common';
import { validServiceCalendar } from '@itsm/contracts';
import type { PoolClient } from 'pg';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK, ROLE_EFFECTIVE_SQL } from './role-policy.js';
type H = Record<string, string | undefined>;
const auth = (h: H) => ({ devUser: h['x-dev-user'], cookie: h.cookie, csrf: h['x-csrf-token'] });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const reason = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 500;

@Controller('admin/sla-calendar')
export class SlaCalendarController {
  constructor(private readonly db: Database, private readonly identity: AuthService, private readonly intake: IntakePolicyService) {}
  private async lock(client: PoolClient, actor: string) {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ROLE_AUTHORIZATION_LOCK]);
    if (!(await client.query('SELECT 1 FROM employees WHERE id=$1 AND active FOR SHARE', [actor])).rowCount
      || !(await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
        AND r.group_id IS NULL AND ${ROLE_EFFECTIVE_SQL}`, [actor])).rowCount)
      throw new ForbiddenException({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await client.query('SELECT pg_advisory_xact_lock(84372913)');
  }
  @Get() async list(@Headers() h: H) {
    const actor = await this.identity.identity(auth(h));
    return this.db.transaction(async client => {
      await this.lock(client, actor.id);
      const current = (await client.query('SELECT * FROM sla_calendars ORDER BY version DESC LIMIT 1')).rows[0];
      const proposals = (await client.query("SELECT * FROM sla_calendar_proposals ORDER BY (status='PENDING') DESC,created_at DESC,id LIMIT 100")).rows;
      const history = (await client.query('SELECT * FROM sla_calendars ORDER BY version DESC LIMIT 100')).rows;
      return { current, proposals, history };
    });
  }
  @Post() async propose(@Headers() h: H, @Body() body: unknown) {
    const actor = await this.identity.identity(auth(h), true);
    if (!object(body) || Object.keys(body).some(k => !['id','expectedVersion','config','reason','contentClass'].includes(k))
      || !uuid.test(String(body.id)) || !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1
      || !reason(body.reason) || !validServiceCalendar(body.config)) throw new BadRequestException({ code: 'INVALID_SERVICE_CALENDAR' });
    await this.intake.requireGeneral(actor.id, body, 'sla-calendar');
    return this.db.transaction(async client => {
      await this.lock(client, actor.id);
      const existing = await client.query('SELECT *,config=$2::jsonb AS same FROM sla_calendar_proposals WHERE id=$1', [body.id, JSON.stringify(body.config)]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.proposed_by !== actor.id || !row.same || row.expected_version !== body.expectedVersion || row.reason !== String(body.reason).trim())
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return row;
      }
      const current = (await client.query('SELECT max(version) AS version FROM sla_calendars')).rows[0];
      if (current.version !== body.expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      const result = await client.query(`INSERT INTO sla_calendar_proposals(id,expected_version,config,proposed_by,reason)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [body.id, body.expectedVersion, JSON.stringify(body.config), actor.id, String(body.reason).trim()]);
      await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)', [actor.id, 'SLA_CALENDAR_PROPOSED', body.id]);
      return result.rows[0];
    });
  }
  @Post(':id/review') async review(@Headers() h: H, @Param('id') id: string, @Body() body: unknown) {
    const actor = await this.identity.identity(auth(h), true);
    if (!uuid.test(id)) throw new NotFoundException();
    if (!object(body) || Object.keys(body).some(k => !['expectedVersion','decision','reason','contentClass'].includes(k))
      || !Number.isInteger(body.expectedVersion) || !['APPROVE','REJECT'].includes(String(body.decision)) || !reason(body.reason))
      throw new BadRequestException({ code: 'INVALID_SERVICE_CALENDAR' });
    await this.intake.requireGeneral(actor.id, body, 'sla-calendar');
    return this.db.transaction(async client => {
      await this.lock(client, actor.id);
      const found = await client.query('SELECT * FROM sla_calendar_proposals WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rowCount) throw new NotFoundException();
      const p = found.rows[0];
      if (p.proposed_by === actor.id) throw new ForbiddenException({ code: 'CALENDAR_INDEPENDENT_REVIEW_REQUIRED' });
      if (p.version !== body.expectedVersion || p.status !== 'PENDING') throw new ConflictException({ code: 'VERSION_CONFLICT' });
      if (body.decision === 'APPROVE') {
        const proposer = await client.query(`SELECT 1 FROM employees e JOIN role_bindings r ON r.employee_id=e.id
          WHERE e.id=$1 AND e.active AND r.role_code='PLATFORM_ADMIN' AND r.group_id IS NULL AND ${ROLE_EFFECTIVE_SQL} FOR SHARE OF e`, [p.proposed_by]);
        if (!proposer.rowCount) throw new ConflictException({ code: 'CALENDAR_PROPOSER_UNAVAILABLE' });
        const current = (await client.query('SELECT max(version) AS version FROM sla_calendars')).rows[0];
        if (current.version !== p.expected_version) throw new ConflictException({ code: 'VERSION_CONFLICT' });
        if (!validServiceCalendar(p.config)) throw new ConflictException({ code: 'INVALID_SERVICE_CALENDAR' });
        await client.query('INSERT INTO sla_calendars(version,config,approved,created_by) VALUES($1,$2,true,$3)', [current.version + 1, p.config, actor.id]);
      }
      const result = await client.query(`UPDATE sla_calendar_proposals SET status=$2,reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1
        WHERE id=$1 RETURNING *`, [id, body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', actor.id, String(body.reason).trim()]);
      await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)', [actor.id, `SLA_CALENDAR_${body.decision}`, id]);
      return result.rows[0];
    });
  }
}
