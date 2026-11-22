ALTER TABLE sla_calendars ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sla_calendars ADD COLUMN created_by text REFERENCES employees(id);
CREATE TABLE sla_calendar_proposals (
  id uuid PRIMARY KEY,
  expected_version integer NOT NULL CHECK(expected_version > 0),
  config jsonb NOT NULL,
  proposed_by text NOT NULL REFERENCES employees(id),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by text REFERENCES employees(id), review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CHECK(reviewed_by IS NULL OR reviewed_by <> proposed_by)
);
CREATE FUNCTION reject_sla_calendar_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SLA_CALENDAR_IMMUTABLE';
END;
$$;
CREATE TRIGGER sla_calendar_immutable BEFORE UPDATE OR DELETE ON sla_calendars
  FOR EACH ROW EXECUTE FUNCTION reject_sla_calendar_mutation();
