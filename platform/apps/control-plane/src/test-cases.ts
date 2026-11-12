import { createHash } from "node:crypto";
import type { DesignDocument } from "./compiler.js";
import type { SystemDatabase } from "./database.js";

export type TestCaseStep = {
  index: number;
  action: string;
  target: string;
  value?: string | number | boolean;
  expected: string;
  dependsOn?: string;
};

export type TestCaseDefinition = {
  origin: "auto" | "user";
  method: "black-box" | "white-box";
  name: string;
  steps: TestCaseStep[];
};

export type StoredTestCase = TestCaseDefinition & {
  id: string;
  code: string;
};

export function defaultFieldValue(type: string, name: string, target?: string): string | number | boolean {
  switch (type) {
    case "number":
      return 1;
    case "boolean":
      return true;
    case "date":
      return "2000-01-01";
    case "datetime":
      return "2000-01-01T00:00:00";
    case "user":
      return "测试用户";
    case "ref":
      return `ref:${target ?? name}`;
    default:
      return `${name}示例`;
  }
}

export function invalidFieldValue(type: string): string {
  switch (type) {
    case "number":
      return "not-a-number";
    case "date":
    case "datetime":
      return "not-a-date";
    case "boolean":
      return "not-a-boolean";
    default:
      return "非法值";
  }
}

export function caseCode(method: string, name: string, steps: TestCaseStep[]): string {
  const stable = JSON.stringify({ method, name, steps: steps.map((step) => ({ action: step.action, target: step.target, value: step.value, expected: step.expected, dependsOn: step.dependsOn })) });
  return `case-${createHash("sha256").update(stable).digest("hex").slice(0, 16)}`;
}

type CreateBlock = { steps: TestCaseStep[]; recordIndex: number };

function createBlock(
  projectCode: string,
  design: DesignDocument,
  entity: DesignDocument["entities"][number],
  visited: Set<string>,
): CreateBlock {
  const steps: TestCaseStep[] = [];
  steps.push({ index: 1, action: "open", target: `${projectCode}/${entity.name}/form`, expected: "表单打开" });
  let index = 2;
  for (const field of entity.fields) {
    if (field.type === "ref" && field.target) {
      const dependency = design.entities.find((candidate) => candidate.name === field.target);
      if (dependency && !visited.has(dependency.name)) {
        const sub = createBlock(projectCode, design, dependency, new Set([...visited, entity.name]));
        const base = index;
        for (let position = 0; position < sub.steps.length; position += 1) {
          steps.push({ ...sub.steps[position], index: base + position });
        }
        const dependencySubmit = base + sub.recordIndex - 1;
        index = base + sub.steps.length;
        steps.push({
          index: index++,
          action: "fill",
          target: `${projectCode}/${entity.name}/${field.name}`,
          value: `ref:${field.target}`,
          expected: "已输入",
          dependsOn: String(dependencySubmit),
        });
        continue;
      }
    }
    steps.push({
      index: index++,
      action: "fill",
      target: `${projectCode}/${entity.name}/${field.name}`,
      value: defaultFieldValue(field.type, field.name, field.target),
      expected: "已输入",
    });
  }
  const recordIndex = index;
  steps.push({ index: recordIndex, action: "click", target: `${projectCode}/${entity.name}/submit`, expected: "保存成功" });
  return { steps, recordIndex };
}

