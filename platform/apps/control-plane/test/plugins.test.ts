import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { createPluginRuntime, type PluginRuntime } from "../src/plugin-runtime.js";
import { registerPlugin, unregisterPlugin, validatePluginConfig, type PluginConfig, type PluginConfigField } from "../src/plugins.js";
import { buildServer } from "../src/server.js";

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

const activationLog: string[] = [];
let disposeCount = 0;

const fixtureId = "portal-notice";
registerPlugin({
  id: fixtureId,
  title: "门户公告",
  description: "在门户显示平台公告",
  configSchema: [
    { key: "title", label: "公告标题", type: "string", required: true },
    { key: "priority", label: "优先级", type: "number", default: 1 },
    { key: "pinned", label: "是否置顶", type: "boolean", default: false },
  ],
  activate(_context, config: PluginConfig) {
    activationLog.push(`activate:${config.title}`);
    return () => {
      disposeCount += 1;
    };
  },
});

describe("plugin config validation", () => {
  it("applies defaults and rejects unknown or mistyped values", () => {
    const schema: PluginConfigField[] = [
      { key: "title", label: "公告标题", type: "string", required: true },
      { key: "priority", label: "优先级", type: "number", default: 1 },
      { key: "pinned", label: "是否置顶", type: "boolean", default: false },
    ];
    expect(validatePluginConfig(schema, { title: "停机", priority: 2, pinned: true })).toEqual({
      ok: true,
      config: { title: "停机", priority: 2, pinned: true },
    });
    expect(validatePluginConfig(schema, {})).toEqual({ ok: false, reason: "请填写公告标题" });
    expect(validatePluginConfig(schema, { title: "停机" })).toEqual({
      ok: true,
      config: { title: "停机", priority: 1, pinned: false },
    });
    expect(validatePluginConfig(schema, { priority: 2 }).ok).toBe(false);
    expect(validatePluginConfig(schema, { title: "停机", extra: "x" }).ok).toBe(false);
    expect(validatePluginConfig(schema, { title: "停机", priority: "高" }).ok).toBe(false);
    expect(validatePluginConfig([], "no")).toEqual({ ok: false, reason: "配置必须是对象" });
  });
});

