CREATE TABLE IF NOT EXISTS employees (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS support_groups (
  id text PRIMARY KEY,
  name text NOT NULL
);
CREATE TABLE IF NOT EXISTS group_memberships (
  employee_id text NOT NULL REFERENCES employees(id),
  group_id text NOT NULL REFERENCES support_groups(id),
  PRIMARY KEY (employee_id, group_id)
);
CREATE TABLE IF NOT EXISTS service_catalog (
  code text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('INC', 'REQ')),
  form_version integer NOT NULL CHECK (form_version > 0),
  published boolean NOT NULL DEFAULT false,
  group_id text NOT NULL REFERENCES support_groups(id),
  required_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_fields) = 'array')
);
CREATE SEQUENCE IF NOT EXISTS ticket_number_seq;
CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  requester_id text NOT NULL REFERENCES employees(id),
  owner_group_id text NOT NULL REFERENCES support_groups(id),
  service_code text NOT NULL REFERENCES service_catalog(code),
  service_type text NOT NULL CHECK (service_type IN ('INC', 'REQ')),
  form_version integer NOT NULL,
  subject text NOT NULL,
  description text NOT NULL,
  fields jsonb NOT NULL,
  impact text NOT NULL,
  urgency text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tickets_requester_recent ON tickets(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_group_recent ON tickets(owner_group_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  actor_id text NOT NULL,
  action text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_events_timeline ON ticket_events(ticket_id, created_at, id);
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  event_id uuid NOT NULL UNIQUE REFERENCES ticket_events(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  event_id uuid NOT NULL UNIQUE REFERENCES ticket_events(id),
  actor_id text NOT NULL,
  request_id text NOT NULL,
  action text NOT NULL,
  before_value jsonb,
  after_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_idempotency (
  actor_id text NOT NULL,
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  PRIMARY KEY (actor_id, scope, key)
);
