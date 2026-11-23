CREATE TABLE catalog_navigation_versions (
  version integer PRIMARY KEY CHECK(version>0),
  config jsonb NOT NULL CHECK(jsonb_typeof(config)='array'),
  actor_id text REFERENCES employees(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO catalog_navigation_versions(version,config,reason) VALUES(1,'[]','Initial catalog navigation');
CREATE TRIGGER immutable_catalog_navigation
  BEFORE UPDATE OR DELETE ON catalog_navigation_versions
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
