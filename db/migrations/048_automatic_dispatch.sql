CREATE TABLE automatic_dispatch_policies (
  service_code text NOT NULL REFERENCES service_catalog(code),
  version integer NOT NULL CHECK(version>0),
  enabled boolean NOT NULL,
  primary_minutes integer NOT NULL CHECK(primary_minutes BETWEEN 1 AND 10080),
  backup_minutes integer NOT NULL CHECK(backup_minutes BETWEEN 1 AND 10080),
  actor_id text NOT NULL REFERENCES employees(id),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(service_code,version)
);
CREATE FUNCTION preserve_automatic_dispatch_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AUTOMATIC_DISPATCH_POLICY_IMMUTABLE'; END;
$$;
CREATE TRIGGER automatic_dispatch_policy_immutable BEFORE UPDATE OR DELETE ON automatic_dispatch_policies
  FOR EACH ROW EXECUTE FUNCTION preserve_automatic_dispatch_policy();

CREATE TABLE automatic_dispatch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL UNIQUE REFERENCES tickets(id),
  snapshot jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('WAITING','OFFERED','ACCEPTED','ESCALATED','MANUAL','STOPPED')),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX automatic_dispatch_pending ON automatic_dispatch_runs(checked_at,ticket_id)
  WHERE state IN ('WAITING','OFFERED');
CREATE TABLE automatic_dispatch_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES automatic_dispatch_runs(id),
  employee_id text NOT NULL REFERENCES employees(id),
  duty text NOT NULL CHECK(duty IN ('PRIMARY','BACKUP')),
  state text NOT NULL CHECK(state IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','INVALIDATED','CANCELLED')),
  offered_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE(run_id,employee_id)
);
CREATE UNIQUE INDEX automatic_dispatch_one_pending ON automatic_dispatch_attempts(run_id) WHERE state='PENDING';
ALTER TABLE ticket_routing_alerts DROP CONSTRAINT ticket_routing_alerts_reason_check;
ALTER TABLE ticket_routing_alerts ADD CONSTRAINT ticket_routing_alerts_reason_check
  CHECK(reason IN ('NO_ACTIVE_FALLBACK','NO_POSITION_COVERAGE','OWNER_APPOINTMENT_REQUIRED','AUTO_DISPATCH_EXHAUSTED'));
