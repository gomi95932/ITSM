# GitHub CI/CD 与开发机部署约定

## 现状与目标

仓库已有应用代码、锁文件和 `Application CI`。本次补齐发布框架，结果需以对应提交的实际 Actions 运行核实。`10.10.81.125` 的 Docker/Compose 有历史安装记录，但完整部署、恢复和真实接口联调尚未验收。不要将本文件当成部署完成记录。

2026-11-12 核验记录见 [开发发布验收状态](deployment-verification-2026-11-12.md)：main 发布流水线和发布包内部署恢复演练已通过，但开发机部署仍待现场验证。GitHub 设置页确认仓库私有、没有经典分支保护规则或 ruleset，并提示当前私有仓库套餐不强制执行 ruleset；下文所列门禁是目标配置，不代表已经启用。不得为获得规则支持而将企业代码公开。

目标链路：本机只编辑/提交代码 -> 功能分支 PR -> GitHub 托管 Runner 构建/测试 -> 合并 `main` -> 构建带提交 SHA 的镜像并发布至私有 GHCR -> 经批准部署到开发测试机 -> 健康检查、记录版本和回退点。开发测试机可在必要时构建测试镜像，但不编辑业务代码；本机不运行应用或测试数据库。

## GitHub 仓库设置（需仓库管理员操作）

1. 保持仓库私有；开启 2FA，按最小权限邀请成员，不向 CI 提供个人长期令牌。
2. 为 `main` 设置 ruleset：必须经 PR、至少一人审阅、要求 `Bootstrap checks / repository-config` 与 `Application CI / build-test` 成功、禁止强制推送和删除。首次启用前核对 GitHub 实际显示的检查名。
3. 为部署建立 `development` Environment；仅在真实部署工作流就绪后启用审批规则。不要把普通 PR 的代码放在有部署权限的 Runner 上执行。
4. GHCR 镜像需由具有 `packages: write` 的专用工作流发布，使用 `GITHUB_TOKEN`；镜像以提交 SHA 标记，不用可变的 `latest` 作为回退依据。
5. 保护仓库 Secrets/Environment Secrets；不把数据库密码、钉钉密钥、SSH 私钥、真实数据写入仓库或 Actions 日志。私有包拉取权限要单独验证。

## 流水线门禁与待补工作

- PR：依赖锁文件安装、构建、类型检查、单测、随机私密 CI env、Compose 校验、API/权限/SLA/语音草稿集成、迁移账本/原子回滚、备份恢复以及桌面/移动浏览器旅程；另含个人责任、P1 复核、知识审核与发布、评价、REQ 目录策略、OA 隔离适配器及受控人工交付、报表边界回归。隔离测试不代表真实钉钉、OA、消息通知或语音识别已经联通，不能用绿灯宣称首期全部完成。
- `main`：测试通过后发布 web/api/worker 及 PostgreSQL/Redis 五个 SHA 镜像。数据镜像使用 CI 真正测试过的 digest，不重新选取上游可变标签。三个应用镜像仍在发布 job 重新构建；后续需要验证最终发布镜像与同版本源码测试结果及运行行为一致。
- `release-bundle`：依赖测试及全部镜像发布成功，收集五个不可变 digest，生成包含文件哈希、迁移指纹及 runId 的发布清单和压缩包。在临时 Runner 中解开实际发布包，用包内工具部署固定 digest 镜像，执行工单闭环，再做业务写入后的备份及隔离恢复；全部通过才上传 artifact。这仍不等于开发机现场验收。artifact 保留 30 天；长期发布包及备份需受控异机归档。SHA256 是完整性校验，不代替来源核验和审批。
- 部署：人工批准后在内网运行同版本 `scripts/release.mjs`，步骤见 [发布手册](release-runbook.md)。目前没有声称 GitHub 托管 Runner 可直连内网，也未启用内网自动部署 job。确认网络、目录、备份和回退后再扩展受控 CD。不要把任意 PR 自托管 Runner 放在现有服务主机。
- 部署前备份数据库；升级迁移需注明向前兼容性。启动后检查 API/队列/数据库健康、关键用例及日志；失败时停止发布并按回退手册处理，不能假设数据库迁移可逆。
- 开发环境标准发布使用 `deploy <SHA> --verify-development`，在写入成功记录前自动执行合成工单闭环并再次核对五个运行镜像，记录与 SHA 绑定的验收证据；真实身份或真实通知环境在修改服务前拒绝该选项。不带此选项仅标记 `readiness-only`。main 的最终发布包演练校验这些证据字段，不以健康接口替代业务验收。该门禁仍不代替钉钉/OA 真实集成或受限无人值守发布通道。

## 开发机隔离原则

### 自动化发布来源校验

`scripts/verify-release-source.mjs <完整40位SHA> <Actions运行ID>` 是只读来源门禁，不下载或执行发布包，不修改容器、sudo 或服务器配置。使用独立只读身份，通过环境变量 `ITSM_GITHUB_READ_TOKEN` 注入；CI 可使用 `GITHUB_TOKEN`。身份只需本仓库 Actions 读取权限，不需要写权限；不要在命令参数、文档或 Git 中填写 Token。

