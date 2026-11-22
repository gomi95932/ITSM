import { BadRequestException, Controller, Get, Headers, NotFoundException, Query, ServiceUnavailableException } from '@nestjs/common';
import { prioritySlaMeasurements, type ServiceCalendar,type PriorityObligation } from '@itsm/contracts';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { ownerMatches, reportMetrics, reportOwnerFilter, reportServiceFilter, responsibilitySummary,
  serviceMatches, serviceSummary, waitingSummary } from './report-metrics.js';
import { ticketWaiting } from './ticket-waiting.js';
import { historicalResponsibilitySummary, intervalMetrics, type ResponsibilityInterval } from './responsibility-history.js';
import { notificationFilter, notificationMatches, notificationMetrics, notificationReason, notificationState,
  type NotificationReportItem } from './notification-report.js';

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
  priority_obligations:PriorityObligation[];pause_history:{from:string;to:string}[];
};

@Controller('reports')
export class ReportsController {
  constructor(private readonly db: Database, private readonly auth: AuthService) {}

  @Get('notifications') async notifications(@Headers('x-dev-user') devUser?: string, @Headers('cookie') cookie?: string,
    @Query('groupId') groupId?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('serviceType') serviceType: string = 'INC', @Query('state') state?: string) {
    const actor = await this.auth.identity({ devUser, cookie });
    if (!groupId || !actor.groups.includes(groupId)) throw new NotFoundException();
    if (serviceType !== 'INC' && serviceType !== 'REQ') throw new BadRequestException({ code: 'INVALID_REPORT_SERVICE_TYPE' });
    const filter = notificationFilter(state);
    if (!filter) throw new BadRequestException({ code: 'INVALID_NOTIFICATION_REPORT_FILTER' });
    const start = reportDate(from), end = reportDate(to);
    const days = (end.getTime() - start.getTime()) / 86400000;
    if (days < 0 || days > 30) throw new BadRequestException({ code: 'INVALID_REPORT_WINDOW' });
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const membership = await client.query(`SELECT now() AS clock FROM group_memberships m
        JOIN employees e ON e.id=m.employee_id JOIN support_groups g ON g.id=m.group_id
        WHERE e.id=$1 AND e.active AND g.enabled AND m.group_id=$2`, [actor.id, groupId]);
      if (!membership.rowCount) throw new NotFoundException();
      const window = [groupId, serviceType, from, to, actor.id];
      const coverage = (await client.query(`SELECT count(*)::int AS events,
          count(*) FILTER(WHERE o.expanded_at IS NULL)::int AS unexpanded,
          count(*) FILTER(WHERE o.expanded_at IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM notification_deliveries d WHERE d.outbox_id=o.id))::int AS without_deliveries
        FROM outbox_events o JOIN tickets t ON t.id=o.ticket_id
        WHERE t.owner_group_id=$1 AND t.service_type=$2 AND staff_site_access(t.service_routing_snapshot,$5,t.owner_group_id)
          AND o.created_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND o.created_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`, window)).rows[0];
      const rows = await client.query(`SELECT d.id,o.ticket_id,t.number,o.created_at AS event_at,d.updated_at,
          d.state,d.attempts,d.last_error FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id
        JOIN tickets t ON t.id=o.ticket_id WHERE t.owner_group_id=$1 AND t.service_type=$2 AND staff_site_access(t.service_routing_snapshot,$5,t.owner_group_id)
          AND o.created_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND o.created_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        ORDER BY d.updated_at DESC,d.id LIMIT 5001`, window);
      if (rows.rows.length > 5000) throw new ServiceUnavailableException({ code: 'REPORT_NOTIFICATION_WINDOW_TOO_LARGE' });
      // Provider errors and recipient identities are not part of group delivery statistics.
      const all: NotificationReportItem[] = rows.rows.map(row => ({ id: row.id, ticketId: row.ticket_id,
        number: row.number, eventAt: row.event_at, updatedAt: row.updated_at, state: notificationState(row.state),
        attempts: row.attempts, reason: notificationReason(row.last_error) }));
      const items = all.filter(item => notificationMatches(item, filter));
      return { groupId, from, to, serviceType, state: filter, asOf: membership.rows[0].clock,
        timeZone: 'Asia/Shanghai', attribution: 'CURRENT_OWNER_GROUP', windowBasis: 'OUTBOX_CREATED_AT',
        coverage: { events: coverage.events, unexpandedEvents: coverage.unexpanded,
          expandedWithoutDeliveryEvents: coverage.without_deliveries },
        cohortMetrics: notificationMetrics(all), metrics: notificationMetrics(items), items };
    });
  }

  @Get('responsibility-history') async history(@Headers('x-dev-user') devUser?: string, @Headers('cookie') cookie?: string,
    @Query('groupId') groupId?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('serviceType') serviceType: string = 'INC',
    @Query('ownerScope') ownerScope?: string, @Query('employeeId') employeeId?: string) {
    const actor = await this.auth.identity({ devUser, cookie });
    if (!groupId || !actor.groups.includes(groupId)) throw new NotFoundException();
    if (serviceType !== 'INC' && serviceType !== 'REQ') throw new BadRequestException({ code: 'INVALID_REPORT_SERVICE_TYPE' });
    const ownerFilter = reportOwnerFilter(ownerScope, employeeId);
    if (!ownerFilter) throw new BadRequestException({ code: 'INVALID_REPORT_OWNER_FILTER' });
    const start = reportDate(from), end = reportDate(to);
    const days = (end.getTime() - start.getTime()) / 86400000;
    if (days < 0 || days > 30) throw new BadRequestException({ code: 'INVALID_REPORT_WINDOW' });
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const membership = await client.query<{ as_of: Date; recording_started_at: Date; window_start: Date; window_end: Date }>(`
        SELECT clock_timestamp() AS as_of,r.started_at AS recording_started_at,
          ($3::date::timestamp AT TIME ZONE 'Asia/Shanghai') AS window_start,
          (($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS window_end
        FROM group_memberships m JOIN employees e ON e.id=m.employee_id CROSS JOIN responsibility_recording r
        WHERE e.id=$1 AND e.active AND m.group_id=$2`, [actor.id, groupId, from, to]);
      if (!membership.rowCount) throw new NotFoundException();
      const clock = membership.rows[0];
      const rows = await client.query(`SELECT h.*,n.observed_at AS next_at,f.source AS history_origin,
          f.observed_at AS first_recorded_at,greatest(h.observed_at,$3::timestamptz) AS interval_from,
          least(coalesce(n.observed_at,$5::timestamptz),$4::timestamptz,$5::timestamptz) AS interval_until,
          extract(epoch FROM least(coalesce(n.observed_at,$5::timestamptz),$4::timestamptz,$5::timestamptz)
            - greatest(h.observed_at,$3::timestamptz)) AS elapsed_seconds
        FROM ticket_responsibility_history h
        JOIN ticket_responsibility_history f ON f.ticket_id=h.ticket_id AND f.revision=1
        LEFT JOIN LATERAL (SELECT observed_at FROM ticket_responsibility_history
          WHERE ticket_id=h.ticket_id AND revision>h.revision ORDER BY revision LIMIT 1) n ON true
        WHERE h.owner_group_id=$1 AND h.service_type=$2
          AND EXISTS(SELECT 1 FROM tickets scoped WHERE scoped.id=h.ticket_id AND staff_site_access(scoped.service_routing_snapshot,$6,h.owner_group_id))
          AND h.observed_at<least($4::timestamptz,$5::timestamptz)
          AND least(coalesce(n.observed_at,$5::timestamptz),$4::timestamptz,$5::timestamptz)
            > greatest(h.observed_at,$3::timestamptz)
        ORDER BY h.observed_at DESC,h.ticket_id,h.revision DESC LIMIT 5001`,
      [groupId, serviceType, clock.window_start, clock.window_end, clock.as_of, actor.id]);
      if (rows.rows.length > 5000) throw new ServiceUnavailableException({ code: 'REPORT_HISTORY_WINDOW_TOO_LARGE' });
      // Do not join current ticket details or expose the next group's identity after a historical transfer.
      const items: ResponsibilityInterval[] = rows.rows.map(row => ({ ticketId: row.ticket_id, number: row.ticket_number,
        revision: row.revision, source: row.source, recordedAt: row.observed_at, from: row.interval_from,
        until: row.interval_until, elapsedSeconds: Number(row.elapsed_seconds), clockAdjusted: row.clock_adjusted,
        groupName: row.owner_group_name, assigneeId: row.assignee_id, assigneeName: row.assignee_name,
        status: row.status, pendingAcceptance: row.pending_assignee_id !== null,
        serviceCode: row.service_code, serviceType: row.service_type,
        historyOrigin: row.history_origin, firstRecordedAt: row.first_recorded_at }));
      const filtered = items.filter(item => ownerMatches(item, ownerFilter));
      return { groupId, from, to, serviceType, ownerFilter, timeZone: 'Asia/Shanghai', asOf: clock.as_of,
        attribution: 'HISTORICAL_OWNER_GROUP', windowBasis: 'INTERVAL_OVERLAP', durationBasis: 'WALL_CLOCK_SECONDS',
        recordingStartedAt: clock.recording_started_at,
        windowStartsBeforeRecording: clock.window_start < clock.recording_started_at,
        responsibility: historicalResponsibilitySummary(items), metrics: intervalMetrics(filtered), items: filtered };
    });
  }

  @Get('summary') async summary(@Headers('x-dev-user') devUser?: string, @Headers('cookie') cookie?: string,
    @Query('groupId') groupId?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('serviceType') serviceType: string = 'INC',
    @Query('ownerScope') ownerScope?: string, @Query('employeeId') employeeId?: string,
    @Query('serviceCode') serviceCode?: string) {
    const actor = await this.auth.identity({ devUser, cookie });
    if (!groupId || !actor.groups.includes(groupId)) throw new NotFoundException();
    if (serviceType !== 'INC' && serviceType !== 'REQ') throw new BadRequestException({ code: 'INVALID_REPORT_SERVICE_TYPE' });
    const ownerFilter = reportOwnerFilter(ownerScope, employeeId);
    if (!ownerFilter) throw new BadRequestException({ code: 'INVALID_REPORT_OWNER_FILTER' });
    const serviceFilter = reportServiceFilter(serviceCode);
    if (!serviceFilter) throw new BadRequestException({ code: 'INVALID_REPORT_SERVICE_FILTER' });
    const start = reportDate(from), end = reportDate(to);
    const days = (end.getTime() - start.getTime()) / 86400000;
    if (days < 0 || days > 30) throw new BadRequestException({ code: 'INVALID_REPORT_WINDOW' });
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const membership = await client.query(`SELECT now() AS clock FROM group_memberships m JOIN employees e ON e.id=m.employee_id
        JOIN support_groups g ON g.id=m.group_id WHERE e.id=$1 AND e.active AND g.enabled AND m.group_id=$2`, [actor.id, groupId]);
      if (!membership.rowCount) throw new NotFoundException();
      const tickets = await client.query(`SELECT t.id,t.number,t.status,t.priority,t.initial_priority,t.created_at,f.rating,
        (SELECT count(*)::integer FROM ticket_events e WHERE e.ticket_id=t.id
          AND e.action IN ('PRIORITY_CHANGED','PRIORITY_REVIEWED')
          AND e.detail->>'oldPriority' <> e.detail->>'priority') AS priority_change_count,
        t.service_code,c.name AS service_name,t.waiting_reason_code,t.waiting_since,t.waiting_due_at,
        t.assignee_id,a.display_name AS assignee_name,a.active AS assignee_active,
        t.pending_assignee_id,p.display_name AS pending_assignee_name,t.assignment_kind,
        (SELECT count(*)::int FROM ticket_events ev WHERE ev.ticket_id=t.id AND ev.action='REOPEN') AS reopen_count,
        (SELECT count(*)::int FROM ticket_events ev WHERE ev.ticket_id=t.id AND ev.action='ACCEPT_HANDOVER'
          AND ev.detail->>'targetGroupId'=$1) AS accepted_handover_count
        FROM tickets t LEFT JOIN ticket_feedback f ON f.ticket_id=t.id
        JOIN service_catalog c ON c.code=t.service_code
        LEFT JOIN employees a ON a.id=t.assignee_id LEFT JOIN employees p ON p.id=t.pending_assignee_id
        WHERE t.service_type=$4 AND t.owner_group_id=$1 AND staff_site_access(t.service_routing_snapshot,$5,t.owner_group_id)
          AND t.created_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND t.created_at<(($3::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        ORDER BY t.created_at DESC,t.id DESC LIMIT 5001`, [groupId, from, to, serviceType, actor.id]);
      if (tickets.rows.length > 5000) throw new ServiceUnavailableException({ code: 'REPORT_WINDOW_TOO_LARGE' });
      const cycles = tickets.rows.length ? await client.query<Cycle>(`SELECT s.*,now() AS clock FROM sla_cycles s
        WHERE s.ticket_id=ANY($1::uuid[]) ORDER BY s.ticket_id,s.cycle`, [tickets.rows.map(t => t.id)]) : { rows: [] as Cycle[] };
      const byTicket = new Map<string, Cycle[]>();
      for (const cycle of cycles.rows) byTicket.set(cycle.ticket_id, [...(byTicket.get(cycle.ticket_id) ?? []), cycle]);
      const items = tickets.rows.map(ticket => {
        const history = byTicket.get(ticket.id) ?? [];
        const measured = history.map(cycle => {
          const obligations=prioritySlaMeasurements(cycle,cycle.clock);
          const {responseMinutes,resolutionMinutes}=obligations[0];
          return { cycle: cycle.cycle, obligations, responseMinutes, resolutionMinutes, responded: !!cycle.responded_at,
            completed: !!cycle.completed_at, responseTarget: cycle.response_target, resolutionTarget: cycle.resolution_target,
            responseOverdue: obligations.some(o=>o.responseMinutes>o.responseTarget), resolutionOverdue: obligations.some(o=>o.resolutionMinutes>o.resolutionTarget),
            calendarApproved: cycle.calendar_snapshot.approved === true };
        });
        const first = measured[0], latest = measured.at(-1);
        return { id: ticket.id, number: ticket.number, createdAt: ticket.created_at, status: ticket.status,
          waiting:ticketWaiting(ticket,membership.rows[0].clock),
          serviceCode: ticket.service_code as string, serviceName: ticket.service_name as string,
          acceptedHandoverCount: ticket.accepted_handover_count as number,
          priority: ticket.priority,initialPriority:ticket.initial_priority,priorityChangeCount:ticket.priority_change_count,
          reopenCount: ticket.reopen_count as number, rating: ticket.rating as number | null,
          assigneeId: ticket.assignee_id as string | null, assigneeName: ticket.assignee_name as string | null,
          assigneeActive: ticket.assignee_active as boolean | null,
          pendingAssigneeId: ticket.pending_assignee_id as string | null,
          pendingAssigneeName: ticket.pending_assignee_name as string | null,
          assignmentKind: ticket.assignment_kind as 'OFFER' | 'HANDOVER' | null,
          firstResponse: first ? { responded: first.responded, minutes: first.responseMinutes, target: first.responseTarget,
            overdue: first.responseOverdue } : null,
          resolution: latest ? { completed: latest.completed && ['CLOSED', 'PENDING_CONFIRMATION'].includes(ticket.status),
            minutes: latest.resolutionMinutes, target: latest.resolutionTarget, overdue: latest.resolutionOverdue } : null,
          overdueEver: measured.some(c => c.responseOverdue || c.resolutionOverdue),
          unapprovedCalendar: measured.some(c => !c.calendarApproved), cycles: measured };
      });
      const owned = items.filter(item => ownerMatches(item, ownerFilter));
      const filtered = owned.filter(item => serviceMatches(item, serviceFilter));
      return { groupId, from, to, serviceType, timeZone: 'Asia/Shanghai', attribution: 'CURRENT_OWNER_GROUP',
        ownerAttribution: 'CURRENT_ASSIGNEE', ownerFilter, serviceFilter, asOf: membership.rows[0].clock,
        handoverBasis: 'RECORDED_ACCEPT_HANDOVER_IN_GROUP', serviceNameBasis: 'CURRENT_CATALOG',
        responsibility: responsibilitySummary(items), services: serviceSummary(owned),
        waiting:waitingSummary(filtered), metrics: reportMetrics(filtered), items: filtered };
    });
  }
}
