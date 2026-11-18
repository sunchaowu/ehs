# 项目运行库实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-18 10:20:00 +0800 |
| 状态 | 第二版：已接入 PostgreSQL |
| 范围 | 第 4 项遗留缺口：生成镜像的运行入口与数据落地 |
| 源码提交 | `57e8a89`（运行库）、`bcb47bc`（数据库接入） |
| 部署验证 | 局域网 Ubuntu 手工构建镜像，带 `DATABASE_URL` 运行并重启验证 |

## 背景

设计编译把草稿编译成 `modules/<项目编码>/module.ts`，模块通过 `createStandardModule` 引用 `@platform/runtime`。此前仓库里没有这个包，生成的 Dockerfile 只复制 `modules/`，也没有启动命令，镜像无法提供业务服务。第一版补齐了运行库和镜像入口，但记录只存在内存；本版把存储切到 PostgreSQL，并让节点代理注入项目数据库连接串。

## 已实现

### 运行库

代码在 `platform/apps/control-plane/src/runtime/`：

- `index.mjs`：模块定义校验、记录校验、内存存储、PostgreSQL 存储、HTTP 路由。
- `server.mjs`：扫描 `modules/` 下的项目目录，加载 `module.ts`；存在 `DATABASE_URL` 时连接 PostgreSQL，然后启动服务。
- `package.json`：包名 `@platform/runtime`，供生成模块按包名导入。

`createStandardModule(definition)` 校验并冻结模块定义：项目编码、菜单、实体字段类型、引用字段目标、流程步骤。Node 24 可直接运行生成模块里的 TypeScript（仅使用可擦除语法）。

### 存储

- 没有 `DATABASE_URL` 时用内存存储，方便本地调试；`/health` 的 `storage` 为 `memory`。
- 有 `DATABASE_URL` 时由 `connectPostgres` 连接并建表，`storage` 为 `postgres`。
- 表结构固定，不为每个实体做 DDL：
  - `platform_records(entity text, id uuid, data jsonb, created_at timestamptz)`
  - `platform_workflows(workflow text primary key, completed integer)`
- 记录体放在 `data` 列，实体名单独成列，列表按实体过滤。

### 镜像

`images.ts` 生成镜像时：

- 把运行库写入 `node_modules/@platform/runtime/`；
- 递归复制 `pg` 及其传递依赖到 `node_modules/`。`pg` 在 `exports` 里屏蔽了 `./package.json`，因此先解析入口文件再向上找清单；解析不到的依赖按可选依赖跳过；
- 当前共打包 14 个包、约 470 KB：`pg`、`pg-cloudflare`、`pg-connection-string`、`pg-int8`、`pg-pool`、`pg-protocol`、`pg-types`、`pgpass`、`postgres-array`、`postgres-bytea`、`postgres-date`、`postgres-interval`、`split2`、`xtend`；
- Dockerfile 复制 `node_modules` 和 `modules`，设置 `PORT=8080`，暴露 8080；
- 启动命令为 `node node_modules/@platform/runtime/server.mjs`。

### 节点侧数据库注入

- 节点代理从本机读取连接串模板，不把数据库地址写进安装脚本：
  - 优先用环境变量 `PLATFORM_DATABASE_URL_TEMPLATE`；
  - 否则读 `~/.platform-node/database.url`。
- 模板里的 `{database}` 会替换成分配到的项目数据库名，例如 `postgres://platform:pw@db:5432/{database}`；没有占位符时按固定连接串使用。
- 启动容器时额外注入 `DATABASE_URL`；模板为空时不注入，运行库回落到内存存储。
- 容器启动后节点代理在容器内执行 `/health` 请求（`docker exec ... node -e`），只有 `storage` 为 `postgres` 才上报 `databaseConnected: true`，否则上报失败原因。
- `dockerContainerRuntime` 提供同样的模板参数和健康检查，供控制面测试与后续复用。

