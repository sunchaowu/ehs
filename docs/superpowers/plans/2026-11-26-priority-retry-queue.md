# 优先级与重试队列实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-26 17:20:00 +0800 |
| 状态 | 已实现：任务优先级、基础设施失败自动重试、超时重新入队 |
| 范围 | P0.5 后续：调度优先级 + 重试队列 |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 93/93 通过；门户 27/27 通过；根与门户 tsc 通过 |

## 背景

此前 `test_jobs` 只有先进先出的 `pending` 队列，任务一旦失败（镜像拉取、容器启动、节点超时）就直接把整次运行判失败，只能人工回放。本次加入任务优先级与自动重试：人工回放优先于全量新跑；镜像/容器/节点类基础设施失败自动重新入队，断言失败作为测试结论不重试。

## 已实现

### 1. `src/schema.sql`

`test_jobs` 增加两列（幂等迁移）：`priority integer default 0`（越大越先领取）、`max_attempts integer default 2`（总执行次数上限）。

### 2. `src/system-config.ts`

新增配置 `test.maxAttempts`（默认 2，即首次 + 1 次重试）。入队时把该值快照到 `test_jobs.max_attempts`，之后改配置不影响已排队任务；`install.ts` 的 `saveConfigDefaults` 会在发布时补齐该键。

### 3. `src/node-tests.ts`

- 入队：`enqueueNodeJob` 增加 `priority` 参数，写入 `priority` 与 `max_attempts`；普通运行优先级 0，异步回放优先级 10（人工针对性重跑越过全量新跑）。
- 领取：`claimTestJobs` 按 `priority desc, created_at, id` 排序，`limit` 内优先高优先级任务。
- 回报：
  - 只带 `log` 的片段仍只追加日志；
  - 任务被重新入队后，上一次尝试的迟到终态回报返回 409（`job.status !== 'running'`）；
  - 基础设施失败（`reason`）且 `attempt < max_attempts` 时，把任务重置为 `pending`、清空 `claimed_at`/`failure`，并写入「第 N/M 次执行失败，已按优先级重新入队」日志；运行保持 `running`；
  - 断言失败（`outcomes` 含未通过步骤）不重试，直接完成运行并按步骤判定失败。
- 门户排障视图 `listRunJobs` 增加 `priority` / `maxAttempts`。

### 4. `src/test-runs.ts`

`expireStaleTestJobs` 改为两段：仍在重试次数内的超时任务重置为 `pending`（保留原优先级、清空领取时间、写「执行超时，已按优先级重新入队」日志），不结束运行；重试次数用尽的任务标记 `done` 并结束运行（失败原因仍为「测试节点未在时限内回报」）。

### 5. 门户 `apps/portal/src/App.tsx`

任务日志视图把「领取次数」改为「执行 N/M 次」，并在优先级大于 0 时显示「优先级 10」标签。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json` 与 `apps/portal/tsconfig.json`：通过。
- `online-testing.test.ts` 新增「claims by priority and requeues stale attempts until exhausted」：
  - 两个排队任务中高优先级先被领取（`limit=1` 两次领取验证真实次序，规避 `UPDATE ... RETURNING` 不保证顺序）；
  - 超时任务在重试次数内重新入队并被再次领取（attempt 2），运行保持 running；
  - 断言失败不重试，任务 `done`、attempt 保持 1、运行 failed；
  - 重试耗尽后超时任务与运行一起失败，日志含「重试次数用尽」。
- 既有调度可观测性用例扩展为「基础设施失败 → 重新入队 → 第 2 次失败 → 终态」，并断言 `maxAttempts` / `priority` 字段。
- `system-config.test.ts` 补 `test.maxAttempts` 默认值断言。
- `node-agent.test.mjs` 12/12；门户 `App.test.tsx` 27/27（任务日志用例更新为「执行 2/2 次」「优先级 10」）。
- 控制面全套在局域网容器内以 `platform_test` 执行：33 个文件、93 个用例全部通过；测试前重建独立库，不触碰正式库 `platform`。

## 部署顺序修复

首次发布后发现：`scripts/deploy.sh` 的「安装初始管理员」步骤在 `control-plane` 镜像重建之前运行，而 `install.ts` 是唯一执行 schema 迁移的入口，导致生产库拿到的是上一次发布的旧代码迁移结果（`priority` / `max_attempts` / `test.maxAttempts` 缺失）。已在安装步骤前加入 `docker compose build control-plane`，保证迁移使用本次代码。

## 当前边界

- 重试仍回到原任务绑定的节点；若该节点持续不可用，重试会在次数用尽后失败。跨节点转移未实现。
- 只对基础设施失败与超时重试；断言失败需人工「回放」（回放优先级 10）。
- 没有死信队列与退避（backoff），重试在下一轮领取时立即执行。
- 优先级目前只有 0（普通）与 10（回放）两档，没有开放给用户自定义。
- 黑盒执行器仍未实现（见 `2026-11-20-test-executor-gaps.md`）。

## 代码位置

- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/control-plane/src/system-config.ts`
- `platform/apps/control-plane/src/node-tests.ts`
- `platform/apps/control-plane/src/test-runs.ts`
- `platform/apps/control-plane/test/online-testing.test.ts`
- `platform/apps/control-plane/test/system-config.test.ts`
- `platform/apps/control-plane/test/node-agent.test.mjs`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/portal/src/App.test.tsx`
- 本文档：`docs/superpowers/plans/2026-11-26-priority-retry-queue.md`
