ALTER TABLE outbox_events ADD COLUMN audience_checked_at timestamptz;
CREATE INDEX outbox_audience_recheck ON outbox_events(audience_checked_at NULLS FIRST,created_at,id)
  WHERE expanded_at IS NOT NULL;

-- Both recipient checks and recovery use the same current obligation, including closed-ticket revocation.
CREATE VIEW request_fulfillment_active_signals AS
  SELECT s.*,f.ticket_id FROM request_fulfillment_signals s
  JOIN ticket_events v ON v.id=s.event_id AND v.action='FULFILLMENT_'||s.kind
  JOIN request_fulfillments f ON f.id=s.fulfillment_id AND f.ticket_id=v.ticket_id
  JOIN tickets t ON t.id=f.ticket_id AND t.owner_group_id=s.group_id
  JOIN support_groups g ON g.id=s.group_id AND g.enabled
  WHERE (
    (s.kind IN ('REVIEW_REQUIRED','REVIEW_OVERDUE') AND f.state='DELIVERED'
      AND f.access_expires_at>clock_timestamp() AND f.reviewed_at IS NULL) OR
    (s.kind IN ('REVOKE_REQUIRED','REVOKE_OVERDUE') AND (f.state='REVOKE_DUE'
      OR (f.state='DELIVERED' AND f.access_expires_at<=clock_timestamp())))
  ) AND (s.kind IN ('REVIEW_REQUIRED','REVOKE_REQUIRED') OR s.escalate_at<=clock_timestamp());
