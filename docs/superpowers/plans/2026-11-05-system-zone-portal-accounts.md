# 系统运行区、门户与账号 Implementation Plan

> **状态：** 2026-11-06 10:21:13 +0800 起停止使用。实现顺序改为先骨架、后内容和构件。当前计划见 `docs/superpowers/plans/2026-11-06-platform-skeleton.md`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立的系统运行区里跑起门户和控制面，完成安装、账号密码登录和按角色显示的管理入口；测试区与正式区只有隔离网络，没有业务容器。

**Architecture:** 浏览器只访问接入区的反向代理。代理把 443 转到系统运行区的门户和控制面。账号、会话和系统配置写入系统库。微信参数和模型参数来自系统配置；未配置微信时登录页不显示扫码。测试网络与正式网络互相不连接，本计划不在这两个区启动容器。

**Tech Stack:** Node.js 22、TypeScript、Fastify、Vitest、React 19、Vite、PostgreSQL 16、argon2、Caddy、Docker Compose。

**计划时间：** 2026-11-05 13:22:08 +0800

**来源规格：** `docs/superpowers/specs/2026-11-04-enterprise-harness-platform-design.md`

## Global Constraints

- 运行时自研，不依赖 DeepSeek Harness 的代码和进程。
- 密码使用 Argon2id。`password.argon2.memoryKiB` 默认 19456，`password.argon2.iterations` 默认 2，`password.argon2.parallelism` 默认 1。
- Cookie 为 HttpOnly、SameSite=Lax；门户使用 HTTPS 时同时标记 Secure。
- `registration.enabled` 默认 true。
- 界面语言至少包含 `zh-CN`。
- 微信的 `wechat.appId`、`wechat.appSecret`、`wechat.redirectUri` 默认是空。未配置时隐藏扫码入口并说明原因，账号密码登录保持可用。
- 安装创建一名初始平台管理员，随机密码只在安装输出中显示一次。
- 停用账号不能登录。
- 系统配置、插件配置、模型配置只对平台管理员显示。
- 系统运行、测试、正式分开部署。测试节点池不能回落到正式节点池。测试区与正式区之间不设路由。
- 互联网到接入区只开放 TCP 443。浏览器不连接数据库和节点。
- 密钥不写入镜像，不写入 Git。业务行为读取系统库里的配置。
- 失败时给出原因，不用匿名访问代替登录。
- 本计划不实现项目、菜单授权、编译发布、在线测试执行、OA 领域包和运维处置。那些各自另写计划。

---

## 文件结构

- `platform/package.json`：工作区脚本。
- `platform/apps/control-plane/src/config.ts`：读取系统配置。
- `platform/apps/control-plane/src/password.ts`：Argon2id。
- `platform/apps/control-plane/src/db.ts`：系统库连接和迁移。
- `platform/apps/control-plane/src/users.ts`：用户创建、登录、停用。
- `platform/apps/control-plane/src/sessions.ts`：Cookie 会话。
- `platform/apps/control-plane/src/auth-options.ts`：登录方式是否可见。
- `platform/apps/control-plane/src/navigation.ts`：按角色返回导航。
- `platform/apps/control-plane/src/server.ts`：HTTP 路由。
- `platform/apps/control-plane/src/install.ts`：初始管理员。
- `platform/apps/portal/src/App.tsx`：登录页和登录后的壳。
- `platform/deploy/compose.yaml`：接入区、系统运行区、空的测试区和正式区。
- `platform/scripts/dev.sh`：开发热加载。
- `platform/scripts/install.sh`：安装。

### Task 1: 工作区与健康检查

**Files:**
- Create: `platform/package.json`
- Create: `platform/tsconfig.json`
- Create: `platform/vitest.config.ts`
- Create: `platform/apps/control-plane/src/server.ts`
- Create: `platform/apps/control-plane/test/health.test.ts`
- Create: `platform/scripts/dev.sh`
- Create: `.gitignore`
- Test: `platform/apps/control-plane/test/health.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `buildServer(): Promise<FastifyInstance>`，`GET /health` 返回 `{ "status": "ok" }`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("GET /health", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  afterEach(async () => {
    await app.close();
  });

  it("returns ok", async () => {
    app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/health.test.ts`

Expected: FAIL，因为 `../src/server.js` 不存在。

- [ ] **Step 3: Write minimal implementation**

`platform/package.json`

```json
{
  "name": "enterprise-platform",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bash scripts/dev.sh",
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  },
  "dependencies": {
    "fastify": "^5.3.0"
  }
}
```

