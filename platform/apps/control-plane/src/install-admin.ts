import { randomBytes } from "node:crypto";
import { openDatabase } from "./database.js";
import { hashPassword } from "./passwords.js";
import { defaultSystemConfig } from "./system-config.js";

export async function installInitialAdmin(
  databaseUrl: string,
  input: { title: string; prodAdminUrl: string; testAdminUrl: string; registryAddress: string; reset?: boolean },
): Promise<{ username: "admin"; password: string; created: boolean }> {
  const database = await openDatabase(databaseUrl);
  await database.migrate();
  const config = defaultSystemConfig({
    title: input.title,
    systemUrl: databaseUrl,
    prodAdminUrl: input.prodAdminUrl,
    testAdminUrl: input.testAdminUrl,
    registryAddress: input.registryAddress,
  });
  await database.saveConfig(config);
  const existing = await database.query("select id from users where username = 'admin'");
  if (existing.rows.length > 0 && !input.reset) {
    await database.close();
    return { username: "admin", password: "", created: false };
  }
  const password = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(password, {
    memoryKiB: config["password.argon2.memoryKiB"],
    iterations: config["password.argon2.iterations"],
    parallelism: config["password.argon2.parallelism"],
  });
  if (existing.rows.length > 0) {
    await database.query("update users set password_hash = $1, disabled = false where username = 'admin'", [passwordHash]);
  } else {
    await database.query(
      `insert into users (id, username, display_name, password_hash, disabled, language, wechat_open_id, platform_admin)
       values (gen_random_uuid(), 'admin', '管理员', $1, false, 'zh-CN', null, true)`,
      [passwordHash],
    );
  }
  await database.close();
  return { username: "admin", password, created: true };
}
