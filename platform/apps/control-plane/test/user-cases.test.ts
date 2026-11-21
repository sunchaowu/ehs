import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

// 涉及多次建库与方案确认，串行全套时放宽超时。
vi.setConfig({ testTimeout: 20_000 });

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

const whiteBoxCase = {
  method: "white-box",
  name: "自定义创建接口返回记录",
  steps: [{ action: "call", target: "qing-jia-shen-pi/请假单.create", expected: "返回带 id 的记录" }],
};

describe("user test case management", () => {
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
    const cookie = login.cookies.find((item) => item.name === "platform_session")!.value;
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: cookie },
      payload: { name: "请假审批" },
    });
    return { cookie, code: created.json().project.code as string, databaseUrl: databaseUrl! };
  }

  it("adds, lists, deduplicates and removes user cases immediately", async () => {
    const { cookie, code } = await setup();
    const empty = await app!.inject({ method: "GET", url: `/api/projects/${code}/tests/cases`, cookies: { platform_session: cookie } });
    expect(empty.json()).toEqual({ cases: [] });

    const invalid = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/cases`,
      cookies: { platform_session: cookie },
      payload: { method: "bogus", name: "", steps: [] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ reason: "测试方法无效" });

    const added = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/cases`,
      cookies: { platform_session: cookie },
      payload: whiteBoxCase,
    });
    expect(added.statusCode).toBe(201);
    const testCase = added.json().testCase;
    expect(testCase).toMatchObject({ origin: "user", method: "white-box", name: whiteBoxCase.name });
    expect(testCase.code).toMatch(/^case-/);

    const duplicate = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/cases`,
      cookies: { platform_session: cookie },
      payload: whiteBoxCase,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ reason: "案例已存在" });

    const listed = await app!.inject({ method: "GET", url: `/api/projects/${code}/tests/cases`, cookies: { platform_session: cookie } });
    expect(listed.json().cases).toHaveLength(1);
    expect(listed.json().cases[0]).toMatchObject({ code: testCase.code, name: whiteBoxCase.name });

    // 同时写入 draft_records，方案确认重新生成后仍保留。
    const record = await openDatabase((process.env.DATABASE_SYSTEM_URL)!);
    const drafts = await record.query<{ body: Record<string, unknown> }>(
      "select body from draft_records where kind = 'test_case' and body->>'name' = $1",
      [whiteBoxCase.name],
    );
    expect(drafts.rows).toHaveLength(1);
    await record.close();

    const removed = await app!.inject({
      method: "DELETE",
      url: `/api/projects/${code}/tests/cases/${testCase.code}`,
      cookies: { platform_session: cookie },
    });
    expect(removed.statusCode).toBe(204);
    const afterRemove = await app!.inject({ method: "GET", url: `/api/projects/${code}/tests/cases`, cookies: { platform_session: cookie } });
    expect(afterRemove.json()).toEqual({ cases: [] });
    const record2 = await openDatabase((process.env.DATABASE_SYSTEM_URL)!);
    const drafts2 = await record2.query("select 1 from draft_records where kind = 'test_case' and body->>'name' = $1", [whiteBoxCase.name]);
    expect(drafts2.rows).toHaveLength(0);
    await record2.close();

    const missing = await app!.inject({
      method: "DELETE",
      url: `/api/projects/${code}/tests/cases/${testCase.code}`,
      cookies: { platform_session: cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("keeps user cases after solution confirmation regenerates the candidate", async () => {
    const { cookie, code } = await setup();
    await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/menus`,
      cookies: { platform_session: cookie },
      payload: { name: "请假单" },
    });
    await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/tools`,
      cookies: { platform_session: cookie },
      payload: { name: "add_entity", arguments: { name: "请假单", fields: [{ name: "天数", type: "number" }] } },
    });
    const added = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/cases`,
      cookies: { platform_session: cookie },
      payload: whiteBoxCase,
    });
    expect(added.statusCode).toBe(201);
    const confirmed = await app!.inject({ method: "POST", url: `/api/projects/${code}/confirm`, cookies: { platform_session: cookie } });
    expect(confirmed.statusCode).toBe(201);
    const listed = await app!.inject({ method: "GET", url: `/api/projects/${code}/tests/cases`, cookies: { platform_session: cookie } });
    expect(listed.json().cases).toEqual([
      expect.objectContaining({ name: whiteBoxCase.name, method: "white-box", origin: "user" }),
    ]);
  });

  it("refuses non-administrators and anonymous users", async () => {
    const { cookie, code } = await setup();
    const created = await app!.inject({
      method: "POST",
      url: "/api/users",
      cookies: { platform_session: cookie },
      payload: { username: "alice", displayName: "爱丽丝", password: "secret-pass" },
    });
    expect(created.statusCode).toBe(201);
    const employeeLogin = await app!.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "alice", password: "secret-pass" },
    });
    const employeeCookie = employeeLogin.cookies.find((item) => item.name === "platform_session")!.value;
    const forbidden = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/cases`,
      cookies: { platform_session: employeeCookie },
      payload: whiteBoxCase,
    });
    expect(forbidden.statusCode).toBe(403);
    const forbiddenDelete = await app!.inject({
      method: "DELETE",
      url: `/api/projects/${code}/tests/cases/case-none`,
      cookies: { platform_session: employeeCookie },
    });
    expect(forbiddenDelete.statusCode).toBe(403);
    const anonymous = await app!.inject({
      method: "POST",
      url: `/api/projects/${code}/tests/cases`,
      payload: whiteBoxCase,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
