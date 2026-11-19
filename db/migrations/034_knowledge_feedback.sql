CREATE TABLE knowledge_feedback (
  article_id uuid NOT NULL,
  version integer NOT NULL,
  employee_id text NOT NULL REFERENCES employees(id),
  helpful boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, version, employee_id),
  FOREIGN KEY (article_id, version) REFERENCES knowledge_versions(article_id, version)
);

CREATE FUNCTION protect_knowledge_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE article RECORD;
  publication RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'KNOWLEDGE_FEEDBACK_IMMUTABLE';
  END IF;
  SELECT status,published_version,owner_group_id INTO article FROM knowledge_articles
    WHERE id=NEW.article_id FOR SHARE;
  IF NOT FOUND OR article.status='ARCHIVED' OR article.published_version IS NULL OR article.published_version<>NEW.version THEN
    RAISE EXCEPTION 'KNOWLEDGE_FEEDBACK_UNAVAILABLE';
  END IF;
  SELECT audience,review_due_at INTO publication FROM knowledge_versions
    WHERE article_id=NEW.article_id AND version=NEW.version;
  IF NOT FOUND OR publication.review_due_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'KNOWLEDGE_FEEDBACK_UNAVAILABLE';
  END IF;
  PERFORM 1 FROM employees WHERE id=NEW.employee_id AND active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KNOWLEDGE_FEEDBACK_UNAVAILABLE';
  END IF;
  IF publication.audience='SUPPORT_GROUP' THEN
    PERFORM 1 FROM group_memberships WHERE employee_id=NEW.employee_id AND group_id=article.owner_group_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KNOWLEDGE_FEEDBACK_UNAVAILABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER knowledge_feedback_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_feedback
  FOR EACH ROW EXECUTE FUNCTION protect_knowledge_feedback();

ALTER TABLE knowledge_audits DROP CONSTRAINT knowledge_audits_action_check;
ALTER TABLE knowledge_audits ADD CONSTRAINT knowledge_audits_action_check
  CHECK (action IN ('CREATE','REVISE','SUBMIT','APPROVE','REJECT','PUBLISH','ARCHIVE','FEEDBACK'));
