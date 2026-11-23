CREATE OR REPLACE FUNCTION service_position_eligible(snapshot jsonb,employee text,target_group text) RETURNS boolean LANGUAGE sql AS $$
  SELECT staff_site_access(snapshot,employee,target_group) AND
    ((NOT (c.config->>'siteEnforced')::boolean AND snapshot='{}'::jsonb) OR EXISTS(
      SELECT 1 FROM support_positions p JOIN service_domains d ON d.id=p."domainId"
      JOIN position_appointments a ON a."positionId"=p.id
      JOIN employees e ON e.id=a."employeeId"
      JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=p."groupId"
      WHERE e.id=employee AND e.active AND p.enabled AND d.enabled AND a.enabled
        AND a."validFrom"<=clock_timestamp() AND (a."validTo" IS NULL OR a."validTo">clock_timestamp())
        AND p."groupId"=target_group
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'positions') s
          WHERE s->>'id'=p.id AND s->>'groupId'=p."groupId")
        AND (NOT (c.config->>'siteEnforced')::boolean OR EXISTS(
          SELECT 1 FROM jsonb_array_elements(c.config->'positionSites') s
          WHERE s->>'positionId'=p.id AND (s->'siteIds') ? (snapshot->'site'->>'id')))))
  FROM operations_current c;
$$;

CREATE OR REPLACE FUNCTION service_position_eligible_pre_site(snapshot jsonb,employee text,target_group text) RETURNS boolean LANGUAGE sql AS $$
  SELECT snapshot='{}'::jsonb OR EXISTS(
    SELECT 1 FROM support_positions p JOIN service_domains d ON d.id=p."domainId"
    JOIN position_appointments a ON a."positionId"=p.id
    JOIN employees e ON e.id=a."employeeId"
    JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=p."groupId"
    WHERE e.id=employee AND e.active AND p.enabled AND d.enabled AND a.enabled
      AND a."validFrom"<=clock_timestamp() AND (a."validTo" IS NULL OR a."validTo">clock_timestamp())
      AND p."groupId"=target_group
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'positions') s
        WHERE s->>'id'=p.id AND s->>'groupId'=p."groupId")
  );
$$;
