# 账号与系统配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成实现顺序第 2 项：安装初始管理员、密码登录，以及微信未配置时不显示扫码。

**Architecture:** 控制面把账号、登录态和系统配置写入系统库。进程启动只从环境变量 `DATABASE_SYSTEM_URL` 取得系统库连接，不在源码里写地址或密码。门户未登录时只显示登录和注册；登录后平台管理员才看到系统配置、插件配置和模型配置。微信身份交换通过可替换的客户端完成，测试不访问微信服务器。

**Tech Stack:** 现有 Node.js、TypeScript、Fastify、Vitest、React 19、Ant Design、Vite、PostgreSQL 16。本计划新增 `argon2`、`pg`、`@fastify/cookie`。

**计划时间：** 2026-11-11 09:01:48 +0800

**进度时间：** 2026-11-11 09:40:55 +0800。9 个任务已完成。2026-11-11 09:39:55 全量测试 12 个文件、22 个测试通过。提交 `c67e8d6`。控制面测试共用一个系统库，因此 node 项目使用单进程顺序执行。

**来源：** `docs/superpowers/specs/2026-11-04-enterprise-harness-platform-design.md` 第 5、11、12 节，以及 `docs/superpowers/specs/2026-11-05-enterprise-platform-overall-plan.md` 第 3、4.2、4.3 节。

## Global Constraints

- 密码使用 Argon2id。`password.argon2.memoryKiB` 为 19456，`password.argon2.iterations` 为 2，`password.argon2.parallelism` 为 1。
- 登录状态保存在服务端会话。Cookie 为 HttpOnly、SameSite=Lax；请求协议为 HTTPS 时同时标记 Secure。
- 初始管理员用户名是 `admin`。随机密码只出现在安装命令的标准输出，不写入文件、Git 或镜像。
- `registration.enabled` 默认 `true`。微信三项默认为空。未配置时登录页显示「微信登录未配置」，不渲染二维码。账号密码登录保持可用。
- 一个微信身份只绑定一个用户。注册关闭后，未绑定微信不创建用户，原因是「请联系管理员」。
- 停用账号不能登录，原因是「账号已停用」。
- 系统配置、插件配置、模型配置只出现在平台管理员导航。
- 界面语言至少包含 `zh-CN`。稳定标识使用 `platform/{页面}/{元素}`。
- 密钥不写入 Git，不写入镜像。缺少 `DATABASE_SYSTEM_URL` 时说明原因，不改用其他数据库。
- 不实现项目、需求会话、编译发布、Midscene、OA 菜单、HolmesGPT 处置和模型调用。
- `GET /health` 与 `GET /slots` 保持现有契约。插槽继续全部为 `attached: false`。

## 文件结构

- `platform/apps/control-plane/src/system-config.ts`：配置键、默认值和读取结果。
- `platform/apps/control-plane/src/schema.sql`：用户、会话、配置和插件表。
- `platform/apps/control-plane/src/database.ts`：系统库连接。
- `platform/apps/control-plane/src/passwords.ts`：Argon2id。
- `platform/apps/control-plane/src/install-admin.ts`：初始管理员。
- `platform/apps/control-plane/src/accounts.ts`：注册、登录、停用和管理员建用户。
- `platform/apps/control-plane/src/wechat.ts`：微信配置判断和回调。
- `platform/apps/control-plane/src/server.ts`：保留健康检查和插槽，增加 `/api` 路由。
- `platform/scripts/install.sh`：执行安装并打印一次密码。
- `platform/deploy/compose.dev.yaml`：只把系统库发布到 `127.0.0.1:5432`。正式 `compose.yaml` 仍只发布 `443:443`。
- `platform/apps/portal/src/App.tsx`：登录、注册、登录后的三栏和三个配置页。

### Task 1: 系统配置默认值

