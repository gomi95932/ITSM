ALTER TABLE support_groups ADD COLUMN fallback_group_id text REFERENCES support_groups(id);
ALTER TABLE support_groups ADD CONSTRAINT support_groups_no_self_fallback
  CHECK (fallback_group_id IS DISTINCT FROM id);

CREATE TABLE ticket_routing_alerts (
  ticket_id uuid PRIMARY KEY REFERENCES tickets(id),
  reason text NOT NULL CHECK (reason='NO_ACTIVE_FALLBACK'),
  owner_group_id text NOT NULL REFERENCES support_groups(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX ticket_routing_alerts_open ON ticket_routing_alerts(opened_at,ticket_id)
  WHERE resolved_at IS NULL;
