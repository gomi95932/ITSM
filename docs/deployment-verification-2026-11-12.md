# ITSM 开发发布验收状态

核验日期：2026-11-12。目标服务器：`10.10.81.125`。本文件区分代码/CI 证据与服务器现场证据，不是上线完成声明。

## 1. 已核实的代码与 CI

- 仓库：`gomi95932/ITSM`，GitHub 设置页确认为私有，默认分支 `main`。
- PR #1 已合并；远端 main 为 `5f9c2cadf36733cc9fc9201fda5b75988075092b`。
- [Application CI #100](https://github.com/gomi95932/ITSM/actions/runs/42996048519) 最新第 2 次尝试显示成功。初次发布遇到 GHCR `unknown blob`，重跑后成功，不将旧尝试的失败节点作为最新结果。
- [release-bundle 实际日志](https://github.com/gomi95932/ITSM/actions/runs/42996048519/job/130445913061) 显示归档校验、私密配置生成、隔离检查、指定 SHA 部署、工单 API 回归、业务写入后备份和临时数据库恢复检查均成功。
- 上述部署和恢复发生在 GitHub 临时 Runner，不发生在开发服务器。恢复检查验证迁移账本和工单表可读取，不是业务数据逐项比对或灾难恢复的完整验收。
- 本次没有在 Mac 构建应用、启动容器或运行应用测试。

### 开发验收增强分支

- 分支 `feat/development-acceptance` 增加可在已有数据的开发库重复运行的验收工具；每次只创建、操作并保留本轮合成工单，不要求空库，也不删除既有数据。
- 提交 `2e1c5238884535308fca58e4ba329ac6bd5d4cf0` 的 [Application CI #101](https://github.com/gomi95932/ITSM/actions/runs/43141366262) 失败。构建、类型检查、单元测试、浏览器流程及此前集成检查已通过；新验收停在 `ACCEPTANCE_CROSS_USER_WRITE_FAILED`，未进入发布。
- 已定位验收脚本的操作请求缺少 `contentClass: GENERAL`，被普通入口安全策略提前拒绝，导致未到达预期的权限检查。修复限于验收请求和单元测试断言，不放宽服务端安全策略。
- 修复提交 `2405abc00d178f1f2acadd9ba9346e05ca068092` 的 [Application CI #102](https://github.com/gomi95932/ITSM/actions/runs/43142850296) 已核实成功，build-test 用时 4m43s。构建、类型检查、单元/集成检查及桌面/移动端浏览器流程通过；重复开发验收两次均为 `status: passed`，完成时间分别为 `2026-11-12T02:43:31.479Z`、`2026-11-12T02:43:31.693Z`。特性分支的镜像发布和发布包任务跳过，不能将其视为新 main 发布包已生成。
- 此分支尚未合并到 main；下述可信包仍为原 main 版本，不包含新验收工具。

## 2. 可信发布包

发布包通过已登录 Safari 从上述 Actions 的 artifact 下载。Mac 本地目录：

```text
/Users/robinzhu/Downloads/itsm-release-5f9c2cadf36733cc9fc9201fda5b75988075092b/
```

归档文件为 `itsm-release-5f9c2cadf36733cc9fc9201fda5b75988075092b.tar.gz`。SHA256 校验通过：

```text
33701bbb7e4183a12672eb8866fb18dde9406d52cad126d259a31ce5cd29f4c8
```

不能把 artifact 外层 ZIP 的 digest 当作此 tar.gz 的校验值。校验和只证明完整性；来源依据是已认证的 Actions 下载及对应提交/日志核验。

发布清单的五个固定镜像：

| 服务 | 镜像 |
| --- | --- |
| API | `ghcr.io/gomi95932/itsm-api@sha256:1c8c55e12946cf8036a62a3eddf41354cb8f6958cfb87a1b310870333858f954` |
| Web | `ghcr.io/gomi95932/itsm-web@sha256:15fda30e7f40b8b77c5aae7842732e48f38b59912196870f20cc0555f849544b` |
| Worker | `ghcr.io/gomi95932/itsm-worker@sha256:feca6d370119731d3e7231302e7aeb34756bc2a8cd089b8a8019190f67ff0886` |
| PostgreSQL | `ghcr.io/gomi95932/itsm-postgres@sha256:7ca38c207cbe66af8f9eebc32cbedd3f12752db53d264f08afbfca32d169d337` |
| Redis | `ghcr.io/gomi95932/itsm-redis@sha256:621bf77af3920abd1956aa833809b12297ed53350ac7a698ba4c437f944b38a6` |

迁移指纹：`46c1998e76789cd8d68bc8563995badd4afb570537a9df56b70adc476352db48`。

## 3. 开发机现场状态

- Termius 已有 `ituser@itserver` 会话。Docker、containerd、宿主 PostgreSQL 和 Redis 的 systemd 状态均为 active。
- 本次只读目录检查时 `/opt/itsm/releases`、`/opt/itsm/shared` 为空，8088/18088 未监听。尚无本次发布成功记录。
- Docker 容器清单检查受 sudo 认证阻挡，不能因此断言服务器没有其他 ITSM 容器。Termius 曾短暂提示断线，后续操作须重新确认连接。
- 服务器请求 GHCR `/v2/` 返回 HTTP 401，说明 registry 端点可达，不说明私有镜像拉取授权已就绪。
- Mac 直连 SSH 的网络已通，但非交互认证失败；没有擅自安装 SSH key、提取密码或降低 Docker 权限。
- 当前不得宣称开发机已部署、网页已可用、备份恢复或回退已经在该服务器验收。

## 4. GitHub 门禁缺口

GitHub 设置页未列出经典分支保护规则；Rulesets 页明确显示尚无规则，并提示当前私有仓库套餐不强制执行 ruleset。CI 运行成功不等于 main 受强制保护。

后续由仓库管理员选择支持私有仓库强制保护的套餐/组织方案，再配置必须 PR、必要检查、审阅和禁止强推/删除。没有获批前不付费、不迁移归属、不公开代码、不更改访问权限。过渡期间按 PR + CI + 人工核验执行，但应承认其不能替代平台强制门禁。

## 5. 待完成验收

1. 用户在 Termius 直接完成 sudo 认证，重新读取原服务/容器/端口/磁盘和工具版本。
2. 将上述唯一版本发布包和校验文件传到开发机新的版本目录，先校验再解压，不覆盖其他版本。
3. 由用户交互提供仅拉取所需的 GHCR 凭据；与部署使用同一 sudo 身份，不写进命令、聊天或日志。未授权时不自动创建 token。
4. 使用包内配置生成器和发布工具，保持 `itsm-dev` 独立项目、独立命名卷，Web 仅绑定 `127.0.0.1:8088`。所有新下载脚本的 UI 执行按动作时确认。
5. 验证五个服务的健康、运行镜像身份、版本状态、SSH 隧道及员工/工程师业务闭环和权限隔离。原始 CI 工单脚本依赖空库，不盲目在有数据的开发库重复运行。
6. 业务写入后生成备份并执行临时数据库恢复检查，记录备份校验值及结果；后续安排受控异机副本。
7. 第二个兼容版本经过同样测试后验证应用回退，不伪造 previous 状态，不回退业务数据库或删除卷。

真实钉钉免登、OA、通知和语音识别另需权限/配置及联调验收；REQ 保持关闭。监控与配置项关联保留第二期，完整安全事件模块保留第三期。
