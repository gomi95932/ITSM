ALTER TABLE directory_sync_runs DROP CONSTRAINT directory_sync_runs_state_check;
ALTER TABLE directory_sync_runs ADD CONSTRAINT directory_sync_runs_state_check
  CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED'));
ALTER TABLE directory_sync_runs
  ADD COLUMN trigger_source text NOT NULL DEFAULT 'AUTOMATIC'
    CHECK (trigger_source IN ('AUTOMATIC','MANUAL','MAINTENANCE')),
  ADD COLUMN requested_by text REFERENCES employees(id),
  ADD COLUMN request_key uuid,
  ADD COLUMN requested_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN error_details jsonb;
CREATE UNIQUE INDEX directory_sync_manual_key ON directory_sync_runs(corp_id,requested_by,request_key)
  WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX directory_sync_queued_corp ON directory_sync_runs(corp_id) WHERE state='QUEUED';
CREATE INDEX directory_sync_automatic_recent ON directory_sync_runs(corp_id,started_at DESC)
  WHERE trigger_source='AUTOMATIC';

-- Keep all existing projections intact; enrich directory operations with their initiating administrator.
ALTER VIEW operation_log_entries RENAME TO operation_log_entries_before_directory_schedule;
CREATE VIEW operation_log_entries AS
SELECT * FROM operation_log_entries_before_directory_schedule WHERE module<>'directory'
UNION ALL
SELECT 'directory:'||r.id,'directory',r.requested_by,r.id::text,'通讯录同步',r.state,
  CASE r.state WHEN 'FAILED' THEN 'FAILED' WHEN 'RUNNING' THEN 'RUNNING'
    WHEN 'QUEUED' THEN 'SUBMITTED' ELSE 'COMPLETED' END,
  r.error_code,COALESCE(r.completed_at,r.started_at),'directory_sync_runs',r.id::text,
  r.request_key::text,NULL,
  jsonb_build_object('state',r.state,'triggerSource',r.trigger_source,'peopleCount',r.people_count,
    'createdCount',r.created_count,'updatedCount',r.updated_count,'disabledCount',r.disabled_count,
    'missingCount',r.missing_count,'errorDetails',r.error_details),'system:directory-sync'
FROM directory_sync_runs r;
