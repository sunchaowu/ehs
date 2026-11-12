# 局域网发布记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-12 18:20:00 +0800 |
| 状态 | 已发布到局域网 Ubuntu 主机，用户正在验证 |
| 目标主机 | `172.18.0.31`（Ubuntu，Docker 27.5.1，Compose v2.32.4，用户 `my`） |
| 发布方式 | `bash platform/scripts/deploy.sh`，读取 `platform/deploy/.env` |
| 核对 | 2026-11-12 18:16 远端校验：登录、项目、方案确认、镜像构建与推送、测试运行编排、发布门均按设计工作 |

## 发布结果

- 五个服务全部起来：`proxy`（Caddy 2，监听 443）、`portal`、`control-plane`、`system-db`、`registry`（私有镜像库）。
- 访问地址：`https://172.18.0.31/`（Caddy 内置 CA，浏览器需要信任或手动放行）。
- 初始管理员：`admin`，密码由安装步骤打印（`ADMIN_RESET=1` 时每次部署重置并打印新密码）。
- 私有镜像库：`https://registry.internal:5000`，自签 CA；宿主 `127.0.0.1 registry.internal` 解析；Docker 守护进程按 `/etc/docker/certs.d/registry.internal:5000/ca.crt` 信任，不需要重启守护进程。

## 本次发布修掉的三个问题

### 1. 安装步骤用了旧镜像，schema 没有跟着代码更新

`deploy.sh` 的安装步骤原来是 `docker compose run --rm -T control-plane …`，不重建镜像。远端保留了上一次发布（11 月 12 日 07:18）的镜像，安装步骤实际执行的是旧代码里的 `install.ts` 和旧 `schema.sql`，远端系统库因此只有 5 张表（`users`、`sessions`、`system_config`、`wechat_states`、`plugins`），`projects`、`drafts`、`release_candidates`、第 5 阶段新增的 `test_cases` / `test_runs` / `test_step_records` 都没有建出来，而部署脚本仍然返回成功。

修复：安装步骤改为 `docker compose run --rm -T --build control-plane …`，先重建再执行，保证 schema 与代码同版本。修复后重跑发布，远端系统库 30 张表齐全。

### 2. 初始管理员密码无法找回

初始管理员密码只在安装输出里出现一次。远端沿用旧系统库里的 `admin`，安装步骤检测到已存在就不再打印密码，管理员无法登录。

新增 `ADMIN_RESET=1`：安装时重置 `admin` 密码并在输出里打印新密码（`installInitialAdmin` 增加 `reset` 选项，`install.ts` 读取环境变量，`compose.server.yaml` 把 `ADMIN_RESET` 传给控制面）。`deploy/.env` 里默认打开，验证完成后改成 `0` 或删除该行。

### 3. 生成器在容器里没有 Docker 客户端，也无处推送镜像

控制面容器内没有 docker 客户端，`POST /api/projects/:code/image` 返回 `spawn docker ENOENT`；compose 里也没有私有镜像库服务。

修复：

- 控制面容器挂载宿主机的 `/usr/bin/docker`（只读）和 `/var/run/docker.sock`，容器内不装守护进程，生成器在系统运行区调用本机 Docker 构建候选镜像。
- compose 新增 `registry` 服务（`docker.io/library/registry:2`），自签 CA 加域名证书，监听 `127.0.0.1:5000`，容器网络内别名 `registry.internal`。
- `deploy.sh` 生成证书、写入 `/etc/docker/certs.d/registry.internal:5000/ca.crt`、补 `/etc/hosts` 解析，全部幂等，不需要重启 Docker 守护进程（该主机还有 1Panel 的 postgres、maxkb、sonarqube 在跑）。
- `REGISTRY_ADDRESS` 改为 `registry.internal:5000`；`platform/.dockerignore` 排除 `deploy/registry`，证书与私钥不进构建上下文。

## 验证过的流程

| 流程 | 结果 |
|---|---|
| `POST /api/session/login` 管理员登录 | 200，返回会话 Cookie，`platformAdmin` 为真 |
| `GET /api/session` | 200，返回管理员与平台标题 |
| `POST /api/projects` 创建项目 | 201，项目编码由名称生成 |
| `POST /api/projects/:code/menus`、`/tools` | 201，草稿写入 |
| `POST /api/projects/:code/confirm` 方案确认 | 201，生成设计并编译源码 |
| `GET /api/projects/:code/tests` | 200，第 5 阶段自动案例已生成，编码稳定 |
| `POST /api/projects/:code/image` 镜像构建 | 201，30 秒内构建并推送，摘要 `sha256:36e0e067…` |
| 镜像库目录 | `GET https://registry.internal:5000/v2/_catalog` 返回 `qing-jia-shen-pi`，标签 `ac0a1f1f3359` |
| `POST /api/projects/:code/tests` 测试运行 | 409「测试执行器未配置：Midscene.js 与 Vitest 白盒入口在测试区接入」；测试库 `tst_qing-jia-shen-pi` 已重建，运行记录已落库 |
| `POST /api/projects/:code/publish` 发布确认 | 409「当前候选测试未全部通过」，发布门按设计拦住 |
| `POST /api/nodes` 登记节点、`PUT /api/nodes/:name/pool` | 201 / 200，`test.nodePool` 写入 `test-1` |

## 未打通的部分

- **真实测试执行**：第 5 阶段的 `TestExecutor` 仍需在测试区接入 Midscene.js 黑盒与 Vitest 白盒容器入口。平台侧编排、记录、回放与发布门已经生效，默认执行器按设计明确拒绝并说明原因，不会产生假的通过记录。
- **正式区节点**：本机没有正式区主机，`scheduler.defaultNodePool` 为空，发布在测试门之后仍会因为「默认节点池为空」被拒绝。
- **单库部署**：这台主机上正式库与测试库暂时用系统库所在的 PostgreSQL 实例（库名 `prd_` / `tst_` 前缀区分）。按设计它们应当在正式区和测试区各自的数据库服务器上，多主机部署时改 `deploy/.env` 的 `DATABASE_PROD_ADMIN_URL` 与 `DATABASE_TEST_ADMIN_URL` 即可。

## 代码位置

- `platform/scripts/deploy.sh`（安装步骤重建镜像、镜像库证书与解析）
- `platform/deploy/compose.server.yaml`（`registry` 服务、控制面挂载 docker 客户端与套接字、`ADMIN_RESET`）
- `platform/deploy/.dockerignore`（排除镜像库证书）
- `platform/apps/control-plane/src/install-admin.ts`（`reset` 选项）
- `platform/apps/control-plane/src/install.ts`（`ADMIN_RESET`）
- `platform/apps/control-plane/test/install-admin.test.ts`（重置行为测试）