### HTTP 接口

- `GET /health`：状态、运行模式、存储类型、已加载项目及实体/流程数量。
- `GET /api/:code/menus`：菜单列表。
- `GET /api/:code/:entity`、`POST /api/:code/:entity`、`DELETE /api/:code/:entity/:id`：记录查询、创建、删除。
- `GET /api/:code/workflows/:name`、`POST /api/:code/workflows/:name/:step`：流程状态与按顺序迁移。
- `GET /p/:code/:entity`、`GET /p/:code/:entity/form`、`POST /p/:code/:entity`：门户页面、表单和提交（303 跳转）。

### 校验

- 字段类型：`text`、`longText`、`number`、`boolean`、`date`、`datetime`、`user`、`ref`。
- 缺少字段、未知字段、日期格式、数字和布尔转换都会返回原因。
- 流程迁移必须按定义顺序执行，顺序不符返回 409 和期望步骤。

## 未实现（当前边界）

- **身份与授权**：模块定义里的 `grants` 只保存不校验，接口没有登录态；OA 模板里的「未授权访问被拒绝」案例还不能通过运行库验证。
- **入口路由**：节点启动容器时没有发布端口，接入区也没有把项目流量转发到容器，浏览器暂时访问不到项目服务。
- **平台侧镜像构建**：控制面容器里没有 Docker CLI 和套接字，`POST /api/projects/:code/image` 在部署环境无法真正构建；本次验证是在服务器上用生成的同一份 Dockerfile 手工构建。
- **公用容器组**：运行库已按项目编码分发，但镜像构建仍只包含当前项目模块，组内其他项目尚未合并进同一镜像。
- **数据库账号生命周期**：运行库只建表，不创建数据库或角色；节点本机模板需指向已存在的项目库。

## 验证记录

- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- `pnpm exec vitest run --project runtime`：5 个用例通过（启动与接口、无效模块拒绝、镜像运行库与启动命令、`pg` 依赖打包、PostgreSQL 固定表存储）。
- `node-runtime.test.ts`：5 个用例通过（拉取失败不启动、默认不注入数据库连接、模板注入与健康检查、运行中但未连库、上报协调结果）。
- `stage4-finish.test.ts` 中安装脚本用例：通过，确认脚本含 `database.url` 与 `PLATFORM_DATABASE_URL_TEMPLATE` 说明且不内嵌 `postgres://`。
- 服务器手工构建 `platform-runtime-db-check:local` 并连接 `prd_runtime_check` 库运行：
  - `/health` 返回 `{"status":"ok","storage":"postgres",...}`；
  - 创建记录成功并返回 id；
  - 重启容器后列表仍返回同一条记录；
  - 流程 `submit` 成功，`platform_workflows` 表有 1 行；
  - 记录表 `platform_records` 有 1 行；
  - 验证结束后删除容器和临时库。

## 后续顺序

1. 接入区或节点代理把 `/p/<项目编码>` 路由到容器。
2. 运行库接入身份与授权校验，让 `grants` 生效。
3. 控制面通过节点代理构建镜像，或显式挂载 Docker 访问能力。
4. 白盒测试执行器调用运行库接口，完成「生成 → 测试 → 发布」闭环。
5. 公用容器组把组内项目模块合并进同一镜像。

## 代码位置

- `platform/apps/control-plane/src/runtime/index.mjs`
- `platform/apps/control-plane/src/runtime/server.mjs`
- `platform/apps/control-plane/src/runtime/package.json`
- `platform/apps/control-plane/src/images.ts`
- `platform/apps/control-plane/src/node-agent.ts`
- `platform/apps/control-plane/src/node-install.ts`
- `platform/apps/control-plane/test/runtime.test.mjs`
- `platform/apps/control-plane/test/node-runtime.test.ts`
- `platform/apps/control-plane/test/stage4-finish.test.ts`
- `platform/vitest.config.ts`
