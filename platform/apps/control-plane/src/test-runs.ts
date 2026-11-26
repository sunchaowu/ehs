import type { SystemDatabase } from "./database.js";
import { projectDatabaseName } from "./images.js";
import { poolNames } from "./nodes.js";
import { latestImageDigest, rebuildPostgresDatabase } from "./publish.js";
import type { TestExecutor, TestStepOutcome } from "./test-executor.js";
import { listTestCases, type StoredTestCase, type TestCaseStep } from "./test-cases.js";

export type TestRunSummary = {
  id: string;
  imageDigest: string;
  status: string;
  failure: string;
  replayedFrom: string | null;
  replayedFromDigest: string | null;
  startedAt: string;
  finishedAt: string | null;
  failedCases: string[];
};

export type TestStepRecord = {
  id: string;
  caseCode: string;
  caseName: string;
  stepIndex: number;
  method: string;
  imageDigest: string;
  startedAt: string;
  locator: string;
  input: unknown;
  expected: string;
  actual: string;
  passed: boolean;
  reason: string;
};

export type TestOverview = {
  candidateDigest: string | null;
  cases: StoredTestCase[];
  runs: TestRunSummary[];
};

const TIMEOUT_FAILURE = "测试节点未在时限内回报";

/** 节点失联或任务卡住时，按运行时限重试或把测试任务和运行标记为失败。 */
export async function expireStaleTestJobs(database: SystemDatabase): Promise<void> {
  // 还有重试次数的超时任务：按原优先级重新入队，不结束运行。
  await database.query(
    `update test_jobs
     set status = 'pending', claimed_at = null, failure = '',
         log = right(log || '[' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '] 第 ' || attempt || '/' || max_attempts || ' 次执行超时，已按优先级重新入队' || E'\\n', 65536)
     where status = 'running' and claimed_at is not null
       and claimed_at + make_interval(secs => run_timeout_seconds) < now()
       and attempt < max_attempts`,
  );
  // 重试次数用尽：任务与运行标记失败。
  const stale = await database.query<{ run_id: string }>(
    `update test_jobs
     set status = 'done', finished_at = now(), failure = $1,
         log = right(log || '[' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '] 执行超时且重试次数用尽' || E'\\n', 65536)
     where status = 'running' and claimed_at is not null
       and claimed_at + make_interval(secs => run_timeout_seconds) < now()
     returning run_id`,
    [TIMEOUT_FAILURE],
  );
  for (const row of stale.rows) {
    await finishRun(database, row.run_id, "failed", TIMEOUT_FAILURE);
  }
}

export async function readTestOverview(
  database: SystemDatabase,
  projectId: string,
): Promise<TestOverview> {
  await expireStaleTestJobs(database);
  const candidateDigest = await latestImageDigest(database, projectId);
  const cases = await listTestCases(database, projectId);
  const runs = await database.query<{
    id: string;
    image_digest: string;
    status: string;
    failure: string;
    replayed_from: string | null;
    replayed_from_digest: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `select id, image_digest, status, failure, replayed_from, replayed_from_digest, started_at, finished_at
     from test_runs
     where project_id = $1
     order by started_at desc, id desc
     limit 20`,
    [projectId],
  );
  const summaries: TestRunSummary[] = [];
  for (const row of runs.rows) {
    const failed = await database.query<{ case_name: string }>(
      "select distinct case_name from test_step_records where run_id = $1 and not passed order by case_name",
      [row.id],
    );
    summaries.push({
      id: row.id,
      imageDigest: row.image_digest,
      status: row.status,
      failure: row.failure,
      replayedFrom: row.replayed_from,
      replayedFromDigest: row.replayed_from_digest,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      failedCases: failed.rows.map((item) => item.case_name),
    });
  }
  return { candidateDigest, cases, runs: summaries };
}

