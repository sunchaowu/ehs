import type { SystemDatabase } from "./database.js";
import { caseCode, normalizeUserCase, type StoredTestCase } from "./test-cases.js";

/**
 * 用户案例管理：草稿记录（kind='test_case'）是用户案例的持久真值，方案确认时由
 * regenerateTestCases 编译进 test_cases。为了让门户编辑后立即出现在测试列表，
 * 这里同步维护两处；代码以 caseCode 稳定生成，重名同内容的案例只保留一条。
 */

/** 列出当前项目的用户案例（来自候选 test_cases，按编码排序）。 */
export async function listUserTestCases(database: SystemDatabase, projectId: string): Promise<StoredTestCase[]> {
  const found = await database.query<{
    id: string;
    method: string;
    code: string;
    name: string;
    steps: StoredTestCase["steps"];
  }>(
    "select id, method, code, name, steps from test_cases where project_id = $1 and origin = 'user' order by code",
    [projectId],
  );
  return found.rows.map((row) => ({
    id: row.id,
    origin: "user",
    method: row.method as StoredTestCase["method"],
    code: row.code,
    name: row.name,
    steps: row.steps,
  }));
}

/**
 * 新增用户案例：校验后同时写入 draft_records 与 test_cases。
 * 同名同内容的案例（相同 code）视为重复，返回 409，避免重复行。
 */
export async function addUserTestCase(
  database: SystemDatabase,
  project: { id: string; code: string },
  body: Record<string, unknown>,
): Promise<{ testCase: StoredTestCase } | { reason: string; status: number }> {
  const normalized = normalizeUserCase(body);
  if ("reason" in normalized) {
    return { reason: normalized.reason, status: 400 };
  }
  const code = caseCode(normalized.method, normalized.name, normalized.steps);
  const existing = await database.query("select 1 from test_cases where project_id = $1 and code = $2", [project.id, code]);
  if (existing.rows.length > 0) {
    return { reason: "案例已存在", status: 409 };
  }
  const args = {
    method: normalized.method,
    name: normalized.name,
    steps: normalized.steps.map((step) => ({
      action: step.action,
      target: step.target,
      ...(step.value !== undefined ? { value: step.value } : {}),
      expected: step.expected,
      ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
    })),
  };
  await database.query("insert into draft_records (id, project_id, kind, body) values (gen_random_uuid(), $1, 'test_case', $2::jsonb)", [
    project.id,
    JSON.stringify(args),
  ]);
  await database.query(
    `insert into test_cases (id, project_id, origin, method, code, name, steps, created_at)
     values (gen_random_uuid(), $1, 'user', $2, $3, $4, $5::jsonb, now())`,
    [project.id, normalized.method, code, normalized.name, JSON.stringify(normalized.steps)],
  );
  return {
    testCase: {
      id: "",
      origin: "user",
      method: normalized.method,
      code,
      name: normalized.name,
      steps: normalized.steps,
    },
  };
}

/**
 * 删除用户案例：同时清理 test_cases 与对应的草稿记录（按规范化后的 name 匹配）。
 * origin='auto' 的自动案例不允许通过此接口删除。
 */
export async function deleteUserTestCase(
  database: SystemDatabase,
  project: { id: string; code: string },
  code: string,
): Promise<{ removed: true } | { reason: string; status: number }> {
  const found = await database.query<{ name: string }>(
    "select name from test_cases where project_id = $1 and code = $2 and origin = 'user'",
    [project.id, code],
  );
  if (found.rows.length === 0) {
    return { reason: "用户案例不存在", status: 404 };
  }
  await database.query("delete from test_cases where project_id = $1 and code = $2 and origin = 'user'", [project.id, code]);
  await database.query("delete from draft_records where project_id = $1 and kind = 'test_case' and body->>'name' = $2", [
    project.id,
    found.rows[0].name,
  ]);
  return { removed: true };
}
