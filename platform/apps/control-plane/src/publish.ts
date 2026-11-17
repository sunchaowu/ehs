import type { SystemDatabase } from "./database.js";
import { latestCompiledSource } from "./designs.js";
import { projectDatabaseName, type ImageBuildInput } from "./images.js";
import { poolNames } from "./nodes.js";
import { candidateTestVerdict } from "./test-gate.js";
import pg from "pg";

export type ImageBuilder = (input: ImageBuildInput) => Promise<{ digest: string } | { reason: string }>;
export type DatabaseProvisioner = (input: { adminUrl: string; databaseName: string }) => Promise<{ created: true } | { reason: string }>;

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export async function buildProjectImage(
  database: SystemDatabase,
  project: { id: string; code: string },
  builder: ImageBuilder,
): Promise<{ digest: string } | { reason: string; status: number }> {
  const source = await latestCompiledSource(database, project.id);
  if ("reason" in source) {
    return source;
  }
  const config = await database.readConfig();
  if (!config["registry.address"]) {
    return { reason: "镜像库未配置", status: 409 };
  }
  const files = { ...source.files };
  const siblings = await database.query<{ id: string }>(
    `select others.id
     from projects current
     join projects others on others.container_group_id = current.container_group_id and others.id <> current.id
     where current.id = $1`,
    [project.id],
  );
  for (const sibling of siblings.rows) {
    const compiled = await latestCompiledSource(database, sibling.id);
    if ("reason" in compiled) {
      continue;
    }
    Object.assign(files, compiled.files);
  }
  const built = await builder({
    registry: config["registry.address"],
    projectCode: project.code,
    sourceRevision: source.sourceRevision,
    files,
  });
  if ("reason" in built) {
    return { reason: built.reason, status: 409 };
  }
  if (!digestPattern.test(built.digest)) {
    return { reason: "镜像摘要无效", status: 409 };
  }
  await database.query(
    `insert into release_candidates (id, project_id, source_revision, image_digest, created_at)
     values (gen_random_uuid(), $1, $2, $3, now())`,
    [project.id, source.sourceRevision, built.digest],
  );
  return { digest: built.digest };
}

export async function latestImageDigest(database: SystemDatabase, projectId: string): Promise<string | null> {
  const found = await database.query<{ image_digest: string }>(
    `select image_digest from release_candidates
     where project_id = $1
     order by created_at desc
     limit 1`,
    [projectId],
  );
  return found.rows[0]?.image_digest ?? null;
}

export async function publishProject(
  database: SystemDatabase,
  project: { id: string; code: string },
  provisioner: DatabaseProvisioner,
): Promise<{ published: false; reason: string; nodes: string[] } | { reason: string; status: number; failedCases?: string[] }> {
  const digest = await latestImageDigest(database, project.id);
  if (!digest) {
    return { reason: "还没有候选镜像", status: 409 };
  }
  const config = await database.readConfig();
  if (config["test.requirePassBeforePublish"]) {
    const verdict = await candidateTestVerdict(database, project.id, digest);
    if (!verdict.passed) {
      return { reason: "当前候选测试未全部通过", status: 409, failedCases: verdict.failedCases };
    }
  }
  const nodes = poolNames(config["scheduler.defaultNodePool"]);
  if (nodes.length === 0) {
    return { reason: "默认节点池为空", status: 409 };
  }
  const found = await database.query<{ name: string }>("select name from nodes where name = any($1::text[])", [nodes]);
  if (found.rows.length !== nodes.length) {
    return { reason: "目标节点不存在", status: 409 };
  }
  if (!config["database.prodAdminUrl"]) {
    return { reason: "正式库未配置", status: 409 };
  }
  const databaseName = projectDatabaseName("prd", project.code);
  const created = await provisioner({ adminUrl: config["database.prodAdminUrl"], databaseName });
  if ("reason" in created) {
    return { reason: created.reason, status: 409 };
  }
  await database.query(
    `insert into desired_states (project_id, image_digest, target_nodes, replicas)
     values ($1, $2, $3, 1)
     on conflict (project_id) do update set image_digest = excluded.image_digest, target_nodes = excluded.target_nodes, replicas = excluded.replicas`,
    [project.id, digest, nodes.join(",")],
  );
  await database.query(
    `insert into portal_notifications (id, user_id, project_id, body, created_at)
     select gen_random_uuid(), project_members.user_id, others.id,
       '容器组 ' || container_groups.code || ' 将随项目 ' || current.code || ' 一起更新',
       now()
     from projects current
     join container_groups on container_groups.id = current.container_group_id
     join projects others on others.container_group_id = current.container_group_id and others.id <> current.id
     join project_members on project_members.project_id = others.id and project_members.project_admin
     where current.id = $1`,
    [project.id],
  );
  return { published: false, reason: "目标节点尚未报告健康", nodes };
}

export async function listNotifications(
  database: SystemDatabase,
  username: string,
): Promise<{ notifications: { body: string }[] }> {
  const found = await database.query<{ body: string }>(
    `select portal_notifications.body
     from portal_notifications
     join users on users.id = portal_notifications.user_id
     where users.username = $1
     order by portal_notifications.created_at`,
    [username],
  );
  return { notifications: found.rows };
}

export async function provisionPostgresDatabase(input: {
  adminUrl: string;
  databaseName: string;
}): Promise<{ created: true } | { reason: string }> {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(input.databaseName)) {
    return { reason: "正式库创建失败：库名无效" };
  }
  const client = new pg.Client({ connectionString: input.adminUrl });
  try {
    await client.connect();
    const existing = await client.query("select 1 from pg_database where datname = $1", [input.databaseName]);
    if ((existing.rowCount ?? 0) === 0) {
      await client.query(`create database "${input.databaseName}"`);
    }
    return { created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "正式库创建失败";
    return { reason: `正式库创建失败：${message}` };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** 每次测试前重建测试库：先删除（PG 13+ FORCE）再创建。库名经校验只含 [a-z0-9_-]，用双引号拼接。 */
export async function rebuildPostgresDatabase(input: {
  adminUrl: string;
  databaseName: string;
}): Promise<{ created: true } | { reason: string }> {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(input.databaseName)) {
    return { reason: "测试库创建失败：库名无效" };
  }
  const client = new pg.Client({ connectionString: input.adminUrl });
  try {
    await client.connect();
    await client.query(`drop database if exists "${input.databaseName}" with (force)`);
    await client.query(`create database "${input.databaseName}"`);
    return { created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "测试库创建失败";
    return { reason: `测试库创建失败：${message}` };
  } finally {
    await client.end().catch(() => undefined);
  }
}
