# 真实测试执行器缺口核对与修复记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-21 03:20 +0800 |
| 状态 | 已核对并修复 P0.5 缺口；模型配置下发、调度可观测性、完整黑盒执行器均已实现 |
| 范围 | 在线测试执行器链路盘点 + 可执行缺陷修复；黑盒执行器第一版完成 |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 138/138 通过；浏览器镜像内 Playwright/Chromium 与 Midscene 均验证可用 |

## 背景

P0.5 的目标是「真实测试执行器」。早期盘点发现链路主体可用（白盒 HTTP 断言、测试库重建、节点原子领取、发布门、门户轮询），但黑盒执行器缺失，另有两个可立即修复的缺陷。本轮已完成全部三项主要缺口：模型配置下发、调度可观测性与黑盒第一版。

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
- **黑盒执行器第一版**（本轮完成）：
  - 动作：`open`（打开运行库页面）、`fill`（填字段）、`click`（点按钮）、`advance`（流程步骤迁移）四类 Playwright 操作。
  - 候选镜像内置系统 Chromium、Playwright、`@playwright/test`（Midscene peer 依赖）与 `@midscene/web`；`/opt/test-harness` 独立目录，不影响运行库启动。
  - 运行库页面增加与步骤 target 一致的 `data-testid` 稳定标识，并提供流程页面 `/p/<code>/workflows/<流程>`。
  - 四级定位链：稳定标识 → 角色+可访问名称 → 上次成功定位缓存 → 模型视觉定位。模型视觉定位优先交给 Midscene `aiAct` 直接完成动作，失败时回退到 openai-chat 截图直连，只接受 CSS 选择器，**禁止坐标点击**；模型返回坐标或无法看图时给出明确失败原因。
  - Midscene 模型配置通过容器环境变量下发：`MIDSCENE_MODEL_BASE_URL` / `NAME` / `API_KEY` / `PROTOCOL=openai-chat` / `FAMILY`（默认 `qwen2.5-vl`，可覆盖）。注意 `openai-chat` 是协议，不是合法 family。`model.apiKey` 只进容器进程环境变量，不写日志或门户响应。
  - HTML 步骤报告与截图在容器内生成，由节点代理 `docker cp` 回测试区目录留存；报告含定位方式、结果、失败原因和截图链接。
  - 节点代理回报的 `log` 记录报告目录；门户「查看日志」可见。

### 部分实现

- **调度可观测性（已实现第一版）**：`test_jobs` 新增 `attempt/log` 列；节点领取任务时 `attempt` 自增；节点通过 `POST /api/nodes/:name/tests/:jobId/log` 实时回报日志片段，终态回报也带完整日志；项目成员通过 `GET /api/projects/:code/tests/runs/:runId/jobs` 查看任务状态与日志，门户测试结果卡提供「查看日志」入口。优先级与重试队列仍未实现。
- **模型配置下发（已修复）**：`test_jobs` 新增 `model_base_url/model_name/model_api_key` 列；`NodeTestJob` 与 `/desired` 的 tests 载荷携带模型配置；节点代理写入 runner payload 时带上同样字段。
- **回放**：同步路径保留来源与来源摘要；异步路径在本次修复后同样保留。
- **定位记录**：黑盒步骤写入实际定位方式（`stable:` / `role:` / `css:` / `midscene:aiAct`），白盒仍写入 `step.target`。
- **安全**：节点仍为 HTTP + Bearer；安装脚本签发的客户端证书只落盘，mTLS 服务端校验未接入。
- **发布门**：只有结果展示，门户尚不能在测试未通过时禁用发布按钮（后端 409 + `failedCases` 已具备）。

### 未实现