`platform/apps/control-plane/src/server.ts`

```ts
import Fastify, { type FastifyInstance } from "fastify";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
```

`platform/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["apps"]
}
```

`platform/vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["apps/**/test/**/*.test.ts"] },
});
```

`.gitignore`

```gitignore
node_modules/
dist/
.env
deepseek-harness/
```

`platform/scripts/dev.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec tsx watch apps/control-plane/src/dev.ts &
pnpm --dir apps/portal exec vite --host 127.0.0.1 &
wait
```

`apps/control-plane/src/dev.ts` 调用 `buildServer()` 后监听 `127.0.0.1` 和端口 `3000`。端口只来自环境变量 `PORT`，缺省 `3000`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform install && pnpm --dir platform exec vitest run apps/control-plane/test/health.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform .gitignore
git commit -m "feat: add control plane health check"
```

### Task 2: 系统配置

**Files:**
- Create: `platform/apps/control-plane/src/config.ts`
- Create: `platform/apps/control-plane/test/config.test.ts`
- Test: `platform/apps/control-plane/test/config.test.ts`

**Interfaces:**
- Consumes: 进程环境变量
- Produces: `loadSystemConfig(env: NodeJS.ProcessEnv): SystemConfig`。缺少 `DATABASE_SYSTEM_URL` 时抛出 `Error`，消息包含 `DATABASE_SYSTEM_URL`。

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { loadSystemConfig } from "../src/config.js";

describe("loadSystemConfig", () => {
  it("rejects a missing system database url", () => {
    expect(() => loadSystemConfig({})).toThrow(/DATABASE_SYSTEM_URL/);
  });

  it("uses install defaults when optional values are absent", () => {
    const config = loadSystemConfig({
      DATABASE_SYSTEM_URL: "postgres://platform@system-db:5432/platform",
    });
    expect(config.registrationEnabled).toBe(true);
    expect(config.languages).toEqual(["zh-CN"]);
    expect(config.wechatAppId).toBe("");
    expect(config.argon2).toEqual({
      memoryKiB: 19456,
      iterations: 2,
      parallelism: 1,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/config.test.ts`

Expected: FAIL，`loadSystemConfig` 未定义。

- [ ] **Step 3: Write minimal implementation**

```ts
export type SystemConfig = {
  platformTitle: string;
  languages: string[];
  registrationEnabled: boolean;
  wechatAppId: string;
  wechatAppSecret: string;
  wechatRedirectUri: string;
  modelBaseUrl: string;
  modelName: string;
  modelApiKey: string;
  databaseSystemUrl: string;
  databaseProdAdminUrl: string;
  databaseTestAdminUrl: string;
  registryAddress: string;
  publicOrigin: string;
  argon2: { memoryKiB: number; iterations: number; parallelism: number };
};

export function loadSystemConfig(env: NodeJS.ProcessEnv): SystemConfig {
  const databaseSystemUrl = env.DATABASE_SYSTEM_URL ?? "";
  if (databaseSystemUrl === "") {
    throw new Error("DATABASE_SYSTEM_URL is required");
  }
  return {
    platformTitle: env.PLATFORM_TITLE ?? "",
    languages: (env.PLATFORM_LANGUAGES ?? "zh-CN").split(",").filter(Boolean),
    registrationEnabled: (env.REGISTRATION_ENABLED ?? "true") === "true",
    wechatAppId: env.WECHAT_APP_ID ?? "",
    wechatAppSecret: env.WECHAT_APP_SECRET ?? "",
    wechatRedirectUri: env.WECHAT_REDIRECT_URI ?? "",
    modelBaseUrl: env.MODEL_BASE_URL ?? "",
    modelName: env.MODEL_NAME ?? "",
    modelApiKey: env.MODEL_API_KEY ?? "",
    databaseSystemUrl,
    databaseProdAdminUrl: env.DATABASE_PROD_ADMIN_URL ?? "",
    databaseTestAdminUrl: env.DATABASE_TEST_ADMIN_URL ?? "",
    registryAddress: env.REGISTRY_ADDRESS ?? "",
    publicOrigin: env.PUBLIC_ORIGIN ?? "",
    argon2: {
      memoryKiB: Number(env.ARGON2_MEMORY_KIB ?? 19456),
      iterations: Number(env.ARGON2_ITERATIONS ?? 2),
      parallelism: Number(env.ARGON2_PARALLELISM ?? 1),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/config.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/config.ts platform/apps/control-plane/test/config.test.ts
git commit -m "feat: load system config from the environment"
```

