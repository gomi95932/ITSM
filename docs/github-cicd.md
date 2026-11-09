# GitHub CI/CD 与开发机部署约定

## 现状与目标

仓库已有 T01 应用骨架、锁文件和 `Application CI` 工作流，但本次改动尚未推送，CI/镜像发布尚未实跑。现有 `Bootstrap checks` 检查仓库配置；`Application CI / build-test` 将执行依赖安装、构建、类型检查、单测、Compose 静态校验和容器冒烟测试，`main` 通过后 `publish` 将发布三个 SHA 镜像。`10.10.81.125` 尚未安装 Docker，且 GitHub/GHCR 连通性尚未验收。不要将本文件当成已完成的部署记录。

目标链路：本机只编辑/提交代码 -> 功能分支 PR -> GitHub 托管 Runner 构建/测试 -> 合并 `main` -> 构建带提交 SHA 的镜像并发布至私有 GHCR -> 经批准部署到开发测试机 -> 健康检查、记录版本和回退点。开发测试机可在必要时构建测试镜像，但不编辑业务代码；本机不运行应用或测试数据库。

## GitHub 仓库设置（需仓库管理员操作）

1. 保持仓库私有；开启 2FA，按最小权限邀请成员，不向 CI 提供个人长期令牌。
2. 为 `main` 设置 ruleset：必须经 PR、至少一人审阅、要求 `Bootstrap checks / repository-config` 与 `Application CI / build-test` 成功、禁止强制推送和删除。首次启用前核对 GitHub 实际显示的检查名。
3. 为部署建立 `development` Environment；仅在真实部署工作流就绪后启用审批规则。不要把普通 PR 的代码放在有部署权限的 Runner 上执行。
4. GHCR 镜像需由具有 `packages: write` 的专用工作流发布，使用 `GITHUB_TOKEN`；镜像以提交 SHA 标记，不用可变的 `latest` 作为回退依据。
5. 保护仓库 Secrets/Environment Secrets；不把数据库密码、钉钉密钥、SSH 私钥、真实数据写入仓库或 Actions 日志。私有包拉取权限要单独验证。

## 流水线门禁与待补工作

- PR：当前已配置依赖锁文件安装、构建、类型检查、单测、Compose 配置校验及 web/API 容器冒烟测试；格式检查、API 契约测试、迁移验证、业务 E2E 尚待业务代码交付。
- `main`：当前已配置成功后发布 web/api/worker 三个 SHA 镜像到 GHCR；必须在 GitHub 上核对实际运行结果、三个镜像的包权限与 digest，不能仅凭 YAML 声称发布成功。
- 部署：首次先人工执行。确认 Docker 安装、网络可达、独立目录、备份与回退演练后，再选择受限的自动化方式。开发机不开放 Docker TCP API；若使用 SSH，必须经受控网络和专用最小权限账号。不要把可执行任意 PR 的自托管 Runner 放在承载现有服务的主机上。
- 部署前备份数据库；升级迁移需注明向前兼容性。启动后检查 API/队列/数据库健康、关键用例及日志；失败时停止发布并按回退手册处理，不能假设数据库迁移可逆。

## 开发机隔离原则

Compose 项目名为 `itsm-dev`，数据库和 Redis 仅在独立内部网络中访问，使用独立命名卷；没有宿主机端口映射。Web 仅绑定 `127.0.0.1:8088`，须经 SSH 隧道访问。不要执行 `docker compose down -v`、全局 `docker system prune` 或修改宿主机已有 PostgreSQL、Redis、OpenClaw。启动前单独确认 HTTP 端口、磁盘、备份目标与访问控制。

## 下一项开发任务

先在 GitHub 和 `10.10.81.125` 实跑 T01：确认服务器 GitHub/GHCR 可达、安装 Docker/Compose、拉取指定 SHA 并验证健康状态。随后按蓝图 T04 交付工单状态机与事件日志。钉钉、GLPI、OA 仅在接口权限和字段经验证后接入，先使用 fake adapter。
