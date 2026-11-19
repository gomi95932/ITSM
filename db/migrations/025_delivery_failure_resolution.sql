CREATE TABLE request_delivery_resolutions (
  command_id uuid PRIMARY KEY REFERENCES request_delivery_commands(id),
  actor_id text NOT NULL REFERENCES employees(id),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(length(request_hash)=64),
  outcome text NOT NULL CHECK(outcome IN ('NOT_GRANTED','REVOKED')),
  evidence_reference text NOT NULL CHECK(evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,request_key)
);
CREATE TRIGGER request_delivery_resolutions_immutable BEFORE UPDATE OR DELETE ON request_delivery_resolutions
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();

CREATE FUNCTION request_delivery_has_unresolved(target_approval uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM request_delivery_commands c WHERE c.approval_id=target_approval
    AND c.operation='DELIVER' AND c.state='REJECTED'
    AND NOT EXISTS(SELECT 1 FROM request_delivery_resolutions r WHERE r.command_id=c.id));
$$;

CREATE FUNCTION request_delivery_resolution_eligible(target_command uuid,verifier text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM request_delivery_commands c JOIN request_approvals a ON a.id=c.approval_id
    JOIN tickets t ON t.id=a.ticket_id JOIN support_groups g ON g.id=t.owner_group_id AND g.enabled
    JOIN group_memberships m ON m.group_id=g.id AND m.employee_id=verifier
    JOIN employees e ON e.id=m.employee_id AND e.active
    WHERE c.id=target_command AND c.operation='DELIVER' AND c.state='REJECTED'
      AND verifier<>c.actor_id AND verifier<>t.requester_id
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.snapshot->'approvers') p WHERE p->>'employeeId'=verifier)
      AND (service_position_eligible(t.service_routing_snapshot,verifier,g.id) OR EXISTS(
        SELECT 1 FROM role_bindings b WHERE b.employee_id=verifier AND b.group_id=g.id AND b.role_code='GROUP_LEAD'
          AND b.status='ACTIVE' AND b.valid_from<=clock_timestamp() AND b.valid_to>clock_timestamp())));
$$;

CREATE FUNCTION resolve_request_delivery_failure(target_command uuid,verifier text,disposition text,reference text,
  command_key uuid,command_hash text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE approval_key uuid; approval request_approvals%ROWTYPE; task request_fulfillments%ROWTYPE;
  target tickets%ROWTYPE; command request_delivery_commands%ROWTYPE; prior request_delivery_resolutions%ROWTYPE;
  result jsonb; event_id uuid; request_id uuid; recorded_at timestamptz;
BEGIN
  IF disposition NOT IN ('NOT_GRANTED','REVOKED') OR disposition IS NULL OR reference IS NULL
    OR reference !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$' OR command_key IS NULL
    OR command_hash IS NULL OR length(command_hash)<>64 THEN RAISE EXCEPTION 'INVALID_DELIVERY_RESOLUTION'; END IF;
  PERFORM pg_advisory_xact_lock_shared(71820512);
  SELECT c.approval_id INTO approval_key FROM request_delivery_commands c WHERE c.id=target_command;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_FAILURE_NOT_FOUND'; END IF;
  SELECT * INTO approval FROM request_approvals WHERE id=approval_key FOR UPDATE;
  SELECT * INTO task FROM request_fulfillments WHERE request_fulfillments.approval_id=approval.id FOR UPDATE;
  SELECT * INTO target FROM tickets WHERE id=approval.ticket_id FOR SHARE;
  SELECT * INTO command FROM request_delivery_commands WHERE id=target_command FOR UPDATE;
  IF command.operation<>'DELIVER' OR command.state<>'REJECTED' THEN RAISE EXCEPTION 'DELIVERY_FAILURE_NOT_FOUND'; END IF;
  PERFORM e.id FROM employees e JOIN group_memberships m ON m.employee_id=e.id
    JOIN support_groups g ON g.id=m.group_id WHERE e.id=verifier AND e.active AND g.enabled AND g.id=target.owner_group_id
    FOR SHARE OF e,m,g;
  IF NOT FOUND OR NOT request_delivery_resolution_eligible(target_command,verifier) THEN
    RAISE EXCEPTION 'DELIVERY_RESOLUTION_OPERATOR_DENIED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery-resolution:'||verifier||':'||command_key::text,0));
  SELECT * INTO prior FROM request_delivery_resolutions WHERE actor_id=verifier AND request_key=command_key;
  IF FOUND THEN
    IF prior.command_id<>target_command OR prior.request_hash<>command_hash THEN RAISE EXCEPTION 'DELIVERY_RESOLUTION_KEY_CONFLICT'; END IF;
    RETURN jsonb_build_object('commandId',prior.command_id,'outcome',prior.outcome,'reference',prior.evidence_reference,'resolvedAt',prior.created_at);
  END IF;
  IF EXISTS(SELECT 1 FROM request_delivery_resolutions WHERE command_id=target_command) THEN
    RAISE EXCEPTION 'DELIVERY_FAILURE_ALREADY_RESOLVED';
  END IF;
  -- Existing successful grants must be revoked through their own audited lifecycle first.
  IF task.state IN ('DELIVERED','REVOKE_DUE') THEN RAISE EXCEPTION 'DELIVERY_RESOLUTION_ACTIVE_GRANT'; END IF;
  IF EXISTS(SELECT 1 FROM request_delivery_commands WHERE request_delivery_commands.approval_id=approval.id AND state='PENDING') THEN
    RAISE EXCEPTION 'REQUEST_DELIVERY_PENDING';
  END IF;
  IF reference=command.evidence_reference OR EXISTS(SELECT 1 FROM request_delivery_resolutions r
    JOIN request_delivery_commands c ON c.id=r.command_id WHERE c.approval_id=approval.id AND r.evidence_reference=reference)
    OR EXISTS(SELECT 1 FROM request_fulfillment_events WHERE fulfillment_id=task.id AND evidence_reference=reference) THEN
    RAISE EXCEPTION 'FULFILLMENT_EVIDENCE_REUSED';
  END IF;
  recorded_at=clock_timestamp();
  IF NOT request_delivery_resolution_eligible(target_command,verifier) THEN
    RAISE EXCEPTION 'DELIVERY_RESOLUTION_OPERATOR_DENIED';
  END IF;
  INSERT INTO request_delivery_resolutions(command_id,actor_id,request_key,request_hash,outcome,evidence_reference,created_at)
    VALUES(target_command,verifier,command_key,command_hash,disposition,reference,recorded_at);
  event_id=gen_random_uuid(); request_id=gen_random_uuid();
  result=jsonb_build_object('commandId',target_command,'outcome',disposition,'reference',reference,'resolvedAt',recorded_at);
  INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id)
    VALUES(event_id,target.id,verifier,'DELIVERY_FAILURE_RESOLVED',target.status,target.status,
      jsonb_build_object('commandId',target_command,'outcome',disposition),request_id);
  INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value)
    VALUES(target.id,event_id,verifier,request_id,'DELIVERY_FAILURE_RESOLVED',
      jsonb_build_object('commandId',target_command,'resolved',false),result);
  INSERT INTO outbox_events(ticket_id,event_id,kind,payload)
    VALUES(target.id,event_id,'TICKET_CHANGED',jsonb_build_object('ticketId',target.id,'eventId',event_id));
  RETURN result;
END;
$$;
