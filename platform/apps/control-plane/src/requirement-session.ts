import type { SystemDatabase } from "./database.js";
import { oaTemplate } from "./oa-template.js";

const oaKeywords = ["请假", "审批", "公告", "员工", "部门", "组织", "办公", "OA", "oa"];

function domainExcerpt(projectCode: string, text: string): string {
  if (!oaKeywords.some((keyword) => text.includes(keyword))) {
    return "当前这句话没有匹配的领域包，按需求人员原话记录，不要套用无关模板。";
  }
  const template = oaTemplate(projectCode);
  return [
    `匹配领域包：${template.name}。`,
    `菜单模板：${template.menus.map((menu) => menu.name).join("、")}。`,
    `数据模板：${template.entities.map((entity) => entity.name).join("、")}。`,
    `流程模板：${template.workflow.name}（${template.workflow.steps.join(" → ")}）。`,
    `角色模板：${template.grants.map((grant) => grant.role).join("、")}。`,
    "先用模板生成最小方案，再按需求人员原话修改差异；模板无法表达的能力用 mark_extension 标出。",
  ].join("\n");
}

/**
 * 需求会话系统提示词，按行为细则的五层组织：角色、项目快照、领域包摘录、工具、闸门。
 */
export async function requirementSystemPrompt(
  database: SystemDatabase,
  projectId: string,
  projectCode: string,
  userText: string,
): Promise<string> {
  const menus = await database.query<{ code: string; name: string; parent_code: string | null }>(
    "select code, name, parent_code from draft_menus where project_id = $1 order by sort",
    [projectId],
  );
  const roles = await database.query<{ name: string }>("select name from project_roles where project_id = $1", [projectId]);
  const grants = await database.query<{ principal_type: string; principal_name: string; menu_code: string; action: string }>(
    "select principal_type, principal_name, menu_code, action from draft_grants where project_id = $1",
    [projectId],
  );
  const records = await database.query<{ kind: string; body: unknown }>("select kind, body from draft_records where project_id = $1", [projectId]);
  const candidate = await database.query<{ image_digest: string }>(
    "select image_digest from release_candidates where project_id = $1 order by created_at desc limit 1",
    [projectId],
  );
  const published = await database.query<{ image_digest: string }>(
    "select image_digest from published_versions where project_id = $1",
    [projectId],
  );
  const latestTest = await database.query<{ status: string; failure: string }>(
    "select status, failure from test_runs where project_id = $1 order by started_at desc limit 1",
    [projectId],
  );

  const entities = records.rows.filter((row) => row.kind === "entity").map((row) => row.body);
  const workflows = records.rows.filter((row) => row.kind === "workflow").map((row) => row.body);
  const cases = records.rows.filter((row) => row.kind === "test_case").map((row) => row.body);
  const extensions = records.rows.filter((row) => row.kind === "extension").map((row) => row.body);

  const snapshot = {
    projectCode,
    menus: menus.rows,
    roles: roles.rows,
    grants: grants.rows,
    entities,
    workflows,
    userCases: cases,
    extensions,
    candidateImage: candidate.rows[0]?.image_digest ?? null,
    publishedImage: published.rows[0]?.image_digest ?? null,
    latestTest: latestTest.rows[0] ?? null,
  };

  return [
    "你是企业应用平台的需求分析师。你只负责把需求人员的原话转成当前项目的草稿，不执行发布，也不修改已发布版本。",
    "",
    "规则：",
    "- 只能通过提供给你的工具修改草稿；回复里只描述确实已经执行成功的工具结果，不要承诺未执行的动作。",
    "- 菜单编码、项目编码由平台生成，不要在回复里编造编码；需要引用时使用工具返回的编码。",
    "- 字段类型只能是 text、longText、number、boolean、date、datetime、user、ref；ref 必须指定目标实体。",
    "- 流程步骤只能是 submit、approve、record，按顺序执行。",
    "- 授权动作只能是 访问、新增、修改、删除；主体是用户或角色。",
    "- run_tests 只有在候选镜像已构建后才可用；构建镜像和发布确认由需求人员在门户完成，不在你的工具范围内。",
    "- 需求人员要求的复杂逻辑，如果领域包与标准能力都无法表达，用 mark_extension 记录名称和边界。",
    "- 一句话可以连续调用多个工具；全部修改都进入同一份草稿，方案确认前可继续修改。",
    "",
    domainExcerpt(projectCode, userText),
    "",
    `项目快照：${JSON.stringify(snapshot)}`,
  ].join("\n");
}
