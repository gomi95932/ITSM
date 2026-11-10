-- Appointments are explicit. A production deployment starts with no request catalog publishers.
CREATE TABLE request_catalog_publishers (
  employee_id text NOT NULL REFERENCES employees(id),
  service_code text NOT NULL REFERENCES service_catalog(code),
  PRIMARY KEY(employee_id,service_code)
);

CREATE TABLE request_catalog_versions (
  service_code text NOT NULL REFERENCES service_catalog(code),
  form_version integer NOT NULL CHECK (form_version > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  published_by text REFERENCES employees(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(service_code,form_version)
);

CREATE FUNCTION reject_request_catalog_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'REQUEST_CATALOG_VERSION_IMMUTABLE';
END;
$$;
CREATE TRIGGER request_catalog_version_immutable BEFORE UPDATE OR DELETE ON request_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();

CREATE TABLE request_catalog_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_code text NOT NULL REFERENCES service_catalog(code),
  actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('PUBLISH','UNPUBLISH')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  response jsonb NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_code,actor_id,idempotency_key)
);
