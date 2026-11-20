import type { SystemDatabase } from "./database.js";
import type { DesignDocument } from "./compiler.js";
import { projectDatabaseName } from "./images.js";
import { authenticateNode, poolNames } from "./nodes.js";
import { claimTestJobs, type NodeTestJob } from "./node-tests.js";
import { candidateTestVerdict } from "./test-gate.js";

export type ReportedProject = {
  code?: string;
  running?: boolean;
  databaseConnected?: boolean;
  imageDigest?: string;
  reason?: string;
};

type NodeView = { name: string; healthy: boolean; reason?: string };

export async function readDesiredWork(
  database: SystemDatabase,
  name: string,
  authorization: string,
): Promise<
  | { projects: Array<{ code: string; imageDigest: string; databaseName: string; replicas: number }>; tests: NodeTestJob[] }
  | { reason: string; status: number }
> {
  const node = await authenticateNode(database, name, authorization);
  if (!node) {
    return { reason: "节点凭证无效", status: 401 };
  }
  return { projects: await assignmentsFor(database, name), tests: await claimTestJobs(database, name) };
}

export async function acceptHealthReport(
  database: SystemDatabase,
  name: string,
  authorization: string,
  projects: ReportedProject[],
  gateway = "",
): Promise<{ accepted: true } | { reason: string; status: number }> {
  const node = await authenticateNode(database, name, authorization);
  if (!node) {
    return { reason: "节点凭证无效", status: 401 };
  }
  await database.query(
    `insert into node_reports (node_name, reported_at, projects, gateway)
     values ($1, now(), $2::jsonb, $3)
     on conflict (node_name) do update set reported_at = now(), projects = excluded.projects, gateway = excluded.gateway`,
    [name, JSON.stringify(projects), gateway.trim()],
  );
  await publishHealthyProjects(database);
  return { accepted: true };
}

/**
 * 项目入口：只对已发布版本开放，目标节点上报了网关地址且容器正在运行。
 * 返回的地址形如 `http://172.18.0.32:8081`，由控制面继续转发 `/p/<编码>/...`。
 */
export async function readProjectEntry(
  database: SystemDatabase,
  projectCode: string,
): Promise<{ gateway: string } | { reason: string; status: number }> {
  const project = await database.query<{ id: string }>("select id from projects where code = $1", [projectCode]);
  const projectId = project.rows[0]?.id;
  if (!projectId) {
    return { reason: "项目不存在", status: 404 };
  }
  const published = await database.query<{ image_digest: string }>(
    "select image_digest from published_versions where project_id = $1",
    [projectId],
  );
  const digest = published.rows[0]?.image_digest;
  if (!digest) {
    return { reason: "项目还没有已发布版本", status: 409 };
  }
  const desired = await database.query<{ target_nodes: string }>(
    "select target_nodes from desired_states where project_id = $1",
    [projectId],
  );
  const names = poolNames(desired.rows[0]?.target_nodes ?? "");
  if (names.length === 0) {
    return { reason: "项目还没有目标节点", status: 409 };
  }
  const reports = await database.query<{ node_name: string; gateway: string; projects: ReportedProject[] }>(
    `select node_name, gateway, projects from node_reports
     where node_name = any($1::text[]) and gateway <> ''
     order by reported_at desc`,
    [names],
  );
  for (const row of reports.rows) {
    const state = (row.projects ?? []).find((item) => item.code === projectCode);
    if (state?.running && state.imageDigest === digest) {
      return { gateway: row.gateway.replace(/\/+$/, "") };
    }
  }
  return { reason: "项目容器尚未在目标节点就绪", status: 503 };
}

export async function readProjectRelease(database: SystemDatabase, projectCode: string) {  const project = await database.query<{ id: string; container_group: string }>(
    `select projects.id, container_groups.code as container_group
     from projects
     join container_groups on container_groups.id = projects.container_group_id
     where projects.code = $1`,
    [projectCode],
  );
  const currentProject = project.rows[0];
  const desired = await database.query<{ image_digest: string; target_nodes: string }>(
    `select desired_states.image_digest, desired_states.target_nodes
     from desired_states
     join projects on projects.id = desired_states.project_id
     where projects.code = $1`,
    [projectCode],
  );
  const current = desired.rows[0];
  const published = await database.query<{ image_digest: string }>(
    `select published_versions.image_digest
     from published_versions
     join projects on projects.id = published_versions.project_id
     where projects.code = $1`,
    [projectCode],
  );
  const candidate = await database.query<{ image_digest: string }>(
    `select image_digest from release_candidates
     join projects on projects.id = release_candidates.project_id
     where projects.code = $1
     order by release_candidates.created_at desc
     limit 1`,
    [projectCode],
  );
  const others = await database.query<{ code: string; name: string }>(
    `select others.code, others.name
     from projects current
     join projects others on others.container_group_id = current.container_group_id and others.id <> current.id
     where current.code = $1
     order by others.code`,
    [projectCode],
  );
  const design = currentProject ? await database.query<{ body: DesignDocument }>(
    `select body from project_designs where project_id = $1 order by created_at desc limit 1`,
    [currentProject.id],
  ) : { rows: [] as Array<{ body: DesignDocument }> };
  const config = await database.readConfig();
  const candidateDigest = candidate.rows[0]?.image_digest ?? null;
  const testResult = config["test.requirePassBeforePublish"]
    ? candidateDigest && currentProject
      ? await candidateTestVerdict(database, currentProject.id, candidateDigest)
      : { passed: false, failedCases: [] as string[] }
    : { required: false };
  const summary = {
    containerGroup: currentProject?.container_group ?? "",
    otherProjects: others.rows,
    designSummary: design.rows[0]?.body.menus.map((menu) => menu.name) ?? [],
    candidateDigest,
    testResult,
  };
  if (!current) {
    return {
      published: false,
      desiredDigest: null,
      publishedDigest: published.rows[0]?.image_digest ?? null,
      nodes: [],
      ...summary,
    };
  }
  const nodes = explainContainerFailure(
    await nodeViews(database, projectCode, current.image_digest, poolNames(current.target_nodes)),
    !published.rows[0],
    projectDatabaseName("prd", projectCode),
  );
  const healthy = nodes.every((node) => node.healthy);
  return {
    published: healthy && published.rows[0]?.image_digest === current.image_digest,
    desiredDigest: current.image_digest,
    publishedDigest: published.rows[0]?.image_digest ?? null,
    nodes,
    ...summary,
  };
}

