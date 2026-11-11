-- Peer review records a separate check of the downstream grant without changing its lifecycle state.
ALTER TABLE request_fulfillments ADD COLUMN reviewed_at timestamptz;
ALTER TABLE request_fulfillments ADD COLUMN reviewed_by text REFERENCES employees(id);
ALTER TABLE request_fulfillments ADD CONSTRAINT request_fulfillment_review_pair
  CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL));
ALTER TABLE request_fulfillments ADD CONSTRAINT request_fulfillment_review_after_delivery
  CHECK (reviewed_at IS NULL OR (delivered_at IS NOT NULL AND reviewed_at >= delivered_at AND reviewed_by <> assignee_id));

CREATE OR REPLACE FUNCTION protect_request_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'REQUEST_FULFILLMENT_IMMUTABLE'; END IF;
  IF (NEW.id,NEW.approval_id,NEW.ticket_id,NEW.created_at,NEW.ready_until,NEW.assignee_id)
    IS DISTINCT FROM (OLD.id,OLD.approval_id,OLD.ticket_id,OLD.created_at,OLD.ready_until,OLD.assignee_id)
    OR (OLD.delivered_at IS NOT NULL AND (NEW.delivered_at,NEW.access_expires_at)
      IS DISTINCT FROM (OLD.delivered_at,OLD.access_expires_at))
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (OLD.reviewed_at IS NOT NULL AND (NEW.reviewed_at,NEW.reviewed_by)
      IS DISTINCT FROM (OLD.reviewed_at,OLD.reviewed_by)) THEN
    RAISE EXCEPTION 'REQUEST_FULFILLMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
