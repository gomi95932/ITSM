CREATE TABLE operations_versions (
  version integer PRIMARY KEY CHECK(version>0), config jsonb NOT NULL,
  created_by text REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO operations_versions(version,config) VALUES(1,'{"siteEnforced":false,"sites":[],"employeeSites":[],"groupSites":[],"positionSites":[],"serviceSites":[],"siteRoutes":[],"slaTemplates":[],"serviceSlas":[]}');
CREATE TABLE operations_proposals (
  id uuid PRIMARY KEY, expected_version integer NOT NULL REFERENCES operations_versions(version),
  config jsonb NOT NULL, proposed_by text NOT NULL REFERENCES employees(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  reviewed_by text REFERENCES employees(id), review_reason text, reviewed_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(reviewed_by IS NULL OR reviewed_by<>proposed_by),
  CHECK((status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status<>'PENDING' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(trim(review_reason)) BETWEEN 1 AND 500))
);
CREATE TRIGGER operations_versions_immutable BEFORE UPDATE OR DELETE ON operations_versions
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
CREATE VIEW operations_current AS SELECT * FROM operations_versions ORDER BY version DESC LIMIT 1;
CREATE FUNCTION staff_site_access(snapshot jsonb,employee text,target_group text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT (config->>'siteEnforced')::boolean OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(config->'employeeSites') e,
      jsonb_array_elements(config->'groupSites') g,jsonb_array_elements(config->'sites') s
    WHERE e->>'employeeId'=employee AND g->>'groupId'=target_group
      AND s->>'id'=snapshot->'site'->>'id' AND (s->>'enabled')::boolean
      AND (e->'siteIds') ? (s->>'id') AND (g->'siteIds') ? (s->>'id'))
  FROM operations_current;
$$;
CREATE FUNCTION ticket_site_access(target uuid,employee text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM tickets t WHERE t.id=target AND
    (t.requester_id=employee OR staff_site_access(t.service_routing_snapshot,employee,t.owner_group_id)
      OR (t.pending_assignee_id=employee AND staff_site_access(t.service_routing_snapshot,employee,t.pending_group_id))));
$$;
ALTER FUNCTION service_position_eligible(jsonb,text,text) RENAME TO service_position_eligible_pre_site;
CREATE FUNCTION service_position_eligible(snapshot jsonb,employee text,target_group text) RETURNS boolean LANGUAGE sql AS $$
  SELECT staff_site_access(snapshot,employee,target_group) AND
    ((NOT (c.config->>'siteEnforced')::boolean AND snapshot='{}'::jsonb) OR EXISTS(
      SELECT 1 FROM support_positions p JOIN service_domains d ON d.id=p."domainId"
      JOIN position_appointments a ON a."positionId"=p.id
      JOIN employees e ON e.id=a."employeeId"
      JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=p."groupId"
      WHERE e.id=employee AND e.active AND p.enabled AND d.enabled AND a.enabled
        AND a."validFrom"<=clock_timestamp() AND a."validTo">clock_timestamp() AND p."groupId"=target_group
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'positions') s
          WHERE s->>'id'=p.id AND s->>'groupId'=p."groupId")
        AND (NOT (c.config->>'siteEnforced')::boolean OR EXISTS(
          SELECT 1 FROM jsonb_array_elements(c.config->'positionSites') s
          WHERE s->>'positionId'=p.id AND (s->'siteIds') ? (snapshot->'site'->>'id')))))
  FROM operations_current c;
$$;
ALTER FUNCTION ticket_processing_eligible(uuid,text) RENAME TO ticket_processing_eligible_pre_site;
CREATE FUNCTION ticket_processing_eligible(target uuid,employee text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM tickets t JOIN employees e ON e.id=employee AND e.active
    JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=t.owner_group_id
    JOIN support_groups g ON g.id=m.group_id AND g.enabled
    WHERE t.id=target AND t.assignee_id=e.id AND staff_site_access(t.service_routing_snapshot,employee,t.owner_group_id)
      AND (service_position_eligible(t.service_routing_snapshot,e.id,t.owner_group_id)
        OR EXISTS(SELECT 1 FROM ticket_continuations c WHERE c.ticket_id=t.id AND c.employee_id=e.id
          AND c.group_id=t.owner_group_id AND c.responsibility_epoch=t.responsibility_epoch
          AND c.status='APPROVED' AND c.expires_at>clock_timestamp())));
