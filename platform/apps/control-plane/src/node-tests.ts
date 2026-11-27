import type { SystemDatabase } from "./database.js";
import { authenticateNode, poolNames } from "./nodes.js";
import type { StoredTestCase } from "./test-cases.js";
import type { TestStepOutcome } from "./test-executor.js";
import {
  completeTestRun,
  expireStaleTestJobs,
  failTestRun,
  prepareProjectTestRun,
  prepareReplayTestRun,
  type TestRunPreparation,
} from "./test-runs.js";

export type NodeTestJob = {
  id: string;
  runId: string;
  projectCode: string;
  imageDigest: string;
  databaseName: string;
  cases: StoredTestCase[];
  stepTimeoutSeconds: number;
  runTimeoutSeconds: number;
  modelBaseUrl: string;
  modelName: string;
  modelApiKey: string;
  attempt: number;
};

type StoredJobRow = {
  id: string;
  run_id: string;
  node_name: string;
  project_code: string;
  image_digest: string;
  database_name: string;
  cases: NodeTestJob["cases"];
  step_timeout_seconds: number;
  run_timeout_seconds: number;
  model_base_url: string;
  model_name: string;
  model_api_key: string;
  status: string;
  attempt: number;
  max_attempts: number;
  priority: number;
  log: string;
  replayed_from: string | null;
  replayed_from_digest: string | null;
};

export type NodeTestDispatch =
  | { runId: string; status: "running"; node: string }
  | { reason: string; status: number };

export async function dispatchProjectTestRun(
  database: SystemDatabase,
  project: { id: string; code: string },
): Promise<NodeTestDispatch> {
  const prepared = await prepareProjectTestRun(database, project);
  if ("reason" in prepared) {
    return prepared;
  }
  return enqueueNodeJob(database, project.code, prepared, 0);
}

export async function dispatchReplayTestRun(
  database: SystemDatabase,
  project: { id: string; code: string },
  runId: string,
): Promise<NodeTestDispatch> {
  const prepared = await prepareReplayTestRun(database, project, runId);
  if ("reason" in prepared) {
    return prepared;
  }
  // 回放是人工触发的针对性重跑，排在新跑的全量任务之前。
  return enqueueNodeJob(database, project.code, prepared, 10);
}

async function enqueueNodeJob(
  database: SystemDatabase,
  projectCode: string,
  prepared: TestRunPreparation,
  priority: number,
): Promise<NodeTestDispatch> {
  const config = await database.readConfig();
  const names = poolNames(config["test.nodePool"]);
  const chosen = names.length
    ? await database.query<{ name: string }>(
        `select nodes.name
         from nodes
         where nodes.name = any($1::text[])
         order by (select count(*) from test_jobs where test_jobs.node_name = nodes.name and test_jobs.status = 'running') asc,
                  nodes.name
         limit 1`,
        [names],
      )
    : { rows: [] as Array<{ name: string }> };
  const node = chosen.rows[0]?.name;
  if (!node) {
    await failTestRun(database, prepared.runId, "测试节点池没有已注册节点");
    return { reason: "测试节点池没有已注册节点", status: 409 };
  }
  // 重试次数在入队时快照，之后改配置不影响已排队的任务。
  const maxAttempts = Math.max(1, Math.floor(Number(config["test.maxAttempts"] ?? 2)));
  await database.query(
    `insert into test_jobs
     (id, run_id, node_name, project_code, image_digest, database_name, cases, step_timeout_seconds, run_timeout_seconds, replayed_from, replayed_from_digest, model_base_url, model_name, model_api_key, priority, max_attempts, status, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', now())`,
    [
      prepared.runId,
      node,
      projectCode,
      prepared.digest,
      prepared.databaseName,
      JSON.stringify(prepared.cases),
      prepared.stepTimeoutSeconds,
      prepared.runTimeoutSeconds,
      prepared.replayedFrom,
      prepared.replayedFromDigest,
      prepared.modelBaseUrl,
      prepared.modelName,
      prepared.modelApiKey,
      priority,
      maxAttempts,
    ],
  );
  return { runId: prepared.runId, status: "running", node };
}

/**
 * 节点读取期望状态时顺带领取待执行测试。单条 SQL 原子地把 pending 改成 running，
 * 避免两个代理同时执行同一任务。
 */
export async function claimTestJobs(database: SystemDatabase, nodeName: string, limit = 2): Promise<NodeTestJob[]> {
  await expireStaleTestJobs(database);
  const claimed = await database.query<StoredJobRow>(
    `update test_jobs
     set status = 'running', claimed_at = now(), attempt = attempt + 1
     where id in (
       select id from test_jobs
       where node_name = $1 and status = 'pending'
       order by priority desc, created_at, id
       limit $2
       for update skip locked
     )
     returning id, run_id, node_name, project_code, image_digest, database_name, cases,
               step_timeout_seconds, run_timeout_seconds, status, model_base_url, model_name, model_api_key, attempt`,
    [nodeName, limit],
  );
  return claimed.rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    projectCode: row.project_code,
    imageDigest: row.image_digest,
    databaseName: row.database_name,
    cases: row.cases,
    stepTimeoutSeconds: row.step_timeout_seconds,
    runTimeoutSeconds: row.run_timeout_seconds,
    modelBaseUrl: row.model_base_url,
    modelName: row.model_name,
    modelApiKey: row.model_api_key,
    attempt: row.attempt,
  }));
}

