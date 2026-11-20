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

describe("PUT /api/account", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function install() {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users where username = 'admin'");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    app = await buildServer({ databaseUrl });
    return { databaseUrl: databaseUrl!, installed };
  }

  async function login(password: string) {
    const response = await app!.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password },
    });
    return {
      statusCode: response.statusCode,
      cookie: response.cookies.find((cookie) => cookie.name === "platform_session")?.value,
    };
  }

  it("rejects a profile update without language and keeps the old password", async () => {
    const { installed } = await install();
    const signedIn = await login(installed.password);
    expect(signedIn.statusCode).toBe(200);

    const rejected = await app!.inject({
      method: "PUT",
      url: "/api/account",
      cookies: { platform_session: signedIn.cookie! },
      payload: { displayName: "管理员", language: "", password: "new-secret" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ reason: "请输入显示名和语言" });

    expect((await login(installed.password)).statusCode).toBe(200);
    expect((await login("new-secret")).statusCode).toBe(401);
  });

  it("saves the display name and the new password together", async () => {
    const { installed } = await install();
    const signedIn = await login(installed.password);

    const saved = await app!.inject({
      method: "PUT",
      url: "/api/account",
      cookies: { platform_session: signedIn.cookie! },
      payload: { displayName: "新名字", language: "zh-CN", password: "new-secret" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().user).toMatchObject({ username: "admin", displayName: "新名字", language: "zh-CN" });

    expect((await login("new-secret")).statusCode).toBe(200);
    expect((await login(installed.password)).statusCode).toBe(401);
  });
});
