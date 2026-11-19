import type { PublicUser } from "./accounts.js";
import type { SystemDatabase } from "./database.js";
import { latestCompiledSource, storeCompiledDesign } from "./designs.js";
import { oaTemplate, type OaTemplate } from "./oa-template.js";
import { isProjectCode, suggestProjectCode } from "./project-code.js";
import { buildProjectImage, latestImageDigest, publishProject, type DatabaseProvisioner, type ImageBuilder } from "./publish.js";
import { cancelDesiredPublication, readProjectRelease } from "./releases.js";
import { type TestExecutor } from "./test-executor.js";
import { dispatchProjectTestRun, dispatchReplayTestRun } from "./node-tests.js";
import { normalizeUserCase } from "./test-cases.js";
import { replayTestRun, runProjectTests, type TestRunResult } from "./test-runs.js";

const allowedActions = ["访问", "新增", "修改", "删除"];
const fieldTypes = ["text", "longText", "number", "boolean", "date", "datetime", "user", "ref"];
const workflowSteps = ["submit", "approve", "record"];

type ManagedProject = { id: string };

export async function addMenu(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  request: { name?: string; parent?: string },
): Promise<{ menu: { code: string; name: string; parent: string | null } } | { reason: string; status: number }> {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  const name = request.name?.trim() ?? "";
  if (!name) {
    return { reason: "请输入菜单名称", status: 400 };
  }
  const suggested = suggestProjectCode(name);
  if ("reason" in suggested) {
    return { reason: "无法生成菜单编码", status: 400 };
  }
  const code = await unusedMenuCode(database, project.id, suggested.code);
  const parent = request.parent?.trim() || null;
  if (parent) {
    const found = await database.query("select 1 from draft_menus where project_id = $1 and code = $2", [project.id, parent]);
    if (found.rows.length === 0) {
      return { reason: "上级菜单不存在", status: 404 };
    }
  }
  const sort = await database.query<{ next: number }>(
    `select coalesce(max(sort), 0) + 1 as next from draft_menus
     where project_id = $1 and parent_code is not distinct from $2`,
    [project.id, parent],
  );
  await database.query(
    `insert into draft_menus (id, project_id, code, name, parent_code, sort)
     values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [project.id, code, name, parent, sort.rows[0].next],
  );
  return { menu: { code, name, parent } };
}

export async function grantAccess(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  request: { principalType?: string; principalName?: string; menu?: string; actions?: string[] },
): Promise<{ granted: true } | { reason: string; status: number }> {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  if (request.principalType !== "user" && request.principalType !== "role") {
    return { reason: "授权对象无效", status: 400 };
  }
  const principalName = request.principalName?.trim() ?? "";
  const menu = request.menu?.trim() ?? "";
  if (!principalName || !menu) {
    return { reason: "请输入授权对象和菜单", status: 400 };
  }
  const actions = request.actions ?? [];
  if (actions.length === 0 || actions.some((action) => !allowedActions.includes(action))) {
    return { reason: "操作无效", status: 400 };
  }
  const menuFound = await database.query("select 1 from draft_menus where project_id = $1 and code = $2", [project.id, menu]);
  if (menuFound.rows.length === 0) {
    return { reason: "菜单不存在", status: 404 };
  }
  if (request.principalType === "role") {
    await database.query(
      `insert into project_roles (project_id, name) values ($1, $2) on conflict do nothing`,
      [project.id, principalName],
    );
  }
  for (const action of actions) {
    await database.query(
      `insert into draft_grants (project_id, principal_type, principal_name, menu_code, action)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [project.id, request.principalType, principalName, menu, action],
    );
  }
  return { granted: true };
}