export async function cancelDesiredPublication(
  database: SystemDatabase,
  projectCode: string,
): Promise<{ cancelled: true }> {
  const project = await database.query<{ id: string }>("select id from projects where code = $1", [projectCode]);
  const projectId = project.rows[0]?.id;
  if (!projectId) {
    return { cancelled: true };
  }
  const published = await database.query<{ image_digest: string }>("select image_digest from published_versions where project_id = $1", [projectId]);
  if (published.rows[0]) {
    await database.query("update desired_states set image_digest = $2 where project_id = $1", [projectId, published.rows[0].image_digest]);
  } else {
    await database.query("delete from desired_states where project_id = $1", [projectId]);
  }
  return { cancelled: true };
}

function explainContainerFailure(nodes: NodeView[], firstPublish: boolean, databaseName: string): NodeView[] {
  if (!firstPublish) {
    return nodes;
  }
  return nodes.map((node) => {
    if (node.healthy || !node.reason?.includes("容器更新失败") || node.reason.includes(databaseName)) {
      return node;
    }
    return { ...node, reason: `${node.reason}：${databaseName}` };
  });
}

async function publishHealthyProjects(database: SystemDatabase): Promise<void> {
  const desired = await database.query<{ project_id: string; code: string; image_digest: string; target_nodes: string }>(
    `select projects.id as project_id, projects.code, desired_states.image_digest, desired_states.target_nodes
     from desired_states
     join projects on projects.id = desired_states.project_id`,
  );
  for (const row of desired.rows) {
    const nodes = await nodeViews(database, row.code, row.image_digest, poolNames(row.target_nodes));
    if (nodes.length === 0 || nodes.some((node) => !node.healthy)) {
      continue;
    }
    await snapshotPublished(database, row.project_id, row.image_digest);
  }
}

async function snapshotPublished(database: SystemDatabase, projectId: string, digest: string): Promise<void> {
  const found = await database.query<{ body: DesignDocument }>(
    `select project_designs.body
     from project_designs
     join release_candidates on release_candidates.project_id = project_designs.project_id
       and release_candidates.source_revision = project_designs.source_revision
     where project_designs.project_id = $1 and release_candidates.image_digest = $2
     order by project_designs.created_at desc
     limit 1`,
    [projectId, digest],
  );
  const design = found.rows[0]?.body;
  if (!design) {
    return;
  }
  await database.query("delete from published_menus where project_id = $1", [projectId]);
  await database.query("delete from published_grants where project_id = $1", [projectId]);
  for (const menu of design.menus) {
    await database.query(
      `insert into published_menus (project_id, code, name, parent_code) values ($1, $2, $3, $4)
       on conflict (project_id, code) do update set name = excluded.name, parent_code = excluded.parent_code`,
      [projectId, menu.code, menu.name, menu.parentCode],
    );
  }
  for (const grant of design.grants) {
    await database.query(
      `insert into published_grants (project_id, principal_type, principal_name, menu_code, action)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing`,
      [projectId, grant.principalType, grant.principalName, grant.menuCode, grant.action],
    );
  }
  await database.query(
    `insert into published_versions (project_id, image_digest) values ($1, $2)
     on conflict (project_id) do update set image_digest = excluded.image_digest`,
    [projectId, digest],
  );
}

async function nodeViews(database: SystemDatabase, projectCode: string, digest: string, names: string[]): Promise<NodeView[]> {
  const reports = await database.query<{ node_name: string; projects: ReportedProject[] }>(
    "select node_name, projects from node_reports where node_name = any($1::text[])",
    [names],
  );
  const byName = new Map(reports.rows.map((row) => [row.node_name, row.projects]));
  return names.map((name) => {
    const project = (byName.get(name) ?? []).find((item) => item.code === projectCode);
    if (!project) {
      return { name, healthy: false, reason: "尚未报告" };
    }
    if (!project.running) {
      return { name, healthy: false, reason: project.reason || "进程未运行" };
    }
    if (!project.databaseConnected) {
      return { name, healthy: false, reason: project.reason || "项目数据库不可连接" };
    }
    if (project.imageDigest !== digest) {
      return { name, healthy: false, reason: "运行镜像与期望不一致" };
    }
    return { name, healthy: true };
  });
}

async function assignmentsFor(database: SystemDatabase, name: string) {
  const desired = await database.query<{ code: string; image_digest: string; target_nodes: string; replicas: number }>(
    `select projects.code, desired_states.image_digest, desired_states.target_nodes, desired_states.replicas
     from desired_states
     join projects on projects.id = desired_states.project_id`,
  );
  return desired.rows
    .filter((row) => poolNames(row.target_nodes).includes(name))
    .map((row) => ({
      code: row.code,
      imageDigest: row.image_digest,
      databaseName: projectDatabaseName("prd", row.code),
      replicas: row.replicas,
    }));
}

