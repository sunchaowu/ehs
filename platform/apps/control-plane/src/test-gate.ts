import type { SystemDatabase } from "./database.js";

export type TestVerdict = { passed: boolean; failedCases: string[] };

/**
 * 发布门：当前候选镜像最近一次完整运行（passed/failed）的结果。
 * 没有一次全部通过的记录则不通过；没有任何运行时失败案例名单为空。
 */
export async function candidateTestVerdict(
  database: SystemDatabase,
  projectId: string,
  digest: string,
): Promise<TestVerdict> {
  const latest = await database.query<{ id: string; status: string }>(
    `select id, status from test_runs
     where project_id = $1 and image_digest = $2 and status in ('passed', 'failed')
     order by started_at desc, id desc
     limit 1`,
    [projectId, digest],
  );
  const run = latest.rows[0];
  if (!run) {
    return { passed: false, failedCases: [] };
  }
  if (run.status === "passed") {
    return { passed: true, failedCases: [] };
  }
  const failed = await database.query<{ case_name: string }>(
    "select distinct case_name from test_step_records where run_id = $1 and not passed order by case_name",
    [run.id],
  );
  return { passed: false, failedCases: failed.rows.map((row) => row.case_name) };
}