export async function assignRole(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  request: { role?: string; username?: string },
): Promise<{ assigned: true } | { reason: string; status: number }> {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  const role = request.role?.trim() ?? "";
  const username = request.username?.trim() ?? "";
  const roleFound = await database.query("select 1 from project_roles where project_id = $1 and name = $2", [project.id, role]);
  if (roleFound.rows.length === 0) {
    return { reason: "角色不存在", status: 404 };
  }
  const userFound = await database.query("select 1 from users where username = $1", [username]);
  if (userFound.rows.length === 0) {
    return { reason: "用户不存在", status: 404 };
  }
  await database.query(
    `insert into project_role_members (project_id, role_name, username) values ($1, $2, $3) on conflict do nothing`,
    [project.id, role, username],
  );
  return { assigned: true };
}

export async function effectiveActions(
  database: SystemDatabase,
  projectCode: string,
  username: string,
  menuCode: string,
): Promise<string[]> {
  const found = await database.query<{ action: string }>(
    `select distinct draft_grants.action
     from draft_grants
     join projects on projects.id = draft_grants.project_id
     where projects.code = $1 and draft_grants.menu_code = $2
       and (
         (draft_grants.principal_type = 'user' and draft_grants.principal_name = $3)
         or (
           draft_grants.principal_type = 'role'
           and exists (
             select 1 from project_role_members
             where project_role_members.project_id = projects.id
               and project_role_members.role_name = draft_grants.principal_name
               and project_role_members.username = $3
           )
         )
       )`,
    [projectCode, menuCode, username],
  );
  return allowedActions.filter((action) => found.rows.some((row) => row.action === action));
}

export type ApplyTemplateResult = {
  applied: true;
  template: string;
  menus: number;
  entities: number;
  workflows: number;
  grants: number;
  cases: number;
};