/** 单次日志片段与整条任务日志的上限，防止失控输出撑爆系统库。 */
const JOB_LOG_CHUNK_LIMIT = 16_384;
const JOB_LOG_TOTAL_LIMIT = 65_536;

async function appendJobLog(database: SystemDatabase, jobId: string, chunk: string): Promise<void> {
  if (!chunk) {
    return;
  }
  await database.query(
    `update test_jobs set log = right(log || $2, ${JOB_LOG_TOTAL_LIMIT}) where id = $1`,
    [jobId, chunk.slice(0, JOB_LOG_CHUNK_LIMIT)],
  );
}

export type NodeTestJobView = {
  id: string;
  nodeName: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  priority: number;
  failure: string;
  log: string;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
};

/** 门户排障视图：一次运行对应的节点任务、领取次数与实时日志。 */
export async function listRunJobs(
  database: SystemDatabase,
  projectId: string,
  runId: string,
): Promise<{ jobs: NodeTestJobView[] } | { reason: string; status: number }> {
  const run = await database.query<{ project_id: string }>("select project_id from test_runs where id = $1", [runId]);
  if (!run.rows[0] || run.rows[0].project_id !== projectId) {
    return { reason: "没有这条测试记录", status: 404 };
  }
  const jobs = await database.query<{
    id: string;
    node_name: string;
    status: string;
    attempt: number;
    max_attempts: number;
    priority: number;
    failure: string;
    log: string;
    created_at: Date;
    claimed_at: Date | null;
    finished_at: Date | null;
  }>(
    `select id, node_name, status, attempt, max_attempts, priority, failure, log, created_at, claimed_at, finished_at
     from test_jobs where run_id = $1 order by created_at`,
    [runId],
  );
  return {
    jobs: jobs.rows.map((row) => ({
      id: row.id,
      nodeName: row.node_name,
      status: row.status,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      priority: row.priority,
      failure: row.failure,
      log: row.log,
      createdAt: row.created_at.toISOString(),
      claimedAt: row.claimed_at ? row.claimed_at.toISOString() : null,
      finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    })),
  };
}

export async function acceptTestJobReport(
  database: SystemDatabase,
  nodeName: string,
  authorization: string,
  jobId: string,
  report: { outcomes?: unknown; reason?: unknown; log?: unknown },
): Promise<{ accepted: true } | { reason: string; status: number }> {
  const node = await authenticateNode(database, nodeName, authorization);
  if (!node) {
    return { reason: "节点凭证无效", status: 401 };
  }
  const found = await database.query<StoredJobRow>("select * from test_jobs where id = $1", [jobId]);
  const job = found.rows[0];
  if (!job || job.node_name !== nodeName) {
    return { reason: "测试任务不存在", status: 404 };
  }
  if (job.status === "done") {
    return { reason: "测试任务已结束", status: 409 };
  }
  const failure = typeof report.reason === "string" ? report.reason.trim() : "";
  const outcomes = normalizeOutcomes(report.outcomes);
  const logChunk = typeof report.log === "string" ? report.log : "";
  // 只带日志的回报是执行中的实时片段：追加日志、不改任务状态。
  if (!failure && !outcomes && logChunk) {
    await appendJobLog(database, job.id, logChunk);
    return { accepted: true };
  }
  // 任务被重新入队后，上一次尝试的迟到终态回报不再生效。
  if (job.status !== "running") {
    return { reason: "测试任务尚未被领取", status: 409 };
  }
  await appendJobLog(database, job.id, logChunk);
  // 基础设施失败（镜像、容器、执行入口、stderr 等）自动重试；断言失败是测试结论，不重试。
  if (failure && job.attempt < job.max_attempts) {
    await database.query(
      `update test_jobs set status = 'pending', claimed_at = null, failure = '', log = right(log || $2, ${JOB_LOG_TOTAL_LIMIT}) where id = $1`,
      [
        job.id,
        `[${new Date().toISOString()}] 第 ${job.attempt}/${job.max_attempts} 次执行失败，已按优先级重新入队：${failure}\n`,
      ],
    );
    return { accepted: true };
  }
  await database.query("update test_jobs set status = 'done', finished_at = now(), failure = $2 where id = $1", [
    job.id,
    failure,
  ]);
  const prepared = { runId: job.run_id, digest: job.image_digest, cases: job.cases };
  if (failure) {
    await failTestRun(database, job.run_id, failure);
    return { accepted: true };
  }
  if (!outcomes) {
    await failTestRun(database, job.run_id, "节点回报的测试步骤格式无效");
    return { reason: "节点回报的测试步骤格式无效", status: 400 };
  }
  await completeTestRun(
    database,
    prepared,
    { steps: outcomes },
    job.replayed_from,
    job.replayed_from_digest,
  );
  return { accepted: true };
}

function normalizeOutcomes(value: unknown): TestStepOutcome[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const outcomes: TestStepOutcome[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.caseCode !== "string" || typeof item.stepIndex !== "number" || typeof item.passed !== "boolean") {
      return null;
    }
    outcomes.push({
      caseCode: item.caseCode,
      caseName: typeof item.caseName === "string" ? item.caseName : "",
      stepIndex: item.stepIndex,
      method: typeof item.method === "string" ? item.method : "",
      locator: typeof item.locator === "string" ? item.locator : "",
      input: item.input,
      expected: typeof item.expected === "string" ? item.expected : "",
      actual: typeof item.actual === "string" ? item.actual : "",
      passed: item.passed,
      reason: typeof item.reason === "string" ? item.reason : "",
    });
  }
  return outcomes;
}
