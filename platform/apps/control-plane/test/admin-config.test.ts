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

describe("system config", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("lets only a platform administrator change the title", async () => {
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
    const adminCookie = adminLogin.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const secretSet = await app.inject({
      method: "PUT",
      url: "/api/system-config",
      cookies: { platform_session: adminCookie },
      payload: { "wechat.appSecret": "stored-secret" },
    });
    expect(secretSet.statusCode).toBe(200);
    expect(secretSet.json()["wechat.appSecret"]).toBe("");
    const kept = await app.inject({
      method: "PUT",
      url: "/api/system-config",
      cookies: { platform_session: adminCookie },
      payload: { "wechat.appSecret": "" },
    });
    expect(kept.statusCode).toBe(200);
    const stored = await openDatabase(databaseUrl!);
    const config = await stored.readConfig();
    expect(config["platform.title"]).toBe("新标题");
    expect(config["wechat.appSecret"]).toBe("stored-secret");
    await stored.close();
  });
});
