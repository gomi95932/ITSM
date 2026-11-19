ALTER TABLE tickets
  ADD COLUMN waiting_reason_code text,
  ADD COLUMN waiting_since timestamptz,
  ADD COLUMN waiting_due_at timestamptz,
  ADD CONSTRAINT ticket_waiting_metadata CHECK (
    (waiting_reason_code IS NULL AND waiting_since IS NULL AND waiting_due_at IS NULL)
    OR (waiting_reason_code IS NOT NULL AND waiting_since IS NOT NULL AND waiting_due_at IS NOT NULL
      AND isfinite(waiting_since) AND isfinite(waiting_due_at) AND waiting_due_at>waiting_since
      AND ((status='WAITING_USER' AND waiting_reason_code IN ('USER_INFORMATION','USER_AVAILABILITY'))
        OR (status='WAITING_VENDOR' AND waiting_reason_code IN ('VENDOR_SUPPORT','VENDOR_PARTS','VENDOR_CHANGE'))))
  );

-- Legacy waiting rows have unknown reasons and times; do not manufacture history.
CREATE FUNCTION clear_ticket_waiting_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('WAITING_USER','WAITING_VENDOR') THEN
    NEW.waiting_reason_code:=NULL; NEW.waiting_since:=NULL; NEW.waiting_due_at:=NULL;
  ELSIF TG_OP='UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      AND ROW(NEW.waiting_reason_code,NEW.waiting_since,NEW.waiting_due_at)
        IS NOT DISTINCT FROM ROW(OLD.waiting_reason_code,OLD.waiting_since,OLD.waiting_due_at) THEN
      NEW.waiting_reason_code:=NULL; NEW.waiting_since:=NULL; NEW.waiting_due_at:=NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tickets_clear_waiting_metadata BEFORE INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION clear_ticket_waiting_metadata();
