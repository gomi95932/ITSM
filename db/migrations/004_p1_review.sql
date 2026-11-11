CREATE TABLE priority_reviewers (
  employee_id text NOT NULL REFERENCES employees(id),
  group_id text NOT NULL REFERENCES support_groups(id),
  PRIMARY KEY (employee_id, group_id),
  FOREIGN KEY (employee_id,group_id) REFERENCES group_memberships(employee_id,group_id) ON DELETE CASCADE
);
ALTER TABLE tickets ADD COLUMN priority_review_state text NOT NULL DEFAULT 'NOT_REQUIRED'
  CHECK (priority_review_state IN ('NOT_REQUIRED','PENDING','CONFIRMED','ADJUSTED'));
ALTER TABLE tickets ADD COLUMN priority_candidate_at timestamptz;
ALTER TABLE tickets ADD COLUMN priority_reviewed_at timestamptz;
ALTER TABLE tickets ADD COLUMN priority_reviewed_by text REFERENCES employees(id);
ALTER TABLE tickets ADD COLUMN priority_review_reason text;
ALTER TABLE tickets ADD CONSTRAINT priority_review_consistency CHECK (
  (priority_review_state='NOT_REQUIRED' AND priority_candidate_at IS NULL AND priority_reviewed_at IS NULL AND priority_reviewed_by IS NULL AND priority_review_reason IS NULL)
  OR (priority_review_state='PENDING' AND priority_candidate_at IS NOT NULL AND priority_reviewed_at IS NULL AND priority_reviewed_by IS NULL AND priority_review_reason IS NULL)
  OR (priority_review_state IN ('CONFIRMED','ADJUSTED') AND priority_candidate_at IS NOT NULL
    AND priority_reviewed_at IS NOT NULL AND priority_reviewed_by IS NOT NULL AND priority_review_reason IS NOT NULL
    AND length(trim(priority_review_reason))>0)
);
UPDATE tickets SET priority_review_state='PENDING',priority_candidate_at=created_at
  WHERE priority='P1' AND status NOT IN ('CLOSED','CANCELLED','REJECTED');
CREATE INDEX tickets_pending_priority_review ON tickets(priority_candidate_at,id) WHERE priority_review_state='PENDING';
CREATE TABLE priority_review_signals (
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  kind text NOT NULL CHECK (kind IN ('CANDIDATE','OVERDUE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id,kind)
);
