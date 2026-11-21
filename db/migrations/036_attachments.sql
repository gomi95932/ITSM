CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  object_key text NOT NULL UNIQUE CHECK (object_key = id::text || '.blob'),
  name text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime text NOT NULL,
  size integer NOT NULL CHECK (size > 0 AND size <= 20971520),
  visibility text NOT NULL CHECK (visibility IN ('PUBLIC','INTERNAL')),
  uploader_id text NOT NULL REFERENCES employees(id),
  scan_status text NOT NULL DEFAULT 'PENDING' CHECK
    (scan_status IN ('PENDING','UPLOADING','SCANNING','CLEAN','QUARANTINED','FAILED')),
  upload_key text NOT NULL,
  request_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  scanned_at timestamptz,
  scanner_version text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(uploader_id,upload_key)
);
CREATE INDEX attachments_ticket ON attachments(ticket_id,created_at);
CREATE INDEX attachments_daily ON attachments(uploader_id,created_at);
CREATE TABLE attachment_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id uuid NOT NULL REFERENCES attachments(id),
  actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('RESERVED','UPLOADED','CLEAN','QUARANTINED','FAILED','DOWNLOAD_GRANTED','DOWNLOADED')),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_audits_object ON attachment_audits(attachment_id,created_at);
