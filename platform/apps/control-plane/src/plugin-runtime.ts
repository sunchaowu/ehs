// 插件运行时借鉴 cordis 的启停模型：插件行声明期望状态（enabled），
// 激活成功是 active，激活失败保留期望但标记 failed 并记录原因，停用即清理。
// 每次启停、配置修改和启动恢复都写入 plugin_events，作为启停记录。

import { randomUUID } from "node:crypto";
import type { SystemDatabase } from "./database.js";
import {
  getPluginDefinition,
  validatePluginConfig,
  type PluginConfig,
  type PluginConfigField,
  type PluginContext,
} from "./plugins.js";

export type PluginStatus = "disabled" | "active" | "failed";

export type PluginView = {
  id: string;
  name: string;
  title: string;
  description: string;
  available: boolean;
  enabled: boolean;
  status: PluginStatus;
  failure: string;
  config: PluginConfig;
  configSchema: PluginConfigField[];
};

export type PluginEventView = {
  action: string;
  actor: string;
  result: string;
  detail: string;
  createdAt: string;
};

type PluginRow = {
  id: string;
  name: string;
  enabled: boolean;
  status: PluginStatus;
  failure: string;
  config: unknown;
};

type ActivationOutcome = { ok: true } | { ok: false; reason: string };

export type PluginActionOutcome = { ok: true; plugin: PluginView } | { ok: false; status: number; reason: string };

function context(): PluginContext {
  return {
    log: () => {
      // 第一版不输出插件日志，保留接口供后续接入控制面日志。
    },
  };
}

