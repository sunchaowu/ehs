# 调度可观测性实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-23 17:10:00 +0800 |
| 状态 | 已实现：任务领取计数、节点实时日志回报、门户任务日志视图 |
| 范围 | P0.5 后续：调度可观测性（排障优先，暂不做优先级与重试队列） |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 92/92 通过；门户 27/27 通过；根与门户 tsc 通过 |

## 背景

异步测试任务失败时只有一个 `failure` 字符串，看不到任务在节点上执行到哪一步、是否被重复领取；节点代理拉镜像、起容器、健康检查、注入载荷、执行入口各阶段的状态全部丢失，排障只能登录节点翻容器。本次给 `test_jobs` 补上领取计数与日志，节点执行各阶段实时回报日志片段，门户按运行查看任务日志。

## 已实现

### 1. `src/schema.sql`

`test_jobs` 增加两列（幂等迁移）：`attempt integer default 0`（领取次数）、`log text default ''`（累积日志）。

### 2. `src/node-tests.ts`

- `claimTestJobs` 领取时 `attempt = attempt + 1` 并随任务返回；`NodeTestJob` 增加 `attempt`。
- `acceptTestJobReport` 接受 `log` 字段：
  - 只带 `log` 的回报是执行中的实时片段——追加日志、不改任务状态；
  - 终态回报（`outcomes` / `reason`）可同时携带最后一段日志；
  - 已结束（done）的任务仍统一 409。
- 日志上限：单片段截断 16 KB，整条日志保留末尾 64 KB（`right(log || chunk, 65536)`），防止失控输出撑爆系统库。
- 新增 `listRunJobs(database, projectId, runId)`：校验运行归属后返回任务的节点、状态、领取次数、失败原因、日志与时间戳。

### 3. `src/server.ts`

- `POST /api/nodes/:name/tests/:jobId` 载荷透传 `log`。
- 新增 `GET /api/projects/:code/tests/runs/:runId/jobs`（项目成员登录可见；未登录 401，运行不存在或不属于该项目 404）。

### 4. `src/node-agent-template.mjs`

`runTestJob` 新增 `note()`：向回报接口发送带 ISO 时间戳的日志片段，尽力而为（失败不重试、不影响测试执行）。覆盖阶段：开始拉取镜像 → 拉取完成 → 容器已启动 → 健康检查通过 → 载荷注入并开始执行 → 执行结束（退出码）→ stderr 尾部（如有，截 2 KB）。日志不包含模型 API Key 等载荷内容。

### 5. 门户 `apps/portal/src/App.tsx`

测试结果卡每条运行新增「任务日志」按钮（`platform/test-results/jobs-<runId>`）：展开显示该运行的节点任务列表——节点名、状态（等待领取/执行中/完成/失败）、领取次数、领取时间、失败原因与日志 `<pre>`（`platform/test-results/job-log-<jobId>`，最大高度滚动）；再点收起。同步执行的运行显示「没有节点任务」。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json` 与 `apps/portal/tsconfig.json`：通过。
- `node-agent.test.mjs`：12/12。既有断言改为按内容查找终态回报（首个回报现在是日志片段）；新增断言：至少 4 条日志片段、日志回报不带终态字段、包含拉取完成与执行结束阶段。
- `online-testing.test.ts`：新增「records job attempts and live logs for troubleshooting」端到端用例，覆盖 pending 期间追加不改状态、领取计数、超长片段截断、终态携带日志、done 后 409、GET jobs 权限（401/404）；既有异步回放用例补 `attempt: 1` 断言。
- 门户 `App.test.tsx`：27/27（新增任务日志展开/收起用例）。
- 控制面全套在局域网容器内以 `platform_test` 执行：33 个文件、92 个用例全部通过；测试前重建独立库，不触碰正式库 `platform`。

## 未实现（当前边界）

- 优先级与重试队列：`attempt` 已为重试打基础，但失败任务仍不会自动或手动重试。
- 日志是阶段级片段，不是容器 stdout 的逐行流；执行中（`docker exec` 阻塞期间）没有中间输出。
- 门户日志不自动轮询，需手动点击「任务日志」刷新。
- 黑盒执行器仍未实现（见 `2026-11-20-test-executor-gaps.md`）。

## 代码位置

- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/control-plane/src/node-tests.ts`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/src/node-agent-template.mjs`
- `platform/apps/control-plane/test/node-agent.test.mjs`
- `platform/apps/control-plane/test/online-testing.test.ts`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/portal/src/App.test.tsx`
- 本文档：`docs/superpowers/plans/2026-11-23-job-observability.md`
