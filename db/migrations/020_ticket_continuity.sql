ALTER TABLE tickets ADD COLUMN responsibility_epoch integer NOT NULL DEFAULT 1 CHECK(responsibility_epoch>0);
CREATE FUNCTION advance_responsibility_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.responsibility_epoch := OLD.responsibility_epoch + CASE WHEN
    OLD.assignee_id IS DISTINCT FROM NEW.assignee_id OR OLD.owner_group_id IS DISTINCT FROM NEW.owner_group_id
    OR OLD.service_routing_snapshot IS DISTINCT FROM NEW.service_routing_snapshot THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tickets_responsibility_epoch BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION advance_responsibility_epoch();

CREATE TABLE ticket_continuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  employee_id text NOT NULL REFERENCES employees(id),
  group_id text NOT NULL REFERENCES support_groups(id),
  responsibility_epoch integer NOT NULL CHECK(responsibility_epoch>0),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','REVOKED')),
  expires_at timestamptz NOT NULL,
  proposed_by text NOT NULL REFERENCES employees(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  reviewed_by text REFERENCES employees(id),
  reviewed_at timestamptz,
  revoked_by text REFERENCES employees(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
  CHECK(reviewed_by IS NULL OR (reviewed_by<>proposed_by AND reviewed_by<>employee_id)),
  CHECK((status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status<>'PENDING' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK((status='REVOKED' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
    OR (status<>'REVOKED' AND revoked_by IS NULL AND revoked_at IS NULL))
);
CREATE UNIQUE INDEX ticket_continuations_pending ON ticket_continuations(ticket_id,responsibility_epoch) WHERE status='PENDING';
CREATE INDEX ticket_continuations_lookup ON ticket_continuations(ticket_id,employee_id,responsibility_epoch);

CREATE FUNCTION ticket_processing_eligible(target uuid,employee text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM tickets t JOIN employees e ON e.id=employee AND e.active
    JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=t.owner_group_id
    JOIN support_groups g ON g.id=m.group_id AND g.enabled
    WHERE t.id=target AND t.assignee_id=e.id AND (service_position_eligible(t.service_routing_snapshot,e.id,t.owner_group_id)
      OR EXISTS(SELECT 1 FROM ticket_continuations c WHERE c.ticket_id=t.id AND c.employee_id=e.id
        AND c.group_id=t.owner_group_id AND c.responsibility_epoch=t.responsibility_epoch
        AND c.status='APPROVED' AND c.expires_at>clock_timestamp())));
$$;

ALTER TABLE ticket_routing_alerts DROP CONSTRAINT ticket_routing_alerts_reason_check;
ALTER TABLE ticket_routing_alerts ADD CONSTRAINT ticket_routing_alerts_reason_check
  CHECK(reason IN ('NO_ACTIVE_FALLBACK','NO_POSITION_COVERAGE','OWNER_APPOINTMENT_REQUIRED'));
