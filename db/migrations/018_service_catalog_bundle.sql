ALTER TABLE service_catalog ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE service_structure_proposals ADD COLUMN catalog_change jsonb
  CHECK(catalog_change IS NULL OR jsonb_typeof(catalog_change)='object');
ALTER TABLE service_structure_proposals ADD COLUMN catalog_base jsonb
  CHECK(catalog_base IS NULL OR jsonb_typeof(catalog_base)='object');
CREATE TABLE service_catalog_revisions (
  service_code text NOT NULL REFERENCES service_catalog(code),
  form_version integer NOT NULL CHECK(form_version>0),
  proposal_id uuid NOT NULL UNIQUE REFERENCES service_structure_proposals(id),
  structure_version integer NOT NULL REFERENCES service_structure_versions(version),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(service_code,form_version)
);
CREATE TRIGGER service_catalog_revisions_immutable BEFORE UPDATE OR DELETE ON service_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_request_catalog_version_change();
