import { afterEach, describe, expect, it, vi } from "vitest";

// 在线测试会在容器内跑白盒用例，串行全套时单个用例可能超过默认 5 秒。
vi.setConfig({ testTimeout: 30_000 });
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";
import type { TestExecutor } from "../src/test-executor.js";
import { caseCode, generateAutomaticCases, normalizeUserCase } from "../src/test-cases.js";
import type { DesignDocument } from "../src/compiler.js";

const digest = `sha256:${"cd".repeat(32)}`;
const testAdminUrl = process.env.DATABASE_SYSTEM_URL ?? "";

const reservationDesign: DesignDocument = {
  projectCode: "qing-jia-shen-pi",
  containerGroup: "qing-jia-shen-pi",
  menus: [{ code: "qing-jia-dan", name: "请假单", parentCode: null, sort: 1 }],
  grants: [],
  entities: [
    {
      name: "请假单",
      fields: [
        { name: "申请人", type: "user" },
        { name: "天数", type: "number" },
        { name: "开始日期", type: "date" },
        { name: "是否加急", type: "boolean" },
        { name: "假期类型", type: "ref", target: "假期类型" },
      ],
    },
    { name: "假期类型", fields: [{ name: "名称", type: "text" }] },
  ],
  workflows: [{ name: "请假审批", steps: ["submit", "approve", "record"] }],
  extensions: [],
};

