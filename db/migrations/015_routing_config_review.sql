ALTER TABLE support_groups ADD COLUMN routing_version integer NOT NULL DEFAULT 1 CHECK (routing_version > 0);

CREATE TABLE routing_config_proposals (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ASSIGNMENT_POLICY','FALLBACK')),
  group_id text NOT NULL REFERENCES support_groups(id),
  priority text CHECK (priority IN ('P1','P2','P3','P4')),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
  expected_policy_id uuid REFERENCES assignment_policy_versions(id),
  expected_routing_version integer CHECK (expected_routing_version > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  proposed_by text NOT NULL REFERENCES employees(id),
  reviewed_by text REFERENCES employees(id),
  reason text NOT NULL,
  review_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CHECK ((kind='ASSIGNMENT_POLICY' AND priority IS NOT NULL AND expected_routing_version IS NULL)
    OR (kind='FALLBACK' AND priority IS NULL AND expected_policy_id IS NULL AND expected_routing_version IS NOT NULL)),
  CHECK (reviewed_by IS NULL OR reviewed_by<>proposed_by)
);
CREATE UNIQUE INDEX routing_config_pending ON routing_config_proposals(group_id,kind,COALESCE(priority,''))
  WHERE status='PENDING';
CREATE INDEX routing_config_history ON routing_config_proposals(created_at DESC,id DESC);

CREATE TABLE routing_config_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES routing_config_proposals(id),
  actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('PROPOSED','APPROVED','REJECTED')),
  before_value jsonb,
  after_value jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routing_config_audits_history ON routing_config_audits(proposal_id,created_at,id);
