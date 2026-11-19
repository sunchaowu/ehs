import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judgeStep, requestForStep, runWhiteBoxCases } from "../src/test-runner.mjs";
import { databaseUrl, reconcileProject, runTestJob } from "../src/node-agent-template.mjs";

const temporary = [];

afterEach(async () => {
  delete process.env.PLATFORM_DATABASE_URL_TEMPLATE;
  delete process.env.PLATFORM_NODE_NAME;
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "platform-agent-test-"));
  temporary.push(directory);
  return directory;
}

describe("white-box test runner", () => {
  it("maps case steps to runtime requests", () => {
    const created = requestForStep({
      action: "call",
      target: "qing-jia/qing-jia-dan.create",
      value: JSON.stringify({ 标题: "示例" }),
    });
    expect(created.method).toBe("POST");
    expect(created.path).toBe("/api/qing-jia/qing-jia-dan");
    expect(created.expect).toBe("created");
    expect(JSON.parse(created.body)).toEqual({ value: { 标题: "示例" } });

    const invalid = requestForStep({ action: "validate", target: "qing-jia/qing-jia-dan/天数", value: JSON.stringify({ 天数: "x" }) });
    expect(invalid.expect).toBe("invalid");
    expect(invalid.field).toBe("天数");

    const menu = requestForStep({ action: "call", target: "qing-jia/menus/qing-jia-dan", value: "未授权用户" });
    expect(menu.method).toBe("GET");
    expect(menu.path).toBe("/api/qing-jia/menus/qing-jia-dan");
    expect(menu.headers["x-platform-user"]).toBe(encodeURIComponent("未授权用户"));

    const migrate = requestForStep({ action: "migrate", target: "qing-jia/workflows/请假流程/submit" });
    expect(migrate.path).toBe("/api/qing-jia/workflows/%E8%AF%B7%E5%81%87%E6%B5%81%E7%A8%8B/submit");
    expect(migrate.expect).toBe("migrated");

    expect(requestForStep({ action: "click", target: "qing-jia/qing-jia-dan/submit" }).reason).toContain("不受支持");
  });

  it("judges responses by assertion type", () => {
    const created = requestForStep({ action: "call", target: "a/b.create", value: "{}" });
    expect(judgeStep(created, created, 201, { record: { id: "r1" } }).passed).toBe(true);
    expect(judgeStep(created, created, 400, { reason: "缺少字段" }).passed).toBe(false);

    const invalid = requestForStep({ action: "validate", target: "a/b/c", value: "{}" });
    expect(judgeStep(invalid, invalid, 400, { reason: "c 必须是数字" }).passed).toBe(true);
    expect(judgeStep(invalid, invalid, 201, { record: { id: "r1" } }).passed).toBe(false);

    const menu = requestForStep({ action: "call", target: "a/menus/m", value: "u" });
    expect(judgeStep(menu, menu, 403, { reason: "未授权访问" }).passed).toBe(true);
    expect(judgeStep(menu, menu, 200, { menu: {} }).passed).toBe(false);

    const migrate = requestForStep({ action: "migrate", target: "a/workflows/w/s" });
    expect(judgeStep(migrate, migrate, 200, {}).passed).toBe(true);
  });

  it("runs white-box cases against a container and fails black-box cases explicitly", async () => {
    const cases = [
      {
        code: "case-1",
        name: "创建",
        method: "white-box",
        steps: [{ index: 1, action: "call", target: "a/b.create", value: "{}", expected: "返回带 id 的记录" }],
      },
      {
        code: "case-2",
        name: "界面",
        method: "black-box",
        steps: [{ index: 1, action: "click", target: "a/b/submit", expected: "保存成功" }],
      },
      {
        code: "case-3",
        name: "未知",
        method: "white-box",
        steps: [{ index: 1, action: "click", target: "a/b/submit", expected: "保存成功" }],
      },
    ];
    const outcomes = await runWhiteBoxCases(cases, {
      timeoutSeconds: 5,
      fetchImpl: async (url) => {
        expect(url).toBe("http://127.0.0.1:8080/api/a/b");
        return new Response(JSON.stringify({ record: { id: "r1" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].passed).toBe(true);
    expect(outcomes[0].actual).toContain("r1");
    expect(outcomes[1].passed).toBe(false);
    expect(outcomes[1].reason).toContain("黑盒执行器未配置");
    expect(outcomes[2].passed).toBe(false);
    expect(outcomes[2].reason).toContain("不受支持");
  });
});

describe("test node agent", () => {
  it("builds the project database url from the local template", () => {
    process.env.PLATFORM_DATABASE_URL_TEMPLATE = "postgres://platform:pw@db:5432/{database}";
    expect(databaseUrl("tst_qing_jia")).toBe("postgres://platform:pw@db:5432/tst_qing_jia");
    process.env.PLATFORM_DATABASE_URL_TEMPLATE = "postgres://fixed";
    expect(databaseUrl("ignored")).toBe("postgres://fixed");
  });

  it("runs a test container, copies the runner, reports steps, and cleans up", async () => {
    process.env.PLATFORM_NODE_NAME = "test-1";
    process.env.PLATFORM_DATABASE_URL_TEMPLATE = "postgres://platform:pw@db:5432/{database}";
    const directory = await tempDirectory();
    await writeFile(join(directory, "test-runner.mjs"), "// runner", "utf8");
    const calls = [];
    const reports = [];
    const docker = async (args) => {
      calls.push(args);
      if (args[0] === "exec" && args[1] === "platform-test-job01" && args[2] === "node") {
        return { code: 0, stdout: JSON.stringify({ storage: "postgres" }), stderr: "" };
      }
      if (args[0] === "exec" && args[1] === "-e") {
        return {
          code: 0,
          stdout: JSON.stringify({ outcomes: [{ caseCode: "case-1", stepIndex: 1, passed: true }] }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const request = async (path, init) => {
      reports.push({ path, body: JSON.parse(init.body) });
      return { accepted: true };
    };
    await runTestJob(
      {
        id: "job-01",
        runId: "run-1",
        projectCode: "qing-jia",
        imageDigest: "registry.internal:5000/qing-jia:latest",
        databaseName: "tst_qing_jia",
        cases: [],
        stepTimeoutSeconds: 10,
        runTimeoutSeconds: 600,
      },
      { docker, request, nodeDir: directory },
    );
    const run = calls.find((args) => args[0] === "run");
    expect(run).toContain("runtime.mode=test");
    expect(run).toContain("DATABASE_URL=postgres://platform:pw@db:5432/tst_qing_jia");
    expect(calls.some((args) => args[0] === "cp" && args[2].endsWith(":/tmp/platform-test-runner.mjs"))).toBe(true);
    expect(calls.some((args) => args[0] === "cp" && args[2].endsWith(":/tmp/platform-test-payload.json"))).toBe(true);
    expect(reports[0].path).toBe("/api/nodes/test-1/tests/job-01");
    expect(reports[0].body.outcomes[0].passed).toBe(true);
    expect(calls.filter((args) => args[0] === "rm" && args[1] === "-f").length).toBeGreaterThanOrEqual(2);
  });

  it("reports a failed pull without starting a container", async () => {
    process.env.PLATFORM_NODE_NAME = "test-1";
    const directory = await tempDirectory();
    const calls = [];
    const reports = [];
    await runTestJob(
      {
        id: "job-02",
        imageDigest: "registry.internal:5000/missing:latest",
        databaseName: "tst_x",
        cases: [],
      },
      {
        nodeDir: directory,
        docker: async (args) => {
          calls.push(args);
          return args[0] === "pull"
            ? { code: 1, stdout: "", stderr: "manifest unknown" }
            : { code: 0, stdout: "", stderr: "" };
        },
        request: async (path, init) => {
          reports.push({ path, body: JSON.parse(init.body) });
          return { accepted: true };
        },
      },
    );
    expect(calls.some((args) => args[0] === "run")).toBe(false);
    expect(reports[0].body.reason).toContain("manifest unknown");
  });

  it("reports project health from the runtime storage flag", async () => {
    process.env.PLATFORM_DATABASE_URL_TEMPLATE = "postgres://platform:pw@db:5432/{database}";
    const calls = [];
    const report = await reconcileProject(
      { code: "qing-jia", imageDigest: "img", databaseName: "prd_qing_jia" },
      {
        docker: async (args) => {
          calls.push(args);
          return args[0] === "exec"
            ? { code: 0, stdout: JSON.stringify({ storage: "postgres" }), stderr: "" }
            : { code: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(report).toEqual({ code: "qing-jia", running: true, databaseConnected: true, imageDigest: "img", reason: undefined });
    expect(calls.find((args) => args[0] === "run")).toContain("runtime.mode=prod");
    expect(calls.find((args) => args[0] === "run")).toContain("DATABASE_URL=postgres://platform:pw@db:5432/prd_qing_jia");
  });
});
