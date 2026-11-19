CREATE TABLE ticket_waiting_signals (
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  group_id text NOT NULL REFERENCES support_groups(id),
  waiting_status text NOT NULL,
  waiting_reason_code text NOT NULL,
  waiting_since timestamptz NOT NULL,
  waiting_due_at timestamptz NOT NULL,
  event_id uuid NOT NULL UNIQUE REFERENCES ticket_events(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(ticket_id,group_id,waiting_since,waiting_due_at,waiting_reason_code),
  CHECK(isfinite(waiting_since) AND isfinite(waiting_due_at) AND waiting_due_at>waiting_since),
  CHECK((waiting_status='WAITING_USER' AND waiting_reason_code IN ('USER_INFORMATION','USER_AVAILABILITY'))
    OR (waiting_status='WAITING_VENDOR' AND waiting_reason_code IN ('VENDOR_SUPPORT','VENDOR_PARTS','VENDOR_CHANGE')))
);
CREATE TRIGGER ticket_waiting_signals_immutable BEFORE UPDATE OR DELETE ON ticket_waiting_signals
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
CREATE TRIGGER ticket_waiting_signals_no_truncate BEFORE TRUNCATE ON ticket_waiting_signals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_request_catalog_version_change();
CREATE INDEX tickets_waiting_follow_up_due ON tickets(waiting_due_at,id)
  WHERE status IN ('WAITING_USER','WAITING_VENDOR') AND waiting_due_at IS NOT NULL;

-- An old signal stops authorizing notifications as soon as its waiting episode or responsibility changes.
CREATE VIEW ticket_waiting_active_signals AS
  SELECT s.* FROM ticket_waiting_signals s
  JOIN ticket_events v ON v.id=s.event_id AND v.ticket_id=s.ticket_id
    AND v.action=s.waiting_status||'_FOLLOW_UP_DUE'
  JOIN tickets t ON t.id=s.ticket_id AND t.owner_group_id=s.group_id
    AND t.status=s.waiting_status AND t.waiting_reason_code=s.waiting_reason_code
    AND t.waiting_since=s.waiting_since AND t.waiting_due_at=s.waiting_due_at
  JOIN support_groups g ON g.id=s.group_id AND g.enabled
  WHERE s.waiting_due_at<=clock_timestamp();
