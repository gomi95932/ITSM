CREATE TABLE ticket_feedback (
  ticket_id uuid PRIMARY KEY REFERENCES tickets(id),
  requester_id text NOT NULL REFERENCES employees(id),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION protect_ticket_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_ticket RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT requester_id,service_type,status INTO source_ticket FROM tickets WHERE id=NEW.ticket_id FOR SHARE;
    IF NOT FOUND OR source_ticket.requester_id <> NEW.requester_id
      OR source_ticket.service_type <> 'INC' OR source_ticket.status <> 'CLOSED' THEN
      RAISE EXCEPTION 'TICKET_FEEDBACK_NOT_ALLOWED';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TICKET_FEEDBACK_IMMUTABLE';
END;
$$;
CREATE TRIGGER ticket_feedback_guard BEFORE INSERT OR UPDATE OR DELETE ON ticket_feedback
  FOR EACH ROW EXECUTE FUNCTION protect_ticket_feedback();
