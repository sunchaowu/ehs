# 测试节点执行记录（2026-11-19）

## 目标

在线测试的编排、案例和发布门已在 `2026-11-17-online-testing.md` 完成，但执行器一直明确失败。本轮把白盒测试放到测试节点执行，补齐「候选镜像 → 测试节点 → 测试容器 → 步骤结果」的链路；黑盒仍未接入，继续明确失败。

## 决策

- **执行位置在测试节点**：控制面不下发 Docker 命令到测试区，测试节点按现有方式轮询 `/api/nodes/:name/desired`。测试任务作为 `tests` 字段随期望状态一起下发。
- **异步执行**：`POST /api/projects/:code/tests` 和回放接口在未注入执行器时返回 `202` 与 `{ runId, status: "running", node }`，不在 HTTP 请求里等待测试跑完。门户在运行中每 3 秒刷新一次，最多约 10 分钟。
- **测试容器**：使用候选镜像启动 `platform-test-<任务短 id>`，注入 `runtime.mode=test`、`DATABASE_NAME` 和本机模板生成的 `DATABASE_URL`，测试库由控制面在创建运行时重建。
- **容器内执行白盒**：节点把 `test-runner.mjs` 和用例 JSON 复制进容器，在容器内用 Node 内置 `fetch` 请求 `127.0.0.1:8080`，不发布端口，也不依赖测试区外的网络。
- **黑盒继续失败**：黑盒步骤逐条记为失败，原因「黑盒执行器未配置：Midscene.js 与 Playwright 待接入」。不生成虚假通过记录，发布门保持关闭。

## 任务与数据

新增 `test_jobs` 表：

- `id`、`run_id`、`node_name`、`project_code`、`image_digest`、`database_name`
- `cases jsonb`、`step_timeout_seconds`、`run_timeout_seconds`
- `status`（`pending`、`running`、`done`）、`claimed_at`、`finished_at`、`failure`、`created_at`

流程：

1. 控制面创建 `test_runs` 行、重建 `tst_<项目编码>` 测试库，写入 `pending` 任务。
2. 测试节点请求 `/desired`，控制面用单条 `update ... where status = 'pending' ... for update skip locked` 原子领取最多 2 个任务并改成 `running`。
3. 节点为每个任务启动独立子进程，主循环继续上报正式项目健康状态，避免测试阻塞心跳。
4. 子进程拉镜像、启动测试容器、复制入口和用例、执行、回报 `/api/nodes/:name/tests/:jobId`。
5. 控制面按回报写 `test_step_records`，把运行标记为 `passed` 或 `failed`；回报 `reason` 时直接失败。
6. 节点或任务超时未回报时，读取测试结果或下次领取任务会把任务和运行标记为「测试节点未在时限内回报」。

## 白盒步骤语义

`test-runner.mjs` 把案例步骤映射为运行库接口：

| action | target | 请求 | 通过条件 |
|---|---|---|---|
| `call` | `<项目编码>/<实体>.create`，`value` 为完整记录 JSON | `POST /api/<编码>/<实体>`，请求体 `{ value }` | 201 且返回带 `id` 的记录 |
| `validate` | `<项目编码>/<实体>/<字段>`，`value` 为含非法值的完整记录 JSON | 同上 | 400 且原因包含字段名 |
| `migrate` | `<项目编码>/workflows/<流程>/<步骤>` | `POST /api/<编码>/workflows/<流程>/<步骤>` | 200 |
| `call` | `<项目编码>/menus/<菜单编码>`，`value` 为未授权用户名 | `GET /api/<编码>/menus/<菜单编码>`，带 `x-platform-user` | 403 |

- 中文用户名按 `encodeURIComponent` 放进请求头。
- 自动生成的「字段校验拒绝非法输入」案例现在携带完整记录 JSON，只把一个字段替换成非法值。
- 「未授权访问被拒绝」案例的目标改成 `<编码>/menus/<菜单编码>`，与运行库的菜单详情接口一致。
- 其他白盒动作、无法解析的目标、请求失败都会记录失败原因。

## 接口

- `POST /api/projects/:code/tests`：未注入 `testExecutor` 时创建异步任务，返回 202；注入时保持同步返回 201。
- `POST /api/projects/:code/tests/runs/:runId/replay`：同样支持异步和同步两种路径。
- `GET /api/nodes/:name/desired`：返回 `{ projects, tests }`，并领取待执行任务。
- `POST /api/nodes/:name/tests/:jobId`：节点 Bearer 令牌鉴权，接收 `{ outcomes }` 或 `{ reason }`。
- `POST /api/projects/:code/tools` 的 `run_tests`、`replay_test` 在未注入执行器时也走异步任务。

## 节点安装脚本

- `node-install.ts` 不再手写内嵌代理字符串，改为读取并嵌入：
  - `src/node-agent-template.mjs`：代理主循环、项目协调、测试任务子进程、任务执行。
  - `src/test-runner.mjs`：容器内白盒入口。
- 安装脚本同时写出 `agent.mjs` 和 `test-runner.mjs`，仍不写数据库地址。
- 代理支持 `agent.mjs --test-job <base64>` 单任务模式，由主循环以 detached 子进程启动。
- 数据库连接串仍从 `PLATFORM_DATABASE_URL_TEMPLATE` 或 `~/.platform-node/database.url` 读取，`{database}` 替换成任务里的测试库名。

## 边界

- 黑盒执行器仍未接入：Midscene.js + Playwright 应运行在同一测试容器和安全边界内，当前没有实现。
- 白盒执行器是 HTTP 级接口测试，不是 Vitest 单元测试；设计里的「Vitest 白盒」如要严格落地，需要后续在生成镜像里带测试入口。
- 测试节点仍通过 HTTP + Bearer 令牌访问控制面，`client.crt` / `client.key` / `ca.crt` 只是落盘材料，实际 mTLS 终止尚未接入。
- 测试任务没有实时日志流，只有最终步骤结果。
- 每个节点每轮最多领取 2 个任务，暂无优先级和重试队列。

## 验证

- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- `pnpm exec vitest run --project runtime`：12 个用例通过。
  - 运行库 5 个：启动与接口、无效模块拒绝、镜像运行库与启动命令、`pg` 依赖打包、PostgreSQL 固定表存储。
  - 测试节点/白盒 7 个：步骤映射、响应判定、完整白盒执行与黑盒失败、数据库模板、任务执行与清理、拉取失败上报、项目健康上报。
- `pnpm exec vitest run --project portal`：20 个用例通过（含测试结果卡片与回放）。
- 未执行：控制面数据库相关测试需要 PostgreSQL；服务器部署与真实测试节点执行待局域网环境验证。

## 代码位置

- `platform/apps/control-plane/src/node-tests.ts`
- `platform/apps/control-plane/src/node-agent-template.mjs`
- `platform/apps/control-plane/src/test-runner.mjs`
- `platform/apps/control-plane/src/test-runs.ts`
- `platform/apps/control-plane/src/test-cases.ts`
- `platform/apps/control-plane/src/node-install.ts`
- `platform/apps/control-plane/src/releases.ts`
- `platform/apps/control-plane/src/nodes.ts`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/src/drafts.ts`
- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/control-plane/test/node-agent.test.mjs`
- `platform/apps/control-plane/test/stage4-finish.test.ts`
