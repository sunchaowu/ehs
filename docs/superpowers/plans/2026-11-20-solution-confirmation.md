# 方案确认页实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-20 14:10:00 +0800 |
| 状态 | 已实现：真实增量预览、方案确认落库、门户方案确认页 |
| 范围 | P0.2：此前 `confirmSolution` 永远只报 added，modified/removed 恒为空 |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 82/82 通过 |

## 背景

`confirmSolution` 直接把整份草稿塞进 `openspec_changes.added`，`modified` 与 `removed` 写死为空数组。发布侧的 `snapshotPublished` 确实会写 `published_menus` / `published_grants`，但没有与草稿做比对。因此门户无法按规格展示「草稿相对已发布版本的新增、修改和删除」。

## 已实现

### 纯函数增量计算（`src/solution-diff.ts`）

- `diffSolution(draft, published)`：菜单按编码比对 `name` 与 `parent_code`；授权按（主体类型、主体名、菜单编码）分组比对动作集合。
- 输出稳定排序：菜单变更先于授权变更；新增/删除结果按编码或主体键排序。
- 语义：`added` / `removed` 是整行记录；`modified` 中菜单带字段 from/to，授权带 `added_actions` / `removed_actions`。

### 控制面接口

- `GET /api/projects/:code/change`：只读预览当前草稿相对已发布版本的增量，不写库。
- `POST /api/projects/:code/confirm`：把预览得到的真实 `added` / `modified` / `removed` 分别写入 `openspec_changes`，再编译设计。
- `published_menus` 增加 `parent_code` 列（迁移为 `add column if not exists`）；`snapshotPublished` 同步写入该列，使上级菜单变更可被识别。
- `previewSolution` 与 `confirmSolution` 共用同一个 `projectChange()`，预览与确认结果一致。

### 门户（`apps/portal/src/App.tsx`）

- 项目页新增「方案确认」按钮，进入独立的方案确认页（`platform/solution/page`）。
- 页面展示变更总数与新增 / 修改 / 删除分组，分别列出菜单与授权变更；无变更时显示空状态。
- 主按钮「确认方案」调用 `POST /confirm`，成功后显示源码版本；可返回草稿页。
- 稳定标识：`platform/solution/page`、`platform/solution/summary`、`platform/solution/added-menu`、`platform/solution/added-grant`、`platform/solution/modified-item`、`platform/solution/removed-menu`、`platform/solution/removed-grant`、`platform/solution/confirm`、`platform/solution/back`。

## 顺带修复

- `applyOaTemplate` 对无 `id` 列的 `draft_grants` 执行 `returning id`，导致 OA 模板接口 500；改为按 `rowCount` 计数。模板授权实际为 18 条，旧测试期望 14 条，已同步修正。
- 多个测试用例在共享库上串行执行时会互相污染配置（模型配置、节点池、测试库地址、发布门槛、注册开关）。相关测试 setup 显式重置这些配置；`release-health` 的慢用例超时从 5 秒放宽到 15 秒。
- 控制面测试需要串行执行：`vitest run --no-file-parallelism`（migrate 与清理数据不能并发）。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json`：通过。
- `pnpm exec tsc --noEmit -p apps/portal`：通过。
- 门户测试 `apps/portal/src/App.test.tsx`：21/21 通过（新增方案确认页用例）。
- 控制面全套测试在局域网容器内以 `platform_test` 执行：30 个文件、82 个用例全部通过。
- 测试前重建独立库：`drop database if exists platform_test with (force)` + `create database platform_test`，不触碰正式库 `platform`。

## 未实现（当前边界）

- 方案确认后不自动触发构建与测试；仍由门户后续步骤发起（与现有流程一致）。
- 变更草稿与回退属于 P1，尚未实现；当前 `confirm` 会覆盖同一项目的设计编译记录。
- 授权变更以动作集合呈现，不展示角色层级继承细节。

## 代码位置

- `platform/apps/control-plane/src/solution-diff.ts`（新增）
- `platform/apps/control-plane/src/drafts.ts`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/control-plane/src/releases.ts`
- `platform/apps/control-plane/test/solution-diff.test.ts`（新增）
- `platform/apps/control-plane/test/solution-confirm.test.ts`（新增）
- `platform/apps/portal/src/App.tsx`
- `platform/apps/portal/src/App.test.tsx`
