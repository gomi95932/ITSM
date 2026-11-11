ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS field_schema jsonb NOT NULL DEFAULT '[]';
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS visible_groups jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS catalog_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS tickets_sla_scan ON tickets(sla_checked_at NULLS FIRST);
CREATE TABLE IF NOT EXISTS identity_links (
  corp_id text NOT NULL, ding_user_id text NOT NULL,
  employee_id text NOT NULL REFERENCES employees(id),
  PRIMARY KEY(corp_id,ding_user_id), UNIQUE(corp_id,employee_id)
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY, csrf_token text NOT NULL,
  employee_id text NOT NULL REFERENCES employees(id), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_code_uses (code_hash text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sla_calendars (
  version integer PRIMARY KEY, config jsonb NOT NULL,
  approved boolean NOT NULL DEFAULT false
);
INSERT INTO sla_calendars(version,config) VALUES (1,'{"timeZone":"Asia/Shanghai","startHour":9,"endHour":18,"holidays":[],"workdays":[]}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS sla_cycles (
  ticket_id uuid NOT NULL REFERENCES tickets(id), cycle integer NOT NULL,
  priority text NOT NULL, calendar_snapshot jsonb NOT NULL,
  started_at timestamptz NOT NULL, response_target integer NOT NULL,
  resolution_target integer NOT NULL, responded_at timestamptz,
  completed_at timestamptz, paused_at timestamptz,
  paused_minutes double precision NOT NULL DEFAULT 0,
  PRIMARY KEY(ticket_id,cycle)
);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS expanded_at timestamptz;
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outbox_id uuid NOT NULL REFERENCES outbox_events(id),
  employee_id text NOT NULL REFERENCES employees(id), state text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
  last_error text, provider_task_id text, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(outbox_id,employee_id)
);
CREATE INDEX IF NOT EXISTS notification_due ON notification_deliveries(state,next_at);
CREATE TABLE IF NOT EXISTS voice_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL REFERENCES employees(id),
  candidate jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operational_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL, target_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intake_rate_limits (
  employee_id text NOT NULL REFERENCES employees(id), bucket timestamptz NOT NULL,
  count integer NOT NULL, PRIMARY KEY(employee_id,bucket)
);
CREATE TABLE IF NOT EXISTS sla_signals (
  ticket_id uuid NOT NULL REFERENCES tickets(id), cycle integer NOT NULL, kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(ticket_id,cycle,kind)
);
ALTER TABLE voice_drafts ADD COLUMN IF NOT EXISTS ticket_id uuid REFERENCES tickets(id);
