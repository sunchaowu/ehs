import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

describe("registration and disabled accounts", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("rejects a disabled account and a closed registration", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    app = await buildServer({ databaseUrl });
    const registered = await app.inject({
      method: "POST",
      url: "/api/account/register",
      payload: { username: "employee", displayName: "员工", password: "secret-pass" },
    });
    expect(registered.statusCode).toBe(201);
    const employeeCookie = registered.cookies.find((cookie) => cookie.name === "platform_session")?.value ?? "";
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/users/employee/disable",
      cookies: { platform_session: employeeCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ reason: "需要平台管理员" });

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    const adminCookie = adminLogin.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const disable = await app.inject({
      method: "POST",
      url: "/api/users/employee/disable",
      cookies: { platform_session: adminCookie },
    });
    expect(disable.statusCode).toBe(204);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "employee", password: "secret-pass" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toEqual({ reason: "账号已停用" });

    const stored = await openDatabase(databaseUrl!);
    const config = await stored.readConfig();
    config["registration.enabled"] = false;
    await stored.saveConfig(config);
    await stored.close();
    const closed = await app.inject({
      method: "POST",
      url: "/api/account/register",
      payload: { username: "other", displayName: "其他人", password: "secret-pass" },
    });
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toEqual({ reason: "请联系管理员" });
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { platform_session: adminCookie },
      payload: { username: "other", displayName: "其他人", password: "secret-pass" },
    });
    expect(created.statusCode).toBe(201);
  });
});
