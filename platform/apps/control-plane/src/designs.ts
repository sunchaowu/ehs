import { createHash } from "node:crypto";
import { compileDesign, type DesignDocument } from "./compiler.js";
import type { SystemDatabase } from "./database.js";
import { regenerateTestCases } from "./test-cases.js";

export async function storeCompiledDesign(
  database: SystemDatabase,
  projectId: string,
): Promise<{ sourceRevision: string }> {
  const project = await database.query<{ code: string; container_group: string }>(
    `select projects.code, container_groups.code as container_group
     from projects
     join container_groups on container_groups.id = projects.container_group_id
     where projects.id = $1`,
    [projectId],
  );
  const menus = await database.query<{ code: string; name: string; parent_code: string | null; sort: number }>(
    "select code, name, parent_code, sort from draft_menus where project_id = $1",
    [projectId],
  );
  const grants = await database.query<{ principal_type: string; principal_name: string; menu_code: string; action: string }>(
    "select principal_type, principal_name, menu_code, action from draft_grants where project_id = $1",
    [projectId],
  );
  const records = await database.query<{ kind: string; body: Record<string, unknown> }>(
    "select kind, body from draft_records where project_id = $1 and kind in ('entity', 'workflow', 'extension')",
    [projectId],
  );
  const design: DesignDocument = {
    projectCode: project.rows[0].code,
    containerGroup: project.rows[0].container_group,
    menus: menus.rows.map((menu) => ({ code: menu.code, name: menu.name, parentCode: menu.parent_code, sort: Number(menu.sort) })),
    grants: grants.rows.map((grant) => ({
      principalType: grant.principal_type,
      principalName: grant.principal_name,
      menuCode: grant.menu_code,
      action: grant.action,
    })),
    entities: records.rows.filter((record) => record.kind === "entity").flatMap((record) => readEntity(record.body)),
    workflows: records.rows.filter((record) => record.kind === "workflow").flatMap((record) => readWorkflow(record.body)),
    extensions: records.rows.filter((record) => record.kind === "extension").flatMap((record) => readExtension(record.body)),
  };
  const compiled = compileDesign(design);
  await database.query(
    `insert into project_designs (id, project_id, revision, body, source_revision, files, created_at)
     values (gen_random_uuid(), $1, $2, $3::jsonb, $4, $5::jsonb, now())`,
    [projectId, designRevision(design), JSON.stringify(design), compiled.sourceRevision, JSON.stringify(compiled.files)],
  );
  await regenerateTestCases(database, { id: projectId, code: design.projectCode }, design);
  return { sourceRevision: compiled.sourceRevision };
}

export async function latestCompiledSource(
  database: SystemDatabase,
  projectId: string,
): Promise<{ sourceRevision: string; files: Record<string, string> } | { reason: string; status: number }> {
  const found = await database.query<{ source_revision: string; files: Record<string, string> }>(
    `select source_revision, files from project_designs
     where project_id = $1
     order by created_at desc
     limit 1`,
    [projectId],
  );
  const row = found.rows[0];
  if (!row) {
    return { reason: "还没有确认的设计", status: 404 };
  }
  return { sourceRevision: row.source_revision, files: row.files };
}

function designRevision(design: DesignDocument): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(design)).digest("hex")}`;
}

function readEntity(body: Record<string, unknown>): DesignDocument["entities"] {
  const name = typeof body.name === "string" ? body.name : "";
  if (!name) {
    return [];
  }
  const fields = Array.isArray(body.fields) ? body.fields.flatMap(readField) : [];
  return [{ name, fields }];
}

function readField(value: unknown): Array<{ name: string; type: string; target?: string }> {
  const field = value as { name?: string; type?: string; target?: string };
  if (!field?.name || !field.type) {
    return [];
  }
  return [field.target ? { name: field.name, type: field.type, target: field.target } : { name: field.name, type: field.type }];
}

function readWorkflow(body: Record<string, unknown>): DesignDocument["workflows"] {
  const name = typeof body.name === "string" ? body.name : "";
  const steps = Array.isArray(body.steps) ? body.steps.map(String) : [];
  return [{ name, steps }];
}

function readExtension(body: Record<string, unknown>): DesignDocument["extensions"] {
  const name = typeof body.name === "string" ? body.name : "";
  return name ? [{ name }] : [];
}
