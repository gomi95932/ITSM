-- Read projection only; authoritative histories and ticket business events stay intact.
CREATE VIEW operation_log_entries AS
SELECT 'ticket:'||a.id AS id,'tickets'::text AS module,a.actor_id,
  t.id::text AS object_id,t.number::text AS object_name,a.action,
  'COMPLETED'::text AS result,NULL::text AS reason,a.created_at,
  'audit_logs'::text AS source_table,a.id::text AS source_id,a.request_id,
  a.before_value,a.after_value,NULL::text AS execution_principal
FROM audit_logs a JOIN tickets t ON t.id=a.ticket_id
UNION ALL
SELECT 'structure:'||a.id,'service-structure',a.actor_id,p.id::text,
  CASE WHEN p.catalog_change IS NULL THEN '服务组织 / 岗位任职' ELSE '服务目录 / '||(p.catalog_change->>'code') END,
  CASE WHEN p.management_mode='ADMIN_DIRECT' AND a.action='APPROVED' THEN 'APPLIED' ELSE a.action END,
  CASE a.action WHEN 'PROPOSED' THEN 'SUBMITTED' WHEN 'REJECTED' THEN 'REJECTED' ELSE 'APPLIED' END,
  a.reason,a.created_at,'service_structure_audits',a.id::text,NULL,
  v.config||CASE WHEN p.catalog_change IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('catalogChange',
    CASE WHEN p.catalog_base IS NULL THEN NULL ELSE COALESCE(previous_catalog.snapshot,jsonb_build_object(
      'code',p.catalog_base->'code','type',p.catalog_base->'type','formVersion',p.catalog_base->'form_version',
      'published',p.catalog_base->'published','name',p.catalog_base->'name','description',p.catalog_base->'description',
      'groupId',p.catalog_base->'group_id','visibleGroups',p.catalog_base->'visible_groups',
      'fields',p.catalog_base->'field_schema','sortOrder',p.catalog_base->'sort_order')) END) END,
  (CASE WHEN a.action='APPROVED' THEN n.config ELSE p.config END)||
    CASE WHEN p.catalog_change IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('catalogChange',
      CASE WHEN a.action='APPROVED' THEN published_catalog.snapshot ELSE p.catalog_change END) END,NULL
FROM service_structure_audits a JOIN service_structure_proposals p ON p.id=a.proposal_id
LEFT JOIN service_structure_versions v ON v.version=p.expected_version
LEFT JOIN service_structure_versions n ON n.version=a.published_version
LEFT JOIN service_catalog_revisions published_catalog ON published_catalog.proposal_id=p.id
LEFT JOIN service_catalog_revisions previous_catalog ON previous_catalog.service_code=p.catalog_base->>'code'
  AND previous_catalog.form_version=(p.catalog_base->>'form_version')::integer
UNION ALL
SELECT 'support:'||a.id,'support',a.actor_id,p.group_id,p.group_id,
  p.kind||'_'||CASE WHEN p.management_mode='ADMIN_DIRECT' AND a.action='APPROVED' THEN 'APPLIED' ELSE a.action END,
  CASE a.action WHEN 'PROPOSED' THEN 'SUBMITTED' WHEN 'REJECTED' THEN 'REJECTED' ELSE 'APPLIED' END,
  a.reason,a.created_at,'support_structure_audits',a.id::text,NULL,a.before_value,a.after_value,NULL
FROM support_structure_audits a JOIN support_structure_proposals p ON p.id=a.proposal_id
UNION ALL
SELECT 'role:'||a.id,'roles',a.actor_id,a.binding_id::text,
  COALESCE(e.display_name,r.employee_id)||' / '||r.role_code,
  CASE WHEN r.management_mode='ADMIN_DIRECT' AND a.action='APPROVED' THEN 'APPLIED' ELSE a.action END,
  CASE a.action WHEN 'PROPOSED' THEN 'SUBMITTED' WHEN 'REJECTED' THEN 'REJECTED' ELSE 'APPLIED' END,
  a.reason,a.created_at,'role_binding_audits',a.id::text,NULL,a.before_value,a.after_value,h.execution_principal