export function generateAutomaticCases(projectCode: string, design: DesignDocument): TestCaseDefinition[] {
  const cases: TestCaseDefinition[] = [];
  for (const entity of design.entities) {
    const block = createBlock(projectCode, design, entity, new Set([entity.name]));
    cases.push({ origin: "auto", method: "black-box", name: `新增${entity.name}`, steps: block.steps });
  }
  for (const entity of design.entities) {
    const fields = Object.fromEntries(entity.fields.map((field) => [field.name, defaultFieldValue(field.type, field.name, field.target)]));
    cases.push({
      origin: "auto",
      method: "white-box",
      name: `${entity.name} 创建接口返回记录`,
      steps: [{ index: 1, action: "call", target: `${projectCode}/${entity.name}.create`, value: JSON.stringify(fields), expected: "返回带 id 的记录" }],
    });
    const invalidTarget = entity.fields.find((field) => field.type === "number" || field.type === "date" || field.type === "datetime") ?? entity.fields[0];
    cases.push({
      origin: "auto",
      method: "white-box",
      name: `${entity.name} 字段校验拒绝非法输入`,
      steps: [
        {
          index: 1,
          action: "validate",
          target: invalidTarget ? `${projectCode}/${entity.name}/${invalidTarget.name}` : `${projectCode}/${entity.name}`,
          value: invalidTarget ? invalidFieldValue(invalidTarget.type) : "非法值",
          expected: "拒绝并说明字段",
        },
      ],
    });
  }
  for (const workflow of design.workflows) {
    cases.push({
      origin: "auto",
      method: "white-box",
      name: `${workflow.name} 流程迁移`,
      steps: workflow.steps.map((step, position) => ({
        index: position + 1,
        action: "migrate",
        target: `${projectCode}/${workflow.name}/${step}`,
        expected: "迁移成功",
      })),
    });
    cases.push({
      origin: "auto",
      method: "black-box",
      name: `${workflow.name} 流程走查`,
      steps: workflow.steps.map((step, position) => ({
        index: position + 1,
        action: "advance",
        target: `${projectCode}/${workflow.name}/${step}`,
        expected: "迁移成功",
      })),
    });
  }
  for (const menu of design.menus) {
    cases.push({
      origin: "auto",
      method: "white-box",
      name: `${menu.name} 未授权访问被拒绝`,
      steps: [{ index: 1, action: "call", target: `${projectCode}/${menu.code}`, value: "未授权用户", expected: "拒绝" }],
    });
  }
  return cases;
}

const userMethods = new Set(["black-box", "white-box"]);

export function normalizeUserCase(body: Record<string, unknown>): TestCaseDefinition | { reason: string } {
  const method = typeof body.method === "string" ? body.method : "";
  if (!userMethods.has(method)) {
    return { reason: "测试方法无效" };
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return { reason: "请输入案例名称" };
  }
  const rawSteps = Array.isArray(body.steps) ? body.steps : [];
  if (rawSteps.length === 0) {
    return { reason: "案例至少需要一个步骤" };
  }
  const steps: TestCaseStep[] = [];
  for (let position = 0; position < rawSteps.length; position += 1) {
    const raw = rawSteps[position] as Record<string, unknown>;
    const action = typeof raw?.action === "string" ? raw.action : "";
    const target = typeof raw?.target === "string" ? raw.target : "";
    if (!action || !target) {
      return { reason: `第 ${position + 1} 步缺少 action 或 target` };
    }
    const step: TestCaseStep = {
      index: position + 1,
      action,
      target,
      expected: typeof raw?.expected === "string" ? raw.expected : "",
    };
    if (typeof raw?.value === "string" || typeof raw?.value === "number" || typeof raw?.value === "boolean") {
      step.value = raw.value;
    }
    if (typeof raw?.dependsOn === "string" && raw.dependsOn) {
      step.dependsOn = raw.dependsOn;
    }
    steps.push(step);
  }
  return { origin: "user", method: method as "black-box" | "white-box", name, steps };
}

export async function regenerateTestCases(
  database: SystemDatabase,
  project: { id: string; code: string },
  design: DesignDocument,
): Promise<{ stored: number }> {
  const userRecords = await database.query<{ body: Record<string, unknown> }>(
    "select body from draft_records where project_id = $1 and kind = 'test_case'",
    [project.id],
  );
  const userCases: TestCaseDefinition[] = [];
  for (const record of userRecords.rows) {
    const normalized = normalizeUserCase(record.body);
    if ("reason" in normalized) {
      continue;
    }
    userCases.push(normalized);
  }
  const generated = [...generateAutomaticCases(project.code, design), ...userCases];
  const seen = new Set<string>();
  await database.query("delete from test_cases where project_id = $1", [project.id]);
  let stored = 0;
  for (const definition of generated) {
    const code = caseCode(definition.method, definition.name, definition.steps);
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    await database.query(
      `insert into test_cases (id, project_id, origin, method, code, name, steps, created_at)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, now())`,
      [project.id, definition.origin, definition.method, code, definition.name, JSON.stringify(definition.steps)],
    );
    stored += 1;
  }
  return { stored };
}

export async function listTestCases(database: SystemDatabase, projectId: string): Promise<StoredTestCase[]> {
  const found = await database.query<{ id: string; origin: string; method: string; code: string; name: string; steps: TestCaseStep[] }>(
    "select id, origin, method, code, name, steps from test_cases where project_id = $1 order by origin, code",
    [projectId],
  );
  return found.rows.map((row) => ({
    id: row.id,
    origin: row.origin as "auto" | "user",
    method: row.method as "black-box" | "white-box",
    code: row.code,
    name: row.name,
    steps: row.steps,
  }));
}
