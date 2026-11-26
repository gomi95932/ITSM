import type { Pool, PoolClient } from 'pg';

type Audience = { requester?: boolean; owner?: boolean; pending?: boolean; queue?: boolean; escalation?: boolean; reviewer?: boolean; platformAdmin?: boolean; fulfillment?: boolean; deliveryFailure?: boolean; waiting?: boolean };
const audiences: Readonly<Record<string, Audience>> = {
  SUBMIT_AND_ROUTE: { requester:true, owner:true, queue:true },
  REQUEST_APPROVED: { requester:true, owner:true, queue:true },
  REQUEST_REJECTED: { requester:true, owner:true },
  ACCEPT: { requester:true, owner:true },
  REQUEST_INFO: { requester:true, owner:true },
  ADD_INFO: { requester:true, owner:true },
  WAIT_VENDOR: { owner:true },
  RESUME_VENDOR: { requester:true, owner:true },
  WAITING_USER_FOLLOW_UP_DUE: { waiting:true },
  WAITING_VENDOR_FOLLOW_UP_DUE: { waiting:true },
  RESOLVE: { requester:true, owner:true },
  CONFIRM: { requester:true, owner:true },
  REOPEN: { requester:true, owner:true, queue:true },
  CANCEL: { requester:true, owner:true },
  AUTO_CLOSE: { requester:true, owner:true },
  REASSIGN: { owner:true, pending:true, queue:true },
  INITIATE_HANDOVER: { owner:true, pending:true, escalation:true },
  FORCE_TAKEOVER: { requester:true, owner:true, escalation:true },
  CONTINUATION_PROPOSE: { owner:true, escalation:true },
  CONTINUATION_APPROVE: { owner:true, escalation:true },
  CONTINUATION_REJECT: { owner:true, escalation:true },
  CONTINUATION_REVOKE: { owner:true, escalation:true },
  ACCEPT_HANDOVER: { requester:true, owner:true },
  DECLINE_HANDOVER: { owner:true, queue:true },
  CANCEL_HANDOVER: { owner:true, queue:true },
  ASSIGN_OFFER: { pending:true, queue:true },
  ACCEPT_OFFER: { requester:true, owner:true },
  DECLINE_OFFER: { queue:true },
  CANCEL_OFFER: { queue:true },
  ASSIGNMENT_EXPIRED: { owner:true, queue:true, escalation:true },
  CLASSIFICATION_CORRECTED: { requester:true, owner:true, queue:true },
  PRIORITY_REVIEWED: { requester:true, owner:true },
  PRIORITY_CHANGED: {requester:true,owner:true,escalation:true},
  PRIORITY_SUGGESTED: {owner:true,queue:true,escalation:true,reviewer:true},
  P1_CANDIDATE: { owner:true, escalation:true, reviewer:true },
  P1_REVIEW_OVERDUE: { owner:true, escalation:true, reviewer:true },
  P1_REVIEW_ROUTED: { owner:true, escalation:true, reviewer:true },
  SLA_BREACH: { owner:true, escalation:true },
  OWNERSHIP_RECOVERED: { owner:true, escalation:true },
  OWNERSHIP_ESCALATION_REQUIRED: { owner:true, escalation:true, platformAdmin:true },
  FEEDBACK_SUBMITTED: { owner:true },
  DELIVERY_FAILURE_RESOLVED: { owner:true, escalation:true },
  DELIVERY_FAILURE_REQUIRED: { deliveryFailure:true },
  FULFILLMENT_REVIEW_REQUIRED: { fulfillment:true },
  FULFILLMENT_REVOKE_REQUIRED: { fulfillment:true },
  FULFILLMENT_REVIEW_OVERDUE: { fulfillment:true },
  FULFILLMENT_REVOKE_OVERDUE: { fulfillment:true },
};

export function notificationAudience(action: string): Readonly<Audience> {
  return Object.hasOwn(audiences,action) ? audiences[action]! : {};
}