### Task 3: 密码散列

**Files:**
- Create: `platform/apps/control-plane/src/password.ts`
- Create: `platform/apps/control-plane/test/password.test.ts`
- Modify: `platform/package.json`
- Test: `platform/apps/control-plane/test/password.test.ts`

**Interfaces:**
- Consumes: `SystemConfig["argon2"]`
- Produces: `hashPassword(plain: string, options: SystemConfig["argon2"]): Promise<string>` 和 `verifyPassword(hash: string, plain: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.js";

const options = { memoryKiB: 19456, iterations: 2, parallelism: 1 };

describe("password", () => {
  it("verifies the original password and rejects another", async () => {
    const hash = await hashPassword("correct horse", options);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword(hash, "correct horse")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/password.test.ts`

Expected: FAIL，`hashPassword` 未定义。

- [ ] **Step 3: Write minimal implementation**

`platform/package.json` 的 `dependencies` 增加 `"argon2": "^0.43.0"`。

`platform/apps/control-plane/src/password.ts`

```ts
import argon2 from "argon2";

type Argon2Options = { memoryKiB: number; iterations: number; parallelism: number };

export async function hashPassword(plain: string, options: Argon2Options): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: options.memoryKiB,
    timeCost: options.iterations,
    parallelism: options.parallelism,
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/password.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform/package.json platform/pnpm-lock.yaml platform/apps/control-plane/src/password.ts platform/apps/control-plane/test/password.test.ts
git commit -m "feat: hash passwords with Argon2id"
```

### Task 4: 系统库用户

**Files:**
- Create: `platform/apps/control-plane/src/db.ts`
- Create: `platform/apps/control-plane/src/users.ts`
- Create: `platform/apps/control-plane/test/users.test.ts`
- Test: `platform/apps/control-plane/test/users.test.ts`

**Interfaces:**
- Consumes: `SystemConfig.databaseSystemUrl`、`hashPassword`
- Produces: `migrate(databaseUrl: string): Promise<void>`、`createUser(databaseUrl: string, input: { username: string; displayName: string; passwordHash: string; role: "platform_admin" | "user" }): Promise<{ id: string }>`、`findUserByUsername(databaseUrl: string, username: string): Promise<StoredUser | null>`

`StoredUser` 包含 `id`、`username`、`displayName`、`passwordHash`、`role`、`disabled`。

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { createUser, findUserByUsername } from "../src/users.js";

const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? "postgres://platform:platform@127.0.0.1:5432/platform_test";

