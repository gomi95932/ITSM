# 开发验证机环境与历史检查记录

目标机器为 `10.10.81.125`。Docker 已安装，ITSM 应用部署尚未执行；其现有 PostgreSQL、Redis、OpenClaw 等服务不属于 ITSM。创建持久化目录和开放访问前，先确认变更窗口、端口和备份目标。不要使用未挂载的磁盘，也不要对宿主机执行全局 prune 或删除卷。

**2026-11-15 现场核对：**上段“尚未部署”及下方基础准备是历史状态，不代表当前现状。当前服务器 `itsm-dev` 五个容器已运行，记录提交为 `4759163954ebf7d06e22f6979d97cf14baa832d3`，五个运行镜像与该旧版记录的 digest 一致；这不是最新 main 部署或业务验收证明。8080 内网入口可达，8088 仅回环监听。现场有手工 nft 规则及服务，但单元的 `IPAddressAllow/Deny` 为空，与仓库规划有漂移；新增版本化规则/服务及隔离 CI 后仍须批准安装并现场验收。随后已完成六个固定 root 发布工具和部署 systemd 模板安装，并复核 `/opt/itsm`、`releases`、`shared` 的 root 管理权限；安装回执为 `trusted-tools-installed`、`deploymentPerformed=false`。独立 GitHub 只读凭据尚未配置，真实制品提升、新版发布和隔离恢复未完成，完整受控 CI/CD 闭环仍未验收。

**2026-11-10 更新：**下列基础检查是历史证据，不保证当前主机状态。现已编写版本化迁移、就绪检查、发布/备份/恢复校验及兼容回退脚本，真实执行情况仍待 CI 和服务器验收；正式操作以 [发布与恢复手册](release-runbook.md) 为准。下方初次准备是源码验证方式，不是 digest 发布流程。

## 2026-11-09 基础环境检查记录

- Ubuntu 24.04.4 LTS；根卷可用约 846 GB，内存约 15 GiB；未操作其他磁盘。
- 经用户确认，通过 Ubuntu 软件源安装 `docker.io` 和 `docker-compose-v2`。Docker Engine 29.1.3、Compose 2.40.3，docker/containerd 为 active；Docker 数据目录 `/var/lib/docker`。
- 宿主 postgresql/redis-server 仍为 active，原有 1883/5432/6379/9090 监听仍在；这是进程/端口核对，不是原有应用的业务回归测试。8088 未占用。
- 未把 `ituser` 加入 docker 组，管理员操作仍经 sudo；未开放 Docker TCP API，未启动 ITSM 容器。
- 安装提示运行内核为 6.8.0-146-generic，而已安装内核为 6.8.0-147-generic；待安排维护窗口重启，本次未重启。
- 软件源可访问；GitHub 直连超时，既有 127.0.0.1:7890 代理访问 GitHub TLS 握手失败。GHCR 的 HTTPS 接口有响应，但未验证私有镜像授权与完整下载；Docker Hub 直连超时。
- 待验收：远端 CI、私有 GHCR 拉取身份、五个发布镜像、隔离目录/测试口令、Compose 实际启动、SSH 隧道访问、回退演练。Docker 安装完成不等于开发验证环境整体就绪。

## 首次准备

1. Docker/Compose 已通过 Ubuntu 软件源安装，版本见上述记录。Docker 控制权等同高权限；由受控管理员执行部署。`ituser` 的 sudo 需要交互密码；不能用未经审核的第三方 GitHub 镜像代替，也不能把密码输入自动化脚本。部署前仍需确认经批准的 GitHub/GHCR 网络出口。
2. 在隔离目录建立受控源码副本，固定在已通过 CI 的提交 SHA。开发机不编辑业务代码。用 `node scripts/create-development-env.mjs infra/compose/.env --seed-development-fixtures` 生成随机测试口令和显式种子开关，文件权限 0600；绝不上传 GitHub。
3. 检查 `ITSM_WEB_PORT` 未占用。Web 仅监听 `127.0.0.1:8088`（可配置）；从本机通过 SSH 本地转发访问。正式开放前必须完成真实身份认证与 HTTPS。
4. 用 `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml config --quiet` 校验，再用 `docker compose ... up -d --build` 启动 T01 骨架，`docker compose ... ps` 检查健康状态。启动日志不得出现数据库口令。
5. 在服务器本地请求 `http://127.0.0.1:8088/api/v1/health/ready`，核对 `status=ok`；此接口检查数据库与必要结构，仍不能证明工单读写、通知或真实业务流程全部可用。

## 镜像发布与手工验证

`main` 的 Application CI 通过后，GitHub Actions 向私有 GHCR 发布 `ghcr.io/gomi95932/itsm-{api,web,worker,postgres,redis}:<commit-sha>`。PostgreSQL 和 Redis 来源分别为 Docker 官方镜像的 `postgres:16-alpine`、`redis:7.4-alpine`，在 GitHub Runner 拉取后复制到本仓库 GHCR；上线前核对其实际来源 digest 和平台架构。首次先验证五个镜像在仓库 Packages 中可见，并为服务器配置仅具 `read:packages` 权限的受控拉取身份。不要把 GHCR 凭据提交到仓库或写入 Compose 文件。

在 `.env` 中设置 `ITSM_IMAGE_PREFIX=ghcr.io/gomi95932/itsm`、`ITSM_IMAGE_TAG=<commit-sha>`、`ITSM_POSTGRES_IMAGE=ghcr.io/gomi95932/itsm-postgres:<commit-sha>`、`ITSM_REDIS_IMAGE=ghcr.io/gomi95932/itsm-redis:<commit-sha>`，然后使用 `docker compose ... pull`、`docker compose ... up -d --no-build`。镜像标记固定到经验证的提交；部署记录还应保存各平台的实际 digest。当前不启用 GitHub 托管 Runner 直连内网，也不在这台承载其他服务的机器上运行可执行不受信任 PR 的自托管 Runner。

验收分成四个门槛：Docker Engine 与 Compose 可执行；服务器能经受控出口访问 GitHub/GHCR；指定 SHA 的镜像可拉取且容器健康；通过 SSH 隧道打开页面与健康接口。任一门槛失败都保留现有服务原状并记录失败点，不宣称开发环境就绪。

## 回退和数据

已提供迁移账本及校验和、事务迁移、数据库备份、独立恢复检查、同迁移指纹/同 Compose 的应用回退脚本。它们是否通过验证需看真实 CI/远端执行证据；未演练不得声称可恢复。优先使用发布手册的 digest 路径，以上手动 SHA 标签示例仅作历史说明，不代替发布清单。禁止 `docker compose down -v`。