export async function readTestRunSteps(
  database: SystemDatabase,
  projectId: string,
  runId: string,
): Promise<{ run: TestRunSummary; steps: TestStepRecord[] } | { reason: string; status: number }> {
  const found = await database.query<{
    id: string;
    project_id: string;
    image_digest: string;
    status: string;
    failure: string;
    replayed_from: string | null;
    replayed_from_digest: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `select id, project_id, image_digest, status, failure, replayed_from, replayed_from_digest, started_at, finished_at
     from test_runs where id = $1`,
    [runId],
  );
  const row = found.rows[0];
  if (!row || row.project_id !== projectId) {
    return { reason: "没有这条测试记录", status: 404 };
  }
  const steps = await database.query<{
    id: string;
    case_code: string;
    case_name: string;
    step_index: number;
    method: string;
    image_digest: string;
    started_at: Date;
    locator: string;
    input: unknown;
    expected: string;
    actual: string;
    passed: boolean;
    reason: string;
  }>(
    `select id, case_code, case_name, step_index, method, image_digest, started_at, locator, input, expected, actual, passed, reason
     from test_step_records
     where run_id = $1
     order by case_code, step_index`,
    [runId],
  );
  const failed = await database.query<{ case_name: string }>(
    "select distinct case_name from test_step_records where run_id = $1 and not passed order by case_name",
    [runId],
  );
  return {
    run: {
      id: row.id,
      imageDigest: row.image_digest,
      status: row.status,
      failure: row.failure,
      replayedFrom: row.replayed_from,
      replayedFromDigest: row.replayed_from_digest,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      failedCases: failed.rows.map((item) => item.case_name),
    },
    steps: steps.rows.map((step) => ({
      id: step.id,
      caseCode: step.case_code,
      caseName: step.case_name,
      stepIndex: step.step_index,
      method: step.method,
      imageDigest: step.image_digest,
      startedAt: step.started_at.toISOString(),
      locator: step.locator,
      input: step.input,
      expected: step.expected,
      actual: step.actual,
      passed: step.passed,
      reason: step.reason,
    })),
  };
}

export type TestRunResult =
  | {
      runId: string;
      imageDigest: string;
      status: "passed" | "failed";
      replayedFrom?: string | null;
      replayedFromDigest?: string | null;
      totalSteps: number;
      failedCases: string[];
    }
  | { reason: string; status: number };

export type TestRunPreparation = {
  runId: string;
  digest: string;
  databaseName: string;
  cases: StoredTestCase[];
  stepTimeoutSeconds: number;
  runTimeoutSeconds: number;
  modelBaseUrl: string;
  modelName: string;
  modelApiKey: string;
  replayedFrom: string | null;
  replayedFromDigest: string | null;
};

async function readTestConfig(database: SystemDatabase): Promise<
  | {
      testAdminUrl: string;
      stepTimeoutSeconds: number;
      runTimeoutSeconds: number;
      modelBaseUrl: string;
      modelName: string;
      modelApiKey: string;
    }
  | { reason: string; status: number }
> {
  const config = await database.readConfig();
  if (poolNames(config["test.nodePool"]).length === 0) {
    return { reason: "测试节点池为空", status: 409 };
  }
  if (!config["database.testAdminUrl"]) {
    return { reason: "测试库未配置", status: 409 };
  }
  return {
    testAdminUrl: config["database.testAdminUrl"],
    stepTimeoutSeconds: config["test.stepTimeoutSeconds"],
    runTimeoutSeconds: config["test.runTimeoutSeconds"],
    modelBaseUrl: config["model.baseUrl"],
    modelName: config["model.name"],
    modelApiKey: config["model.apiKey"],
  };
}

/**
 * 创建测试运行并重建测试库，供同步执行器和测试节点任务共用。
 * 调用方负责最终写入步骤并把运行标记为完成或失败。
 */
export async function prepareProjectTestRun(
  database: SystemDatabase,
  project: { id: string; code: string },
): Promise<TestRunPreparation | { reason: string; status: number }> {
  const digest = await latestImageDigest(database, project.id);
  if (!digest) {
    return { reason: "还没有候选镜像", status: 409 };
  }
  const config = await readTestConfig(database);
  if ("reason" in config) {
    return config;
  }
  const databaseName = projectDatabaseName("tst", project.code);
  const rebuilt = await rebuildPostgresDatabase({ adminUrl: config.testAdminUrl, databaseName });
  if ("reason" in rebuilt) {
    return { reason: rebuilt.reason, status: 409 };
  }
  const cases = await listTestCases(database, project.id);
  const runId = await startRun(database, project.id, digest, null, null);
  if (cases.length === 0) {
    await finishRun(database, runId, "failed", "没有测试案例");
    return { reason: "没有测试案例", status: 409 };
  }
  return {
    runId,
    digest,
    databaseName,
    cases,
    stepTimeoutSeconds: config.stepTimeoutSeconds,
    runTimeoutSeconds: config.runTimeoutSeconds,
    modelBaseUrl: config.modelBaseUrl,
    modelName: config.modelName,
    modelApiKey: config.modelApiKey,
    replayedFrom: null,
    replayedFromDigest: null,
  };
}

