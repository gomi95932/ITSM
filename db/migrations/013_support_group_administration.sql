ALTER TABLE support_groups ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE group_membership_changes (
  id uuid PRIMARY KEY,
  group_id text NOT NULL REFERENCES support_groups(id),
  employee_id text NOT NULL REFERENCES employees(id),
  operation text NOT NULL CHECK (operation IN ('ADD','REMOVE')),
  group_version integer NOT NULL CHECK (group_version > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by text NOT NULL REFERENCES employees(id),
  reviewed_by text REFERENCES employees(id),
  reason text NOT NULL,
  review_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CHECK (requested_by <> employee_id),
  CHECK (reviewed_by IS NULL OR (reviewed_by <> requested_by AND reviewed_by <> employee_id)),
  CHECK ((status='PENDING' AND reviewed_by IS NULL) OR (status<>'PENDING' AND reviewed_by IS NOT NULL))
);
CREATE UNIQUE INDEX group_membership_changes_pending ON group_membership_changes(group_id,employee_id) WHERE status='PENDING';
CREATE INDEX group_membership_changes_recent ON group_membership_changes(group_id,created_at DESC,id);

CREATE TABLE support_group_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id text NOT NULL REFERENCES support_groups(id),
  change_id uuid REFERENCES group_membership_changes(id),
  actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('CREATED','RENAMED','MEMBER_PROPOSED','MEMBER_APPROVED','MEMBER_REJECTED')),
  before_value jsonb,
  after_value jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_group_audits_history ON support_group_audits(group_id,created_at DESC,id);
