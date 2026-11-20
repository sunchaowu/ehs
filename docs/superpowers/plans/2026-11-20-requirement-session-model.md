# 需求会话接入模型实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-20 11:00:00 +0800 |
| 状态 | 已实现：模型调用、工具循环、门户会话收发 |
| 范围 | 总体计划第 3 项遗留缺口：会话只存消息、不调用模型 |
| 部署验证 | 局域网 Ubuntu（`172.18.0.31`），控制面容器内独立测试库执行控制面测试 |

## 背景

此前 `postRequirementMessage` 在模型配置齐全时也只把用户消息写入 `requirement_messages`，不调用模型、不执行工具；门户会话卡片没有消息列表和发送按钮。需求人员无法通过对话产生草稿变更，总体计划「一条确认链路」的第一环是空的。

## 已实现

### 模型客户端（`src/llm.ts`）

- `createModelClient()`：OpenAI Chat Completions 兼容协议，`POST {model.baseUrl}/chat/completions`，`Authorization: Bearer {model.apiKey}`，`model` 取 `model.name`。
- 60 秒超时（AbortController），失败返回原因（HTTP 状态 + 响应片段 / 超时 / 网络错误），不重试、不生成虚假回复。
- 返回结构保留 `tool_calls`，供上层执行工具。

### 工具定义（`src/requirement-tools.ts`）

按行为细则第 6.4 节对模型开放 9 个工具：`create_project`、`add_menu`、`add_entity`、`add_workflow`、`grant_role`、`mark_extension`、`add_test_case`、`run_tests`、`replay_test`。菜单编码、项目编码由平台生成，模型不传编码；字段类型、流程步骤、授权动作的枚举与校验沿用草稿层。

### 提示词（`src/requirement-session.ts`）

`requirementSystemPrompt()` 按五层组织：

1. 角色：需求分析师，只改草稿，不发布、不改已发布版本；
2. 项目快照：草稿菜单、角色、授权、实体、流程、用户案例、扩展，候选镜像、已发布镜像、最近一次测试状态；
3. 领域包摘录：按当前这句话是否匹配 OA 关键词（请假/审批/公告/员工/部门/组织）注入 OA 模板的菜单、数据、流程、角色；不匹配时明确要求不套用模板；
4. 工具规则：编码由平台生成、字段类型与流程步骤枚举、发布不在工具范围；
5. 闸门：模型配置为空时不调用（HTTP 403「会话和运维智能体不会调用模型」）。

### 会话循环（`drafts.ts`）

`postRequirementMessage(database, actor, projectCode, body, { model, executor })`：

1. 校验模型配置与会话成员权限；
2. 写入用户消息（`role='user'`）；
3. 读取最近 40 条会话消息作为历史（只回放 user/assistant）；
4. 调用模型，最多 4 轮工具循环：执行工具 → 把结果作为 `tool` 消息带回 → 直到模型返回文本；
5. 助手回复写入 `requirement_messages`（`role='assistant'`）；模型失败返回 502 并保留用户消息，不写助手消息；
6. 工具统一经 `applyTool` 执行，沿用项目管理权限校验；`create_project` 走项目创建接口的同一函数。

### 数据与接口

- `requirement_messages` 新增 `role` 列（`alter table ... add column if not exists`，历史消息默认 `user`）。
- `GET /api/projects/:code/messages` 返回 `{ role, body }` 序列。
- `POST /api/projects/:code/messages` 返回 `{ stored: true, reply }`；`buildServer({ modelClient })` 可注入测试模型，与 `testExecutor` 注入方式一致。

### 门户（`apps/portal/src/App.tsx`）

- 项目会话卡片新增消息列表（用户 / 方案分析师标签），进入项目时加载历史。
- 输入框 + 发送按钮；发送中禁用并显示加载态；失败显示服务端原因；成功后重新加载消息。
- 模型未配置时输入框与发送按钮禁用，并显示「会话和运维智能体不会调用模型」。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json`：通过。
- `pnpm exec tsc --noEmit -p apps/portal`：通过。
- 门户测试 `apps/portal/src/App.test.tsx`：20 个用例通过。
- 新增 `apps/control-plane/test/requirement-model.test.ts`：覆盖工具循环（add_menu 落库、两轮消息、工具结果回传）、助手回复入库、模型失败不写助手消息。
- 控制面测试在局域网控制面容器内以独立库 `platform_test` 执行，不接触正式库。2026-11-20 12:00 +0800 执行 `vitest run --no-file-parallelism`：`requirement-model.test.ts` 2/2 通过、`drafts.test.ts` 1/1 通过。两个测试文件必须串行执行，否则 migrate 与清理数据会相互竞争；每个用例开头清空模型配置，避免配置跨用例残留。
- 部署 `deploy.sh` 成功，control-plane / portal 容器已重建启动（日志末尾出现 `Started`；PowerShell 下退出码 1 是 stderr 噪声）。

## 未实现（当前边界）

- 流式输出与多轮中断恢复。
- 领域包按语义检索（当前按关键词匹配 OA）。
- 会话工具的 `run_tests` 依赖测试节点与候选镜像，未配置时按既有原因拒绝。
- 模型连通性测试按钮、运维智能体复用同一客户端尚未接入。
- 模型未配置时仍允许查看历史消息。

## 代码位置

- `platform/apps/control-plane/src/llm.ts`
- `platform/apps/control-plane/src/requirement-tools.ts`
- `platform/apps/control-plane/src/requirement-session.ts`
- `platform/apps/control-plane/src/drafts.ts`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/control-plane/test/requirement-model.test.ts`
