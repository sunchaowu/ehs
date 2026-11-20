import { randomBytes } from "node:crypto";
import type { SystemDatabase } from "./database.js";
import { hashPassword, verifyPassword } from "./passwords.js";

export type PublicUser = {
  username: string;
  displayName: string;
  language: string;
  platformAdmin: boolean;
  wechatBound: boolean;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  disabled: boolean;
  language: string;
  wechat_open_id: string | null;
  platform_admin: boolean;
};

function toPublicUser(row: UserRow): PublicUser {
  return {
    username: row.username,
    displayName: row.display_name,
    language: row.language,
    platformAdmin: row.platform_admin,
    wechatBound: row.wechat_open_id !== null,
  };
}

export async function loginWithPassword(
  database: SystemDatabase,
  username: string,
  password: string,
): Promise<{ sessionId: string; user: PublicUser } | { reason: string }> {
  const found = await database.query<UserRow>(
    `select id, username, display_name, password_hash, disabled, language, wechat_open_id, platform_admin
     from users where username = $1`,
    [username],
  );
  const row = found.rows[0];
  if (!row || !(await verifyPassword(row.password_hash, password))) {
    return { reason: "用户名或密码错误" };
  }
  if (row.disabled) {
    return { reason: "账号已停用" };
  }
  const sessionId = randomBytes(32).toString("hex");
  await database.query(
    "insert into sessions (id, user_id, expires_at) values ($1, $2, now() + interval '12 hours')",
    [sessionId, row.id],
  );
  return { sessionId, user: toPublicUser(row) };
}

export async function readSession(database: SystemDatabase, sessionId: string | undefined): Promise<PublicUser | undefined> {
  if (!sessionId) {
    return undefined;
  }
  const found = await database.query<UserRow>(
    `select users.id, users.username, users.display_name, users.password_hash, users.disabled, users.language,
            users.wechat_open_id, users.platform_admin
     from sessions join users on users.id = sessions.user_id
     where sessions.id = $1 and sessions.expires_at > now()`,
    [sessionId],
  );
  const row = found.rows[0];
  if (!row || row.disabled) {
    return undefined;
  }
  return toPublicUser(row);
}

type AccountInput = { username?: string; displayName?: string; password?: string };

function validateAccount(input: AccountInput): { username: string; displayName: string; password: string } | { reason: string } {
  const username = input.username?.trim() ?? "";
  const displayName = input.displayName?.trim() ?? "";
  const password = input.password ?? "";
  if (!username || !displayName || !password) {
    return { reason: "请输入用户名、显示名和密码" };
  }
  return { username, displayName, password };
}

async function insertUser(
  database: SystemDatabase,
  input: { username: string; displayName: string; password: string; platformAdmin: boolean },
): Promise<{ id: string } | { reason: string }> {
  const existing = await database.query("select id from users where username = $1", [input.username]);
  if (existing.rows.length > 0) {
    return { reason: "用户名已存在" };
  }
  const config = await database.readConfig();
  const passwordHash = await hashPassword(input.password, {
    memoryKiB: config["password.argon2.memoryKiB"],
    iterations: config["password.argon2.iterations"],
    parallelism: config["password.argon2.parallelism"],
  });
  const inserted = await database.query<{ id: string }>(
    `insert into users (id, username, display_name, password_hash, disabled, language, wechat_open_id, platform_admin)
     values (gen_random_uuid(), $1, $2, $3, false, 'zh-CN', null, $4)
     returning id`,
    [input.username, input.displayName, passwordHash, input.platformAdmin],
  );
  return { id: inserted.rows[0].id };
}

export async function registerAccount(
  database: SystemDatabase,
  input: AccountInput,
): Promise<{ sessionId: string; user: PublicUser } | { reason: string; status: number }> {
  const config = await database.readConfig();
  if (!config["registration.enabled"]) {
    return { reason: "请联系管理员", status: 403 };
  }
  const valid = validateAccount(input);
  if ("reason" in valid) {
    return { reason: valid.reason, status: 400 };
  }
  const created = await insertUser(database, { ...valid, platformAdmin: false });
  if ("reason" in created) {
    return { reason: created.reason, status: 409 };
  }
  return loginWithPassword(database, valid.username, valid.password).then((result) => {
    if ("reason" in result) {
      return { reason: result.reason, status: 401 };
    }
    return result;
  });
}

export async function createUser(
  database: SystemDatabase,
  input: AccountInput,
): Promise<{ user: PublicUser } | { reason: string; status: number }> {
  const valid = validateAccount(input);
  if ("reason" in valid) {
    return { reason: valid.reason, status: 400 };
  }
  const created = await insertUser(database, { ...valid, platformAdmin: false });
  if ("reason" in created) {
    return { reason: created.reason, status: 409 };
  }
  const found = await database.query<UserRow>(
    `select id, username, display_name, password_hash, disabled, language, wechat_open_id, platform_admin
     from users where id = $1`,
    [created.id],
  );
  return { user: toPublicUser(found.rows[0]) };
}

export async function disableUser(database: SystemDatabase, username: string): Promise<void> {
  await database.query("update users set disabled = true where username = $1", [username]);
}

export type ManagedUser = {
  username: string;
  displayName: string;
  language: string;
  platformAdmin: boolean;
  disabled: boolean;
  wechatBound: boolean;
};

/** 平台管理员的用户列表；不返回密码哈希。 */
export async function listUsers(database: SystemDatabase): Promise<ManagedUser[]> {
  const found = await database.query<UserRow>(
    `select id, username, display_name, password_hash, disabled, language, wechat_open_id, platform_admin
     from users order by username`,
  );
  return found.rows.map((row) => ({
    username: row.username,
    displayName: row.display_name,
    language: row.language,
    platformAdmin: row.platform_admin,
    disabled: row.disabled,
    wechatBound: row.wechat_open_id !== null,
  }));
}

export async function setUserDisabled(database: SystemDatabase, username: string, disabled: boolean): Promise<void> {
  await database.query("update users set disabled = $1 where username = $2", [disabled, username]);
}
