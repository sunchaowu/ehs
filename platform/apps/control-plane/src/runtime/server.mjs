/**
 * 模块进程入口：扫描 modules 目录，加载每个项目的 module.ts，启动 HTTP 服务。
 * 镜像里直接以 `node node_modules/@platform/runtime/server.mjs` 启动。
 */
import { createServer } from "node:http";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { createApp, connectPostgres } from "./index.mjs";

const moduleFilePattern = /^module\.(ts|js|mjs)$/;

export async function loadModules(modulesDir) {
  const entries = await readdir(modulesDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const modules = [];
  for (const name of directories) {
    const directory = join(modulesDir, name);
    const files = await readdir(directory);
    const file = files.find((candidate) => moduleFilePattern.test(candidate));
    if (!file) {
      continue;
    }
    const imported = await import(pathToFileURL(join(directory, file)).href);
    const definition = imported.moduleDefinition ?? imported.default;
    if (!definition) {
      throw new Error(`模块缺少 moduleDefinition：${name}`);
    }
    modules.push(definition);
  }
  if (modules.length === 0) {
    throw new Error("没有找到可运行的项目模块");
  }
  return modules;
}

export async function startModules(options = {}) {
  const modulesDir = options.modulesDir ?? join(process.cwd(), "modules");
  const host = options.host ?? "0.0.0.0";
  const modules = await loadModules(modulesDir);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const database = databaseUrl ? await connectPostgres(databaseUrl) : undefined;
  const app = createApp(modules, database?.store);
  const server = createServer((request, response) => {
    void app.handle(request, response);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 8080, host, resolveListen);
  });
  const address = server.address();
  return {
    server,
    port: typeof address === "object" && address ? address.port : options.port ?? 8080,
    modules,
    storage: app.store.kind,
    closeDatabase: database ? () => database.pool.end() : undefined,
  };
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const port = Number(process.env.PORT ?? "8080");
  const { port: actualPort, modules, server, storage, closeDatabase } = await startModules({ port });
  const mode = process.env["runtime.mode"] ?? "prod";
  console.log(
    `平台运行库已启动：端口 ${actualPort}，模式 ${mode}，存储 ${storage}，模块 ${modules.map((item) => item.projectCode).join(",")}`,
  );
  const shutdown = () => {
    server.close(() => {
      void closeDatabase?.().finally(() => process.exit(0));
      if (!closeDatabase) {
        process.exit(0);
      }
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