$$;
ALTER FUNCTION request_fulfillment_operator_eligible(uuid,text,text) RENAME TO request_fulfillment_operator_eligible_pre_site;
CREATE FUNCTION request_fulfillment_operator_eligible(target uuid,employee text,operation text) RETURNS boolean LANGUAGE sql AS $$
  SELECT request_fulfillment_operator_eligible_pre_site(target,employee,operation) AND EXISTS(
    SELECT 1 FROM request_fulfillments f JOIN tickets t ON t.id=f.ticket_id WHERE f.id=target
      AND staff_site_access(t.service_routing_snapshot,employee,t.owner_group_id)
      AND (service_position_eligible(t.service_routing_snapshot,employee,t.owner_group_id)
        OR (operation='REVOKE' AND EXISTS(SELECT 1 FROM role_bindings r WHERE r.employee_id=employee
          AND r.group_id=t.owner_group_id AND r.role_code='GROUP_LEAD' AND r.status='ACTIVE'
          AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp()))));
$$;
ALTER FUNCTION request_delivery_operator_eligible(uuid,text) RENAME TO request_delivery_operator_eligible_pre_site;
CREATE FUNCTION request_delivery_operator_eligible(target_approval uuid,employee text) RETURNS boolean LANGUAGE sql AS $$
  SELECT request_delivery_operator_eligible_pre_site(target_approval,employee) AND EXISTS(
    SELECT 1 FROM request_approvals a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=target_approval
      AND service_position_eligible(t.service_routing_snapshot,employee,t.owner_group_id));
$$;
ALTER FUNCTION request_delivery_resolution_eligible(uuid,text) RENAME TO request_delivery_resolution_eligible_pre_site;
CREATE FUNCTION request_delivery_resolution_eligible(target_command uuid,verifier text) RETURNS boolean LANGUAGE sql AS $$
  SELECT request_delivery_resolution_eligible_pre_site(target_command,verifier) AND EXISTS(
    SELECT 1 FROM request_delivery_commands c JOIN request_approvals a ON a.id=c.approval_id
      JOIN tickets t ON t.id=a.ticket_id WHERE c.id=target_command AND staff_site_access(t.service_routing_snapshot,verifier,t.owner_group_id)
      AND (service_position_eligible(t.service_routing_snapshot,verifier,t.owner_group_id) OR EXISTS(
        SELECT 1 FROM role_bindings r WHERE r.employee_id=verifier AND r.group_id=t.owner_group_id AND r.role_code='GROUP_LEAD'
          AND r.status='ACTIVE' AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp())));
$$;
ALTER TABLE sla_cycles ADD COLUMN template_snapshot jsonb NOT NULL DEFAULT '{}';
CREATE FUNCTION preserve_sla_template_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot THEN RAISE EXCEPTION 'SLA_TEMPLATE_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sla_template_snapshot_immutable BEFORE UPDATE ON sla_cycles
  FOR EACH ROW EXECUTE FUNCTION preserve_sla_template_snapshot();
CREATE TABLE appointment_emergency_revocations (
  id uuid PRIMARY KEY, appointment_id text NOT NULL, actor_id text NOT NULL REFERENCES employees(id),
  expected_version integer NOT NULL, published_version integer NOT NULL REFERENCES service_structure_versions(version),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER appointment_emergency_revocations_immutable BEFORE UPDATE OR DELETE ON appointment_emergency_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();

CREATE FUNCTION service_site_visible(service text,employee text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT (config->>'siteEnforced')::boolean OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(config->'employeeSites') e,
      jsonb_array_elements(config->'serviceSites') b,jsonb_array_elements(config->'sites') s
    WHERE e->>'employeeId'=employee AND b->>'serviceCode'=service
      AND s->>'id'=e->>'homeSiteId' AND (s->>'enabled')::boolean AND (b->'siteIds') ? (s->>'id'))
  FROM operations_current;
$$;
CREATE FUNCTION knowledge_site_access(article uuid,employee text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM knowledge_articles a WHERE a.id=article AND (a.source_ticket_id IS NULL OR EXISTS(
    SELECT 1 FROM tickets t WHERE t.id=a.source_ticket_id AND staff_site_access(t.service_routing_snapshot,employee,a.owner_group_id))));
$$;
