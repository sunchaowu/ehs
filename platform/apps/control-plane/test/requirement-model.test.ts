import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";
import type { ChatMessage, ModelClient } from "../src/llm.js";

const input = {
  title: "企业应用平台",
  prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
  testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
  registryAddress: "registry.internal",
};

describe("requirement session calls the model", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("runs the model tool calls against the draft and stores the reply", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.query("delete from projects");
    const initialConfig = await database.readConfig();
    await database.saveConfig({ ...initialConfig, "model.baseUrl": "", "model.name": "", "model.apiKey": "" });
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);

    const rounds: ChatMessage[][] = [];
    const modelClient: ModelClient = async ({ messages }) => {
      rounds.push(messages);
      if (rounds.length === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_menu",
                type: "function",
                function: { name: "add_menu", arguments: JSON.stringify({ name: "请假单" }) },
              },
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "已新增请假单菜单，请在草稿中核对。" } };
    };
    app = await buildServer({ databaseUrl, modelClient });

    const login = await app.inject({ method: "POST", url: "/api/session/login", payload: { username: "admin", password: installed.password } });
    const cookie = login.cookies.find((item) => item.name === "platform_session")!.value;
    const created = await app.inject({ method: "POST", url: "/api/projects", cookies: { platform_session: cookie }, payload: { name: "请假审批" } });
    const code = created.json().project.code as string;
    const configured = await openDatabase(databaseUrl!);
    const config = await configured.readConfig();
    await configured.saveConfig({ ...config, "model.baseUrl": "http://model.internal", "model.name": "local", "model.apiKey": "test-key" });
    await configured.close();

    const sent = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/messages`,
      cookies: { platform_session: cookie },
      payload: { body: "帮我加一个请假单菜单" },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().reply).toBe("已新增请假单菜单，请在草稿中核对。");
    // 第一轮带上系统提示词、工具定义与会话消息；第二轮带回工具结果
    expect(rounds.length).toBe(2);
    const system = rounds[0][0] as { role: string; content: string };
    expect(system.role).toBe("system");
    expect(system.content).toContain("需求分析师");
    expect(system.content).toContain(code);
    expect(rounds[0].some((message) => message.role === "user" && message.content === "帮我加一个请假单菜单")).toBe(true);
    expect(rounds[1].some((message) => message.role === "tool")).toBe(true);

    const draft = await app.inject({ method: "GET", url: `/api/projects/${code}/draft`, cookies: { platform_session: cookie } });
    expect(draft.json().menus).toEqual([{ code: "qing-jia-dan", name: "请假单" }]);

    const messages = await app.inject({ method: "GET", url: `/api/projects/${code}/messages`, cookies: { platform_session: cookie } });
    expect(messages.json().messages).toEqual([
      { role: "user", body: "帮我加一个请假单菜单" },
      { role: "assistant", body: "已新增请假单菜单，请在草稿中核对。" },
    ]);
  });

  it("reports the model failure without inventing a reply", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.query("delete from projects");
    const initialConfig = await database.readConfig();
    await database.saveConfig({ ...initialConfig, "model.baseUrl": "", "model.name": "", "model.apiKey": "" });
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, input);
    app = await buildServer({ databaseUrl, modelClient: async () => ({ reason: "模型调用失败（HTTP 502）：bad gateway" }) });

    const login = await app.inject({ method: "POST", url: "/api/session/login", payload: { username: "admin", password: installed.password } });
    const cookie = login.cookies.find((item) => item.name === "platform_session")!.value;
    const created = await app.inject({ method: "POST", url: "/api/projects", cookies: { platform_session: cookie }, payload: { name: "公告" } });
    const code = created.json().project.code as string;
    const configured = await openDatabase(databaseUrl!);
    const config = await configured.readConfig();
    await configured.saveConfig({ ...config, "model.baseUrl": "http://model.internal", "model.name": "local", "model.apiKey": "test-key" });
    await configured.close();

    const sent = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/messages`,
      cookies: { platform_session: cookie },
      payload: { body: "加一个公告菜单" },
    });
    expect(sent.statusCode).toBe(502);
    expect(sent.json().reason).toContain("模型调用失败");
    const messages = await app.inject({ method: "GET", url: `/api/projects/${code}/messages`, cookies: { platform_session: cookie } });
    expect(messages.json().messages).toEqual([{ role: "user", body: "加一个公告菜单" }]);
  });
});