**Files:**
- Create: `platform/apps/control-plane/src/system-config.ts`
- Create: `platform/apps/control-plane/test/system-config.test.ts`
- Test: `platform/apps/control-plane/test/system-config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `SystemConfig`，以及 `defaultSystemConfig(input: { title: string; systemUrl: string; prodAdminUrl: string; testAdminUrl: string; registryAddress: string }): SystemConfig`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { defaultSystemConfig } from "../src/system-config.js";

describe("defaultSystemConfig", () => {
  it("uses the account defaults and keeps wechat and model empty", () => {
    const config = defaultSystemConfig({
      title: "企业应用平台",
      systemUrl: "postgres://platform@127.0.0.1:5432/platform",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    expect(config["platform.title"]).toBe("企业应用平台");
    expect(config["platform.languages"]).toEqual(["zh-CN"]);
    expect(config["registration.enabled"]).toBe(true);
    expect(config["wechat.appId"]).toBe("");
    expect(config["wechat.appSecret"]).toBe("");
    expect(config["wechat.redirectUri"]).toBe("");
    expect(config["model.baseUrl"]).toBe("");
    expect(config["model.name"]).toBe("");
    expect(config["model.apiKey"]).toBe("");
    expect(config["password.argon2.memoryKiB"]).toBe(19456);
    expect(config["password.argon2.iterations"]).toBe(2);
    expect(config["password.argon2.parallelism"]).toBe(1);
    expect(config["ops.heartbeatTimeoutSeconds"]).toBe(30);
    expect(config["ops.restartMaxAttempts"]).toBe(3);
    expect(config["ops.restartWindowSeconds"]).toBe(600);
    expect(config["ops.errorRateThreshold"]).toBe(0.05);
    expect(config["ops.errorRateWindowSeconds"]).toBe(300);
    expect(config["ops.minRequestsInWindow"]).toBe(20);
    expect(config["test.nodePool"]).toBe("");
    expect(config["test.requirePassBeforePublish"]).toBe(true);
    expect(config["test.stepTimeoutSeconds"]).toBe(30);
    expect(config["test.runTimeoutSeconds"]).toBe(900);
    expect(config["scheduler.defaultNodePool"]).toBe("");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/system-config.test.ts`

Expected: FAIL，`defaultSystemConfig` 不存在。

- [x] **Step 3: Write minimal implementation**

```ts
export type SystemConfig = {
  "platform.title": string;
  "platform.languages": string[];
  "registration.enabled": boolean;
  "wechat.appId": string;
  "wechat.appSecret": string;
  "wechat.redirectUri": string;
  "model.baseUrl": string;
  "model.name": string;
  "model.apiKey": string;
  "database.systemUrl": string;
  "database.prodAdminUrl": string;
  "database.testAdminUrl": string;
  "password.argon2.memoryKiB": number;
  "password.argon2.iterations": number;
  "password.argon2.parallelism": number;
  "registry.address": string;
  "scheduler.defaultNodePool": string;
  "ops.heartbeatTimeoutSeconds": number;
  "ops.restartMaxAttempts": number;
  "ops.restartWindowSeconds": number;
  "ops.errorRateThreshold": number;
  "ops.errorRateWindowSeconds": number;
  "ops.minRequestsInWindow": number;
  "test.nodePool": string;
  "test.requirePassBeforePublish": boolean;
  "test.stepTimeoutSeconds": number;
  "test.runTimeoutSeconds": number;
};

export function defaultSystemConfig(input: {
  title: string;
  systemUrl: string;
  prodAdminUrl: string;
  testAdminUrl: string;
  registryAddress: string;
}): SystemConfig {
  return {
    "platform.title": input.title,
    "platform.languages": ["zh-CN"],
    "registration.enabled": true,
    "wechat.appId": "",
    "wechat.appSecret": "",
    "wechat.redirectUri": "",
    "model.baseUrl": "",
    "model.name": "",
    "model.apiKey": "",
    "database.systemUrl": input.systemUrl,
    "database.prodAdminUrl": input.prodAdminUrl,
    "database.testAdminUrl": input.testAdminUrl,
    "password.argon2.memoryKiB": 19456,
    "password.argon2.iterations": 2,
    "password.argon2.parallelism": 1,
    "registry.address": input.registryAddress,
    "scheduler.defaultNodePool": "",
    "ops.heartbeatTimeoutSeconds": 30,
    "ops.restartMaxAttempts": 3,
    "ops.restartWindowSeconds": 600,
    "ops.errorRateThreshold": 0.05,
    "ops.errorRateWindowSeconds": 300,
    "ops.minRequestsInWindow": 20,
    "test.nodePool": "",
    "test.requirePassBeforePublish": true,
    "test.stepTimeoutSeconds": 30,
    "test.runTimeoutSeconds": 900,
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/system-config.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/system-config.ts platform/apps/control-plane/test/system-config.test.ts
git commit -m "feat: add system config defaults"
```