FROM role_binding_audits a JOIN role_bindings r ON r.id=a.binding_id
LEFT JOIN employees e ON e.id=r.employee_id LEFT JOIN admin_handoffs h ON h.id=a.handoff_id
UNION ALL
SELECT 'routing:'||a.id,'routing',a.actor_id,p.group_id,p.group_id||' / '||COALESCE(p.priority,p.kind),a.action,
  CASE a.action WHEN 'PROPOSED' THEN 'SUBMITTED' WHEN 'REJECTED' THEN 'REJECTED' ELSE 'APPLIED' END,
  a.reason,a.created_at,'routing_config_audits',a.id::text,NULL,a.before_value,a.after_value,NULL
FROM routing_config_audits a JOIN routing_config_proposals p ON p.id=a.proposal_id
UNION ALL
SELECT 'dispatch:'||p.service_code||':'||p.version,'automatic-dispatch',p.actor_id,p.service_code,
  COALESCE(c.name,p.service_code),'APPLIED','APPLIED',p.reason,p.created_at,
  'automatic_dispatch_policies',p.service_code||':'||p.version,NULL,
  (SELECT to_jsonb(v) FROM automatic_dispatch_policies v WHERE v.service_code=p.service_code AND v.version=p.version-1),
  to_jsonb(p),NULL
FROM automatic_dispatch_policies p LEFT JOIN service_catalog c ON c.code=p.service_code
UNION ALL
SELECT 'navigation:'||v.version,'catalog-navigation',v.actor_id,'catalog-navigation','目录展示分类',
  CASE WHEN v.actor_id IS NULL THEN 'INITIALIZED' ELSE 'APPLIED' END,'APPLIED',v.reason,v.created_at,
  'catalog_navigation_versions',v.version::text,NULL,
  (SELECT p.config FROM catalog_navigation_versions p WHERE p.version=v.version-1),v.config,NULL
FROM catalog_navigation_versions v
UNION ALL
SELECT 'catalog:'||a.id,'catalog',a.actor_id,a.service_code,COALESCE(c.name,a.service_code),a.action,
  'APPLIED',NULL,a.created_at,'request_catalog_audits',a.id::text,a.request_id,a.before_value,a.after_value,NULL
FROM request_catalog_audits a LEFT JOIN service_catalog c ON c.code=a.service_code
UNION ALL
SELECT 'knowledge:'||a.id,'knowledge',a.actor_id,a.article_id::text,a.article_id::text,a.action,
  CASE WHEN a.action='REJECT' THEN 'REJECTED' WHEN a.action='SUBMIT' THEN 'SUBMITTED' ELSE 'COMPLETED' END,
  NULL,a.created_at,'knowledge_audits',a.id::text,a.request_id,a.before_value,a.after_value,NULL
FROM knowledge_audits a
UNION ALL
SELECT 'attachment:'||a.id,'attachments',a.actor_id,t.id::text,t.number||' / 附件',a.action,
  CASE WHEN a.action IN ('FAILED','QUARANTINED') THEN 'FAILED' ELSE 'COMPLETED' END,
  NULL,a.created_at,'attachment_audits',a.id::text,a.request_id,NULL,NULL,NULL
FROM attachment_audits a JOIN attachments f ON f.id=a.attachment_id JOIN tickets t ON t.id=f.ticket_id
UNION ALL
SELECT 'directory:'||r.id,'directory',NULL,r.id::text,'通讯录同步',r.state,
  CASE r.state WHEN 'FAILED' THEN 'FAILED' WHEN 'RUNNING' THEN 'RUNNING' ELSE 'COMPLETED' END,
  r.error_code,COALESCE(r.completed_at,r.started_at),'directory_sync_runs',r.id::text,NULL,NULL,
  jsonb_build_object('state',r.state,'peopleCount',r.people_count,'createdCount',r.created_count,
    'updatedCount',r.updated_count,'disabledCount',r.disabled_count,'missingCount',r.missing_count),'system:directory-sync'
