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

export type ContainerRuntime = {
  pull(image: string): Promise<{ pulled: true } | { reason: string }>;
  start(input: { projectCode: string; image: string; databaseName: string }): Promise<{ running: true } | { reason: string }>;
  checkDatabase(databaseName: string): Promise<{ connected: true } | { reason: string }>;
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
    const database = await runtime.checkDatabase(assignment.databaseName);
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

export function dockerContainerRuntime(
  runner: CommandRunner = dockerCommandRunner(),
  checkDatabase: (databaseName: string) => Promise<{ connected: true } | { reason: string }> = async () => ({
    reason: "项目数据库连通性由节点本机检查",
  }),
): ContainerRuntime {
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
      const result = await runner([
        "run",
        "-d",
        "--name",
        name,
        "-e",
        `DATABASE_NAME=${input.databaseName}`,
        "-e",
        "runtime.mode=prod",
        input.image,
      ]);
      if (result.code !== 0) {
        return { reason: result.stderr.trim() || result.stdout.trim() || "容器启动失败" };
      }
      return { running: true };
    },
    checkDatabase,
  };
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