### Task 2: 系统库

**Files:**
- Create: `platform/apps/control-plane/src/schema.sql`
- Create: `platform/apps/control-plane/src/database.ts`
- Create: `platform/apps/control-plane/test/database.test.ts`
- Create: `platform/deploy/compose.dev.yaml`
- Modify: `platform/package.json`
- Test: `platform/apps/control-plane/test/database.test.ts`

**Interfaces:**
- Consumes: `SystemConfig`，`defaultSystemConfig`
- Produces: `openDatabase(databaseUrl: string): Promise<SystemDatabase>`。`SystemDatabase` 提供 `migrate()`、`saveConfig(config: SystemConfig)`、`readConfig(): Promise<SystemConfig>`、`close()`。

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { defaultSystemConfig } from "../src/system-config.js";

describe("system database", () => {
  it("requires the system database url and rounds a config trip", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    const config = defaultSystemConfig({
      title: "企业应用平台",
      systemUrl: databaseUrl!,
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    await database.saveConfig(config);
    expect(await database.readConfig()).toEqual(config);
    await database.close();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/database.test.ts`

Expected: FAIL，`openDatabase` 不存在。环境变量未设置时，失败原因必须包含 `缺少 DATABASE_SYSTEM_URL`，不能连接另一个库。

- [x] **Step 3: Write minimal implementation**

`platform/package.json` 增加依赖 `pg`。

`schema.sql` 创建四张表：

- `system_config(key text primary key, value text not null)`
- `users(id uuid primary key, username text unique not null, display_name text not null, password_hash text not null, disabled boolean not null, language text not null, wechat_open_id text unique, platform_admin boolean not null)`
- `sessions(id text primary key, user_id uuid not null references users(id), expires_at timestamptz not null)`
- `plugins(id text primary key, name text not null, enabled boolean not null, updated_at timestamptz not null)`

`openDatabase` 使用 `pg` 连接传入地址。`saveConfig` 把每个字段按字符串保存，布尔和数字在 `readConfig` 还原为 `SystemConfig` 的对应类型。`migrate` 重复执行不报错。

`platform/deploy/compose.dev.yaml` 只覆盖 `system-db`：镜像 `postgres:16`，`POSTGRES_USER` 和 `POSTGRES_DB` 为 `platform`，`POSTGRES_PASSWORD` 取环境变量且不写默认值，端口只绑定 `127.0.0.1:5432:5432`。不修改 `platform/deploy/compose.yaml` 的端口。

- [x] **Step 4: Run test to verify it passes**

先用 `compose.dev.yaml` 在本机启动系统库。`DATABASE_SYSTEM_URL` 由操作者提供，不写入仓库。

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/database.test.ts`

Expected: PASS。未设置 `DATABASE_SYSTEM_URL` 时 FAIL，原因包含 `缺少 DATABASE_SYSTEM_URL`。

- [x] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/schema.sql platform/apps/control-plane/src/database.ts platform/apps/control-plane/test/database.test.ts platform/deploy/compose.dev.yaml platform/package.json platform/pnpm-lock.yaml
git commit -m "feat: store system config in PostgreSQL"
```

### Task 3: Argon2id

**Files:**
- Create: `platform/apps/control-plane/src/passwords.ts`
- Create: `platform/apps/control-plane/test/passwords.test.ts`
- Modify: `platform/package.json`
- Test: `platform/apps/control-plane/test/passwords.test.ts`

**Interfaces:**
- Consumes: `SystemConfig["password.argon2.memoryKiB"]`、`password.argon2.iterations`、`password.argon2.parallelism`
- Produces: `hashPassword(plain: string, options: { memoryKiB: number; iterations: number; parallelism: number }): Promise<string>` 和 `verifyPassword(hash: string, plain: string): Promise<boolean>`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/passwords.js";

const options = { memoryKiB: 19456, iterations: 2, parallelism: 1 };

describe("passwords", () => {
  it("verifies the same password and rejects another", async () => {
    const hash = await hashPassword("correct horse", options);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword(hash, "correct horse")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse")).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/passwords.test.ts`

Expected: FAIL，`hashPassword` 不存在。

- [x] **Step 3: Write minimal implementation**

增加依赖 `argon2`。`hashPassword` 调用 `argon2.hash(plain, { type: argon2.argon2id, memoryCost: options.memoryKiB, timeCost: options.iterations, parallelism: options.parallelism })`。`verifyPassword` 调用 `argon2.verify`，校验异常时返回 `false`。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/passwords.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/passwords.ts platform/apps/control-plane/test/passwords.test.ts platform/package.json platform/pnpm-lock.yaml
git commit -m "feat: hash passwords with Argon2id"
```

### Task 4: 安装初始管理员

**Files:**
- Create: `platform/apps/control-plane/src/install-admin.ts`
- Create: `platform/apps/control-plane/src/install.ts`
- Create: `platform/scripts/install.sh`
- Create: `platform/apps/control-plane/test/install-admin.test.ts`
- Test: `platform/apps/control-plane/test/install-admin.test.ts`

**Interfaces:**
- Consumes: `openDatabase`、`defaultSystemConfig`、`hashPassword`
- Produces: `installInitialAdmin(databaseUrl: string, input: { title: string; prodAdminUrl: string; testAdminUrl: string; registryAddress: string }): Promise<{ username: "admin"; password: string; created: boolean }>`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { installInitialAdmin } from "../src/install-admin.js";

describe("installInitialAdmin", () => {
  it("prints a new password once and does not replace it", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const input = {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    };
    const first = await installInitialAdmin(databaseUrl!, input);
    const second = await installInitialAdmin(databaseUrl!, input);
    expect(first).toMatchObject({ username: "admin", created: true });
    expect(first.password).toHaveLength(24);
    expect(second).toEqual({ username: "admin", password: "", created: false });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/install-admin.test.ts`

Expected: FAIL，`installInitialAdmin` 不存在。

- [x] **Step 3: Write minimal implementation**

`installInitialAdmin` 迁移数据库，保存 `defaultSystemConfig`，其中 `database.systemUrl` 等于传入的 `databaseUrl`。`admin` 不存在时生成 24 位 URL 安全随机密码，保存 Argon2id 哈希和 `platform_admin=true`，返回明文密码。`admin` 已存在时不更新密码，返回空密码和 `created: false`。

`platform/apps/control-plane/src/install.ts` 读取 `DATABASE_SYSTEM_URL`、`PLATFORM_TITLE`、`DATABASE_PROD_ADMIN_URL`、`DATABASE_TEST_ADMIN_URL`、`REGISTRY_ADDRESS`。任一缺失时向标准错误写出缺失的变量名并以状态码 1 退出。成功且 `created` 为真时，只向标准输出写 `admin` 和一次密码。

`platform/scripts/install.sh` 从 `platform/` 执行 `tsx apps/control-plane/src/install.ts`。脚本不保存密码。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/install-admin.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/install-admin.ts platform/apps/control-plane/src/install.ts platform/apps/control-plane/test/install-admin.test.ts platform/scripts/install.sh
git commit -m "feat: install the initial administrator once"
```

### Task 5: 密码登录

**Files:**
- Create: `platform/apps/control-plane/src/accounts.ts`
- Modify: `platform/apps/control-plane/src/server.ts`
- Create: `platform/apps/control-plane/test/login.test.ts`
- Modify: `platform/package.json`
- Test: `platform/apps/control-plane/test/login.test.ts`

**Interfaces:**
- Consumes: `openDatabase`、`verifyPassword`
- Produces: `loginWithPassword(database: SystemDatabase, username: string, password: string): Promise<{ sessionId: string; user: PublicUser } | { reason: string }>`。`PublicUser` 为 `{ username: string; displayName: string; language: string; platformAdmin: boolean; wechatBound: boolean }`。`buildServer(options?: { databaseUrl?: string })` 增加 `POST /api/session/login` 和 `GET /api/session`。

- [x] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

describe("POST /api/session/login", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("sets an HttpOnly session cookie", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const installed = await installInitialAdmin(databaseUrl!, {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    app = await buildServer({ databaseUrl });
    const response = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ username: "admin", platformAdmin: true });
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(String(response.headers["set-cookie"])).not.toContain("Secure");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/login.test.ts`

Expected: FAIL，`/api/session/login` 不存在。

- [x] **Step 3: Write minimal implementation**

增加依赖 `@fastify/cookie`。登录成功写入 `sessions`，Cookie 名为 `platform_session`，有效期 12 小时。用户名或密码不匹配时返回 401 和 `{ reason: "用户名或密码错误" }`。`GET /api/session` 无有效 Cookie 时返回 401 和 `{ reason: "未登录" }`。`buildServer` 未收到数据库地址且环境变量也没有时，登录返回 503 和 `{ reason: "系统库未配置" }`。`GET /health` 与 `GET /slots` 不访问数据库。

HTTPS 注入测试另断言 Cookie 包含 `Secure`：

```ts
const secure = await app.inject({
  method: "POST",
  url: "/api/session/login",
  headers: { "x-forwarded-proto": "https" },
  payload: { username: "admin", password: installed.password },
});
expect(secure.headers["set-cookie"]).toContain("Secure");
```

`buildServer` 设置 `trustProxy: true`。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/login.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/accounts.ts platform/apps/control-plane/src/server.ts platform/apps/control-plane/test/login.test.ts platform/package.json platform/pnpm-lock.yaml
git commit -m "feat: sign in with a server-side session"
```

### Task 6: 注册、停用和管理员建用户

**Files:**
- Modify: `platform/apps/control-plane/src/accounts.ts`
- Modify: `platform/apps/control-plane/src/server.ts`
- Create: `platform/apps/control-plane/test/registration.test.ts`
- Test: `platform/apps/control-plane/test/registration.test.ts`

**Interfaces:**
- Consumes: `loginWithPassword`、`readConfig`
- Produces: `POST /api/account/register`、`POST /api/users`、`POST /api/users/:username/disable`

- [x] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { installInitialAdmin } from "../src/install-admin.js";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";

describe("registration and disabled accounts", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("rejects a disabled account and a closed registration", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const installed = await installInitialAdmin(databaseUrl!, {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    app = await buildServer({ databaseUrl });
    const registered = await app.inject({
      method: "POST",
      url: "/api/account/register",
      payload: { username: "employee", displayName: "员工", password: "secret-pass" },
    });
    expect(registered.statusCode).toBe(201);
    const employeeCookie = registered.cookies.find((cookie) => cookie.name === "platform_session")?.value ?? "";
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/users/employee/disable",
      cookies: { platform_session: employeeCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ reason: "需要平台管理员" });

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    const adminCookie = adminLogin.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const disable = await app.inject({
      method: "POST",
      url: "/api/users/employee/disable",
      cookies: { platform_session: adminCookie },
    });
    expect(disable.statusCode).toBe(204);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "employee", password: "secret-pass" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toEqual({ reason: "账号已停用" });

    const database = await openDatabase(databaseUrl!);
    const config = await database.readConfig();
    config["registration.enabled"] = false;
    await database.saveConfig(config);
    await database.close();
    const closed = await app.inject({
      method: "POST",
      url: "/api/account/register",
      payload: { username: "other", displayName: "其他人", password: "secret-pass" },
    });
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toEqual({ reason: "请联系管理员" });
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { platform_session: adminCookie },
      payload: { username: "other", displayName: "其他人", password: "secret-pass" },
    });
    expect(created.statusCode).toBe(201);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/registration.test.ts`

Expected: FAIL，`/api/account/register` 不存在。

- [x] **Step 3: Write minimal implementation**

注册在 `registration.enabled` 为真时创建非管理员用户并直接建立会话。用户名或显示名为空、密码为空时返回 400 和 `{ reason: "请输入用户名、显示名和密码" }`。用户名冲突返回 409 和 `{ reason: "用户名已存在" }`。管理员建用户使用同一套校验。停用只修改 `disabled`，不删除用户。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/registration.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/accounts.ts platform/apps/control-plane/src/server.ts platform/apps/control-plane/test/registration.test.ts
git commit -m "feat: register accounts and reject disabled users"
```

### Task 7: 微信未配置与回调

**Files:**
- Create: `platform/apps/control-plane/src/wechat.ts`
- Modify: `platform/apps/control-plane/src/server.ts`
- Create: `platform/apps/control-plane/test/wechat.test.ts`
- Test: `platform/apps/control-plane/test/wechat.test.ts`

**Interfaces:**
- Consumes: `SystemConfig` 的微信三项和 `registration.enabled`
- Produces: `wechatLoginAvailable(config: SystemConfig): boolean`，`POST /api/session/wechat/start`，`GET /api/session/wechat/callback`。`WechatClient` 为 `{ exchangeCode(code: string, config: { appId: string; appSecret: string; redirectUri: string }): Promise<{ openId: string }> }`。

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { defaultSystemConfig } from "../src/system-config.js";
import { wechatLoginAvailable } from "../src/wechat.js";

describe("wechatLoginAvailable", () => {
  it("is false until app id, secret, and redirect are all present", () => {
    const config = defaultSystemConfig({
      title: "企业应用平台",
      systemUrl: "postgres://platform@127.0.0.1:5432/platform",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    expect(wechatLoginAvailable(config)).toBe(false);
    config["wechat.appId"] = "wx-app";
    config["wechat.appSecret"] = "wx-secret";
    expect(wechatLoginAvailable(config)).toBe(false);
    config["wechat.redirectUri"] = "https://platform.example/api/session/wechat/callback";
    expect(wechatLoginAvailable(config)).toBe(true);
  });
});
```

```ts
it("does not start WeChat login when the three values are empty", async () => {
  const databaseUrl = process.env.DATABASE_SYSTEM_URL;
  expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
  const app = await buildServer({ databaseUrl, wechatClient: { async exchangeCode() { throw new Error("测试不能访问微信"); } } });
  const response = await app.inject({ method: "POST", url: "/api/session/wechat/start" });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ reason: "微信登录未配置" });
  await app.close();
});

it("rejects an unbound scan after registration is closed", async () => {
  const databaseUrl = process.env.DATABASE_SYSTEM_URL!;
  await installInitialAdmin(databaseUrl, {
    title: "企业应用平台",
    prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
    testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
    registryAddress: "registry.internal",
  });
  const database = await openDatabase(databaseUrl);
  const config = await database.readConfig();
  config["wechat.appId"] = "wx-app";
  config["wechat.appSecret"] = "wx-secret";
  config["wechat.redirectUri"] = "https://platform.example/api/session/wechat/callback";
  config["registration.enabled"] = false;
  await database.saveConfig(config);
  await database.close();
  const app = await buildServer({
    databaseUrl,
    wechatClient: { async exchangeCode() { return { openId: "wx-user" }; } },
  });
  const started = await app.inject({ method: "POST", url: "/api/session/wechat/start" });
  expect(started.statusCode).toBe(200);
  expect(started.json().url).toContain("open.weixin.qq.com/connect/qrconnect");
  expect(started.json().url).toContain("appid=wx-app");
  const callback = await app.inject({
    method: "GET",
    url: `/api/session/wechat/callback?code=demo-code&state=${started.json().state}`,
  });
  expect(callback.statusCode).toBe(403);
  expect(callback.json()).toEqual({ reason: "请联系管理员" });
  const missing = await app.inject({ method: "GET", url: "/api/session/wechat/callback?code=demo-code&state=missing" });
  expect(missing.statusCode).toBe(400);
  expect(missing.json()).toEqual({ reason: "扫码已失效，请重试" });
  await app.close();
});
```

已绑定的 `openId` 再次回调时返回 200 和已有用户，不创建第二个用户。未绑定且 `registration.enabled` 为真时返回 200，并在用户上保存该 `openId`。回调没有 `code` 时返回 400 和 `{ reason: "已取消扫码，请重试" }`。

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/wechat.test.ts`

Expected: FAIL，`wechatLoginAvailable` 不存在。

- [x] **Step 3: Write minimal implementation**

`wechatLoginAvailable` 仅在三个字符串都非空时返回真。`state` 保存 5 分钟。默认客户端留在 `createWechatClient()`，测试通过 `buildServer({ databaseUrl, wechatClient })` 替换。回调成功后沿用密码登录的 Cookie。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/wechat.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/wechat.ts platform/apps/control-plane/src/server.ts platform/apps/control-plane/test/wechat.test.ts
git commit -m "feat: hide WeChat login until it is configured"
```

### Task 8: 登录页和注册页

**Files:**
- Modify: `platform/apps/portal/src/App.tsx`
- Modify: `platform/apps/portal/src/App.test.tsx`
- Modify: `platform/apps/portal/vite.config.ts`
- Test: `platform/apps/portal/src/App.test.tsx`

**Interfaces:**
- Consumes: `GET /api/session`、`POST /api/session/login`、`POST /api/account/register`、`POST /api/session/wechat/start`
- Produces: 未登录页面。`platform/login/username`、`platform/login/password`、`platform/login/submit`、`platform/login/wechat-unavailable`。微信可用时才有 `platform/login/wechat-qr`。

- [x] **Step 1: Write the failing test**

替换 `App.test.tsx` 里对空工作台的直接渲染。`App` 接受 `session` 和 `wechatAvailable`，测试不访问网络。

```tsx
it("shows password login when WeChat is not configured", () => {
  render(<App session={null} wechatAvailable={false} />);
  expect(screen.getByTestId("platform/login/username")).toBeInTheDocument();
  expect(screen.getByTestId("platform/login/password")).toBeInTheDocument();
  expect(screen.getByTestId("platform/login/submit")).toBeInTheDocument();
  expect(screen.getByTestId("platform/login/wechat-unavailable")).toHaveTextContent("微信登录未配置");
  expect(screen.queryByTestId("platform/login/wechat-qr")).toBeNull();
  expect(screen.getByTestId("platform/login/card")).toHaveStyle({ width: "420px" });
});

it("shows the QR entry only after WeChat is configured", () => {
  render(<App session={null} wechatAvailable={true} />);
  expect(screen.getByTestId("platform/login/wechat-qr")).toBeInTheDocument();
  expect(screen.queryByTestId("platform/login/wechat-unavailable")).toBeNull();
});

it("keeps the login page and shows the returned reason", async () => {
  render(<App session={null} wechatAvailable={false} loginResult={{ reason: "用户名或密码错误" }} />);
  expect(await screen.findByText("用户名或密码错误")).toBeInTheDocument();
  expect(screen.getByTestId("platform/login/username")).toBeInTheDocument();
});

it("explains that registration is closed", () => {
  render(<App session={null} wechatAvailable={false} registrationEnabled={false} page="register" />);
  expect(screen.getByText("请联系管理员")).toBeInTheDocument();
  expect(screen.queryByTestId("platform/register/submit")).toBeNull();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/portal/src/App.test.tsx`

Expected: FAIL，登录标识不存在。

- [x] **Step 3: Write minimal implementation**

`App` 先请求 `GET /api/session`。401 时显示登录页。登录卡片宽 420，居中。提交调用 `POST /api/session/login`。Vite 把 `/api` 代理到 `http://127.0.0.1:3000`，保留 `/api` 前缀。测试里用注入的会话加载函数，不访问真实网络。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/portal/src/App.test.tsx`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/portal/src/App.tsx platform/apps/portal/src/App.test.tsx platform/apps/portal/vite.config.ts
git commit -m "feat: show password login without an unconfigured WeChat code"
```

### Task 9: 登录后的配置入口

**Files:**
- Modify: `platform/apps/portal/src/App.tsx`
- Modify: `platform/apps/portal/src/App.test.tsx`
- Modify: `platform/apps/control-plane/src/server.ts`
- Create: `platform/apps/control-plane/test/admin-config.test.ts`
- Test: `platform/apps/portal/src/App.test.tsx`

**Interfaces:**
- Consumes: `PublicUser`、`SystemConfig`
- Produces: 平台管理员导航 `platform/shell/nav-system-config`、`platform/shell/nav-plugin-config`、`platform/shell/nav-model-config`。普通用户看不到这三个标识。顶栏高 56，包含 `platform/shell/user`、`platform/shell/language`、`platform/shell/settings`。

- [x] **Step 1: Write the failing test**

```tsx
const admin = { username: "admin", displayName: "管理员", language: "zh-CN", platformAdmin: true, wechatBound: false };
const employee = { username: "employee", displayName: "员工", language: "zh-CN", platformAdmin: false, wechatBound: false };

it("shows the three settings links only to a platform administrator", () => {
  render(<App session={admin} title="企业应用平台" />);
  expect(screen.getByTestId("platform/shell/nav-system-config")).toHaveTextContent("系统配置");
  expect(screen.getByTestId("platform/shell/nav-plugin-config")).toHaveTextContent("插件配置");
  expect(screen.getByTestId("platform/shell/nav-model-config")).toHaveTextContent("模型配置");
  expect(screen.getByTestId("platform/shell/header")).toHaveStyle({ height: "56px" });
  expect(screen.getByTestId("platform/shell/user")).toHaveTextContent("管理员");
  expect(screen.getByTestId("platform/shell/language")).toHaveTextContent("zh-CN");
});

it("tells a user without menus to contact an administrator", () => {
  render(<App session={employee} title="企业应用平台" />);
  expect(screen.queryByTestId("platform/shell/nav-system-config")).toBeNull();
  expect(screen.queryByTestId("platform/shell/nav-plugin-config")).toBeNull();
  expect(screen.queryByTestId("platform/shell/nav-model-config")).toBeNull();
  expect(screen.getByTestId("platform/shell/content")).toHaveTextContent("联系管理员");
});
```

```ts
it("lets only a platform administrator change the title", async () => {
  const databaseUrl = process.env.DATABASE_SYSTEM_URL;
  expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
  const installed = await installInitialAdmin(databaseUrl!, {
    title: "企业应用平台",
    prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
    testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
    registryAddress: "registry.internal",
  });
  const app = await buildServer({ databaseUrl });
  const registered = await app.inject({
    method: "POST",
    url: "/api/account/register",
    payload: { username: "employee", displayName: "员工", password: "secret-pass" },
  });
  const employeeCookie = registered.cookies.find((cookie) => cookie.name === "platform_session")!.value;
  const forbidden = await app.inject({
    method: "PUT",
    url: "/api/system-config",
    cookies: { platform_session: employeeCookie },
    payload: { "platform.title": "新标题" },
  });
  expect(forbidden.statusCode).toBe(403);
  expect(forbidden.json()).toEqual({ reason: "需要平台管理员" });
  const adminLogin = await app.inject({
    method: "POST",
    url: "/api/session/login",
    payload: { username: "admin", password: installed.password },
  });
  const saved = await app.inject({
    method: "PUT",
    url: "/api/system-config",
    cookies: { platform_session: adminLogin.cookies.find((cookie) => cookie.name === "platform_session")!.value },
    payload: { "platform.title": "新标题", "wechat.appSecret": "" },
  });
  expect(saved.statusCode).toBe(200);
  const database = await openDatabase(databaseUrl!);
  expect((await database.readConfig())["platform.title"]).toBe("新标题");
  await database.close();
  await app.close();
});
```

系统配置页渲染标题、语言、注册开关、微信三项、正式库地址、测试库地址和镜像库地址。密钥输入框初始为空；已有密钥时显示「已配置」，没有密钥时显示「未配置」。模型三项都为空时显示「会话和运维智能体不会调用模型」。插件页无记录时显示「暂无插件」。个人配置提交显示名、密码和语言，并显示微信是否已绑定。空密钥字段调用保存接口时不覆盖原值。

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/portal/src/App.test.tsx apps/control-plane/test/admin-config.test.ts`

Expected: FAIL，管理员导航不存在。

- [x] **Step 3: Write minimal implementation**

三个页面只读写本计划列出的配置和插件记录。插件表保持为空，不预装插件。保存系统配置不调用模型，不创建项目。侧栏继续使用浅色主题和宽度 240。标题文本改为当前 `platform.title`。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform test`

Expected: PASS。原有健康检查、插槽和网络分区测试仍然通过。

- [x] **Step 5: Commit**

```bash
git add platform/apps/portal/src/App.tsx platform/apps/portal/src/App.test.tsx platform/apps/control-plane/src/server.ts platform/apps/control-plane/test/admin-config.test.ts
git commit -m "feat: limit system settings to platform administrators"
```

## 自检

- 第 2 项的完成标准有对应任务：Task 4 安装管理员，Task 5 密码登录，Task 7 和 Task 8 在微信未配置时不显示扫码。
- 规格中的注册、停用、微信绑定、管理员导航和个人配置分别落在 Task 6、Task 7 和 Task 9。
- 创建项目、需求会话、编译发布、在线测试执行、OA、运维处置和模型调用没有任务。
- `compose.yaml` 的公开端口不被本计划修改。系统库密码只通过环境变量进入本机开发用的 `compose.dev.yaml`。
- 计划没有要求把 `argon2` 写成插槽。骨架插槽清单保持原样。
