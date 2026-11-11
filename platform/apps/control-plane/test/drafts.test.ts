import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

describe("drafts and requirement sessions", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("shares one draft, isolates conversations, and does not publish menus", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    app = await buildServer({ databaseUrl });
    const registered = await app.inject({
      method: "POST",
      url: "/api/account/register",
      payload: { username: "employee", displayName: "员工", password: "secret-pass" },
    });
    const employeeCookie = registered.cookies.find((cookie) => cookie.name === "platform_session")!.value;
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
    const other = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: adminCookie },
      payload: { name: "库存" },
    });
    const otherCode = other.json().project.code as string;
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/members`,
      cookies: { platform_session: adminCookie },
      payload: { username: "employee", projectAdmin: true },
    });
    const menu = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/menus`,
      cookies: { platform_session: adminCookie },
      payload: { name: "请假单" },
    });
    expect(menu.statusCode).toBe(201);
    const shared = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/draft`,
      cookies: { platform_session: employeeCookie },
    });
    expect(shared.json().menus).toEqual([{ code: "qing-jia-dan", name: "请假单" }]);
    const cross = await app.inject({
      method: "POST",
      url: `/api/projects/${otherCode}/menus`,
      cookies: { platform_session: employeeCookie },
      payload: { name: "入库" },
    });
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toEqual({ reason: "没有项目管理权限" });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/messages`,
      cookies: { platform_session: adminCookie },
      payload: { body: "管理员的需求" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ reason: "会话和运维智能体不会调用模型" });
    const configured = await openDatabase(databaseUrl!);
    const config = await configured.readConfig();
    await configured.saveConfig({ ...config, "model.baseUrl": "http://model.internal", "model.name": "local", "model.apiKey": "test-key" });
    await configured.close();
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/messages`,
      cookies: { platform_session: adminCookie },
      payload: { body: "管理员的需求" },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/messages`,
      cookies: { platform_session: employeeCookie },
      payload: { body: "员工的需求" },
    });
    const adminMessages = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/messages`,
      cookies: { platform_session: adminCookie },
    });
    const employeeMessages = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/messages`,
      cookies: { platform_session: employeeCookie },
    });
    expect(adminMessages.json().messages).toEqual([{ body: "管理员的需求" }]);
    expect(employeeMessages.json().messages).toEqual([{ body: "员工的需求" }]);
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: adminCookie },
      payload: { principalType: "user", principalName: "employee", menu: "qing-jia-dan", actions: ["访问"] },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: adminCookie },
      payload: { principalType: "role", principalName: "审批人", menu: "qing-jia-dan", actions: ["修改"] },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/roles/assign`,
      cookies: { platform_session: adminCookie },
      payload: { role: "审批人", username: "employee" },
    });
    const access = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/access?username=employee&menu=qing-jia-dan`,
      cookies: { platform_session: adminCookie },
    });
    expect(access.json().actions).toEqual(["访问", "修改"]);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/confirm`,
      cookies: { platform_session: adminCookie },
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().change.added.menus).toEqual([{ code: "qing-jia-dan", name: "请假单", parent_code: null }]);
    expect(confirmed.json().change.modified).toEqual([]);
    expect(confirmed.json().change.removed).toEqual([]);
    const menus = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: employeeCookie },
    });
    expect(menus.json()).toEqual({ menus: [] });
    const refused = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tools`,
      cookies: { platform_session: adminCookie },
      payload: { name: "run_tests" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ reason: "还没有候选镜像" });
    const missing = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tools`,
      cookies: { platform_session: adminCookie },
      payload: { name: "replay_test", arguments: { record: "missing" } },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ reason: "没有这条测试记录" });
    const entity = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tools`,
      cookies: { platform_session: employeeCookie },
      payload: { name: "add_entity", arguments: { name: "请假单", fields: [{ name: "申请人", type: "user" }] } },
    });
    expect(entity.statusCode).toBe(201);
    const crossTool = await app.inject({
      method: "POST",
      url: `/api/projects/${otherCode}/tools`,
      cookies: { platform_session: employeeCookie },
      payload: { name: "add_entity", arguments: { name: "入库", fields: [] } },
    });
    expect(crossTool.statusCode).toBe(403);
  });
});
