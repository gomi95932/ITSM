# 开发环境发布、备份与恢复手册

适用环境：10.10.81.125，Compose 项目仅限 `itsm-dev`。本文定义可执行路径，不代表已完成远端验收。Mac 只编辑代码和使用 Git；所有构建、容器和集成测试在 GitHub 托管 CI 或开发服务器执行。

## 1. 发布前置条件

- 管理员确认变更窗口、磁盘、8088 端口及原服务清单；保留现有宿主 PostgreSQL、Redis、OpenClaw 等服务。
- 应用与 CI 使用 Node.js 22；发布工具要求 Node.js >=22、Docker Engine、Compose v2 和受控 GitHub/GHCR 出口。开发机已核实的宿主 Node.js 为 24.14.1，部署时仍须实际验证工具兼容性，不自动替换现有服务的全局运行时。Docker 操作账户属于高权限账户，不开放 Docker TCP API。
- 自动制品预备还需要系统 `/usr/bin/python3`；以普通账户执行已审核目录中的 `stage-release.mjs`。来源校验和解包无需 Docker 或 sudo，不将其与特权部署混用。
- 只使用本仓库 `main` 成功流水线的发布包和完整 40 位 SHA；先核对运行 URL、提交、`build-test`、三个应用镜像发布 job（api/web/worker）、两个数据镜像发布 job（postgres/redis）和 `release-bundle` 全部成功。校验和只验证完整性，不提供发布者身份；不得从聊天、陌生镜像站或不受信任 PR 下载脚本执行。
- GHCR 用只读 `read:packages` 拉取身份，通过 `docker login ghcr.io --password-stdin` 交互输入；不在命令、Git、日志或工单中保存令牌。
- 创建独立目录 `/opt/itsm/releases/<SHA>`、`/opt/itsm/shared`；归属为批准的部署账户。共享目录权限 0700；环境文件 0600。首次创建目录须获管理员授权。
- 开发环境可明确启用虚拟人员种子及开发身份，不可使用真实员工或生产数据。该身份不是正式钉钉免登。
- `release-bundle` 在独立 GitHub 托管 Runner 上解开最终归档，用包内工具按实际镜像 digest 部署，运行工单闭环与越权回归，再做业务写入后的备份及隔离恢复。演练成功才上传发布包；这不替代开发机现场验收。

## 2. 私密配置与发布包

发布包包含配置生成器、发布工具、Compose 文件、迁移及本手册，并在打包末尾执行完整性校验。在服务器核验并解压受信任发布包后，从该版本目录运行以下配置生成器；目标文件必须尚不存在，生成器不会覆盖已有凭据：

```sh
sudo -H node scripts/create-development-env.mjs /opt/itsm/shared/development.env --seed-development-fixtures
```

在 `10.10.81.125`，部署账户需要通过 `sudo` 访问 Docker。首次操作先执行 `sudo -v` 和 `sudo -H node --version`，确认 sudo 环境可找到受信任的系统 Node；用同一 `sudo -H` 身份执行上面的生成器和下文所有 `node scripts/release.mjs` 命令。相同身份也用于 `docker login`。这样配置、发布状态及 Docker 凭据始终由同一执行身份持有。不得先以普通账户生成配置、再直接混用 sudo 执行发布工具；也不要把私密配置改成全局可读或为方便而放宽 Docker 权限。若文件已存在或属主不符，停止并核验，不覆盖现有配置。

仅需要空数据库时省略种子选项。虚拟人员只用于隔离验证。`ITSM_SEED_DEV_DATA` 默认 false；正式模式禁止种子。改变现有 env 密码不等于改变已初始化 PostgreSQL 的密码，须另行批准轮换。

下载 `itsm-release-<SHA>` artifact 后，在服务器核对归档的 SHA256，再解压到本次新建的版本目录。不能覆盖旧版本目录或从未核验归档直接执行。发布清单记录代码 SHA、所有文件哈希、迁移指纹和五个 GHCR 镜像的 `sha256` digest。镜像按 digest 拉取，不依赖可变标签。