// The same query is used at expansion and immediately before every delivery attempt.
export async function notificationRecipients(client: Pick<PoolClient,'query'>, eventId: string, employeeId: string | null = null): Promise<string[]> {
  const event = await client.query<{ action:string }>('SELECT action FROM ticket_events WHERE id=$1',[eventId]);
  if (!event.rowCount) return [];
  if(['TRIAGE_ASSIGNED','TRIAGE_TRANSFERRED','TRIAGE_ESCALATED'].includes(event.rows[0]!.action)){
    const result=await client.query<{id:string}>(`SELECT e.id FROM ticket_events v
      JOIN tickets t ON t.id=v.ticket_id JOIN ticket_triage_responsibilities r ON r.ticket_id=t.id
      JOIN employees e ON e.active WHERE v.id=$1 AND ($2::text IS NULL OR e.id=$2)
        AND v.detail->>'triageGeneration'=r.generation::text AND r.stage<>'COMPLETED'
        AND t.assignee_id IS NULL AND t.pending_assignee_id IS NULL
        AND (t.status='QUEUED' OR (t.service_type='REQ' AND t.status='IN_PROGRESS'))
        AND (e.id=r.coordinator_id OR (v.action IN ('TRIAGE_TRANSFERRED','TRIAGE_ESCALATED') AND EXISTS(
          SELECT 1 FROM role_bindings b WHERE b.employee_id=e.id AND b.role_code='PLATFORM_ADMIN'
          AND b.status='ACTIVE' AND b.valid_from<=clock_timestamp() AND b.valid_to>clock_timestamp())))
      ORDER BY e.id`,[eventId,employeeId]);
    return result.rows.map(row=>row.id);
  }
  if(event.rows[0]!.action.startsWith('P1_')) {
    const current=await client.query(`SELECT 1 FROM ticket_events v JOIN tickets t ON t.id=v.ticket_id
      WHERE v.id=$1 AND t.priority='P1' AND t.priority_review_state='PENDING'
        AND COALESCE((v.detail->>'generation')::integer,1)=t.priority_review_generation`,[eventId]);
    if(!current.rowCount)return [];
  }
  const a = notificationAudience(event.rows[0]!.action);
  if (!Object.keys(a).length) return [];
  if (a.waiting) {
    const recipients = await client.query<{id:string}>(`SELECT e.id FROM ticket_waiting_active_signals s
      JOIN tickets t ON t.id=s.ticket_id JOIN employees e ON e.active
      WHERE s.event_id=$1 AND ($2::text IS NULL OR e.id=$2)
        AND (e.id=t.requester_id OR staff_site_access(t.service_routing_snapshot,e.id,t.owner_group_id)) AND (
        (s.waiting_status='WAITING_USER' AND e.id=t.requester_id) OR
        (e.id=t.assignee_id AND ticket_processing_eligible(t.id,e.id)) OR
        ((t.assignee_id IS NULL OR NOT ticket_processing_eligible(t.id,t.assignee_id)) AND EXISTS(
          SELECT 1 FROM role_bindings r JOIN group_memberships m ON m.employee_id=r.employee_id AND m.group_id=r.group_id
          WHERE r.employee_id=e.id AND r.group_id=s.group_id AND r.role_code='GROUP_LEAD' AND r.status='ACTIVE'
            AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp()))
      ) ORDER BY e.id`,[eventId,employeeId]);
    return recipients.rows.map(row=>row.id);
  }
  if(a.deliveryFailure){
    const recipients=await client.query<{id:string}>(`SELECT e.id FROM ticket_events v
      JOIN request_delivery_commands c ON c.id::text=v.detail->>'commandId'
      JOIN request_approvals p ON p.id=c.approval_id AND p.ticket_id=v.ticket_id
      JOIN tickets t ON t.id=v.ticket_id JOIN group_memberships m ON m.group_id=t.owner_group_id
      JOIN employees e ON e.id=m.employee_id AND e.active
      WHERE v.id=$1 AND ($2::text IS NULL OR e.id=$2)
        AND NOT EXISTS(SELECT 1 FROM request_delivery_resolutions r WHERE r.command_id=c.id)
        AND request_delivery_resolution_eligible(c.id,e.id) ORDER BY e.id`,[eventId,employeeId]);
    return recipients.rows.map(row=>row.id);
  }
  if(a.fulfillment){
    // Bound the signal and group before evaluating the nested current-authorization functions.
    const recipients=await client.query<{id:string}>(`WITH signal AS MATERIALIZED (
      SELECT s.*,t.service_routing_snapshot FROM request_fulfillment_active_signals s
      JOIN tickets t ON t.id=s.ticket_id WHERE s.event_id=$1
    ), candidates AS MATERIALIZED (
      SELECT s.fulfillment_id,s.group_id,s.kind,s.escalate_at,s.service_routing_snapshot,e.id
      FROM signal s JOIN group_memberships m ON m.group_id=s.group_id
      JOIN employees e ON e.id=m.employee_id AND e.active WHERE ($2::text IS NULL OR e.id=$2)
    ) SELECT s.id FROM candidates s
      WHERE staff_site_access(s.service_routing_snapshot,s.id,s.group_id) AND CASE s.kind
        WHEN 'REVIEW_REQUIRED' THEN request_fulfillment_operator_eligible(s.fulfillment_id,s.id,'REVIEW')
        WHEN 'REVOKE_REQUIRED' THEN request_fulfillment_operator_eligible(s.fulfillment_id,s.id,'REVOKE')
        ELSE s.kind IN ('REVIEW_OVERDUE','REVOKE_OVERDUE') AND s.escalate_at<=clock_timestamp() AND EXISTS(
          SELECT 1 FROM role_bindings r WHERE r.employee_id=s.id AND r.group_id=s.group_id AND r.role_code='GROUP_LEAD'
            AND r.status='ACTIVE' AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp())
      END ORDER BY s.id`,[eventId,employeeId]);
    return recipients.rows.map(row=>row.id);
  }
  const result = await client.query<{ id:string }>(`SELECT e.id FROM ticket_events v JOIN tickets t ON t.id=v.ticket_id
    JOIN employees e ON e.active WHERE v.id=$1 AND ($2::text IS NULL OR e.id=$2)
      AND (e.id=t.requester_id OR staff_site_access(t.service_routing_snapshot,e.id,t.owner_group_id)
        OR (e.id=t.pending_assignee_id AND staff_site_access(t.service_routing_snapshot,e.id,t.pending_group_id))) AND (
      ($3 AND e.id=t.requester_id) OR
      ($4 AND e.id=t.assignee_id AND EXISTS(SELECT 1 FROM group_memberships m WHERE m.employee_id=e.id AND m.group_id=t.owner_group_id)) OR
      (v.action='FORCE_TAKEOVER' AND e.id=v.detail->>'oldAssigneeId' AND EXISTS(
        SELECT 1 FROM group_memberships m WHERE m.employee_id=e.id AND m.group_id=t.owner_group_id)) OR
      ($5 AND e.id=t.pending_assignee_id AND (
          (v.detail->>'automatic'='true' AND EXISTS(SELECT 1 FROM automatic_dispatch_runs r
            JOIN automatic_dispatch_attempts a ON a.run_id=r.id AND a.state='PENDING'
            WHERE r.ticket_id=t.id AND r.state='OFFERED' AND r.id::text=v.detail->>'runId'
              AND a.employee_id=e.id AND a.offered_at=t.assignment_offered_at AND t.assignment_due_at>clock_timestamp()))
          OR (COALESCE(v.detail->>'automatic','false')<>'true' AND v.detail->>'assignmentVersion'=t.version::text))
        AND v.detail->>'targetAssigneeId'=t.pending_assignee_id
        AND v.detail->>'targetGroupId'=t.pending_group_id AND EXISTS
        (SELECT 1 FROM group_memberships m WHERE m.employee_id=e.id AND m.group_id=t.pending_group_id)
        AND service_position_eligible(t.service_routing_snapshot,e.id,t.pending_group_id)) OR
      (($6 AND t.assignee_id IS NULL AND t.status NOT IN ('CLOSED','CANCELLED','REJECTED') OR $7) AND EXISTS
        (SELECT 1 FROM role_bindings r JOIN group_memberships m ON m.employee_id=r.employee_id AND m.group_id=r.group_id
          WHERE r.employee_id=e.id AND r.group_id=t.owner_group_id AND r.role_code IN ('DISPATCHER','GROUP_LEAD')
          AND r.status='ACTIVE' AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp())) OR
      ($8 AND EXISTS(SELECT 1 FROM priority_reviewers p WHERE p.employee_id=e.id AND p.group_id=t.owner_group_id)) OR
      ($9 AND EXISTS(SELECT 1 FROM role_bindings r WHERE r.employee_id=e.id AND r.role_code='PLATFORM_ADMIN'
        AND r.status='ACTIVE' AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp()))
    ) ORDER BY e.id`,[eventId,employeeId,!!a.requester,!!a.owner,!!a.pending,!!a.queue,!!a.escalation,!!a.reviewer,!!a.platformAdmin]);
  return result.rows.map(row=>row.id);
}

