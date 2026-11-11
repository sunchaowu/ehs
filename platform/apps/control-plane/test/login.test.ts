import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

describe("POST /api/session/login", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("sets an HttpOnly session cookie", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users where username = 'admin'");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    app = await buildServer({ databaseUrl });
    const response = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ username: "admin", platformAdmin: true });
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(String(response.headers["set-cookie"])).not.toContain("Secure");

    const secure = await app.inject({
      method: "POST",
      url: "/api/session/login",
      headers: { "x-forwarded-proto": "https" },
      payload: { username: "admin", password: installed.password },
    });
    expect(secure.headers["set-cookie"]).toContain("Secure");
  });
});
