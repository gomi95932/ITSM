LOCK TABLE tickets IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE responsibility_recording (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO responsibility_recording(id) VALUES(true);

CREATE TABLE ticket_responsibility_history (
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  revision integer NOT NULL CHECK(revision>0),
  source text NOT NULL CHECK(source IN ('CREATED','BASELINE','CHANGE')),
  observed_at timestamptz NOT NULL,
  clock_adjusted boolean NOT NULL DEFAULT false,
  ticket_number text NOT NULL,
  ticket_version integer NOT NULL,
  responsibility_epoch integer NOT NULL,
  owner_group_id text NOT NULL REFERENCES support_groups(id),
  owner_group_name text NOT NULL,
  assignee_id text REFERENCES employees(id),
  assignee_name text,
  status text NOT NULL,
  service_code text NOT NULL,
  service_type text NOT NULL CHECK(service_type IN ('INC','REQ','GEN')),
  pending_group_id text,
  pending_assignee_id text,
  assignment_kind text,
  assignment_state text,
  routing_version text,
  domain_id text,
  system_id text,
  primary_position_id text,
  PRIMARY KEY(ticket_id,revision),
  CHECK((revision=1 AND source IN ('CREATED','BASELINE')) OR (revision>1 AND source='CHANGE')),
  CHECK((assignee_id IS NULL)=(assignee_name IS NULL))
);
CREATE INDEX responsibility_history_group_time ON ticket_responsibility_history(owner_group_id,service_type,observed_at);

INSERT INTO ticket_responsibility_history(ticket_id,revision,source,observed_at,ticket_number,ticket_version,
  responsibility_epoch,owner_group_id,owner_group_name,assignee_id,assignee_name,status,service_code,service_type,
  pending_group_id,pending_assignee_id,assignment_kind,assignment_state,routing_version,domain_id,system_id,primary_position_id)
SELECT t.id,1,'BASELINE',r.started_at,t.number,t.version,t.responsibility_epoch,t.owner_group_id,g.name,
  t.assignee_id,e.display_name,t.status,t.service_code,t.service_type,t.pending_group_id,t.pending_assignee_id,
  t.assignment_kind,t.assignment_state,t.service_routing_snapshot->>'version',
  t.service_routing_snapshot->>'domainId',t.service_routing_snapshot->>'systemId',t.service_routing_snapshot->>'primaryPositionId'
FROM tickets t JOIN support_groups g ON g.id=t.owner_group_id LEFT JOIN employees e ON e.id=t.assignee_id
CROSS JOIN responsibility_recording r;

CREATE FUNCTION capture_ticket_responsibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous ticket_responsibility_history%ROWTYPE; observed timestamptz; actual_clock timestamptz;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.owner_group_id,NEW.assignee_id,NEW.status,NEW.service_code,NEW.service_type,NEW.number,
      NEW.pending_group_id,NEW.pending_assignee_id,NEW.assignment_kind,NEW.assignment_state,NEW.service_routing_snapshot)
      IS NOT DISTINCT FROM ROW(OLD.owner_group_id,OLD.assignee_id,OLD.status,OLD.service_code,OLD.service_type,OLD.number,
      OLD.pending_group_id,OLD.pending_assignee_id,OLD.assignment_kind,OLD.assignment_state,OLD.service_routing_snapshot) THEN
      RETURN NEW;
    END IF;
    SELECT * INTO STRICT previous FROM ticket_responsibility_history WHERE ticket_id=NEW.id ORDER BY revision DESC LIMIT 1;
  END IF;
  actual_clock:=clock_timestamp();
  observed:=greatest(actual_clock,previous.observed_at);
  INSERT INTO ticket_responsibility_history(ticket_id,revision,source,observed_at,clock_adjusted,ticket_number,ticket_version,
    responsibility_epoch,owner_group_id,owner_group_name,assignee_id,assignee_name,status,service_code,service_type,
    pending_group_id,pending_assignee_id,assignment_kind,assignment_state,routing_version,domain_id,system_id,primary_position_id)
  SELECT NEW.id,coalesce(previous.revision,0)+1,CASE WHEN TG_OP='INSERT' THEN 'CREATED' ELSE 'CHANGE' END,
    observed,actual_clock<coalesce(previous.observed_at,actual_clock),NEW.number,NEW.version,NEW.responsibility_epoch,
    NEW.owner_group_id,g.name,NEW.assignee_id,e.display_name,NEW.status,NEW.service_code,NEW.service_type,
    NEW.pending_group_id,NEW.pending_assignee_id,NEW.assignment_kind,NEW.assignment_state,
    NEW.service_routing_snapshot->>'version',NEW.service_routing_snapshot->>'domainId',
    NEW.service_routing_snapshot->>'systemId',NEW.service_routing_snapshot->>'primaryPositionId'
  FROM support_groups g LEFT JOIN employees e ON e.id=NEW.assignee_id WHERE g.id=NEW.owner_group_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tickets_capture_responsibility AFTER INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION capture_ticket_responsibility();

CREATE FUNCTION reject_responsibility_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RESPONSIBILITY_HISTORY_APPEND_ONLY';
END;
$$;
CREATE TRIGGER responsibility_history_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON ticket_responsibility_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_history_change();
CREATE TRIGGER responsibility_recording_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON responsibility_recording
  FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_history_change();
