# 项目运行库实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-18 09:15:00 +0800 |
| 状态 | 第一版已实现 |
| 范围 | 第 4 项遗留缺口：生成镜像的运行入口 |
| 源码提交 | `57e8a89` |
| 部署验证 | 局域网 Ubuntu 手工构建并运行镜像验证 |

## 背景

设计编译把草稿编译成 `modules/<项目编码>/module.ts`，模块通过 `createStandardModule` 引用 `@platform/runtime`。此前仓库里没有这个包，生成的 Dockerfile 只复制 `modules/`，也没有启动命令，镜像无法提供业务服务。本次补齐最小运行库和镜像入口。

## 已实现

### 运行库

代码在 `platform/apps/control-plane/src/runtime/`：

- `index.mjs`：模块定义校验、记录校验、内存存储、HTTP 路由。
- `server.mjs`：扫描 `modules/` 下的项目目录，加载 `module.ts` 并启动服务；作为镜像入口运行。
- `package.json`：包名 `@platform/runtime`，供生成模块按包名导入。

`createStandardModule(definition)` 校验并冻结模块定义：项目编码、菜单、实体字段类型、引用字段目标、流程步骤。Node 24 可直接运行生成模块里的 TypeScript（仅使用可擦除语法）。

### 镜像

`images.ts` 生成镜像时：

- 把运行库写入 `node_modules/@platform/runtime/`；
- Dockerfile 复制 `node_modules` 和 `modules`，设置 `PORT=8080`，暴露 8080；
- 启动命令为 `node node_modules/@platform/runtime/server.mjs`。

### HTTP 接口

- `GET /health`：状态、运行模式、已加载项目及实体/流程数量。
- `GET /api/:code/menus`：菜单列表。
- `GET /api/:code/:entity`、`POST /api/:code/:entity`、`DELETE /api/:code/:entity/:id`：记录查询、创建、删除。
- `GET /api/:code/workflows/:name`、`POST /api/:code/workflows/:name/:step`：流程状态与按顺序迁移。
- `GET /p/:code/:entity`、`GET /p/:code/:entity/form`、`POST /p/:code/:entity`：门户页面、表单和提交（303 跳转）。

### 校验

- 字段类型：`text`、`longText`、`number`、`boolean`、`date`、`datetime`、`user`、`ref`。
- 缺少字段、未知字段、日期格式、数字和布尔转换都会返回原因。
- 流程迁移必须按定义顺序执行，顺序不符返回 409 和期望步骤。

## 未实现（当前边界）

- **数据库持久化**：记录存在进程内存，重启即丢失。节点代理目前只注入 `DATABASE_NAME` 和 `runtime.mode`，没有数据库连接串；运行库也没有打包 `pg`。
- **身份与授权**：模块定义里的 `grants` 只保存不校验，接口没有登录态；OA 模板里的「未授权访问被拒绝」案例还不能通过运行库验证。
- **入口路由**：节点启动容器时没有发布端口，接入区也没有把项目流量转发到容器，浏览器暂时访问不到项目服务。
- **平台侧镜像构建**：控制面容器里没有 Docker CLI 和套接字，`POST /api/projects/:code/image` 在部署环境无法真正构建；本次验证是在服务器上用生成的同一份 Dockerfile 手工构建。
- **公用容器组**：运行库已按项目编码分发，但镜像构建仍只包含当前项目模块，组内其他项目尚未合并进同一镜像。

## 验证记录

- `pnpm exec vitest run --project runtime`：3 个用例通过（启动与接口、无效模块拒绝、镜像运行库与启动命令）。
- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- 服务器手工构建 `platform-runtime-check:local` 并运行：
  - `/health` 返回 `{"status":"ok",...}`；
  - 创建返回带 id 的记录，非法日期返回「开始日期 必须是 YYYY-MM-DD」；
  - 列表返回已创建记录；
  - 流程第一次 `submit` 成功，第二次返回「流程步骤顺序不符，期望 approve」；
  - 表单页返回 200。

## 后续顺序

1. 节点代理注入 `DATABASE_URL`（本机配置模板），运行库接 PostgreSQL 并建表。
2. 接入区或节点代理把 `/p/<项目编码>` 路由到容器。
3. 控制面通过节点代理构建镜像，或显式挂载 Docker 访问能力。
4. 白盒测试执行器调用运行库接口，完成「生成 → 测试 → 发布」闭环。

## 代码位置

- `platform/apps/control-plane/src/runtime/index.mjs`
- `platform/apps/control-plane/src/runtime/server.mjs`
- `platform/apps/control-plane/src/runtime/package.json`
- `platform/apps/control-plane/src/images.ts`
- `platform/apps/control-plane/test/runtime.test.mjs`
- `platform/vitest.config.ts`
