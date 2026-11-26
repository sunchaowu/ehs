export type SystemConfig = {
  "platform.title": string;
  "platform.languages": string[];
  "registration.enabled": boolean;
  "wechat.appId": string;
  "wechat.appSecret": string;
  "wechat.redirectUri": string;
  "model.baseUrl": string;
  "model.name": string;
  "model.apiKey": string;
  "database.systemUrl": string;
  "database.prodAdminUrl": string;
  "database.testAdminUrl": string;
  "password.argon2.memoryKiB": number;
  "password.argon2.iterations": number;
  "password.argon2.parallelism": number;
  "registry.address": string;
  "scheduler.defaultNodePool": string;
  "ops.heartbeatTimeoutSeconds": number;
  "ops.restartMaxAttempts": number;
  "ops.restartWindowSeconds": number;
  "ops.errorRateThreshold": number;
  "ops.errorRateWindowSeconds": number;
  "ops.minRequestsInWindow": number;
  "test.nodePool": string;
  "test.requirePassBeforePublish": boolean;
  "test.stepTimeoutSeconds": number;
  "test.runTimeoutSeconds": number;
  "test.maxAttempts": number;
};

export function defaultSystemConfig(input: {
  title: string;
  systemUrl: string;
  prodAdminUrl: string;
  testAdminUrl: string;
  registryAddress: string;
}): SystemConfig {
  return {
    "platform.title": input.title,
    "platform.languages": ["zh-CN", "en-US"],
    "registration.enabled": true,
    "wechat.appId": "",
    "wechat.appSecret": "",
    "wechat.redirectUri": "",
    "model.baseUrl": "",
    "model.name": "",
    "model.apiKey": "",
    "database.systemUrl": input.systemUrl,
    "database.prodAdminUrl": input.prodAdminUrl,
    "database.testAdminUrl": input.testAdminUrl,
    "password.argon2.memoryKiB": 19456,
    "password.argon2.iterations": 2,
    "password.argon2.parallelism": 1,
    "registry.address": input.registryAddress,
    "scheduler.defaultNodePool": "",
    "ops.heartbeatTimeoutSeconds": 30,
    "ops.restartMaxAttempts": 3,
    "ops.restartWindowSeconds": 600,
    "ops.errorRateThreshold": 0.05,
    "ops.errorRateWindowSeconds": 300,
    "ops.minRequestsInWindow": 20,
    "test.nodePool": "",
    "test.requirePassBeforePublish": true,
    "test.stepTimeoutSeconds": 30,
    "test.runTimeoutSeconds": 900,
    "test.maxAttempts": 2,
  };
}
