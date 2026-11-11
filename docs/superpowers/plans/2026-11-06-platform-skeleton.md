# 平台骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先搭起可运行的平台骨架：接入区、系统运行区、空的测试区和正式区、门户三栏、控制面健康检查，以及各阶段开源构件的空插槽。

**Architecture:** 浏览器只访问 Caddy 的 443。Caddy 把请求转到系统运行区的门户和控制面。控制面公布构件插槽，插槽在本计划中除界面壳以外都是未接入。测试区和正式区只有隔离网络，没有业务容器。内容和开源构件按文末顺序在后续计划里接入。

**Tech Stack:** Node.js 22、TypeScript、Fastify、Vitest、React 19、Ant Design、Vite、PostgreSQL 16、Caddy 2、Docker Compose。

**计划时间：** 2026-11-06 10:21:13 +0800

**进度时间：** 2026-11-11 08:57:22 +0800

**进度：** 四个任务已完成。分支 `platform-skeleton`，最新提交 `0ae926a`。2026-11-11 08:56:46 重新执行 `pnpm --dir platform test`，4 个文件、5 个测试通过。同一次检查里，`127.0.0.1:5173` 和 `127.0.0.1:3000` 连接失败，开发服务当前没有在监听。侧栏对比度修复在 `0ae926a`。账号、方案会话、生成发布、在线测试、OA、运维和本地模型都还没有开始。

**来源：** `docs/superpowers/specs/2026-11-05-enterprise-platform-overall-plan.md`

## Global Constraints

- 先骨架，后内容和构件。本计划不实现注册登录、项目会话、编译发布、Midscene 执行、OA 菜单和 HolmesGPT 处置。
- 运行时自研，不依赖 DeepSeek Harness 的代码和进程。
- 互联网到接入区只开放 TCP 443。测试区与正式区之间不设路由。
- 系统运行、测试、正式分开部署。系统运行服务器不加入测试节点池或正式节点池。
- 密钥不写入 Git，不写入镜像。
- 失败时给出原因。
- 门户可交互元素使用 `platform/{页面}/{元素}` 形式的稳定标识。
- 界面语言至少包含 `zh-CN`。

---

## 后续计划顺序

骨架可运行之后，再按这个顺序各写一份计划。每一份只接入对应构件，不提前写下一份的业务内容。

| 顺序 | 计划 | 接入的开源构件 | 完成后可以验证的事 |
|---|---|---|---|
| 1 | 本文 | Caddy、React、Ant Design、Vite、PostgreSQL、Docker | 门户三栏打开，五个网络分区存在，构件插槽全部列出 |
| 2 | 账号与系统配置 | argon2 | 安装管理员、密码登录、微信未配置时不显示扫码 |
| 3 | 方案与会话 | OpenSpec 的增量结构 | 草稿只记录新增、修改、删除，确认前不编译 |
| 4 | 生成与发布 | Docker Engine、Distribution `registry:2` | 正式区节点拉取镜像并更新正式容器 |
| 5 | 在线测试 | Midscene.js、Playwright、Vitest | 黑盒由 Midscene 执行，白盒由 Vitest 执行，未通过不能发布 |
| 6 | OA 内容 | 无新组件，使用已有生成器和 Midscene | 请假、审批、公告的菜单和案例出现在草稿中 |
| 7 | 运维 | OpenTelemetry Collector、Prometheus、VictoriaLogs、HolmesGPT | 正式区信号可查询，HolmesGPT 只读调查，重启由平台调度器执行 |
| 8 | 本地模型 | vLLM | 模型配置指向 vLLM 的兼容接口后，会话和运维调查才能调用模型 |

`docs/superpowers/plans/2026-11-05-system-zone-portal-accounts.md` 停止使用。账号改到第 2 份计划，避免骨架还没跑起来就写登录内容。

## 文件结构

- `platform/package.json`：脚本和依赖。
- `platform/apps/control-plane/src/server.ts`：健康检查和构件列表。
- `platform/apps/control-plane/src/slots.ts`：阶段插槽。
- `platform/apps/control-plane/src/compose-zones.ts`：读取网络分区。
- `platform/apps/portal/src/App.tsx`：Ant Design 三栏壳。
- `platform/deploy/compose.yaml`：Caddy、门户、控制面、系统库和两个空网络。
- `platform/deploy/Caddyfile`：只反代系统运行区。
- `platform/scripts/dev.sh`：前后端热加载。

### Task 1: 控制面健康检查

