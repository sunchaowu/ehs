import { openDatabase } from "../src/database.js";

export async function setup(): Promise<() => Promise<void>> {
  const databaseUrl = process.env.DATABASE_SYSTEM_URL;
  if (!databaseUrl) {
    throw new Error("缺少 DATABASE_SYSTEM_URL");
  }
  const database = await openDatabase(databaseUrl);
  const found = await database.query<{ password_hash: string }>("select password_hash from users where username = 'admin'");
  const passwordHash = found.rows[0]?.password_hash;
  await database.close();
  return async () => {
    if (!passwordHash) {
      return;
    }
    const restore = await openDatabase(databaseUrl);
    await restore.query("update users set password_hash = $1, disabled = false where username = 'admin'", [passwordHash]);
    await restore.close();
  };
}