新版本可用已审核工具的 `node scripts/stage-release.mjs "$SHA" "$RUN_ID" /absolute/private-staging/new-release` 自动完成来源、实际 ZIP digest、安全解包和清单绑定校验，要求指定 SHA 对应的 main Application CI 全部成功、未重跑变更且 artifact 未过期。`ITSM_GITHUB_READ_TOKEN` 由批准的秘密管理方式注入，不把令牌粘贴到命令行。父目录须由当前普通用户持有、0700、无链接，目标目录不得已存在。工具会拒绝旧版缺少 runAttempt 的清单，不以放宽门禁兼容。

预备输出为 `artifact-verified`，不是发布批准。`verified/bundle` 仍是普通用户可写数据；管理员或后续受限服务必须先将批准版本复制至普通用户不可写的可信发布目录，在可信边界内重新校验后才可执行。不得直接 sudo 执行 staging 内的脚本，也不因具备 source/staging JSON 就开启无人值守 sudo。首次安装可信发布工具、自动提升及受限执行通道是独立的管理员变更。

## 3. 检查与部署

从已验证的版本目录执行；`SHA` 必须是本次批准的完整提交值：

```sh
sudo -H node scripts/release.mjs check
sudo -H node scripts/release.mjs deploy "$SHA" --verify-development
```

也可用 `--env /absolute/private.env --state /absolute/private-state` 指定私密路径。默认项目名固定 `itsm-dev`。脚本拒绝数据库、Redis、API、worker 或迁移服务暴露端口，以及 Web 非回环绑定；示例弱口令也会被拒绝。

部署流程：校验包 -> 拉取 digest 镜像 -> 停止本项目写入者 -> 备份 -> 启动本项目数据服务 -> 事务迁移 -> 启动 API/worker/Web -> 就绪与页面检查 -> 合成工单业务验收 -> 再核对运行镜像 -> 写入版本记录。任何阶段失败即停，不自动恢复数据库，也不声称新版本已发布。迁移文件应用后不可修改；迁移失败会回滚同批 DDL 和迁移账本。

`--verify-development` 明确授权创建一张合成工单并完成员工建单、工程师接收/解决、员工确认，以及幂等、版本冲突和越权检查。仅在开发认证、明确启用测试种子、API 和 worker 都使用 fake 通知且真实发送关闭时允许；部署修改前检查配置及验收脚本的清单哈希。真实身份环境不得加此参数，也不得临时开启开发认证来通过验收，应另行执行真实人员 UAT。省略参数只能得到 `verificationLevel=readiness-only`，不代表业务验收完成。

成功记录保存 `verificationLevel`、`businessAcceptance`（运行编号、合成工单 ID、检查结果和时间）及五个服务的 `runtime`（容器 ID、镜像 ID、批准 digest），与同一记录的 SHA、备份和迁移指纹绑定。失败阶段及已创建的合成工单 ID 保存在私密失败记录中，`current.json` 不更新；此时实际容器可能已经升级，不能把旧 current 记录当作当前运行事实，必须核对失败阶段和容器后处置。合成工单保留审计，不删除历史。

写入成功记录前，还必须逐个核对 db、Redis、API、worker、Web 的运行容器：每个服务只有一个运行实例，Compose 项目/服务标签匹配且非一次性任务，容器健康，并且实际 Image ID 与批准 digest 解析的本地 Image ID 一致。回退采用相同校验，但数据库和 Redis 保持当前版本。页面可访问不等于已运行目标版本；校验失败不会更新 `current.json`。

已有 `itsm-dev` 数据库但没有 `current.json` 时，脚本拒绝自动接管。管理员应先核查原版本、卷和数据库，导出独立备份并制定接管记录；不得为绕过检查删卷或伪造记录。第一次部署的迁移前备份可能为空库，只能作为初始化前现场记录；不能证明业务数据可恢复。

