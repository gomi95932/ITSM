-- The HTTP boundary records intent; the worker re-inspects OA before recording delivery.
CREATE TABLE request_delivery_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES request_approvals(id),
  actor_id text NOT NULL REFERENCES employees(id),
  request_key uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('PREPARE','DELIVER')),
  expected_version integer NOT NULL,
  evidence_reference text,
  request_hash text NOT NULL CHECK(length(request_hash)=64),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SUCCEEDED','REJECTED')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
  completed_at timestamptz,
  UNIQUE(actor_id,request_key),
  CHECK(expires_at>created_at),
  CHECK((operation='PREPARE' AND expected_version=0 AND evidence_reference IS NULL) OR
    (operation='DELIVER' AND expected_version>0 AND evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$' AND evidence_reference IS NOT NULL)),
  CHECK((state='PENDING' AND result IS NULL AND error_code IS NULL AND completed_at IS NULL) OR
    (state='SUCCEEDED' AND jsonb_typeof(result)='object' AND result IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL) OR
    (state='REJECTED' AND result IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX request_delivery_commands_pending ON request_delivery_commands(created_at,id) WHERE state='PENDING';
CREATE UNIQUE INDEX request_delivery_commands_one_pending ON request_delivery_commands(approval_id) WHERE state='PENDING';
CREATE INDEX request_delivery_commands_actor ON request_delivery_commands(approval_id,actor_id,created_at DESC,id DESC);
CREATE FUNCTION protect_request_delivery_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REQUEST_DELIVERY_COMMAND_IMMUTABLE'; END IF;
  IF OLD.state<>'PENDING' OR NEW.state='PENDING' OR
    (NEW.id,NEW.approval_id,NEW.actor_id,NEW.request_key,NEW.operation,NEW.expected_version,NEW.evidence_reference,
      NEW.request_hash,NEW.created_at,NEW.expires_at) IS DISTINCT FROM
    (OLD.id,OLD.approval_id,OLD.actor_id,OLD.request_key,OLD.operation,OLD.expected_version,OLD.evidence_reference,
      OLD.request_hash,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'REQUEST_DELIVERY_COMMAND_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_delivery_command_immutable BEFORE UPDATE OR DELETE ON request_delivery_commands
  FOR EACH ROW EXECUTE FUNCTION protect_request_delivery_command();