**Files:**
- Create: `platform/package.json`
- Create: `platform/tsconfig.json`
- Create: `platform/vitest.config.ts`
- Create: `platform/apps/control-plane/src/server.ts`
- Create: `platform/apps/control-plane/src/dev.ts`
- Create: `platform/apps/control-plane/test/health.test.ts`
- Create: `.gitignore`
- Test: `platform/apps/control-plane/test/health.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `buildServer(): Promise<FastifyInstance>`，`GET /health` 返回 `{ "status": "ok" }`

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/health.test.ts`

Expected: FAIL，`../src/server.js` 不存在。

- [x] **Step 3: Write minimal implementation**

`platform/package.json`

```json
{
  "name": "enterprise-platform",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bash scripts/dev.sh",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  },
  "dependencies": {
    "fastify": "^5.3.0"
  }
}
```

`platform/tsconfig.json` 设置 `"module": "NodeNext"`、`"moduleResolution": "NodeNext"`、`"strict": true`，`include` 为 `["apps"]`。

`platform/vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["apps/**/test/**/*.test.ts"] },
});
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

`platform/apps/control-plane/src/dev.ts` 调用 `buildServer()`，监听 `127.0.0.1` 和 `process.env.PORT ?? "3000"`。

`.gitignore` 包含 `node_modules/`、`dist/`、`.env`、`deepseek-harness/`。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform install && pnpm --dir platform exec vitest run apps/control-plane/test/health.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add .gitignore platform
git commit -m "feat: add the control plane health check"
```

### Task 2: 阶段构件插槽

**Files:**
- Create: `platform/apps/control-plane/src/slots.ts`
- Modify: `platform/apps/control-plane/src/server.ts`
- Create: `platform/apps/control-plane/test/slots.test.ts`
- Test: `platform/apps/control-plane/test/slots.test.ts`

**Interfaces:**
- Consumes: `buildServer`
- Produces: `listSlots(): Slot[]`。`Slot` 为 `{ id: string; stage: string; component: string; attached: boolean }`。`GET /slots` 返回 `{ slots: Slot[] }`。

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { listSlots } from "../src/slots.js";

