CREATE OR REPLACE FUNCTION protect_ticket_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_ticket RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT requester_id,service_type,status INTO source_ticket FROM tickets WHERE id=NEW.ticket_id FOR SHARE;
    IF NOT FOUND OR source_ticket.requester_id <> NEW.requester_id
      OR source_ticket.service_type NOT IN ('INC', 'REQ') OR source_ticket.status <> 'CLOSED' THEN
      RAISE EXCEPTION 'TICKET_FEEDBACK_NOT_ALLOWED';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TICKET_FEEDBACK_IMMUTABLE';
END;
$$;