export async function applyOaTemplate(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  template: OaTemplate = oaTemplate(projectCode),
): Promise<ApplyTemplateResult | { reason: string; status: number }> {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  // 菜单：同名复用已有编码，避免重复应用时堆叠「组织-2」
  const menuCodes = new Map<string, string>();
  let sort = await database.query<{ next: number }>(
    "select coalesce(max(sort), 0) + 1 as next from draft_menus where project_id = $1",
    [project.id],
  );
  let nextSort = sort.rows[0].next;
  for (const menu of template.menus) {
    const existing = await database.query<{ code: string }>(
      "select code from draft_menus where project_id = $1 and name = $2",
      [project.id, menu.name],
    );
    if (existing.rows[0]) {
      menuCodes.set(menu.key, existing.rows[0].code);
      continue;
    }
    const suggested = suggestProjectCode(menu.name);
    if ("reason" in suggested) {
      return { reason: `无法生成菜单编码：${menu.name}`, status: 400 };
    }
    const code = await unusedMenuCode(database, project.id, suggested.code);
    const parent = menu.parent ? menuCodes.get(template.menus.find((item) => item.name === menu.parent)?.key ?? "") ?? null : null;
    await database.query(
      `insert into draft_menus (id, project_id, code, name, parent_code, sort)
       values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [project.id, code, menu.name, parent, nextSort],
    );
    menuCodes.set(menu.key, code);
    nextSort += 1;
  }
  // 数据与流程：同名跳过，不覆盖已有草稿
  let entityCount = 0;
  for (const entity of template.entities) {
    const found = await database.query(
      "select 1 from draft_records where project_id = $1 and kind = 'entity' and body->>'name' = $2",
      [project.id, entity.name],
    );
    if (found.rows.length > 0) {
      continue;
    }
    await database.query(
      "insert into draft_records (id, project_id, kind, body) values (gen_random_uuid(), $1, 'entity', $2::jsonb)",
      [project.id, JSON.stringify({ name: entity.name, fields: entity.fields })],
    );
    entityCount += 1;
  }
  let workflowCount = 0;
  const foundWorkflow = await database.query(
    "select 1 from draft_records where project_id = $1 and kind = 'workflow' and body->>'name' = $2",
    [project.id, template.workflow.name],
  );
  if (foundWorkflow.rows.length === 0) {
    await database.query(
      "insert into draft_records (id, project_id, kind, body) values (gen_random_uuid(), $1, 'workflow', $2::jsonb)",
      [project.id, JSON.stringify(template.workflow)],
    );
    workflowCount = 1;
  }
  // 角色与授权
  let grantCount = 0;
  for (const grant of template.grants) {
    const menuCode = menuCodes.get(template.menus.find((item) => item.name === grant.menu)?.key ?? "");
    if (!menuCode) {
      return { reason: `模板菜单缺失：${grant.menu}`, status: 500 };
    }
    await database.query(
      "insert into project_roles (project_id, name) values ($1, $2) on conflict do nothing",
      [project.id, grant.role],
    );
    for (const action of grant.actions) {
      const inserted = await database.query<{ id: string }>(
        `insert into draft_grants (project_id, principal_type, principal_name, menu_code, action)
         values ($1, 'role', $2, $3, $4) on conflict do nothing returning id`,
        [project.id, grant.role, menuCode, action],
      );
      if (inserted.rows[0]) {
        grantCount += 1;
      }
    }
  }
  // 用户测试案例：同名跳过
  let caseCount = 0;
  for (const testCase of template.cases) {
    const found = await database.query(
      "select 1 from draft_records where project_id = $1 and kind = 'test_case' and body->>'name' = $2",
      [project.id, testCase.name],
    );
    if (found.rows.length > 0) {
      continue;
    }
    await database.query(
      "insert into draft_records (id, project_id, kind, body) values (gen_random_uuid(), $1, 'test_case', $2::jsonb)",
      [project.id, JSON.stringify({ method: testCase.method, name: testCase.name, steps: testCase.steps })],
    );
    caseCount += 1;
  }
  return {
    applied: true,
    template: template.name,
    menus: menuCodes.size,
    entities: entityCount,
    workflows: workflowCount,
    grants: grantCount,
    cases: caseCount,
  };
}

export async function confirmSolution(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
): Promise<{ change: { added: unknown; modified: unknown[]; removed: unknown[] }; sourceRevision: string } | { reason: string; status: number }> {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  const menus = await database.query("select code, name, parent_code from draft_menus where project_id = $1 order by sort", [project.id]);
  const grants = await database.query(
    "select principal_type, principal_name, menu_code, action from draft_grants where project_id = $1",
    [project.id],
  );
  const added = { menus: menus.rows, grants: grants.rows };
  await database.query(
    `insert into openspec_changes (id, project_id, added, modified, removed, confirmed_at)
     values (gen_random_uuid(), $1, $2::jsonb, '[]'::jsonb, '[]'::jsonb, now())`,
    [project.id, JSON.stringify(added)],
  );
  const compiled = await storeCompiledDesign(database, project.id);
  return { change: { added, modified: [], removed: [] }, sourceRevision: compiled.sourceRevision };
}

export async function readProjectSource(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
): Promise<{ sourceRevision: string; files: Record<string, string> } | { reason: string; status: number }> {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  return latestCompiledSource(database, project.id);
}

export async function createProjectImage(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  builder: ImageBuilder,
): Promise<{ digest: string } | { reason: string; status: number }> {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  return buildProjectImage(database, { id: project.id, code: projectCode }, builder);
}

export async function confirmPublication(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  provisioner: DatabaseProvisioner,
) {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  return publishProject(database, { id: project.id, code: projectCode }, provisioner);
}

export async function readReleaseStatus(database: SystemDatabase, actor: PublicUser, projectCode: string) {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  return readProjectRelease(database, projectCode);
}

export async function cancelPublication(database: SystemDatabase, actor: PublicUser, projectCode: string) {
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  return cancelDesiredPublication(database, projectCode);
}

export async function publishedMenus(database: SystemDatabase, actor: PublicUser): Promise<{ code: string; name: string }[]> {
  const found = await database.query<{ code: string; name: string }>(
    `select distinct published_menus.code, published_menus.name
     from published_menus
     join project_members on project_members.project_id = published_menus.project_id
     join users on users.id = project_members.user_id
     where users.username = $1
       and exists (
         select 1 from published_grants
         where published_grants.project_id = published_menus.project_id
           and published_grants.menu_code = published_menus.code
           and published_grants.action = '访问'
           and (
             (published_grants.principal_type = 'user' and published_grants.principal_name = users.username)
             or (
               published_grants.principal_type = 'role'
               and exists (
                 select 1 from project_role_members
                 where project_role_members.project_id = published_menus.project_id
                   and project_role_members.role_name = published_grants.principal_name
                   and project_role_members.username = users.username
               )
             )
           )
       )
     order by published_menus.code`,
    [actor.username],
  );
  return found.rows;
}

export async function readDraft(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
): Promise<{ menus: { code: string; name: string }[] } | { reason: string; status: number }> {
  const project = await memberProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  const menus = await database.query<{ code: string; name: string }>(
    "select code, name from draft_menus where project_id = $1 order by sort",
    [project.id],
  );
  return { menus: menus.rows };
}

export async function postRequirementMessage(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  body: string,
): Promise<{ stored: true } | { reason: string; status: number }> {
  const config = await database.readConfig();
  if (!config["model.baseUrl"] || !config["model.name"] || !config["model.apiKey"]) {
    return { reason: "会话和运维智能体不会调用模型", status: 403 };
  }
  const project = await memberProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  const text = body.trim();
  if (!text) {
    return { reason: "请输入内容", status: 400 };
  }
  const sessionId = await ownSession(database, project.id, actor.username);
  await database.query(
    `insert into requirement_messages (id, session_id, user_id, body, created_at)
     values (gen_random_uuid(), $1, (select id from users where username = $2), $3, now())`,
    [sessionId, actor.username, text],
  );
  return { stored: true };
}

export async function listRequirementMessages(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
): Promise<{ messages: { body: string }[] } | { reason: string; status: number }> {
  const project = await memberProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  const found = await database.query<{ body: string }>(
    `select requirement_messages.body
     from requirement_messages
     join requirement_sessions on requirement_sessions.id = requirement_messages.session_id
     join users on users.id = requirement_sessions.user_id
     where requirement_sessions.project_id = $1 and users.username = $2
     order by requirement_messages.created_at`,
    [project.id, actor.username],
  );
  return { messages: found.rows };
}

export async function applyTool(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  call: { name?: string; arguments?: Record<string, unknown> },
  executor?: TestExecutor,
): Promise<{ recorded: true } | { reason: string; status: number } | TestRunResult | { runId: string; status: string; node: string }> {
  const name = call.name ?? "";
  const args = call.arguments ?? {};
  if (name === "run_tests") {
    const project = await managedProject(database, actor, projectCode);
    if ("reason" in project) {
      return project;
    }
    const digest = await latestImageDigest(database, project.id);
    if (!digest) {
      return { reason: "还没有候选镜像", status: 409 };
    }
    const config = await database.readConfig();
    if (!config["test.nodePool"].trim()) {
      return { reason: "测试节点池为空", status: 409 };
    }
    if (!executor) {
      return dispatchProjectTestRun(database, { id: project.id, code: projectCode });
    }
    return runProjectTests(database, { id: project.id, code: projectCode }, executor);
  }
  if (name === "replay_test") {
    const project = await managedProject(database, actor, projectCode);
    if ("reason" in project) {
      return project;
    }
    const recordId = stringArg(args.record);
    if (!recordId) {
      return { reason: "缺少测试记录", status: 400 };
    }
    if (!executor) {
      return dispatchReplayTestRun(database, { id: project.id, code: projectCode }, recordId);
    }
    return replayTestRun(database, { id: project.id, code: projectCode }, recordId, executor);
  }
  const project = await managedProject(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  if (name === "add_menu") {
    const result = await addMenu(database, actor, projectCode, { name: stringArg(args.name), parent: stringArg(args.parent) });
    return "reason" in result ? result : { recorded: true };
  }
  if (name === "grant_role") {
    const result = await grantAccess(database, actor, projectCode, {
      principalType: "role",
      principalName: stringArg(args.role),
      menu: stringArg(args.menu),
      actions: Array.isArray(args.actions) ? args.actions.map(String) : [],
    });
    return "reason" in result ? result : { recorded: true };
  }
  if (name === "add_entity") {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    for (const field of fields) {
      const record = field as { type?: string; target?: string };
      if (!fieldTypes.includes(record.type ?? "")) {
        return { reason: "字段类型无效", status: 400 };
      }
      if (record.type === "ref" && !record.target) {
        return { reason: "引用必须指定目标", status: 400 };
      }
    }
    await database.query("insert into draft_records (id, project_id, kind, body) values (gen_random_uuid(), $1, 'entity', $2::jsonb)", [
      project.id,
      JSON.stringify(args),
    ]);
    return { recorded: true };
  }
  if (name === "add_workflow") {
    const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
    if (steps.some((step) => !workflowSteps.includes(step))) {
      return { reason: "流程步骤无效", status: 400 };
    }
    await database.query("insert into draft_records (id, project_id, kind, body) values (gen_random_uuid(), $1, 'workflow', $2::jsonb)", [
      project.id,
      JSON.stringify(args),
    ]);
    return { recorded: true };
  }
  if (name === "mark_extension" || name === "add_test_case") {
    if (name === "add_test_case") {
      const normalized = normalizeUserCase(args);
      if ("reason" in normalized) {
        return { reason: normalized.reason, status: 400 };
      }
    }
    await database.query("insert into draft_records (id, project_id, kind, body) values (gen_random_uuid(), $1, $2, $3::jsonb)", [
      project.id,
      name === "mark_extension" ? "extension" : "test_case",
      JSON.stringify(args),
    ]);
    return { recorded: true };
  }
  return { reason: "不能识别的操作", status: 400 };
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function ownSession(database: SystemDatabase, projectId: string, username: string): Promise<string> {
  const existing = await database.query<{ id: string }>(
    `select requirement_sessions.id from requirement_sessions
     join users on users.id = requirement_sessions.user_id
     where requirement_sessions.project_id = $1 and users.username = $2`,
    [projectId, username],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const created = await database.query<{ id: string }>(
    `insert into requirement_sessions (id, project_id, user_id)
     values (gen_random_uuid(), $1, (select id from users where username = $2)) returning id`,
    [projectId, username],
  );
  return created.rows[0].id;
}

export async function managedProject(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
): Promise<ManagedProject | { reason: string; status: number }> {
  const found = await database.query<{ id: string; project_admin: boolean }>(
    `select projects.id, project_members.project_admin
     from projects
     join project_members on project_members.project_id = projects.id
     join users on users.id = project_members.user_id
     where projects.code = $1 and users.username = $2`,
    [projectCode, actor.username],
  );
  if (!found.rows[0]?.project_admin) {
    return { reason: "没有项目管理权限", status: 403 };
  }
  return { id: found.rows[0].id };
}

export async function memberProject(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
): Promise<ManagedProject | { reason: string; status: number }> {
  const found = await database.query<{ id: string }>(
    `select projects.id from projects
     join project_members on project_members.project_id = projects.id
     join users on users.id = project_members.user_id
     where projects.code = $1 and users.username = $2`,
    [projectCode, actor.username],
  );
  if (!found.rows[0]) {
    return { reason: "没有项目管理权限", status: 403 };
  }
  return { id: found.rows[0].id };
}

async function unusedMenuCode(database: SystemDatabase, projectId: string, base: string): Promise<string> {
  let suffix = 2;
  let candidate = base;
  while (!isProjectCode(candidate) || (await menuTaken(database, projectId, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function menuTaken(database: SystemDatabase, projectId: string, code: string): Promise<boolean> {
  const found = await database.query("select 1 from draft_menus where project_id = $1 and code = $2", [projectId, code]);
  return found.rows.length > 0;
}
