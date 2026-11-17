import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
});

describe("portal login", () => {
  it("shows password login when WeChat is not configured", () => {
    render(<App session={null} wechatAvailable={false} />);
    expect(screen.getByTestId("platform/login/username")).toBeInTheDocument();
    expect(screen.getByTestId("platform/login/password")).toBeInTheDocument();
    expect(screen.getByTestId("platform/login/submit")).toBeInTheDocument();
    expect(screen.getByTestId("platform/login/wechat-unavailable")).toHaveTextContent("微信登录未配置");
    expect(screen.queryByTestId("platform/login/wechat-qr")).toBeNull();
    expect(screen.getByTestId("platform/login/card")).toHaveStyle({ width: "420px" });
  });

  it("shows the QR entry only after WeChat is configured", () => {
    render(<App session={null} wechatAvailable={true} />);
    expect(screen.getByTestId("platform/login/wechat-qr")).toBeInTheDocument();
    expect(screen.queryByTestId("platform/login/wechat-unavailable")).toBeNull();
  });

  it("keeps the login page and shows the returned reason", async () => {
    render(<App session={null} wechatAvailable={false} loginResult={{ reason: "用户名或密码错误" }} />);
    expect(await screen.findByText("用户名或密码错误")).toBeInTheDocument();
    expect(screen.getByTestId("platform/login/username")).toBeInTheDocument();
  });

  it("opens the workbench after a successful login", async () => {
    const user = { username: "admin", displayName: "管理员", language: "zh-CN", platformAdmin: true, wechatBound: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ user, title: "企业应用平台" }),
      })),
    );
    render(<App session={null} wechatAvailable={false} />);
    fireEvent.change(screen.getByTestId("platform/login/username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByTestId("platform/login/password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByTestId("platform/login/submit"));
    expect(await screen.findByTestId("platform/shell/user")).toHaveTextContent("管理员");
    vi.unstubAllGlobals();
  });

  it("explains that registration is closed", () => {
    render(<App session={null} wechatAvailable={false} registrationEnabled={false} page="register" />);
    expect(screen.getByText("请联系管理员")).toBeInTheDocument();
    expect(screen.queryByTestId("platform/register/submit")).toBeNull();
  });

  it("registers and opens the workbench", async () => {
    const user = { username: "newuser", displayName: "新用户", language: "zh-CN", platformAdmin: false, wechatBound: false };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/account/register") {
        return { ok: true, status: 201, json: async () => ({ user }) };
      }
      return { ok: true, json: async () => ({ title: "企业应用平台" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App session={null} wechatAvailable={false} />);
    fireEvent.click(screen.getByTestId("platform/login/register"));
    fireEvent.change(screen.getByTestId("platform/register/username"), { target: { value: "newuser" } });
    fireEvent.change(screen.getByTestId("platform/register/display-name"), { target: { value: "新用户" } });
    fireEvent.change(screen.getByTestId("platform/register/password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByTestId("platform/register/submit"));
    expect(await screen.findByTestId("platform/shell/user")).toHaveTextContent("新用户");
    expect(fetchMock).toHaveBeenCalledWith("/api/account/register", expect.anything());
    vi.unstubAllGlobals();
  });

  it("shows the server reason when registration is rejected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/account/register") {
        return { ok: false, status: 403, json: async () => ({ reason: "请联系管理员" }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App session={null} wechatAvailable={false} />);
    fireEvent.click(screen.getByTestId("platform/login/register"));
    fireEvent.change(screen.getByTestId("platform/register/username"), { target: { value: "newuser" } });
    fireEvent.change(screen.getByTestId("platform/register/display-name"), { target: { value: "新用户" } });
    fireEvent.change(screen.getByTestId("platform/register/password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByTestId("platform/register/submit"));
    expect(await screen.findByText("请联系管理员")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

const admin = { username: "admin", displayName: "管理员", language: "zh-CN", platformAdmin: true, wechatBound: false };
const employee = { username: "employee", displayName: "员工", language: "zh-CN", platformAdmin: false, wechatBound: false };

describe("portal shell", () => {
  it("shows the three settings links only to a platform administrator", () => {
    render(<App session={admin} title="企业应用平台" />);
    expect(screen.getByTestId("platform/shell/nav-system-config")).toHaveTextContent("系统配置");
    expect(screen.getByTestId("platform/shell/nav-plugin-config")).toHaveTextContent("插件配置");
    expect(screen.getByTestId("platform/shell/nav-model-config")).toHaveTextContent("模型配置");
    expect(screen.getByTestId("platform/shell/header")).toHaveStyle({ height: "56px" });
    expect(screen.getByTestId("platform/shell/user")).toHaveTextContent("管理员");
    expect(screen.getByTestId("platform/shell/language")).toHaveTextContent("zh-CN");
  });

  it("fills the viewport and scrolls inside the content area only", () => {
    render(<App session={admin} title="企业应用平台" />);
    expect(screen.getByTestId("platform/shell/root")).toHaveClass("platform-shell");
    expect(screen.getByTestId("platform/shell/content")).toHaveClass("platform-shell-content");
  });

  it("opens account actions and collapses the navigation to icons", async () => {
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/shell/account"));
    expect(await screen.findByTestId("platform/shell/account-settings")).toHaveTextContent("账号设置");
    expect(screen.getByTestId("platform/shell/menu-system-config")).toHaveTextContent("系统配置");
    expect(screen.getByTestId("platform/shell/logout")).toHaveTextContent("退出");
    fireEvent.click(screen.getByTestId("platform/shell/nav-collapse"));
    expect(screen.getByTestId("platform/shell/sider")).toHaveClass("ant-layout-sider-collapsed");
  });

  it("tells a user without menus to contact an administrator", () => {
    render(<App session={employee} title="企业应用平台" />);
    expect(screen.queryByTestId("platform/shell/nav-system-config")).toBeNull();
    expect(screen.queryByTestId("platform/shell/nav-plugin-config")).toBeNull();
    expect(screen.queryByTestId("platform/shell/nav-model-config")).toBeNull();
    expect(screen.getByTestId("platform/shell/content")).toHaveTextContent("联系管理员");
    expect(screen.queryByTestId("platform/project/new")).toBeNull();
  });

  it("opens a draft session after an administrator creates a project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ project: { name: "请假审批", code: "qing-jia-shen-pi" } }),
      })),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    expect(await screen.findByTestId("platform/project/draft")).toHaveTextContent("草稿");
    expect(screen.getByTestId("platform/project/session")).toHaveStyle({ width: "400px" });
    expect(screen.getByText("会话和运维智能体不会调用模型")).toBeInTheDocument();
    expect(screen.getByTestId("platform/project/message")).toBeDisabled();
    vi.unstubAllGlobals();
  });

  it("lists projects on the workbench and restores the last opened one after a refresh", async () => {
    localStorage.clear();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/projects") {
        return {
          ok: true,
          json: async () => ({ projects: [{ name: "请假审批", code: "qing-jia-shen-pi", containerGroup: "qing-jia-shen-pi", projectAdmin: true }] }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App session={admin} title="企业应用平台" />);
    expect(await screen.findByTestId("platform/project/list")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("platform/project/open"));
    expect(await screen.findByTestId("platform/project/draft")).toBeInTheDocument();
    // 模拟刷新页面：重新挂载后应自动恢复上次打开的项目
    cleanup();
    render(<App session={admin} title="企业应用平台" />);
    expect(await screen.findByTestId("platform/project/draft")).toBeInTheDocument();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows a node that has not reported healthy on the release check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/release")) {
          return { ok: true, json: async () => ({ published: false, nodes: [{ name: "prod-1", healthy: false, reason: "尚未报告" }] }) };
        }
        return { ok: true, json: async () => ({ project: { name: "请假审批", code: "qing-jia-shen-pi" } }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    fireEvent.click(await screen.findByTestId("platform/project/release"));
    expect(await screen.findByText("prod-1：尚未报告")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("shows the container group and design summary on the release check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/release")) {
          return {
            ok: true,
            json: async () => ({
              published: false,
              containerGroup: "leave",
              otherProjects: [{ code: "leave", name: "请假" }],
              designSummary: ["入库"],
              candidateDigest: "sha256:abc",
              testResult: { required: false },
              nodes: [],
            }),
          };
        }
        return { ok: true, json: async () => ({ project: { name: "库存", code: "stock" } }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "库存" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    fireEvent.click(await screen.findByTestId("platform/project/release"));
    const summary = await screen.findByTestId("platform/project/release-summary");
    expect(summary).toHaveTextContent("容器组 leave");
    expect(summary).toHaveTextContent("同组项目 请假");
    expect(summary).toHaveTextContent("设计 入库");
    expect(summary).toHaveTextContent("测试未设为发布门槛");
    vi.unstubAllGlobals();
  });

  it("shows test results and replays a record", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const target = String(url);
        requests.push({ url: target, method: init?.method });
        if (target.endsWith("/tests/runs/run-1/replay") && init?.method === "POST") {
          return { ok: true, json: async () => ({ runId: "run-2", status: "passed" }) };
        }
        if (target.endsWith("/tests/runs/run-1")) {
          return {
            ok: true,
            json: async () => ({
              run: { id: "run-1" },
              steps: [
                {
                  caseCode: "case-1",
                  caseName: "新增请假单",
                  stepIndex: 3,
                  method: "black-box",
                  startedAt: "2026-11-12T08:00:01.000Z",
                  expected: "保存成功",
                  actual: "保存失败",
                  passed: false,
                  reason: "提交后未看到成功提示",
                },
              ],
            }),
          };
        }
        if (target.endsWith("/tests")) {
          return {
            ok: true,
            json: async () => ({
              candidateDigest: "sha256:abcdef0123456789",
              cases: [{ origin: "auto", method: "black-box", code: "case-1", name: "新增请假单" }],
              runs: [
                {
                  id: "run-1",
                  imageDigest: "sha256:abcdef0123456789",
                  status: "failed",
                  failure: "",
                  replayedFrom: null,
                  replayedFromDigest: null,
                  startedAt: "2026-11-12T08:00:00.000Z",
                  finishedAt: null,
                  failedCases: ["新增请假单"],
                },
              ],
            }),
          };
        }
        if (target.endsWith("/release")) {
          return {
            ok: true,
            json: async () => ({ published: false, nodes: [], candidateDigest: "sha256:abcdef0123456789", testResult: { passed: false, failedCases: ["新增请假单"] } }),
          };
        }
        return { ok: true, json: async () => ({ project: { name: "请假审批", code: "leave" } }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    expect(await screen.findByTestId("platform/test-results/card")).toBeInTheDocument();
    expect(await screen.findByTestId("platform/test-results/case-case-1")).toHaveTextContent("新增请假单");
    expect(screen.getByTestId("platform/test-results/case-case-1")).toHaveTextContent("失败");
    expect(screen.getByTestId("platform/test-results/case-case-1")).toHaveTextContent("第 3 步");
    fireEvent.click(screen.getByTestId("platform/test-results/replay-run-1"));
    await vi.waitFor(() => {
      expect(requests.some((request) => request.url.endsWith("/tests/runs/run-1/replay") && request.method === "POST")).toBe(true);
    });
    vi.unstubAllGlobals();
  });

  it("renders system, plugin, model, and personal settings", () => {
    const config = {
      "platform.title": "企业应用平台",
      "platform.languages": ["zh-CN"],
      "registration.enabled": true,
      "wechat.appId": "",
      "wechat.redirectUri": "",
      "model.baseUrl": "",
      "model.name": "",
      "database.prodAdminUrl": "postgres://platform@127.0.0.1:5432/prod",
      "database.testAdminUrl": "postgres://platform@127.0.0.1:5432/test",
      "registry.address": "registry.internal",
      wechatSecretConfigured: false,
      modelKeyConfigured: false,
    };
    const { rerender } = render(<App session={admin} title="企业应用平台" section="system" config={config} />);
    expect(screen.getByTestId("platform/system-config/title")).toHaveValue("企业应用平台");
    expect(screen.getByTestId("platform/system-config/wechat-secret")).toHaveValue("");
    expect(screen.getByTestId("platform/system-config/wechat-secret-state")).toHaveTextContent("未配置");
    rerender(<App session={admin} title="企业应用平台" section="plugin" plugins={[]} />);
    expect(screen.getByTestId("platform/plugin-config/empty")).toHaveTextContent("暂无插件");
    rerender(<App session={admin} title="企业应用平台" section="model" config={config} />);
    expect(screen.getByTestId("platform/model-config/empty")).toHaveTextContent("会话和运维智能体不会调用模型");
    expect(screen.getByTestId("platform/model-config/api-key")).toHaveValue("");
    expect(screen.getByTestId("platform/model-config/api-key-state")).toHaveTextContent("未配置");
    rerender(<App session={admin} title="企业应用平台" section="account" />);
    expect(screen.getByTestId("platform/account/display-name")).toHaveValue("管理员");
    expect(screen.getByTestId("platform/account/wechat")).toHaveTextContent("未绑定");
  });

  it("shows plugin state, failure reason, and load toggles", async () => {
    const notice = {
      id: "portal-notice",
      title: "门户公告",
      description: "在门户显示平台公告",
      available: true,
      enabled: false,
      status: "disabled" as const,
      failure: "",
      config: {},
      configSchema: [{ key: "title", label: "公告标题", type: "string" as const, required: true }],
    };
    const broken = {
      id: "broken-plugin",
      title: "坏插件",
      description: "启动会失败",
      available: true,
      enabled: true,
      status: "failed" as const,
      failure: "请填写公告标题",
      config: {},
      configSchema: [],
    };
    const requests: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url: String(url), body: init?.body });
        if (String(url).endsWith("/state") && init?.method === "PUT") {
          return { ok: true, json: async () => ({ plugin: { ...notice, enabled: true, status: "active" } }) };
        }
        if (String(url).endsWith("/events")) {
          return {
            ok: true,
            json: async () => ({ events: [{ action: "enable", actor: "admin", result: "ok", detail: "", createdAt: "2026-11-12T04:00:00.000Z" }] }),
          };
        }
        return { ok: true, json: async () => ({ plugins: [notice, broken] }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" section="plugin" plugins={[notice, broken]} />);
    expect(screen.getByTestId("platform/plugin-config/portal-notice/status")).toHaveTextContent("已停用");
    expect(screen.getByTestId("platform/plugin-config/broken-plugin/status")).toHaveTextContent("启动失败");
    expect(screen.getByTestId("platform/plugin-config/broken-plugin/failure")).toHaveTextContent("请填写公告标题");
    fireEvent.click(screen.getByTestId("platform/plugin-config/portal-notice/switch"));
    expect(await screen.findByTestId("platform/plugin-config/portal-notice/status")).toHaveTextContent("运行中");
    expect(requests.some((request) => request.url === "/api/plugins/portal-notice/state" && request.body === '{"enabled":true}')).toBe(true);
    fireEvent.click(screen.getByTestId("platform/plugin-config/portal-notice/events-button"));
    expect(await screen.findByTestId("platform/plugin-config/portal-notice/event-0")).toHaveTextContent("enable");
    fireEvent.click(screen.getByTestId("platform/plugin-config/portal-notice/config-title"));
    fireEvent.change(screen.getByTestId("platform/plugin-config/portal-notice/config-title"), { target: { value: "停机维护" } });
    fireEvent.click(screen.getByTestId("platform/plugin-config/portal-notice/save"));
    await vi.waitFor(() => {
      expect(
        requests.some((request) => request.url === "/api/plugins/portal-notice/config" && request.body?.includes("停机维护")),
      ).toBe(true);
    });
    vi.unstubAllGlobals();
  });

  it("reports whether personal settings were saved", async () => {
    const requests: Array<{ body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        requests.push({ body: init?.body });
        return { ok: true, json: async () => ({ user: admin }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" section="account" />);
    fireEvent.change(screen.getByTestId("platform/account/password"), { target: { value: "  new-secret  " } });
    fireEvent.click(screen.getByTestId("platform/account/save"));
    expect(await screen.findByTestId("platform/account/feedback")).toHaveTextContent("已保存，下次登录请使用新密码");
    expect(requests.map((item) => item.body).find(Boolean)).toBe(JSON.stringify({ displayName: "管理员", language: "zh-CN", password: "new-secret" }));
    vi.unstubAllGlobals();
  });

  it("shows the server reason when personal settings are rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ reason: "请输入显示名和语言" }) })),
    );
    render(<App session={admin} title="企业应用平台" section="account" />);
    fireEvent.click(screen.getByTestId("platform/account/save"));
    expect(await screen.findByTestId("platform/account/feedback")).toHaveTextContent("请输入显示名和语言");
    vi.unstubAllGlobals();
  });
});
