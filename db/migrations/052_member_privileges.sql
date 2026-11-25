CREATE TABLE member_privilege_audits (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL REFERENCES employees(id),
  group_id text NOT NULL REFERENCES support_groups(id),
  employee_id text NOT NULL REFERENCES employees(id),
  request_hash text NOT NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  response jsonb NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_privilege_audit_group ON member_privilege_audits(group_id,created_at DESC);
CREATE TRIGGER member_privilege_audit_immutable BEFORE UPDATE OR DELETE ON member_privilege_audits
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();

ALTER VIEW operation_log_entries RENAME TO operation_log_entries_before_member_privileges;
CREATE VIEW operation_log_entries AS
SELECT * FROM operation_log_entries_before_member_privileges
UNION ALL
SELECT 'member-privileges:'||a.id,'roles',a.actor_id,a.group_id,
  g.name||' / '||e.display_name,'MEMBER_PRIVILEGES_APPLIED','APPLIED',a.reason,a.created_at,
  'member_privilege_audits',a.id::text,a.id::text,a.before_value,a.after_value,NULL
FROM member_privilege_audits a JOIN support_groups g ON g.id=a.group_id JOIN employees e ON e.id=a.employee_id;
