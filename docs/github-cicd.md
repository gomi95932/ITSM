# GitHub CI/CD 与开发机部署约定

## 现状与目标

仓库目前没有 ITSM 应用代码。现有 `Bootstrap checks` 仅检查提交内容及 Compose 配置，不包含编译、应用测试、镜像发布或部署。`10.10.81.125` 尚未安装 Docker，不要将这份规范当成已完成的部署记录。

目标链路：本机开发 -> 功能分支 PR -> GitHub 托管 Runner 构建/测试 -> 合并 `main` -> 构建带提交 SHA 的镜像并发布至私有 GHCR -> 经批准部署到开发测试机 -> 健康检查、记录版本和回退点。测试机只拉镜像和运行容器，不编辑业务代码。

## GitHub 仓库设置（需仓库管理员操作）

1. 保持仓库私有；开启 2FA，按最小权限邀请成员，不向 CI 提供个人长期令牌。
2. 为 `main` 设置 ruleset：必须经 PR、至少一人审阅、要求 `Bootstrap checks / repository-config` 成功、禁止强制推送和删除。待应用测试接入后，将对应检查加为必过项。
3. 为部署建立 `development` Environment；仅在真实部署工作流就绪后启用审批规则。不要把普通 PR 的代码放在有部署权限的 Runner 上执行。
4. GHCR 镜像需由具有 `packages: write` 的专用工作流发布，使用 `GITHUB_TOKEN`；镜像以提交 SHA 标记，不用可变的 `latest` 作为回退依据。
5. 保护仓库 Secrets/Environment Secrets；不把数据库密码、钉钉密钥、SSH 私钥、真实数据写入仓库或 Actions 日志。私有包拉取权限要单独验证。

## 后续流水线门禁（应用代码进入仓库时实现）

- PR：依赖锁文件安装、格式/类型检查、单元测试、API 契约测试、迁移验证、构建；有 E2E 时增加模拟集成测试。
- `main`：仅在所有检查通过后构建前后端及 worker 镜像，推送 GHCR；记录镜像 digest、源提交和迁移版本。
- 部署：首次先人工执行。确认 Docker 安装、网络可达、独立目录、备份与回退演练后，再选择受限的自动化方式。开发机不开放 Docker TCP API；若使用 SSH，必须经受控网络和专用最小权限账号。不要把可执行任意 PR 的自托管 Runner 放在承载现有服务的主机上。
- 部署前备份数据库；升级迁移需注明向前兼容性。启动后检查 API/队列/数据库健康、关键用例及日志；失败时停止发布并按回退手册处理，不能假设数据库迁移可逆。

## 开发机隔离原则

Compose 项目名为 `itsm-dev`，数据库和 Redis 仅在独立内部网络中访问，使用独立命名卷；没有宿主机端口映射。不要执行 `docker compose down -v`、全局 `docker system prune` 或修改宿主机已有 PostgreSQL、Redis、OpenClaw。将来增加应用容器时单独确认 HTTP 端口、磁盘、备份目标与访问控制。

## 下一项开发任务

按蓝图 T01 建立 `apps/web`、`apps/api`、`apps/worker`、`packages/contracts` 的可运行 monorepo，加入锁文件和真实测试后升级 CI。随后按 T04 交付工单状态机与事件日志。钉钉、GLPI、OA 仅在接口权限和字段经验证后接入，先使用 fake adapter。
