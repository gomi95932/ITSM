export const ownershipCandidatesQuery=`SELECT t.* FROM tickets t LEFT JOIN ticket_routing_alerts a ON a.ticket_id=t.id AND a.resolved_at IS NULL
  WHERE t.status NOT IN ('CLOSED','CANCELLED','REJECTED') AND
  ((t.assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees e JOIN group_memberships m ON m.employee_id=e.id
    WHERE e.id=t.assignee_id AND e.active AND m.group_id=t.owner_group_id)) OR
   (t.pending_assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees e JOIN group_memberships m ON m.employee_id=e.id
    WHERE e.id=t.pending_assignee_id AND e.active AND m.group_id=t.pending_group_id
      AND service_position_eligible(t.service_routing_snapshot,e.id,t.pending_group_id))) OR
   (t.assignee_id IS NOT NULL AND NOT ticket_processing_eligible(t.id,t.assignee_id)) OR
   a.ticket_id IS NOT NULL OR
   NOT EXISTS (SELECT 1 FROM employees e JOIN group_memberships m ON m.employee_id=e.id
    WHERE e.active AND m.group_id=t.owner_group_id AND service_position_eligible(t.service_routing_snapshot,e.id,t.owner_group_id)))
  ORDER BY COALESCE(a.last_checked_at,t.updated_at),t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED`;
