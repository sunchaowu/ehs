import type { SystemDatabase } from "../src/database.js";
import { describe, expect, it } from "vitest";
import { forwardBody, forwardHeaders } from "../src/entry-proxy.js";
import { buildServer } from "../src/server.js";

describe("project entry proxy", () => {
  it("drops hop-by-hop headers and client-supplied identity, then injects encoded identity", () => {
    const headers = forwardHeaders(
      {
        host: "platform.internal",
        connection: "keep-alive",
        "content-length": "12",
        "accept-encoding": "gzip",
        "content-type": "application/x-www-form-urlencoded",
        cookie: "platform_session=abc",
        "x-platform-user": "spoofed",
        "X-Platform-Roles": "admin",
      },
      "张三",
      ["部门负责人", "员工"],
    );
    expect(headers["host"]).toBeUndefined();
    expect(headers["connection"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["accept-encoding"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["cookie"]).toBe("platform_session=abc");
    expect(headers["x-platform-user"]).toBe(encodeURIComponent("张三"));
    expect(headers["x-platform-roles"]).toBe(
      `${encodeURIComponent("部门负责人")},${encodeURIComponent("员工")}`,
    );
  });

  it("keeps urlencoded form text and serializes parsed json bodies", () => {
    expect(forwardBody("POST", "name=%E5%BC%A0%E4%B8%89")).toBe("name=%E5%BC%A0%E4%B8%89");
    expect(forwardBody("POST", { name: "张三" })).toBe('{"name":"张三"}');
    expect(forwardBody("GET", { name: "张三" })).toBeUndefined();
    expect(forwardBody("POST", undefined)).toBeUndefined();
  });

  it("keeps the entry route closed when the system database is not configured", async () => {
    const saved = process.env.DATABASE_SYSTEM_URL;
    delete process.env.DATABASE_SYSTEM_URL;
    const app = await buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/p/demo" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ reason: "系统库未配置" });
    } finally {
      await app.close();
      if (saved !== undefined) {
        process.env.DATABASE_SYSTEM_URL = saved;
      }
    }
  });
});

type RouteState = {
  user?: string;
  member?: boolean;
  published?: string | null;
  targetNodes?: string;
  gateway?: string;
  runningDigest?: string;
  roles?: string[];
};

/** 只实现入口路由会走到的那几条查询，不依赖 PostgreSQL。 */
function fakeDatabase(state: RouteState): SystemDatabase {
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (text.includes("from sessions join users")) {
      if (!state.user || values[0] !== "session-1") {
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: "user-1",
            username: state.user,
            display_name: state.user,
            password_hash: "x",
            disabled: false,
            language: "zh-CN",
            wechat_open_id: null,
            platform_admin: false,
          },
        ],
      };
    }
    if (text.includes("join project_members")) {
      return { rows: state.member ? [{ id: "project-1" }] : [] };
    }
    if (text.includes("from published_versions")) {
      return { rows: state.published ? [{ image_digest: state.published }] : [] };
    }
    if (text.includes("from desired_states")) {
      return { rows: state.targetNodes ? [{ target_nodes: state.targetNodes }] : [] };
    }
    if (text.includes("from node_reports")) {
      const row =
        state.gateway && state.runningDigest
          ? [
              {
                node_name: "prod-1",
                gateway: state.gateway,
                projects: [{ code: "demo", running: true, databaseConnected: true, imageDigest: state.runningDigest }],
              },
            ]
          : [];
      return { rows: row };
    }
    if (text.includes("project_role_members.role_name")) {
      return { rows: (state.roles ?? []).map((name) => ({ role_name: name })) };
    }
    if (text.includes("select id from projects where code")) {
      return { rows: [{ id: "project-1" }] };
    }
    return { rows: [] };
  };
  return {
    query: query as never,
    migrate: async () => {},
    saveConfig: async () => {},
    saveConfigDefaults: async () => {},
    readConfig: async () => {
      throw new Error("入口路由不应读取系统配置");
    },
    close: async () => {},
  } as unknown as SystemDatabase;
}

/** 入口路由测试不读取 DATABASE_SYSTEM_URL，避免本机意外连上真实库。 */
async function startEntry(state: RouteState, entryFetch: typeof fetch) {
  const saved = process.env.DATABASE_SYSTEM_URL;
  delete process.env.DATABASE_SYSTEM_URL;
  const app = await buildServer({ database: fakeDatabase(state), entryFetch });
  return {
    app,
    async close() {
      await app.close();
      if (saved !== undefined) {
        process.env.DATABASE_SYSTEM_URL = saved;
      }
    },
  };
}