1. ~~**黑盒执行器**~~：已实现第一版，见「已实现」。
2. ~~**视觉定位链**~~：已实现四级定位与明确失败原因，禁止坐标点击，见「已实现」。
3. ~~**模型配置下发**~~：已修复，见「部分实现」。
4. ~~**测试报告**~~：已实现 HTML 报告 + 截图 + 步骤证据，并留存测试区。
5. **单步超时**：规格要求定位超时失败并记录已尝试的定位方式；当前有 fetch 超时、浏览器默认超时与容器 exec 硬超时，但没有按定位级别单独设超时。
6. **手工录制**：手工操作录制成可回放黑盒记录未实现；门户也无用户案例编辑界面。
7. **调度增强**：实时日志已实现（见「部分实现」）；优先级与任务重试队列仍未实现（`test_jobs` 无 priority 字段）。
8. **Vitest 白盒入口**：规格中的 Vitest 入口未实现，当前是内置 HTTP runner。

### 黑盒对发布门的实际影响

早期每个实体都会生成黑盒「新增」案例，而黑盒步骤必然失败，导致任何含实体的项目发布门长期关闭。黑盒第一版完成后该阻塞已解除；在镜像与模型可用时，自动生成的黑盒案例可以真正通过。

## 下一步建议（按投入与收益排序）

1. ~~**模型配置下发**（小）~~：已完成。
2. ~~**调度可观测性**（中）~~：已完成第一版。
3. ~~**黑盒第一版**（大）~~：已完成，镜像、依赖、模型配置、四级定位、HTML 报告均落地并验证。
4. **门户案例编辑与发布禁用**（中）：补用户案例编辑 UI，并在未通过测试时禁用发布按钮（后端 409 已就绪）。
5. **单步超时与定位重试**（中）：按定位级别设超时，并区分可重试的模型抖动与确定性失败。
6. **调度增强**（中）：优先级字段与失败重试队列。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json`：通过。
- 控制面全套测试在局域网容器内以 `platform_test` 执行：34 个文件、138 个用例全部通过。
  - `node-agent.test.mjs` 22/22：含白盒映射、runner payload 模型配置、黑盒四级定位、Midscene `aiAct` 包装、禁止坐标点击、HTML 报告、浏览器 bootstrap 与密钥不落日志。
  - `runtime.test.mjs` 5/5：含稳定标识、流程页面、镜像 Dockerfile（Chromium / Playwright / `@midscene/web` / Midscene 环境变量）。
  - `App.test.tsx` 25/25：含节点任务日志面板。
- 浏览器镜像构建验证（局域网服务器 Docker）：`BUILD OK`，`BROWSER OK: hello CHROMIUM: 156.0.8078.79`，`MIDSCENE OK: PlaywrightAgent.aiAct 可用`。
  - 发现并修正：Midscene 正确 npm 包为 `@midscene/web`（`@midscene/playwright` 不存在）；其 peer 依赖 `@playwright/test` 必须一并安装，否则 `@midscene/web/playwright` 入口加载失败。
  - 发现并修正：`openai-chat` 是 Midscene 协议（`MIDSCENE_MODEL_PROTOCOL`），不是合法 `MIDSCENE_MODEL_FAMILY`；family 使用受支持的视觉模型族，默认 `qwen2.5-vl`。
- 测试前重建独立库，不触碰正式库 `platform`。

## 代码位置

- `platform/apps/control-plane/src/test-runner.mjs`：白盒/黑盒分发、四级定位、openai-chat 视觉回退、Midscene 包装、HTML 报告、浏览器 bootstrap。
- `platform/apps/control-plane/src/runtime/index.mjs`：`data-testid` 稳定标识、流程页面、created banner。
- `platform/apps/control-plane/src/images.ts`：候选镜像 Dockerfile，Chromium + Playwright + `@midscene/web`。
- `platform/apps/control-plane/src/node-agent-template.mjs`：报告从容器拷回测试区、payload 与日志回报。
- `platform/apps/control-plane/src/node-install.ts`：节点安装脚本注释。
- `platform/apps/control-plane/src/test-cases.ts`
- `platform/apps/control-plane/src/node-tests.ts`
- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/control-plane/test/online-testing.test.ts`
- `platform/apps/control-plane/test/node-agent.test.mjs`
- `platform/apps/control-plane/test/runtime.test.mjs`
- `platform/apps/portal/src/App.test.tsx`
- 本文档：`docs/superpowers/plans/2026-11-20-test-executor-gaps.md`