describe("users", () => {
  afterAll(async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("drop table if exists users");
    await client.end();
  });

  it("rejects a duplicate username and misses an unknown user", async () => {
    await migrate(databaseUrl);
    await createUser(databaseUrl, { username: "ada", displayName: "Ada", passwordHash: "hash", role: "user" });
    await expect(createUser(databaseUrl, { username: "ada", displayName: "Ada", passwordHash: "hash", role: "user" })).rejects.toThrow(/ada/);
    expect(await findUserByUsername(databaseUrl, "missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/users.test.ts`

Expected: FAIL，`migrate` 未定义。

- [ ] **Step 3: Write minimal implementation**

`platform/package.json` 的 `dependencies` 增加 `"pg": "^8.14.0"`，`devDependencies` 增加 `"@types/pg": "^8.11.0"`。

`platform/apps/control-plane/src/db.ts`

```ts
import pg from "pg";

export async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`create table if not exists users (
    id uuid primary key,
    username text unique not null,
    display_name text not null,
    password_hash text not null,
    role text not null,
    disabled boolean not null default false
  )`);
  await client.end();
}
```

`platform/apps/control-plane/src/users.ts`

```ts
import { randomUUID } from "node:crypto";
import pg from "pg";

export type StoredUser = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: "platform_admin" | "user";
  disabled: boolean;
};

export async function createUser(databaseUrl: string, input: { username: string; displayName: string; passwordHash: string; role: StoredUser["role"] }): Promise<{ id: string }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const id = randomUUID();
  try {
    await client.query(
      "insert into users (id, username, display_name, password_hash, role) values ($1, $2, $3, $4, $5)",
      [id, input.username, input.displayName, input.passwordHash, input.role],
    );
    return { id };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new Error(`username already exists: ${input.username}`);
    }
    throw error;
  } finally {
    await client.end();
  }
}

export async function findUserByUsername(databaseUrl: string, username: string): Promise<StoredUser | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const result = await client.query("select id, username, display_name, password_hash, role, disabled from users where username = $1", [username]);
  await client.end();
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    disabled: row.disabled,
  };
}
```

开发脚本在系统运行区启动 PostgreSQL 16，不把 5432 发布到接入区。本机执行测试时只把系统库发布到 `127.0.0.1:5432`：

```bash
docker run --rm -d --name platform-system-db -p 127.0.0.1:5432:5432 -e POSTGRES_USER=platform -e POSTGRES_PASSWORD=platform -e POSTGRES_DB=platform_test postgres:16
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/users.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/db.ts platform/apps/control-plane/src/users.ts platform/apps/control-plane/test/users.test.ts
git commit -m "feat: store platform users in the system database"
```

### Task 5: 安装初始管理员

**Files:**
- Create: `platform/apps/control-plane/src/install.ts`
- Create: `platform/apps/control-plane/test/install.test.ts`
- Create: `platform/scripts/install.sh`
- Test: `platform/apps/control-plane/test/install.test.ts`

**Interfaces:**
- Consumes: `migrate`、`createUser`、`hashPassword`、`loadSystemConfig`
- Produces: `installInitialAdmin(databaseUrl: string, argon2: SystemConfig["argon2"]): Promise<{ username: "admin"; password: string; created: boolean }>`

- [ ] **Step 1: Write the failing test**

```ts
it("prints a password only when the admin is created", async () => {
  const first = await installInitialAdmin(databaseUrl, options);
  const second = await installInitialAdmin(databaseUrl, options);
  expect(first.created).toBe(true);
  expect(first.password).toHaveLength(24);
  expect(second.created).toBe(false);
  expect(second.password).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/install.test.ts`

Expected: FAIL，`installInitialAdmin` 未定义。

- [ ] **Step 3: Write minimal implementation**

`platform/apps/control-plane/src/install.ts`

```ts
import { randomBytes } from "node:crypto";
import type { SystemConfig } from "./config.js";
import { migrate } from "./db.js";
import { hashPassword } from "./password.js";
import { createUser, findUserByUsername } from "./users.js";

export async function installInitialAdmin(databaseUrl: string, argon2: SystemConfig["argon2"]): Promise<{ username: "admin"; password: string; created: boolean }> {
  await migrate(databaseUrl);
  const existing = await findUserByUsername(databaseUrl, "admin");
  if (existing) return { username: "admin", password: "", created: false };
  const password = randomBytes(18).toString("base64url");
  await createUser(databaseUrl, {
    username: "admin",
    displayName: "admin",
    passwordHash: await hashPassword(password, argon2),
    role: "platform_admin",
  });
  return { username: "admin", password, created: true };
}
```

`platform/scripts/install.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --experimental-strip-types --input-type=module -e '
import { loadSystemConfig } from "./apps/control-plane/src/config.ts";
import { installInitialAdmin } from "./apps/control-plane/src/install.ts";
const config = loadSystemConfig(process.env);
const result = await installInitialAdmin(config.databaseSystemUrl, config.argon2);
if (result.created) console.log(result.password);
'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/install.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/install.ts platform/apps/control-plane/test/install.test.ts platform/scripts/install.sh
git commit -m "feat: create the initial administrator once"
```

### Task 6: 注册、登录和停用

**Files:**
- Create: `platform/apps/control-plane/src/sessions.ts`
- Modify: `platform/apps/control-plane/src/server.ts`
- Create: `platform/apps/control-plane/test/auth.test.ts`
- Test: `platform/apps/control-plane/test/auth.test.ts`

**Interfaces:**
- Consumes: `StoredUser`、`verifyPassword`、`SystemConfig.registrationEnabled`、`SystemConfig.publicOrigin`
- Produces: `sessionCookie(token: string, secure: boolean): string`，以及路由 `POST /auth/register`、`POST /auth/login`、`POST /users/:id/disable`

- [ ] **Step 1: Write the failing test**

```ts
it("logs in after registration", async () => {
  const registered = await app.inject({ method: "POST", url: "/auth/register", payload: { username: "ada", displayName: "Ada", password: "secret" } });
  expect(registered.statusCode).toBe(201);
  const loggedIn = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "ada", password: "secret" } });
  expect(loggedIn.statusCode).toBe(200);
  expect(loggedIn.headers["set-cookie"]).toMatch(/HttpOnly/);
});

it("rejects an unknown password", async () => {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "ada", password: "wrong" } });
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ error: "invalid username or password" });
});

it("rejects a disabled account", async () => {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "disabled-user", password: "secret" } });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "account disabled" });
});

it("rejects registration when the switch is off", async () => {
  const response = await app.inject({ method: "POST", url: "/auth/register", payload: { username: "new", displayName: "New", password: "secret" } });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "registration is disabled" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/auth.test.ts`

Expected: FAIL，路由不存在，状态码 404。

- [ ] **Step 3: Write minimal implementation**

`platform/apps/control-plane/src/sessions.ts`

```ts
export function sessionCookie(token: string, secure: boolean): string {
  const base = `platform_session=${token}; HttpOnly; SameSite=Lax; Path=/`;
  return secure ? `${base}; Secure` : base;
}

export function cookieIsSecure(publicOrigin: string): boolean {
  return publicOrigin.startsWith("https://");
}
```

`POST /auth/login` 在用户不存在或密码不符时都返回 401 和 `{ "error": "invalid username or password" }`。`disabled === true` 时返回 403 和 `{ "error": "account disabled" }`。`registrationEnabled === false` 时 `POST /auth/register` 返回 403 和 `{ "error": "registration is disabled" }`，并且不调用 `createUser`。成功登录用 `sessionCookie(token, cookieIsSecure(config.publicOrigin))` 设置 `Set-Cookie`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/auth.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/sessions.ts platform/apps/control-plane/src/server.ts platform/apps/control-plane/test/auth.test.ts
git commit -m "feat: register and log in platform users"
```

### Task 7: 登录方式

**Files:**
- Create: `platform/apps/control-plane/src/auth-options.ts`
- Create: `platform/apps/control-plane/test/auth-options.test.ts`
- Modify: `platform/apps/control-plane/src/server.ts`
- Test: `platform/apps/control-plane/test/auth-options.test.ts`

**Interfaces:**
- Consumes: `SystemConfig` 的微信三项
- Produces: `authOptions(config: SystemConfig): { password: true; wechat: boolean; wechatDisabledReason: string }`，路由 `GET /auth/options`

- [ ] **Step 1: Write the failing test**

```ts
expect(authOptions({ ...config, wechatAppId: "", wechatAppSecret: "", wechatRedirectUri: "" })).toEqual({
  password: true,
  wechat: false,
  wechatDisabledReason: "微信登录未配置",
});
```

三项都非空时 `wechat` 为 true，`wechatDisabledReason` 为 `""`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/auth-options.test.ts`

Expected: FAIL，`authOptions` 未定义。

- [ ] **Step 3: Write minimal implementation**

`platform/apps/control-plane/src/auth-options.ts`

```ts
import type { SystemConfig } from "./config.js";

export function authOptions(config: SystemConfig): { password: true; wechat: boolean; wechatDisabledReason: string } {
  const wechat = config.wechatAppId !== "" && config.wechatAppSecret !== "" && config.wechatRedirectUri !== "";
  return { password: true, wechat, wechatDisabledReason: wechat ? "" : "微信登录未配置" };
}
```

`GET /auth/options` 返回 `authOptions(config)`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/auth-options.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/auth-options.ts platform/apps/control-plane/test/auth-options.test.ts platform/apps/control-plane/src/server.ts
git commit -m "feat: hide WeChat login until it is configured"
```

### Task 8: 门户导航

**Files:**
- Create: `platform/apps/control-plane/src/navigation.ts`
- Create: `platform/apps/control-plane/test/navigation.test.ts`
- Create: `platform/apps/portal/src/App.tsx`
- Create: `platform/apps/portal/src/main.tsx`
- Create: `platform/apps/portal/index.html`
- Modify: `platform/apps/control-plane/src/server.ts`
- Test: `platform/apps/control-plane/test/navigation.test.ts`

**Interfaces:**
- Consumes: `StoredUser.role`
- Produces: `navigationFor(role: "platform_admin" | "user"): Array<{ id: string; title: string }>`，路由 `GET /navigation`

- [ ] **Step 1: Write the failing test**

```ts
expect(navigationFor("user").map((item) => item.id)).toEqual([]);
expect(navigationFor("platform_admin").map((item) => item.id)).toEqual([
  "system-config",
  "plugin-config",
  "model-config",
]);
```

未登录调用 `GET /navigation` 返回 401，正文包含 `authentication required`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/navigation.test.ts`

Expected: FAIL，`navigationFor` 未定义。

- [ ] **Step 3: Write minimal implementation**

`platform/apps/control-plane/src/navigation.ts`

```ts
export function navigationFor(role: "platform_admin" | "user"): Array<{ id: string; title: string }> {
  if (role !== "platform_admin") return [];
  return [
    { id: "system-config", title: "系统配置" },
    { id: "plugin-config", title: "插件配置" },
    { id: "model-config", title: "模型配置" },
  ];
}
```

未登录的 `GET /navigation` 返回 401 和 `{ "error": "authentication required" }`。已登录时返回 `navigationFor(user.role)`。

`platform/apps/portal/src/App.tsx` 在登录后渲染三栏：左侧是 `platformTitle` 和导航标题，右上角是 `displayName`、`zh-CN` 和按钮文字 `配置`，右侧在导航为空时显示 `暂无可用菜单`。普通用户不渲染 `系统配置`、`插件配置`、`模型配置`。Vite 开发服务器由 Task 1 的 `platform/scripts/dev.sh` 启动。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/navigation.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/navigation.ts platform/apps/control-plane/test/navigation.test.ts platform/apps/control-plane/src/server.ts platform/apps/portal platform/scripts/dev.sh
git commit -m "feat: show admin navigation only to platform administrators"
```

### Task 9: 网络分区

**Files:**
- Create: `platform/deploy/compose.yaml`
- Create: `platform/deploy/Caddyfile`
- Create: `platform/apps/control-plane/test/compose-zones.test.ts`
- Test: `platform/apps/control-plane/test/compose-zones.test.ts`

**Interfaces:**
- Consumes: 无运行中的测试容器或正式容器
- Produces: `readZonePolicy(composeYaml: string): { publishedPorts: string[]; isolatedPairs: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readZonePolicy } from "../src/compose-zones.js";

describe("zone policy", () => {
  it("publishes only 443 and keeps test away from prod and the edge", () => {
    const policy = readZonePolicy(readFileSync(new URL("../../../deploy/compose.yaml", import.meta.url), "utf8"));
    expect(policy.publishedPorts).toEqual(["443:443"]);
    expect(policy.isolatedPairs).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/compose-zones.test.ts`

Expected: FAIL，文件不存在。

- [ ] **Step 3: Write minimal implementation**

`platform/apps/control-plane/src/compose-zones.ts`

```ts
import { parse } from "yaml";

type Compose = { services?: Record<string, { networks?: string[]; ports?: string[] }> };

export function readZonePolicy(composeYaml: string): { publishedPorts: string[]; isolatedPairs: boolean } {
  const compose = parse(composeYaml) as Compose;
  const services = Object.values(compose.services ?? {});
  const publishedPorts = services.flatMap((service) => service.ports ?? []);
  const isolatedPairs = services.every((service) => {
    const networks = new Set(service.networks ?? []);
    const crosses = (left: string, right: string) => networks.has(left) && networks.has(right);
    return !crosses("test", "prod") && !crosses("test", "edge") && !crosses("prod", "edge");
  });
  return { publishedPorts, isolatedPairs };
}
```

`platform/package.json` 的 `dependencies` 增加 `"yaml": "^2.7.0"`。

`platform/deploy/compose.yaml`

```yaml
networks:
  edge:
  system:
  test:
    internal: true
  prod:
    internal: true
services:
  proxy:
    image: caddy:2
    networks: [edge, system]
    ports: ["443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro"]
  portal:
    image: enterprise-platform-portal
    networks: [system]
  control-plane:
    image: enterprise-platform-control-plane
    networks: [system]
  system-db:
    image: postgres:16
    networks: [system]
    environment:
      POSTGRES_USER: platform
      POSTGRES_PASSWORD: platform
      POSTGRES_DB: platform
```

`platform/deploy/Caddyfile`

```caddyfile
{$PUBLIC_ORIGIN} {
  handle /api/* {
    reverse_proxy control-plane:3000
  }
  handle {
    reverse_proxy portal:5173
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/compose-zones.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add platform/deploy platform/apps/control-plane/test/compose-zones.test.ts
git commit -m "feat: isolate system, test, and production networks"
```

## 自检

- 规格第 5 节的密码、Cookie、注册、初始管理员、微信未配置和角色导航由 Task 3 到 Task 8 覆盖。
- 规格第 4.1 节的分区由 Task 9 覆盖。本计划不启动测试容器和正式容器。
- 项目、编译、在线测试执行、OA 和自动运维不在本计划中。
- 规格里的 `test.nodePool` 回落禁令留到节点计划实现；本计划的网络文件已经让测试区到不了接入区和正式区。

## 执行选择

计划保存于 `docs/superpowers/plans/2026-11-05-system-zone-portal-accounts.md`。