describe("listSlots", () => {
  it("lists every stage component and leaves them unattached", () => {
    const slots = listSlots();
    expect(slots.map((slot) => slot.component)).toEqual([
      "OpenSpec",
      "Caddy",
      "Ant Design",
      "Midscene.js",
      "Playwright",
      "Vitest",
      "OpenTelemetry Collector",
      "Prometheus",
      "VictoriaLogs",
      "HolmesGPT",
      "vLLM",
    ]);
    expect(slots.every((slot) => slot.attached === false)).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/slots.test.ts`

Expected: FAIL，`listSlots` 未定义。

- [x] **Step 3: Write minimal implementation**

```ts
export type Slot = { id: string; stage: string; component: string; attached: boolean };

export function listSlots(): Slot[] {
  return [
    { id: "openspec", stage: "solution", component: "OpenSpec", attached: false },
    { id: "caddy", stage: "edge", component: "Caddy", attached: false },
    { id: "antd", stage: "ui", component: "Ant Design", attached: false },
    { id: "midscene", stage: "test", component: "Midscene.js", attached: false },
    { id: "playwright", stage: "test", component: "Playwright", attached: false },
    { id: "vitest", stage: "test", component: "Vitest", attached: false },
    { id: "otel", stage: "ops", component: "OpenTelemetry Collector", attached: false },
    { id: "prometheus", stage: "ops", component: "Prometheus", attached: false },
    { id: "victoria-logs", stage: "ops", component: "VictoriaLogs", attached: false },
    { id: "holmes", stage: "ops", component: "HolmesGPT", attached: false },
    { id: "vllm", stage: "model", component: "vLLM", attached: false },
  ];
}
```

`GET /slots` 返回 `{ slots: listSlots() }`。本任务不安装这些组件，也不把 `attached` 改成 true。Caddy 和 Ant Design 要到 Task 3、Task 4 的运行环境里才算接入；插槽清单仍保持 `attached: false`，后续计划每接入一个构件就只改对应的那一项。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/slots.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/control-plane/src/slots.ts platform/apps/control-plane/src/server.ts platform/apps/control-plane/test/slots.test.ts
git commit -m "feat: list stage component slots"
```

### Task 3: 门户骨架

**Files:**
- Create: `platform/apps/portal/package.json`
- Create: `platform/apps/portal/index.html`
- Create: `platform/apps/portal/src/main.tsx`
- Create: `platform/apps/portal/src/App.tsx`
- Create: `platform/apps/portal/src/App.test.tsx`
- Create: `platform/scripts/dev.sh`
- Test: `platform/apps/portal/src/App.test.tsx`

**Interfaces:**
- Consumes: 无控制面账号
- Produces: 页面根节点 `data-testid="platform/shell/root"`。左侧 `platform/shell/title` 文本为 `企业应用平台`。右侧内容 `platform/shell/content` 文本为 `暂无可用菜单`。右侧会话栏不渲染。

- [x] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("portal shell", () => {
  it("shows the empty workbench", () => {
    render(<App />);
    expect(screen.getByTestId("platform/shell/title")).toHaveTextContent("企业应用平台");
    expect(screen.getByTestId("platform/shell/content")).toHaveTextContent("暂无可用菜单");
    expect(screen.queryByTestId("platform/shell/conversation")).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/portal/src/App.test.tsx`

Expected: FAIL，`App` 未定义。

- [x] **Step 3: Write minimal implementation**

`platform/apps/portal/package.json` 依赖 `react`、`react-dom`、`antd`，开发依赖 `vite`、`@vitejs/plugin-react`、`jsdom`、`@testing-library/react`。

`platform/apps/portal/src/App.tsx`

```tsx
import { Layout, Typography } from "antd";

const { Header, Sider, Content } = Layout;

export function App() {
  return (
    <Layout data-testid="platform/shell/root" style={{ minHeight: "100vh" }}>
      <Sider width={240}>
        <Typography.Title level={4} data-testid="platform/shell/title">企业应用平台</Typography.Title>
      </Sider>
      <Layout>
        <Header data-testid="platform/shell/header" />
        <Content data-testid="platform/shell/content">暂无可用菜单</Content>
      </Layout>
    </Layout>
  );
}
```

`platform/scripts/dev.sh` 同时启动 `tsx watch apps/control-plane/src/dev.ts` 和 `pnpm --dir apps/portal exec vite --host 127.0.0.1`。两个进程都热加载。脚本不写入模型地址或数据库密码。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/portal/src/App.test.tsx`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/apps/portal platform/scripts/dev.sh platform/vitest.config.ts
git commit -m "feat: add the empty portal shell"
```

### Task 4: 网络分区骨架

**Files:**
- Create: `platform/deploy/compose.yaml`
- Create: `platform/deploy/Caddyfile`
- Create: `platform/apps/control-plane/src/compose-zones.ts`
- Create: `platform/apps/control-plane/test/compose-zones.test.ts`
- Test: `platform/apps/control-plane/test/compose-zones.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `readZonePolicy(composeYaml: string): { publishedPorts: string[]; isolatedPairs: boolean }`

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/compose-zones.test.ts`

Expected: FAIL，`deploy/compose.yaml` 不存在。

- [x] **Step 3: Write minimal implementation**

`platform/package.json` 增加依赖 `yaml`。

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

`platform/deploy/compose.yaml` 定义网络 `edge`、`system`、`test`、`prod`。`test` 和 `prod` 为 `internal: true`。服务只有 `proxy`、`portal`、`control-plane`、`system-db`。`proxy` 使用 `caddy:2`，加入 `edge` 和 `system`，只发布 `443:443`。其余服务只加入 `system`。`system-db` 使用 `postgres:16`，不发布端口。不创建 Midscene、Prometheus、vLLM 或业务容器。

`platform/deploy/Caddyfile` 只把 `/api/*` 转到 `control-plane:3000`，其余转到 `portal:5173`。不写测试区或正式区上游。

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir platform exec vitest run apps/control-plane/test/compose-zones.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add platform/deploy platform/apps/control-plane/src/compose-zones.ts platform/apps/control-plane/test/compose-zones.test.ts platform/package.json
git commit -m "feat: add isolated edge, system, test, and production networks"
```

## 自检

核对时间：2026-11-11 08:57:22 +0800。

- 总体计划第 7 节的每个开源组件都有插槽，本计划不把它们标成已接入。`listSlots()` 仍全部是 `attached: false`。
- 网络分区只允许接入区到系统运行区，测试区和正式区没有容器。`readZonePolicy` 测试仍要求只发布 `443:443`，并且测试区不与正式区或接入区同属一个服务。
- 账号、OpenSpec 内容、镜像发布、Midscene 执行、OA 和 HolmesGPT 处置都在后续计划，不在本文任务里。这三项在当前代码里仍然成立。
- 门户标题在深色侧栏上不可读。2026-11-09 已把侧栏改为浅色，测试断言 `ant-layout-sider-light`。
- `portal` 与 `control-plane` 只有镜像名，没有构建文件。系统库没有写入密码。这两项留到生成发布计划，不在本计划里补做。
