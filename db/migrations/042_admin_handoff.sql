CREATE TABLE admin_handoffs (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL UNIQUE DEFAULT true CHECK (singleton),
  execution_principal text NOT NULL,
  authority_ref text NOT NULL,
  reason text NOT NULL,
  directory_run_id uuid NOT NULL REFERENCES directory_sync_runs(id),
  configuration_sha256 text NOT NULL CHECK (configuration_sha256 ~ '^[a-f0-9]{64}$'),
  backup_ref text NOT NULL,
  selection jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE role_bindings ADD COLUMN handoff_id uuid REFERENCES admin_handoffs(id);
ALTER TABLE role_bindings ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE role_bindings DROP CONSTRAINT role_bindings_source_check;
-- PostgreSQL numbers unnamed multi-column checks; select by their column set,
-- leaving the group-scope and independent-review constraints intact.
DO $$
DECLARE columns text[]; constraint_name text;
BEGIN
  FOREACH columns SLICE 1 IN ARRAY ARRAY[
    ARRAY['employee_id','requested_by','source'],ARRAY['reviewed_by','status',NULL]
  ] LOOP
    SELECT c.conname INTO STRICT constraint_name FROM pg_constraint c
    WHERE c.conrelid='role_bindings'::regclass AND c.contype='c'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(c.conkey) k(attnum)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)
        =array_remove(columns,NULL);
    EXECUTE format('ALTER TABLE role_bindings DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END;
$$;
ALTER TABLE role_bindings ADD CONSTRAINT role_bindings_source_check CHECK (source IN ('REVIEW','BOOTSTRAP','HANDOFF'));
ALTER TABLE role_bindings ADD CONSTRAINT role_bindings_origin_check CHECK (
  (source='HANDOFF' AND handoff_id IS NOT NULL AND requested_by IS NULL AND reviewed_by IS NULL
    AND status IN ('ACTIVE','REVOKED'))
  OR
  (source IN ('REVIEW','BOOTSTRAP') AND handoff_id IS NULL AND requested_by IS NOT NULL
    AND (source='BOOTSTRAP' OR requested_by<>employee_id)
    AND (status<>'ACTIVE' OR reviewed_by IS NOT NULL))
);

ALTER TABLE role_binding_audits ADD COLUMN handoff_id uuid REFERENCES admin_handoffs(id);
ALTER TABLE role_binding_audits ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE role_binding_audits DROP CONSTRAINT role_binding_audits_action_check;
ALTER TABLE role_binding_audits ADD CONSTRAINT role_binding_audits_action_check
  CHECK (action IN ('PROPOSED','APPROVED','REJECTED','REVOKED','BOOTSTRAPPED','HANDED_OFF','HANDOFF_REVOKED'));
ALTER TABLE role_binding_audits ADD CONSTRAINT role_binding_audits_actor_check CHECK (
  (action IN ('HANDED_OFF','HANDOFF_REVOKED') AND actor_id IS NULL AND handoff_id IS NOT NULL)
  OR (action NOT IN ('HANDED_OFF','HANDOFF_REVOKED') AND actor_id IS NOT NULL AND handoff_id IS NULL)
);
