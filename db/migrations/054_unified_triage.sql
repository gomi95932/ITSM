CREATE TABLE triage_policy_versions (
  version integer PRIMARY KEY CHECK(version>0), request_id uuid NOT NULL UNIQUE,
  enabled boolean NOT NULL, primary_employee_id text REFERENCES employees(id),
  backup_employee_id text REFERENCES employees(id), reminder_minutes integer NOT NULL CHECK(reminder_minutes BETWEEN 1 AND 10080),
  actor_id text NOT NULL REFERENCES employees(id), reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(NOT enabled OR primary_employee_id IS NOT NULL),
  CHECK(backup_employee_id IS NULL OR backup_employee_id<>primary_employee_id)
);
CREATE TRIGGER immutable_triage_policy BEFORE UPDATE OR DELETE ON triage_policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
CREATE TABLE ticket_triage_responsibilities (
  ticket_id uuid PRIMARY KEY REFERENCES tickets(id), policy_version integer NOT NULL REFERENCES triage_policy_versions(version),
  primary_employee_id text REFERENCES employees(id), backup_employee_id text REFERENCES employees(id),
  reminder_minutes integer NOT NULL CHECK(reminder_minutes BETWEEN 1 AND 10080),
  coordinator_id text REFERENCES employees(id), stage text NOT NULL CHECK(stage IN ('PRIMARY','BACKUP','ESCALATED','COMPLETED')),
  reason text NOT NULL, due_at timestamptz, generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((stage IN ('PRIMARY','BACKUP') AND coordinator_id IS NOT NULL AND due_at IS NOT NULL)
    OR (stage IN ('ESCALATED','COMPLETED') AND coordinator_id IS NULL AND due_at IS NULL))
);
CREATE INDEX triage_pending ON ticket_triage_responsibilities(checked_at,ticket_id) WHERE stage<>'COMPLETED';
CREATE TABLE triage_transfer_requests (
  request_id uuid PRIMARY KEY, ticket_id uuid NOT NULL REFERENCES tickets(id), actor_id text NOT NULL REFERENCES employees(id),
  input jsonb NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_triage_transfer BEFORE UPDATE OR DELETE ON triage_transfer_requests
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
CREATE FUNCTION ticket_triage_access(target uuid,employee text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM ticket_triage_responsibilities r JOIN tickets t ON t.id=r.ticket_id
    JOIN employees e ON e.id=r.coordinator_id AND e.active
    WHERE r.ticket_id=target AND r.coordinator_id=employee AND r.stage IN ('PRIMARY','BACKUP')
      AND t.assignee_id IS NULL AND t.pending_assignee_id IS NULL
      AND (t.status='QUEUED' OR (t.service_type='REQ' AND t.status='IN_PROGRESS')));
$$;
ALTER TABLE assignment_policy_versions ADD COLUMN management_mode text NOT NULL DEFAULT 'REVIEW'
  CHECK(management_mode IN ('REVIEW','ADMIN_DIRECT'));
ALTER TABLE routing_config_proposals ADD COLUMN management_mode text NOT NULL DEFAULT 'REVIEW'
  CHECK(management_mode IN ('REVIEW','ADMIN_DIRECT'));
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conrelid::regclass AS target,conname FROM pg_constraint
    WHERE contype='c' AND conrelid IN ('assignment_policy_versions'::regclass,'routing_config_proposals'::regclass)
      AND ((conrelid='assignment_policy_versions'::regclass AND pg_get_constraintdef(oid) LIKE '%proposed_by <> approved_by%')
        OR (conrelid='routing_config_proposals'::regclass AND pg_get_constraintdef(oid) LIKE '%reviewed_by <> proposed_by%'))
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.target,item.conname); END LOOP;
END $$;
ALTER TABLE assignment_policy_versions ADD CONSTRAINT assignment_policy_authority CHECK(
  (management_mode='ADMIN_DIRECT' AND proposed_by=approved_by) OR (management_mode='REVIEW' AND proposed_by<>approved_by));
ALTER TABLE routing_config_proposals ADD CONSTRAINT routing_config_authority CHECK(
  reviewed_by IS NULL OR (management_mode='ADMIN_DIRECT' AND proposed_by=reviewed_by)
    OR (management_mode='REVIEW' AND proposed_by<>reviewed_by));
ALTER VIEW operation_log_entries RENAME TO operation_log_entries_before_triage;
CREATE VIEW operation_log_entries AS SELECT * FROM operation_log_entries_before_triage
UNION ALL
SELECT 'triage-policy:'||v.version,'routing',v.actor_id,v.version::text,'统一兜底派单',
  'TRIAGE_POLICY_APPLIED','APPLIED',v.reason,v.created_at,'triage_policy_versions',v.version::text,NULL,
  (SELECT to_jsonb(p)-'reason'-'request_id' FROM triage_policy_versions p WHERE p.version<v.version ORDER BY p.version DESC LIMIT 1),
  to_jsonb(v)-'reason'-'request_id',NULL FROM triage_policy_versions v;
