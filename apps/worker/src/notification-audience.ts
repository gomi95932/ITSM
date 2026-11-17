import type { PoolClient } from 'pg';

type Audience = { requester?: boolean; owner?: boolean; pending?: boolean; queue?: boolean; escalation?: boolean; reviewer?: boolean; platformAdmin?: boolean; fulfillment?: boolean; deliveryFailure?: boolean };
const audiences: Readonly<Record<string, Audience>> = {
  SUBMIT_AND_ROUTE: { requester:true, owner:true, queue:true },
  ACCEPT: { requester:true, owner:true },
  REQUEST_INFO: { requester:true, owner:true },
  ADD_INFO: { requester:true, owner:true },
  WAIT_VENDOR: { owner:true },
  RESOLVE: { requester:true, owner:true },
  CONFIRM: { requester:true, owner:true },
  REOPEN: { requester:true, owner:true, queue:true },
  CANCEL: { requester:true, owner:true },
  AUTO_CLOSE: { requester:true, owner:true },
  REASSIGN: { owner:true, pending:true, queue:true },
  INITIATE_HANDOVER: { owner:true, pending:true, escalation:true },
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
  const a = notificationAudience(event.rows[0]!.action);
  if (!Object.keys(a).length) return [];
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
    const recipients=await client.query<{id:string}>(`SELECT e.id FROM request_fulfillment_signals s
      JOIN ticket_events v ON v.id=s.event_id AND v.action='FULFILLMENT_'||s.kind
      JOIN request_fulfillments f ON f.id=s.fulfillment_id AND f.ticket_id=v.ticket_id
      JOIN tickets t ON t.id=f.ticket_id AND t.owner_group_id=s.group_id
      JOIN support_groups g ON g.id=s.group_id AND g.enabled
      JOIN group_memberships m ON m.group_id=g.id JOIN employees e ON e.id=m.employee_id AND e.active
      WHERE s.event_id=$1 AND ($2::text IS NULL OR e.id=$2) AND (
        (s.kind IN ('REVIEW_REQUIRED','REVIEW_OVERDUE') AND f.state='DELIVERED'
          AND f.access_expires_at>clock_timestamp() AND f.reviewed_at IS NULL) OR
        (s.kind IN ('REVOKE_REQUIRED','REVOKE_OVERDUE') AND (f.state='REVOKE_DUE'
          OR (f.state='DELIVERED' AND f.access_expires_at<=clock_timestamp())))
      ) AND (
        (s.kind='REVIEW_REQUIRED' AND request_fulfillment_operator_eligible(f.id,e.id,'REVIEW')) OR
        (s.kind='REVOKE_REQUIRED' AND request_fulfillment_operator_eligible(f.id,e.id,'REVOKE')) OR
        (s.kind IN ('REVIEW_OVERDUE','REVOKE_OVERDUE') AND s.escalate_at<=clock_timestamp() AND EXISTS(
          SELECT 1 FROM role_bindings r WHERE r.employee_id=e.id AND r.group_id=g.id AND r.role_code='GROUP_LEAD'
            AND r.status='ACTIVE' AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp()))
      ) ORDER BY e.id`,[eventId,employeeId]);
    return recipients.rows.map(row=>row.id);
  }
  const result = await client.query<{ id:string }>(`SELECT e.id FROM ticket_events v JOIN tickets t ON t.id=v.ticket_id
    JOIN employees e ON e.active WHERE v.id=$1 AND ($2::text IS NULL OR e.id=$2) AND (
      ($3 AND e.id=t.requester_id) OR
      ($4 AND e.id=t.assignee_id AND EXISTS(SELECT 1 FROM group_memberships m WHERE m.employee_id=e.id AND m.group_id=t.owner_group_id)) OR
      ($5 AND e.id=t.pending_assignee_id AND v.detail->>'assignmentVersion'=t.version::text
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
  await client.query("UPDATE outbox_events SET expanded_at=now(),state='EXPANDED' WHERE id=$1",[outboxId]);
}
