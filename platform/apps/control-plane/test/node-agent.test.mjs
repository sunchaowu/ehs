import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapBrowser,
  createMidsceneVisualLocator,
  judgeStep,
  locateElement,
  midscenePrompt,
  openPathForTarget,
  requestForStep,
  runAllCases,
  runBlackBoxCases,
  runWhiteBoxCases,
  visualLocate,
  workflowPathForTarget,
} from "../src/test-runner.mjs";
import { databaseUrl, gatewayUrl, parseDockerPort, proxyToProject, reconcileProject, runTestJob } from "../src/node-agent-template.mjs";

const temporary = [];

afterEach(async () => {
  delete process.env.PLATFORM_DATABASE_URL_TEMPLATE;
  delete process.env.PLATFORM_NODE_NAME;
  delete process.env.PLATFORM_NODE_GATEWAY_PORT;
  delete process.env.PLATFORM_NODE_GATEWAY_URL;
  delete process.env.PLATFORM_NODE_ADDRESS;
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
    expect(outcomes[1].reason).toContain("黑盒步骤需由黑盒执行器处理");
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
    const terminal = reports.find((item) => item.path === "/api/nodes/test-1/tests/job-01");
    expect(terminal.body.outcomes[0].passed).toBe(true);
    expect(terminal.body.log).toContain("执行测试");
    expect(reports.some((item) => item.path.endsWith("/log") && item.body.log)).toBe(true);
    expect(calls.filter((args) => args[0] === "rm" && args[1] === "-f").length).toBeGreaterThanOrEqual(2);
  });

  it("writes the model config into the test payload for the black-box runner", async () => {
    process.env.PLATFORM_NODE_NAME = "test-1";
    process.env.PLATFORM_DATABASE_URL_TEMPLATE = "postgres://platform:pw@db:5432/{database}";
    const directory = await tempDirectory();
    await writeFile(join(directory, "test-runner.mjs"), "// runner", "utf8");
    let payload;
    const docker = async (args) => {
      if (args[0] === "cp" && args[2].endsWith(":/tmp/platform-test-payload.json")) {
        payload = JSON.parse(await readFile(args[1], "utf8"));
      }
      if (args[0] === "exec" && args[2] === "node" && args[3] === "-e") {
        return { code: 0, stdout: JSON.stringify({ storage: "postgres" }), stderr: "" };
      }
      if (args[0] === "exec" && args[1] === "-e") {
        return { code: 0, stdout: JSON.stringify({ outcomes: [] }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    await runTestJob(
      {
        id: "job-model",
        runId: "run-1",
        projectCode: "qing-jia",
        imageDigest: "registry.internal:5000/qing-jia:latest",
        databaseName: "tst_qing_jia",
        cases: [],
        stepTimeoutSeconds: 10,
        runTimeoutSeconds: 600,
        modelBaseUrl: "http://vllm.internal:8000/v1",
        modelName: "qwen2.5-vl",
        modelApiKey: "secret-key-for-test",
      },
      { docker, request: async () => ({ accepted: true }), nodeDir: directory },
    );
    expect(payload).toMatchObject({
      modelBaseUrl: "http://vllm.internal:8000/v1",
      modelName: "qwen2.5-vl",
      modelApiKey: "secret-key-for-test",
    });
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
    const terminal = reports.find((item) => item.path === "/api/nodes/test-1/tests/job-02");
    expect(terminal.body.reason).toContain("manifest unknown");
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
    expect(calls.find((args) => args[0] === "run")).toContain("127.0.0.1::8080");
    expect(calls.some((args) => args[0] === "port" && args[2] === "8080/tcp")).toBe(true);
  });
});

describe("project entry gateway", () => {
  it("parses the published container port", () => {
    expect(parseDockerPort("0.0.0.0:49153\n[::]:49153\n")).toBe(49153);
    expect(parseDockerPort("")).toBe(0);
  });

  it("uses an explicit gateway url first, then the node address and port", () => {
    process.env.PLATFORM_NODE_ADDRESS = "172.18.0.32";
    process.env.PLATFORM_NODE_GATEWAY_PORT = "8090";
    expect(gatewayUrl()).toBe("http://172.18.0.32:8090");
    process.env.PLATFORM_NODE_GATEWAY_URL = "http://gateway.internal:8081/";
    expect(gatewayUrl()).toBe("http://gateway.internal:8081");
    // 没有显式地址时退回本机可达的非回环 IPv4，保证控制面能连上。
    delete process.env.PLATFORM_NODE_GATEWAY_URL;
    delete process.env.PLATFORM_NODE_ADDRESS;
    delete process.env.PLATFORM_NODE_GATEWAY_PORT;
    expect(gatewayUrl()).toMatch(/^http:\/\/.+:8081$/);
    expect(gatewayUrl()).not.toContain("127.0.0.1");
  });

  it("forwards the request to the published container port with the identity headers", async () => {
    const calls = [];
    const request = Object.assign(Readable.from([Buffer.from('{"name":"张三"}')]), {
      url: "/p/qing-jia/qing-jia-dan?created=1",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-platform-user": encodeURIComponent("张三"),
        "x-platform-roles": encodeURIComponent("部门负责人"),
        cookie: "platform_session=secret",
      },
    });
    const state = {};
    const response = {
      writeHead(status, headers) {
        state.status = status;
        state.headers = headers;
      },
      end(body) {
        state.body = body;
      },
    };
    await proxyToProject(
      request,
      response,
      async (url, init) => {
        calls.push({ url, init });
        return new Response("<p>ok</p>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", location: "/p/qing-jia/qing-jia-dan?created=1" },
        });
      },
      new Map([["qing-jia", 49153]]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:49153/p/qing-jia/qing-jia-dan?created=1");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
    expect(calls[0].init.headers["x-platform-user"]).toBe(encodeURIComponent("张三"));
    expect(calls[0].init.headers["x-platform-roles"]).toBe(encodeURIComponent("部门负责人"));
    expect(calls[0].init.headers["cookie"]).toBeUndefined();
    expect(Buffer.from(calls[0].init.body).toString("utf8")).toBe('{"name":"张三"}');
    expect(state.status).toBe(200);
    expect(state.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(state.headers.location).toBe("/p/qing-jia/qing-jia-dan?created=1");
    expect(state.body.toString("utf8")).toBe("<p>ok</p>");
  });

  it("returns 404 for a project without a published container and 502 when the container is unreachable", async () => {
    const missing = {};
    await proxyToProject(
      Object.assign(Readable.from([]), { url: "/p/missing/form", method: "GET", headers: {} }),
      { writeHead(status) { missing.status = status; }, end() {} },
      async () => {
        throw new Error("should not be called");
      },
      new Map(),
    );
    expect(missing.status).toBe(404);

    const unreachable = {};
    await proxyToProject(
      Object.assign(Readable.from([]), { url: "/p/qing-jia/form", method: "GET", headers: {} }),
      { writeHead(status) { unreachable.status = status; }, end() {} },
      async () => {
        throw new Error("connect refused");
      },
      new Map([["qing-jia", 49153]]),
    );
    expect(unreachable.status).toBe(502);
  });
});

describe("black-box test runner", () => {
  function fakePage(elements = {}) {
    const calls = [];
    function locatorFor(exists, selector) {
      return {
        async count() {
          return exists ? 1 : 0;
        },
        async isVisible() {
          return Boolean(exists);
        },
        async fill(value) {
          calls.push(["fill", selector, value]);
        },
        async click() {
          calls.push(["click", selector]);
        },
      };
    }
    const page = {
      calls,
      async goto(url) {
        calls.push(["goto", url]);
      },
      async screenshot(args) {
        calls.push(["screenshot", args?.path ?? null]);
        return Buffer.from("png");
      },
      locator(selector) {
        calls.push(["locator", selector]);
        return locatorFor(elements[selector], selector);
      },
      getByRole(role, options) {
        const key = `role:${role}:${options.name}`;
        calls.push(["getByRole", role, options.name]);
        return locatorFor(elements[key], key);
      },
      mouse: {
        click() {
          calls.push(["mouse.click"]);
          throw new Error("禁止坐标点击");
        },
      },
    };
    return page;
  }

  function modelResponse(content, status = 200) {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }

  it("maps step targets to runtime page addresses", () => {
    expect(openPathForTarget("qing-jia/qing-jia-dan/form")).toBe("/p/qing-jia/qing-jia-dan/form");
    expect(openPathForTarget("qing-jia/qing-jia-dan")).toBe("/p/qing-jia/qing-jia-dan");
    expect(workflowPathForTarget("qing-jia/请假流程/submit")).toBe("/p/qing-jia/workflows/%E8%AF%B7%E5%81%87%E6%B5%81%E7%A8%8B");
  });

  it("executes open/fill/click through stable test ids and never uses coordinates", async () => {
    const page = fakePage({
      '[data-testid="qing-jia/qing-jia-dan/form"]': true,
      '[data-testid="qing-jia/qing-jia-dan/申请人"]': true,
      '[data-testid="qing-jia/qing-jia-dan/submit"]': true,
    });
    const cases = [
      {
        code: "c1",
        name: "新增请假单",
        method: "black-box",
        steps: [
          { index: 1, action: "open", target: "qing-jia/qing-jia-dan/form", expected: "表单打开" },
          { index: 2, action: "fill", target: "qing-jia/qing-jia-dan/申请人", value: "张三", expected: "已输入" },
          { index: 3, action: "click", target: "qing-jia/qing-jia-dan/submit", expected: "保存成功" },
        ],
      },
    ];
    const { outcomes } = await runBlackBoxCases(cases, { page });
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((outcome) => outcome.passed)).toBe(true);
    expect(outcomes[0].actual).toBe("/p/qing-jia/qing-jia-dan/form");
    expect(outcomes[1].locator).toContain("stable:");
    expect(page.calls.some((call) => call[0] === "fill" && call[2] === "张三")).toBe(true);
    expect(page.calls.some((call) => call[0] === "click")).toBe(true);
    expect(page.calls.some((call) => call[0] === "mouse.click")).toBe(false);
  });

  it("falls back to role and accessible name when the stable id is absent", async () => {
    const page = fakePage({ "role:textbox:申请人": true });
    const cases = [
      {
        code: "c2",
        name: "角色定位",
        method: "black-box",
        steps: [{ index: 1, action: "fill", target: "qing-jia/qing-jia-dan/申请人", value: "李四", expected: "已输入" }],
      },
    ];
    const { outcomes } = await runBlackBoxCases(cases, { page });
    expect(outcomes[0].passed).toBe(true);
    expect(outcomes[0].locator).toContain("role:textbox");
    expect(page.calls.some((call) => call[0] === "getByRole" && call[2] === "申请人")).toBe(true);
  });

  it("uses model visual localization and caches the successful selector", async () => {
    const page = fakePage({ '[data-testid="visual-1"]': true });
    let modelCalls = 0;
    const fetchImpl = async (url, init) => {
      modelCalls += 1;
      expect(url).toBe("http://vllm.internal:8000/v1/chat/completions");
      expect(init.headers.authorization).toBe("Bearer secret");
      expect(JSON.parse(init.body).messages[1].content[1].image_url.url).toContain("data:image/png;base64,");
      return modelResponse('[data-testid="visual-1"]');
    };
    const cases = [
      {
        code: "c3",
        name: "视觉定位",
        method: "black-box",
        steps: [
          { index: 1, action: "fill", target: "qing-jia/qing-jia-dan/申请人", value: "王五", expected: "已输入" },
          { index: 2, action: "fill", target: "qing-jia/qing-jia-dan/申请人", value: "赵六", expected: "已输入" },
        ],
      },
    ];
    const { outcomes } = await runBlackBoxCases(cases, {
      page,
      fetchImpl,
      takeScreenshot: async () => Buffer.from("png"),
      model: { baseUrl: "http://vllm.internal:8000/v1/", name: "qwen2.5-vl", apiKey: "secret" },
    });
    expect(outcomes.every((outcome) => outcome.passed)).toBe(true);
    expect(outcomes[0].locator).toContain("css:[data-testid=\"visual-1\"]");
    expect(outcomes[1].locator).toContain("css:[data-testid=\"visual-1\"]");
    expect(modelCalls).toBe(1);
    expect(page.calls.some((call) => call[0] === "mouse.click")).toBe(false);
  });

  it("fails with a clear reason when the model returns coordinates or cannot see images", async () => {
    const page = fakePage();
    const options = {
      page,
      takeScreenshot: async () => Buffer.from("png"),
      model: { baseUrl: "http://vllm.internal:8000/v1", name: "qwen2.5-vl", apiKey: "secret" },
      fetchImpl: async () => modelResponse("点击坐标 (123, 456)"),
    };
    const step = { index: 1, action: "click", target: "qing-jia/qing-jia-dan/submit", expected: "保存成功" };
    const coordinates = await visualLocate(step.target, step, options);
    expect(coordinates.reason).toContain("坐标");
    expect(coordinates.reason).toContain("禁止坐标点击");

    const blind = await visualLocate(step.target, step, {
      ...options,
      fetchImpl: async () => modelResponse("ERROR: 当前模型不支持输入图片"),
    });
    expect(blind.reason).toContain("不支持输入图片");

    const failed = await visualLocate(step.target, step, {
      ...options,
      fetchImpl: async () => modelResponse("服务不可用", 500),
    });
    expect(failed.reason).toContain("HTTP 500");

    const unconfigured = await visualLocate(step.target, step, { page, model: {} });
    expect(unconfigured.reason).toContain("视觉定位未配置模型");
    expect(page.calls.some((call) => call[0] === "mouse.click")).toBe(false);
  });

  it("reports a clear failure when no browser is available", async () => {
    const cases = [
      {
        code: "c4",
        name: "无浏览器",
        method: "black-box",
        steps: [{ index: 1, action: "open", target: "qing-jia/qing-jia-dan/form", expected: "表单打开" }],
      },
    ];
    const { outcomes } = await runBlackBoxCases(cases, { browserReason: "浏览器依赖未就绪：Chromium 缺失" });
    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].reason).toContain("浏览器依赖未就绪");
  });

  it("writes an HTML report with screenshots into the test area", async () => {
    const page = fakePage({ '[data-testid="qing-jia/qing-jia-dan/submit"]': true });
    const files = {};
    const fs = {
      async mkdir(dir) {
        files[dir] = files[dir] ?? {};
      },
      async writeFile(path, content) {
        files[path] = content;
      },
    };
    const cases = [
      {
        code: "c5",
        name: "报告",
        method: "black-box",
        steps: [{ index: 1, action: "click", target: "qing-jia/qing-jia-dan/submit", expected: "保存成功" }],
      },
    ];
    const { reportDir, outcomes } = await runBlackBoxCases(cases, { page, reportDir: "/tmp/platform-test-report", fs });
    expect(reportDir).toBe("/tmp/platform-test-report");
    expect(files["/tmp/platform-test-report/report.html"]).toContain("黑盒测试报告");
    expect(files["/tmp/platform-test-report/report.html"]).toContain("截图");
    expect(outcomes[0].screenshot).toBe("step-c5-1.png");
    expect(page.calls.some((call) => call[0] === "screenshot" && call[1] === "/tmp/platform-test-report/step-c5-1.png")).toBe(true);
  });

  it("opens a workflow page before advancing a step", async () => {
    const page = fakePage({ '[data-testid="qing-jia/请假流程/submit"]': true });
    const cases = [
      {
        code: "c6",
        name: "流程走查",
        method: "black-box",
        steps: [{ index: 1, action: "advance", target: "qing-jia/请假流程/submit", expected: "迁移成功" }],
      },
    ];
    const { outcomes } = await runBlackBoxCases(cases, { page });
    expect(outcomes[0].passed).toBe(true);
    expect(page.calls.some((call) => call[0] === "goto" && call[1].includes("/p/qing-jia/workflows/"))).toBe(true);
    expect(page.calls.some((call) => call[0] === "click")).toBe(true);
  });

  it("dispatches white-box and black-box cases to their executors", async () => {
    const page = fakePage({ '[data-testid="qing-jia/qing-jia-dan/submit"]': true });
    const result = await runAllCases(
      [
        { code: "w", name: "接口", method: "white-box", steps: [{ index: 1, action: "call", target: "a/b.create", value: "{}", expected: "返回" }] },
        { code: "b", name: "界面", method: "black-box", steps: [{ index: 1, action: "click", target: "qing-jia/qing-jia-dan/submit", expected: "成功" }] },
      ],
      {
        page,
        fetchImpl: async () =>
          new Response(JSON.stringify({ record: { id: "r1" } }), { status: 201, headers: { "content-type": "application/json" } }),
      },
    );
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0].caseCode).toBe("w");
    expect(result.outcomes[0].passed).toBe(true);
    expect(result.outcomes[1].caseCode).toBe("b");
    expect(result.outcomes[1].passed).toBe(true);
  });

  it("tries the whole locator chain before reporting a visual failure", async () => {
    const page = fakePage();
    const context = { lastLocators: {} };
    const locate = await locateElement(
      "qing-jia/qing-jia-dan/submit",
      { action: "click", target: "qing-jia/qing-jia-dan/submit" },
      {
        page,
        context,
        model: { baseUrl: "http://vllm.internal:8000/v1", name: "qwen2.5-vl", apiKey: "secret" },
        takeScreenshot: async () => Buffer.from("png"),
        fetchImpl: async () => modelResponse("ERROR: 无法识别该元素"),
      },
    );
    expect(locate.reason).toContain("已尝试");
    expect(locate.attempts.some((text) => text.startsWith("stable:"))).toBe(true);
    expect(locate.attempts.some((text) => text.startsWith("role:"))).toBe(true);
    expect(locate.attempts.some((text) => text.startsWith("visual:"))).toBe(true);
  });

  it("translates steps into Midscene aiAct prompts and reports failures", async () => {
    expect(midscenePrompt("qing-jia/qing-jia-dan/申请人", { action: "fill", target: "x", value: "张三" })).toContain("张三");
    expect(midscenePrompt("qing-jia/qing-jia-dan/submit", { action: "click" })).toContain("保存");
    expect(midscenePrompt("qing-jia/请假流程/submit", { action: "advance" })).toContain("流程步骤");

    const calls = [];
    const visualLocator = createMidsceneVisualLocator({
      async aiAct(prompt) {
        calls.push(prompt);
      },
    });
    const performed = await visualLocator("qing-jia/qing-jia-dan/submit", { action: "click" });
    expect(performed.performed).toBe(true);
    expect(calls).toHaveLength(1);

    const failed = createMidsceneVisualLocator({
      async aiAct() {
        throw new Error("模型无法理解截图");
      },
    });
    const reason = await failed("qing-jia/qing-jia-dan/submit", { action: "click" });
    expect(reason.reason).toContain("模型无法理解截图");
  });

  it("accepts Midscene-performed steps without coordinate clicks", async () => {
    const page = fakePage();
    const cases = [
      {
        code: "c7",
        name: "Midscene 代执行",
        method: "black-box",
        steps: [
          { index: 1, action: "click", target: "qing-jia/qing-jia-dan/submit", expected: "保存成功" },
          { index: 2, action: "fill", target: "qing-jia/qing-jia-dan/申请人", value: "张三", expected: "已输入" },
        ],
      },
    ];
    const { outcomes } = await runBlackBoxCases(cases, {
      page,
      model: { baseUrl: "http://vllm.internal:8000/v1", name: "qwen2.5-vl", apiKey: "secret" },
      visualLocator: createMidsceneVisualLocator({ async aiAct() {} }),
    });
    expect(outcomes.every((outcome) => outcome.passed)).toBe(true);
    expect(outcomes[0].locator).toBe("midscene:aiAct");
    expect(page.calls.some((call) => call[0] === "mouse.click")).toBe(false);
    expect(page.calls.some((call) => call[0] === "fill" || call[0] === "click")).toBe(false);
  });

  it("bootstraps Playwright and Midscene with model env vars and no secret leaks", async () => {
    const env = {
      PLATFORM_BROWSER_MODULE: "playwright-mock",
      PLATFORM_MIDSCENE_MODULE: "midscene-mock",
      PLATFORM_CHROMIUM_PATH: "/usr/bin/chromium",
    };
    const page = fakePage();
    let closed = false;
    const imported = [];
    const modules = {
      "playwright-mock": {
        chromium: {
          async launch(launch) {
            expect(launch.executablePath).toBe("/usr/bin/chromium");
            expect(launch.headless).toBe(true);
            return {
              async newPage() {
                return page;
              },
              async close() {
                closed = true;
              },
            };
          },
        },
      },
      "midscene-mock": {
        PlaywrightAgent: class {
          constructor(agentPage) {
            expect(agentPage).toBe(page);
          }
          async aiAct() {}
        },
      },
    };
    const browser = await bootstrapBrowser({
      env,
      timeoutSeconds: 12,
      importModule: async (path) => {
        imported.push(path);
        return modules[path];
      },
      model: { baseUrl: "http://vllm.internal:8000/v1/", name: "qwen2.5-vl", apiKey: "secret-key" },
    });
    expect(browser.page).toBe(page);
    expect(browser.visualLocator).toBeTypeOf("function");
    expect(browser.midsceneReason).toBe("");
    expect(env.MIDSCENE_MODEL_BASE_URL).toBe("http://vllm.internal:8000/v1");
    expect(env.MIDSCENE_MODEL_NAME).toBe("qwen2.5-vl");
    expect(env.MIDSCENE_MODEL_API_KEY).toBe("secret-key");
    expect(env.MIDSCENE_MODEL_PROTOCOL).toBe("openai-chat");
    expect(env.MIDSCENE_MODEL_FAMILY).toBe("qwen2.5-vl");
    expect(imported).toEqual(["playwright-mock", "midscene-mock"]);
    const performed = await browser.visualLocator("qing-jia/qing-jia-dan/submit", { action: "click" });
    expect(performed.performed).toBe(true);
    await browser.close();
    expect(closed).toBe(true);
  });

  it("keeps browser working when Midscene cannot load and reports why", async () => {
    const env = { PLATFORM_BROWSER_MODULE: "playwright-mock", PLATFORM_MIDSCENE_MODULE: "missing-midscene" };
    const page = fakePage();
    const modules = {
      "playwright-mock": {
        chromium: {
          async launch() {
            return {
              async newPage() {
                return page;
              },
              async close() {},
            };
          },
        },
      },
    };
    const browser = await bootstrapBrowser({
      env,
      importModule: async (path) => {
        if (!modules[path]) {
          throw new Error("模块不存在：" + path);
        }
        return modules[path];
      },
      model: { baseUrl: "http://vllm.internal:8000/v1", name: "qwen2.5-vl", apiKey: "secret-key" },
    });
    expect(browser.page).toBe(page);
    expect(browser.visualLocator).toBeUndefined();
    expect(browser.midsceneReason).toContain("Midscene 未就绪");
    expect(browser.midsceneReason).not.toContain("secret-key");
  });
});
