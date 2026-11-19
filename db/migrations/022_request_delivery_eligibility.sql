-- Preparation has no fulfillment row yet, so delivery eligibility is scoped to the approval.
CREATE FUNCTION request_delivery_operator_eligible(target_approval uuid,employee text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS(
    SELECT 1 FROM request_approvals a JOIN tickets t ON t.id=a.ticket_id
    JOIN support_groups g ON g.id=t.owner_group_id AND g.enabled
    JOIN group_memberships m ON m.group_id=g.id AND m.employee_id=employee
    JOIN employees e ON e.id=m.employee_id AND e.active
    WHERE a.id=target_approval AND employee<>(a.snapshot->'applicant'->>'employeeId')
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.snapshot->'approvers') p WHERE p->>'employeeId'=employee)
      AND service_position_eligible(t.service_routing_snapshot,employee,t.owner_group_id)
  );
$$;
