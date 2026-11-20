import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createUser, disableUser, loginWithPassword, readSession, registerAccount } from "./accounts.js";
import { addMenu, applyOaTemplate, applyTool, assignRole, cancelPublication, confirmPublication, confirmSolution, createProjectImage, effectiveActions, grantAccess, listRequirementMessages, memberProject, managedProject, postRequirementMessage, projectRoles, publishedMenus, readDraft, readProjectSource, readReleaseStatus } from "./drafts.js";
import { openDatabase, type SystemDatabase } from "./database.js";
import { forwardBody, forwardHeaders } from "./entry-proxy.js";
import { dockerImageBuilder, type ImageBuildInput } from "./images.js";
import { opensslCertificateIssuer, type NodeCertificate } from "./node-install.js";
import { assignNodePool, poolsOverlap, prepareNodeInstall, registerNode } from "./nodes.js";
import { type TestExecutor } from "./test-executor.js";
import { createModelClient, type ModelClient } from "./llm.js";
import { readTestOverview, readTestRunSteps, replayTestRun, runProjectTests } from "./test-runs.js";
import { acceptTestJobReport, dispatchProjectTestRun, dispatchReplayTestRun } from "./node-tests.js";
import { createPluginRuntime } from "./plugin-runtime.js";
import { acceptHealthReport, readDesiredWork, readProjectEntry, type ReportedProject } from "./releases.js";
import { hashPassword } from "./passwords.js";
import { addProjectMember, canCreateProject, createProject, listProjects } from "./projects.js";
import { listNotifications, provisionPostgresDatabase, type DatabaseProvisioner } from "./publish.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { listSlots } from "./slots.js";
import { defaultSystemConfig, type SystemConfig } from "./system-config.js";
import { completeWechatLogin, createWechatClient, startWechatLogin, type WechatClient } from "./wechat.js";

