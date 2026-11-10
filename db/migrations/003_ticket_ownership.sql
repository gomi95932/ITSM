ALTER TABLE tickets ADD COLUMN assignee_id text REFERENCES employees(id);
ALTER TABLE tickets ADD COLUMN pending_group_id text REFERENCES support_groups(id);
ALTER TABLE tickets ADD COLUMN pending_assignee_id text REFERENCES employees(id);
ALTER TABLE tickets ADD CONSTRAINT tickets_pending_owner_pair CHECK (
  (pending_group_id IS NULL) = (pending_assignee_id IS NULL)
);
CREATE INDEX tickets_personal_queue ON tickets(assignee_id, updated_at DESC);
CREATE INDEX tickets_handover_queue ON tickets(pending_assignee_id, updated_at DESC)
  WHERE pending_assignee_id IS NOT NULL;
