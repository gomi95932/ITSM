ALTER TABLE sla_cycles ADD COLUMN pause_reason text
  CHECK (pause_reason IN ('USER','APPROVAL'));
UPDATE sla_cycles SET pause_reason='USER' WHERE paused_at IS NOT NULL;

-- Caller serializes approval -> fulfillment -> ticket and holds the authorization lock.
-- Closing the ticket does not revoke the independently time-bounded downstream grant.
CREATE FUNCTION request_ticket_completion_ready(target uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM tickets t JOIN request_approvals a ON a.ticket_id=t.id
    JOIN request_fulfillments f ON f.approval_id=a.id AND f.ticket_id=t.id
    JOIN support_groups g ON g.id=t.owner_group_id AND g.enabled
    WHERE t.id=target AND t.service_type='REQ'
      AND a.state='APPROVED' AND a.last_verified_at IS NOT NULL AND a.lease_token IS NULL
      AND f.state='DELIVERED' AND f.delivered_at IS NOT NULL AND f.access_expires_at>clock_timestamp()
      AND f.reviewed_at IS NOT NULL AND f.reviewed_by<>f.assignee_id AND f.reviewed_by<>t.requester_id
      AND t.requester_id=a.snapshot->'applicant'->>'employeeId'
      AND t.service_code=a.snapshot->>'serviceCode' AND to_jsonb(t.form_version)=a.snapshot->'formVersion'
      AND t.catalog_snapshot=a.snapshot->'catalog'
      AND jsonb_build_object('subject',t.subject,'description',t.description,'fields',t.fields)=a.snapshot->'request'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.snapshot->'approvers') p
        WHERE p->>'employeeId'=f.reviewed_by)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(a.snapshot->'applicant')||(a.snapshot->'approvers')) p
        WHERE NOT EXISTS(SELECT 1 FROM employees e JOIN identity_links l ON l.employee_id=e.id
          WHERE e.id=p->>'employeeId' AND e.active AND l.corp_id=a.corp_id AND l.ding_user_id=p->>'dingUserId'))
      AND (NOT (a.snapshot ? 'managerMapping') OR EXISTS(
        SELECT 1 FROM request_manager_mappings m JOIN employees v ON v.id=m.verified_by AND v.active
        WHERE m.employee_id=t.requester_id AND m.review_before>clock_timestamp()
          AND m.manager_id=a.snapshot->'managerMapping'->>'managerId'
          AND m.source_reference=a.snapshot->'managerMapping'->>'sourceReference'
          AND m.verified_at=(a.snapshot->'managerMapping'->>'verifiedAt')::timestamptz
          AND m.review_before=(a.snapshot->'managerMapping'->>'reviewBefore')::timestamptz))
      AND EXISTS(SELECT 1 FROM request_fulfillment_events e WHERE e.fulfillment_id=f.id
        AND e.action='DELIVERY_RECORDED' AND e.actor_id=f.assignee_id AND e.evidence_reference IS NOT NULL)
      AND EXISTS(SELECT 1 FROM request_fulfillment_events e WHERE e.fulfillment_id=f.id
        AND e.action='DELIVERY_REVIEWED' AND e.actor_id=f.reviewed_by AND e.evidence_reference IS NOT NULL)
      AND NOT request_delivery_has_unresolved(a.id)
      AND NOT EXISTS(SELECT 1 FROM request_delivery_commands c WHERE c.approval_id=a.id AND c.state='PENDING')
  );
$$;
