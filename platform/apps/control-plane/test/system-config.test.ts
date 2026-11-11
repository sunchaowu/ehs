import { describe, expect, it } from "vitest";
import { defaultSystemConfig } from "../src/system-config.js";

describe("defaultSystemConfig", () => {
  it("uses the account defaults and keeps wechat and model empty", () => {
    const config = defaultSystemConfig({
      title: "企业应用平台",
      systemUrl: "postgres://platform@127.0.0.1:5432/platform",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    expect(config["platform.title"]).toBe("企业应用平台");
    expect(config["platform.languages"]).toEqual(["zh-CN", "en-US"]);
    expect(config["registration.enabled"]).toBe(true);
    expect(config["wechat.appId"]).toBe("");
    expect(config["wechat.appSecret"]).toBe("");
    expect(config["wechat.redirectUri"]).toBe("");
    expect(config["model.baseUrl"]).toBe("");
    expect(config["model.name"]).toBe("");
    expect(config["model.apiKey"]).toBe("");
    expect(config["password.argon2.memoryKiB"]).toBe(19456);
    expect(config["password.argon2.iterations"]).toBe(2);
    expect(config["password.argon2.parallelism"]).toBe(1);
    expect(config["ops.heartbeatTimeoutSeconds"]).toBe(30);
    expect(config["ops.restartMaxAttempts"]).toBe(3);
    expect(config["ops.restartWindowSeconds"]).toBe(600);
    expect(config["ops.errorRateThreshold"]).toBe(0.05);
    expect(config["ops.errorRateWindowSeconds"]).toBe(300);
    expect(config["ops.minRequestsInWindow"]).toBe(20);
    expect(config["test.nodePool"]).toBe("");
    expect(config["test.requirePassBeforePublish"]).toBe(true);
    expect(config["test.stepTimeoutSeconds"]).toBe(30);
    expect(config["test.runTimeoutSeconds"]).toBe(900);
    expect(config["scheduler.defaultNodePool"]).toBe("");
  });
});
