# ITSM

公司内部 ITSM 系统的独立代码仓库。当前处于仓库与开发环境引导阶段，业务应用尚未实现；不要将配置检查通过理解为工单功能已经可用。

## 工作边界

- 本机：编辑代码、提交 Git、发起 Pull Request。
- GitHub：私有仓库、代码审阅、CI；后续应用就绪后再构建与发布镜像。
- `10.10.81.125`：ITSM 开发测试运行环境。现有服务及宿主机 PostgreSQL/Redis 不属于本项目，不应覆盖或复用。
- 现有 ELK、监控、本地模型等运行在其他服务器，后续通过受控适配器集成。

业务基线是本地《公司内部ITSM系统开发规格与实施蓝图_V1.1》。进入应用开发前，应将经批准的版本纳入仓库 `docs/`，并确认 GLPI 工单复用评估的结论；不得同时维护两套工单真相源。

## 目录

```text
.github/workflows/       GitHub Actions 检查
docs/                    仓库治理与部署步骤
infra/compose/           独立开发测试数据服务（尚不包含应用）
apps/                    后续 web、api、worker
packages/                后续 contracts、ui
db/migrations/           后续数据库迁移
tests/e2e/               后续端到端测试
```

当前仅提交已实现的目录；上面的 `apps/` 等是蓝图约定，不代表已有代码。

## 环境准备

开发机安装 Docker/Compose 且确认端口和磁盘后，复制 `infra/compose/.env.example` 为 `infra/compose/.env`，在开发机上填入**仅用于测试**的随机口令。不要提交 `.env`、生产凭据或真实员工数据。服务不对宿主机发布数据库或 Redis 端口。

```sh
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml config --quiet
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps
```

这些命令目前只会启动独立 PostgreSQL、Redis；不能据此宣称 ITSM 应用已部署。安装 Docker、创建目录、迁移和备份须单独批准并验证。后续接入应用时要求版本化数据库迁移、健康检查、镜像回退和恢复演练。

GitHub 分支、PR、镜像发布和开发机部署规则见 [docs/github-cicd.md](docs/github-cicd.md)。
