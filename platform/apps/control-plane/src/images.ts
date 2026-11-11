import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export function projectDatabaseName(prefix: "prd" | "tst", projectCode: string): string {
  const room = 63 - prefix.length - 1;
  return `${prefix}_${projectCode.slice(0, room)}`;
}

export async function runDockerBuild(
  runner: CommandRunner,
  input: ImageBuildInput,
): Promise<{ digest: string } | { reason: string }> {
  const directory = await mkdtemp(join(tmpdir(), "platform-image-"));
  try {
    for (const [file, content] of Object.entries(input.files)) {
      const target = join(directory, ...file.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    }
    await writeFile(join(directory, "Dockerfile"), "FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY modules ./modules\n");
    const tag = `${input.registry}/${input.projectCode}:${input.sourceRevision.replace(/^sha256:/, "").slice(0, 12)}`;
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
