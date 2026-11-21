import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export type CommandResult = { code: number; stderr: string; stdout: string };
export type CommandRunner = (args: string[]) => Promise<CommandResult>;

export type ImageBuildInput = {
  registry: string;
  projectCode: string;
  sourceRevision: string;
  files: Record<string, string>;
};

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const runtimeAssets = ["package.json", "index.mjs", "server.mjs"] as const;
const runtimeDependencies = ["pg"] as const;

type RequireFrom = ReturnType<typeof createRequire>;

/**
 * 运行库随镜像一起发布：生成的模块 import "@platform/runtime"，
 * 镜像里要有对应的 node_modules 目录才能启动。
 */
export async function readRuntimeFiles(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    runtimeAssets.map(
      async (name) => [name, await readFile(fileURLToPath(new URL(name, new URL("./runtime/", import.meta.url))), "utf8")] as const,
    ),
  );
  return Object.fromEntries(
    entries.map(([name, content]) => [`node_modules/@platform/runtime/${name}`, content]),
  );
}

/**
 * 运行库在 DATABASE_URL 存在时按需 import "pg"。镜像里没有 pnpm，
 * 因此构建时把 pg 及其传递依赖整棵复制进镜像的 node_modules。
 * 解析不到的包按可选依赖处理，跳过即可。
 */
export async function readRuntimeDependencies(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  const root = createRequire(import.meta.url);
  for (const name of runtimeDependencies) {
    await collectPackage(name, root, files, seen);
  }
  return files;
}

async function collectPackage(
  name: string,
  requireFrom: RequireFrom,
  files: Record<string, string>,
  seen: Set<string>,
): Promise<void> {
  const manifestPath = await resolveManifest(name, requireFrom);
  if (!manifestPath) {
    return;
  }
  const directory = dirname(manifestPath);
  if (seen.has(directory)) {
    return;
  }
  seen.add(directory);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const [relative, content] of await readPackageDirectory(directory)) {
    files[`node_modules/${name}/${relative}`] = content;
  }
  const nested = createRequire(manifestPath);
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    await collectPackage(dependency, nested, files, seen);
  }
}

/**
 * 有些包在 exports 里屏蔽了 ./package.json，不能直接 resolve 清单，
 * 因此先解析入口文件，再向上找到 name 匹配的 package.json。
 */
async function resolveManifest(name: string, requireFrom: RequireFrom): Promise<string | undefined> {
  let entry: string;
  try {
    entry = requireFrom.resolve(name);
  } catch {
    return undefined;
  }
  let directory = dirname(entry);
  for (;;) {
    try {
      const manifestPath = join(directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: string };
      if (manifest.name === name) {
        return manifestPath;
      }
    } catch {
      // 继续向上找
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

async function readPackageDirectory(root: string, prefix = ""): Promise<Array<[string, string]>> {
  const entries = await readdir(prefix ? join(root, prefix) : root, { withFileTypes: true });
  const files: Array<[string, string]> = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") {
        continue;
      }
      files.push(...(await readPackageDirectory(root, relative)));
    } else if (entry.isFile()) {
      files.push([relative, await readFile(join(root, relative), "utf8")]);
    }
  }
  return files;
}

export function imageDockerfile(): string {
  return [
    "FROM node:24-bookworm-slim",
    "WORKDIR /app",
    "COPY node_modules ./node_modules",
    "COPY modules ./modules",
    // 黑盒测试入口与浏览器装在独立目录，运行库启动不需要这些依赖。
    "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    "    ca-certificates chromium fonts-liberation libnss3 libatk-bridge2.0-0 \\",
    "    libgtk-3-0 libgbm1 libasound2 libxss1 libxtst6 xdg-utils \\",
    "    && rm -rf /var/lib/apt/lists/*",
    "RUN mkdir -p /opt/test-harness && cd /opt/test-harness \\",
    "    && npm init -y >/dev/null 2>&1 \\",
    "    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund playwright @playwright/test @midscene/web",
    "ENV PORT=8080",
    "ENV PLATFORM_BROWSER_MODULE=/opt/test-harness/node_modules/playwright/index.mjs",
    "ENV PLATFORM_MIDSCENE_MODULE=/opt/test-harness/node_modules/@midscene/web/dist/es/playwright/index.mjs",
    "ENV PLATFORM_CHROMIUM_PATH=/usr/bin/chromium",
    // openai-chat 是协议；family 必须是受支持的视觉模型族，运行时可按系统设置覆盖。
    "ENV MIDSCENE_MODEL_PROTOCOL=openai-chat",
    "ENV MIDSCENE_MODEL_FAMILY=qwen2.5-vl",
    "EXPOSE 8080",
    'CMD ["node", "node_modules/@platform/runtime/server.mjs"]',
    "",
  ].join("\n");
}

export function projectDatabaseName(prefix: "prd" | "tst", projectCode: string): string {
  const room = 63 - prefix.length - 1;
  return `${prefix}_${projectCode.slice(0, room)}`;
}

/**
 * 部署里的私有镜像库监听 5000，但 `registry.address` 常被写成
 * `registry.internal`。少了端口时 docker push 会落到 443，补上默认端口。
 */
export function registryWithPort(registry: string): string {
  const host = registry.split("/")[0] ?? "";
  if (!host || host.includes(":") || registry.includes("://")) {
    return registry;
  }
  return `${host}:5000${registry.slice(host.length)}`;
}

export async function runDockerBuild(
  runner: CommandRunner,
  input: ImageBuildInput,
): Promise<{ digest: string } | { reason: string }> {
  const directory = await mkdtemp(join(tmpdir(), "platform-image-"));
  try {
    const files = { ...(await readRuntimeFiles()), ...(await readRuntimeDependencies()), ...input.files };
    for (const [file, content] of Object.entries(files)) {
      const target = join(directory, ...file.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    }
    await writeFile(join(directory, "Dockerfile"), imageDockerfile());
    const tag = `${registryWithPort(input.registry)}/${input.projectCode}:${input.sourceRevision.replace(/^sha256:/, "").slice(0, 12)}`;
    const result = await runner(["build", "-q", "-t", tag, directory]);
    if (result.code !== 0) {
      return { reason: result.stderr.trim() || result.stdout.trim() || "镜像构建失败" };
    }
    const digest = result.stdout
      .trim()
      .split(/\s+/)
      .filter((line) => digestPattern.test(line))
      .at(-1);
    if (!digest) {
      return { reason: "镜像摘要无效" };
    }
    const pushed = await runner(["push", tag]);
    if (pushed.code !== 0) {
      return { reason: pushed.stderr.trim() || pushed.stdout.trim() || "镜像推送失败" };
    }
    return { digest };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function dockerImageBuilder(): (input: ImageBuildInput) => Promise<{ digest: string } | { reason: string }> {
  return (input) => runDockerBuild(dockerCommandRunner(), input);
}

function dockerCommandRunner(): CommandRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn("docker", args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => resolve({ code: 1, stderr: error.message, stdout }));
      child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
    });
}