export async function buildServer(options?: {
  databaseUrl?: string;
  /** 供测试注入：存在时入口路由复用该连接，不再按请求开连接。 */
  database?: SystemDatabase;
  wechatClient?: WechatClient;
  imageBuilder?: (input: ImageBuildInput) => Promise<{ digest: string } | { reason: string }>;
  databaseProvisioner?: DatabaseProvisioner;
  certificateIssuer?: (nodeName: string) => Promise<NodeCertificate | { reason: string }>;
  pluginRuntime?: PluginRuntime;
  testExecutor?: TestExecutor;
  modelClient?: ModelClient;
  entryFetch?: typeof fetch;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(cookie);
  // 项目页面表单默认提交 urlencoded，这里保留原始文本，转发时原样交给运行库解析。
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  const databaseUrl = options?.databaseUrl ?? process.env.DATABASE_SYSTEM_URL;
  const wechatClient = options?.wechatClient ?? createWechatClient();
  const imageBuilder = options?.imageBuilder ?? dockerImageBuilder();
  const databaseProvisioner = options?.databaseProvisioner ?? provisionPostgresDatabase;
  const certificateIssuer = options?.certificateIssuer ?? opensslCertificateIssuer;
  const pluginRuntime = options?.pluginRuntime ?? createPluginRuntime();
  const testExecutor = options?.testExecutor;
  const modelClient = options?.modelClient ?? createModelClient();
  const entryFetch = options?.entryFetch ?? fetch;
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/slots", async () => ({ slots: listSlots() }));
  if (databaseUrl) {
    try {
      const database = await openDatabase(databaseUrl);
      try {
        await pluginRuntime.activateInstalled(database);
      } finally {
        await database.close();
      }
    } catch {
      // 数据库尚未就绪时跳过启动恢复；插件行状态保持到下次重启。
    }
  }
  app.addHook("onClose", async () => {
    await pluginRuntime.disposeAll();
  });

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
      const config = await database.readConfig();
      reply.setCookie("platform_session", result.sessionId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: request.protocol === "https",
      });
      return {
        user: result.user,
        title: config["platform.title"],
        canCreateProject: await canCreateProject(database, result.user),
        modelConfigured: modelReady(config),
        languages: config["platform.languages"],
      };
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
      const config = await database.readConfig();
      return {
        user,
        title: config["platform.title"],
        canCreateProject: await canCreateProject(database, user),
        modelConfigured: modelReady(config),
        languages: config["platform.languages"],
      };
    } finally {
      await database.close();
    }
  });

  app.post("/api/session/logout", async (request, reply) => {
    if (!databaseUrl) {
      return reply.code(503).send({ reason: "系统库未配置" });
    }
    const database = await openDatabase(databaseUrl);
    try {
      const sessionId = request.cookies.platform_session;
      if (sessionId) {
        await database.query("delete from sessions where id = $1", [sessionId]);
      }
      reply.clearCookie("platform_session", { path: "/" });
      return { loggedOut: true };
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

  app.post("/api/session/wechat/start", async (_request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const result = await startWechatLogin(database);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.get("/api/session/wechat/callback", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const query = request.query as { code?: string; state?: string };
      const result = await completeWechatLogin(database, wechatClient, query.code, query.state);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
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

  app.get("/api/system-config", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(403).send({ reason: "需要平台管理员" });
      }
      return publicConfig(await database.readConfig());
    } finally {
      await database.close();
    }
  });

  app.put("/api/system-config", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(403).send({ reason: "需要平台管理员" });
      }
      const current = await database.readConfig();
      const next = applyConfigPatch(current, request.body);
      if (poolsOverlap(next["scheduler.defaultNodePool"], next["test.nodePool"])) {
        return reply.code(400).send({ reason: "同一节点不能同时属于正式节点池和测试节点池" });
      }
      await database.saveConfig(next);
      return publicConfig(next);
    } finally {
      await database.close();
    }
  });

  app.get("/api/plugins", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(403).send({ reason: "需要平台管理员" });
      }
      return { plugins: await pluginRuntime.listPlugins(database) };
    } finally {
      await database.close();
    }
  });

  app.put("/api/plugins/:id/state", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(403).send({ reason: "需要平台管理员" });
      }
      const body = request.body as { enabled?: boolean };
      if (typeof body.enabled !== "boolean") {
        return reply.code(400).send({ reason: "请提供启停状态" });
      }
      const outcome = await pluginRuntime.setState(database, (request.params as { id: string }).id, body.enabled, actor.username);
      if (!outcome.ok) {
        return reply.code(outcome.status).send({ reason: outcome.reason });
      }
      return { plugin: outcome.plugin };
    } finally {
      await database.close();
    }
  });

  app.put("/api/plugins/:id/config", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(403).send({ reason: "需要平台管理员" });
      }
      const body = request.body as { config?: unknown };
      const outcome = await pluginRuntime.saveConfig(database, (request.params as { id: string }).id, body.config, actor.username);
      if (!outcome.ok) {
        return reply.code(outcome.status).send({ reason: outcome.reason });
      }
      return { plugin: outcome.plugin };
    } finally {
      await database.close();
    }
  });

  app.get("/api/plugins/:id/events", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(403).send({ reason: "需要平台管理员" });
      }
      return { events: await pluginRuntime.listEvents(database, (request.params as { id: string }).id) };
    } finally {
      await database.close();
    }
  });

  app.put("/api/account", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const body = request.body as { displayName?: string; password?: string; language?: string };
      const displayName = body.displayName?.trim() ?? "";
      const language = body.language?.trim() ?? "";
      const password = body.password ?? "";
      if (!displayName || !language) {
        return reply.code(400).send({ reason: "请输入显示名和语言" });
      }
      if (password.trim() !== "") {
        const config = await database.readConfig();
        const passwordHash = await hashPassword(password, {
          memoryKiB: config["password.argon2.memoryKiB"],
          iterations: config["password.argon2.iterations"],
          parallelism: config["password.argon2.parallelism"],
        });
        // 先算好哈希再一次性写入，避免改密码失败时只改了显示名。
        await database.query(
          "update users set display_name = $1, language = $2, password_hash = $3 where username = $4",
          [displayName, language, passwordHash, actor.username],
        );
      } else {
        await database.query("update users set display_name = $1, language = $2 where username = $3", [
          displayName,
          language,
          actor.username,
        ]);
      }
      const user = await readSession(database, request.cookies.platform_session);
      return { user };
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await createProject(database, actor, request.body as { name?: string; code?: string; containerGroup?: string });
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.get("/api/projects", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      return { projects: await listProjects(database, actor) };
    } finally {
      await database.close();
    }
  });

  app.get("/api/menus", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      return { menus: await publishedMenus(database, actor) };
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/members", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await addProjectMember(database, actor, (request.params as { code: string }).code, request.body as { username?: string; projectAdmin?: boolean });
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/menus", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await addMenu(database, actor, (request.params as { code: string }).code, request.body as { name?: string; parent?: string });
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/apply-template", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const body = (request.body ?? {}) as { template?: string };
      if (body.template !== "oa") {
        return reply.code(400).send({ reason: "未知模板" });
      }
      const result = await applyOaTemplate(database, actor, (request.params as { code: string }).code);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.get("/api/projects/:code/draft", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await readDraft(database, actor, (request.params as { code: string }).code);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/grants", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await grantAccess(
        database,
        actor,
        (request.params as { code: string }).code,
        request.body as { principalType?: string; principalName?: string; menu?: string; actions?: string[] },
      );
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/roles/assign", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await assignRole(database, actor, (request.params as { code: string }).code, request.body as { role?: string; username?: string });
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.get("/api/projects/:code/access", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const query = request.query as { username?: string; menu?: string };
      const actions = await effectiveActions(database, (request.params as { code: string }).code, query.username ?? "", query.menu ?? "");
      return { actions };
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/confirm", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await confirmSolution(database, actor, (request.params as { code: string }).code);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.get("/api/projects/:code/source", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await readProjectSource(database, actor, (request.params as { code: string }).code);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/image", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await createProjectImage(database, actor, (request.params as { code: string }).code, imageBuilder);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/publish", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await confirmPublication(database, actor, (request.params as { code: string }).code, databaseProvisioner);
      if ("status" in result) {
        const body = "failedCases" in result ? { reason: result.reason, failedCases: result.failedCases } : { reason: result.reason };
        return reply.code(result.status).send(body);
      }
      return reply.code(202).send(result);
    } finally {
      await database.close();
    }
  });

  app.post("/api/nodes", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(actor ? 403 : 401).send({ reason: actor ? "需要平台管理员" : "未登录" });
      }
      const body = request.body as { name?: string; zone?: string };
      const result = await registerNode(database, body);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.put("/api/nodes/:name/pool", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(actor ? 403 : 401).send({ reason: actor ? "需要平台管理员" : "未登录" });
      }
      const result = await assignNodePool(database, (request.params as { name: string }).name, String((request.body as { pool?: string }).pool ?? ""));
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.get("/api/nodes/:name/desired", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const result = await readDesiredWork(database, (request.params as { name: string }).name, request.headers.authorization ?? "");
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.post("/api/nodes/:name/health", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const body = (request.body ?? {}) as { projects?: ReportedProject[]; gateway?: unknown };
      const projects = body.projects;
      const result = await acceptHealthReport(
        database,
        (request.params as { name: string }).name,
        request.headers.authorization ?? "",
        Array.isArray(projects) ? projects : [],
        typeof body.gateway === "string" ? body.gateway : "",
      );
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.post("/api/nodes/:name/tests/:jobId", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const body = (request.body ?? {}) as { outcomes?: unknown; reason?: unknown };
      const result = await acceptTestJobReport(
        database,
        (request.params as { name: string }).name,
        request.headers.authorization ?? "",
        (request.params as { jobId: string }).jobId,
        body,
      );
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.get("/api/projects/:code/release", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await readReleaseStatus(database, actor, (request.params as { code: string }).code);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.get("/api/nodes/:name/install", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor?.platformAdmin) {
        return reply.code(actor ? 403 : 401).send({ reason: actor ? "需要平台管理员" : "未登录" });
      }
      const host = request.hostname;
      const result = await prepareNodeInstall(
        database,
        (request.params as { name: string }).name,
        host ? `${request.protocol}://${host}` : "",
        certificateIssuer,
      );
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.type("text/plain").send(result.script);
    } finally {
      await database.close();
    }
  });

  app.get("/api/notifications", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      return await listNotifications(database, actor.username);
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/publish/cancel", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await cancelPublication(database, actor, (request.params as { code: string }).code);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/messages", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await postRequirementMessage(database, actor, (request.params as { code: string }).code, String((request.body as { body?: string }).body ?? ""), {
        model: modelClient,
        executor: testExecutor,
      });
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.get("/api/projects/:code/messages", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await listRequirementMessages(database, actor, (request.params as { code: string }).code);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  const projectEntry = async (request: FastifyRequest, reply: FastifyReply) => {
    const injected = options?.database;
    const database = injected ?? (databaseUrl ? await openDatabase(databaseUrl) : undefined);
    if (!database) {
      return reply.code(503).send({ reason: "系统库未配置" });
    }
    try {
      const url = new URL(request.url, "http://platform.local");
      const code = decodeURIComponent(url.pathname.split("/").filter(Boolean)[1] ?? "");
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        if (request.method === "GET" || request.method === "HEAD") {
          return reply.redirect("/");
        }
        return reply.code(401).send({ reason: "未登录" });
      }
      const project = await memberProject(database, actor, code);
      if ("reason" in project) {
        return reply.code(project.status).send({ reason: project.reason });
      }
      const entry = await readProjectEntry(database, code);
      if ("reason" in entry) {
        return reply.code(entry.status).send({ reason: entry.reason });
      }
      const headers = forwardHeaders(request.headers, actor.username, await projectRoles(database, code, actor.username));
      let upstream: Response;
      try {
        upstream = await entryFetch(`${entry.gateway}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: forwardBody(request.method, request.body),
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        // 节点网关失联、超时或容器端口失效时给出明确原因，不暴露内部栈。
        const reason = error instanceof Error && error.name === "TimeoutError" ? "项目入口响应超时" : "项目网关不可达";
        return reply.code(502).send({ reason });
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      reply.code(upstream.status);
      for (const name of ["content-type", "location", "cache-control"]) {
        const value = upstream.headers.get(name);
        if (value) {
          reply.header(name, value);
        }
      }
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length > 0) {
        reply.header("set-cookie", cookies);
      }
      return reply.send(buffer);
    } finally {
      if (!injected) {
        await database.close();
      }
    }
  };
  app.all("/p/:code", projectEntry);
  app.all("/p/*", projectEntry);

  app.get("/api/projects/:code/tests", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const projectCode = (request.params as { code: string }).code;
      const project = await memberProject(database, actor, projectCode);
      if ("reason" in project) {
        return reply.code(project.status).send({ reason: project.reason });
      }
      return await readTestOverview(database, project.id);
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/tests", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const projectCode = (request.params as { code: string }).code;
      const project = await managedProject(database, actor, projectCode);
      if ("reason" in project) {
        return reply.code(project.status).send({ reason: project.reason });
      }
      const target = { id: project.id, code: projectCode };
      if (!testExecutor) {
        const dispatched = await dispatchProjectTestRun(database, target);
        if ("reason" in dispatched) {
          return reply.code(dispatched.status).send({ reason: dispatched.reason });
        }
        return reply.code(202).send(dispatched);
      }
      const result = await runProjectTests(database, target, testExecutor);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.get("/api/projects/:code/tests/runs/:runId", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const projectCode = (request.params as { code: string }).code;
      const project = await memberProject(database, actor, projectCode);
      if ("reason" in project) {
        return reply.code(project.status).send({ reason: project.reason });
      }
      const result = await readTestRunSteps(database, project.id, (request.params as { runId: string }).runId);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return result;
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/tests/runs/:runId/replay", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const projectCode = (request.params as { code: string }).code;
      const project = await managedProject(database, actor, projectCode);
      if ("reason" in project) {
        return reply.code(project.status).send({ reason: project.reason });
      }
      const target = { id: project.id, code: projectCode };
      const runId = (request.params as { runId: string }).runId;
      if (!testExecutor) {
        const dispatched = await dispatchReplayTestRun(database, target, runId);
        if ("reason" in dispatched) {
          return reply.code(dispatched.status).send({ reason: dispatched.reason });
        }
        return reply.code(202).send(dispatched);
      }
      const result = await replayTestRun(database, target, runId, testExecutor);
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  app.post("/api/projects/:code/tools", async (request, reply) => {
    const database = await requireDatabase(databaseUrl, reply);
    if (!database) {
      return;
    }
    try {
      const actor = await readSession(database, request.cookies.platform_session);
      if (!actor) {
        return reply.code(401).send({ reason: "未登录" });
      }
      const result = await applyTool(
        database,
        actor,
        (request.params as { code: string }).code,
        request.body as { name?: string; arguments?: Record<string, unknown> },
        testExecutor,
      );
      if ("reason" in result) {
        return reply.code(result.status).send({ reason: result.reason });
      }
      return reply.code(201).send(result);
    } finally {
      await database.close();
    }
  });

  return app;
}

const secretKeys = new Set<keyof SystemConfig>(["wechat.appSecret", "model.apiKey"]);

function applyConfigPatch(current: SystemConfig, body: unknown): SystemConfig {
  const patch = body && typeof body === "object" ? (body as Partial<Record<keyof SystemConfig, unknown>>) : {};
  const sample = defaultSystemConfig({ title: "", systemUrl: "", prodAdminUrl: "", testAdminUrl: "", registryAddress: "" });
  const next = { ...current };
  for (const key of Object.keys(sample) as Array<keyof SystemConfig>) {
    if (!(key in patch)) {
      continue;
    }
    const value = patch[key];
    if (secretKeys.has(key) && value === "") {
      continue;
    }
    const currentValue = sample[key];
    if (typeof currentValue === "boolean" && typeof value === "boolean") {
      next[key] = value as never;
    } else if (typeof currentValue === "number" && typeof value === "number") {
      next[key] = value as never;
    } else if (Array.isArray(currentValue) && Array.isArray(value) && value.every((item) => typeof item === "string")) {
      next[key] = value as never;
    } else if (typeof currentValue === "string" && typeof value === "string") {
      next[key] = value as never;
    }
  }
  return next;
}

function publicConfig(config: SystemConfig) {
  return {
    ...config,
    "wechat.appSecret": "",
    "model.apiKey": "",
    wechatSecretConfigured: config["wechat.appSecret"] !== "",
    modelKeyConfigured: config["model.apiKey"] !== "",
  };
}

function modelReady(config: SystemConfig): boolean {
  return config["model.baseUrl"] !== "" && config["model.name"] !== "" && config["model.apiKey"] !== "";
}

async function requireDatabase(databaseUrl: string | undefined, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (!databaseUrl) {
    reply.code(503).send({ reason: "系统库未配置" });
    return undefined;
  }
  return openDatabase(databaseUrl);
}
