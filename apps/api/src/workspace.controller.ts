import { BadRequestException, Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
type H = Record<string,string | undefined>;
const auth = (h: H) => ({ devUser: h['x-dev-user'], cookie: h.cookie, csrf: h['x-csrf-token'] });

@Controller()
export class WorkspaceController {
  constructor(private readonly db: Database, private readonly identity: AuthService) {}
  @Get('catalog') async catalog(@Headers() h: H) {
    const actor = await this.identity.identity(auth(h));
    const result = await this.db.pool.query(`SELECT * FROM service_catalog WHERE published=true AND (visible_groups='[]'::jsonb OR EXISTS
      (SELECT 1 FROM group_memberships WHERE employee_id=$1 AND visible_groups ? group_id)) ORDER BY code`,[actor.id]);
    return { items: result.rows.map(r => ({ code:r.code,name:r.name || r.code,description:r.description,type:r.type,formVersion:r.form_version,fields:r.field_schema,available:r.type === 'INC' })) };
  }
  @Get('support-groups') async groups(@Headers() h: H) {
    const actor = await this.identity.identity(auth(h)); if (!actor.groups.length) throw new NotFoundException();
    return { items: (await this.db.pool.query('SELECT id,name FROM support_groups ORDER BY name')).rows };
  }
  @Get('notifications') async notifications(@Headers() h: H) {
    const actor = await this.identity.identity(auth(h)); if (!actor.groups.length) throw new NotFoundException();
    const result = await this.db.pool.query(`SELECT d.id,d.state,d.attempts,d.last_error AS "lastError",d.updated_at AS "updatedAt",t.number
      FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id JOIN tickets t ON t.id=o.ticket_id
      WHERE t.owner_group_id=ANY($1::text[]) ORDER BY d.updated_at DESC LIMIT 100`,[actor.groups]);
    return { mode: process.env.NOTIFICATION_MODE ?? 'disabled', items:result.rows };
  }
  @Post('notifications/:id/retry') @HttpCode(200) async retry(@Headers() h: H,@Param('id') id: string) {
    const actor = await this.identity.identity(auth(h),true); if (!actor.groups.length) throw new NotFoundException();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new NotFoundException();
    return this.db.transaction(async client => {
      const result = await client.query(`UPDATE notification_deliveries d SET state='PENDING',attempts=0,next_at=now(),last_error=NULL,updated_at=now()
        FROM outbox_events o,tickets t WHERE d.id=$1 AND d.outbox_id=o.id AND o.ticket_id=t.id AND t.owner_group_id=ANY($2::text[])
        AND d.state='DEAD' RETURNING d.id`,[id,actor.groups]);
      if (!result.rowCount) throw new NotFoundException();
      await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES ($1,$2,$3)',[actor.id,'NOTIFICATION_RETRY',id]);
      return { ok:true };
    });
  }
  @Get('voice/config') async voiceConfig(@Headers() h: H) {
    await this.identity.identity(auth(h));
    return { recordingEnabled: process.env.ASR_DATA_APPROVED === 'true' && !!process.env.ITSM_ASR_URL, maxSeconds:30 };
  }
  @Post('voice/transcribe') @HttpCode(200) async transcribe(@Headers() h: H,@Body() body: unknown) {
    const actor = await this.identity.identity(auth(h),true); await this.rateLimit(actor.id);
    if (process.env.ASR_DATA_APPROVED !== 'true' || !process.env.ITSM_ASR_URL) throw new ServiceUnavailableException({ code:'ASR_UNAVAILABLE' });
    const b = body as Record<string,unknown>;
    if (!b || Object.keys(b).some(k => !['audio','mimeType','consent'].includes(k)) || b.consent !== true || typeof b.audio !== 'string'
      || b.audio.length > 2700000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.audio) || !['audio/webm','audio/ogg','audio/mp4'].includes(String(b.mimeType))) throw new BadRequestException({ code:'INVALID_AUDIO' });
    try {
      const response = await fetch(process.env.ITSM_ASR_URL, { method:'POST',headers:{ 'Content-Type':'application/json',...(process.env.ITSM_ASR_TOKEN ? { Authorization:`Bearer ${process.env.ITSM_ASR_TOKEN}` } : {}) },
        body:JSON.stringify({ audio:b.audio,mimeType:b.mimeType }),signal:AbortSignal.timeout(20000) });
      const data = await response.json() as { text?:string };
      if (!response.ok || typeof data.text !== 'string' || data.text.length > 4000 || !data.text.trim()) throw new Error('ASR_FAILED');
      return { text:data.text };
    } catch { throw new ServiceUnavailableException({ code:'ASR_UNAVAILABLE' }); }
  }
  private async rateLimit(employee: string) {
    const result = await this.db.pool.query(`INSERT INTO intake_rate_limits(employee_id,bucket,count) VALUES ($1,date_trunc('minute',now()),1)
      ON CONFLICT(employee_id,bucket) DO UPDATE SET count=intake_rate_limits.count+1 RETURNING count`,[employee]);
    if (result.rows[0].count > 10) throw new BadRequestException({ code:'INTAKE_RATE_LIMITED' });
  }
  @Post('voice/interpret') @HttpCode(200) async interpret(@Headers() h: H,@Body() body: unknown) {
    const actor = await this.identity.identity(auth(h),true); await this.rateLimit(actor.id);
    const b = body as { text?:unknown };
    if (!b || Object.keys(b).join(',') !== 'text' || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000) throw new BadRequestException({ code:'INVALID_TRANSCRIPT' });
    // Local extraction never executes tools or sends transcripts to an external model.
    const text = b.text.trim(), system = /\b(ERP|WMS|MES|SRM)\b/i.exec(text)?.[1]?.toUpperCase();
    const requested = /申请|开通|授权|权限|批准/.test(text);
    const code = requested ? null : system ? 'INC-BIZ' : /网络|断网|VPN/i.test(text) ? 'INC-NET' : /邮箱|邮件/.test(text) ? 'INC-MAIL' : /电脑|显示器|打印机/.test(text) ? 'INC-PC' : null;
    const candidate = { serviceCode:code,subject:text.slice(0,80),description:text,fields:system ? { system } : {},
      missingFields:['impact','urgency',...(code ? [] : ['serviceCode'])],requiresReview:true,interpreter:'local-rules' };
    const draft = await this.db.pool.query('INSERT INTO voice_drafts(employee_id,candidate) VALUES ($1,$2) RETURNING id,expires_at AS "expiresAt"',[actor.id,JSON.stringify(candidate)]);
    return { ...draft.rows[0],candidate };
  }
}