export async function expandNotification(client: PoolClient, outboxId: string, eventId: string): Promise<void> {
  const recipients = await notificationRecipients(client,eventId);
  await client.query(`INSERT INTO notification_deliveries(outbox_id,employee_id)
    SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`,[outboxId,recipients]);
  await client.query("UPDATE outbox_events SET expanded_at=COALESCE(expanded_at,clock_timestamp()),audience_checked_at=clock_timestamp(),state='EXPANDED' WHERE id=$1",[outboxId]);
}

async function maintainNotificationAudiences(db: Pick<Pool,'connect'>, query:string, application:string): Promise<void> {
  // Release the authorization lock between events so configuration writers do not wait for a whole batch.
  for(let i=0;i<20;i++){
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('application_name',$1,true)",[application]);
      await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
      const pending=await client.query<{id:string;event_id:string}>(query);
      const event=pending.rows[0];
      if(event)await expandNotification(client,event.id,event.event_id);
      await client.query('COMMIT');
      if(!event)break;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

export async function expandPendingNotifications(db: Pick<Pool,'connect'>): Promise<void> {
  await maintainNotificationAudiences(db,`SELECT o.id,o.event_id FROM outbox_events o WHERE o.expanded_at IS NULL
    ORDER BY (o.kind='P1_ALERT') DESC,o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,'itsm-worker-notification-expand');
}

export async function refreshFulfillmentNotificationAudiences(db: Pick<Pool,'connect'>): Promise<void> {
  await maintainNotificationAudiences(db,`SELECT o.id,o.event_id FROM outbox_events o
      JOIN request_fulfillment_active_signals s ON s.event_id=o.event_id AND s.ticket_id=o.ticket_id
      WHERE o.expanded_at IS NOT NULL
        AND (o.audience_checked_at IS NULL OR o.audience_checked_at<=clock_timestamp()-interval '60 seconds')
      ORDER BY o.audience_checked_at NULLS FIRST,o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,'itsm-worker-notification-fulfillment');
}

export async function refreshWaitingNotificationAudiences(db: Pick<Pool,'connect'>): Promise<void> {
  await maintainNotificationAudiences(db,`SELECT o.id,o.event_id FROM outbox_events o
      JOIN ticket_waiting_active_signals s ON s.event_id=o.event_id AND s.ticket_id=o.ticket_id
      WHERE o.expanded_at IS NOT NULL
        AND (o.audience_checked_at IS NULL OR o.audience_checked_at<=clock_timestamp()-interval '60 seconds')
      ORDER BY o.audience_checked_at NULLS FIRST,o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,'itsm-worker-notification-waiting');
}
