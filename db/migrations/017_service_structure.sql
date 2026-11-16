CREATE TABLE service_structure_versions (
  version integer PRIMARY KEY CHECK(version>0),
  config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
  proposal_id uuid UNIQUE,
  published_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO service_structure_versions(version,config) VALUES
  (1,'{"domains":[],"systems":[],"positions":[],"appointments":[],"mappings":[]}');
CREATE TABLE service_structure_current (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  version integer NOT NULL REFERENCES service_structure_versions(version)
);
INSERT INTO service_structure_current(id,version) VALUES(true,1);
CREATE TABLE service_structure_proposals (
  id uuid PRIMARY KEY,
  expected_version integer NOT NULL REFERENCES service_structure_versions(version),
  config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
  request_hash text NOT NULL,
  proposed_by text NOT NULL REFERENCES employees(id),
  reviewed_by text REFERENCES employees(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CHECK(reviewed_by IS NULL OR reviewed_by<>proposed_by),
  CHECK((status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status<>'PENDING' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(review_reason) BETWEEN 1 AND 500))
);
ALTER TABLE service_structure_versions ADD CONSTRAINT service_structure_version_proposal
  FOREIGN KEY(proposal_id) REFERENCES service_structure_proposals(id);
CREATE TABLE service_structure_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES service_structure_proposals(id),
  actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK(action IN ('PROPOSED','APPROVED','REJECTED')),
  published_version integer REFERENCES service_structure_versions(version),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER service_structure_versions_immutable BEFORE UPDATE OR DELETE ON service_structure_versions
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
CREATE TRIGGER service_structure_audits_immutable BEFORE UPDATE OR DELETE ON service_structure_audits
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
ALTER TABLE tickets ADD COLUMN service_routing_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE ticket_routing_alerts DROP CONSTRAINT ticket_routing_alerts_reason_check;
ALTER TABLE ticket_routing_alerts ADD CONSTRAINT ticket_routing_alerts_reason_check
  CHECK(reason IN ('NO_ACTIVE_FALLBACK','NO_POSITION_COVERAGE'));
CREATE VIEW service_domains AS SELECT d.* FROM service_structure_current c
  JOIN service_structure_versions v ON v.version=c.version,
  jsonb_to_recordset(v.config->'domains') AS d(id text,name text,enabled boolean);
CREATE VIEW business_systems AS SELECT s.* FROM service_structure_current c
  JOIN service_structure_versions v ON v.version=c.version,
  jsonb_to_recordset(v.config->'systems') AS s(id text,name text,"domainId" text,enabled boolean);
CREATE VIEW support_positions AS SELECT p.* FROM service_structure_current c
  JOIN service_structure_versions v ON v.version=c.version,
  jsonb_to_recordset(v.config->'positions') AS p(id text,name text,"domainId" text,"groupId" text,enabled boolean);
CREATE VIEW position_appointments AS SELECT a.* FROM service_structure_current c
  JOIN service_structure_versions v ON v.version=c.version,
  jsonb_to_recordset(v.config->'appointments') AS a(id text,"positionId" text,"employeeId" text,duty text,"validFrom" timestamptz,"validTo" timestamptz,enabled boolean);
CREATE VIEW service_position_routes AS SELECT r.*,c.version FROM service_structure_current c
  JOIN service_structure_versions v ON v.version=c.version,
  jsonb_to_recordset(v.config->'mappings') AS r("serviceCode" text,"domainId" text,"systemId" text,"primaryPositionId" text,"collaboratingPositionIds" jsonb,enabled boolean);

CREATE FUNCTION service_position_eligible(snapshot jsonb,employee text,target_group text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT snapshot='{}'::jsonb OR EXISTS(
    SELECT 1 FROM support_positions p JOIN service_domains d ON d.id=p."domainId"
    JOIN position_appointments a ON a."positionId"=p.id
    JOIN employees e ON e.id=a."employeeId"
    JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=p."groupId"
    WHERE e.id=employee AND e.active AND p.enabled AND d.enabled AND a.enabled
      AND a."validFrom"<=clock_timestamp() AND a."validTo">clock_timestamp() AND p."groupId"=target_group
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'positions') s
        WHERE s->>'id'=p.id AND s->>'groupId'=p."groupId")
  );
$$;