export function createPluginRuntime() {
  const active = new Map<string, () => void>();

  function disposeInstance(id: string): void {
    const dispose = active.get(id);
    if (!dispose) {
      return;
    }
    active.delete(id);
    try {
      dispose();
    } catch {
      // 清理失败不影响行状态；插件应在激活函数内自愈。
    }
  }

  async function activateRow(row: { id: string; config: unknown }): Promise<ActivationOutcome> {
    const definition = getPluginDefinition(row.id);
    if (!definition) {
      return { ok: false, reason: "插件定义不存在" };
    }
    const validated = validatePluginConfig(definition.configSchema, row.config);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason };
    }
    disposeInstance(row.id);
    try {
      const activation = await definition.activate(context(), validated.config);
      if (typeof activation === "function") {
        active.set(row.id, activation);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function readRow(database: SystemDatabase, id: string): Promise<PluginRow | undefined> {
    const result = await database.query<PluginRow & { config: unknown }>(
      "select id, name, enabled, status, failure, config from plugins where id = $1",
      [id],
    );
    return result.rows[0];
  }

  async function recordEvent(
    database: SystemDatabase,
    pluginId: string,
    action: string,
    actor: string,
    result: string,
    detail: string,
  ): Promise<void> {
    await database.query(
      "insert into plugin_events (id, plugin_id, action, actor, result, detail, created_at) values ($1, $2, $3, $4, $5, $6, clock_timestamp())",
      [randomUUID(), pluginId, action, actor, result, detail],
    );
  }

  function viewOf(row: PluginRow): PluginView {
    const definition = getPluginDefinition(row.id);
    return {
      id: row.id,
      name: definition?.title ?? row.name,
      title: definition?.title ?? row.name,
      description: definition?.description ?? "插件定义不存在，无法运行",
      available: definition !== undefined,
      enabled: row.enabled,
      status: row.enabled ? (row.status === "failed" ? "failed" : "active") : "disabled",
      failure: row.failure ?? "",
      config: (row.config ?? {}) as PluginConfig,
      configSchema: definition?.configSchema ?? [],
    };
  }

  async function listPlugins(database: SystemDatabase): Promise<PluginView[]> {
    const result = await database.query<PluginRow>(
      "select id, name, enabled, status, failure, config from plugins order by name",
    );
    return result.rows.map(viewOf);
  }

  async function setState(database: SystemDatabase, id: string, enabled: boolean, actor: string): Promise<PluginActionOutcome> {
    const definition = getPluginDefinition(id);
    if (!definition) {
      return { ok: false, status: 404, reason: "没有这个插件" };
    }
    const row = await readRow(database, id);
    if (!row) {
      return { ok: false, status: 404, reason: "没有这个插件" };
    }
    if (enabled) {
      const activated = await activateRow(row);
      if (!activated.ok) {
        await database.query(
          "update plugins set enabled = true, status = 'failed', failure = $2, updated_at = now() where id = $1",
          [id, activated.reason],
        );
        await recordEvent(database, id, "enable", actor, "failed", activated.reason);
        const failedRow = await readRow(database, id);
        return failedRow
          ? { ok: true, plugin: viewOf(failedRow) }
          : { ok: false, status: 404, reason: "没有这个插件" };
      }
      await database.query("update plugins set enabled = true, status = 'active', failure = '', updated_at = now() where id = $1", [
        id,
      ]);
      await recordEvent(database, id, "enable", actor, "ok", "");
    } else {
      disposeInstance(id);
      await database.query("update plugins set enabled = false, status = 'disabled', failure = '', updated_at = now() where id = $1", [
        id,
      ]);
      await recordEvent(database, id, "disable", actor, "ok", "");
    }
    const nextRow = await readRow(database, id);
    return nextRow
      ? { ok: true, plugin: viewOf(nextRow) }
      : { ok: false, status: 404, reason: "没有这个插件" };
  }

  async function saveConfig(
    database: SystemDatabase,
    id: string,
    input: unknown,
    actor: string,
  ): Promise<PluginActionOutcome> {
    const definition = getPluginDefinition(id);
    if (!definition) {
      return { ok: false, status: 404, reason: "没有这个插件" };
    }
    const row = await readRow(database, id);
    if (!row) {
      return { ok: false, status: 404, reason: "没有这个插件" };
    }
    const validated = validatePluginConfig(definition.configSchema, input);
    if (!validated.ok) {
      return { ok: false, status: 400, reason: validated.reason };
    }
    await database.query("update plugins set config = $2::jsonb, updated_at = now() where id = $1", [id, JSON.stringify(validated.config)]);
    if (row.enabled) {
      const activated = await activateRow({ id, config: validated.config });
      if (!activated.ok) {
        await database.query("update plugins set status = 'failed', failure = $2, updated_at = now() where id = $1", [
          id,
          activated.reason,
        ]);
        await recordEvent(database, id, "config", actor, "failed", activated.reason);
        const failedRow = await readRow(database, id);
        return failedRow
          ? { ok: true, plugin: viewOf(failedRow) }
          : { ok: false, status: 404, reason: "没有这个插件" };
      }
      await database.query("update plugins set status = 'active', failure = '', updated_at = now() where id = $1", [id]);
    }
    await recordEvent(database, id, "config", actor, "ok", "");
    const nextRow = await readRow(database, id);
    return nextRow
      ? { ok: true, plugin: viewOf(nextRow) }
      : { ok: false, status: 404, reason: "没有这个插件" };
  }

  async function listEvents(database: SystemDatabase, id: string): Promise<PluginEventView[]> {
    const result = await database.query<{ action: string; actor: string; result: string; detail: string; created_at: Date }>(
      "select action, actor, result, detail, created_at from plugin_events where plugin_id = $1 order by seq desc limit 50",
      [id],
    );
    return result.rows.map((row) => ({
      action: row.action,
      actor: row.actor,
      result: row.result,
      detail: row.detail,
      createdAt: row.created_at.toISOString(),
    }));
  }

  // 启动恢复：期望启用的行在进程重启后重新激活，失败保留原因，与 cordis 的持久启停一致。
  async function activateInstalled(database: SystemDatabase): Promise<void> {
    const result = await database.query<PluginRow>("select id, name, enabled, status, failure, config from plugins where enabled");
    for (const row of result.rows) {
      const activated = await activateRow(row);
      if (!activated.ok) {
        await database.query("update plugins set status = 'failed', failure = $2, updated_at = now() where id = $1", [
          row.id,
          activated.reason,
        ]);
        continue;
      }
      await database.query("update plugins set status = 'active', failure = '', updated_at = now() where id = $1", [row.id]);
    }
  }

  async function disposeAll(): Promise<void> {
    for (const id of [...active.keys()]) {
      disposeInstance(id);
    }
  }

  return { listPlugins, setState, saveConfig, listEvents, activateInstalled, disposeAll };
}

export type PluginRuntime = ReturnType<typeof createPluginRuntime>;