## 4. 真实验证

新发布包包含 `scripts/verify-development.mjs`，无需在开发机安装 npm 依赖或复制源码测试。仅在批准的隔离开发环境、启用虚拟人员种子时执行以下命令；`--allow-synthetic-writes` 明确允许创建一张标记为 `ITSM deployment acceptance` 的测试工单并走完关闭流程。脚本仅接受 HTTP 回环地址，禁止重定向，在任何写入前核对开发模式和三个虚拟人员及权限。它不修改或删除已有工单，不假设数据库为空；每次执行会新增一张测试工单并保留审计痕迹，失败时报告已创建工单 ID 供人工核查，不自动绕过权限或清库。

```sh
node scripts/verify-development.mjs --base-url http://127.0.0.1:8088 --allow-synthetic-writes
```

可以按批准的 Web 端口替换 8088。CI 在解开实际发布包后连续执行两次，核验非空库重跑，再进行业务写入后的备份恢复。检查覆盖就绪、匿名访问、员工隔离、角色限制、幂等、过期版本冲突、工程师解决、员工确认及内部证据隐藏，不等于桌面/移动 UI 或真实钉钉/OA/通知验收。失败会留下本次测试工单，先排查，勿仅凭下一次通过忽略前次失败。旧发布包没有此工具时，不下载独立陌生脚本补跑，使用匹配已核验版本的测试方案。

```sh
sudo -H node scripts/release.mjs backup
sudo -H node scripts/release.mjs restore-check --backup /absolute/path/to/itsm-backup.dump
```

备份用 PostgreSQL custom dump，校验哈希和目录，权限 0600。恢复检查创建独立临时数据库，恢复后读取迁移账本及工单表，最后删除该临时数据库，不覆盖正在使用的 ITSM 数据库。仅备份成功不等于恢复已验证；需对迁移完成后的备份执行恢复检查。当前备份覆盖 PostgreSQL；后续附件对象存储必须独立纳入备份与恢复演练。

本机访问通过 SSH 隧道：

```sh
ssh -N -L 8088:127.0.0.1:8088 ituser@10.10.81.125
```

浏览器访问 `http://127.0.0.1:8088`，核验员工提交、服务台处理、员工确认和权限隔离；`/api/v1/health/ready` 只证明数据库及必要结构可读，不替代业务端到端验收。worker 健康依赖成功处理循环的心跳。正式钉钉、OA、通知需各自真实权限和联调证据。

### 4.1 经批准的局域网测试入口

开发验证入口为 `http://10.10.81.125:8080`，由宿主机已有 `systemd-socket-proxyd` 转发到 `127.0.0.1:8088`。不修改受校验的 Compose、环境文件或镜像，不开放数据库、Redis、API 和 worker 端口。配置源为 `infra/systemd/itsm-dev-lan.socket`、`infra/systemd/itsm-dev-lan.service`，目标为服务器 `/etc/systemd/system/` 下同名文件；它们独立于应用发布包维护，后续应用升级仍需核验该入口。

仅用于虚拟身份及合成数据测试。当前访问者可以选择开发测试用户，不能作为正式人员认证；HTTP 不加密，禁止输入真实敏感数据。不得配置公网端口映射。入口来源仅允许 `10.10.81.0/24` 与 `10.10.91.0/24`；本机代理进程连接 Web 的 `127.0.0.1/32` 规则单独配置。这不是公司人员认证，跨 VLAN 仍取决于企业网络 ACL。服务器的 nftables 与 systemd socket 过滤均须与上述批准网段一致。

首次安装前确认 8080 空闲、两个同名单元不存在，保留原服务基线。将审核后的两个文件传入目标主机并核对 SHA256，再以 root:root、0644 安装；不得覆盖来源不明的既有单元。服务器需要 systemd 255 及实际可用的 cgroup/eBPF 网络过滤，不仅是编译特性显示支持。执行：

