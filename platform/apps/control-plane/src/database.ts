import { readFileSync } from "node:fs";
import pg from "pg";
import { defaultSystemConfig, type SystemConfig } from "./system-config.js";

const { Pool } = pg;

export type SystemDatabase = {
  migrate(): Promise<void>;
  saveConfig(config: SystemConfig): Promise<void>;
  readConfig(): Promise<SystemConfig>;
  close(): Promise<void>;
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
};

function restoreConfig(rows: Array<{ key: string; value: string }>): SystemConfig {
  const sample = defaultSystemConfig({
    title: "",
    systemUrl: "",
    prodAdminUrl: "",
    testAdminUrl: "",
    registryAddress: "",
  });
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const config = { ...sample };
  for (const key of Object.keys(sample) as Array<keyof SystemConfig>) {
    const raw = stored.get(key);
    if (raw === undefined) {
      throw new Error(`系统配置缺少 ${key}`);
    }
    const current = sample[key];
    if (typeof current === "boolean") {
      config[key] = (raw === "true") as never;
    } else if (typeof current === "number") {
      config[key] = Number(raw) as never;
    } else if (Array.isArray(current)) {
      config[key] = JSON.parse(raw) as never;
    } else {
      config[key] = raw as never;
    }
  }
  return config;
}

export async function openDatabase(databaseUrl: string): Promise<SystemDatabase> {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async migrate() {
      const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
      await pool.query(sql);
    },
    async saveConfig(config) {
      for (const [key, value] of Object.entries(config)) {
        const stored = Array.isArray(value) ? JSON.stringify(value) : String(value);
        await pool.query(
          `insert into system_config (key, value) values ($1, $2)
           on conflict (key) do update set value = excluded.value`,
          [key, stored],
        );
      }
    },
    async readConfig() {
      const result = await pool.query<{ key: string; value: string }>("select key, value from system_config");
      if (result.rows.length === 0) {
        throw new Error("系统配置不存在");
      }
      return restoreConfig(result.rows);
    },
    async close() {
      await pool.end();
    },
    query(text, values) {
      return pool.query(text, values);
    },
  };
}
