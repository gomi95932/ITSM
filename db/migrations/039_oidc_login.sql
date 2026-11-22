CREATE TABLE oidc_identity_links (
  issuer text NOT NULL, subject text NOT NULL,
  employee_id text NOT NULL REFERENCES employees(id),
  approval_ref text NOT NULL CHECK(length(approval_ref) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer,subject), UNIQUE(issuer,employee_id)
);
CREATE TABLE oidc_login_attempts (
  state_hash text PRIMARY KEY, browser_hash text NOT NULL,
  issuer text NOT NULL, client_id text NOT NULL, redirect_uri text NOT NULL,
  verifier text NOT NULL, nonce text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE INDEX oidc_login_attempts_expiry ON oidc_login_attempts(expires_at);
CREATE FUNCTION revoke_changed_oidc_identity_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.issuer,OLD.subject,OLD.employee_id) IS NOT DISTINCT FROM
      (NEW.issuer,NEW.subject,NEW.employee_id) THEN RETURN NULL; END IF;
  DELETE FROM auth_sessions WHERE employee_id=OLD.employee_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER oidc_identity_links_revoke_sessions_after_change
AFTER UPDATE OR DELETE ON oidc_identity_links FOR EACH ROW
EXECUTE FUNCTION revoke_changed_oidc_identity_sessions();
