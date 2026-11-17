import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";

describe("installInitialAdmin", () => {
  it("prints a new password once and does not replace it", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users where username = 'admin'");
    await database.close();
    const input = {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    };
    const first = await installInitialAdmin(databaseUrl!, input);
    const second = await installInitialAdmin(databaseUrl!, input);
    expect(first).toMatchObject({ username: "admin", created: true });
    expect(first.password).toHaveLength(24);
    expect(second).toEqual({ username: "admin", password: "", created: false });

    const stored = await openDatabase(databaseUrl!);
    const config = await stored.readConfig();
    await stored.saveConfig({ ...config, "platform.title": "已修改的标题" });
    await stored.close();

    const third = await installInitialAdmin(databaseUrl!, input);
    expect(third.created).toBe(false);

    const after = await openDatabase(databaseUrl!);
    expect((await after.readConfig())["platform.title"]).toBe("已修改的标题");
    await after.close();
  });

  it("resets the administrator password only when asked", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const setup = await openDatabase(databaseUrl!);
    await setup.migrate();
    await setup.query("delete from sessions");
    await setup.query("delete from users where username = 'admin'");
    await setup.close();
    const input = {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    };
    const created = await installInitialAdmin(databaseUrl!, input);
    expect(created.created).toBe(true);
    const reset = await installInitialAdmin(databaseUrl!, { ...input, reset: true });
    expect(reset.created).toBe(true);
    expect(reset.password).not.toBe(created.password);
    const database = await openDatabase(databaseUrl!);
    const { loginWithPassword } = await import("../src/accounts.js");
    const session = await loginWithPassword(database, "admin", reset.password);
    expect("reason" in session).toBe(false);
    const stale = await loginWithPassword(database, "admin", created.password);
    expect(stale).toEqual({ reason: "用户名或密码错误" });
    await database.close();
  });
});