工具校验固定仓库的 `app.yml`、main push、指定 SHA、完整成功运行、当前 attempt 的十个必须成功任务，以及唯一且未过期的 `itsm-release-<SHA>` 制品。制品必须带 SHA256 digest，创建时间必须在当前 attempt 的发布任务内；查询前后 attempt 和运行状态不得变化。列举超过 100 项时安全拒绝，不默默忽略分页。

输出绑定 run、attempt、artifact ID、digest 与下载 API 地址；级别明确为 `github-source-only`。这不是制品下载校验、批准、部署成功或业务验收。后续下载必须校验返回归档的实际 digest，解包时阻止路径逃逸和链接，并核对包内 SHA、runId、文件哈希及镜像 digest。服务器只能执行可信受控目录里的已批准包；不得因为此只读工具成功就以 root 执行普通用户可改写的脚本。

发布矩阵任务使用稳定名称 `publish-api/web/worker/postgres/redis`。旧版本运行使用旧任务名时会拒绝本门禁，不通过放宽匹配补救；旧版保留手册中的人工来源核验流程。

`Release source verification` 工作流仅在 main push 的 Application CI 成功结束后启动，另提供 main 上的手动入口。只签出该 main 提交，不执行 artifact 或 PR 代码，不接入内网，也没有部署写权限。完成来源校验后，在 Runner 私有临时目录下载及校验同一 artifact，安全解包并核对清单，保存 `release-source.json` 和 `release-staging.json`；失败即停止，不冒充服务器发布成功。工作流首次合并后仍需用实际 main 发布运行验证 GitHub 返回字段、任务名及实际下载行为。

### 制品下载与非特权预备

`scripts/stage-release.mjs <完整40位SHA> <Actions运行ID> <绝对新目录>` 复用上述来源门禁。运行环境为 Linux、Node >=22 和系统 `/usr/bin/python3`（Python >=3.8）；只从已审核的可信工具目录运行，不使用新下载包里的工具校验它自身。GitHub 读取身份与 GHCR 拉取身份分离，前者仅放在环境变量，不写入命令参数、证明文件或解包子进程环境。

该命令拒绝 root 执行。目标父目录必须属于当前普通用户、0700 且路径不经过符号链接；目标目录必须尚不存在。下载请求固定本仓库 artifact API；只接受 HTTPS 的 GitHub Actions 对象存储重定向，并且不向存储域转发 Authorization。实际 ZIP 长度和 SHA256 必须与 API 的 artifact 元数据一致，不仅校验包内自带 checksum。

可信 Python 辅助工具仅提取精确命名的 tar.gz 和 checksum；禁止路径穿越、重复项、符号链接、硬链接、设备/FIFO、PAX 元数据与额外 ZIP 文件，限制压缩包/展开大小、成员数、内存和 CPU。文件重新以私有权限创建，不恢复归档所有者或执行权限。随后用可信 Node 代码验证发布清单、完整文件集合、每个文件 hash、SHA、runId、runAttempt、迁移指纹及五个镜像 digest，下载后再次查询来源，拒绝期间发生重跑或替换的运行。

成功时输出 `artifact-verified` 证明；包位于 `<目标目录>/verified/bundle`，同层保留来源与预备证明。失败不会生成 `verified`，可能留下空的预留目录；保留现场，人工核对后另选新目录重试，不覆盖。它不调用 Docker、sudo、容器、迁移或包内代码，不等于批准、部署、权限提升或业务验收。

`scripts/promote-release.mjs` 补充受控提升代码，安装和现场验收仍待管理员变更。它不相信普通用户 staging 中的文件或 JSON，而以固定 root 工具和只读身份重新查验 GitHub、重新下载实际制品，只把已批准的精确版本放入 root 管理目录。命令只接收 SHA 与 run ID，不接收目录、命令、配置文件或凭据路径；固定路径和安装要求见发布手册。批准文件须 root 私有、绑定 artifact ID/digest/attempt，最长有效 24 小时；发布前再查批准和来源。完成提升仍不执行 Docker、迁移或新包代码，不等于自动部署。

GitHub 临时 Linux Runner 增加 root 自有 `/run/itsm-promotion-test-*` 夹具测试，通过独立模拟来源验证提升与拒绝路径。模拟 API 不证明服务器 GitHub 身份、真实下载、sudo 入口或现场权限已经生效。禁止直接 `sudo node <普通用户可改写目录>/scripts/release.mjs`，不能仅凭预备证明绕过批准或信任边界。服务器上的部署身份、可信工具安装、批准机制接入、实际 main 制品提升与发布、备份恢复和回退证据仍待完成；不提供通用 Node 或 Docker 的免密 sudo 权限。

Compose 项目名为 `itsm-dev`，数据库和 Redis 仅在独立内部网络中访问，使用独立命名卷；没有宿主机端口映射。Web 仅绑定 `127.0.0.1:8088`，须经 SSH 隧道访问。不要执行 `docker compose down -v`、全局 `docker system prune` 或修改宿主机已有 PostgreSQL、Redis、OpenClaw。启动前单独确认 HTTP 端口、磁盘、备份目标与访问控制。

## 下一项开发任务

先核实当前提交 CI、main 镜像/发布包和服务器授权接入，完成真实部署、员工/工程师操作、备份恢复及兼容回退验证；未完成项明确保留。业务能力按 [实施基线](implementation-baseline.md) 顺序推进：安全入口与个人责任、P1 确认优先于 REQ/OA 和 INC 收尾；监控/CI 第二期，完整 SEC 第三期。
