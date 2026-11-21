import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileDesign } from "../src/compiler.js";
import { imageDockerfile, readRuntimeDependencies, readRuntimeFiles } from "../src/images.js";
import { createPostgresStore } from "../src/runtime/index.mjs";
import { startModules } from "../src/runtime/server.mjs";

const design = {
  projectCode: "qing-jia-shen-pi",
  containerGroup: "qing-jia-shen-pi",
  menus: [{ code: "qing-jia-dan", name: "请假单", parentCode: null, sort: 1 }],
  grants: [
    { principalType: "user", principalName: "employee", menuCode: "qing-jia-dan", action: "访问" },
    { principalType: "role", principalName: "员工", menuCode: "qing-jia-dan", action: "访问" },
  ],
  entities: [
    {
      name: "请假单",
      fields: [
        { name: "申请人", type: "user" },
        { name: "开始日期", type: "date" },
        { name: "天数", type: "number" },
        { name: "员工", type: "ref", target: "员工" },
      ],
    },
  ],
  workflows: [{ name: "请假", steps: ["submit", "approve", "record"] }],
  extensions: [],
};

let running;
let directory;

afterEach(async () => {
  if (running) {
    await new Promise((resolve) => running.server.close(resolve));
  }
  running = undefined;
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

async function start() {
  directory = await mkdtemp(join(tmpdir(), "platform-runtime-"));
  // 镜像里运行库放在 node_modules/@platform/runtime，测试按同样布局准备。
  const runtimeDirectory = join(directory, "node_modules", "@platform", "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  for (const name of ["package.json", "index.mjs", "server.mjs"]) {
    await writeFile(join(runtimeDirectory, name), await readFile(new URL(`../src/runtime/${name}`, import.meta.url)));
  }
  const compiled = compileDesign(design);
  for (const [file, content] of Object.entries(compiled.files)) {
    const target = join(directory, ...file.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  running = await startModules({ modulesDir: join(directory, "modules"), port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${running.port}`;
}

describe("standard module runtime", () => {
  it("starts compiled modules and serves health, menus, records, forms, and workflows", async () => {
    const base = await start();

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody.status).toBe("ok");
    expect(healthBody.storage).toBe("memory");
    expect(healthBody.projects).toEqual([{ code: "qing-jia-shen-pi", entities: 1, workflows: 1 }]);

    const menus = await fetch(`${base}/api/qing-jia-shen-pi/menus`, {
      headers: { "x-platform-user": "employee" },
    });
    expect((await menus.json()).menus).toEqual([
      { code: "qing-jia-dan", name: "请假单", parentCode: null, sort: 1 },
    ]);

    const anonymous = await fetch(`${base}/api/qing-jia-shen-pi/menus`);
    expect(anonymous.status).toBe(401);

    const otherRole = await fetch(`${base}/api/qing-jia-shen-pi/menus`, {
      headers: { "x-platform-roles": encodeURIComponent("访客") },
    });
    expect(otherRole.status).toBe(200);
    expect((await otherRole.json()).menus).toEqual([]);

    const grantedRole = await fetch(`${base}/api/qing-jia-shen-pi/menus`, {
      headers: { "x-platform-roles": encodeURIComponent("员工") },
    });
    expect(grantedRole.status).toBe(200);
    expect((await grantedRole.json()).menus).toHaveLength(1);

    const deniedMenu = await fetch(`${base}/api/qing-jia-shen-pi/menus/qing-jia-dan`, {
      headers: { "x-platform-user": "other" },
    });
    expect(deniedMenu.status).toBe(403);
    expect((await deniedMenu.json()).reason).toBe("未授权访问");

    const allowedMenu = await fetch(`${base}/api/qing-jia-shen-pi/menus/qing-jia-dan`, {
      headers: { "x-platform-user": "employee" },
    });
    expect(allowedMenu.status).toBe(200);
    expect((await allowedMenu.json()).menu.name).toBe("请假单");

    const created = await fetch(`${base}/api/qing-jia-shen-pi/请假单`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ 申请人: "测试用户", 开始日期: "2000-01-01", 天数: 2, 员工: "ref:员工" }),
    });
    expect(created.status).toBe(201);
    const record = (await created.json()).record;
    expect(record).toMatchObject({ 申请人: "测试用户", 开始日期: "2000-01-01", 天数: 2 });
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);

    const invalid = await fetch(`${base}/api/qing-jia-shen-pi/请假单`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ 申请人: "测试用户", 开始日期: "not-a-date", 天数: 2, 员工: "ref:员工" }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toContain("开始日期");

    const unknown = await fetch(`${base}/api/qing-jia-shen-pi/请假单`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ 申请人: "测试用户", 开始日期: "2000-01-01", 天数: 2, 员工: "ref:员工", 多余: 1 }),
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).reason).toContain("未知字段");

    const listed = await fetch(`${base}/api/qing-jia-shen-pi/请假单`);
    expect((await listed.json()).records).toHaveLength(1);

    const form = await fetch(`${base}/p/qing-jia-shen-pi/请假单/form`);
    expect(form.status).toBe(200);
    const formHtml = await form.text();
    expect(formHtml).toContain('name="开始日期"');
    // 稳定标识与黑盒步骤 target 完全一致，供 Playwright 优先定位。
    expect(formHtml).toContain('data-testid="qing-jia-shen-pi/请假单/form"');
    expect(formHtml).toContain('data-testid="qing-jia-shen-pi/请假单/开始日期"');
    expect(formHtml).toContain('data-testid="qing-jia-shen-pi/请假单/submit"');

    const workflowPage = await fetch(`${base}/p/qing-jia-shen-pi/workflows/请假`);
    expect(workflowPage.status).toBe(200);
    expect(await workflowPage.text()).toContain('data-testid="qing-jia-shen-pi/请假/submit"');

    const submitted = await fetch(`${base}/p/qing-jia-shen-pi/请假单`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ 申请人: "测试用户", 开始日期: "2000-01-02", 天数: "1", 员工: "ref:员工" }),
      redirect: "manual",
    });
    expect(submitted.status).toBe(303);

    expect((await fetch(`${base}/api/qing-jia-shen-pi/workflows/请假/submit`, { method: "POST" })).status).toBe(200);
    const outOfOrder = await fetch(`${base}/api/qing-jia-shen-pi/workflows/请假/submit`, { method: "POST" });
    expect(outOfOrder.status).toBe(409);
    expect((await outOfOrder.json()).reason).toContain("approve");
  });

  it("rejects modules with an invalid definition", async () => {
    await expect(startModules({ modulesDir: join(tmpdir(), "platform-runtime-missing"), port: 0 })).rejects.toThrow();
  });

  it("ships the runtime and a start command in the generated image", async () => {
    const assets = await readRuntimeFiles();
    expect(Object.keys(assets).sort()).toEqual([
      "node_modules/@platform/runtime/index.mjs",
      "node_modules/@platform/runtime/package.json",
      "node_modules/@platform/runtime/server.mjs",
    ]);
    expect(assets["node_modules/@platform/runtime/package.json"]).toContain('"@platform/runtime"');
    const dockerfile = imageDockerfile();
    expect(dockerfile).toContain("COPY node_modules ./node_modules");
    expect(dockerfile).toContain('CMD ["node", "node_modules/@platform/runtime/server.mjs"]');
    // 黑盒执行器需要浏览器与 Midscene/Playwright，并固定定位路径。
    expect(dockerfile).toContain("chromium");
    expect(dockerfile).toContain("playwright @playwright/test @midscene/web");
    expect(dockerfile).toContain("PLATFORM_BROWSER_MODULE=/opt/test-harness/node_modules/playwright/index.mjs");
    expect(dockerfile).toContain("PLATFORM_MIDSCENE_MODULE=/opt/test-harness/node_modules/@midscene/web/dist/es/playwright/index.mjs");
    expect(dockerfile).toContain("MIDSCENE_MODEL_PROTOCOL=openai-chat");
    expect(dockerfile).toContain("MIDSCENE_MODEL_FAMILY=qwen2.5-vl");
    // 多行 RUN 必须以反斜杠续行，否则 Docker 会把后续行当成独立指令而构建失败。
    const aptRun = dockerfile.match(/RUN apt-get update[\s\S]*?lists\/\*/)?.[0] ?? "";
    expect(aptRun).toContain("recommends \\");
    expect(aptRun).toContain("libatk-bridge2.0-0 \\");
    expect(aptRun).toContain("xdg-utils \\");
    const harnessRun = dockerfile.match(/RUN mkdir -p \/opt\/test-harness[\s\S]*?@midscene\/web/)?.[0] ?? "";
    expect(harnessRun).toContain("cd /opt/test-harness \\");
    expect(harnessRun).toContain("npm init -y >/dev/null 2>&1 \\");
  });

  it("copies pg and its dependencies into the image", async () => {
    const dependencies = await readRuntimeDependencies();
    expect(dependencies["node_modules/pg/package.json"]).toContain('"name": "pg"');
    expect(dependencies["node_modules/pg-pool/package.json"]).toContain('"name": "pg-pool"');
    expect(dependencies["node_modules/pg-protocol/package.json"]).toContain('"name": "pg-protocol"');
    expect(dependencies["node_modules/pg-types/package.json"]).toContain('"name": "pg-types"');
    expect(Object.keys(dependencies).every((file) => file.startsWith("node_modules/"))).toBe(true);
  });

  it("keeps records and workflow positions in PostgreSQL through a fixed schema", async () => {
    const records = [];
    const workflows = new Map();
    const queries = [];
    const pool = {
      async query(text, params = []) {
        queries.push(text);
        if (text.startsWith("insert into platform_records")) {
          records.push({ entity: params[0], data: JSON.parse(params[2]) });
          return { rows: [] };
        }
        if (text.startsWith("select data from platform_records")) {
          return { rows: records.filter((row) => row.entity === params[0]) };
        }
        if (text.startsWith("delete from platform_records")) {
          const index = records.findIndex((row) => row.entity === params[0] && row.data.id === params[1]);
          if (index === -1) {
            return { rows: [] };
          }
          records.splice(index, 1);
          return { rows: [{ id: params[1] }] };
        }
        if (text.startsWith("select completed from platform_workflows")) {
          return { rows: workflows.has(params[0]) ? [{ completed: workflows.get(params[0]) }] : [] };
        }
        if (text.startsWith("insert into platform_workflows")) {
          const completed = (workflows.get(params[0]) ?? 0) + 1;
          workflows.set(params[0], completed);
          return { rows: [{ completed }] };
        }
        return { rows: [] };
      },
    };
    const store = createPostgresStore(pool);
    expect(store.kind).toBe("postgres");
    await store.ensureSchema();
    expect(queries.some((text) => text.includes("create table if not exists platform_records"))).toBe(true);

    const record = await store.insert("qing-jia-shen-pi", "请假单", { 申请人: "tester" });
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.list("qing-jia-shen-pi", "请假单")).toEqual([record]);
    expect(await store.list("qing-jia-shen-pi", "其他")).toEqual([]);

    expect(await store.workflowPosition("qing-jia-shen-pi", "请假")).toBe(0);
    expect(await store.advance("qing-jia-shen-pi", "请假")).toBe(0);
    expect(await store.workflowPosition("qing-jia-shen-pi", "请假")).toBe(1);

    expect(await store.remove("qing-jia-shen-pi", "请假单", record.id)).toBe(true);
    expect(await store.remove("qing-jia-shen-pi", "请假单", record.id)).toBe(false);
  });
});
