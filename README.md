# ITSM

公司内部轻量 ITSM 系统的独立代码仓库。已有员工端、IT 工作台、INC 核心、SLA、身份/通知适配及语音草稿基础；REQ/OA、个人责任、知识等仍需补齐。代码存在不代表真实外部联调或部署验收完成。

## 工作边界

- 本机：编辑代码、提交 Git、发起 Pull Request。
- GitHub：私有仓库、代码审阅、CI；合并主分支后发布带提交 SHA 的镜像，部署仍需人工批准与验证。
- `10.10.81.125`：ITSM 开发测试运行环境。现有服务及宿主机 PostgreSQL/Redis 不属于本项目，不应覆盖或复用。
- 现有 ELK、监控、本地模型等运行在其他服务器，后续通过受控适配器集成。

业务基线是 [V1.2 开发规格与实施蓝图](docs/design/itsm-development-blueprint-v1.2.md)及 2026-11-10 已确认的分期决策，仓库执行映射见 [实施基线](docs/implementation-baseline.md)。V1.2 补充工程师角色、工单到人及钉钉处理契约，不代表这些能力已经实现。业务参数及 GLPI 工单复用结论仍需确认；不得同时维护两套工单真相源。

## 目录

```text
.github/workflows/       GitHub Actions 检查
docs/                    仓库治理与部署步骤
infra/compose/           独立开发测试 Compose（应用与数据服务）
apps/                    web、api、worker
packages/                contracts；后续 ui
db/migrations/           工单核心初始化迁移
db/seeds/                仅开发/CI 测试种子
tests/integration/       CI 容器 API 集成测试
```

历史切片记录见 `docs/t04-delivery.md`；当前能力与缺口以实施基线及对应提交的 CI/联调记录为准，不把历史文档当成当前交付证明。

## 环境准备

本机仅编辑代码并使用 Git；不运行 ITSM 的构建、服务或测试数据库。构建与自动检查交给 GitHub Actions，部署验证交给 `10.10.81.125`。以下命令只在服务器受控源码副本执行，配置生成器创建随机口令且拒绝覆盖已有文件。不要提交 `.env`、生产凭据或真实员工数据。数据库、Redis 和 API 不发布宿主机端口；Web 仅绑定回环地址供 SSH 隧道访问。

```sh
node scripts/create-development-env.mjs infra/compose/.env --seed-development-fixtures
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml config --quiet
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d --build --wait
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps
```

这份 Compose **仅适用于隔离开发/CI 环境**。迁移使用账本、文件校验和及事务锁，已执行迁移不可修改；种子默认关闭，必须显式选择。API 使用 `X-Dev-User: employee-1` / `agent-1` 模拟身份，仅在非 production 且 `ENABLE_DEV_AUTH=true` 时启用；不能把测试数据或模拟身份带到正式环境。`/api/v1/health` 检查进程，`/api/v1/health/ready` 进一步检查数据库和必要迁移，但仍不能代替业务验收。服务器现状见 [开发环境记录](docs/development-deployment.md)，实际发布按 [发布与恢复手册](docs/release-runbook.md)。

开发测试 API：`POST /api/v1/tickets` 须带唯一 `Idempotency-Key`（8–128 位）；`GET /api/v1/tickets?mine=true`、`GET /api/v1/tickets/{id}`；`POST /api/v1/tickets/{id}/actions` 同样须带幂等键及 `expectedVersion`。普通员工只看本人，支持人员按组可见；工单、状态事件、审计和 outbox 同事务。worker 已有通知重试和 SLA 扫描基础；钉钉真实免登/通知仍需联调，REQ/OA 和受控附件未交付。CI 覆盖 API、权限、SLA、语音草稿、浏览器旅程及迁移/备份恢复。本机不运行上述测试。

GitHub 分支、PR、镜像发布和开发机部署规则见 [docs/github-cicd.md](docs/github-cicd.md)。
