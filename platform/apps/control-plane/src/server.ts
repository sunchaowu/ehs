import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { createUser, disableUser, loginWithPassword, readSession, registerAccount } from "./accounts.js";
import { openDatabase } from "./database.js";
import { listSlots } from "./slots.js";

export async function buildServer(options?: { databaseUrl?: string }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(cookie);
  const databaseUrl = options?.databaseUrl ?? process.env.DATABASE_SYSTEM_URL;
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/slots", async () => ({ slots: listSlots() }));

  app.post("/api/session/login", async (request, reply) => {
    if (!databaseUrl) {
      return reply.code(503).send({ reason: "系统库未配置" });
    }
    const body = request.body as { username?: string; password?: string };
    const database = await openDatabase(databaseUrl);
    try {
      const result = await loginWithPassword(database, body.username ?? "", body.password ?? "");
      if ("reason" in result) {
        const status = result.reason === "账号已停用" ? 403 : 401;
        return reply.code(status).send({ reason: result.reason });
      }
      reply.setCookie("platform_session", result.sessionId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: request.protocol === "https",
      });
      return { user: result.user };
    } finally {
      await database.close();
    }
  });

  app.get("/api/session", async (request, reply) => {
    if (!databaseUrl) {
      return reply.code(503).send({ reason: "系统库未配置" });
    }
    const database = await openDatabase(databaseUrl);
    try {
      const user = await readSession(database, request.cookies.platform_session);
      if (!user) {
        return reply.code(401).send({ reason: "未登录" });
      }
      return { user };
    } finally {
      await database.close();
    }
  });

  app.post("/api/account/register", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const result = await registerAccount(database, request.body as { username?: string; displayName?: string; password?: string });
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      reply.setCookie("platform_session", result.sessionId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: request.protocol === "https",
      });
      return reply.code(201).send({ user: result.user });
    } finally {
      await database.close();
    }
  });

  app.post("/api/users", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(403).send({ reason: "需要平台管理员" });
      }
      const result = await createUser(database, request.body as { username?: string; displayName?: string; password?: string });
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send({ user: result.user });
    } finally {
      await database.close();
    }
  });

  app.post("/api/users/:username/disable", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(403).send({ reason: "需要平台管理员" });
      }
      const params = request.params as { username: string };
      await disableUser(database, params.username);
      return reply.code(204).send();
    } finally {
      await database.close();
    }
  });

  return app;
}

async function requireDatabase(databaseUrl: string | undefined, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (!databaseUrl) {
    reply.code(503).send({ reason: "系统库未配置" });
    return undefined;
  }
  return openDatabase(databaseUrl);
}
