// 插件声明借鉴 DeepSeek Harness 的 cordis 机制：插件是清单加激活函数。
// 清单（id、标题、描述、配置 schema）对应 cordis 的 bundle 行与 meta 资源；
// 激活函数返回清理函数，对应 cordis 的 apply(ctx, config) 加 ctx.effect 所有权。
// 第一版插件由平台代码内置注册，不动态加载外部包；不预装业务插件。

export type PluginConfigField = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  required?: boolean;
};

export type PluginConfig = Record<string, string | number | boolean>;

export type PluginContext = {
  log(message: string): void;
};

export type PluginActivation = void | (() => void);

export type PluginDefinition = {
  id: string;
  title: string;
  description: string;
  configSchema: PluginConfigField[];
  activate(context: PluginContext, config: PluginConfig): PluginActivation | Promise<PluginActivation>;
};

const registry = new Map<string, PluginDefinition>();

export function registerPlugin(definition: PluginDefinition): { reason?: string } {
  if (registry.has(definition.id)) {
    return { reason: "插件已注册" };
  }
  registry.set(definition.id, definition);
  return {};
}

export function unregisterPlugin(id: string): void {
  registry.delete(id);
}

export function getPluginDefinition(id: string): PluginDefinition | undefined {
  return registry.get(id);
}

export function listPluginDefinitions(): PluginDefinition[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export type PluginConfigResult = { ok: true; config: PluginConfig } | { ok: false; reason: string };

export function validatePluginConfig(schema: PluginConfigField[], input: unknown): PluginConfigResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "配置必须是对象" };
  }
  const provided = input as Record<string, unknown>;
  const known = new Set(schema.map((field) => field.key));
  for (const key of Object.keys(provided)) {
    if (!known.has(key)) {
      return { ok: false, reason: `未知配置项 ${key}` };
    }
  }
  const config: PluginConfig = {};
  for (const field of schema) {
    const value = provided[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.default !== undefined) {
        config[field.key] = field.default;
      } else if (field.required) {
        return { ok: false, reason: `请填写${field.label}` };
      }
      continue;
    }
    if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `${field.label}必须是数字` };
      }
      config[field.key] = value;
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        return { ok: false, reason: `${field.label}必须是布尔值` };
      }
      config[field.key] = value;
    } else {
      if (typeof value !== "string") {
        return { ok: false, reason: `${field.label}必须是文本` };
      }
      config[field.key] = value;
    }
  }
  return { ok: true, config };
}