export async function prepareReplayTestRun(
  database: SystemDatabase,
  project: { id: string; code: string },
  runId: string,
): Promise<TestRunPreparation | { reason: string; status: number }> {
  const digest = await latestImageDigest(database, project.id);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const found = uuidPattern.test(runId)
    ? await database.query<{ id: string; project_id: string; image_digest: string }>(
        "select id, project_id, image_digest from test_runs where id = $1",
        [runId],
      )
    : { rows: [] as Array<{ id: string; project_id: string; image_digest: string }> };
  const original = found.rows[0];
  if (!original || original.project_id !== project.id) {
    return { reason: "没有这条测试记录", status: 404 };
  }
  if (!digest) {
    return { reason: "还没有候选镜像", status: 409 };
  }
  const config = await readTestConfig(database);
  if ("reason" in config) {
    return config;
  }
  const databaseName = projectDatabaseName("tst", project.code);
  const rebuilt = await rebuildPostgresDatabase({ adminUrl: config.testAdminUrl, databaseName });
  if ("reason" in rebuilt) {
    return { reason: rebuilt.reason, status: 409 };
  }
  const steps = await database.query<{
    case_code: string;
    case_name: string;
    step_index: number;
    method: string;
    input: unknown;
    expected: string;
  }>(
    `select case_code, case_name, step_index, method, input, expected
     from test_step_records
     where run_id = $1
     order by case_code, step_index`,
    [runId],
  );
  if (steps.rows.length === 0) {
    return { reason: "这条测试记录没有步骤", status: 409 };
  }
  const grouped = new Map<string, StoredTestCase>();
  for (const row of steps.rows) {
    const existing = grouped.get(row.case_code) ?? {
      id: row.case_code,
      origin: "user" as const,
      method: row.method as "black-box" | "white-box",
      code: row.case_code,
      name: row.case_name,
      steps: [] as TestCaseStep[],
    };
    const recorded = (row.input ?? {}) as { action?: string; target?: string; value?: string | number | boolean };
    const step: TestCaseStep = {
      index: row.step_index,
      action: recorded.action ?? "",
      target: recorded.target ?? "",
      expected: row.expected,
    };
    if (recorded.value !== undefined) {
      step.value = recorded.value;
    }
    existing.steps.push(step);
    grouped.set(row.case_code, existing);
  }
  const cases = [...grouped.values()];
  const newRunId = await startRun(database, project.id, digest, original.id, original.image_digest);
  return {
    runId: newRunId,
    digest,
    databaseName,
    cases,
    stepTimeoutSeconds: config.stepTimeoutSeconds,
    runTimeoutSeconds: config.runTimeoutSeconds,
    modelBaseUrl: config.modelBaseUrl,
    modelName: config.modelName,
    modelApiKey: config.modelApiKey,
    replayedFrom: original.id,
    replayedFromDigest: original.image_digest,
  };
}

export async function runProjectTests(
  database: SystemDatabase,
  project: { id: string; code: string },
  executor: TestExecutor,
): Promise<TestRunResult> {
  const prepared = await prepareProjectTestRun(database, project);
  if ("reason" in prepared) {
    return prepared;
  }
  const result = await executor({
    projectCode: project.code,
    imageDigest: prepared.digest,
    databaseName: prepared.databaseName,
    cases: prepared.cases,
    stepTimeoutSeconds: prepared.stepTimeoutSeconds,
    runTimeoutSeconds: prepared.runTimeoutSeconds,
    modelBaseUrl: prepared.modelBaseUrl,
    modelName: prepared.modelName,
    modelApiKey: prepared.modelApiKey,
  });
  return completeTestRun(database, prepared, result, prepared.replayedFrom, prepared.replayedFromDigest);
}

export async function replayTestRun(
  database: SystemDatabase,
  project: { id: string; code: string },
  runId: string,
  executor: TestExecutor,
): Promise<TestRunResult> {
  const prepared = await prepareReplayTestRun(database, project, runId);
  if ("reason" in prepared) {
    return prepared;
  }
  const result = await executor({
    projectCode: project.code,
    imageDigest: prepared.digest,
    databaseName: prepared.databaseName,
    cases: prepared.cases,
    stepTimeoutSeconds: prepared.stepTimeoutSeconds,
    runTimeoutSeconds: prepared.runTimeoutSeconds,
    modelBaseUrl: prepared.modelBaseUrl,
    modelName: prepared.modelName,
    modelApiKey: prepared.modelApiKey,
  });
  return completeTestRun(database, prepared, result, prepared.replayedFrom, prepared.replayedFromDigest);
}

