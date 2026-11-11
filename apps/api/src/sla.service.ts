import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DEFAULT_CALENDAR, SLA_TARGETS, serviceMinutes, type ServiceCalendar } from '@itsm/contracts';

@Injectable()
export class SlaService {
  async start(client: PoolClient, ticketId: string, priority: string, reopen = false) {
    const calendar = await client.query('SELECT version,config,approved FROM sla_calendars ORDER BY version DESC LIMIT 1');
    const snapshot = { ...(calendar.rows[0]?.config ?? DEFAULT_CALENDAR), version: calendar.rows[0]?.version ?? 1, approved: calendar.rows[0]?.approved ?? false };
    const target = SLA_TARGETS[priority];
    await client.query(`INSERT INTO sla_cycles(ticket_id,cycle,priority,calendar_snapshot,started_at,response_target,resolution_target,responded_at)
      SELECT $1,COALESCE(max(cycle),0)+1,$2,$3,now(),$4,$5,CASE WHEN $6 THEN now() ELSE NULL END FROM sla_cycles WHERE ticket_id=$1`,
      [ticketId, priority, JSON.stringify(snapshot), target.response, target.resolution, reopen]);
  }
  async action(client: PoolClient, ticketId: string, action: string, priority: string) {
    if (action === 'REOPEN') return this.start(client, ticketId, priority, true);
    const result = await client.query('SELECT *,now() AS clock FROM sla_cycles WHERE ticket_id=$1 ORDER BY cycle DESC LIMIT 1 FOR UPDATE', [ticketId]);
    const row = result.rows[0]; if (!row || row.completed_at) return;
    if (action === 'REQUEST_INFO') await client.query('UPDATE sla_cycles SET paused_at=now() WHERE ticket_id=$1 AND cycle=$2 AND paused_at IS NULL', [ticketId,row.cycle]);
    if (action === 'ADD_INFO' && row.paused_at) {
      const minutes = serviceMinutes(row.paused_at, row.clock, row.calendar_snapshot, row.priority === 'P1');
      await client.query('UPDATE sla_cycles SET paused_at=NULL,paused_minutes=paused_minutes+$3 WHERE ticket_id=$1 AND cycle=$2', [ticketId,row.cycle,minutes]);
    }
    if (['RESOLVE','CANCEL'].includes(action)) await client.query('UPDATE sla_cycles SET completed_at=now() WHERE ticket_id=$1 AND cycle=$2', [ticketId,row.cycle]);
  }
  async view(client: PoolClient, ticketId: string) {
    const result = await client.query('SELECT *,now() AS clock FROM sla_cycles WHERE ticket_id=$1 ORDER BY cycle', [ticketId]);
    return result.rows.map(row => {
      const calendar = row.calendar_snapshot as ServiceCalendar;
      const end: Date = row.completed_at ?? row.clock;
      const responseMinutes = serviceMinutes(row.started_at, row.responded_at ?? end, calendar, row.priority === 'P1');
      const resolutionMinutes = Math.max(0, serviceMinutes(row.started_at, end, calendar, row.priority === 'P1') - row.paused_minutes
        - (row.paused_at ? serviceMinutes(row.paused_at,end,calendar,row.priority === 'P1') : 0));
      return { cycle: row.cycle, priority: row.priority, responseTarget: row.response_target, resolutionTarget: row.resolution_target,
        responseMinutes, resolutionMinutes, responded: !!row.responded_at, completed: !!row.completed_at,
        paused: !!row.paused_at && !row.completed_at, breached: responseMinutes > row.response_target || resolutionMinutes > row.resolution_target,
        calendarApproved: row.calendar_snapshot.approved, calendarVersion: row.calendar_snapshot.version };
    });
  }
}
