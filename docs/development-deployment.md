# 开发验证机运行手册（T01 阶段）

目标机器为 `10.10.81.125`。当前部署尚未执行；其现有 PostgreSQL、Redis、OpenClaw 等服务不属于 ITSM。安装 Docker、创建持久化目录和开放访问前，先确认变更窗口、端口和备份目标。不要使用未挂载的磁盘，也不要对宿主机执行全局 prune 或删除卷。

## 首次准备

1. 按 Docker 官方 Ubuntu 安装文档安装 Engine 与 Compose plugin，确认 `docker compose version`。Docker 控制权等同高权限；由受控管理员执行部署。
   当前系统为 Ubuntu 24.04.4；`ituser` 的 sudo 需要交互密码。软件源可访问，但 GitHub 直连超时，现有本机代理访问 GitHub 的 TLS 握手失败。安装前先确认经批准的 GitHub/GHCR 网络出口；不能用未经审核的第三方 GitHub 镜像代替，也不能把密码输入自动化脚本。
2. 在隔离目录建立仓库只读工作副本，固定在已通过 CI 的提交 SHA。开发机不直接编辑业务代码。准备 `infra/compose/.env`，只放测试口令，限制为 `0600`；绝不上传到 GitHub。
3. 检查 `ITSM_WEB_PORT` 未占用。Web 仅监听 `127.0.0.1:8088`（可配置）；从本机通过 SSH 本地转发访问。正式开放前必须完成真实身份认证与 HTTPS。
4. 用 `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml config --quiet` 校验，再用 `docker compose ... up -d --build` 启动 T01 骨架，`docker compose ... ps` 检查健康状态。启动日志不得出现数据库口令。
5. 在服务器本地请求 `http://127.0.0.1:8088/api/v1/health`，核对 `status=ok`；查看页面仅验证静态资源。此检查不能证明工单、数据库读写或通知功能可用。

## 镜像发布与手工验证

`main` 的 Application CI 通过后，GitHub Actions 向私有 GHCR 发布 `ghcr.io/gomi95932/itsm-{api,web,worker}:<commit-sha>`。首次先验证三个镜像在仓库 Packages 中可见，并为服务器配置仅具 `read:packages` 权限的受控拉取身份。不要把 GHCR 凭据提交到仓库或写入 Compose 文件。

在 `.env` 中设置 `ITSM_IMAGE_PREFIX=ghcr.io/gomi95932/itsm` 与精确的 `ITSM_IMAGE_TAG=<commit-sha>`，然后使用 `docker compose ... pull`、`docker compose ... up -d --no-build`。记录源提交、镜像 digest、执行人、时间和验证结果。当前不启用 GitHub 托管 Runner 直连内网，也不在这台承载其他服务的机器上运行可执行不受信任 PR 的自托管 Runner。

验收分成四个门槛：Docker Engine 与 Compose 可执行；服务器能经受控出口访问 GitHub/GHCR；指定 SHA 的镜像可拉取且容器健康；通过 SSH 隧道打开页面与健康接口。任一门槛失败都保留现有服务原状并记录失败点，不宣称开发环境就绪。

## 回退和数据

上线业务数据库前需先实现并验证版本化迁移、备份、恢复及兼容性窗口。当前没有迁移和业务数据，不能声称具备数据回退能力。镜像回退须指定上一个通过验证的 SHA，并检查迁移兼容性；不得执行 `docker compose down -v`。
