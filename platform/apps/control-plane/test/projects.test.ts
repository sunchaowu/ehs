import { afterEach, describe, expect, it } from "vitest";
import { installInitialAdmin } from "../src/install-admin.js";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

describe("projects", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("lets a platform administrator create a project and keeps the code unique", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    const configured = await openDatabase(databaseUrl!);
    const config = await configured.readConfig();
    await configured.saveConfig({ ...config, "registration.enabled": true });
    await configured.close();
    app = await buildServer({ databaseUrl });
    const registered = await app.inject({
      method: "POST",
      url: "/api/account/register",
      payload: { username: "employee", displayName: "员工", password: "secret-pass" },
    });
    const employeeCookie = registered.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: employeeCookie },
      payload: { name: "请假审批" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ reason: "没有创建项目的权限" });
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
    expect(created.statusCode).toBe(201);
    expect(created.json().project).toEqual({
      name: "请假审批",
      code: "qing-jia-shen-pi",
      containerGroup: "qing-jia-shen-pi",
      projectAdmin: true,
    });
    const again = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: adminCookie },
      payload: { name: "请假审批" },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().project.code).toBe("qing-jia-shen-pi-2");
  });
});
