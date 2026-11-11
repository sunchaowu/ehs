import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { defaultSystemConfig } from "../src/system-config.js";

describe("system database", () => {
  it("requires the system database url and rounds a config trip", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    const config = defaultSystemConfig({
      title: "企业应用平台",
      systemUrl: databaseUrl!,
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    await database.saveConfig(config);
    expect(await database.readConfig()).toEqual(config);
    await database.close();
  });
});
