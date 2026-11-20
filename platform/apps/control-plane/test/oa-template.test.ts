import { afterEach, describe, expect, it } from "vitest";
import { installInitialAdmin } from "../src/install-admin.js";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

describe("oa template", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("fills the draft with menus, entities, a workflow, roles, grants, and user cases", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    app = await buildServer({ databaseUrl });
    const login = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    const cookie = login.cookies.find((item) => item.name === "platform_session")!.value;
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: cookie },
      payload: { name: "OA 试点" },
    });
    const code = created.json().project.code as string;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/apply-template`,
      cookies: { platform_session: cookie },
      payload: { template: "unknown" },
    });
    expect(rejected.statusCode).toBe(400);
    const applied = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/apply-template`,
      cookies: { platform_session: cookie },
      payload: { template: "oa" },
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.json()).toMatchObject({
      applied: true,
      template: "OA 办公模板",
      menus: 5,
      entities: 4,
      workflows: 1,
      grants: 18,
      cases: 5,
    });
    const draft = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/draft`,
      cookies: { platform_session: cookie },
    });
    const menuNames = draft.json().menus.map((menu: { name: string }) => menu.name);
    expect(menuNames).toEqual(expect.arrayContaining(["组织", "员工", "部门", "请假", "公告"]));

    const reopened = await openDatabase(databaseUrl!);
    const employees = await effectiveActionsFor(reopened, code, "员工", "组织");
    expect(employees).toEqual(["访问"]);
    const hr = await effectiveActionsFor(reopened, code, "人事", "组织");
    expect(hr).toEqual(["访问", "新增", "修改", "删除"]);
    const caseRows = await reopened.query<{ name: string; kind: string }>(
      "select body->>'name' as name, kind from draft_records where kind = 'test_case' and project_id = (select id from projects where code = $1)",
      [code],
    );
    const caseNames = caseRows.rows.map((row) => row.name);
    expect(caseNames).toEqual(
      expect.arrayContaining(["员工提交请假", "部门负责人审批", "人事备案", "部门负责人不能访问组织菜单", "请假单缺少必填字段被拒绝"]),
    );
    await reopened.close();

    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/apply-template`,
      cookies: { platform_session: cookie },
      payload: { template: "oa" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ menus: 5, entities: 0, workflows: 0, grants: 0, cases: 0 });
  });

  it("keeps the template cases through confirmation and compiles the design", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    app = await buildServer({ databaseUrl });
    const login = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    const cookie = login.cookies.find((item) => item.name === "platform_session")!.value;
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: cookie },
      payload: { name: "OA 内容核对" },
    });
    const code = created.json().project.code as string;
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/apply-template`,
      cookies: { platform_session: cookie },
      payload: { template: "oa" },
    });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/confirm`,
      cookies: { platform_session: cookie },
    });
    expect(confirmed.statusCode).toBe(201);
    const reopened = await openDatabase(databaseUrl!);
    const cases = await reopened.query<{ origin: string; name: string }>(
      "select origin, name from test_cases where project_id = (select id from projects where code = $1) order by origin, name",
      [code],
    );
    const names = cases.rows.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["员工提交请假", "部门负责人审批", "人事备案", "部门负责人不能访问组织菜单", "请假单缺少必填字段被拒绝"]));
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining("请假单 创建接口返回记录"), expect.stringContaining("请假单 字段校验拒绝非法输入")]));
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining("请假流程 流程走查")]));
    const source = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/source`,
      cookies: { platform_session: cookie },
    });
    expect(source.statusCode).toBe(200);
    expect(source.json().files[`modules/${code}/module.ts`]).toContain("请假流程");
    await reopened.close();
  });
});

async function effectiveActionsFor(
  database: Awaited<ReturnType<typeof openDatabase>>,
  code: string,
  role: string,
  menu: string,
): Promise<string[]> {
  const grants = await database.query<{ action: string }>(
    `select distinct draft_grants.action
     from draft_grants
     join projects on projects.id = draft_grants.project_id
     join draft_menus on draft_menus.project_id = draft_grants.project_id and draft_menus.code = draft_grants.menu_code
     where projects.code = $1 and draft_grants.principal_type = 'role' and draft_grants.principal_name = $2 and draft_menus.name = $3`,
    [code, role, menu],
  );
  const order = ["访问", "新增", "修改", "删除"];
  return order.filter((action) => grants.rows.some((row) => row.action === action));
}
