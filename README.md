# ITSM

公司内部 ITSM 系统的独立代码仓库。当前已具备可构建的 Vue/NestJS/Worker 骨架和健康检查，但业务工单尚未实现；不要将健康检查理解为工单功能可用。

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
db/migrations/           后续数据库迁移
tests/e2e/               后续端到端测试
```

目前 `apps/` 与 `packages/contracts` 已有 T01 骨架；数据库迁移、业务模块和 E2E 尚未交付。

## 环境准备

本机仅编辑代码并使用 Git；不运行 ITSM 的构建、服务或测试数据库。构建与自动检查交给 GitHub Actions，部署验证交给 `10.10.81.125`。服务器安装 Docker/Compose 且确认端口和磁盘后，复制 `infra/compose/.env.example` 为 `infra/compose/.env`，填入**仅用于测试**的随机口令。不要提交 `.env`、生产凭据或真实员工数据。数据库、Redis 和 API 不发布宿主机端口；Web 仅绑定回环地址供 SSH 隧道访问。

```sh
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml config --quiet
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps
```

这些命令启动数据库、Redis 和 T01 应用骨架；API `/api/v1/health` 仅检查进程，不检查数据库和业务可用性。安装 Docker、创建目录、迁移和备份须单独批准并验证。业务接入后要求版本化迁移、真实依赖就绪检查、镜像回退和恢复演练。详见 [开发环境运行手册](docs/development-deployment.md)。

GitHub 分支、PR、镜像发布和开发机部署规则见 [docs/github-cicd.md](docs/github-cicd.md)。
