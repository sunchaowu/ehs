# 在线测试实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-17 17:30:00 +0800 |
| 状态 | 编排已实现，真实执行器待接入 |
| 范围 | 总体计划第 5 项「在线测试」 |
| 源码提交 | `b835786`（stage-5 源码随该提交进入仓库） |
| 部署验证 | 已随平台部署到局域网 Ubuntu（`172.18.0.31`） |

## 已实现

### 案例生成与校验（`test-cases.ts`）

- 每个实体生成黑盒「新增」案例：打开表单、逐字段填值、提交；遇到 `ref` 字段时递归生成前置实体的创建步骤，并用 `dependsOn` 指向前置提交步骤。
- 每个实体生成白盒「创建接口返回记录」和「字段校验拒绝非法输入」案例。
- 每个流程生成白盒「流程迁移」和黑盒「流程走查」案例，步骤来自流程定义。
- 每个菜单生成白盒「未授权访问被拒绝」案例。
- 用户案例经 `normalizeUserCase` 校验方法、名称和步骤，案例编码由内容和步骤哈希生成，重复导入保持稳定。

### 运行与记录（`test-runs.ts`）

- 运行前要求：存在候选镜像、`test.nodePool` 非空、`database.testAdminUrl` 已配置。
- 每次完整运行会重建 `tst_` 前缀的测试库，避免上一轮数据影响结果。
- `test_runs` 记录 `running`/`passed`/`failed` 状态和失败原因；`test_step_records` 记录案例、方法、步骤、定位方式、输入、期望、实际和失败原因。
- 失败案例可回放：沿用原步骤，针对当前候选镜像重新执行并记录新的运行。

### 发布门（`test-gate.ts`）

- 取同一项目、同一镜像摘要最近一次 `passed`/`failed` 运行。
- 没有运行记录或最近一次失败时门保持关闭；失败时返回失败案例名单。
- `publish.ts` 与 `releases.ts` 均已接入；配置 `test.requirePassBeforePublish` 默认 `true`。

### 接口与门户

- `GET /api/projects/:code/tests`：查看案例与运行历史
- `POST /api/projects/:code/tests`：运行测试
- `GET /api/projects/:code/tests/runs/:runId`：查看运行步骤
- `POST /api/projects/:code/tests/runs/:runId/replay`：回放失败运行
- 门户 `TestResultsCard` 提供运行、查看步骤和回放入口。

### 配置项与数据表

- 配置：`test.nodePool`、`test.requirePassBeforePublish`、`test.stepTimeoutSeconds`、`test.runTimeoutSeconds`
- 数据表：`test_cases`、`test_runs`、`test_step_records`

## 未实现（当前边界）

- **真实执行器**：`defaultTestExecutor()` 明确返回「测试执行器未配置：Midscene.js 与 Vitest 白盒入口在测试区接入」，不会生成虚假通过记录。执行器通过 `buildServer({ testExecutor })` 注入。
- **黑盒执行**：Midscene.js + Playwright 的定位策略（稳定标识 → 角色与可访问名称 → 上次成功定位记录）、截图、超时和模型调用尚未实现。
- **白盒执行**：在测试区启动容器执行 `call`/`validate`/`migrate` 步骤的 Vitest 入口尚未实现。
- **节点调度**：目前只校验测试节点池非空，执行器如何落到具体节点尚未实现。
- **门户案例编辑**：用户案例目前通过接口或草稿写入，门户暂无编辑界面。

## 验证记录

- 2026-11-12 生产库中存在一条测试运行，状态 `failed`，原因正是「测试执行器未配置」，说明运行创建、失败原因记录和发布门闭合逻辑按设计工作。
- 2026-11-17 部署后 `GET /api/projects/:code/tests` 返回 401（未登录），路由存在。
- 2026-11-17 本地 `tsc` 通过，门户测试 19 个通过；`online-testing.test.ts` 与 `oa-template.test.ts` 属于 node 项目，需要 PostgreSQL，本机未启动数据库，未执行。

## 代码位置

- `platform/apps/control-plane/src/test-cases.ts`
- `platform/apps/control-plane/src/test-executor.ts`
- `platform/apps/control-plane/src/test-runs.ts`
- `platform/apps/control-plane/src/test-gate.ts`
- `platform/apps/control-plane/src/publish.ts`
- `platform/apps/control-plane/src/releases.ts`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/control-plane/test/online-testing.test.ts`
