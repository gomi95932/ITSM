import { BadRequestException, Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK, ROLE_EFFECTIVE_SQL } from './role-policy.js';
import { requestIntakePolicy } from './request-intake-policy.js';
import { VoiceAsrService } from './voice-asr.service.js';
import { voiceCandidate } from './voice-catalog.js';
type H = Record<string,string | undefined>;
const auth = (h: H) => ({ devUser: h['x-dev-user'], cookie: h.cookie, csrf: h['x-csrf-token'] });

@Controller()
export class WorkspaceController {
  constructor(private readonly db: Database, private readonly identity: AuthService, private readonly intake: IntakePolicyService, private readonly voice: VoiceAsrService) {}
  @Get('intake-policy') async intakePolicy(@Headers() h: H) {
    await this.identity.identity(auth(h));
    return this.intake.config();
  }
  @Get('catalog') async catalog(@Headers() h: H) {
    const actor = await this.identity.identity(auth(h));
    const result = await this.db.pool.query(`SELECT c.*,v.snapshot FROM service_catalog c LEFT JOIN request_catalog_versions v
      ON v.service_code=c.code AND v.form_version=c.form_version WHERE c.published=true AND (c.visible_groups='[]'::jsonb OR EXISTS
      (SELECT 1 FROM group_memberships WHERE employee_id=$1 AND c.visible_groups ? group_id)) ORDER BY c.sort_order,c.code`,[actor.id]);
    return { items: result.rows.map(r => ({ code:r.code,name:r.name || r.code,description:r.description,type:r.type,formVersion:r.form_version,fields:r.field_schema,
      available:['INC','GEN'].includes(r.type)||(r.type==='REQ'&&!!r.snapshot?.approval?.steps?.length
        &&!!requestIntakePolicy(process.env,r.code,r.form_version)),maxValidityDays:r.type==='REQ'?r.snapshot?.maxValidityDays??null:null })) };
  }
  @Get('support-groups') async groups(@Headers() h: H) {
    const actor = await this.identity.identity(auth(h)); if (!actor.groups.length) throw new NotFoundException();
    return { items: (await this.db.pool.query('SELECT id,name FROM support_groups WHERE enabled ORDER BY name')).rows };
  }
  @Get('support-groups/:id/members') async members(@Headers() h: H,@Param('id') id: string) {
    const actor = await this.identity.identity(auth(h)); if (!actor.groups.length) throw new NotFoundException();
    if (!(await this.db.pool.query('SELECT id FROM support_groups WHERE id=$1 AND enabled',[id])).rowCount) throw new NotFoundException();
    return { items:(await this.db.pool.query(`SELECT e.id,e.display_name AS name FROM employees e
      JOIN group_memberships m ON m.employee_id=e.id WHERE m.group_id=$1 AND e.active ORDER BY e.display_name,e.id`,[id])).rows };
  }
  @Get('notifications') async notifications(@Headers() h: H) {
    const actor = await this.identity.identity(auth(h)); if (!actor.groups.length) throw new NotFoundException();
    const result = await this.db.pool.query(`SELECT d.id,d.state,d.attempts,d.last_error AS "lastError",d.updated_at AS "updatedAt",t.number,
      (d.state='DEAD' AND EXISTS(SELECT 1 FROM role_bindings r WHERE r.employee_id=$2 AND r.group_id=t.owner_group_id
        AND r.role_code IN ('DISPATCHER','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL})) AS "canRetry"
      FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id JOIN tickets t ON t.id=o.ticket_id
      WHERE t.owner_group_id=ANY($1::text[])
      ORDER BY (d.state='REVIEW_REQUIRED') DESC,d.updated_at DESC,d.id LIMIT 100`,[actor.groups,actor.id]);
    return { mode: process.env.NOTIFICATION_MODE ?? 'disabled', items:result.rows };
  }
  @Get('routing-alerts') async routingAlerts(@Headers() h: H) {
    const actor = await this.identity.identity(auth(h));
    const result = await this.db.pool.query(`SELECT t.id AS "ticketId",t.number,a.owner_group_id AS "ownerGroupId",
      g.name AS "ownerGroupName",a.reason,a.opened_at AS "openedAt"
      FROM ticket_routing_alerts a JOIN tickets t ON t.id=a.ticket_id
      JOIN support_groups g ON g.id=a.owner_group_id
      WHERE a.resolved_at IS NULL AND (
        EXISTS(SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
          AND ${ROLE_EFFECTIVE_SQL}) OR
        EXISTS(SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.group_id=a.owner_group_id
          AND r.role_code IN ('DISPATCHER','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL}))
      ORDER BY a.opened_at,a.ticket_id LIMIT 100`,[actor.id]);
    return { items:result.rows };
  }
  @Post('notifications/:id/retry') @HttpCode(200) async retry(@Headers() h: H,@Param('id') id: string) {
    const actor = await this.identity.identity(auth(h),true); if (!actor.groups.length) throw new NotFoundException();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new NotFoundException();
    return this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
      const result = await client.query(`UPDATE notification_deliveries d SET
        state=CASE WHEN d.provider_task_id IS NOT NULL THEN 'SENDING' ELSE 'PENDING' END,
        attempts=0,next_at=now(),last_error=NULL,updated_at=now()
        FROM outbox_events o,tickets t WHERE d.id=$1 AND d.outbox_id=o.id AND o.ticket_id=t.id AND t.owner_group_id=ANY($2::text[])
        AND d.state='DEAD' AND EXISTS(SELECT 1 FROM role_bindings r WHERE r.employee_id=$3 AND r.group_id=t.owner_group_id
          AND r.role_code IN ('DISPATCHER','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL}) RETURNING d.id`,[id,actor.groups,actor.id]);
      if (!result.rowCount) throw new NotFoundException();
      await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES ($1,$2,$3)',[actor.id,'NOTIFICATION_RETRY',id]);
      return { ok:true };
    });
  }
  @Get('voice/config') async voiceConfig(@Headers() h: H) {
    await this.identity.identity(auth(h));
    return this.voice.config();
  }
  @Post('voice/transcribe') @HttpCode(200) async transcribe(@Headers() h: H,@Body() body: unknown) {
    const actor = await this.identity.identity(auth(h),true); await this.rateLimit(actor.id);
    // Configuration stays closed until the operator records approval for the internal audio boundary.
    if(!this.voice.config().recordingEnabled)return this.voice.transcribe(body);
    const b=body as Record<string,unknown>;
    if(!b||typeof b!=='object'||Array.isArray(b))throw new BadRequestException({code:'INVALID_AUDIO'});
    await this.intake.requireGeneral(actor.id,{contentClass:b.contentClass},'voice-transcribe');
    const result=await this.voice.transcribe(body);
    await this.intake.requireGeneral(actor.id,{contentClass:'GENERAL',text:result.text},'voice-transcribe');
    await this.identity.identity(auth(h),true);
    return result;
  }
  private async rateLimit(employee: string) {
    const result = await this.db.pool.query(`INSERT INTO intake_rate_limits(employee_id,bucket,count) VALUES ($1,date_trunc('minute',now()),1)
      ON CONFLICT(employee_id,bucket) DO UPDATE SET count=intake_rate_limits.count+1 RETURNING count`,[employee]);
    if (result.rows[0].count > 10) throw new BadRequestException({ code:'INTAKE_RATE_LIMITED' });
  }
  @Post('voice/interpret') @HttpCode(200) async interpret(@Headers() h: H,@Body() body: unknown) {
    const actor = await this.identity.identity(auth(h),true); await this.rateLimit(actor.id);
    const b = body as Record<string,unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['text','contentClass'].includes(k)) || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000) throw new BadRequestException({ code:'INVALID_TRANSCRIPT' });
    await this.intake.requireGeneral(actor.id, b, 'voice-interpret');
    const visible=await this.catalog(h);
    const candidate=voiceCandidate(b.text.trim(),visible.items);
    const draft = await this.db.pool.query('INSERT INTO voice_drafts(employee_id,candidate) VALUES ($1,$2) RETURNING id,expires_at AS "expiresAt"',[actor.id,JSON.stringify(candidate)]);
    return { ...draft.rows[0],candidate };
  }
}