describe("plugin lifecycle", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let runtime: PluginRuntime | undefined;
  let password = "";

  afterEach(async () => {
    await app?.close();
    unregisterPlugin("ghost-plugin");
  });

  async function prepare(): Promise<string> {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from plugin_events");
    await database.query("delete from plugins");
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    password = installed.password;
    runtime = createPluginRuntime();
    app = await buildServer({ databaseUrl, pluginRuntime: runtime });
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    return adminLogin.cookies.find((cookie) => cookie.name === "platform_session")!.value;
  }

  async function insertFixtureRow(config: unknown) {
    const database = await openDatabase(process.env.DATABASE_SYSTEM_URL!);
    await database.query(
      "insert into plugins (id, name, enabled, status, failure, config, updated_at) values ($1, $2, false, 'disabled', '', $3::jsonb, now())",
      [fixtureId, "门户公告", JSON.stringify(config)],
    );
    await database.close();
  }

  it("lists installed rows and marks rows without a definition unavailable", async () => {
    const adminCookie = await prepare();
    const list = await app!.inject({ method: "GET", url: "/api/plugins", cookies: { platform_session: adminCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ plugins: [] });
    await app!.close();
    app = undefined;
    const database = await openDatabase(process.env.DATABASE_SYSTEM_URL!);
    await database.query(
      "insert into plugins (id, name, enabled, status, failure, config, updated_at) values ($1, $2, false, 'disabled', '', '{}', now())",
      ["ghost-plugin", "幽灵插件"],
    );
    await database.close();
    const second = await buildServer({ databaseUrl: process.env.DATABASE_SYSTEM_URL!, pluginRuntime: runtime });
    try {
      const adminLogin = await second.inject({
        method: "POST",
        url: "/api/session/login",
        payload: { username: "admin", password },
      });
      const cookie = adminLogin.cookies.find((entry) => entry.name === "platform_session")!.value;
      const ghosts = await second.inject({ method: "GET", url: "/api/plugins", cookies: { platform_session: cookie } });
      expect(ghosts.json().plugins).toEqual([
        {
          id: "ghost-plugin",
          name: "幽灵插件",
          title: "幽灵插件",
          description: "插件定义不存在，无法运行",
          available: false,
          enabled: false,
          status: "disabled",
          failure: "",
          config: {},
          configSchema: [],
        },
      ]);
    } finally {
      await second.close();
    }
  });

  it("lets only a platform administrator read and change plugins", async () => {
    const adminCookie = await prepare();
    await insertFixtureRow({});
    const registered = await app!.inject({
      method: "POST",
      url: "/api/account/register",
      payload: { username: "employee", displayName: "员工", password: "secret-pass" },
    });
    const employeeCookie = registered.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const forbidden = await app!.inject({ method: "GET", url: "/api/plugins", cookies: { platform_session: employeeCookie } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ reason: "需要平台管理员" });
    const deniedState = await app!.inject({
      method: "PUT",
      url: `/api/plugins/${fixtureId}/state`,
      cookies: { platform_session: employeeCookie },
      payload: { enabled: true },
    });
    expect(deniedState.statusCode).toBe(403);
    const deniedConfig = await app!.inject({
      method: "PUT",
      url: `/api/plugins/${fixtureId}/config`,
      cookies: { platform_session: employeeCookie },
      payload: { config: { title: "停机维护" } },
    });
    expect(deniedConfig.statusCode).toBe(403);
    const list = await app!.inject({ method: "GET", url: "/api/plugins", cookies: { platform_session: adminCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().plugins[0].id).toBe(fixtureId);
  });

  it("keeps the desired state when activation fails, and disposes on disable", async () => {
    const adminCookie = await prepare();
    await insertFixtureRow({});
    const missingTitle = await app!.inject({
      method: "PUT",
      url: `/api/plugins/${fixtureId}/state`,
      cookies: { platform_session: adminCookie },
      payload: { enabled: true },
    });
    expect(missingTitle.statusCode).toBe(200);
    const failed = missingTitle.json().plugin;
    expect(failed.status).toBe("failed");
    expect(failed.failure).toBe("请填写公告标题");
    expect(failed.enabled).toBe(true);
    expect(activationLog).toEqual([]);
    const saved = await app!.inject({
      method: "PUT",
      url: `/api/plugins/${fixtureId}/config`,
      cookies: { platform_session: adminCookie },
      payload: { config: { title: "停机维护", priority: 2 } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().plugin.status).toBe("active");
    expect(saved.json().plugin.config).toEqual({ title: "停机维护", priority: 2, pinned: false });
    expect(activationLog).toEqual(["activate:停机维护"]);
    const disabled = await app!.inject({
      method: "PUT",
      url: `/api/plugins/${fixtureId}/state`,
      cookies: { platform_session: adminCookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().plugin.status).toBe("disabled");
    expect(disposeCount).toBe(1);
    const events = await app!.inject({ method: "GET", url: `/api/plugins/${fixtureId}/events`, cookies: { platform_session: adminCookie } });
    const records = events.json().events as Array<{ action: string; result: string; detail: string }>;
    expect(records.map((record) => `${record.action}:${record.result}`)).toEqual([
      "disable:ok",
      "config:ok",
      "enable:failed",
    ]);
    expect(records[2].detail).toBe("请填写公告标题");
  });

  it("rejects unknown plugins and invalid configs, and records the actor", async () => {
    const adminCookie = await prepare();
    const unknown = await app!.inject({
      method: "PUT",
      url: "/api/plugins/no-such-plugin/state",
      cookies: { platform_session: adminCookie },
      payload: { enabled: true },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ reason: "没有这个插件" });
    await insertFixtureRow({});
    const badConfig = await app!.inject({
      method: "PUT",
      url: `/api/plugins/${fixtureId}/config`,
      cookies: { platform_session: adminCookie },
      payload: { config: { title: "停机维护", pinned: "yes" } },
    });
    expect(badConfig.statusCode).toBe(400);
    expect(badConfig.json()).toEqual({ reason: "是否置顶必须是布尔值" });
    const saved = await app!.inject({
      method: "PUT",
      url: `/api/plugins/${fixtureId}/config`,
      cookies: { platform_session: adminCookie },
      payload: { config: { title: "停机维护" } },
    });
    expect(saved.statusCode).toBe(200);
    const events = await app!.inject({ method: "GET", url: `/api/plugins/${fixtureId}/events`, cookies: { platform_session: adminCookie } });
    const records = events.json().events as Array<{ action: string; actor: string; result: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ action: "config", actor: "admin", result: "ok" });
  });

  it("reactivates enabled rows when the server restarts", async () => {
    const adminCookie = await prepare();
    const database = await openDatabase(process.env.DATABASE_SYSTEM_URL!);
    await database.query(
      "insert into plugins (id, name, enabled, status, failure, config, updated_at) values ($1, $2, true, 'active', '', $3::jsonb, now())",
      [fixtureId, "门户公告", JSON.stringify({ title: "停机维护" })],
    );
    await database.close();
    activationLog.length = 0;
    const restarted = await buildServer({ databaseUrl: process.env.DATABASE_SYSTEM_URL!, pluginRuntime: runtime });
    try {
      const list = await restarted.inject({ method: "GET", url: "/api/plugins", cookies: { platform_session: adminCookie } });
      expect(list.json().plugins[0]).toMatchObject({ status: "active", enabled: true });
      expect(activationLog).toEqual(["activate:停机维护"]);
    } finally {
      await restarted.close();
    }
    expect(disposeCount).toBeGreaterThanOrEqual(1);
  });
});
