ALTER TABLE role_bindings ADD COLUMN management_mode text NOT NULL DEFAULT 'REVIEW'
  CHECK(management_mode IN ('REVIEW','ADMIN_DIRECT'));
ALTER TABLE support_structure_proposals ADD COLUMN management_mode text NOT NULL DEFAULT 'REVIEW'
  CHECK(management_mode IN ('REVIEW','ADMIN_DIRECT'));
ALTER TABLE service_structure_proposals ADD COLUMN management_mode text NOT NULL DEFAULT 'REVIEW'
  CHECK(management_mode IN ('REVIEW','ADMIN_DIRECT'));

-- Keep historical review rules; direct administrator changes have an explicit provenance.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conrelid::regclass AS target,conname FROM pg_constraint
    WHERE contype='c' AND conrelid IN ('role_bindings'::regclass,'support_structure_proposals'::regclass,'service_structure_proposals'::regclass)
      AND pg_get_constraintdef(oid) LIKE '%<>%'
      AND conname<>'role_bindings_origin_check'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
        WHERE a.attrelid=conrelid AND a.attnum=ANY(conkey)) IN (
          ARRAY['employee_id','requested_by','reviewed_by'],
          ARRAY['employee_id','kind','proposed_by'],
          ARRAY['employee_id','proposed_by','reviewed_by'],
          ARRAY['proposed_by','reviewed_by'])
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.target,item.conname);
  END LOOP;
END $$;

ALTER TABLE role_bindings ADD CONSTRAINT role_binding_management_authority CHECK(
  (management_mode='ADMIN_DIRECT' AND (reviewed_by IS NULL OR reviewed_by=requested_by)) OR
  (management_mode='REVIEW' AND (reviewed_by IS NULL OR (reviewed_by<>requested_by AND reviewed_by<>employee_id))));
ALTER TABLE role_bindings DROP CONSTRAINT role_bindings_origin_check;
ALTER TABLE role_bindings ADD CONSTRAINT role_bindings_origin_check CHECK(
  (source='HANDOFF' AND management_mode='REVIEW' AND handoff_id IS NOT NULL AND requested_by IS NULL AND reviewed_by IS NULL
    AND status IN ('ACTIVE','REVOKED')) OR
  (source IN ('REVIEW','BOOTSTRAP') AND handoff_id IS NULL AND requested_by IS NOT NULL
    AND (management_mode='ADMIN_DIRECT' OR source='BOOTSTRAP' OR requested_by<>employee_id)
    AND (status<>'ACTIVE' OR reviewed_by IS NOT NULL)));
ALTER TABLE support_structure_proposals ADD CONSTRAINT support_management_authority CHECK(
  (management_mode='ADMIN_DIRECT' AND (reviewed_by IS NULL OR reviewed_by=proposed_by)) OR
  (management_mode='REVIEW' AND (kind<>'MEMBER_ADD' OR employee_id<>proposed_by)
    AND (reviewed_by IS NULL OR (reviewed_by<>proposed_by AND (employee_id IS NULL OR reviewed_by<>employee_id)))));
ALTER TABLE service_structure_proposals ADD CONSTRAINT service_structure_management_authority CHECK(
  (management_mode='ADMIN_DIRECT' AND (reviewed_by IS NULL OR reviewed_by=proposed_by)) OR
  (management_mode='REVIEW' AND (reviewed_by IS NULL OR reviewed_by<>proposed_by)));