const neverFetch: typeof fetch = async () => {
  throw new Error("不应访问节点网关");
};

describe("project entry route", () => {
  it("redirects anonymous page requests to the portal and rejects anonymous writes", async () => {
    const started = await startEntry({}, neverFetch);
    try {
      const page = await started.app.inject({ method: "GET", url: "/p/demo" });
      expect(page.statusCode).toBe(302);
      expect(page.headers.location).toBe("/");
      const write = await started.app.inject({
        method: "POST",
        url: "/p/demo/form",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "name=x",
      });
      expect(write.statusCode).toBe(401);
      expect(write.json()).toEqual({ reason: "未登录" });
    } finally {
      await started.close();
    }
  });

  it("refuses non members and unpublished projects", async () => {
    const started = await startEntry({ user: "张三", member: false, published: "sha256:a" }, neverFetch);
    try {
      const denied = await started.app.inject({
        method: "GET",
        url: "/p/demo",
        cookies: { platform_session: "session-1" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ reason: "没有项目管理权限" });
    } finally {
      await started.close();
    }

    const unpublished = await startEntry(
      { user: "张三", member: true, published: null, targetNodes: "prod", gateway: "http://172.18.0.32:8081" },
      neverFetch,
    );
    try {
      const response = await unpublished.app.inject({
        method: "GET",
        url: "/p/demo",
        cookies: { platform_session: "session-1" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ reason: "项目还没有已发布版本" });
    } finally {
      await unpublished.close();
    }
  });

  it("does not route to a container whose running digest differs from the published one", async () => {
    const started = await startEntry(
      {
        user: "张三",
        member: true,
        published: "sha256:old",
        targetNodes: "prod",
        gateway: "http://172.18.0.32:8081",
        runningDigest: "sha256:candidate",
      },
      neverFetch,
    );
    try {
      const response = await started.app.inject({
        method: "GET",
        url: "/p/demo",
        cookies: { platform_session: "session-1" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ reason: "项目容器尚未在目标节点就绪" });
    } finally {
      await started.close();
    }
  });

  it("forwards pages and forms to the node gateway with the verified identity", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const entryFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response("<html>表单</html>", {
        status: 201,
        headers: { "content-type": "text/html; charset=utf-8", location: "/p/demo/form?created=1" },
      });
    };
    const started = await startEntry(
      {
        user: "张三",
        member: true,
        published: "sha256:published",
        targetNodes: "prod",
        gateway: "http://172.18.0.32:8081",
        runningDigest: "sha256:published",
        roles: ["部门负责人"],
      },
      entryFetch,
    );
    try {
      const page = await started.app.inject({
        method: "GET",
        url: "/p/demo/%E8%AF%B7%E5%81%87%E5%8D%95?tab=1",
        cookies: { platform_session: "session-1" },
        headers: { "x-platform-user": "spoofed", host: "evil.example", "accept-encoding": "gzip" },
      });
      expect(page.statusCode).toBe(201);
      expect(page.body).toBe("<html>表单</html>");
      expect(page.headers.location).toBe("/p/demo/form?created=1");
      expect(calls[0].url).toBe("http://172.18.0.32:8081/p/demo/%E8%AF%B7%E5%81%87%E5%8D%95?tab=1");
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["x-platform-user"]).toBe(encodeURIComponent("张三"));
      expect(headers["x-platform-roles"]).toBe(encodeURIComponent("部门负责人"));
      expect(headers["host"]).toBeUndefined();
      expect(headers["accept-encoding"]).toBeUndefined();

      const form = await started.app.inject({
        method: "POST",
        url: "/p/demo/%E8%AF%B7%E5%81%87%E5%8D%95",
        cookies: { platform_session: "session-1" },
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "title=%E7%94%B3%E8%AF%B7&days=3",
      });
      expect(form.statusCode).toBe(201);
      expect(calls[1].init.body).toBe("title=%E7%94%B3%E8%AF%B7&days=3");
      expect((calls[1].init.headers as Record<string, string>)["content-type"]).toBe(
        "application/x-www-form-urlencoded",
      );
    } finally {
      await started.close();
    }
  });

  it("answers 502 when the node gateway cannot be reached", async () => {
    const started = await startEntry(
      {
        user: "张三",
        member: true,
        published: "sha256:published",
        targetNodes: "prod",
        gateway: "http://172.18.0.32:8081",
        runningDigest: "sha256:published",
      },
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    try {
      const response = await started.app.inject({
        method: "GET",
        url: "/p/demo",
        cookies: { platform_session: "session-1" },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ reason: "项目网关不可达" });
    } finally {
      await started.close();
    }
  });
});
