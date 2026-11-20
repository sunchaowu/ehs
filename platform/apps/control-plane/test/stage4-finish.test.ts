import { afterEach, describe, expect, it } from "vitest";
import { issueNodeCertificate, nodeInstallScript } from "../src/node-install.js";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

describe("node install script", () => {
  it("keeps a failed certificate command from producing a certificate", async () => {
    const failed = await issueNodeCertificate(async () => ({ code: 1, stderr: "openssl 不存在", stdout: "" }), "prod-1");
    expect(failed).toEqual({ reason: "openssl 不存在" });
  });

  it("dials out with the node certificate and does not embed a database url", () => {
    const script = nodeInstallScript({
      nodeName: "prod-1",
      controlPlaneUrl: "https://platform.internal",
      token: "node-token",
      certificate: "CERT-DATA",
      privateKey: "KEY-DATA",
      caCertificate: "CA-DATA",
    });
    expect(script).toContain("prod-1");
    expect(script).toContain("https://platform.internal");
    expect(script).toContain("CERT-DATA");
    expect(script).toContain("KEY-DATA");
    expect(script).toContain("CA-DATA");
    expect(script).toContain("agent.mjs");
    expect(script).toContain("test-runner.mjs");
    expect(script).toContain("docker");
    expect(script).toContain("database.url");
    expect(script).toContain("PLATFORM_DATABASE_URL_TEMPLATE");
    expect(script).toContain('health.storage === "postgres"');
    expect(script).toContain("runtime.mode=test");
    expect(script).not.toContain("postgres://");
    expect(script).toContain("127.0.0.1::8080");
    expect(script).toContain("startGateway");
    expect(script).toContain("PLATFORM_NODE_GATEWAY_PORT");
  });
});

describe("shared container publication", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("builds every confirmed module, notifies the other project admin, and can cancel before deploy", async () => {
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
    let builtFiles: Record<string, string> = {};
    app = await buildServer({
      databaseUrl,
      imageBuilder: async (input) => {
        builtFiles = input.files;
        return { digest: input.sourceRevision };
      },
      databaseProvisioner: async () => ({ created: true }),
      certificateIssuer: async () => ({ certificate: "CERT-DATA", privateKey: "KEY-DATA", caCertificate: "CA-DATA" }),
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
      payload: { username: "owner", displayName: "负责人", password: "secret-pass" },
    });
    const ownerCookie = registeredUser.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const leave = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: adminCookie },
      payload: { name: "请假", code: "leave" },
    });
    expect(leave.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/api/projects/leave/members",
      cookies: { platform_session: adminCookie },
      payload: { username: "owner", projectAdmin: true },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/leave/menus",
      cookies: { platform_session: adminCookie },
      payload: { name: "请假单" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/leave/confirm",
      cookies: { platform_session: adminCookie },
    });
    const stock = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: adminCookie },
      payload: { name: "库存", code: "stock", containerGroup: "leave" },
    });
    expect(stock.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/api/projects/stock/menus",
      cookies: { platform_session: adminCookie },
      payload: { name: "入库" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/stock/confirm",
      cookies: { platform_session: adminCookie },
    });
    const image = await app.inject({
      method: "POST",
      url: "/api/projects/stock/image",
      cookies: { platform_session: adminCookie },
    });
    expect(image.statusCode).toBe(201);
    expect(Object.keys(builtFiles).some((file) => file.startsWith("modules/leave/"))).toBe(true);
    expect(Object.keys(builtFiles).some((file) => file.startsWith("modules/stock/"))).toBe(true);
    expect(JSON.stringify(builtFiles)).not.toContain("postgres://");
    const node = await app.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: adminCookie },
      payload: { name: "prod-1", zone: "正式区" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/nodes/prod-1/pool",
      cookies: { platform_session: adminCookie },
      payload: { pool: "prod" },
    });
    const install = await app.inject({
      method: "GET",
      url: "/api/nodes/prod-1/install",
      cookies: { platform_session: adminCookie },
      headers: { host: "platform.internal", "x-forwarded-proto": "https" },
    });
    expect(install.statusCode).toBe(200);
    expect(install.body).toContain("CERT-DATA");
    expect(install.body).toContain("https://platform.internal");
    expect(install.body).not.toContain("postgres://");
    const systemNode = await app.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: adminCookie },
      payload: { name: "sys-1", zone: "系统运行区" },
    });
    expect(systemNode.statusCode).toBe(201);
    const systemInstall = await app.inject({
      method: "GET",
      url: "/api/nodes/sys-1/install",
      cookies: { platform_session: adminCookie },
      headers: { host: "platform.internal" },
    });
    expect(systemInstall.statusCode).toBe(400);
    expect(systemInstall.json()).toEqual({ reason: "系统运行区节点不生成安装脚本" });
    const denied = await app.inject({
      method: "POST",
      url: "/api/projects/stock/publish",
      cookies: { platform_session: ownerCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ reason: "没有项目管理权限" });
    const published = await app.inject({
      method: "POST",
      url: "/api/projects/stock/publish",
      cookies: { platform_session: adminCookie },
    });
    expect(published.statusCode).toBe(202);
    await published.json();
    const notices = await app.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: { platform_session: ownerCookie },
    });
    expect(notices.statusCode).toBe(200);
    expect(notices.json().notifications.map((item: { body: string }) => item.body)).toContain("容器组 leave 将随项目 stock 一起更新");
    const release = await app.inject({
      method: "GET",
      url: "/api/projects/stock/release",
      cookies: { platform_session: adminCookie },
    });
    expect(release.json().containerGroup).toBe("leave");
    expect(release.json().otherProjects).toEqual([{ code: "leave", name: "请假" }]);
    expect(release.json().designSummary).toEqual(["入库"]);
    expect(release.json().candidateDigest).toBe(image.json().digest);
    expect(release.json().testResult).toEqual({ required: false });
    const token = node.json().token as string;
    await app.inject({
      method: "POST",
      url: "/api/nodes/prod-1/health",
      headers: { authorization: `Bearer ${token}` },
      payload: { projects: [{ code: "stock", running: false, databaseConnected: false, imageDigest: "", reason: "容器更新失败" }] },
    });
    const failed = await app.inject({
      method: "GET",
      url: "/api/projects/stock/release",
      cookies: { platform_session: adminCookie },
    });
    expect(failed.json().published).toBe(false);
    expect(failed.json().nodes).toEqual([{ name: "prod-1", healthy: false, reason: "容器更新失败：prd_stock" }]);
    const menus = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: adminCookie },
    });
    expect(menus.json()).toEqual({ menus: [] });
    const cancelled = await app.inject({
      method: "POST",
      url: "/api/projects/stock/publish/cancel",
      cookies: { platform_session: adminCookie },
    });
    expect(cancelled.statusCode).toBe(200);
    const afterCancel = await app.inject({
      method: "GET",
      url: "/api/projects/stock/release",
      cookies: { platform_session: adminCookie },
    });
    expect(afterCancel.json().desiredDigest).toBeNull();
    expect(afterCancel.json().candidateDigest).toBe(image.json().digest);
    expect(afterCancel.json().published).toBe(false);
  }, 30000);
});
