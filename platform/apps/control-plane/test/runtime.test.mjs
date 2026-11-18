import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileDesign } from "../src/compiler.js";
import { imageDockerfile, readRuntimeFiles } from "../src/images.js";
import { startModules } from "../src/runtime/server.mjs";

const design = {
  projectCode: "qing-jia-shen-pi",
  containerGroup: "qing-jia-shen-pi",
  menus: [{ code: "qing-jia-dan", name: "请假单", parentCode: null, sort: 1 }],
  grants: [{ principalType: "user", principalName: "employee", menuCode: "qing-jia-dan", action: "访问" }],
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
    expect(healthBody.projects).toEqual([{ code: "qing-jia-shen-pi", entities: 1, workflows: 1 }]);

    const menus = await fetch(`${base}/api/qing-jia-shen-pi/menus`);
    expect((await menus.json()).menus).toEqual([
      { code: "qing-jia-dan", name: "请假单", parentCode: null, sort: 1 },
    ]);

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
    expect(await form.text()).toContain('name="开始日期"');

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
  });
});