describe("automatic test cases", () => {
  it("generates stable cases from a design, including ref dependencies", () => {
    const first = generateAutomaticCases("qing-jia-shen-pi", reservationDesign);
    const second = generateAutomaticCases("qing-jia-shen-pi", reservationDesign);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const create = first.find((testCase) => testCase.name === "新增请假单");
    expect(create?.method).toBe("black-box");
    expect(create?.steps[0]).toMatchObject({ action: "open", target: "qing-jia-shen-pi/请假单/form" });
    const numberField = create?.steps.find((step) => step.target === "qing-jia-shen-pi/请假单/天数");
    expect(numberField?.value).toBe(1);
    const dateField = create?.steps.find((step) => step.target === "qing-jia-shen-pi/请假单/开始日期");
    expect(dateField?.value).toBe("2000-01-01");
    const booleanField = create?.steps.find((step) => step.target === "qing-jia-shen-pi/请假单/是否加急");
    expect(booleanField?.value).toBe(true);
    const userField = create?.steps.find((step) => step.target === "qing-jia-shen-pi/请假单/申请人");
    expect(userField?.value).toBe("测试用户");
    const refField = create?.steps.find((step) => step.target === "qing-jia-shen-pi/请假单/假期类型");
    expect(refField?.value).toBe("ref:假期类型");
    expect(refField?.dependsOn).toBeDefined();
    const dependencySubmit = create?.steps.find((step) => step.target === "qing-jia-shen-pi/假期类型/submit");
    const formSubmit = create?.steps.find((step) => step.target === "qing-jia-shen-pi/请假单/submit");
    expect(Number(refField?.dependsOn)).toBe(dependencySubmit?.index);
    expect(dependencySubmit!.index).toBeLessThan(Number(formSubmit!.index));
    const whiteBox = first.filter((testCase) => testCase.method === "white-box");
    expect(whiteBox.map((testCase) => testCase.name)).toContain("请假单 创建接口返回记录");
    expect(whiteBox.map((testCase) => testCase.name)).toContain("请假单 字段校验拒绝非法输入");
    expect(whiteBox.map((testCase) => testCase.name)).toContain("请假审批 流程迁移");
    const migration = whiteBox.find((testCase) => testCase.name === "请假审批 流程迁移");
    // 白盒执行器只接受 <项目>/workflows/<流程>/<步骤>，自动生成必须匹配该格式。
    expect(migration?.steps[0].target).toMatch(/^qing-jia-shen-pi\/workflows\/请假审批\//);
    expect(whiteBox.map((testCase) => testCase.name)).toContain("请假单 未授权访问被拒绝");
    const codes = new Set(first.map((testCase) => caseCode(testCase.method, testCase.name, testCase.steps)));
    expect(codes.size).toBe(first.length);
  });

  it("rejects invalid user cases and keeps valid ones with stable codes", () => {
    expect(normalizeUserCase({ method: "manual", name: "坏案例", steps: [{ action: "open", target: "x" }] })).toEqual({ reason: "测试方法无效" });
    expect(normalizeUserCase({ method: "white-box", name: "", steps: [{ action: "open", target: "x" }] })).toEqual({ reason: "请输入案例名称" });
    expect(normalizeUserCase({ method: "black-box", name: "无步骤", steps: [] })).toEqual({ reason: "案例至少需要一个步骤" });
    const ok = normalizeUserCase({
      method: "black-box",
      name: "员工不能删除人事菜单",
      steps: [{ action: "click", target: "ren-shi/employees/删除", expected: "拒绝" }],
    });
    expect("reason" in ok).toBe(false);
  });
});

describe("online testing", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function installAdmin() {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const reset = await openDatabase(databaseUrl!);
    await reset.migrate();
    await reset.query("delete from sessions");
    await reset.query("delete from users");
    await reset.query("delete from nodes");
    await reset.close();
    const installed = await installInitialAdmin(databaseUrl!, {
      title: "企业应用平台",
      prodAdminUrl: testAdminUrl,
      testAdminUrl,
      registryAddress: "registry.internal",
    });
    // installInitialAdmin 只填默认值，不覆盖已有配置；串行跑全套时必须显式恢复可达库与空节点池。
    const configured = await openDatabase(databaseUrl!);
    const config = await configured.readConfig();
    await configured.saveConfig({
      ...config,
      "database.testAdminUrl": testAdminUrl,
      "test.nodePool": "",
      "scheduler.defaultNodePool": "",
      "test.requirePassBeforePublish": true,
    });
    await configured.close();
    return installed;
  }

  async function login(server: NonNullable<typeof app>, password: string) {
    const response = await server.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password },
    });
    return response.cookies.find((cookie) => cookie.name === "platform_session")!.value;
  }

  async function createProjectWithDesign(server: NonNullable<typeof app>, cookie: string, name: string) {
    const created = await server.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: cookie },
      payload: { name },
    });
    const code = created.json().project.code as string;
    const menu = await server.inject({
      method: "POST",
      url: `/api/projects/${code}/menus`,
      cookies: { platform_session: cookie },
      payload: { name: "请假单" },
    });
    expect(menu.statusCode).toBe(201);
    const entity = await server.inject({
      method: "POST",
      url: `/api/projects/${code}/tools`,
      cookies: { platform_session: cookie },
      payload: { name: "add_entity", arguments: { name: "请假单", fields: [{ name: "天数", type: "number" }] } },
    });
    expect(entity.statusCode).toBe(201);
    const image = await server.inject({
      method: "POST",
      url: `/api/projects/${code}/confirm`,
      cookies: { platform_session: cookie },
    });
    expect(image.statusCode).toBe(201);
    const built = await server.inject({
      method: "POST",
      url: `/api/projects/${code}/image`,
      cookies: { platform_session: cookie },
    });
    expect(built.statusCode).toBe(201);
    return code;
  }

  async function addTestPool(server: NonNullable<typeof app>, cookie: string) {
    await server.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "test-1", zone: "测试区" },
    });
    await server.inject({
      method: "PUT",
      url: "/api/nodes/test-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "test" },
    });
  }

  async function addProdPool(server: NonNullable<typeof app>, cookie: string) {
    await server.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "prod-1", zone: "正式区" },
    });
    await server.inject({
      method: "PUT",
      url: "/api/nodes/prod-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "prod" },
    });
  }

  const allPassExecutor: TestExecutor = async ({ cases, imageDigest }) => ({
    steps: cases.flatMap((testCase) =>
      testCase.steps.map((step) => ({
        caseCode: testCase.code,
        caseName: testCase.name,
        stepIndex: step.index,
        method: testCase.method,
        locator: "stable-id",
        input: { action: step.action, target: step.target, value: step.value },
        expected: step.expected,
        actual: step.expected,
        passed: true,
      })),
    ),
  });

  it("runs the suite on the candidate, records steps, and opens the publish gate", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL!;
    const installed = await installAdmin();
    let provisions = 0;
    app = await buildServer({
      databaseUrl,
      imageBuilder: async () => ({ digest }),
      databaseProvisioner: async () => {
        provisions += 1;
        return { created: true };
      },
      testExecutor: allPassExecutor,
    });
    const cookie = await login(app, installed.password);
    const code = await createProjectWithDesign(app, cookie, "请假审批");
    const overview = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/tests`,
      cookies: { platform_session: cookie },
    });
    expect(overview.statusCode).toBe(200);
    const overviewBody = overview.json() as { candidateDigest: string | null; cases: Array<{ name: string; method: string }> };
    expect(overviewBody.candidateDigest).toBe(digest);
    expect(overviewBody.cases.map((testCase) => testCase.name)).toContain("新增请假单");
    const blocked = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tests`,
      cookies: { platform_session: cookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ reason: "测试节点池为空" });
    await addTestPool(app, cookie);
    const run = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tests`,
      cookies: { platform_session: cookie },
    });
    expect(run.statusCode).toBe(201);
    const runBody = run.json() as { runId: string; status: string; imageDigest: string; failedCases: string[]; totalSteps: number };
    expect(runBody.status).toBe("passed");
    expect(runBody.imageDigest).toBe(digest);
    expect(runBody.failedCases).toEqual([]);
    expect(runBody.totalSteps).toBeGreaterThan(0);
    const steps = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/tests/runs/${runBody.runId}`,
      cookies: { platform_session: cookie },
    });
    expect(steps.statusCode).toBe(200);
    const stepsBody = steps.json() as { run: { status: string }; steps: Array<{ passed: boolean; locator: string; startedAt: string; method: string }> };
    expect(stepsBody.run.status).toBe("passed");
    expect(stepsBody.steps.every((step) => step.passed)).toBe(true);
    expect(stepsBody.steps[0]?.locator).toBe("stable-id");
    expect(stepsBody.steps[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const replayed = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/runs/${runBody.runId}/replay`,
      cookies: { platform_session: cookie },
    });
    expect(replayed.statusCode).toBe(201);
    const replayBody = replayed.json() as { status: string; replayedFrom: string; replayedFromDigest: string };
    expect(replayBody.status).toBe("passed");
    expect(replayBody.replayedFrom).toBe(runBody.runId);
    expect(replayBody.replayedFromDigest).toBe(digest);
    await addProdPool(app, cookie);
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: cookie },
    });
    expect(publish.statusCode).toBe(202);
    expect(provisions).toBe(1);
  }, 120000);

  it("keeps the publish gate closed and lists failed cases when a case fails", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL!;
    const installed = await installAdmin();
    const failingExecutor: TestExecutor = async ({ cases }) => ({
      steps: cases.flatMap((testCase) =>
        testCase.steps.map((step) => {
          const isCreateCase = testCase.name === "新增请假单";
          return {
            caseCode: testCase.code,
            caseName: testCase.name,
            stepIndex: step.index,
            method: testCase.method,
            locator: "stable-id",
            input: { action: step.action, target: step.target, value: step.value },
            expected: step.expected,
            actual: isCreateCase ? "保存失败" : step.expected,
            passed: !isCreateCase,
            reason: isCreateCase ? "提交后未看到成功提示" : undefined,
          };
        }),
      ),
    });
    app = await buildServer({
      databaseUrl,
      imageBuilder: async () => ({ digest }),
      databaseProvisioner: async () => ({ created: true }),
      testExecutor: failingExecutor,
    });
    const cookie = await login(app, installed.password);
    const code = await createProjectWithDesign(app, cookie, "请假审批");
    await addTestPool(app, cookie);
    const run = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tests`,
      cookies: { platform_session: cookie },
    });
    expect(run.statusCode).toBe(201);
    const runBody = run.json() as { status: string; failedCases: string[] };
    expect(runBody.status).toBe("failed");
    expect(runBody.failedCases).toEqual(["新增请假单"]);
    const release = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/release`,
      cookies: { platform_session: cookie },
    });
    const releaseBody = release.json() as { testResult?: { passed: boolean; failedCases: string[] } };
    expect(releaseBody.testResult?.passed).toBe(false);
    expect(releaseBody.testResult?.failedCases).toEqual(["新增请假单"]);
    await addProdPool(app, cookie);
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/publish`,
      cookies: { platform_session: cookie },
    });
    expect(publish.statusCode).toBe(409);
    expect(publish.json()).toEqual({ reason: "当前候选测试未全部通过", failedCases: ["新增请假单"] });
    const unknown = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/runs/00000000-0000-4000-8000-000000000000/replay`,
      cookies: { platform_session: cookie },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ reason: "没有这条测试记录" });
  }, 120000);

  it("keeps replay metadata through the asynchronous node path", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL!;
    const installed = await installAdmin();
    app = await buildServer({
      databaseUrl,
      imageBuilder: async () => ({ digest }),
      databaseProvisioner: async () => ({ created: true }),
    });
    const cookie = await login(app, installed.password);
    const code = await createProjectWithDesign(app, cookie, "请假审批");
    const registered = await app.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "test-1", zone: "测试区" },
    });
    const token = registered.json().token as string;
    await app.inject({
      method: "PUT",
      url: "/api/nodes/test-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "test" },
    });

    const seed = await openDatabase(databaseUrl);
    const project = await seed.query<{ id: string }>("select id from projects where code = $1", [code]);
    const original = await seed.query<{ id: string }>(
      `insert into test_runs (id, project_id, image_digest, status, started_at)
       values (gen_random_uuid(), $1, $2, 'passed', now()) returning id`,
      [project.rows[0].id, digest],
    );
    await seed.query(
      `insert into test_step_records
       (id, run_id, case_code, case_name, step_index, method, image_digest, started_at, locator, input, expected, actual, passed, reason)
       values (gen_random_uuid(), $1, $2, $3, 1, $4, $5, now(), $6, $7::jsonb, $8, $8, true, '')`,
      [
        original.rows[0].id,
        "case-1",
        "请假单 创建接口返回记录",
        "white-box",
        digest,
        "qing-jia-shen-pi/请假单.create",
        JSON.stringify({ action: "call", target: "qing-jia-shen-pi/请假单.create" }),
        "返回带 id 的记录",
      ],
    );
    await seed.close();

    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/runs/${original.rows[0].id}/replay`,
      cookies: { platform_session: cookie },
    });
    expect(replay.statusCode).toBe(202);
    const runId = replay.json().runId as string;

    const queued = await openDatabase(databaseUrl);
    const jobs = await queued.query<{
      id: string;
      replayed_from: string | null;
      replayed_from_digest: string | null;
      cases: Array<{ code: string; name: string; method: string; steps: Array<{ index: number; target: string; expected?: string }> }>;
    }>("select id, replayed_from, replayed_from_digest, cases from test_jobs where run_id = $1", [runId]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].replayed_from).toBe(original.rows[0].id);
    expect(jobs.rows[0].replayed_from_digest).toBe(digest);
    const job = jobs.rows[0];
    await queued.close();

    const outcomes = job.cases.flatMap((testCase) =>
      testCase.steps.map((step) => ({
        caseCode: testCase.code,
        caseName: testCase.name,
        stepIndex: step.index,
        method: testCase.method,
        locator: step.target,
        input: { action: "call", target: step.target },
        expected: step.expected ?? "",
        actual: "ok",
        passed: true,
        reason: "",
      })),
    );
    const reported = await app.inject({
      method: "POST",
      url: `/api/nodes/test-1/tests/${job.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { outcomes },
    });
    expect(reported.statusCode).toBe(200);

    const verified = await openDatabase(databaseUrl);
    const run = await verified.query<{ replayed_from: string | null; replayed_from_digest: string | null; status: string }>(
      "select replayed_from, replayed_from_digest, status from test_runs where id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      replayed_from: original.rows[0].id,
      replayed_from_digest: digest,
      status: "passed",
    });
    await verified.close();
  }, 120000);

  it("propagates the model config into the node test job payload", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL!;
    const installed = await installAdmin();
    app = await buildServer({
      databaseUrl,
      imageBuilder: async () => ({ digest }),
      databaseProvisioner: async () => ({ created: true }),
    });
    const cookie = await login(app, installed.password);
    const code = await createProjectWithDesign(app, cookie, "模型配置下发");

    const model = {
      "model.baseUrl": "http://vllm.internal:8000/v1",
      "model.name": "qwen2.5-vl",
      "model.apiKey": "secret-key-for-test",
    };
    const configured = await openDatabase(databaseUrl);
    const config = await configured.readConfig();
    await configured.saveConfig({ ...config, ...model });
    await configured.close();

    const registered = await app.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "test-1", zone: "测试区" },
    });
    expect(registered.statusCode).toBe(201);
    const token = registered.json().token as string;
    await app.inject({
      method: "PUT",
      url: "/api/nodes/test-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "test" },
    });

    const dispatched = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/tests`,
      cookies: { platform_session: cookie },
    });
    expect(dispatched.statusCode).toBe(202);

    // 控制面把模型配置随任务落库。
    const queued = await openDatabase(databaseUrl);
    const jobs = await queued.query<{ model_base_url: string; model_name: string; model_api_key: string }>(
      "select model_base_url, model_name, model_api_key from test_jobs",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toEqual({
      model_base_url: model["model.baseUrl"],
      model_name: model["model.name"],
      model_api_key: model["model.apiKey"],
    });
    await queued.close();

    // 节点通过 /desired 原子领取时，任务载荷含模型配置。
    const desired = await app.inject({
      method: "GET",
      url: "/api/nodes/test-1/desired",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(desired.statusCode).toBe(200);
    const tests = desired.json().tests as Array<{ modelBaseUrl: string; modelName: string; modelApiKey: string }>;
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({
      modelBaseUrl: model["model.baseUrl"],
      modelName: model["model.name"],
      modelApiKey: model["model.apiKey"],
    });
  }, 120000);
});
