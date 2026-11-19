ALTER TABLE support_groups ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description)<=1000);
ALTER TABLE support_groups ADD COLUMN administration_version integer NOT NULL DEFAULT 1 CHECK (administration_version>0);

CREATE TABLE support_structure_proposals (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('GROUP_CREATE','GROUP_UPDATE','MEMBER_ADD','MEMBER_REMOVE')),
  group_id text NOT NULL CHECK (length(group_id) BETWEEN 1 AND 100),
  employee_id text REFERENCES employees(id),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
  expected_group_version integer CHECK (expected_group_version>0),
  request_hash text NOT NULL,
  proposed_by text NOT NULL REFERENCES employees(id),
  reviewed_by text REFERENCES employees(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  review_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CHECK ((kind='GROUP_CREATE' AND expected_group_version IS NULL) OR (kind<>'GROUP_CREATE' AND expected_group_version IS NOT NULL)),
  CHECK ((kind IN ('MEMBER_ADD','MEMBER_REMOVE') AND employee_id IS NOT NULL AND config='{}'::jsonb)
    OR (kind IN ('GROUP_CREATE','GROUP_UPDATE') AND employee_id IS NULL)),
  CHECK (kind<>'MEMBER_ADD' OR employee_id<>proposed_by),
  CHECK (reviewed_by IS NULL OR (reviewed_by<>proposed_by AND (employee_id IS NULL OR reviewed_by<>employee_id))),
  CHECK ((status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status<>'PENDING' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(trim(review_reason))>0))
);
CREATE UNIQUE INDEX support_structure_pending ON support_structure_proposals(group_id,kind,COALESCE(employee_id,'')) WHERE status='PENDING';
CREATE INDEX support_structure_recent ON support_structure_proposals(created_at DESC,id DESC);

CREATE TABLE support_structure_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES support_structure_proposals(id),
  actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('PROPOSED','APPROVED','REJECTED')),
  before_value jsonb,
  after_value jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_structure_audit_history ON support_structure_audits(proposal_id,created_at,id);
CREATE TRIGGER support_structure_audit_immutable BEFORE UPDATE OR DELETE ON support_structure_audits
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
