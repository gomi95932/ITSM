CREATE TABLE request_fulfillment_signals (
  fulfillment_id uuid NOT NULL REFERENCES request_fulfillments(id),
  group_id text NOT NULL REFERENCES support_groups(id),
  kind text NOT NULL CHECK(kind IN ('REVIEW_REQUIRED','REVOKE_REQUIRED','REVIEW_OVERDUE','REVOKE_OVERDUE')),
  event_id uuid NOT NULL UNIQUE REFERENCES ticket_events(id),
  escalate_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(fulfillment_id,group_id,kind)
);
CREATE TRIGGER request_fulfillment_signals_immutable BEFORE UPDATE OR DELETE ON request_fulfillment_signals
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
CREATE INDEX request_fulfillment_revocation_history ON request_fulfillment_events(fulfillment_id,created_at)
  WHERE action='REVOCATION_REQUIRED';

-- Current obligations, not the ticket's status: a closed ticket may still require actual revocation.
CREATE VIEW request_fulfillment_attention_pending AS
  SELECT f.id AS fulfillment_id,f.approval_id,t.id AS ticket_id,t.owner_group_id AS group_id,
    obligation.kind,obligation.since_at,obligation.escalate_at
  FROM request_fulfillments f JOIN tickets t ON t.id=f.ticket_id
  JOIN support_groups g ON g.id=t.owner_group_id AND g.enabled
  LEFT JOIN request_fulfillment_signals review ON review.fulfillment_id=f.id
    AND review.group_id=t.owner_group_id AND review.kind='REVIEW_REQUIRED'
  LEFT JOIN request_fulfillment_signals revoke ON revoke.fulfillment_id=f.id
    AND revoke.group_id=t.owner_group_id AND revoke.kind='REVOKE_REQUIRED'
  CROSS JOIN LATERAL (
    SELECT f.state='DELIVERED' AND f.access_expires_at>clock_timestamp() AND f.reviewed_at IS NULL AS review_needed,
      (f.state='REVOKE_DUE' OR (f.state='DELIVERED' AND f.access_expires_at<=clock_timestamp())) AS revoke_needed,
      CASE WHEN f.state='REVOKE_DUE' THEN LEAST(f.access_expires_at,COALESCE(
        (SELECT min(e.created_at) FROM request_fulfillment_events e
          WHERE e.fulfillment_id=f.id AND e.action='REVOCATION_REQUIRED'),f.updated_at))
        ELSE f.access_expires_at END AS revoke_since
  ) current_need
  CROSS JOIN LATERAL (VALUES
    ('REVIEW_REQUIRED',current_need.review_needed,f.delivered_at,NULL::timestamptz),
    ('REVOKE_REQUIRED',current_need.revoke_needed,current_need.revoke_since,NULL::timestamptz),
    ('REVIEW_OVERDUE',current_need.review_needed AND review.escalate_at<=clock_timestamp(),f.delivered_at,review.escalate_at),
    ('REVOKE_OVERDUE',current_need.revoke_needed AND revoke.escalate_at<=clock_timestamp(),current_need.revoke_since,revoke.escalate_at)
  ) obligation(kind,needed,since_at,escalate_at)
  WHERE obligation.needed AND NOT EXISTS(SELECT 1 FROM request_fulfillment_signals s
    WHERE s.fulfillment_id=f.id AND s.group_id=t.owner_group_id AND s.kind=obligation.kind);
