ALTER TABLE support_groups ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE support_structure_proposals DROP CONSTRAINT support_structure_proposals_kind_check;
ALTER TABLE support_structure_proposals ADD CONSTRAINT support_structure_proposals_kind_check
  CHECK(kind IN ('GROUP_CREATE','GROUP_UPDATE','GROUP_DISABLE','GROUP_RESTORE','MEMBER_ADD','MEMBER_REMOVE'));
ALTER TABLE support_structure_proposals DROP CONSTRAINT support_structure_proposals_check1;
ALTER TABLE support_structure_proposals ADD CONSTRAINT support_structure_proposal_subject
  CHECK((kind IN ('MEMBER_ADD','MEMBER_REMOVE') AND employee_id IS NOT NULL AND config='{}'::jsonb)
    OR (kind IN ('GROUP_CREATE','GROUP_UPDATE') AND employee_id IS NULL)
    OR (kind IN ('GROUP_DISABLE','GROUP_RESTORE') AND employee_id IS NULL AND config='{}'::jsonb));

CREATE FUNCTION support_group_dependencies(target text)
RETURNS TABLE(kind text,id text,name text) LANGUAGE sql STABLE AS $$
  SELECT 'TICKET',t.id::text,t.number FROM tickets t
    WHERE t.status NOT IN ('CLOSED','CANCELLED','REJECTED') AND (t.owner_group_id=target OR t.pending_group_id=target)
  UNION ALL SELECT 'APPROVAL',a.id::text,t.number FROM request_approvals a JOIN tickets t ON t.id=a.ticket_id
    WHERE t.owner_group_id=target AND (a.state IN ('QUEUED','CREATING','CREATE_UNCERTAIN','PENDING')
      OR (a.state='APPROVED' AND NOT EXISTS(SELECT 1 FROM request_fulfillments f WHERE f.approval_id=a.id)))
  UNION ALL SELECT 'FULFILLMENT',f.id::text,t.number FROM request_fulfillments f JOIN tickets t ON t.id=f.ticket_id
    WHERE t.owner_group_id=target AND (f.state IN ('READY','DELIVERED','REVOKE_DUE') OR (f.delivered_at IS NOT NULL AND f.revoked_at IS NULL))
  UNION ALL SELECT 'KNOWLEDGE',k.id::text,k.title FROM knowledge_articles k
    WHERE k.owner_group_id=target AND k.status<>'ARCHIVED'
  UNION ALL SELECT 'POSITION',p.id,p.name FROM support_positions p WHERE p."groupId"=target AND p.enabled
  UNION ALL SELECT 'APPOINTMENT',a.id,p.name FROM position_appointments a JOIN support_positions p ON p.id=a."positionId"
    WHERE p."groupId"=target AND a.enabled
  UNION ALL SELECT 'CATALOG',c.code,c.name FROM service_catalog c
    WHERE c.published AND (c.group_id=target OR c.visible_groups ? target)
  UNION ALL SELECT 'FALLBACK',g.id,g.name FROM support_groups g
    WHERE g.fallback_group_id=target OR (g.id=target AND g.fallback_group_id IS NOT NULL)
  UNION ALL SELECT 'ASSIGNMENT_POLICY',a.id::text,a.priority FROM assignment_policy_versions a
    WHERE a.group_id=target AND a.active;
$$;

-- Runtime writers serialize against retirement, even when they do not administer configuration.
CREATE FUNCTION require_enabled_support_group(target text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF target IS NOT NULL THEN
    PERFORM id FROM support_groups WHERE id=target AND enabled FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SUPPORT_GROUP_DISABLED' USING ERRCODE='23514'; END IF;
  END IF;
END;
$$;
CREATE FUNCTION guard_enabled_support_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
  IF TG_TABLE_NAME='support_groups' THEN
    IF TG_OP='UPDATE' AND OLD.enabled AND NOT NEW.enabled THEN
      IF EXISTS(SELECT 1 FROM support_group_dependencies(NEW.id))
        OR EXISTS(SELECT 1 FROM group_memberships WHERE group_id=NEW.id)
        OR EXISTS(SELECT 1 FROM role_bindings WHERE group_id=NEW.id AND status IN ('PENDING','ACTIVE')) THEN
        RAISE EXCEPTION 'SUPPORT_GROUP_DEPENDENCIES' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.fallback_group_id IS NOT NULL THEN
      IF NOT NEW.enabled THEN RAISE EXCEPTION 'SUPPORT_GROUP_DISABLED' USING ERRCODE='23514'; END IF;
      PERFORM require_enabled_support_group(NEW.fallback_group_id);
    END IF;
  ELSIF TG_TABLE_NAME='service_catalog' THEN
    IF NEW.published THEN
      PERFORM require_enabled_support_group(NEW.group_id);
      FOR target IN SELECT jsonb_array_elements_text(NEW.visible_groups) LOOP
        PERFORM require_enabled_support_group(target);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME='tickets' THEN
    IF NEW.status NOT IN ('CLOSED','CANCELLED','REJECTED') THEN
      PERFORM require_enabled_support_group(NEW.owner_group_id);
      PERFORM require_enabled_support_group(NEW.pending_group_id);
    END IF;
  ELSIF TG_TABLE_NAME='knowledge_articles' THEN
    IF NEW.status<>'ARCHIVED' THEN PERFORM require_enabled_support_group(NEW.owner_group_id); END IF;
  ELSIF TG_TABLE_NAME='assignment_policy_versions' THEN
    IF NEW.active THEN PERFORM require_enabled_support_group(NEW.group_id); END IF;
  ELSIF TG_TABLE_NAME='request_fulfillments' THEN
    IF NEW.state IN ('READY','DELIVERED','REVOKE_DUE') OR (NEW.delivered_at IS NOT NULL AND NEW.revoked_at IS NULL) THEN
      SELECT owner_group_id INTO target FROM tickets WHERE id=NEW.ticket_id;
      PERFORM require_enabled_support_group(target);
    END IF;
  ELSIF TG_TABLE_NAME='role_bindings' THEN
    IF NEW.status IN ('PENDING','ACTIVE') THEN PERFORM require_enabled_support_group(NEW.group_id); END IF;
  ELSE
    PERFORM require_enabled_support_group(NEW.group_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER support_group_fallback_enabled BEFORE INSERT OR UPDATE ON support_groups
  FOR EACH ROW EXECUTE FUNCTION guard_enabled_support_group();
CREATE TRIGGER support_membership_group_enabled BEFORE INSERT OR UPDATE ON group_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_enabled_support_group();
CREATE TRIGGER support_catalog_group_enabled BEFORE INSERT OR UPDATE ON service_catalog
  FOR EACH ROW EXECUTE FUNCTION guard_enabled_support_group();
CREATE TRIGGER support_ticket_group_enabled BEFORE INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION guard_enabled_support_group();
CREATE TRIGGER support_knowledge_group_enabled BEFORE INSERT OR UPDATE ON knowledge_articles
  FOR EACH ROW EXECUTE FUNCTION guard_enabled_support_group();
CREATE TRIGGER support_assignment_policy_group_enabled BEFORE INSERT OR UPDATE ON assignment_policy_versions
  FOR EACH ROW EXECUTE FUNCTION guard_enabled_support_group();
CREATE TRIGGER support_fulfillment_group_enabled BEFORE INSERT OR UPDATE ON request_fulfillments
  FOR EACH ROW EXECUTE FUNCTION guard_enabled_support_group();
CREATE TRIGGER support_role_group_enabled BEFORE INSERT OR UPDATE ON role_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_enabled_support_group();
