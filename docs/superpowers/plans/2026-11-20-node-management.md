# 节点管理页实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-20 14:48:43 +0800 |
| 状态 | 已实现：节点列表、令牌轮换、节点删除、门户节点管理页 |
| 范围 | P0.4：补齐平台管理员查看与管理节点的入口 |
| 验证 | 局域网控制面容器 + 独立测试库 `platform_test`，全套 86/86 通过；门户 24/24 通过 |

## 背景

控制面已有节点登记（`POST /api/nodes`）、入池（`PUT /api/nodes/:name/pool`）、安装脚本（`GET /api/nodes/:name/install`）和代理心跳/任务接口，但平台管理员无法从 API 或界面看到节点列表，也无法轮换丢失的注册令牌或删除已退役节点。门户此前只在发布确认卡片里只读显示节点健康提示。

## 已实现

### 控制面节点业务（`src/nodes.ts`）

- `listNodes(database)`：按名称排序列出节点，附带区域、当前节点池（`prod` / `test` / 空）、最近心跳时间、上报项目数与网关地址；从 `system_config` 的两个池字符串推导池归属，不返回任何令牌哈希。
- `rotateNodeToken(database, name)`：重新生成注册令牌并覆盖 `token_hash`，旧令牌立即失效，明文只返回一次；节点不存在返回 404。
- `removeNode(database, name)`：删除节点前先把名称从 `scheduler.defaultNodePool` 与 `test.nodePool` 中移除，并从所有 `desired_states.target_nodes` 中剔除；`node_reports` 与 `test_jobs` 由外键级联删除。节点不存在返回 404。

### 控制面路由（`src/server.ts`）

| 方法 | 路由 | 权限 | 行为 |
|---|---|---|---|
| GET | `/api/nodes` | 平台管理员（未登录 401 / 非管理员 403） | 节点列表 |
| POST | `/api/nodes/:name/rotate-token` | 平台管理员 | 轮换注册令牌，返回明文一次 |
| DELETE | `/api/nodes/:name` | 平台管理员 | 删除节点并清理池与期望状态 |

与既有 `POST /api/nodes`、`PUT /api/nodes/:name/pool`、`GET /api/nodes/:name/install` 共同构成完整的节点管理接口；区域校验、池互斥规则沿用既有实现。

### 门户（`apps/portal/src/App.tsx`、`shell-copy.ts`）

- 平台管理员左侧导航新增「节点管理」（`platform/shell/nav-nodes`），文案加入 `zh-CN` / `en-US` 的 `nodes` 项。
- 节点管理页 `platform/nodes/*`：
  - 登记表单（名称 + 区域下拉），名称输入即时校验 `^[a-z0-9][a-z0-9-]{0,62}$`；登记成功后单独显示一次性注册令牌。
  - 列表逐行展示区域、节点池标签、最近心跳/项目数/网关；未上报心跳显示「尚未上报心跳」。
  - 每行提供安装脚本链接、轮换令牌、按区域加入/移出对应池、删除节点；系统运行区节点不显示入池按钮（后端也不生成脚本）。
  - 所有变更成功后重新拉取列表，失败显示后端原因。
- 稳定标识：`platform/nodes/page`、`platform/nodes/feedback`、`platform/nodes/token`、`platform/nodes/name`、`platform/nodes/zone`、`platform/nodes/create`，以及每行 `row-<名称>` / `zone-<名称>` / `pool-<名称>` / `health-<名称>` / `install-<名称>` / `rotate-<名称>` / `pool-prod-<名称>` / `pool-test-<名称>` / `remove-<名称>`。

## 验证记录

- `pnpm exec tsc --noEmit -p tsconfig.json`：通过。
- `pnpm exec tsc --noEmit -p apps/portal`：通过。
- 门户测试 `apps/portal/src/App.test.tsx`：24/24 通过（新增节点管理页用例）。
- 控制面新增 `test/node-management.test.ts`：2/2 通过，覆盖列表与越权拒绝、区域/池校验、心跳聚合、令牌轮换使旧令牌失效、删除后池与 `target_nodes` 清理、系统运行区不生成安装脚本。
- 控制面全套测试在局域网容器内以 `platform_test` 执行：32 个文件、86 个用例全部通过。
- 测试前重建独立库：`drop database if exists platform_test with (force)` + `create database platform_test`，不触碰正式库 `platform`。

## 顺带处理

- 容器镜像重建后，读取 `deploy/compose.yaml`、`deploy/compose.server.yaml`、`scripts/deploy.sh` 的三个测试会因容器内缺少这些文件而报 ENOENT；测试前把文件同步进容器即可，与实现无关。

## 未实现（当前边界）

- 节点指标（CPU / 内存 / 磁盘 / 错误率 / 日志）尚未上报与展示；当前只显示心跳时间、上报项目数与网关。
- 心跳超时仅在同池内换健康节点的自动处置、自动重启与通知仍属 P1 运维闭环。
- 安装脚本每次获取都会重新生成安装令牌，使上一次脚本失效；界面已提示令牌与脚本只显示一次。
- 客户端证书的 mTLS 服务端校验仍未接入（沿用既有边界）。

## 代码位置

- `platform/apps/control-plane/src/nodes.ts`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/control-plane/test/node-management.test.ts`
- `platform/apps/portal/src/App.tsx`
- `platform/apps/portal/src/shell-copy.ts`
- `platform/apps/portal/src/App.test.tsx`
- 本文档：`docs/superpowers/plans/2026-11-20-node-management.md`
