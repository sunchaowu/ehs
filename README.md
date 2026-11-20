# EHS 企业应用平台

对话式生成企业应用的内部平台。需求人员在门户的会话里用自然语言描述需求，平台按软件工程方法生成方案和设计，编译成项目服务并在测试区验证，确认后再发布到正式区。系统运行、测试、正式分三套服务器，已知故障由运维智能体按固定动作处理。业务代码问题回到方案确认、在线测试和发布确认的完整链路。

## 功能概览

- **需求会话**：每个用户、每个项目独立会话，只通过固定工具修改共享草稿，模型未配置时明确说明原因
- **方案确认**：一次变更只记录新增、修改、删除，确认前不动已发布版本
- **生成与发布**：确认后编译项目模块、构建不可变镜像并推送私有镜像库，测试未全部通过不能发布
- **分区隔离**：接入区、系统运行区、测试区、正式区之间默认拒绝，节点凭证与双向证书管控
- **账号体系**：Argon2id 密码、服务端会话、初始管理员安装、微信未配置时不显示扫码

## 技术栈

| 层 | 组件 |
|---|---|
| 控制面 | Node.js、TypeScript、Fastify、PostgreSQL 16 |
| 门户 | React 19、Ant Design、Vite |
| 测试 | Vitest（平台自身白盒测试） |
| 运行与发布 | Docker Engine、Distribution `registry:2` |
| 接入 | Caddy 2 |
| 规划组件 | Midscene.js + Playwright（在线测试）、OpenTelemetry + Prometheus + VictoriaLogs + HolmesGPT（运维）、vLLM（本地模型） |

## 仓库结构

```
docs/superpowers/            设计细则、总体计划与各阶段实施记录
platform/
  apps/control-plane/        控制面：账号、会话、草稿、编译、发布、节点协调
  apps/portal/               门户前端
  deploy/                    compose、Caddyfile、环境样例
  scripts/                   开发、安装、部署脚本
```

## 快速开始

```bash
# 启动开发数据库（需要 Docker）
cd platform
docker compose -f deploy/compose.dev.yaml --env-file deploy/.env up -d

# 启动控制面与门户开发服务
bash scripts/dev.sh

# 运行全量测试（需要 DATABASE_SYSTEM_URL，见 deploy/.env）
pnpm test
```

控制面进程只从环境变量 `DATABASE_SYSTEM_URL` 取系统库连接，不在源码里写地址或密码。

## 测试与发布验证

测试与发布验证需要发布到本地局域网 Ubuntu 环境，发布脚本已经配置完成：

```bash
bash platform/scripts/deploy.sh
```

- 脚本读取 `platform/deploy/.env`（部署主机、账号、系统库连接等），上传 `platform/` 后在 Ubuntu 上用 compose 启动系统库、安装初始管理员并构建全量服务。
- 发布链路验证（compose、Caddy、节点安装脚本、镜像库）和依赖 GNU bash 的测试在 Ubuntu 环境完成。
- 开发机本地只跑单元与门户测试；本地临时 PostgreSQL 即可跑控制面测试，不占用正式环境。

## 开发计划与进度

实现原则：先搭骨架，再按阶段补充内容和开源构件。完整设计与阶段核对见
`docs/superpowers/specs/2026-11-05-enterprise-platform-overall-plan.md` 第 8 节。

| 顺序 | 计划 | 状态 | 说明 |
|---|---|---|---|
| 1 | 平台骨架 | ✅ 已完成 | 控制面/门户骨架、健康检查、组件插槽、三区网络隔离 |
| 2 | 账号与系统配置 | ✅ 已完成 | 安装初始管理员、密码登录、微信未配置不显示扫码、管理员配置入口 |
| 3 | 方案与会话 | ✅ 已完成 | 项目编码、共享草稿、会话隔离、授权并集、未发布菜单、门户工作台 |
| 4 | 生成与发布 | ✅ 已完成 | 设计编译、镜像推送、节点安装与证书、代理协调、发布闸门与摘要、发布取消。镜像已内置 `@platform/runtime` 与 `pg`，按 `DATABASE_URL` 持久化；控制面镜像已带 Docker CLI 并挂载宿主套接字，可构建推送；运行库菜单授权已接入，`/p/<编码>` 入口路由已接入（控制面注入身份头，节点网关转发到容器；mTLS 与多副本待补） |
| 5 | 在线测试 | 🟡 白盒已接入 | 案例生成、运行记录与回放、发布门、门户测试卡片已实现；白盒测试由测试节点在候选容器内执行，黑盒 Midscene.js + Playwright 待接入 |
| 6 | OA 内容 | 🟡 模板种子 | OA 菜单、实体、请假流程、角色授权与案例模板，可一键应用到草稿；独立领域运行时尚待补充 |
| 7 | 运维 | ⬜ 未开始 | 目前只有 `slots.ts` 占位（OpenTelemetry、Prometheus、VictoriaLogs、HolmesGPT） |
| 8 | 本地模型 | ⬜ 未开始 | 目前只有模型配置页三个配置键，vLLM 接入未开始 |

**当前进度**：第 1~4 项、插件机制和在线测试编排已完成并部署到局域网 Ubuntu（`172.18.0.31`），相关提交已提交到 `platform-skeleton` 分支。第 5 项已接入测试节点白盒执行，还差黑盒执行器；第 6 项只有 OA 模板种子，第 7、8 项尚未开始。生成镜像已内置 `@platform/runtime` 与 `pg`，可启动并提供健康检查、菜单、实体、流程和表单接口；存在 `DATABASE_URL` 时记录落到项目库，节点代理按本机模板注入连接串。运行库已按 `x-platform-user` / `x-platform-roles` 校验菜单授权（无身份 401、无授权详情 403、角色与用户授权取并集）；记录和流程接口的动作级授权待补齐。项目入口已打通：Caddy 把 `/p/*` 转到控制面，控制面校验登录、项目成员和已发布版本后注入身份头，转发到节点内置网关，节点再按项目编码转到只绑定 `127.0.0.1` 的容器端口；记录见 `docs/superpowers/plans/2026-11-19-project-entry-routing.md`。测试流程为：控制面创建 `test_jobs` 任务并重建测试库，测试节点通过 `/desired` 领取任务，在候选镜像容器内运行白盒入口并回报步骤；黑盒步骤明确失败，发布门保持关闭。测试节点任务和入口路由需要重新部署控制面、重新生成节点安装脚本后生效。控制面镜像已带 Docker CLI 并挂载宿主套接字，可在部署环境构建并推送项目镜像；当前运行实例需重新部署后才生效。门户还没有用户管理与通知页面。2026-11-19 本地核对：`tsc` 通过，门户测试 20 个、运行库与测试节点及入口路由测试 24 个、节点运行测试 5 个全部通过；控制面其余测试需要 PostgreSQL，本机未启动数据库，未执行。

**插件机制**（2026-11-12）：在原「插件配置页显示入口和启停记录」的基础上，参照 DeepSeek Harness cordis 机制完成第一版插件启停、配置校验、启动恢复与启停记录，实现记录见 `docs/superpowers/plans/2026-11-12-plugins.md`。

## 文档

- 行为细则：`docs/superpowers/specs/2026-11-04-enterprise-harness-platform-design.md`
- 总体计划与进度：`docs/superpowers/specs/2026-11-05-enterprise-platform-overall-plan.md`
- 各阶段实施记录：`docs/superpowers/plans/`
