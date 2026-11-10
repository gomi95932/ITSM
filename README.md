# ITSM

公司内部 ITSM 系统的独立代码仓库。T01 骨架与 T04 工单核心 API 正在开发中；其余流程及钉钉正式接入尚未完成。

## 工作边界

- 本机：编辑代码、提交 Git、发起 Pull Request。
- GitHub：私有仓库、代码审阅、CI；合并主分支后发布带提交 SHA 的镜像，部署仍需人工批准与验证。
- `10.10.81.125`：ITSM 开发测试运行环境。现有服务及宿主机 PostgreSQL/Redis 不属于本项目，不应覆盖或复用。
- 现有 ELK、监控、本地模型等运行在其他服务器，后续通过受控适配器集成。

业务基线是本地《公司内部ITSM系统开发规格与实施蓝图_V1.1》。进入应用开发前，应将经批准的版本纳入仓库 `docs/`，并确认 GLPI 工单复用评估的结论；不得同时维护两套工单真相源。

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

目前已有 T01 骨架和待 CI 验证的 T04 工单核心 API。前端业务页面、完整 SLA、审批和真实系统集成尚未交付；进度与限制见 `docs/t04-delivery.md`。

## 环境准备

本机仅编辑代码并使用 Git；不运行 ITSM 的构建、服务或测试数据库。构建与自动检查交给 GitHub Actions，部署验证交给 `10.10.81.125`。服务器安装 Docker/Compose 且确认端口和磁盘后，复制 `infra/compose/.env.example` 为 `infra/compose/.env`，填入**仅用于测试**的随机口令。不要提交 `.env`、生产凭据或真实员工数据。数据库、Redis 和 API 不发布宿主机端口；Web 仅绑定回环地址供 SSH 隧道访问。

```sh
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml config --quiet
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps
```

这份 Compose **仅适用于隔离开发/CI 环境**：`migrate` 执行 `db/migrations/001_ticket_core.sql` 并装载 `db/seeds/dev.sql` 的测试人员及 `INC-BIZ` 目录项。API 使用 `X-Dev-User: employee-1` / `agent-1` 模拟身份，仅在 `NODE_ENV` 非 production 且 `ENABLE_DEV_AUTH=true` 时启用；生产模式硬性拒绝。不能把测试数据或模拟身份带到正式环境。`/api/v1/health` 仅检查进程，不检查数据库和业务可用性。安装 Docker、创建目录、备份与部署须单独批准并验证。详见 [开发环境运行手册](docs/development-deployment.md)。

开发测试 API：`POST /api/v1/tickets` 须带唯一 `Idempotency-Key`（8–128 位），正文参见蓝图第 7 章；`GET /api/v1/tickets?mine=true`、`GET /api/v1/tickets/{id}`；`POST /api/v1/tickets/{id}/actions` 同样须带幂等键及 `expectedVersion`。普通员工只看本人，支持人员按组可见；工单写入、状态事件、审计和待投递 outbox 在同一数据库事务。**outbox 尚未有真实投递器，OA/钉钉/SLA/附件/正式身份暂不可用。** GitHub CI 在隔离 Compose 中运行 `tests/integration/tickets.mjs` 并检查数据库记录数。本机不运行服务和测试数据库。

GitHub 分支、PR、镜像发布和开发机部署规则见 [docs/github-cicd.md](docs/github-cicd.md)。
