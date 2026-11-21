# 模型配置下发实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-20 16:55:00 +0800 |
| 状态 | 已实现：模型配置贯通至节点测试 runner payload |
| 范围 | P0.5 后续：模型配置下发（黑盒视觉定位前提） |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 91/91 通过；门户 26/26 通过；根与门户 tsc 通过 |

## 背景

黑盒执行器（Midscene.js + Playwright，尚未接入）需要视觉定位模型，配置来自系统配置 `model.baseUrl` / `model.name` / `model.apiKey`。同步执行路径已通过 `TestRunPreparation` 拿到这三个字段并交给 `TestExecutor`，但异步节点路径在 `enqueueNodeJob` → `test_jobs` → `claimTestJobs` → 节点代理 runner payload 这一段把它们丢了：

- `test_jobs` 没有列保存模型配置；
- `NodeTestJob` 与领取结果没有模型字段，节点代理构造 runner payload 时只写 `cases` 与 `stepTimeoutSeconds`；
- 黑盒失败原因固定为「黑盒执行器未配置」，无法反映模型配置是否已下发。

本次让模型配置沿异步链路贯通到测试容器内的 runner，失败原因按配置是否就绪给出更具体的提示，为后续黑盒执行器接入打通前提。

## 已实现

### 1. `src/schema.sql`

`test_jobs` 增加三列（幂等迁移，默认空串）：`model_base_url`、`model_name`、`model_api_key`。

### 2. `src/node-tests.ts`

- `NodeTestJob` 与 `StoredJobRow` 增加 `modelBaseUrl` / `modelName` / `modelApiKey`（库内为 snake_case 对应列）。
- `enqueueNodeJob` 把 `prepared.modelBaseUrl` / `modelName` / `modelApiKey` 写入 `test_jobs` 新增三列。
- `claimTestJobs` 的 `returning` 与行映射补齐三字段，节点领取任务时拿到模型配置。

### 3. `src/node-agent-template.mjs`

runner payload 从原来的 `{ cases, stepTimeoutSeconds }` 扩展为同时带 `runTimeoutSeconds` 与模型三字段，随任务写入 `/tmp/platform-test-payload.json` 并复制进测试容器。

### 4. `src/test-runner.mjs`

- `runWhiteBoxCases` 读取 `modelBaseUrl` / `modelName` / `modelApiKey`，三要素齐全时黑盒失败原因为「黑盒执行器未配置：模型已就绪，Midscene.js 与 Playwright 待接入」，否则为「黑盒执行器未配置：…（视觉定位模型未下发）」。两种原因都保留「黑盒执行器未配置」前缀，兼容既有断言。
- `main` 把 payload 中的模型字段传给 `runWhiteBoxCases`。

模型配置只用于生成更具体的失败原因与后续黑盒接入，不写日志、不回传控制面。`model.apiKey` 经 Bearer 认证的 `/desired` 下发到受信任节点，与同步执行路径一致。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json`：通过；`pnpm exec tsc --noEmit -p apps/portal/tsconfig.json`：通过。
- `node-agent.test.mjs`：12/12 通过。新增两条覆盖：runner payload 含 `runTimeoutSeconds` 与模型三字段；黑盒失败原因随模型配置是否就绪变化。
- `online-testing.test.ts`：异步回放用例注入系统配置 `model.*`，断言 `test_jobs` 落库保存模型配置，且 `claimTestJobs` 返回值带回模型字段。
- 控制面全套在局域网容器内以 `platform_test` 执行：33 个文件、91 个用例全部通过。
- 门户 `App.test.tsx`：26/26 通过。
- 测试前重建独立库，不触碰正式库 `platform`。

## 未实现（当前边界）

- 黑盒执行器仍未实现；模型配置只贯通到 runner payload 并在失败原因中体现，尚未真正用于视觉定位。
- 未做模型连通性探测或 API Key 有效性校验。
- runner payload 中 `modelApiKey` 以明文临时文件存在于测试节点，依赖节点信任边界；文件在任务结束后删除，与既有临时载荷处理一致。

## 代码位置

- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/control-plane/src/node-tests.ts`
- `platform/apps/control-plane/src/node-agent-template.mjs`
- `platform/apps/control-plane/src/test-runner.mjs`
- `platform/apps/control-plane/test/node-agent.test.mjs`
- `platform/apps/control-plane/test/online-testing.test.ts`
- 本文档：`docs/superpowers/plans/2026-11-20-model-config-downlink.md`
