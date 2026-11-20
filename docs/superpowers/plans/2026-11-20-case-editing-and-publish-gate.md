# 门户案例编辑与发布门实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-20 15:40:17 +0800 |
| 状态 | 已实现：用户测试案例增删改 API 与门户界面、测试门槛禁用发布 |
| 范围 | P0.5 后续：门户案例编辑 + 测试未全部通过时禁用发布按钮 |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 90/90 通过；门户 26/26 通过 |

## 背景

规格要求「用户在会话里追加的案例一直保留直到删除」「当前候选没有全部通过时，不能确认发布」。此前：

- 用户案例只能通过会话工具 `add_test_case` 或 OA 模板写入 `draft_records(kind='test_case')`，方案确认时再编译进 `test_cases`；门户没有任何案例编辑入口，也没有删除能力。
- 后端 `POST /api/projects/:code/publish` 已有测试门槛（失败返回 409 + `failedCases`），`GET /release` 也返回 `testResult`，但门户「发布确认」按钮只读取状态、不触发发布，更不会在测试未通过时禁用。

## 已实现

### 控制面用户案例管理（`src/user-test-cases.ts`）

- `listUserTestCases`：列出当前项目 `origin='user'` 的案例（来自 `test_cases`，按编码排序）。
- `addUserTestCase`：复用 `normalizeUserCase` 校验，按 `caseCode` 稳定编码；重复案例返回 409；同时写入 `draft_records(kind='test_case')`（持久真值）与 `test_cases`（当前候选即时生效）。
- `deleteUserTestCase`：按编码删除 `test_cases` 中的用户案例，并按规范化后的 `name` 清理对应草稿记录；自动案例（`origin='auto'`）不可经此接口删除；不存在返回 404。

双层写入是关键：只写草稿要等方案确认才生效；只写候选会在下次确认编译后被覆盖。两处同步保证「编辑后立即出现在测试列表」且「方案确认后保留」。

### 控制面路由（`src/server.ts`）

| 方法 | 路由 | 权限 | 行为 |
|---|---|---|---|
| GET | `/api/projects/:code/tests/cases` | 项目成员（登录） | 列出用户案例 |
| POST | `/api/projects/:code/tests/cases` | 项目管理员 | 新增用户案例，201 返回 `testCase` |
| DELETE | `/api/projects/:code/tests/cases/:caseCode` | 项目管理员 | 删除用户案例，204 |

未登录统一 401；写操作非项目管理员 403。

### 门户（`apps/portal/src/App.tsx`）

- 项目页新增「用户测试案例」卡片（`platform/user-cases/page`）：
  - 列出用户案例，显示方法标签、步骤数与编码；每条提供删除按钮。
  - 新增表单：方法下拉（黑盒/白盒）、案例名称、可动态增删的步骤（action / target / value / expected）；提交时构造与 `normalizeUserCase` 一致的载荷。
  - 所有变更成功后重新拉取列表，失败显示后端原因。
- 发布门槛：
  - 「发布确认」按钮读取 `GET /release` 展示状态（原行为保留）。
  - 状态区新增「确认发布」按钮（`platform/project/publish`），真正调用 `POST /publish`，成功后重新读取 release 刷新。
  - 门槛开启且当前候选没有全部通过时，按钮禁用（`platform/project/publish-blocked` 显示原因，含失败案例名）；门槛关闭时不拦截。后端 409 也会渲染到页面。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json`：通过。
- `pnpm exec tsc --noEmit -p apps/portal`：通过。
- 控制面新增 `test/user-cases.test.ts`：3/3 通过，覆盖新增即时生效、重复 409、校验 400、删除清理两层、方案确认后保留、非管理员与匿名拒绝。
- 门户 `App.test.tsx`：26/26 通过（新增案例增删与发布门槛禁用两个用例）。
- 控制面全套测试在局域网容器内以 `platform_test` 执行：33 个文件、90 个用例全部通过。
- 测试前重建独立库，不触碰正式库 `platform`。

## 未实现（当前边界）

- 黑盒步骤仍必然失败（Midscene.js + Playwright 未接入），因此含黑盒案例的项目发布门事实上关闭；门户会如实禁用发布并列出失败案例。
- 案例步骤为自由文本（action / target / value / expected），无元素选择器辅助或可视化录制；手工录制链未实现。
- 案例「编辑」通过删除后重新新增实现（编码随内容变化），没有原地编辑接口。
- 只读用户仍能看到用户案例列表，但无新增/删除入口（写操作由后端 403 兜底，界面未做角色级隐藏）。

## 代码位置

- `platform/apps/control-plane/src/user-test-cases.ts`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/test/user-cases.test.ts`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/portal/src/App.test.tsx`
- 本文档：`docs/superpowers/plans/2026-11-20-case-editing-and-publish-gate.md`
