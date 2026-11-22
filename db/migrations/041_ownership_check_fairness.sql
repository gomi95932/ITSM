ALTER TABLE tickets ADD COLUMN ownership_checked_at timestamptz;
CREATE INDEX tickets_ownership_check_idx ON tickets (ownership_checked_at NULLS FIRST,id)
  WHERE status NOT IN ('CLOSED','CANCELLED','REJECTED');
