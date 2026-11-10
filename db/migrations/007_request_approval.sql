-- No manager is inferred from display names or support-group membership.
CREATE TABLE request_manager_mappings (
  employee_id text PRIMARY KEY REFERENCES employees(id),
  manager_id text NOT NULL REFERENCES employees(id),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 200),
  verified_by text NOT NULL REFERENCES employees(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  review_before timestamptz NOT NULL,
  CHECK (employee_id <> manager_id AND review_before > verified_at)
);

CREATE TABLE request_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL UNIQUE REFERENCES tickets(id),
  corp_id text NOT NULL CHECK (length(corp_id) BETWEEN 1 AND 200),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN
    ('QUEUED','CREATING','CREATE_UNCERTAIN','PENDING','APPROVED','REJECTED','WITHDRAWN','EXPIRED','BLOCKED')),
  provider_instance_id text,
  creation_attempts integer NOT NULL DEFAULT 0 CHECK (creation_attempts BETWEEN 0 AND 1),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(corp_id,provider_instance_id),
  CHECK (expires_at > created_at),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (state NOT IN ('PENDING','APPROVED','REJECTED','WITHDRAWN') OR provider_instance_id IS NOT NULL),
  CHECK (state <> 'APPROVED' OR last_verified_at IS NOT NULL)
);
CREATE INDEX request_approvals_due ON request_approvals(next_at,lease_until)
  WHERE state IN ('QUEUED','CREATING','CREATE_UNCERTAIN','PENDING','APPROVED');

CREATE FUNCTION protect_request_approval_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'REQUEST_APPROVAL_IMMUTABLE'; END IF;
  IF (NEW.id,NEW.ticket_id,NEW.corp_id,NEW.snapshot,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.ticket_id,OLD.corp_id,OLD.snapshot,OLD.expires_at,OLD.created_at)
    OR (OLD.provider_instance_id IS NOT NULL AND NEW.provider_instance_id IS DISTINCT FROM OLD.provider_instance_id)
    OR NEW.creation_attempts < OLD.creation_attempts THEN
    RAISE EXCEPTION 'REQUEST_APPROVAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_approval_snapshot_immutable BEFORE UPDATE OR DELETE ON request_approvals
  FOR EACH ROW EXECUTE FUNCTION protect_request_approval_snapshot();

CREATE TABLE request_approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES request_approvals(id),
  action text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER request_approval_event_immutable BEFORE UPDATE OR DELETE ON request_approval_events
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();

-- Only authenticated, known-instance callback hints belong here. No callback body is stored.
CREATE TABLE request_approval_hints (
  corp_id text NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  approval_id uuid NOT NULL REFERENCES request_approvals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(corp_id,event_id)
);
