import { randomBytes } from "node:crypto";
import type { SystemDatabase } from "./database.js";
import { verifyPassword } from "./passwords.js";

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
