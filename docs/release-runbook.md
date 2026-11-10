# 开发环境发布、备份与恢复手册

适用环境：10.10.81.125，Compose 项目仅限 `itsm-dev`。本文定义可执行路径，不代表已完成远端验收。Mac 只编辑代码和使用 Git；所有构建、容器和集成测试在 GitHub 托管 CI 或开发服务器执行。

## 1. 发布前置条件

- 管理员确认变更窗口、磁盘、8088 端口及原服务清单；保留现有宿主 PostgreSQL、Redis、OpenClaw 等服务。
- 服务器需有 Node.js 22、Docker Engine、Compose v2 和受控 GitHub/GHCR 出口。Docker 操作账户属于高权限账户，不开放 Docker TCP API。
- 只使用本仓库 `main` 成功流水线的发布包和完整 40 位 SHA；先核对运行 URL、提交、`build-test`、两个镜像发布 job 和 `release-bundle` 全部成功。校验和只验证完整性，不提供发布者身份；不得从聊天、陌生镜像站或不受信任 PR 下载脚本执行。
- GHCR 用只读 `read:packages` 拉取身份，通过 `docker login ghcr.io --password-stdin` 交互输入；不在命令、Git、日志或工单中保存令牌。
- 创建独立目录 `/opt/itsm/releases/<SHA>`、`/opt/itsm/shared`；归属为批准的部署账户。共享目录权限 0700；环境文件 0600。首次创建目录须获管理员授权。
- 开发环境可明确启用虚拟人员种子及开发身份，不可使用真实员工或生产数据。该身份不是正式钉钉免登。

## 2. 私密配置与发布包

在服务器的受控源码副本中运行以下配置生成器；目标文件必须尚不存在，生成器不会覆盖已有凭据：

```sh
node scripts/create-development-env.mjs /opt/itsm/shared/development.env --seed-development-fixtures
```

仅需要空数据库时省略种子选项。虚拟人员只用于隔离验证。`ITSM_SEED_DEV_DATA` 默认 false；正式模式禁止种子。改变现有 env 密码不等于改变已初始化 PostgreSQL 的密码，须另行批准轮换。

下载 `itsm-release-<SHA>` artifact 后，在服务器核对归档的 SHA256，再解压到本次新建的版本目录。不能覆盖旧版本目录或从未核验归档直接执行。发布清单记录代码 SHA、所有文件哈希、迁移指纹和五个 GHCR 镜像的 `sha256` digest。镜像按 digest 拉取，不依赖可变标签。

## 3. 检查与部署

从已验证的版本目录执行；`SHA` 必须是本次批准的完整提交值：

```sh
node scripts/release.mjs check
node scripts/release.mjs deploy "$SHA"
```

也可用 `--env /absolute/private.env --state /absolute/private-state` 指定私密路径。默认项目名固定 `itsm-dev`。脚本拒绝数据库、Redis、API、worker 或迁移服务暴露端口，以及 Web 非回环绑定；示例弱口令也会被拒绝。

部署流程：校验包 -> 拉取 digest 镜像 -> 停止本项目写入者 -> 备份 -> 启动本项目数据服务 -> 事务迁移 -> 启动 API/worker/Web -> 就绪与页面检查 -> 写入版本记录。任何阶段失败即停，不自动恢复数据库，也不声称新版本已发布。迁移文件应用后不可修改；迁移失败会回滚同批 DDL 和迁移账本。

写入成功记录前，还必须逐个核对 db、Redis、API、worker、Web 的运行容器：每个服务只有一个运行实例，Compose 项目/服务标签匹配且非一次性任务，容器健康，并且实际 Image ID 与批准 digest 解析的本地 Image ID 一致。回退采用相同校验，但数据库和 Redis 保持当前版本。页面可访问不等于已运行目标版本；校验失败不会更新 `current.json`。

已有 `itsm-dev` 数据库但没有 `current.json` 时，脚本拒绝自动接管。管理员应先核查原版本、卷和数据库，导出独立备份并制定接管记录；不得为绕过检查删卷或伪造记录。第一次部署的迁移前备份可能为空库，只能作为初始化前现场记录；不能证明业务数据可恢复。

## 4. 真实验证

```sh
node scripts/release.mjs backup
node scripts/release.mjs restore-check --backup /absolute/path/to/itsm-backup.dump
```

备份用 PostgreSQL custom dump，校验哈希和目录，权限 0600。恢复检查创建独立临时数据库，恢复后读取迁移账本及工单表，最后删除该临时数据库，不覆盖正在使用的 ITSM 数据库。仅备份成功不等于恢复已验证；需对迁移完成后的备份执行恢复检查。当前备份覆盖 PostgreSQL；后续附件对象存储必须独立纳入备份与恢复演练。

本机访问通过 SSH 隧道：

```sh
ssh -N -L 8088:127.0.0.1:8088 ituser@10.10.81.125
```

浏览器访问 `http://127.0.0.1:8088`，核验员工提交、服务台处理、员工确认和权限隔离；`/api/v1/health/ready` 只证明数据库及必要结构可读，不替代业务端到端验收。worker 健康依赖成功处理循环的心跳。正式钉钉、OA、通知需各自真实权限和联调证据。

## 5. 回退与故障处理

```sh
node scripts/release.mjs rollback
```

只有当前/上版迁移指纹相同、Compose 文件一致且旧发布包完整可验证，才允许应用镜像回退；保留当前 PostgreSQL/Redis 镜像，不重跑旧迁移。回退不恢复已经写入的数据。迁移或 Compose 不兼容时停止，选择批准的前向修复或单独计划的数据库恢复，不能盲目拉旧镜像。

`release-state` 保存 `current.json`、`previous.json`、历史、失败阶段及备份路径。`operation.lock` 防并发发布；异常断电留下锁时，管理员核对 PID 和真实活动操作，确认已终止后方可人工移除锁，不能自动按时间清锁。工具错误默认脱敏，不输出完整 Compose config、数据库内容或凭据。

禁止 `docker compose down -v`、全局 `docker system prune`、删除现有数据卷、自动停用原平台告警或操作宿主数据库。备份副本需转存受控异机位置并定期验证；同机备份不能防主机损坏。

## 6. 发布完成证据

每次保存：PR/批准记录、SHA、Actions run URL、artifact 来源/校验值、五个镜像 digest、服务器环境、部署记录、业务验证、备份恢复结果、原服务状态及遗留问题。未真实验证的项目标为待验收。当前流水线不直接从 GitHub 托管 Runner 连接内网；初期 CD 是人工批准后执行同一版本化脚本，不运行不受信任 PR 的内网自托管 Runner。
