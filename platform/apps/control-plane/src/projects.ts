import type { PublicUser } from "./accounts.js";
import type { SystemDatabase } from "./database.js";
import { isProjectCode, suggestProjectCode } from "./project-code.js";

export type ProjectSummary = {
  name: string;
  code: string;
  containerGroup: string;
  projectAdmin: boolean;
};

export async function canCreateProject(database: SystemDatabase, user: PublicUser): Promise<boolean> {
  if (user.platformAdmin) {
    return true;
  }
  const found = await database.query(
    `select 1 from platform_permissions
     join users on users.id = platform_permissions.user_id
     where users.username = $1 and platform_permissions.permission = 'create_project'`,
    [user.username],
  );
  return found.rows.length > 0;
}

export async function createProject(
  database: SystemDatabase,
  actor: PublicUser,
  request: { name?: string; code?: string; containerGroup?: string },
): Promise<{ project: ProjectSummary } | { reason: string; status: number }> {
  if (!(await canCreateProject(database, actor))) {
    return { reason: "没有创建项目的权限", status: 403 };
  }
  const name = request.name?.trim() ?? "";
  if (!name) {
    return { reason: "请输入项目名称", status: 400 };
  }
  const requested = request.code?.trim() ?? "";
  let code = requested;
  if (!code) {
    const suggested = suggestProjectCode(name);
    if ("reason" in suggested) {
      return { reason: suggested.reason, status: 400 };
    }
    code = await unusedCode(database, suggested.code);
  } else if (!isProjectCode(code)) {
    return { reason: "项目编码无效", status: 400 };
  } else if (await codeTaken(database, code)) {
    return { reason: "项目编码已存在", status: 409 };
  }
  const groupCode = request.containerGroup?.trim() || code;
  if (!isProjectCode(groupCode)) {
    return { reason: "容器组编码无效", status: 400 };
  }
  const actorId = await userId(database, actor.username);
  if (!actorId) {
    return { reason: "未登录", status: 401 };
  }
  let groupId = await findGroup(database, groupCode);
  if (!groupId) {
    if (request.containerGroup?.trim()) {
      return { reason: "容器组不存在", status: 404 };
    }
    const created = await database.query<{ id: string }>(
      "insert into container_groups (id, code) values (gen_random_uuid(), $1) returning id",
      [groupCode],
    );
    groupId = created.rows[0].id;
  }
  const inserted = await database.query<{ id: string }>(
    `insert into projects (id, name, code, container_group_id, created_by)
     values (gen_random_uuid(), $1, $2, $3, $4) returning id`,
    [name, code, groupId, actorId],
  );
  await database.query(
    `insert into project_members (project_id, user_id, project_admin) values ($1, $2, true)`,
    [inserted.rows[0].id, actorId],
  );
  return { project: { name, code, containerGroup: groupCode, projectAdmin: true } };
}

export async function listProjects(database: SystemDatabase, actor: PublicUser): Promise<ProjectSummary[]> {
  const found = await database.query<{ name: string; code: string; container_group: string; project_admin: boolean }>(
    `select projects.name, projects.code, container_groups.code as container_group, project_members.project_admin
     from projects
     join container_groups on container_groups.id = projects.container_group_id
     join project_members on project_members.project_id = projects.id
     join users on users.id = project_members.user_id
     where users.username = $1
     order by projects.name`,
    [actor.username],
  );
  return found.rows.map((row) => ({
    name: row.name,
    code: row.code,
    containerGroup: row.container_group,
    projectAdmin: row.project_admin,
  }));
}

export async function addProjectMember(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  request: { username?: string; projectAdmin?: boolean },
): Promise<{ added: true } | { reason: string; status: number }> {
  const project = await database.query<{ id: string }>(
    `select projects.id from projects
     join project_members on project_members.project_id = projects.id
     join users on users.id = project_members.user_id
     where projects.code = $1 and users.username = $2 and project_members.project_admin`,
    [projectCode, actor.username],
  );
  if (!project.rows[0]) {
    return { reason: "没有项目管理权限", status: 403 };
  }
  const username = request.username?.trim() ?? "";
  const member = await database.query<{ id: string }>("select id from users where username = $1", [username]);
  if (!member.rows[0]) {
    return { reason: "用户不存在", status: 404 };
  }
  await database.query(
    `insert into project_members (project_id, user_id, project_admin) values ($1, $2, $3)
     on conflict (project_id, user_id) do update set project_admin = excluded.project_admin`,
    [project.rows[0].id, member.rows[0].id, request.projectAdmin === true],
  );
  return { added: true };
}

export type ProjectMemberView = { username: string; displayName: string; projectAdmin: boolean };

async function requireProjectAdmin(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
): Promise<{ id: string } | { reason: string; status: number }> {
  const found = await database.query<{ id: string }>(
    `select projects.id from projects
     join project_members on project_members.project_id = projects.id
     join users on users.id = project_members.user_id
     where projects.code = $1 and users.username = $2 and project_members.project_admin`,
    [projectCode, actor.username],
  );
  const row = found.rows[0];
  return row ? { id: row.id } : { reason: "没有项目管理权限", status: 403 };
}

export async function listProjectMembers(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
): Promise<{ members: ProjectMemberView[] } | { reason: string; status: number }> {
  const project = await requireProjectAdmin(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  const found = await database.query<{ username: string; display_name: string; project_admin: boolean }>(
    `select users.username, users.display_name, project_members.project_admin
     from project_members
     join users on users.id = project_members.user_id
     where project_members.project_id = $1
     order by users.username`,
    [project.id],
  );
  return {
    members: found.rows.map((row) => ({
      username: row.username,
      displayName: row.display_name,
      projectAdmin: row.project_admin,
    })),
  };
}

export async function removeProjectMember(
  database: SystemDatabase,
  actor: PublicUser,
  projectCode: string,
  username: string,
): Promise<{ removed: true } | { reason: string; status: number }> {
  const project = await requireProjectAdmin(database, actor, projectCode);
  if ("reason" in project) {
    return project;
  }
  if (username === actor.username) {
    return { reason: "不能移除自己", status: 400 };
  }
  const removed = await database.query(
    "delete from project_members where project_id = $1 and user_id = (select id from users where username = $2)",
    [project.id, username],
  );
  if ((removed.rowCount ?? 0) === 0) {
    return { reason: "成员不存在", status: 404 };
  }
  // 用户离开项目后不应继续通过角色继承授权。
  await database.query(
    "delete from project_role_members where project_id = $1 and username = $2",
    [project.id, username],
  );
  return { removed: true };
}

async function unusedCode(database: SystemDatabase, base: string): Promise<string> {
  let suffix = 2;
  let candidate = base;
  while (await codeTaken(database, candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
    if (!isProjectCode(candidate)) {
      return base;
    }
  }
  return candidate;
}

async function codeTaken(database: SystemDatabase, code: string): Promise<boolean> {
  const found = await database.query("select 1 from projects where code = $1", [code]);
  return found.rows.length > 0;
}

async function findGroup(database: SystemDatabase, code: string): Promise<string | undefined> {
  const found = await database.query<{ id: string }>("select id from container_groups where code = $1", [code]);
  return found.rows[0]?.id;
}

async function userId(database: SystemDatabase, username: string): Promise<string | undefined> {
  const found = await database.query<{ id: string }>("select id from users where username = $1", [username]);
  return found.rows[0]?.id;
}
