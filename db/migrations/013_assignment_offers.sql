CREATE TABLE assignment_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id text NOT NULL REFERENCES support_groups(id),
  priority text NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  receive_minutes integer NOT NULL CHECK (receive_minutes BETWEEN 1 AND 10080),
  calendar_snapshot jsonb NOT NULL CHECK (jsonb_typeof(calendar_snapshot)='object'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL CHECK (valid_to>valid_from),
  proposed_by text NOT NULL REFERENCES employees(id),
  approved_by text NOT NULL REFERENCES employees(id),
  approved_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  CHECK (proposed_by<>approved_by)
);
CREATE UNIQUE INDEX assignment_policy_active ON assignment_policy_versions(group_id,priority) WHERE active;

ALTER TABLE tickets ADD COLUMN assignment_kind text CHECK (assignment_kind IN ('OFFER','HANDOVER'));
ALTER TABLE tickets ADD COLUMN assignment_state text CHECK (assignment_state IN ('PENDING','ACCEPTED','DECLINED','CANCELLED','EXPIRED','INVALIDATED'));
ALTER TABLE tickets ADD COLUMN assignment_offered_at timestamptz;
ALTER TABLE tickets ADD COLUMN assignment_due_at timestamptz;
ALTER TABLE tickets ADD COLUMN assignment_policy_version_id uuid REFERENCES assignment_policy_versions(id);
UPDATE tickets SET assignment_kind='HANDOVER',assignment_state='PENDING',assignment_offered_at=updated_at
  WHERE pending_assignee_id IS NOT NULL;
ALTER TABLE tickets ADD CONSTRAINT tickets_assignment_pending CHECK (
  (pending_assignee_id IS NOT NULL AND assignment_kind IS NOT NULL AND assignment_state IS NOT DISTINCT FROM 'PENDING' AND assignment_offered_at IS NOT NULL)
  OR (pending_assignee_id IS NULL AND assignment_kind IS NULL AND assignment_state IS DISTINCT FROM 'PENDING'
    AND assignment_offered_at IS NULL AND assignment_due_at IS NULL AND assignment_policy_version_id IS NULL)
);
ALTER TABLE tickets ADD CONSTRAINT tickets_assignment_offer_group CHECK (
  assignment_kind IS DISTINCT FROM 'OFFER' OR (assignee_id IS NULL AND owner_group_id=pending_group_id)
);
CREATE INDEX tickets_assignment_deadline ON tickets(assignment_due_at,id)
  WHERE pending_assignee_id IS NOT NULL AND assignment_due_at IS NOT NULL;
