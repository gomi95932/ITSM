ALTER TABLE request_fulfillments ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);

-- Polling timestamps do not invalidate a form; changes to business facts do.
CREATE FUNCTION advance_request_fulfillment_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version<>OLD.version THEN RAISE EXCEPTION 'FULFILLMENT_VERSION_MANAGED'; END IF;
  IF (NEW.state,NEW.delivered_at,NEW.access_expires_at,NEW.revoked_at,NEW.reviewed_at,NEW.reviewed_by,NEW.reason_code)
    IS DISTINCT FROM (OLD.state,OLD.delivered_at,OLD.access_expires_at,OLD.revoked_at,OLD.reviewed_at,OLD.reviewed_by,OLD.reason_code) THEN
    NEW.version=OLD.version+1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_fulfillment_revision BEFORE UPDATE ON request_fulfillments
  FOR EACH ROW EXECUTE FUNCTION advance_request_fulfillment_version();
CREATE UNIQUE INDEX request_fulfillment_evidence_unique ON request_fulfillment_events(fulfillment_id,evidence_reference)
  WHERE evidence_reference IS NOT NULL;

CREATE FUNCTION request_fulfillment_operator_eligible(target uuid,employee text,operation text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS(
    SELECT 1 FROM request_fulfillments f JOIN request_approvals a ON a.id=f.approval_id
    JOIN tickets t ON t.id=f.ticket_id JOIN support_groups g ON g.id=t.owner_group_id AND g.enabled
    JOIN group_memberships m ON m.group_id=g.id AND m.employee_id=employee
    JOIN employees e ON e.id=m.employee_id AND e.active
    WHERE f.id=target AND (
      (operation='REVIEW' AND employee<>f.assignee_id AND employee<>(a.snapshot->'applicant'->>'employeeId')
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.snapshot->'approvers') p WHERE p->>'employeeId'=employee)
        AND service_position_eligible(t.service_routing_snapshot,employee,t.owner_group_id))
      OR (operation='REVOKE' AND (service_position_eligible(t.service_routing_snapshot,employee,t.owner_group_id)
        OR EXISTS(SELECT 1 FROM role_bindings r WHERE r.employee_id=employee AND r.group_id=g.id AND r.role_code='GROUP_LEAD'
          AND r.status='ACTIVE' AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp())))
    )
  );
$$;

-- Both the worker and HTTP boundary call this action, so neither can bypass current appointments.
CREATE FUNCTION perform_request_fulfillment_action(target_approval uuid,actor text,operation text,reference text,expected integer DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE approval request_approvals%ROWTYPE; task request_fulfillments%ROWTYPE; target_group text; next_version integer;
BEGIN
  IF operation NOT IN ('REVIEW','REVOKE') THEN RAISE EXCEPTION 'FULFILLMENT_ACTION_INVALID'; END IF;
  IF reference IS NULL OR reference !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$' THEN
    RAISE EXCEPTION 'FULFILLMENT_EVIDENCE_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(71820512);
  SELECT * INTO approval FROM request_approvals WHERE id=target_approval FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  SELECT * INTO task FROM request_fulfillments WHERE approval_id=target_approval FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FULFILLMENT_NOT_FOUND'; END IF;
  IF expected IS NOT NULL AND expected<>task.version THEN RAISE EXCEPTION 'FULFILLMENT_VERSION_CONFLICT'; END IF;
  IF operation='REVIEW' AND (task.state NOT IN ('DELIVERED','REVOKE_DUE') OR task.reviewed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FULFILLMENT_REVIEW_UNAVAILABLE';
  END IF;
  IF operation='REVOKE' AND task.state NOT IN ('DELIVERED','REVOKE_DUE') THEN RAISE EXCEPTION 'FULFILLMENT_NOT_DELIVERED'; END IF;
  SELECT owner_group_id INTO target_group FROM tickets WHERE id=task.ticket_id FOR SHARE;
  PERFORM e.id FROM employees e JOIN group_memberships m ON m.employee_id=e.id
    JOIN support_groups g ON g.id=m.group_id WHERE e.id=actor AND e.active AND m.group_id=target_group AND g.enabled
    FOR SHARE OF e,m,g;
  IF NOT FOUND OR NOT request_fulfillment_operator_eligible(task.id,actor,operation) THEN
    RAISE EXCEPTION 'FULFILLMENT_OPERATOR_DENIED';
  END IF;
  IF EXISTS(SELECT 1 FROM request_fulfillment_events WHERE fulfillment_id=task.id AND evidence_reference=reference) THEN
    RAISE EXCEPTION 'FULFILLMENT_EVIDENCE_REUSED';
  END IF;
  IF operation='REVIEW' THEN
    UPDATE request_fulfillments SET reviewed_at=clock_timestamp(),reviewed_by=actor,updated_at=clock_timestamp()
      WHERE id=task.id RETURNING version INTO next_version;
  ELSE
    UPDATE request_fulfillments SET state='REVOKED',revoked_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=task.id RETURNING version INTO next_version;
  END IF;
  INSERT INTO request_fulfillment_events(fulfillment_id,actor_id,action,from_state,to_state,evidence_reference)
    VALUES(task.id,actor,CASE operation WHEN 'REVIEW' THEN 'DELIVERY_REVIEWED' ELSE 'REVOCATION_RECORDED' END,
      task.state,CASE operation WHEN 'REVIEW' THEN task.state ELSE 'REVOKED' END,reference);
  RETURN next_version;
END;
$$;

CREATE TABLE request_fulfillment_commands (
  actor_id text NOT NULL REFERENCES employees(id),
  request_key uuid NOT NULL,
  fulfillment_id uuid NOT NULL REFERENCES request_fulfillments(id),
  action text NOT NULL CHECK(action IN ('REVIEW','REVOKE')),
  request_hash text NOT NULL CHECK(length(request_hash)=64),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,request_key)
);
CREATE TRIGGER request_fulfillment_commands_immutable BEFORE UPDATE OR DELETE ON request_fulfillment_commands
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
