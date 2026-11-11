import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";
import { defaultSystemConfig } from "../src/system-config.js";
import { wechatLoginAvailable } from "../src/wechat.js";

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

describe("wechatLoginAvailable", () => {
  it("is false until app id, secret, and redirect are all present", () => {
    const config = defaultSystemConfig({
      title: "企业应用平台",
      systemUrl: "postgres://platform@127.0.0.1:5432/platform",
      prodAdminUrl: input.prodAdminUrl,
      testAdminUrl: input.testAdminUrl,
      registryAddress: input.registryAddress,
    });
    expect(wechatLoginAvailable(config)).toBe(false);
    config["wechat.appId"] = "wx-app";
    config["wechat.appSecret"] = "wx-secret";
    expect(wechatLoginAvailable(config)).toBe(false);
    config["wechat.redirectUri"] = "https://platform.example/api/session/wechat/callback";
    expect(wechatLoginAvailable(config)).toBe(true);
  });
});

describe("wechat callback", () => {
  const apps: Array<Awaited<ReturnType<typeof buildServer>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("does not start WeChat login when the three values are empty", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    await installInitialAdmin(databaseUrl!, input);
    const database = await openDatabase(databaseUrl!);
    const config = await database.readConfig();
    config["wechat.appId"] = "";
    config["wechat.appSecret"] = "";
    config["wechat.redirectUri"] = "";
    await database.saveConfig(config);
    await database.close();
    const app = await buildServer({
      databaseUrl,
      wechatClient: { async exchangeCode() { throw new Error("测试不能访问微信"); } },
    });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/session/wechat/start" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ reason: "微信登录未配置" });
  });

  it("rejects an unbound scan after registration is closed", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL!;
    await installInitialAdmin(databaseUrl, input);
    const database = await openDatabase(databaseUrl);
    const config = await database.readConfig();
    config["wechat.appId"] = "wx-app";
    config["wechat.appSecret"] = "wx-secret";
    config["wechat.redirectUri"] = "https://platform.example/api/session/wechat/callback";
    config["registration.enabled"] = false;
    await database.saveConfig(config);
    await database.close();
    const app = await buildServer({
      databaseUrl,
      wechatClient: { async exchangeCode() { return { openId: "wx-user" }; } },
    });
    apps.push(app);
    const started = await app.inject({ method: "POST", url: "/api/session/wechat/start" });
    expect(started.statusCode).toBe(200);
    expect(started.json().url).toContain("open.weixin.qq.com/connect/qrconnect");
    expect(started.json().url).toContain("appid=wx-app");
    const callback = await app.inject({
      method: "GET",
      url: `/api/session/wechat/callback?code=demo-code&state=${started.json().state}`,
    });
    expect(callback.statusCode).toBe(403);
    expect(callback.json()).toEqual({ reason: "请联系管理员" });
    const missing = await app.inject({ method: "GET", url: "/api/session/wechat/callback?code=demo-code&state=missing" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ reason: "扫码已失效，请重试" });
    const cancelled = await app.inject({ method: "GET", url: `/api/session/wechat/callback?state=${started.json().state}` });
    expect(cancelled.statusCode).toBe(400);
    expect(cancelled.json()).toEqual({ reason: "已取消扫码，请重试" });
  });

  it("binds a new user once and signs the same user in again", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL!;
    const database = await openDatabase(databaseUrl);
    const config = await database.readConfig();
    config["registration.enabled"] = true;
    await database.saveConfig(config);
    await database.query("delete from sessions");
    await database.query("delete from users where wechat_open_id = 'wx-new'");
    await database.close();
    const app = await buildServer({
      databaseUrl,
      wechatClient: { async exchangeCode() { return { openId: "wx-new" }; } },
    });
    apps.push(app);
    const started = await app.inject({ method: "POST", url: "/api/session/wechat/start" });
    const first = await app.inject({
      method: "GET",
      url: `/api/session/wechat/callback?code=demo-code&state=${started.json().state}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().user.wechatBound).toBe(true);
    const again = await app.inject({ method: "POST", url: "/api/session/wechat/start" });
    const second = await app.inject({
      method: "GET",
      url: `/api/session/wechat/callback?code=demo-code&state=${again.json().state}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().user.username).toBe(first.json().user.username);
  });
});
