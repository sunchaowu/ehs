import { afterEach, describe, expect, it } from "vitest";
import { reconcileAssignments } from "../src/node-agent.js";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

describe("node reconciliation", () => {
  it("does not start a container when the image pull fails", async () => {
    const started: string[] = [];
    const report = await reconcileAssignments(
      [{ projectCode: "qing-jia-shen-pi", imageDigest: "sha256:" + "ab".repeat(32), databaseName: "prd_qing-jia-shen-pi", replicas: 1 }],
      {
        pull: async () => ({ reason: "镜像拉取失败" }),
        start: async (input) => {
          started.push(input.image);
          return { running: true };
        },
        checkDatabase: async () => ({ connected: true }),
      },
    );
    expect(started).toEqual([]);
    expect(report.projects).toEqual([
      { code: "qing-jia-shen-pi", running: false, databaseConnected: false, imageDigest: "", reason: "镜像拉取失败" },
    ]);
  });
});

describe("healthy nodes publish the granted menus", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("publishes menus only after every target node reports the expected image", async () => {
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
    const configured = await openDatabase(databaseUrl!);
    const config = await configured.readConfig();
    await configured.saveConfig({ ...config, "test.requirePassBeforePublish": false });
    await configured.close();
    app = await buildServer({
      databaseUrl,
      imageBuilder: async (input) => ({ digest: input.sourceRevision }),
      databaseProvisioner: async () => ({ created: true }),
    });
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    const adminCookie = adminLogin.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const registeredUser = await app.inject({
      method: "POST",
      url: "/api/account/register",
      payload: { username: "employee", displayName: "员工", password: "secret-pass" },
    });
    const employeeCookie = registeredUser.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: adminCookie },
      payload: { name: "请假审批" },
    });
    const code = created.json().project.code as string;
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/members`,
      cookies: { platform_session: adminCookie },
      payload: { username: "employee", projectAdmin: false },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/menus`,
      cookies: { platform_session: adminCookie },
      payload: { name: "请假单" },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: adminCookie },
      payload: { principalType: "user", principalName: "employee", menu: "qing-jia-dan", actions: ["访问"] },
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
    const digest = image.json().digest as string;
    const node = await app.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: adminCookie },
      payload: { name: "prod-1", zone: "正式区" },
    });
    const token = node.json().token as string;
    await app.inject({
      method: "PUT",
      url: "/api/nodes/prod-1/pool",
      cookies: { platform_session: adminCookie },
      payload: { pool: "prod" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: adminCookie },
      payload: { name: "prod-2", zone: "正式区" },
    });
    const secondToken = second.json().token as string;
    await app.inject({
      method: "PUT",
      url: "/api/nodes/prod-2/pool",
      cookies: { platform_session: adminCookie },
      payload: { pool: "prod" },
    });
    const published = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: adminCookie },
    });
    expect(published.statusCode).toBe(202);
    const desired = await app.inject({
      method: "GET",
      url: "/api/nodes/prod-1/desired",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(desired.statusCode).toBe(200);
    expect(desired.json().projects).toEqual([{ code, imageDigest: digest, databaseName: "prd_qing-jia-shen-pi", replicas: 1 }]);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/nodes/prod-1/health",
      headers: { authorization: "Bearer wrong-token" },
      payload: { projects: [{ code, running: true, databaseConnected: true, imageDigest: digest }] },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ reason: "节点凭证无效" });
    await app.inject({
      method: "POST",
      url: "/api/nodes/prod-1/health",
      headers: { authorization: `Bearer ${token}` },
      payload: { projects: [{ code, running: false, databaseConnected: false, imageDigest: "", reason: "进程未运行" }] },
    });
    const waiting = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/release`,
      cookies: { platform_session: adminCookie },
    });
    expect(waiting.json().published).toBe(false);
    expect(waiting.json().nodes).toEqual(
      expect.arrayContaining([
        { name: "prod-1", healthy: false, reason: "进程未运行" },
        { name: "prod-2", healthy: false, reason: "尚未报告" },
      ]),
    );
    const hidden = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: employeeCookie },
    });
    expect(hidden.json()).toEqual({ menus: [] });
    await app.inject({
      method: "POST",
      url: "/api/nodes/prod-1/health",
      headers: { authorization: `Bearer ${token}` },
      payload: { projects: [{ code, running: true, databaseConnected: true, imageDigest: digest }] },
    });
    const stillHidden = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: employeeCookie },
    });
    expect(stillHidden.json()).toEqual({ menus: [] });
    await app.inject({
      method: "POST",
      url: "/api/nodes/prod-2/health",
      headers: { authorization: `Bearer ${secondToken}` },
      payload: { projects: [{ code, running: true, databaseConnected: true, imageDigest: digest }] },
    });
    const visible = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: employeeCookie },
    });
    expect(visible.json()).toEqual({ menus: [{ code: "qing-jia-dan", name: "请假单" }] });
    const adminMenus = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: adminCookie },
    });
    expect(adminMenus.json()).toEqual({ menus: [] });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/menus`,
      cookies: { platform_session: adminCookie },
      payload: { name: "假期余额" },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/confirm`,
      cookies: { platform_session: adminCookie },
    });
    const nextImage = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/image`,
      cookies: { platform_session: adminCookie },
    });
    const nextDigest = nextImage.json().digest as string;
    expect(nextDigest).not.toBe(digest);
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: adminCookie },
    });
    await app.inject({
      method: "POST",
      url: "/api/nodes/prod-1/health",
      headers: { authorization: `Bearer ${token}` },
      payload: { projects: [{ code, running: false, databaseConnected: false, imageDigest: "", reason: "进程未运行" }] },
    });
    const kept = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: employeeCookie },
    });
    expect(kept.json()).toEqual({ menus: [{ code: "qing-jia-dan", name: "请假单" }] });
    const keptRelease = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/release`,
      cookies: { platform_session: adminCookie },
    });
    expect(keptRelease.json().publishedDigest).toBe(digest);
  }, 15_000);
});
