import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

describe("user and access management", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function setup() {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.query("delete from nodes");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    app = await buildServer({ databaseUrl });
    const login = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    return { cookie: login.cookies.find((item) => item.name === "platform_session")!.value };
  }

  it("lists and manages users, and refuses non-administrators", async () => {
    const { cookie } = await setup();
    const created = await app!.inject({
      method: "POST",
      url: "/api/users",
      cookies: { platform_session: cookie },
      payload: { username: "alice", displayName: "爱丽丝", password: "secret-pass" },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app!.inject({ method: "GET", url: "/api/users", cookies: { platform_session: cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().users).toEqual([
      expect.objectContaining({ username: "admin", platformAdmin: true, disabled: false, wechatBound: false }),
      expect.objectContaining({ username: "alice", platformAdmin: false, disabled: false, wechatBound: false }),
    ]);
    expect(listed.body).not.toContain("password_hash");

    const disabled = await app!.inject({
      method: "POST",
      url: "/api/users/alice/disable",
      cookies: { platform_session: cookie },
    });
    expect(disabled.statusCode).toBe(204);
    const afterDisable = await app!.inject({ method: "GET", url: "/api/users", cookies: { platform_session: cookie } });
    expect(afterDisable.json().users.find((item: { username: string }) => item.username === "alice").disabled).toBe(true);

    const enabled = await app!.inject({
      method: "POST",
      url: "/api/users/alice/enable",
      cookies: { platform_session: cookie },
    });
    expect(enabled.statusCode).toBe(204);
    const afterEnable = await app!.inject({ method: "GET", url: "/api/users", cookies: { platform_session: cookie } });
    expect(afterEnable.json().users.find((item: { username: string }) => item.username === "alice").disabled).toBe(false);

    const missing = await app!.inject({
      method: "POST",
      url: "/api/users/nobody/enable",
      cookies: { platform_session: cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ reason: "用户不存在" });

    const employeeLogin = await app!.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "alice", password: "secret-pass" },
    });
    const employeeCookie = employeeLogin.cookies.find((item) => item.name === "platform_session")!.value;
    const forbidden = await app!.inject({ method: "GET", url: "/api/users", cookies: { platform_session: employeeCookie } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ reason: "需要平台管理员" });
    const forbiddenToggle = await app!.inject({
      method: "POST",
      url: "/api/users/admin/disable",
      cookies: { platform_session: employeeCookie },
    });
    expect(forbiddenToggle.statusCode).toBe(403);
  });

  it("lists and manages project members, roles and grants", async () => {
    const { cookie } = await setup();
    for (const [username, displayName] of [
      ["alice", "爱丽丝"],
      ["bob", "鲍勃"],
    ]) {
      const created = await app!.inject({
        method: "POST",
        url: "/api/users",
        cookies: { platform_session: cookie },
        payload: { username, displayName, password: "secret-pass" },
      });
      expect(created.statusCode).toBe(201);
    }
    const created = await app!.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: cookie },
      payload: { name: "请假审批" },
    });
    const code = created.json().project.code as string;

    const members = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/members`,
      cookies: { platform_session: cookie },
    });
    expect(members.json().members).toEqual([
      expect.objectContaining({ username: "admin", projectAdmin: true }),
    ]);

    const menu = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/menus`,
      cookies: { platform_session: cookie },
      payload: { name: "请假单" },
    });
    expect(menu.statusCode).toBe(201);
    const view = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
    });
    expect(view.json().access).toEqual({
      menus: [{ code: "qing-jia-dan", name: "请假单", parent_code: null }],
      roles: [],
      grants: [],
    });

    for (const [username, projectAdmin] of [
      ["alice", true],
      ["bob", false],
    ]) {
      const added = await app!.inject({
        method: "POST",
        url: `/api/projects/${code}/members`,
        cookies: { platform_session: cookie },
        payload: { username, projectAdmin },
      });
      expect(added.statusCode).toBe(201);
    }
    const withMembers = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/members`,
      cookies: { platform_session: cookie },
    });
    expect(withMembers.json().members.map((item: { username: string }) => item.username)).toEqual(["admin", "alice", "bob"]);

    const roleGrant = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
      payload: { principalType: "role", principalName: "审批人", menu: "qing-jia-dan", actions: ["访问", "修改"] },
    });
    expect(roleGrant.statusCode).toBe(201);
    const userGrant = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
      payload: { principalType: "user", principalName: "bob", menu: "qing-jia-dan", actions: ["访问"] },
    });
    expect(userGrant.statusCode).toBe(201);
    const assigned = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/roles/assign`,
      cookies: { platform_session: cookie },
      payload: { role: "审批人", username: "alice" },
    });
    expect(assigned.statusCode).toBe(201);

    const filled = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
    });
    expect(filled.json().access.roles).toEqual([{ name: "审批人", members: ["alice"] }]);
    expect(filled.json().access.grants).toEqual([
      { principal_type: "role", principal_name: "审批人", menu_code: "qing-jia-dan", action: "修改" },
      { principal_type: "role", principal_name: "审批人", menu_code: "qing-jia-dan", action: "访问" },
      { principal_type: "user", principal_name: "bob", menu_code: "qing-jia-dan", action: "访问" },
    ]);

    const revoke = await app!.inject({
      method: "DELETE",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
      payload: { principalType: "user", principalName: "bob", menu: "qing-jia-dan", action: "访问" },
    });
    expect(revoke.statusCode).toBe(204);
    const afterRevoke = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
    });
    expect(afterRevoke.json().access.grants).toHaveLength(2);
    expect(afterRevoke.json().access.grants.some((item: { principal_type: string }) => item.principal_type === "user")).toBe(false);
    const missingGrant = await app!.inject({
      method: "DELETE",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
      payload: { principalType: "user", principalName: "bob", menu: "qing-jia-dan", action: "访问" },
    });
    expect(missingGrant.statusCode).toBe(404);

    const unassign = await app!.inject({
      method: "DELETE",
      url: `/api/projects/${code}/roles/assign`,
      cookies: { platform_session: cookie },
      payload: { role: "审批人", username: "alice" },
    });
    expect(unassign.statusCode).toBe(204);
    const afterUnassign = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
    });
    expect(afterUnassign.json().access.roles).toEqual([{ name: "审批人", members: [] }]);

    const assignedBob = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/roles/assign`,
      cookies: { platform_session: cookie },
      payload: { role: "审批人", username: "bob" },
    });
    expect(assignedBob.statusCode).toBe(201);
    const removed = await app!.inject({
      method: "DELETE",
      url: `/api/projects/${code}/members/bob`,
      cookies: { platform_session: cookie },
    });
    expect(removed.statusCode).toBe(204);
    const afterRemove = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/members`,
      cookies: { platform_session: cookie },
    });
    expect(afterRemove.json().members.map((item: { username: string }) => item.username)).toEqual(["admin", "alice"]);
    const rolesAfter = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
    });
    expect(rolesAfter.json().access.roles).toEqual([{ name: "审批人", members: [] }]);

    const selfRemove = await app!.inject({
      method: "DELETE",
      url: `/api/projects/${code}/members/admin`,
      cookies: { platform_session: cookie },
    });
    expect(selfRemove.statusCode).toBe(400);
    expect(selfRemove.json()).toEqual({ reason: "不能移除自己" });

    const bobLogin = await app!.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "bob", password: "secret-pass" },
    });
    const bobCookie = bobLogin.cookies.find((item) => item.name === "platform_session")!.value;
    const forbidden = await app!.inject({
      method: "GET",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: bobCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ reason: "没有项目管理权限" });
  });
});