```sh
sudo systemd-analyze verify /etc/systemd/system/itsm-dev-lan.socket /etc/systemd/system/itsm-dev-lan.service
sudo systemctl daemon-reload
sudo systemctl enable --now itsm-dev-lan.socket
curl --noproxy '*' --fail --max-time 10 http://10.10.81.125:8080/api/v1/health/ready
sudo systemctl status --no-pager itsm-dev-lan.socket itsm-dev-lan.service
sudo journalctl --no-pager -u itsm-dev-lan.socket -u itsm-dev-lan.service -n 30
```

验收必须包括：8080 仅绑定目标内网 IP、8088 仍仅绑定回环地址、原服务正常、从另一台内网电脑打开页面及就绪接口。再比较以下两条只读探测：第一条应成功，证明测试源可用；第二条必须超时或拒绝，因为 `127.0.0.2` 不在该入口白名单。第二条成功即访问控制验收失败，应立即停止入口，不得宣称内网限制已生效。检查日志不得有 BPF 不受支持或过滤器安装失败信息。外网来源、交换机 ACL、公网 NAT 未做端到端验证，不能据此宣称整个网络边界已通过验收。

```sh
curl --noproxy '*' --interface 127.0.0.2 --fail --max-time 3 http://127.0.0.1:8088/api/v1/health/ready
curl --noproxy '*' --interface 127.0.0.2 --fail --connect-timeout 2 --max-time 3 http://10.10.81.125:8080/api/v1/health/ready
```

代理只转发 TCP，不注入 `X-Forwarded-For`，应用看到的是代理连接地址，不能把它当作终端 IP 溯源方案。正式上线需有真实认证、HTTPS 和可信边界代理的来源审计设计。关闭测试入口仅停用本单元，不删除数据或停止 ITSM 容器：

```sh
sudo systemctl disable --now itsm-dev-lan.socket
```

`PartOf` 会同时停止代理服务；关闭后检查 8080 不再监听而 8088 仍可用。开机自动启动仅在 enable 成功后成立；未实际重启主机不能宣称重启恢复已验证。

## 5. 回退与故障处理

```sh
sudo -H node scripts/release.mjs rollback
```

只有当前/上版迁移指纹相同、Compose 文件一致且旧发布包完整可验证，才允许应用镜像回退；保留当前 PostgreSQL/Redis 镜像，不重跑旧迁移。回退不恢复已经写入的数据。迁移或 Compose 不兼容时停止，选择批准的前向修复或单独计划的数据库恢复，不能盲目拉旧镜像。

在同样满足合成验证条件的开发环境，可执行 `rollback --verify-development`，须从当前已部署发布包目录运行。工具先验证当前包中的验收脚本，再在回退后重新执行业务检查、核对五个运行镜像并生成新的回退记录。旧版业务验收结果不会冒充此次结果；不带参数回退也明确记录为仅就绪检查。

`release-state` 保存 `current.json`、`previous.json`、历史、失败阶段及备份路径。`operation.lock` 防并发发布；异常断电留下锁时，管理员核对 PID 和真实活动操作，确认已终止后方可人工移除锁，不能自动按时间清锁。工具错误默认脱敏，不输出完整 Compose config、数据库内容或凭据。

禁止 `docker compose down -v`、全局 `docker system prune`、删除现有数据卷、自动停用原平台告警或操作宿主数据库。备份副本需转存受控异机位置并定期验证；同机备份不能防主机损坏。

## 6. 发布完成证据

每次保存：PR/批准记录、SHA、Actions run URL、artifact 来源/校验值、五个镜像 digest、服务器环境、部署记录、业务验证、备份恢复结果、原服务状态及遗留问题。未真实验证的项目标为待验收。当前流水线不直接从 GitHub 托管 Runner 连接内网；初期 CD 是人工批准后执行同一版本化脚本，不运行不受信任 PR 的内网自托管 Runner。