export async function completeTestRun(
  database: SystemDatabase,
  prepared: Pick<TestRunPreparation, "runId" | "digest" | "cases">,
  result: { steps: TestStepOutcome[] } | { reason: string },
  replayedFrom: string | null,
  replayedFromDigest: string | null,
): Promise<TestRunResult> {
  if ("reason" in result) {
    await finishRun(database, prepared.runId, "failed", result.reason);
    return { reason: result.reason, status: 409 };
  }
  return finishRunWithSteps(
    database,
    prepared.runId,
    prepared.digest,
    result.steps,
    prepared.cases,
    replayedFrom,
    replayedFromDigest,
  );
}

export async function failTestRun(database: SystemDatabase, runId: string, reason: string): Promise<void> {
  await finishRun(database, runId, "failed", reason);
}

async function startRun(
  database: SystemDatabase,
  projectId: string,
  digest: string,
  replayedFrom: string | null,
  replayedFromDigest: string | null,
): Promise<string> {
  const created = await database.query<{ id: string }>(
    `insert into test_runs (id, project_id, image_digest, status, replayed_from, replayed_from_digest, started_at)
     values (gen_random_uuid(), $1, $2, 'running', $3, $4, now())
     returning id`,
    [projectId, digest, replayedFrom, replayedFromDigest],
  );
  return created.rows[0].id;
}

async function finishRun(database: SystemDatabase, runId: string, status: string, failure: string): Promise<void> {
  await database.query(
    "update test_runs set status = $2, failure = $3, finished_at = now() where id = $1",
    [runId, status, failure],
  );
}

async function finishRunWithSteps(
  database: SystemDatabase,
  runId: string,
  digest: string,
  outcomes: TestStepOutcome[],
  cases: StoredTestCase[],
  replayedFrom: string | null,
  replayedFromDigest: string | null,
): Promise<TestRunResult> {
  if (outcomes.length === 0) {
    await finishRun(database, runId, "failed", "测试执行器未返回步骤记录");
    return { reason: "测试执行器未返回步骤记录", status: 409 };
  }
  const caseNames = new Map(cases.map((testCase) => [testCase.code, testCase.name]));
  const caseSteps = new Map(cases.map((testCase) => [testCase.code, new Map(testCase.steps.map((step) => [step.index, step]))]));
  for (const outcome of outcomes) {
    const recorded = (outcome.input ?? {}) as { action?: string; target?: string; value?: string | number | boolean };
    const fallback = caseSteps.get(outcome.caseCode)?.get(outcome.stepIndex);
    const input = {
      action: recorded.action ?? fallback?.action ?? "",
      target: recorded.target ?? fallback?.target ?? "",
      ...(recorded.value !== undefined ? { value: recorded.value } : fallback?.value !== undefined ? { value: fallback.value } : {}),
    };
    await database.query(
      `insert into test_step_records
       (id, run_id, case_code, case_name, step_index, method, image_digest, started_at, locator, input, expected, actual, passed, reason)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now(), $7, $8::jsonb, $9, $10, $11, $12)`,
      [
        runId,
        outcome.caseCode,
        outcome.caseName || caseNames.get(outcome.caseCode) || "",
        outcome.stepIndex,
        outcome.method,
        digest,
        outcome.locator ?? "",
        JSON.stringify(input),
        outcome.expected ?? fallback?.expected ?? "",
        outcome.actual ?? "",
        outcome.passed,
        outcome.reason ?? "",
      ],
    );
  }
  const failed = await database.query<{ case_name: string }>(
    "select distinct case_name from test_step_records where run_id = $1 and not passed order by case_name",
    [runId],
  );
  const failedCases = failed.rows.map((row) => row.case_name);
  const status = failedCases.length === 0 ? "passed" : "failed";
  await finishRun(database, runId, status, "");
  return {
    runId,
    imageDigest: digest,
    status,
    replayedFrom,
    replayedFromDigest,
    totalSteps: outcomes.length,
    failedCases,
  };
}
