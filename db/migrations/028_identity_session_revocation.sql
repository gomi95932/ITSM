CREATE INDEX auth_sessions_employee ON auth_sessions(employee_id);

CREATE FUNCTION revoke_disabled_employee_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM auth_sessions WHERE employee_id=OLD.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER employees_revoke_sessions_after_disable
AFTER UPDATE OF active ON employees FOR EACH ROW
WHEN (OLD.active AND NOT NEW.active)
EXECUTE FUNCTION revoke_disabled_employee_sessions();

CREATE FUNCTION revoke_changed_identity_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (OLD.corp_id, OLD.ding_user_id, OLD.employee_id) IS NOT DISTINCT FROM
       (NEW.corp_id, NEW.ding_user_id, NEW.employee_id) THEN
      RETURN NULL;
    END IF;
  END IF;
  -- Existing sessions carry only the employee ID, so revoke all sessions for the old owner.
  DELETE FROM auth_sessions WHERE employee_id=OLD.employee_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER identity_links_revoke_sessions_after_change
AFTER UPDATE OR DELETE ON identity_links FOR EACH ROW
EXECUTE FUNCTION revoke_changed_identity_sessions();
