import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

// 节点登记/心跳/删除涉及多次建库与配置写入，串行全套时放宽超时。
vi.setConfig({ testTimeout: 20_000 });

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

describe("node management", () => {
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
    await database.query("delete from desired_states");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    // installInitialAdmin 创建默认配置；其后显式清空两个节点池，避免测试间互相污染。
    const configured = await openDatabase(databaseUrl!);
    const config = await configured.readConfig();
    await configured.saveConfig({ ...config, "scheduler.defaultNodePool": "", "test.nodePool": "" });
    await configured.close();
    app = await buildServer({ databaseUrl });
    const login = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    return { cookie: login.cookies.find((item) => item.name === "platform_session")!.value, databaseUrl: databaseUrl! };
  }

  it("lists nodes with pool and heartbeat, and refuses non-administrators", async () => {
    const { cookie } = await setup();
    const empty = await app!.inject({ method: "GET", url: "/api/nodes", cookies: { platform_session: cookie } });
    expect(empty.json()).toEqual({ nodes: [] });

    const registered = await app!.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "test-1", zone: "测试区" },
    });
    expect(registered.statusCode).toBe(201);
    const token = registered.json().token as string;
    expect(token).toBeTruthy();

    const beforePool = await app!.inject({ method: "GET", url: "/api/nodes", cookies: { platform_session: cookie } });
    expect(beforePool.json().nodes).toEqual([
      { name: "test-1", zone: "测试区", pool: "", reportedAt: null, projectCount: 0, gateway: "" },
    ]);
    expect(beforePool.body).not.toContain("token_hash");
    expect(beforePool.body).not.toContain("install_token_hash");

    const pooled = await app!.inject({
      method: "PUT",
      url: "/api/nodes/test-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "test" },
    });
    expect(pooled.json()).toEqual({ node: { name: "test-1", zone: "测试区", pool: "test" } });
    const wrongPool = await app!.inject({
      method: "PUT",
      url: "/api/nodes/test-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "prod" },
    });
    expect(wrongPool.statusCode).toBe(400);
    expect(wrongPool.json()).toEqual({ reason: "正式节点池只接受正式区节点" });

    const health = await app!.inject({
      method: "POST",
      url: "/api/nodes/test-1/health",
      headers: { authorization: `Bearer ${token}` },
      payload: { projects: [{ code: "leave", running: true, databaseConnected: true }], gateway: "http://172.18.0.9:8081" },
    });
    expect(health.statusCode).toBe(200);
    const afterHealth = await app!.inject({ method: "GET", url: "/api/nodes", cookies: { platform_session: cookie } });
    const reported = afterHealth.json().nodes[0];
    expect(reported.pool).toBe("test");
    expect(reported.reportedAt).toBeTruthy();
    expect(reported.projectCount).toBe(1);
    expect(reported.gateway).toBe("http://172.18.0.9:8081");

    const prod = await app!.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "prod-1", zone: "正式区" },
    });
    expect(prod.statusCode).toBe(201);
    await app!.inject({
      method: "PUT",
      url: "/api/nodes/prod-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "prod" },
    });
    const all = await app!.inject({ method: "GET", url: "/api/nodes", cookies: { platform_session: cookie } });
    expect(all.json().nodes.map((item: { name: string; pool: string }) => [item.name, item.pool])).toEqual([
      ["prod-1", "prod"],
      ["test-1", "test"],
    ]);

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
    const forbidden = await app!.inject({ method: "GET", url: "/api/nodes", cookies: { platform_session: employeeCookie } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ reason: "需要平台管理员" });
    const forbiddenCreate = await app!.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: employeeCookie },
      payload: { name: "hack", zone: "测试区" },
    });
    expect(forbiddenCreate.statusCode).toBe(403);
  });

  it("rotates tokens and removes nodes without leaving stale pool or target references", async () => {
    const { cookie, databaseUrl } = await setup();
    const registered = await app!.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "test-1", zone: "测试区" },
    });
    const oldToken = registered.json().token as string;
    await app!.inject({
      method: "PUT",
      url: "/api/nodes/test-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "test" },
    });

    const rotated = await app!.inject({
      method: "POST",
      url: "/api/nodes/test-1/rotate-token",
      cookies: { platform_session: cookie },
    });
    expect(rotated.statusCode).toBe(200);
    const newToken = rotated.json().token as string;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);
    const oldCredential = await app!.inject({
      method: "POST",
      url: "/api/nodes/test-1/health",
      headers: { authorization: `Bearer ${oldToken}` },
      payload: { projects: [] },
    });
    expect(oldCredential.statusCode).toBe(401);
    const newCredential = await app!.inject({
      method: "POST",
      url: "/api/nodes/test-1/health",
      headers: { authorization: `Bearer ${newToken}` },
      payload: { projects: [] },
    });
    expect(newCredential.statusCode).toBe(200);
    const missing = await app!.inject({
      method: "POST",
      url: "/api/nodes/nobody/rotate-token",
      cookies: { platform_session: cookie },
    });
    expect(missing.statusCode).toBe(404);

    const prod = await app!.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "prod-1", zone: "正式区" },
    });
    expect(prod.statusCode).toBe(201);
    await app!.inject({
      method: "PUT",
      url: "/api/nodes/prod-1/pool",
      cookies: { platform_session: cookie },
      payload: { pool: "prod" },
    });

    const project = await app!.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: cookie },
      payload: { name: "请假审批" },
    });
    const code = project.json().project.code as string;
    const database = await openDatabase(databaseUrl);
    const found = await database.query<{ id: string }>("select id from projects where code = $1", [code]);
    await database.query(
      `insert into desired_states (project_id, image_digest, target_nodes, replicas)
       values ($1, $2, $3, $4) on conflict (project_id) do update set target_nodes = excluded.target_nodes`,
      [found.rows[0].id, "sha256:test", "prod-1,test-1", 1],
    );
    await database.close();

    const removed = await app!.inject({
      method: "DELETE",
      url: "/api/nodes/test-1",
      cookies: { platform_session: cookie },
    });
    expect(removed.statusCode).toBe(204);
    const remaining = await app!.inject({ method: "GET", url: "/api/nodes", cookies: { platform_session: cookie } });
    expect(remaining.json().nodes.map((item: { name: string }) => item.name)).toEqual(["prod-1"]);

    const after = await openDatabase(databaseUrl);
    const config = await after.readConfig();
    expect(config["test.nodePool"]).toBe("");
    expect(config["scheduler.defaultNodePool"]).toBe("prod-1");
    const desired = await after.query<{ target_nodes: string }>("select target_nodes from desired_states where project_id = $1", [found.rows[0].id]);
    expect(desired.rows[0].target_nodes).toBe("prod-1");
    await after.close();

    const again = await app!.inject({
      method: "DELETE",
      url: "/api/nodes/test-1",
      cookies: { platform_session: cookie },
    });
    expect(again.statusCode).toBe(404);

    const sys = await app!.inject({
      method: "POST",
      url: "/api/nodes",
      cookies: { platform_session: cookie },
      payload: { name: "sys-1", zone: "系统运行区" },
    });
    expect(sys.statusCode).toBe(201);
    const install = await app!.inject({ method: "GET", url: "/api/nodes/sys-1/install", cookies: { platform_session: cookie } });
    expect(install.statusCode).toBe(400);
    expect(install.json()).toEqual({ reason: "系统运行区节点不生成安装脚本" });
  });
});
