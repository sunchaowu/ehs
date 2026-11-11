import { describe, expect, it } from "vitest";
import { dockerContainerRuntime, reconcileAssignments, runNodeAgentCycle } from "../src/node-agent.js";

describe("node docker runtime", () => {
  it("does not start a container when the image pull fails", async () => {
    const commands: string[][] = [];
    const runtime = dockerContainerRuntime(async (args) => {
      commands.push(args);
      if (args[0] === "pull") {
        return { code: 1, stderr: "镜像拉取失败", stdout: "" };
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const report = await reconcileAssignments(
      [{ projectCode: "qing-jia-shen-pi", imageDigest: "sha256:" + "ab".repeat(32), databaseName: "prd_qing-jia-shen-pi", replicas: 1 }],
      runtime,
    );
    expect(report.projects).toEqual([
      { code: "qing-jia-shen-pi", running: false, databaseConnected: false, imageDigest: "", reason: "镜像拉取失败" },
    ]);
    expect(commands.some((command) => command[0] === "run")).toBe(false);
  });

  it("injects the project database name and omits control-plane secrets", async () => {
    const commands: string[][] = [];
    const runtime = dockerContainerRuntime(async (args) => {
      commands.push(args);
      return { code: 0, stderr: "", stdout: "" };
    }, async () => ({ connected: true }));
    const pulled = await runtime.pull("sha256:" + "cd".repeat(32));
    const started = await runtime.start({
      projectCode: "qing-jia-shen-pi",
      image: "sha256:" + "cd".repeat(32),
      databaseName: "prd_qing-jia-shen-pi",
    });
    expect(pulled).toEqual({ pulled: true });
    expect(started).toEqual({ running: true });
    const run = commands.find((command) => command[0] === "run");
    expect(run).toBeTruthy();
    expect(run?.join(" ")).toContain("DATABASE_NAME=prd_qing-jia-shen-pi");
    expect(run?.join(" ")).not.toContain("DATABASE_SYSTEM_URL");
    expect(run?.join(" ")).not.toContain("model.apiKey");
  });

  it("reports the reconcile result back to the control plane", async () => {
    const reports: unknown[] = [];
    const result = await runNodeAgentCycle(
      {
        nodeName: "prod-1",
        controlPlaneUrl: "https://platform.internal",
        token: "node-token",
        fetchDesired: async () => ({
          projects: [{ code: "stock", imageDigest: "sha256:" + "ab".repeat(32), databaseName: "prd_stock", replicas: 1 }],
        }),
        reportHealth: async (body) => {
          reports.push(body);
          return { accepted: true };
        },
      },
      {
        pull: async () => ({ pulled: true as const }),
        start: async () => ({ running: true as const }),
        checkDatabase: async () => ({ connected: true as const }),
      },
    );
    expect(result).toEqual({
      projects: [{ code: "stock", running: true, databaseConnected: true, imageDigest: "sha256:" + "ab".repeat(32) }],
    });
    expect(reports).toEqual([result]);
  });
});
