-- Manual delivery is recorded independently from OA approval. No downstream grant is automated here.
CREATE TABLE request_fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL UNIQUE REFERENCES request_approvals(id),
  ticket_id uuid NOT NULL UNIQUE REFERENCES tickets(id),
  assignee_id text NOT NULL REFERENCES employees(id),
  state text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','DELIVERED','REVOKE_DUE','REVOKED','BLOCKED')),
  ready_until timestamptz NOT NULL,
  delivered_at timestamptz,
  access_expires_at timestamptz,
  revoked_at timestamptz,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ready_until > created_at),
  CHECK ((delivered_at IS NULL AND access_expires_at IS NULL) OR
    (delivered_at IS NOT NULL AND access_expires_at > delivered_at)),
  CHECK (state NOT IN ('DELIVERED','REVOKE_DUE','REVOKED') OR delivered_at IS NOT NULL),
  CHECK (state <> 'REVOKED' OR revoked_at IS NOT NULL)
);
CREATE INDEX request_fulfillments_active ON request_fulfillments(updated_at,id)
  WHERE state IN ('READY','DELIVERED');
CREATE FUNCTION protect_request_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'REQUEST_FULFILLMENT_IMMUTABLE'; END IF;
  IF (NEW.id,NEW.approval_id,NEW.ticket_id,NEW.created_at,NEW.ready_until,NEW.assignee_id)
    IS DISTINCT FROM (OLD.id,OLD.approval_id,OLD.ticket_id,OLD.created_at,OLD.ready_until,OLD.assignee_id)
    OR (OLD.delivered_at IS NOT NULL AND (NEW.delivered_at,NEW.access_expires_at)
      IS DISTINCT FROM (OLD.delivered_at,OLD.access_expires_at))
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'REQUEST_FULFILLMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_fulfillment_immutable BEFORE UPDATE OR DELETE ON request_fulfillments
  FOR EACH ROW EXECUTE FUNCTION protect_request_fulfillment();

CREATE TABLE request_fulfillment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES request_fulfillments(id),
  actor_id text REFERENCES employees(id),
  action text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  evidence_reference text,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER request_fulfillment_event_immutable BEFORE UPDATE OR DELETE ON request_fulfillment_events
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
