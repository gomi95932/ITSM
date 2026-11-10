-- Local/CI fixtures only. Never load this file in production.
INSERT INTO employees(id, display_name) VALUES
  ('employee-1', 'Test requester'), ('employee-2', 'Other employee'), ('agent-1', 'Test agent')
ON CONFLICT (id) DO NOTHING;
INSERT INTO support_groups(id, name) VALUES ('service-desk', 'Service desk') ON CONFLICT (id) DO NOTHING;
INSERT INTO group_memberships(employee_id, group_id) VALUES ('agent-1', 'service-desk') ON CONFLICT DO NOTHING;
INSERT INTO service_catalog(code, type, form_version, published, group_id, required_fields)
VALUES ('INC-BIZ', 'INC', 1, true, 'service-desk', '[]'::jsonb)
ON CONFLICT (code) DO NOTHING;
