-- Local/CI fixtures only. Never load this file in production.
INSERT INTO employees(id, display_name) VALUES
  ('employee-1', '演示员工一'), ('employee-2', '演示员工二'), ('agent-1', '服务台工程师'), ('agent-2', '应用支持工程师'), ('agent-3', '服务台协作工程师')
ON CONFLICT (id) DO NOTHING;
INSERT INTO support_groups(id, name) VALUES ('service-desk', 'IT 服务台'),('applications','应用支持组') ON CONFLICT (id) DO NOTHING;
INSERT INTO group_memberships(employee_id, group_id) VALUES ('agent-1', 'service-desk'),('agent-2','applications'),('agent-3','service-desk') ON CONFLICT DO NOTHING;
-- Disposable demonstration identities only; never bootstrap real administrators from seeds.
INSERT INTO employees(id,display_name) VALUES ('demo-admin-1','演示配置管理员一'),('demo-admin-2','演示配置管理员二') ON CONFLICT DO NOTHING;
WITH inserted AS (
  INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,source,requested_by,reviewed_by,reason,reviewed_at) VALUES
    ('dc000000-0000-4000-8000-000000000001','demo-admin-1','PLATFORM_ADMIN',NULL,now(),now()+interval '365 days','ACTIVE','BOOTSTRAP','demo-admin-1','demo-admin-2','Disposable CI bootstrap',now()),
    ('dc000000-0000-4000-8000-000000000002','demo-admin-2','PLATFORM_ADMIN',NULL,now(),now()+interval '365 days','ACTIVE','BOOTSTRAP','demo-admin-2','demo-admin-1','Disposable CI bootstrap',now()),
    ('dc000000-0000-4000-8000-000000000003','agent-1','DISPATCHER','service-desk',now(),now()+interval '365 days','ACTIVE','REVIEW','demo-admin-1','demo-admin-2','Disposable CI dispatcher',now())
  ON CONFLICT DO NOTHING RETURNING *
)
INSERT INTO role_binding_audits(binding_id,actor_id,action,after_value,reason)
SELECT id,reviewed_by,CASE WHEN source='BOOTSTRAP' THEN 'BOOTSTRAPPED' ELSE 'APPROVED' END,to_jsonb(inserted),reason FROM inserted;
-- Demo-only role. Production appointments must be reviewed explicitly.
INSERT INTO priority_reviewers(employee_id,group_id) VALUES ('agent-3','service-desk'),('agent-2','applications') ON CONFLICT DO NOTHING;
INSERT INTO service_catalog(code, type, form_version, published, group_id, required_fields)
VALUES ('INC-BIZ', 'INC', 1, true, 'service-desk', '[]'::jsonb)
ON CONFLICT (code) DO NOTHING;
UPDATE service_catalog SET name='业务系统故障',description='ERP、WMS、MES、SRM 使用异常',
field_schema='[{"key":"system","label":"业务系统","required":false,"options":["ERP","WMS","MES","SRM","其他"]},{"key":"module","label":"模块 / 页面","required":false}]'
WHERE code='INC-BIZ' AND form_version=1;
INSERT INTO service_catalog(code,type,form_version,published,group_id,required_fields,name,description,field_schema) VALUES
('INC-PC','INC',1,true,'service-desk','[]','电脑与外设','电脑、显示器、打印机等设备故障','[{"key":"device","label":"设备编号","required":false}]'),
('INC-NET','INC',1,true,'service-desk','["location"]','网络与 VPN','无法联网、网络慢、VPN 连接异常','[{"key":"location","label":"所在地点","required":true}]'),
('INC-MAIL','INC',1,true,'service-desk','[]','邮箱与协作','收发邮件及协作工具使用异常','[]'),
('REQ-ACCOUNT','REQ',1,true,'service-desk','[]','账号开通与调整','审批接入后开放','[]'),
('REQ-PERM','REQ',1,true,'service-desk','[]','业务系统权限','审批接入后开放','[]'),
('REQ-SOFT','REQ',1,true,'service-desk','[]','软件安装','审批接入后开放','[]'),
('REQ-DEVICE','REQ',1,true,'service-desk','[]','设备借用与领用','审批接入后开放','[]'),
('REQ-VPN','REQ',1,true,'service-desk','[]','VPN 开通','审批接入后开放','[]'),
('REQ-SHARE','REQ',1,true,'service-desk','[]','共享目录权限','审批接入后开放','[]'),
('REQ-GPU','REQ',1,true,'service-desk','[]','GPU 算力','审批接入后开放','[]'),
('REQ-AI','REQ',1,true,'service-desk','[]','AI 模型与额度','审批接入后开放','[]')
ON CONFLICT(code) DO NOTHING;
