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

describe("solution confirmation", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("previews and records the real diff against the published version", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.query("delete from projects");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    app = await buildServer({ databaseUrl });
    const login = await app.inject({ method: "POST", url: "/api/session/login", payload: { username: "admin", password: installed.password } });
    const cookie = login.cookies.find((item) => item.name === "platform_session")!.value;
    const created = await app.inject({ method: "POST", url: "/api/projects", cookies: { platform_session: cookie }, payload: { name: "请假审批" } });
    const code = created.json().project.code as string;
    await app.inject({ method: "POST", url: `/api/projects/${code}/menus`, cookies: { platform_session: cookie }, payload: { name: "请假单" } });
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/grants`,
      cookies: { platform_session: cookie },
      payload: { principalType: "user", principalName: "alice", menu: "qing-jia-dan", actions: ["访问"] },
    });

    const first = await app.inject({ method: "GET", url: `/api/projects/${code}/change`, cookies: { platform_session: cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.json().change.added.menus).toEqual([{ code: "qing-jia-dan", name: "请假单", parent_code: null }]);
    expect(first.json().change.added.grants).toEqual([
      { principal_type: "user", principal_name: "alice", menu_code: "qing-jia-dan", action: "访问" },
    ]);
    expect(first.json().change.modified).toEqual([]);
    expect(first.json().change.removed).toEqual({ menus: [], grants: [] });

    const state = await openDatabase(databaseUrl!);
    const project = await state.query<{ id: string }>("select id from projects where code = $1", [code]);
    const projectId = project.rows[0].id;
    await state.query("insert into published_menus (project_id, code, name, parent_code) values ($1, $2, $3, $4)", [projectId, "qing-jia-dan", "请假单", null]);
    await state.query(
      "insert into published_grants (project_id, principal_type, principal_name, menu_code, action) values ($1, $2, $3, $4, $5)",
      [projectId, "user", "alice", "qing-jia-dan", "访问"],
    );
    const unchanged = await app.inject({ method: "GET", url: `/api/projects/${code}/change`, cookies: { platform_session: cookie } });
    expect(unchanged.json().change).toEqual({ added: { menus: [], grants: [] }, modified: [], removed: { menus: [], grants: [] } });

    await state.query("update draft_menus set name = $1 where project_id = $2 and code = $3", ["请假申请", projectId, "qing-jia-dan"]);
    await state.query("delete from draft_grants where project_id = $1 and menu_code = $2", [projectId, "qing-jia-dan"]);
    await state.query(
      "insert into draft_grants (project_id, principal_type, principal_name, menu_code, action) values ($1, $2, $3, $4, $5)",
      [projectId, "user", "alice", "qing-jia-dan", "修改"],
    );
    await state.query("insert into published_menus (project_id, code, name, parent_code) values ($1, $2, $3, $4)", [projectId, "gong-gao", "公告", null]);
    await state.query(
      "insert into draft_menus (id, project_id, code, name, parent_code, sort) values (gen_random_uuid(), $1, $2, $3, $4, $5)",
      [projectId, "xin-wen", "新闻", null, 99],
    );

    const changed = await app.inject({ method: "GET", url: `/api/projects/${code}/change`, cookies: { platform_session: cookie } });
    expect(changed.json().change.added.menus).toEqual([{ code: "xin-wen", name: "新闻", parent_code: null }]);
    expect(changed.json().change.removed.menus).toEqual([{ code: "gong-gao", name: "公告", parent_code: null }]);
    expect(changed.json().change.modified).toEqual([
      {
        kind: "menu",
        code: "qing-jia-dan",
        changes: { name: { from: "请假单", to: "请假申请" } },
      },
      {
        kind: "grant",
        principal_type: "user",
        principal_name: "alice",
        menu_code: "qing-jia-dan",
        added_actions: ["修改"],
        removed_actions: ["访问"],
      },
    ]);

    const confirmed = await app.inject({ method: "POST", url: `/api/projects/${code}/confirm`, cookies: { platform_session: cookie } });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().change).toEqual(changed.json().change);
    const recorded = await state.query<{ added: unknown; modified: unknown; removed: unknown }>(
      "select added, modified, removed from openspec_changes where project_id = $1 order by confirmed_at desc limit 1",
      [projectId],
    );
    expect(recorded.rows[0].added).toEqual(changed.json().change.added);
    expect(recorded.rows[0].modified).toEqual(changed.json().change.modified);
    expect(recorded.rows[0].removed).toEqual(changed.json().change.removed);
    await state.close();
  });
});
