import { afterEach, describe, expect, it, vi } from "vitest";

// 发布门槛用例串行全套时可能逼近默认 5 秒超时。
vi.setConfig({ testTimeout: 15_000 });
import { openDatabase } from "../src/database.js";
import { projectDatabaseName, registryWithPort, runDockerBuild } from "../src/images.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

const digest = `sha256:${"ab".repeat(32)}`;

describe("image digest and database name", () => {
  it("keeps a failed docker build from becoming an image digest", async () => {
    const failed = await runDockerBuild(async () => ({ code: 1, stderr: "docker 不存在", stdout: "" }), {
      registry: "registry.internal",
      projectCode: "qing-jia-shen-pi",
      sourceRevision: digest,
      files: { "modules/qing-jia-shen-pi/module.ts": "export const moduleDefinition = {};\n" },
    });
    expect(failed).toEqual({ reason: "docker 不存在" });
    const commands: string[][] = [];
    const built = await runDockerBuild(async (args) => {
      commands.push(args);
      if (args[0] === "build") {
        return { code: 0, stderr: "", stdout: `${digest}\n` };
      }
      return { code: 0, stderr: "", stdout: "" };
    }, {
      registry: "registry.internal",
      projectCode: "qing-jia-shen-pi",
      sourceRevision: digest,
      files: { "modules/qing-jia-shen-pi/module.ts": "export const moduleDefinition = {};\n" },
    });
    expect(built).toEqual({ digest });
    expect(commands.map((command) => command[0])).toEqual(["build", "push"]);
    expect(commands[1]?.join(" ")).toContain(`registry.internal:5000/qing-jia-shen-pi:`);
    expect(registryWithPort("registry.internal:5000")).toBe("registry.internal:5000");
    expect(registryWithPort("localhost:5001/team")).toBe("localhost:5001/team");
    expect(registryWithPort("registry.internal/team")).toBe("registry.internal:5000/team");
    const rejected = await runDockerBuild(async (args) => {
      if (args[0] === "push") {
        return { code: 1, stderr: "镜像库拒绝推送", stdout: "" };
      }
      return { code: 0, stderr: "", stdout: `${digest}\n` };
    }, {
      registry: "registry.internal",
      projectCode: "qing-jia-shen-pi",
      sourceRevision: digest,
      files: { "modules/qing-jia-shen-pi/module.ts": "export const moduleDefinition = {};\n" },
    });
    expect(rejected).toEqual({ reason: "镜像库拒绝推送" });
  });

  it("names the production database without colliding with the test database", () => {
    const code = "a".repeat(63);
    expect(projectDatabaseName("prd", code)).toHaveLength(63);
    expect(projectDatabaseName("tst", code)).toHaveLength(63);
    expect(projectDatabaseName("prd", code)).not.toBe(projectDatabaseName("tst", code));
    expect(projectDatabaseName("prd", "qing-jia-shen-pi")).toBe("prd_qing-jia-shen-pi");
  });
});

describe("release confirmation", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("refuses publication until an image, a passing test, a node pool, and a production database are all present", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const setup = await openDatabase(databaseUrl!);
    await setup.migrate();
    await setup.query("delete from sessions");
    await setup.query("delete from users");
    await setup.query("delete from nodes");
    await setup.close();
    const installed = await installInitialAdmin(databaseUrl!, {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    // 同一测试库被多个文件复用，显式清掉节点池，避免上一个测试留下配置。
    const resetConfig = await openDatabase(databaseUrl!);
    const initialConfig = await resetConfig.readConfig();
    await resetConfig.saveConfig({
      ...initialConfig,
      "test.nodePool": "",
      "scheduler.defaultNodePool": "",
      "test.requirePassBeforePublish": true,
    });
    await resetConfig.close();
    let provisions = 0;
    app = await buildServer({
      databaseUrl,
      imageBuilder: async () => ({ digest }),
      databaseProvisioner: async (input) => {
        provisions += 1;
        expect(input.databaseName).toBe("prd_qing-jia-shen-pi");
        return { created: true };
      },
    });
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    const adminCookie = adminLogin.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: adminCookie },
      payload: { name: "请假审批" },
    });
    const code = created.json().project.code as string;
    const tooSoon = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: adminCookie },
    });
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json()).toEqual({ reason: "还没有候选镜像" });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/menus`,
      cookies: { platform_session: adminCookie },
      payload: { name: "请假单" },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/confirm`,
      cookies: { platform_session: adminCookie },
    });
    const image = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/image`,
      cookies: { platform_session: adminCookie },
    });
    expect(image.statusCode).toBe(201);
    expect(image.json()).toEqual({ digest });
    const tests = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tools`,
      cookies: { platform_session: adminCookie },
      payload: { name: "run_tests" },
    });
    expect(tests.statusCode).toBe(409);
    expect(tests.json()).toEqual({ reason: "测试节点池为空" });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: adminCookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ reason: "当前候选测试未全部通过", failedCases: [] });
    expect(provisions).toBe(0);
    const configured = await openDatabase(databaseUrl!);
    const config = await configured.readConfig();
    await configured.saveConfig({ ...config, "test.requirePassBeforePublish": false });
    await configured.close();
    const noPool = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: adminCookie },
    });
    expect(noPool.statusCode).toBe(409);
    expect(noPool.json()).toEqual({ reason: "默认节点池为空" });
    const registered = await app.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: adminCookie },
      payload: { name: "prod-1", zone: "正式区" },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().node.pool).toBe("");
    await app.inject({
      method: "PUT",
      url: "/api/nodes/prod-1/pool",
      cookies: { platform_session: adminCookie },
      payload: { pool: "prod" },
    });
    const noDatabase = await openDatabase(databaseUrl!);
    const pooled = await noDatabase.readConfig();
    await noDatabase.saveConfig({ ...pooled, "database.prodAdminUrl": "" });
    await noDatabase.close();
    const missingDatabase = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: adminCookie },
    });
    expect(missingDatabase.statusCode).toBe(409);
    expect(missingDatabase.json()).toEqual({ reason: "正式库未配置" });
    const restored = await openDatabase(databaseUrl!);
    const ready = await restored.readConfig();
    await restored.saveConfig({ ...ready, "database.prodAdminUrl": "postgres://platform@127.0.0.1:5432/prod" });
    await restored.close();
    const waiting = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: adminCookie },
    });
    expect(waiting.statusCode).toBe(202);
    expect(waiting.json()).toEqual({ published: false, reason: "目标节点尚未报告健康", nodes: ["prod-1"] });
    expect(provisions).toBe(1);
    const menus = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: adminCookie },
    });
    expect(menus.json()).toEqual({ menus: [] });
    const overlap = await app.inject({
      method: "PUT",
      url: "/api/system-config",
      cookies: { platform_session: adminCookie },
      payload: { "scheduler.defaultNodePool": "prod-1", "test.nodePool": "prod-1" },
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json()).toEqual({ reason: "同一节点不能同时属于正式节点池和测试节点池" });
  });
});
