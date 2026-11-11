import { BadRequestException, Controller, Get, Headers, NotFoundException, Query, ServiceUnavailableException } from '@nestjs/common';
import { serviceMinutes, type ServiceCalendar } from '@itsm/contracts';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';

function reportDate(value: string | undefined): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException({ code: 'INVALID_REPORT_WINDOW' });
  const day = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value)
    throw new BadRequestException({ code: 'INVALID_REPORT_WINDOW' });
  return day;
}

type Cycle = {
  ticket_id: string; cycle: number; priority: string; calendar_snapshot: ServiceCalendar & { approved?: boolean };
  started_at: Date; responded_at: Date | null; completed_at: Date | null; paused_at: Date | null;
  paused_minutes: number; response_target: number; resolution_target: number; clock: Date;
};

@Controller('reports')
export class ReportsController {
  constructor(private readonly db: Database, private readonly auth: AuthService) {}

  @Get('summary') async summary(@Headers('x-dev-user') devUser?: string, @Headers('cookie') cookie?: string,
    @Query('groupId') groupId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const actor = await this.auth.identity({ devUser, cookie });
    if (!groupId || !actor.groups.includes(groupId)) throw new NotFoundException();
    const start = reportDate(from), end = reportDate(to);
    const days = (end.getTime() - start.getTime()) / 86400000;
    if (days < 0 || days > 30) throw new BadRequestException({ code: 'INVALID_REPORT_WINDOW' });
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const membership = await client.query(`SELECT 1 FROM group_memberships m JOIN employees e ON e.id=m.employee_id
        WHERE e.id=$1 AND e.active AND m.group_id=$2`, [actor.id, groupId]);
      if (!membership.rowCount) throw new NotFoundException();
      const tickets = await client.query(`SELECT t.id,t.number,t.status,t.priority,t.created_at,f.rating,
        (SELECT count(*)::int FROM ticket_events ev WHERE ev.ticket_id=t.id AND ev.action='REOPEN') AS reopen_count
        FROM tickets t LEFT JOIN ticket_feedback f ON f.ticket_id=t.id
        WHERE t.service_type='INC' AND t.owner_group_id=$1
          AND t.created_at>=($2::date AT TIME ZONE 'Asia/Shanghai')
          AND t.created_at<(($3::date + 1) AT TIME ZONE 'Asia/Shanghai')
        ORDER BY t.created_at DESC,t.id DESC LIMIT 5001`, [groupId, from, to]);
      if (tickets.rows.length > 5000) throw new ServiceUnavailableException({ code: 'REPORT_WINDOW_TOO_LARGE' });
      const cycles = tickets.rows.length ? await client.query<Cycle>(`SELECT s.*,now() AS clock FROM sla_cycles s
        WHERE s.ticket_id=ANY($1::uuid[]) ORDER BY s.ticket_id,s.cycle`, [tickets.rows.map(t => t.id)]) : { rows: [] as Cycle[] };
      const byTicket = new Map<string, Cycle[]>();
      for (const cycle of cycles.rows) byTicket.set(cycle.ticket_id, [...(byTicket.get(cycle.ticket_id) ?? []), cycle]);
      const items = tickets.rows.map(ticket => {
        const history = byTicket.get(ticket.id) ?? [];
        const measured = history.map(cycle => {
          const endAt = cycle.completed_at ?? cycle.clock;
          const always = cycle.priority === 'P1';
          const responseMinutes = serviceMinutes(cycle.started_at, cycle.responded_at ?? endAt, cycle.calendar_snapshot, always);
          const resolutionMinutes = Math.max(0, serviceMinutes(cycle.started_at, endAt, cycle.calendar_snapshot, always)
            - cycle.paused_minutes - (cycle.paused_at && !cycle.completed_at
              ? serviceMinutes(cycle.paused_at, endAt, cycle.calendar_snapshot, always) : 0));
          return { cycle: cycle.cycle, responseMinutes, resolutionMinutes, responded: !!cycle.responded_at,
            completed: !!cycle.completed_at, responseTarget: cycle.response_target, resolutionTarget: cycle.resolution_target,
            responseOverdue: responseMinutes > cycle.response_target, resolutionOverdue: resolutionMinutes > cycle.resolution_target,
            calendarApproved: cycle.calendar_snapshot.approved === true };
        });
        const first = measured[0], latest = measured.at(-1);
        return { id: ticket.id, number: ticket.number, createdAt: ticket.created_at, status: ticket.status,
          priority: ticket.priority, reopenCount: ticket.reopen_count as number, rating: ticket.rating as number | null,
          firstResponse: first ? { responded: first.responded, minutes: first.responseMinutes, target: first.responseTarget,
            overdue: first.responseOverdue } : null,
          resolution: latest ? { completed: latest.completed && ['CLOSED', 'PENDING_CONFIRMATION'].includes(ticket.status),
            minutes: latest.resolutionMinutes, target: latest.resolutionTarget, overdue: latest.resolutionOverdue } : null,
          overdueEver: measured.some(c => c.responseOverdue || c.resolutionOverdue),
          unapprovedCalendar: measured.some(c => !c.calendarApproved), cycles: measured };
      });
      const ratings = items.filter(item => item.rating !== null).map(item => item.rating!);
      return { groupId, from, to, timeZone: 'Asia/Shanghai', attribution: 'CURRENT_OWNER_GROUP',
        metrics: { tickets: items.length, responded: items.filter(i => i.firstResponse?.responded).length,
          firstResponseOverdue: items.filter(i => i.firstResponse?.overdue).length,
          resolved: items.filter(i => i.resolution?.completed).length,
          resolutionOverdue: items.filter(i => i.resolution?.overdue).length,
          overdueTickets: items.filter(i => i.overdueEver).length,
          reopenedTickets: items.filter(i => i.reopenCount > 0).length,
          rated: ratings.length, satisfactionAverage: ratings.length ? Math.round(ratings.reduce((a,b) => a+b,0) / ratings.length * 100) / 100 : null,
          unapprovedCalendarTickets: items.filter(i => i.unapprovedCalendar).length }, items };
    });
  }
}
