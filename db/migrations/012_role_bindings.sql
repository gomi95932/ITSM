CREATE TABLE role_bindings (
  id uuid PRIMARY KEY,
  employee_id text NOT NULL REFERENCES employees(id),
  role_code text NOT NULL CHECK (role_code IN ('PLATFORM_ADMIN','DISPATCHER','GROUP_LEAD')),
  group_id text REFERENCES support_groups(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL CHECK (valid_to > valid_from),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REJECTED','REVOKED')),
  source text NOT NULL DEFAULT 'REVIEW' CHECK (source IN ('REVIEW','BOOTSTRAP')),
  requested_by text NOT NULL REFERENCES employees(id),
  reviewed_by text REFERENCES employees(id),
  revoked_by text REFERENCES employees(id),
  reason text NOT NULL,
  review_reason text,
  revoke_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  revoked_at timestamptz,
  CHECK ((role_code='PLATFORM_ADMIN' AND group_id IS NULL) OR (role_code<>'PLATFORM_ADMIN' AND group_id IS NOT NULL)),
  CHECK (source='BOOTSTRAP' OR requested_by<>employee_id),
  CHECK (reviewed_by IS NULL OR (reviewed_by<>requested_by AND reviewed_by<>employee_id)),
  CHECK (status<>'ACTIVE' OR reviewed_by IS NOT NULL)
);
CREATE UNIQUE INDEX role_bindings_open ON role_bindings(employee_id,role_code,COALESCE(group_id,''))
  WHERE status IN ('PENDING','ACTIVE');
CREATE INDEX role_bindings_authorization ON role_bindings(employee_id,role_code,group_id) WHERE status='ACTIVE';
CREATE TABLE role_binding_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES role_bindings(id),
  actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('PROPOSED','APPROVED','REJECTED','REVOKED','BOOTSTRAPPED')),
  before_value jsonb,
  after_value jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX role_binding_audits_history ON role_binding_audits(binding_id,created_at,id);
