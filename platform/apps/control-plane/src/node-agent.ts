import { spawn } from "node:child_process";

export type NodeAssignment = {
  projectCode: string;
  imageDigest: string;
  databaseName: string;
  replicas: number;
};

export type HealthProject = {
  code: string;
  running: boolean;
  databaseConnected: boolean;
  imageDigest: string;
  reason?: string;
};

export type DatabaseCheckInput = { projectCode: string; databaseName: string };

export type ContainerRuntime = {
  pull(image: string): Promise<{ pulled: true } | { reason: string }>;
  start(input: { projectCode: string; image: string; databaseName: string }): Promise<{ running: true } | { reason: string }>;
  checkDatabase(input: DatabaseCheckInput): Promise<{ connected: true } | { reason: string }>;
};

type CommandResult = { code: number; stderr: string; stdout: string };
type CommandRunner = (args: string[]) => Promise<CommandResult>;

export async function reconcileAssignments(
  assignments: NodeAssignment[],
  runtime: ContainerRuntime,
): Promise<{ projects: HealthProject[] }> {
  const projects: HealthProject[] = [];
  for (const assignment of assignments) {
    const pulled = await runtime.pull(assignment.imageDigest);
    if ("reason" in pulled) {
      projects.push({ code: assignment.projectCode, running: false, databaseConnected: false, imageDigest: "", reason: pulled.reason });
      continue;
    }
    const started = await runtime.start({
      projectCode: assignment.projectCode,
      image: assignment.imageDigest,
      databaseName: assignment.databaseName,
    });
    if ("reason" in started) {
      projects.push({
        code: assignment.projectCode,
        running: false,
        databaseConnected: false,
        imageDigest: assignment.imageDigest,
        reason: started.reason,
      });
      continue;
    }
    const database = await runtime.checkDatabase({
      projectCode: assignment.projectCode,
      databaseName: assignment.databaseName,
    });
    projects.push({
      code: assignment.projectCode,
      running: true,
      databaseConnected: !("reason" in database),
      imageDigest: assignment.imageDigest,
      reason: "reason" in database ? database.reason : undefined,
    });
  }
  return { projects };
}

export type DockerRuntimeOptions = {
  /** 项目数据库连接串模板，`{database}` 会替换成项目数据库名；留空则不注入 DATABASE_URL。 */
  databaseUrlTemplate?: string;
  /** 容器健康检查重试次数，默认 10 次、每次间隔 1 秒。 */
  healthAttempts?: number;
  healthIntervalMs?: number;
};

export function databaseUrlFromTemplate(template: string | undefined, databaseName: string): string {
  if (!template) {
    return "";
  }
  return template.includes("{database}") ? template.replaceAll("{database}", databaseName) : template;
}

export function dockerContainerRuntime(
  runner: CommandRunner = dockerCommandRunner(),
  checkDatabase?: (input: DatabaseCheckInput) => Promise<{ connected: true } | { reason: string }>,
  options: DockerRuntimeOptions = {},
): ContainerRuntime {
  const template = options.databaseUrlTemplate ?? process.env.PLATFORM_DATABASE_URL_TEMPLATE;
  return {
    async pull(image) {
      const result = await runner(["pull", image]);
      if (result.code !== 0) {
        return { reason: result.stderr.trim() || result.stdout.trim() || "镜像拉取失败" };
      }
      return { pulled: true };
    },
    async start(input) {
      const name = `platform-${input.projectCode}`;
      await runner(["rm", "-f", name]);
      const args = [
        "run",
        "-d",
        "--name",
        name,
        "-e",
        `DATABASE_NAME=${input.databaseName}`,
        "-e",
        "runtime.mode=prod",
      ];
      const databaseUrl = databaseUrlFromTemplate(template, input.databaseName);
      if (databaseUrl) {
        args.push("-e", `DATABASE_URL=${databaseUrl}`);
      }
      args.push(input.image);
      const result = await runner(args);
      if (result.code !== 0) {
        return { reason: result.stderr.trim() || result.stdout.trim() || "容器启动失败" };
      }
      return { running: true };
    },
    checkDatabase:
      checkDatabase ??
      ((input) =>
        containerHealth(runner, input.projectCode, options.healthAttempts ?? 10, options.healthIntervalMs ?? 1000)),
  };
}

const healthScript =
  "fetch('http://127.0.0.1:8080/health').then((r) => r.json()).then((j) => console.log(JSON.stringify(j))).catch(() => process.exit(1))";

async function containerHealth(
  runner: CommandRunner,
  projectCode: string,
  attempts: number,
  intervalMs: number,
): Promise<{ connected: true } | { reason: string }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await runner(["exec", `platform-${projectCode}`, "node", "-e", healthScript]);
    if (result.code === 0) {
      try {
        const health = JSON.parse(result.stdout.trim()) as { storage?: string };
        if (health.storage === "postgres") {
          return { connected: true };
        }
        return { reason: "运行库未连接项目数据库" };
      } catch {
        // 容器刚启动时健康检查可能还没就绪，继续重试。
      }
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return { reason: "容器健康检查未返回数据库状态" };
}

export async function runNodeAgentCycle(
  bridge: {
    nodeName: string;
    controlPlaneUrl: string;
    token: string;
    fetchDesired: () => Promise<{ projects: Array<{ code: string; imageDigest: string; databaseName: string; replicas: number }> } | { reason: string }>;
    reportHealth: (body: { projects: HealthProject[] }) => Promise<{ accepted: true } | { reason: string }>;
  },
  runtime: ContainerRuntime,
): Promise<{ projects: HealthProject[] } | { reason: string }> {
  const desired = await bridge.fetchDesired();
  if ("reason" in desired) {
    return desired;
  }
  const report = await reconcileAssignments(
    desired.projects.map((project) => ({
      projectCode: project.code,
      imageDigest: project.imageDigest,
      databaseName: project.databaseName,
      replicas: project.replicas,
    })),
    runtime,
  );
  const accepted = await bridge.reportHealth({ projects: report.projects });
  if ("reason" in accepted) {
    return accepted;
  }
  return report;
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