FROM directory_sync_runs r
UNION ALL
SELECT 'operation:'||a.id,
  CASE WHEN a.action LIKE 'PRIORITY_POLICY_%' THEN 'priority'
    WHEN a.action LIKE 'SLA_CALENDAR_%' THEN 'calendar'
    WHEN a.action LIKE 'OPERATIONS_%' THEN 'operations'
    WHEN a.action LIKE '%LOGIN%' THEN 'authentication'
    WHEN a.action LIKE 'NOTIFICATION_%' THEN 'notifications'
    WHEN a.action LIKE 'APPOINTMENT_%' THEN 'service-structure' ELSE 'system' END,
  a.actor_id,a.target_id,a.target_id,a.action,
  CASE WHEN a.action LIKE '%_PROPOSED' THEN 'SUBMITTED' WHEN a.action LIKE '%_REJECT' THEN 'REJECTED'
    WHEN a.action LIKE '%_APPROVE' THEN 'APPLIED' ELSE 'COMPLETED' END,
  CASE WHEN a.action LIKE '%_PROPOSED' THEN COALESCE(p.reason,s.reason,o.reason)
    ELSE COALESCE(p.review_reason,s.review_reason,o.review_reason) END,
  a.created_at,'operational_audits',a.id::text,NULL,
  COALESCE(pv.config,sv.config,ov.config),COALESCE(p.config,s.config,o.config),NULL
FROM operational_audits a
LEFT JOIN priority_policy_proposals p ON p.id::text=a.target_id AND a.action LIKE 'PRIORITY_POLICY_%'
LEFT JOIN priority_policy_versions pv ON pv.version=p.expected_version
LEFT JOIN sla_calendar_proposals s ON s.id::text=a.target_id AND a.action LIKE 'SLA_CALENDAR_%'
LEFT JOIN sla_calendars sv ON sv.version=s.expected_version
LEFT JOIN operations_proposals o ON o.id::text=a.target_id AND a.action LIKE 'OPERATIONS_%'
LEFT JOIN operations_versions ov ON ov.version=o.expected_version
WHERE NOT EXISTS(SELECT 1 FROM role_binding_audits x WHERE x.binding_id::text=a.target_id
  AND x.actor_id=a.actor_id AND 'ROLE_'||x.action=a.action AND x.created_at=a.created_at)
AND NOT EXISTS(SELECT 1 FROM support_structure_audits x WHERE x.proposal_id::text=a.target_id
  AND x.actor_id=a.actor_id AND ('SUPPORT_'||x.action=a.action OR a.action='SUPPORT_ADMIN_DIRECT') AND x.created_at=a.created_at)
AND NOT EXISTS(SELECT 1 FROM service_structure_audits x WHERE x.proposal_id::text=a.target_id
  AND x.actor_id=a.actor_id AND 'SERVICE_STRUCTURE_'||x.action=a.action AND x.created_at=a.created_at)
AND NOT EXISTS(SELECT 1 FROM routing_config_audits x WHERE x.proposal_id::text=a.target_id
  AND x.actor_id=a.actor_id AND 'ROUTING_'||x.action=a.action AND x.created_at=a.created_at)
AND NOT (a.action='AUTOMATIC_DISPATCH_CONFIGURED' AND EXISTS(
  SELECT 1 FROM automatic_dispatch_policies x WHERE x.service_code=a.target_id AND x.actor_id=a.actor_id
    AND x.created_at>=a.created_at AND x.created_at<a.created_at+interval '1 minute'));

CREATE INDEX operational_audits_search_time ON operational_audits(created_at DESC,id DESC);
CREATE INDEX ticket_audits_search_time ON audit_logs(created_at DESC,id DESC);
