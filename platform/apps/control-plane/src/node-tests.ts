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
  return enqueueNodeJob(database, project.code, prepared);
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
  return enqueueNodeJob(database, project.code, prepared);
}

async function enqueueNodeJob(
  database: SystemDatabase,
  projectCode: string,
  prepared: TestRunPreparation,
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
  await database.query(
    `insert into test_jobs
     (id, run_id, node_name, project_code, image_digest, database_name, cases, step_timeout_seconds, run_timeout_seconds, model_base_url, model_name, model_api_key, replayed_from, replayed_from_digest, status, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, 'pending', now())`,
    [
      prepared.runId,
      node,
      projectCode,
      prepared.digest,
      prepared.databaseName,
      JSON.stringify(prepared.cases),
      prepared.stepTimeoutSeconds,
      prepared.runTimeoutSeconds,
      prepared.modelBaseUrl,
      prepared.modelName,
      prepared.modelApiKey,
      prepared.replayedFrom,
      prepared.replayedFromDigest,
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
     set status = 'running', claimed_at = now()
     where id in (
       select id from test_jobs
       where node_name = $1 and status = 'pending'
       order by created_at
       limit $2
       for update skip locked
     )
     returning id, run_id, node_name, project_code, image_digest, database_name, cases,
               step_timeout_seconds, run_timeout_seconds, model_base_url, model_name, model_api_key, status`,
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
  }));
}

export async function acceptTestJobReport(
  database: SystemDatabase,
  nodeName: string,
  authorization: string,
  jobId: string,
  report: { outcomes?: unknown; reason?: unknown },
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
