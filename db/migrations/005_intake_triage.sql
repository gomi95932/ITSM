ALTER TABLE service_catalog DROP CONSTRAINT service_catalog_type_check;
ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_type_check CHECK (type IN ('INC','REQ','GEN'));
ALTER TABLE tickets DROP CONSTRAINT tickets_service_type_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_service_type_check CHECK (service_type IN ('INC','REQ','GEN'));

-- A queue is created, not a production staff appointment.
INSERT INTO support_groups(id,name) VALUES ('service-desk','IT 服务台') ON CONFLICT DO NOTHING;
INSERT INTO service_catalog(code,type,form_version,published,group_id,name,description)
VALUES ('GEN-OTHER','GEN',1,true,'service-desk','其他 IT 事项','分类不确定、咨询及需进一步澄清的 IT 事项') ON CONFLICT DO NOTHING;

CREATE TABLE ticket_delegations (
  id uuid PRIMARY KEY,
  requester_id text NOT NULL REFERENCES employees(id),
  delegate_id text NOT NULL REFERENCES employees(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (requester_id<>delegate_id),
  CHECK (expires_at>created_at)
);
CREATE INDEX ticket_delegations_incoming ON ticket_delegations(delegate_id,expires_at) WHERE revoked_at IS NULL;
ALTER TABLE tickets ADD COLUMN submitted_by_id text REFERENCES employees(id);
UPDATE tickets SET submitted_by_id=requester_id;
ALTER TABLE tickets ALTER COLUMN submitted_by_id SET NOT NULL;
ALTER TABLE tickets ADD COLUMN delegation_id uuid REFERENCES ticket_delegations(id);
ALTER TABLE tickets ADD COLUMN original_catalog_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN original_fields jsonb NOT NULL DEFAULT '{}';
UPDATE tickets SET original_catalog_snapshot=catalog_snapshot,original_fields=fields;
