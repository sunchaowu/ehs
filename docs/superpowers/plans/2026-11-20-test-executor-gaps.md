# 真实测试执行器缺口核对与修复记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-20 15:02:45 +0800 |
| 状态 | 已核对 P0.5 缺口，修复两处白盒/回放缺陷 |
| 范围 | 在线测试执行器链路盘点 + 可执行缺陷修复；黑盒执行器未实现 |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 87/87 通过 |

## 背景

P0.5 的目标是「真实测试执行器」。为确定剩余工作量，对控制面下发、节点代理执行、门户展示与规格要求做了完整盘点，发现链路主体已经可用（白盒 HTTP 断言、测试库重建、节点原子领取、发布门、门户轮询），但黑盒执行器缺失，另有两个可立即修复的缺陷。

## 已修复缺陷

### 1. 自动流程迁移案例 target 与白盒执行器不匹配

- `src/test-cases.ts` 自动生成 `migrate` 步骤时使用 `<项目>/<流程>/<步骤>`，而 `src/test-runner.mjs:71-78` 只接受 `<项目>/workflows/<流程>/<步骤>`；自动生成的流程迁移案例必然落入「白盒步骤不受支持」失败分支。
- 已改为生成 `<项目>/workflows/<流程>/<步骤>`，并在 `test/online-testing.test.ts` 断言目标格式。

### 2. 异步回放丢失来源元数据

- `src/node-tests.ts` 的 `acceptTestJobReport` 调用 `completeTestRun` 时把 `replayedFrom` / `replayedFromDigest` 写死为 `null`；异步回放的 `test_runs` 不再记录回放来源，与同步回放行为不一致。
- 已给 `test_jobs` 增加 `replayed_from` / `replayed_from_digest` 列（`schema.sql` 用 `add column if not exists` 迁移），下发时写入 `TestRunPreparation` 的来源，回报时透传给 `completeTestRun`。
- 新增 `test/online-testing.test.ts` 用例，覆盖「创建原始 run → 异步回放 202 → 节点领取 job → Bearer 回报 → `test_runs` 保留来源且状态为 passed」的端到端链路。

## 现状盘点

### 已实现

- **控制面**：案例生成与用户案例校验、每次重建 `tst_<code>` 测试库、测试节点池校验、候选镜像摘要、运行/步骤/任务落库、`/desired` 原子领取（每轮上限 2）、回报幂等（done 返回 409）、超时标记失败、发布门 `test.requirePassBeforePublish`。
- **节点代理**：按 `test.nodePool` 选择 running job 最少的已注册节点；detached 子进程拉候选镜像、注入 `DATABASE_URL` / `DATABASE_NAME`、`docker cp` runner 与 payload、`docker exec` 执行、解析最后一行 JSON 回报、网络回报重试 3 次、容器与临时文件清理。
- **白盒**：`call`（创建记录）、`validate`（字段校验拒绝）、`migrate`（流程迁移）、`call /menus`（未授权访问 403）四类 HTTP 断言，HTTP 级测试而非 Vitest。
- **门户**：测试结果卡、每 3 秒轮询运行中的 run、按案例聚合失败步骤、失败回放。

### 部分实现

- **回放**：同步路径保留来源与来源摘要；异步路径在本次修复后同样保留。
- **定位记录**：`TestStepOutcome.locator` 契约存在，但白盒写入的是 `step.target`，没有真正的元素定位信息。
- **安全**：节点仍为 HTTP + Bearer；安装脚本签发的客户端证书只落盘，mTLS 服务端校验未接入。
- **发布门**：只有结果展示，门户尚不能在测试未通过时禁用发布按钮（后端 409 + `failedCases` 已具备）。

### 未实现

1. **黑盒执行器**：Midscene.js + Playwright 未安装（`package.json` / lockfile 无依赖，`slots.ts` 中 `attached:false`）；`test-runner.mjs:126-134` 对每个非白盒步骤直接产出 `passed:false` + `reason:"黑盒执行器未配置：Midscene.js 与 Playwright 待接入"`。
2. **视觉定位链**：稳定标识 → 角色与可访问名称 → 上次成功定位 → 视觉回退的三级策略、`openai-chat` 模型调用、不能看图时说明原因、禁止坐标点击，均未实现。
3. **模型配置下发**：`TestRunPreparation` 与 `test-executor.ts` 传递 `modelBaseUrl/modelName/modelApiKey`，但 `NodeTestJob`、`/desired` 的 tests 载荷与 runner payload 都没有这些字段，视觉定位所需配置到不了节点。
4. **测试报告**：Midscene HTML 报告、截图、步骤证据未产出也未留在测试区。
5. **单步超时**：规格要求定位超时失败并记录已尝试的定位方式；当前只有 fetch 超时与容器 exec 硬超时。
6. **手工录制**：手工操作录制成可回放黑盒记录未实现；门户也无用户案例编辑界面。
7. **调度增强**：优先级、任务重试队列、实时日志未实现（`test_jobs` 无 priority/attempt/log 字段）。
8. **Vitest 白盒入口**：规格中的 Vitest 入口未实现，当前是内置 HTTP runner。

### 黑盒对发布门的实际影响

`test-cases.ts` 对每个实体都会生成黑盒「新增」案例，而黑盒步骤必然失败，因此任何含实体的项目都无法满足 `test.requirePassBeforePublish`，发布门事实上长期关闭。这与既有实施记录中的判断一致。

## 下一步建议（按投入与收益排序）

1. **模型配置下发**（小）：把 `modelBaseUrl/modelName/modelApiKey` 加入 `NodeTestJob`、job 表与 runner payload，为视觉定位打通前提；同时可让黑盒失败原因更具体。
2. **调度可观测性**（中）：`test_jobs` 增加 attempt/log，节点回报实时日志片段；先解决排障困难，再谈优先级与重试队列。
3. **黑盒第一版**（大）：确认候选镜像内可执行 Playwright/Chrome 后在 runner 实现 `open/fill/click/advance` 与三级定位；需同步改造镜像模板、依赖与模型配置下发，并补 HTML 报告落盘。
4. **门户案例编辑与发布禁用**（中）：补用户案例编辑 UI，并在未通过测试时禁用发布按钮（后端 409 已就绪）。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json`：通过。
- 控制面新增/扩充用例：`online-testing.test.ts` 5/5 通过（含自动案例 target 格式断言与异步回放元数据用例）。
- 控制面全套测试在局域网容器内以 `platform_test` 执行：32 个文件、87 个用例全部通过。
- 测试前重建独立库，不触碰正式库 `platform`。

## 代码位置

- `platform/apps/control-plane/src/test-cases.ts`
- `platform/apps/control-plane/src/node-tests.ts`
- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/control-plane/test/online-testing.test.ts`
- 本文档：`docs/superpowers/plans/2026-11-20-test-executor-gaps.md`
