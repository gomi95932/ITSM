CREATE TABLE catalog_tree_versions (
  version integer PRIMARY KEY CHECK(version>0),
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
  nodes jsonb NOT NULL CHECK(jsonb_typeof(nodes)='array'),
  navigation_version integer NOT NULL UNIQUE REFERENCES catalog_navigation_versions(version),
  structure_version integer NOT NULL REFERENCES service_structure_versions(version),
  actor_id text NOT NULL REFERENCES employees(id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_catalog_tree BEFORE UPDATE OR DELETE ON catalog_tree_versions
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();

ALTER TABLE tickets ADD COLUMN navigation_snapshot jsonb;
ALTER TABLE tickets ADD COLUMN original_navigation_snapshot jsonb;
ALTER TABLE tickets ADD COLUMN pending_classification jsonb;
ALTER TABLE tickets ADD CONSTRAINT pending_classification_handover CHECK (
  pending_classification IS NULL OR (assignment_kind='HANDOVER' AND pending_assignee_id IS NOT NULL));
CREATE FUNCTION preserve_original_navigation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.original_navigation_snapshot IS NOT NULL AND NEW.original_navigation_snapshot IS DISTINCT FROM OLD.original_navigation_snapshot THEN
    RAISE EXCEPTION 'ORIGINAL_NAVIGATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_original_navigation BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION preserve_original_navigation();

ALTER VIEW operation_log_entries RENAME TO operation_log_entries_before_catalog_tree;
CREATE VIEW operation_log_entries AS
SELECT * FROM operation_log_entries_before_catalog_tree e
WHERE e.module<>'catalog-navigation' OR NOT EXISTS(
  SELECT 1 FROM catalog_tree_versions t WHERE t.navigation_version::text=e.source_id)
UNION ALL
SELECT 'catalog-tree:'||v.version,'catalog-navigation',v.actor_id,v.version::text,'服务目录树',
  'CATALOG_TREE_APPLIED','APPLIED',v.reason,v.created_at,'catalog_tree_versions',v.version::text,NULL,
  (SELECT jsonb_build_object('nodes',p.nodes,'structureVersion',p.structure_version) FROM catalog_tree_versions p
    WHERE p.version<v.version ORDER BY p.version DESC LIMIT 1),
  jsonb_build_object('nodes',v.nodes,'structureVersion',v.structure_version,'navigationVersion',v.navigation_version),NULL
FROM catalog_tree_versions v;
