# 在线测试实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-12 09:30:00 +0800 |
| 状态 | 已完成，随本次提交 |
| 行为细则 | `docs/superpowers/specs/2026-11-05-enterprise-platform-overall-plan.md` 第 5 节、`docs/superpowers/specs/2026-11-04-enterprise-harness-platform-design.md` 第 8 节 |
| 核对 | 2026-11-12 16:44:00 本地全量测试 23 个文件、57 个测试全部通过（Node 22.14.0 + PostgreSQL 16.15） |

本阶段覆盖设计案例生成、测试案例与记录存储、测试运行编排、测试记录回放、发布门接入、会话工具 `run_tests` / `replay_test`、门户测试结果页。

## 已实现行为

- 编译设计时生成自动案例，案例编码由方法和步骤内容稳定生成（`case-` + 内容摘要），不含时间与随机数。同一设计重复编译，自动案例相同、编码相同。设计修订后按新设计重新生成自动案例；用户用 `add_test_case` 追加的案例保留，直到用户删除。
- 自动案例按字段类型写入默认值并保存到案例中：`text`、`longText` 为字段名加「示例」，`number` 为 1，`boolean` 为真，`date` 为 `2000-01-01`，`datetime` 为 `2000-01-01T00:00:00`，`user` 使用本案例指定角色下的测试用户，`ref` 写明依赖的前序步骤（前序步骤创建的记录）。
- 通用自动案例：每个实体生成「新增{实体}」黑盒案例与「{实体} 字段校验」白盒案例，每个流程生成「{流程} 流程迁移」白盒案例，每个菜单生成「{菜单} 未授权访问被拒绝」白盒案例。OA 领域包的五类行业案例随第 6 阶段生成。
- `test.nodePool` 为空时测试不开始并说明原因，不使用正式节点池。候选镜像尚不存在时拒绝并说明原因。`database.testAdminUrl` 未配置时拒绝并说明原因。每次运行前重建 `tst_` 加项目编码的测试库（先删后建，PG 16 `DROP DATABASE ... WITH (FORCE)`），测试库与正式库、系统库分开。
- 测试运行创建 `test_runs` 记录，逐步写入 `test_step_records`：开始时间（精确到秒）、案例编码、案例名、步骤序号、方法、候选镜像摘要、定位方式、输入、期望、实际结果、通过或失败、原因。一次运行给出总结果（`passed` / `failed`）。
- `replay_test` 按指定记录的步骤对当前候选重新执行，结果写成一条新记录，注明被回放的原记录（`replayed_from`）和原镜像摘要（`replayed_from_digest`）；当前没有候选镜像时拒绝并说明原因；记录不属于该项目时拒绝并说明原因。
- 发布确认接入真实测试门：`test.requirePassBeforePublish` 为真时，查询当前候选镜像最近一次运行；没有一次全部通过的记录就拒绝确认，并列出失败案例名单。`test.requirePassBeforePublish` 为假时跳过测试门。
- 会话工具 `run_tests`、`replay_test` 接入真实实现，行为与门户接口一致。`add_test_case` 校验方法只允许 `black-box` / `white-box`。
- `GET /api/projects/:code/tests`、`POST /api/projects/:code/tests`、`GET /api/projects/:code/tests/runs/:runId`、`POST /api/projects/:code/tests/runs/:runId/replay`：查看需项目成员，触发运行与回放需项目管理员。
- 门户项目页新增「测试结果」：按案例列出黑盒或白盒、通过或失败、开始时间和失败步骤，可以运行测试、回放任一条记录。发布确认摘要列出失败案例名单。可交互元素带稳定标识 `platform/test-results/{页面}/{元素}`。

## 边界（本阶段之外）

- **真实执行组件未接入**。白盒 Vitest 入口位于候选模块的测试容器内（`runtime.mode=test` 时开放），黑盒由 Midscene.js 通过 Playwright 操作门户并调用模型配置里的多模态模型完成视觉定位；两者都需要测试区节点侧运行器和稳定标识的运行时页面，平台侧只负责编排、记录和闸门。本阶段 `TestExecutor` 以依赖注入形式接入：默认实现为「测试执行器未配置」并以 409 明确说明原因，不产生假的通过记录；Ubuntu 环境验证时在 `buildServer({ testExecutor })` 处接入真实执行器。
- 黑盒定位顺序（稳定标识 → 角色+可访问名称 → 上次成功定位记录）由测试区执行器实现，平台把每步定位方式写入记录；回放重新定位，不使用屏幕坐标点击，时限读取 `test.stepTimeoutSeconds`、总时限读取 `test.runTimeoutSeconds`。
- 测试容器仅在 `runtime.mode=test` 时开放白盒入口；正式区期望状态不设置该变量，正式区不接收测试容器（部署侧保证）。
- OA 领域包的五类在线测试案例随第 6 阶段 OA 内容生成。
- 手工操作录制为黑盒记录（拥有在线测试权限的用户在测试环境手工操作）随测试区执行器一起接入。

## 数据表

- `test_cases`：案例。`origin` 为 `auto` 或 `user`，`code` 全局按内容稳定生成，`steps` 为有序步骤 JSON。
- `test_runs`：一次运行。`image_digest` 为候选镜像摘要，`status` 为 `running` / `passed` / `failed`，`replayed_from` 与 `replayed_from_digest` 注明回放来源。
- `test_step_records`：步骤记录，关联 `test_runs`，通过 `started_at`、`locator`、`input`、`expected`、`actual`、`passed`、`reason` 还原每一步。

## 代码位置

- `platform/apps/control-plane/src/test-cases.ts`
- `platform/apps/control-plane/src/test-executor.ts`
- `platform/apps/control-plane/src/test-runs.ts`
- `platform/apps/control-plane/src/publish.ts`（测试库重建 `rebuildPostgresDatabase`、发布门）
- `platform/apps/control-plane/src/designs.ts`（编译时生成自动案例）
- `platform/apps/control-plane/src/drafts.ts`（`run_tests` / `replay_test` 工具）
- `platform/apps/control-plane/src/releases.ts`（发布确认页测试结果）
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/control-plane/test/online-testing.test.ts`

## 测试与验证

- 2026-11-12 16:44:00 全量测试 23 个文件、57 个测试全部通过。本机无 Docker/Node/PostgreSQL 预装环境，Node 22.14.0 与从 Ubuntu 软件源提取的 PostgreSQL 16.15（免安装副本）在用户目录就绪后跑通控制面测试；门户测试需要 `apps/portal` 单独 `pnpm install`（门户不是 pnpm workspace 成员）。
- 新增 `apps/control-plane/test/online-testing.test.ts`：自动案例稳定性与默认值、用户案例校验、确认后生成案例、空测试池 409、运行后逐步记录、发布门放行、回放注明原记录与原镜像摘要、失败案例名单回流到发布确认。
- `deploy-script.test.ts` 在本机同样通过（依赖 GNU bash）。
- Ubuntu 环境验证：发布链路（compose、Caddy、节点安装脚本、镜像库）与真实执行组件接入后的黑盒/白盒执行。

## 附注

- 顺带修复一处既有缺陷：`provisionPostgresDatabase` 与测试库重建的库名校验只接受 `[a-z0-9_]`，会拒绝包含连字符的项目库名（`prd_请假审批` 这类由项目编码生成的库名带连字符）；校验已放宽到 `[a-z0-9_-]`，库名仍由我们生成并用双引号拼接，不引入注入风险。
- 回放记录非 UUID 编码或记录不属于该项目时，返回 `没有这条测试记录`（404），与既有行为保持一致。
