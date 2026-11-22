import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DEFAULT_CALENDAR, SLA_TARGETS, serviceMinutes, prioritySlaMeasurements, type PriorityPolicy } from '@itsm/contracts';
import { randomUUID } from 'node:crypto';

@Injectable()
export class SlaService {
  async start(client: PoolClient, ticketId: string, priority: string, reopen = false) {
    const calendar = await client.query('SELECT version,config,approved FROM sla_calendars ORDER BY version DESC LIMIT 1');
    const snapshot = { ...(calendar.rows[0]?.config ?? DEFAULT_CALENDAR), version: calendar.rows[0]?.version ?? 1, approved: calendar.rows[0]?.approved ?? false };
    const policy=await client.query(reopen?'SELECT config FROM priority_policy_versions ORDER BY version DESC LIMIT 1'
      :"SELECT priority_policy_snapshot->'config' AS config FROM tickets WHERE id=$1",reopen?[]:[ticketId]);
    const template=(await client.query(`SELECT v.version,tpl FROM operations_current v JOIN tickets t ON t.id=$1,
      jsonb_array_elements(v.config->'serviceSlas') binding,jsonb_array_elements(v.config->'slaTemplates') tpl
      WHERE binding->>'serviceCode'=t.service_code AND tpl->>'id'=binding->>'templateId' AND (tpl->>'enabled')::boolean`,[ticketId])).rows[0];
    const templateSnapshot=template?{...template.tpl,configVersion:template.version}:{};
    const target = template?.tpl.targets[priority]??policy.rows[0]?.config.targets[priority]??SLA_TARGETS[priority];
    await client.query(`INSERT INTO sla_cycles(ticket_id,cycle,priority,calendar_snapshot,started_at,response_target,resolution_target,responded_at,template_snapshot)
      SELECT $1,COALESCE(max(cycle),0)+1,$2,$3,now(),$4,$5,CASE WHEN $6 THEN now() ELSE NULL END,$7 FROM sla_cycles WHERE ticket_id=$1`,
      [ticketId, priority, JSON.stringify(snapshot), target.response, target.resolution, reopen,JSON.stringify(templateSnapshot)]);
  }
  async upgrade(client:PoolClient,ticketId:string,priority:string,policy:PriorityPolicy) {
    const row=(await client.query('SELECT *,now() AS clock FROM sla_cycles WHERE ticket_id=$1 ORDER BY cycle DESC LIMIT 1 FOR UPDATE',[ticketId])).rows[0];
    if(!row||row.completed_at)return;
    const target=row.template_snapshot?.targets?.[priority]??policy.targets[priority as keyof typeof policy.targets];
    await client.query(`UPDATE sla_cycles SET priority_obligations=priority_obligations||$3::jsonb WHERE ticket_id=$1 AND cycle=$2`,
      [ticketId,row.cycle,JSON.stringify([{id:randomUUID(),priority,startedAt:row.clock.toISOString(),responseTarget:target.response,resolutionTarget:target.resolution}])]);
  }
  async action(client: PoolClient, ticketId: string, action: string, priority: string) {
    if (action === 'REOPEN') return this.start(client, ticketId, priority, true);
    const result = await client.query('SELECT *,now() AS clock FROM sla_cycles WHERE ticket_id=$1 ORDER BY cycle DESC LIMIT 1 FOR UPDATE', [ticketId]);
    const row = result.rows[0]; if (!row || row.completed_at) return;
    if (action === 'REQUEST_INFO') await client.query("UPDATE sla_cycles SET paused_at=now(),pause_reason='USER' WHERE ticket_id=$1 AND cycle=$2 AND paused_at IS NULL", [ticketId,row.cycle]);
    if (action === 'ADD_INFO' && row.paused_at) {
      const minutes = serviceMinutes(row.paused_at, row.clock, row.calendar_snapshot, row.priority === 'P1');
      await client.query('UPDATE sla_cycles SET paused_at=NULL,pause_reason=NULL,paused_minutes=paused_minutes+$3 WHERE ticket_id=$1 AND cycle=$2', [ticketId,row.cycle,minutes]);
    }
    if (['RESOLVE','CANCEL'].includes(action)) await client.query('UPDATE sla_cycles SET completed_at=now() WHERE ticket_id=$1 AND cycle=$2', [ticketId,row.cycle]);
  }
  async view(client: PoolClient, ticketId: string) {
    const result = await client.query('SELECT *,now() AS clock FROM sla_cycles WHERE ticket_id=$1 ORDER BY cycle', [ticketId]);
    return result.rows.map(row => {
      const [base,...obligations]=prioritySlaMeasurements(row,row.clock);
      const {responseMinutes,resolutionMinutes}=base;
      return { cycle: row.cycle, priority: row.priority, responseTarget: row.response_target, resolutionTarget: row.resolution_target,
        responseMinutes, resolutionMinutes, responded: !!row.responded_at, completed: !!row.completed_at,
        paused: !!row.paused_at && !row.completed_at,pauseReason:row.pause_reason, obligations,breached: base.breached||obligations.some(o=>o.breached),
        calendarApproved: row.calendar_snapshot.approved, calendarVersion: row.calendar_snapshot.version,
        template:row.template_snapshot?.id?row.template_snapshot:null };
    });
  }
}
