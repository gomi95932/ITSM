CREATE TABLE knowledge_editors (
  employee_id text NOT NULL REFERENCES employees(id),
  group_id text NOT NULL REFERENCES support_groups(id),
  PRIMARY KEY (employee_id, group_id),
  FOREIGN KEY (employee_id, group_id) REFERENCES group_memberships(employee_id, group_id) ON DELETE CASCADE
);
CREATE TABLE knowledge_reviewers (
  employee_id text NOT NULL REFERENCES employees(id),
  group_id text NOT NULL REFERENCES support_groups(id),
  PRIMARY KEY (employee_id, group_id),
  FOREIGN KEY (employee_id, group_id) REFERENCES group_memberships(employee_id, group_id) ON DELETE CASCADE
);
CREATE TABLE knowledge_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_group_id text NOT NULL REFERENCES support_groups(id),
  source_ticket_id uuid REFERENCES tickets(id),
  author_id text NOT NULL REFERENCES employees(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','PUBLISHED','ARCHIVED')),
  draft_version integer NOT NULL DEFAULT 1 CHECK (draft_version > 0),
  published_version integer,
  review_version integer,
  reviewed_by text REFERENCES employees(id),
  audience text NOT NULL CHECK (audience IN ('EMPLOYEE','SUPPORT_GROUP')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 12000),
  review_due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (published_version IS NULL OR published_version > 0),
  CHECK (review_version IS NULL OR review_version > 0)
);
CREATE TABLE knowledge_versions (
  article_id uuid NOT NULL REFERENCES knowledge_articles(id),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  body text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('EMPLOYEE','SUPPORT_GROUP')),
  review_due_at timestamptz NOT NULL,
  approved_by text NOT NULL REFERENCES employees(id),
  published_by text NOT NULL REFERENCES employees(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, version)
);
CREATE FUNCTION reject_knowledge_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KNOWLEDGE_VERSION_IMMUTABLE';
END;
$$;
CREATE TRIGGER knowledge_version_immutable BEFORE UPDATE OR DELETE ON knowledge_versions
  FOR EACH ROW EXECUTE FUNCTION reject_knowledge_version_change();
CREATE TABLE knowledge_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES knowledge_articles(id),
  actor_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('CREATE','REVISE','SUBMIT','APPROVE','REJECT','PUBLISH','ARCHIVE')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  before_value jsonb,
  after_value jsonb NOT NULL,
  response jsonb NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, idempotency_key)
);
CREATE INDEX knowledge_published_recent ON knowledge_versions(published_at DESC) INCLUDE (article_id,version);
