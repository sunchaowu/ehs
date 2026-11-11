import { randomBytes } from "node:crypto";
import type { SystemDatabase } from "./database.js";
import { hashPassword } from "./passwords.js";
import type { SystemConfig } from "./system-config.js";

export type WechatClient = {
  exchangeCode(
    code: string,
    config: { appId: string; appSecret: string; redirectUri: string },
  ): Promise<{ openId: string }>;
};

export function wechatLoginAvailable(config: SystemConfig): boolean {
  return config["wechat.appId"] !== "" && config["wechat.appSecret"] !== "" && config["wechat.redirectUri"] !== "";
}

export function createWechatClient(): WechatClient {
  return {
    async exchangeCode(code, config) {
      const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
      url.searchParams.set("appid", config.appId);
      url.searchParams.set("secret", config.appSecret);
      url.searchParams.set("code", code);
      url.searchParams.set("grant_type", "authorization_code");
      const response = await fetch(url);
      const body = (await response.json()) as { openid?: string; errmsg?: string };
      if (!body.openid) {
        throw new Error(body.errmsg ?? "微信身份交换失败");
      }
      return { openId: body.openid };
    },
  };
}

export function wechatQrUrl(config: SystemConfig, state: string): string {
  const url = new URL("https://open.weixin.qq.com/connect/qrconnect");
  url.searchParams.set("appid", config["wechat.appId"]);
  url.searchParams.set("redirect_uri", config["wechat.redirectUri"]);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "snsapi_login");
  url.searchParams.set("state", state);
  return `${url.toString()}#wechat_redirect`;
}

export async function startWechatLogin(
  database: SystemDatabase,
): Promise<{ state: string; url: string } | { reason: string; status: number }> {
  const config = await database.readConfig();
  if (!wechatLoginAvailable(config)) {
    return { reason: "微信登录未配置", status: 404 };
  }
  const state = randomBytes(16).toString("hex");
  await database.query(
    "insert into wechat_states (state, expires_at) values ($1, now() + interval '5 minutes')",
    [state],
  );
  return { state, url: wechatQrUrl(config, state) };
}

export async function completeWechatLogin(
  database: SystemDatabase,
  client: WechatClient,
  code: string | undefined,
  state: string | undefined,
): Promise<{ sessionId: string; user: { username: string; wechatBound: boolean } } | { reason: string; status: number }> {
  if (!code) {
    return { reason: "已取消扫码，请重试", status: 400 };
  }
  const found = await database.query<{ expires_at: Date }>(
    "select expires_at from wechat_states where state = $1",
    [state ?? ""],
  );
  const ticket = found.rows[0];
  if (!ticket || new Date(ticket.expires_at).getTime() <= Date.now()) {
    return { reason: "扫码已失效，请重试", status: 400 };
  }
  await database.query("delete from wechat_states where state = $1", [state]);
  const config = await database.readConfig();
  const identity = await client.exchangeCode(code, {
    appId: config["wechat.appId"],
    appSecret: config["wechat.appSecret"],
    redirectUri: config["wechat.redirectUri"],
  });
  const existing = await database.query<{ id: string; username: string; disabled: boolean }>(
    "select id, username, disabled from users where wechat_open_id = $1",
    [identity.openId],
  );
  const current = existing.rows[0];
  if (current?.disabled) {
    return { reason: "账号已停用", status: 403 };
  }
  const userId = current?.id ?? (await createWechatUser(database, identity.openId, config));
  if (typeof userId !== "string") {
    return userId;
  }
  const sessionId = randomBytes(32).toString("hex");
  await database.query(
    "insert into sessions (id, user_id, expires_at) values ($1, $2, now() + interval '12 hours')",
    [sessionId, userId],
  );
  const named = await database.query<{ username: string }>("select username from users where id = $1", [userId]);
  return { sessionId, user: { username: named.rows[0].username, wechatBound: true } };
}

async function createWechatUser(
  database: SystemDatabase,
  openId: string,
  config: SystemConfig,
): Promise<string | { reason: string; status: number }> {
  if (!config["registration.enabled"]) {
    return { reason: "请联系管理员", status: 403 };
  }
  const username = /^[A-Za-z0-9_-]{1,40}$/.test(openId) ? `wx-${openId}` : `wx-${randomBytes(6).toString("hex")}`;
  const passwordHash = await hashPassword(randomBytes(18).toString("base64url"), {
    memoryKiB: config["password.argon2.memoryKiB"],
    iterations: config["password.argon2.iterations"],
    parallelism: config["password.argon2.parallelism"],
  });
  const inserted = await database.query<{ id: string }>(
    `insert into users (id, username, display_name, password_hash, disabled, language, wechat_open_id, platform_admin)
     values (gen_random_uuid(), $1, '微信用户', $2, false, 'zh-CN', $3, false)
     returning id`,
    [username, passwordHash, openId],
  );
  return inserted.rows[0].id;
}
