# 用户与授权管理页实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-20 14:33:38 +0800 |
| 状态 | 已实现：平台用户管理、项目成员/角色/授权管理、对应门户页面 |
| 范围 | P0.3：补齐账号生命周期与项目授权的可视化管理入口 |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 84/84 通过；门户 23/23 通过 |

## 背景

规格要求区分平台管理员与项目管理员：平台管理员管理账号与平台配置，项目管理员管理本项目的会话、授权与发布确认。此前控制面已有 `POST /api/users`、`POST /api/users/:username/disable` 和项目侧的成员/角色/授权写入口，但缺少只读列表、启用与撤销能力，门户也没有任何用户或授权管理界面，管理员只能依赖 API 直接操作。

## 已实现

### 控制面账号管理（`src/accounts.ts`）

- `listUsers(database)`：按用户名排序列出全部用户，返回 `username` / `displayName` / `language` / `platformAdmin` / `disabled` / `wechatBound`，不返回密码哈希。
- `setUserDisabled(database, username, disabled)`：统一启用/停用写入，供新增的启用接口复用。

### 控制面项目管理（`src/projects.ts`）

- `requireProjectAdmin`：按（项目编码、用户名、`project_members.project_admin`）校验项目管理员权限，非管理员返回 403。
- `listProjectMembers` / `removeProjectMember`：列出项目成员；移除成员时拒绝移除自己（400），并清理其 `project_role_members` 记录，避免离项用户继续通过角色继承授权。

### 控制面授权视图（`src/drafts.ts`）

- `listProjectAccess`：项目管理员只读视图，返回草稿菜单、角色及成员、草稿授权三部分，供授权管理页一次拉取。
- `revokeGrant`：按（主体类型、主体名、菜单编码、动作）删除单条草稿授权，不存在返回 404。
- `unassignRole`：删除某角色的指定成员，不存在返回 404。
- 复用 `solution-diff.ts` 的 `DraftGrant` 类型，避免重复定义。

### 控制面路由（`src/server.ts`）

| 方法 | 路由 | 权限 | 行为 |
|---|---|---|---|
| GET | `/api/users` | 平台管理员（否则 403） | 列出用户 |
| POST | `/api/users/:username/enable` | 平台管理员 | 启用用户；不存在 404，成功 204 |
| POST | `/api/users/:username/disable` | 平台管理员 | 停用用户（既有） |
| GET | `/api/projects/:code/members` | 项目管理员 | 列出成员 |
| DELETE | `/api/projects/:code/members/:username` | 项目管理员 | 移除成员；自己 400，不存在 404 |
| GET | `/api/projects/:code/grants` | 项目管理员 | 授权视图（菜单/角色/授权） |
| DELETE | `/api/projects/:code/grants` | 项目管理员 | 撤销单条授权 |
| DELETE | `/api/projects/:code/roles/assign` | 项目管理员 | 取消角色成员 |

未登录统一 401；项目侧所有写/读接口都经过项目管理员校验。

### 门户（`apps/portal/src/App.tsx`、`shell-copy.ts`）

- 平台管理员左侧导航新增「用户管理」（`platform/shell/nav-users`）；项目页在「方案确认」旁新增「授权管理」入口（`platform/project/access`）。
- 用户管理页 `platform/users/*`：内联表单创建用户，列表展示状态/平台管理员/语言/微信绑定，支持启用/停用切换与操作反馈。
- 授权管理页 `platform/access/*`：分区展示并可管理项目成员、角色成员、草稿授权，均可新增与移除；所有变更成功后重新拉取视图。
- 文案加入 `zh-CN` / `en-US` 的 `users`、`access` 项。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json`：通过。
- `pnpm exec tsc --noEmit -p apps/portal`：通过。
- 门户测试 `apps/portal/src/App.test.tsx`：23/23 通过（新增用户管理与项目授权管理两个用例）。
- 控制面新增 `test/access-management.test.ts`：2/2 通过，覆盖用户列表/创建/启停/权限拒绝，以及成员/角色/授权的增删改与越权拒绝。
- 控制面全套测试在局域网容器内以 `platform_test` 执行：31 个文件、84 个用例全部通过。
- 测试前重建独立库：`drop database if exists platform_test with (force)` + `create database platform_test`，不触碰正式库 `platform`。

## 顺带修复

- 串行全套执行时新增测试文件改变了用例顺序，暴露出共享库配置污染：`publish.test.ts` 未重置 `test.requirePassBeforePublish`、`admin-config.test.ts` 未重置 `registration.enabled`。已在这两个用例 setup 中显式恢复默认配置。
- 多个慢用例在容器负载下逼近默认 5 秒超时：`admin-config` / `drafts` / `publish` 设为 15 秒，`online-testing` 设为 30 秒，通过文件级 `vi.setConfig({ testTimeout })` 实现。

## 未实现（当前边界）

- 授权管理操作的是草稿（`draft_grants` / `project_role_members`），需经发布流程生效；不直接改已发布授权。
- 角色本身无独立管理页；当前通过分配角色时输入角色名自动创建，角色授权仍通过草稿授权区的「主体类型 = role」添加。
- 不提供用户删除、密码重置、角色重命名；停用仅阻止登录，不清理其会话。

## 代码位置

- `platform/apps/control-plane/src/accounts.ts`
- `platform/apps/control-plane/src/projects.ts`
- `platform/apps/control-plane/src/drafts.ts`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/test/access-management.test.ts`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/portal/src/shell-copy.ts`
- `platform/apps/portal/src/App.test.tsx`
- 本文档：`docs/superpowers/plans/2026-11-20-user-access-management.md`
