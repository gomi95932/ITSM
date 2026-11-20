CREATE TABLE directory_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corp_id text NOT NULL,
  scope_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('RUNNING','SUCCEEDED','FAILED')),
  people_count integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  disabled_count integer NOT NULL DEFAULT 0,
  missing_count integer NOT NULL DEFAULT 0,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX directory_sync_runs_recent ON directory_sync_runs(corp_id,started_at DESC);

CREATE TABLE directory_people (
  corp_id text NOT NULL,
  ding_user_id text NOT NULL,
  employee_id text NOT NULL REFERENCES employees(id),
  scope_hash text NOT NULL,
  department_ids jsonb NOT NULL CHECK (jsonb_typeof(department_ids)='array'),
  job_title text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run uuid NOT NULL REFERENCES directory_sync_runs(id),
  consecutive_absences integer NOT NULL DEFAULT 0 CHECK (consecutive_absences>=0),
  disabled_by_sync_at timestamptz,
  PRIMARY KEY(corp_id,ding_user_id),
  UNIQUE(corp_id,employee_id)
);
