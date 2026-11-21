CREATE TABLE priority_policy_versions (
  version integer PRIMARY KEY CHECK(version>0), config jsonb NOT NULL,
  approved boolean NOT NULL DEFAULT false, created_by text REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO priority_policy_versions(version,config) VALUES(1,'{"matrix":{"COMPANY":{"HIGH":"P1","MEDIUM":"P1","LOW":"P2"},"DEPARTMENT":{"HIGH":"P1","MEDIUM":"P2","LOW":"P3"},"INDIVIDUAL":{"HIGH":"P2","MEDIUM":"P3","LOW":"P4"}},"targets":{"P1":{"response":15,"resolution":240},"P2":{"response":30,"resolution":480},"P3":{"response":240,"resolution":1080},"P4":{"response":540,"resolution":2700}},"criticalServices":[],"reviewMinutes":5}');
CREATE TABLE priority_policy_proposals (
  id uuid PRIMARY KEY, expected_version integer NOT NULL, config jsonb NOT NULL,
  proposed_by text NOT NULL REFERENCES employees(id), reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by text REFERENCES employees(id), review_reason text, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
  CHECK(reviewed_by IS NULL OR reviewed_by<>proposed_by)
);
ALTER TABLE tickets ADD COLUMN initial_priority text;
ALTER TABLE tickets ADD COLUMN priority_policy_snapshot jsonb;
ALTER TABLE tickets ADD COLUMN priority_changed_by text REFERENCES employees(id);
ALTER TABLE tickets ADD COLUMN priority_review_generation integer NOT NULL DEFAULT 1 CHECK(priority_review_generation>0);
UPDATE tickets t SET initial_priority=COALESCE(
  (SELECT e.detail->>'oldPriority' FROM ticket_events e WHERE e.ticket_id=t.id AND e.action='PRIORITY_REVIEWED' ORDER BY e.created_at,e.id LIMIT 1),t.priority),
  priority_policy_snapshot=(SELECT jsonb_build_object('version',version,'approved',approved,'config',config) FROM priority_policy_versions WHERE version=1);
ALTER TABLE tickets ALTER COLUMN initial_priority SET NOT NULL;
ALTER TABLE tickets ADD CONSTRAINT initial_priority_values CHECK(initial_priority IN ('P1','P2','P3','P4'));
-- Existing writers remain compatible; application creation supplies the same immutable baseline explicitly.
CREATE FUNCTION set_initial_priority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.initial_priority IS NULL THEN NEW.initial_priority:=NEW.priority; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_initial_priority BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION set_initial_priority();
ALTER TABLE priority_review_signals ADD COLUMN generation integer NOT NULL DEFAULT 1;
ALTER TABLE priority_review_signals DROP CONSTRAINT priority_review_signals_pkey;
ALTER TABLE priority_review_signals ADD PRIMARY KEY(ticket_id,kind,generation);
ALTER TABLE sla_cycles ADD COLUMN priority_obligations jsonb NOT NULL DEFAULT '[]';
ALTER TABLE sla_cycles ADD COLUMN pause_history jsonb NOT NULL DEFAULT '[]';
CREATE FUNCTION preserve_priority_pause_intervals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.paused_at IS NOT NULL AND NEW.paused_at IS DISTINCT FROM OLD.paused_at THEN
    NEW.pause_history:=OLD.pause_history||jsonb_build_array(jsonb_build_object('from',OLD.paused_at,'to',COALESCE(NEW.completed_at,clock_timestamp())));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sla_priority_pause_intervals BEFORE UPDATE ON sla_cycles FOR EACH ROW EXECUTE FUNCTION preserve_priority_pause_intervals();
