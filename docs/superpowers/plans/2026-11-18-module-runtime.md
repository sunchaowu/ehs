# 项目运行库实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-18 10:20:00 +0800 |
| 状态 | 第三版：已接入 PostgreSQL，平台侧可构建镜像 |
| 范围 | 第 4 项遗留缺口：生成镜像的运行入口、数据落地与镜像构建能力 |
| 源码提交 | `57e8a89`（运行库）、`bcb47bc`（数据库接入）、`c1d45e1`（构建能力） |
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

### 平台侧镜像构建

- `apps/control-plane/Dockerfile` 用 `docker:27-cli` 多阶段复制 Docker CLI 到运行镜像；`deploy/compose.server.yaml` 给控制面挂载 `/var/run/docker.sock`。
- 挂载套接字等同宿主 root 权限，只部署在受控的运行区服务器，不放到接入区。
- 设计原文要求 Docker 套接字只在节点本机；当前是在系统运行区服务器本地挂载，不跨区。若后续严格按该条执行，需要改成受控构建服务或专用构建节点，不影响当前部署边界。
- `registry.address` 常写成 `registry.internal`，构建标签会自动补默认端口 5000，避免推送到 443。
- 部署 compose 后，`POST /api/projects/:code/image` 可在控制面容器内真正执行构建和推送；当前运行实例仍是 2026-11-17 的镜像，需要重新部署才生效。

### HTTP 接口

- `GET /health`：状态、运行模式、存储类型、已加载项目及实体/流程数量。
- `GET /api/:code/menus`：按身份过滤后的菜单列表。
- `GET /api/:code/:entity`、`POST /api/:code/:entity`、`DELETE /api/:code/:entity/:id`：记录查询、创建、删除。
- `GET /api/:code/workflows/:name`、`POST /api/:code/workflows/:name/:step`：流程状态与按顺序迁移。
- `GET /p/:code/:entity`、`GET /p/:code/:entity/form`、`POST /p/:code/:entity`：门户页面、表单和提交（303 跳转）。

### 身份与授权

- 运行库不自己登录，信任网关注入的身份头：
  - `x-platform-user`：当前用户名；
  - `x-platform-roles`：逗号分隔的角色名。
- 请求头只能是 ASCII，中文用户名和角色用 `encodeURIComponent` 编码；运行库按 `decodeURIComponent` 还原，解码失败时保留原值。
- 菜单授权取用户授权与角色授权的并集，且 `action` 必须是「访问」；其他动作（新增/修改/删除）暂不参与接口判定。
- 两个菜单接口都先校验身份：
  - 没有任何身份 → 401「缺少用户身份」；
  - `GET /api/:code/menus` 返回过滤后的列表，已授权为空时返回空数组；
  - `GET /api/:code/menus/:menuCode`：菜单不存在 404，无授权 403「未授权访问」，有授权返回 200。
- 容器不能直接暴露公网，否则可伪造身份头；当前由节点和内网边界保证。

### 校验

- 字段类型：`text`、`longText`、`number`、`boolean`、`date`、`datetime`、`user`、`ref`。
- 缺少字段、未知字段、日期格式、数字和布尔转换都会返回原因。
- 流程迁移必须按定义顺序执行，顺序不符返回 409 和期望步骤。

## 未实现（当前边界）

- **身份与授权**：只覆盖菜单可见性（「访问」授权），记录/流程接口仍未校验动作级授权；OA 模板里的「未授权访问被拒绝」菜单案例已可通过运行库验证，但记录级越权尚未拦截。
- **入口路由**：已接入 `/p/<项目编码>`：控制面校验登录、项目成员与已发布版本，注入身份头后转发到节点内置网关，节点再转到只绑定 `127.0.0.1` 的容器端口。mTLS、多副本与故障切换尚未接入，节点网关需靠网络分区限制来源，记录见 `docs/superpowers/plans/2026-11-19-project-entry-routing.md`。
- **平台侧镜像构建的部署状态**：代码和 compose 已具备能力，但当前局域网实例还没重新部署；在重新部署前，`POST /api/projects/:code/image` 仍找不到 Docker CLI。
- **公用容器组**：运行库已按项目编码分发，但镜像构建仍只包含当前项目模块，组内其他项目尚未合并进同一镜像。
- **数据库账号生命周期**：运行库只建表，不创建数据库或角色；节点本机模板需指向已存在的项目库。

## 验证记录

- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- `pnpm exec vitest run --project runtime`：5 个用例通过（启动与接口、无效模块拒绝、镜像运行库与启动命令、`pg` 依赖打包、PostgreSQL 固定表存储）；启动用例覆盖身份头、401、403 和角色授权。2026-11-19 入口路由加入后同一项目共 24 个用例通过（含测试节点与入口路由）。
- `node-runtime.test.ts`：5 个用例通过（拉取失败不启动、默认不注入数据库连接、模板注入与健康检查、运行中但未连库、上报协调结果）。
- `stage4-finish.test.ts` 中安装脚本用例：通过，确认脚本含 `database.url` 与 `PLATFORM_DATABASE_URL_TEMPLATE` 说明且不内嵌 `postgres://`。
- `publish.test.ts` 中镜像用例：通过，确认推送标签为 `registry.internal:5000/...`，且缺端口时自动补 5000。
- `compose-zones.test.ts`：2 个用例通过，确认三区端口策略并校验控制面挂载了 Docker 套接字。
- 服务器手工构建 `platform-runtime-db-check:local` 并连接 `prd_runtime_check` 库运行：
  - `/health` 返回 `{"status":"ok","storage":"postgres",...}`；
  - 创建记录成功并返回 id；
  - 重启容器后列表仍返回同一条记录；
  - 流程 `submit` 成功，`platform_workflows` 表有 1 行；
  - 记录表 `platform_records` 有 1 行；
  - 验证结束后删除容器和临时库。
- 服务器用带宿主套接字和系统网络的临时容器构建一个空镜像并推送到 `registry.internal:5000`：
  - Docker Server 27.5.1 可访问；
  - 构建成功；
  - 推送返回 manifest digest；
  - 探针镜像随后从本地删除，并从镜像库删除 manifest。

## 后续顺序

1. 给已打通的入口路由补 mTLS、多副本与故障切换（当前记录见 `2026-11-19-project-entry-routing.md`）。
2. 黑盒测试执行器接入测试节点，与白盒一起完成「生成 → 测试 → 发布」闭环（白盒节点执行见 `2026-11-19-test-node-execution.md`）。
3. 公用容器组把组内项目模块合并进同一镜像。
4. 重新部署控制面，验证平台接口能完成一次真实构建、推送和发布。
5. 补齐记录与流程的动作级授权（新增/修改/删除）。

## 代码位置

- `platform/apps/control-plane/src/runtime/index.mjs`
- `platform/apps/control-plane/src/runtime/server.mjs`
- `platform/apps/control-plane/src/runtime/package.json`
- `platform/apps/control-plane/src/images.ts`
- `platform/apps/control-plane/src/node-agent.ts`
- `platform/apps/control-plane/src/node-install.ts`
- `platform/apps/control-plane/Dockerfile`
- `platform/deploy/compose.server.yaml`
- `platform/apps/control-plane/test/runtime.test.mjs`
- `platform/apps/control-plane/test/node-runtime.test.ts`
- `platform/apps/control-plane/test/stage4-finish.test.ts`
- `platform/apps/control-plane/test/publish.test.ts`
- `platform/apps/control-plane/test/compose-zones.test.ts`
- `platform/vitest.config.ts`
