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

  it("shows the real solution diff and confirms the draft", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const target = String(url);
        requests.push({ url: target, method: init?.method });
        if (target === "/api/projects") {
          return { ok: true, json: async () => ({ project: { name: "请假审批", code: "qing-jia-shen-pi" } }) };
        }
        if (target.endsWith("/change")) {
          return {
            ok: true,
            json: async () => ({
              change: {
                added: { menus: [{ code: "qing-jia-dan", name: "请假单", parent_code: null }], grants: [] },
                modified: [
                  {
                    kind: "grant",
                    principal_type: "role",
                    principal_name: "审批人",
                    menu_code: "qing-jia-dan",
                    added_actions: ["修改"],
                    removed_actions: ["访问"],
                  },
                ],
                removed: { menus: [{ code: "gong-gao", name: "公告", parent_code: null }], grants: [] },
              },
            }),
          };
        }
        if (target.endsWith("/confirm") && init?.method === "POST") {
          return { ok: true, json: async () => ({ sourceRevision: "sha256:abc" }) };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    fireEvent.click(await screen.findByTestId("platform/project/solution"));
    expect(await screen.findByTestId("platform/solution/page")).toHaveTextContent("方案确认");
    expect(await screen.findByTestId("platform/solution/added-menu")).toHaveTextContent("请假单（qing-jia-dan）");
    expect(screen.getByTestId("platform/solution/modified-item")).toHaveTextContent("新增动作 修改；移除动作 访问");
    expect(screen.getByTestId("platform/solution/removed-menu")).toHaveTextContent("公告（gong-gao）");
    expect(requests.some((item) => item.url.endsWith("/change") && item.method === undefined)).toBe(true);
    fireEvent.click(screen.getByTestId("platform/solution/confirm"));
    expect(await screen.findByText("方案已确认，源码版本 sha256:abc")).toBeInTheDocument();
    expect(requests.some((item) => item.url.endsWith("/confirm") && item.method === "POST")).toBe(true);
    fireEvent.click(screen.getByTestId("platform/solution/back"));
    expect(await screen.findByTestId("platform/project/draft")).toBeInTheDocument();
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
    expect(screen.getByTestId("platform/project/open-entry")).toHaveAttribute("href", "/p/stock");
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

  it("shows node job logs from the test results card", async () => {
    const admin = { username: "admin", displayName: "管理员", language: "zh-CN", platformAdmin: true, wechatBound: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const target = String(url);
        if (target.endsWith("/tests/runs/run-1/jobs")) {
          return {
            ok: true,
            json: async () => ({
              jobs: [
                {
                  id: "job-1",
                  runId: "run-1",
                  nodeName: "test-1",
                  status: "running",
                  attempt: 2,
                  log: "拉取镜像成功\n启动容器成功",
                  failure: "",
                  createdAt: "2026-11-12T08:00:00.000Z",
                  claimedAt: "2026-11-12T08:00:01.000Z",
                  finishedAt: null,
                },
              ],
            }),
          };
        }
        if (target.endsWith("/tests/runs/run-1")) {
          return { ok: true, json: async () => ({ steps: [] }) };
        }
        if (target.endsWith("/tests")) {
          return {
            ok: true,
            json: async () => ({
              candidateDigest: "sha256:abcdef0123456789",
              cases: [],
              runs: [
                {
                  id: "run-1",
                  imageDigest: "sha256:abcdef0123456789",
                  status: "running",
                  failure: "",
                  replayedFrom: null,
                  replayedFromDigest: null,
                  startedAt: "2026-11-12T08:00:00.000Z",
                  finishedAt: null,
                  failedCases: [],
                },
              ],
            }),
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
    fireEvent.click(await screen.findByTestId("platform/test-results/jobs-run-1"));
    expect(await screen.findByTestId("platform/test-results/job-panel")).toBeInTheDocument();
    expect(screen.getByTestId("platform/test-results/job-log-job-1")).toHaveTextContent("拉取镜像成功");
    expect(screen.getByTestId("platform/test-results/job-log-job-1")).toHaveTextContent("启动容器成功");
    expect(screen.getByTestId("platform/test-results/job-job-1")).toHaveTextContent("第 2 次领取");
    vi.unstubAllGlobals();
  });

  it("adds and removes user test cases from the project page", async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    let cases: Array<{ origin: string; method: string; code: string; name: string; steps: unknown[] }> = [
      { origin: "user", method: "white-box", code: "case-existing", name: "已有案例", steps: [] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const target = String(url);
        requests.push({ url: target, method: init?.method, body: init?.body });
        if (target.endsWith("/tests/cases") && !init?.method) {
          return { ok: true, json: async () => ({ cases }) };
        }
        if (target.endsWith("/tests/cases") && init?.method === "POST") {
          const payload = JSON.parse(init.body ?? "{}") as { name: string };
          cases = [...cases, { origin: "user", method: "white-box", code: "case-new", name: payload.name, steps: [] }];
          return { ok: true, json: async () => ({ testCase: { code: "case-new" } }) };
        }
        if (target.includes("/tests/cases/") && init?.method === "DELETE") {
          const code = decodeURIComponent(target.split("/tests/cases/")[1]);
          cases = cases.filter((item) => item.code !== code);
          return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({ project: { name: "请假审批", code: "qing-jia-shen-pi" } }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));

    expect(await screen.findByTestId("platform/user-cases/page")).toBeInTheDocument();
    expect(await screen.findByTestId("platform/user-cases/row-case-existing")).toHaveTextContent("已有案例");
    expect(screen.getByTestId("platform/user-cases/method-case-existing")).toHaveTextContent("白盒");

    fireEvent.change(screen.getByTestId("platform/user-cases/name"), { target: { value: "新增案例" } });
    fireEvent.change(screen.getByTestId("platform/user-cases/step-target-0"), { target: { value: "qing-jia-shen-pi/请假单.create" } });
    fireEvent.click(screen.getByTestId("platform/user-cases/add"));
    expect(await screen.findByTestId("platform/user-cases/row-case-new")).toHaveTextContent("新增案例");
    await vi.waitFor(() => {
      const call = requests.find((item) => item.url.endsWith("/tests/cases") && item.method === "POST");
      expect(call).toBeTruthy();
      const body = JSON.parse(call!.body ?? "{}") as { name: string; method: string; steps: Array<{ target: string }> };
      expect(body).toMatchObject({ name: "新增案例", method: "white-box" });
      expect(body.steps[0].target).toBe("qing-jia-shen-pi/请假单.create");
    });

    fireEvent.click(screen.getByTestId("platform/user-cases/remove-case-new"));
    await vi.waitFor(() => {
      expect(screen.queryByTestId("platform/user-cases/row-case-new")).toBeNull();
    });
    expect(requests.some((item) => item.url.includes("/tests/cases/case-new") && item.method === "DELETE")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("blocks publishing until the current candidate passes all tests", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    let passed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const target = String(url);
        requests.push({ url: target, method: init?.method });
        if (target.endsWith("/publish") && init?.method === "POST") {
          return { ok: true, json: async () => ({ published: true }) };
        }
        if (target.endsWith("/release")) {
          return {
            ok: true,
            json: async () => ({
              published: false,
              nodes: [],
              candidateDigest: "sha256:abc",
              testResult: { required: true, passed, failedCases: passed ? [] : ["新增请假单"] },
            }),
          };
        }
        return { ok: true, json: async () => ({ project: { name: "请假审批", code: "qing-jia-shen-pi" } }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    fireEvent.click(await screen.findByTestId("platform/project/release"));
    const publishButton = await screen.findByTestId("platform/project/publish");
    expect(publishButton).toBeDisabled();
    expect(await screen.findByTestId("platform/project/publish-blocked")).toHaveTextContent("新增请假单");
    fireEvent.click(publishButton);
    expect(requests.some((item) => item.url.endsWith("/publish") && item.method === "POST")).toBe(false);

    passed = true;
    fireEvent.click(screen.getByTestId("platform/project/release"));
    await vi.waitFor(() => {
      expect(publishButton).not.toBeDisabled();
    });
    fireEvent.click(publishButton);
    await vi.waitFor(() => {
      expect(requests.some((item) => item.url.endsWith("/publish") && item.method === "POST")).toBe(true);
      // 发布成功后会再次读取 release 刷新状态，等它完成后再还原 stub，避免 pending fetch 落到真实 fetch。
      expect(requests.filter((item) => item.url.endsWith("/release")).length).toBeGreaterThanOrEqual(3);
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

  it("lists users and lets an administrator create and toggle accounts", async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const target = String(url);
        requests.push({ url: target, method: init?.method, body: init?.body });
        if (target === "/api/users" && !init?.method) {
          return {
            ok: true,
            json: async () => ({
              users: [
                { username: "admin", displayName: "管理员", language: "zh-CN", platformAdmin: true, disabled: false, wechatBound: false },
                { username: "alice", displayName: "爱丽丝", language: "zh-CN", platformAdmin: false, disabled: true, wechatBound: false },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({ projects: [] }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    expect(screen.getByTestId("platform/shell/nav-users")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("platform/shell/nav-users"));
    expect(await screen.findByTestId("platform/users/page")).toHaveTextContent("共 2 名用户");
    expect(screen.getByTestId("platform/users/row-alice")).toHaveTextContent("爱丽丝（alice）");
    expect(screen.getByTestId("platform/users/state-alice")).toHaveTextContent("已停用");

    fireEvent.click(screen.getByTestId("platform/users/toggle-alice"));
    await vi.waitFor(() => {
      expect(requests.some((item) => item.url === "/api/users/alice/enable" && item.method === "POST")).toBe(true);
    });

    fireEvent.change(screen.getByTestId("platform/users/username"), { target: { value: "bob" } });
    fireEvent.change(screen.getByTestId("platform/users/display-name"), { target: { value: "鲍勃" } });
    fireEvent.change(screen.getByTestId("platform/users/password"), { target: { value: "secret-pass" } });
    fireEvent.click(screen.getByTestId("platform/users/create"));
    await vi.waitFor(() => {
      expect(
        requests.some(
          (item) =>
            item.url === "/api/users" &&
            item.method === "POST" &&
            item.body === '{"username":"bob","displayName":"鲍勃","password":"secret-pass"}',
        ),
      ).toBe(true);
    });
    expect(await screen.findByTestId("platform/users/feedback")).toHaveTextContent("bob 已创建");
    vi.unstubAllGlobals();
  });

  it("manages project members, roles and grants from the project page", async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const target = String(url);
        requests.push({ url: target, method: init?.method, body: init?.body });
        if (target === "/api/projects") {
          return { ok: true, json: async () => ({ project: { name: "请假审批", code: "qing-jia-shen-pi" } }) };
        }
        if (target.endsWith("/members") && !init?.method) {
          return {
            ok: true,
            json: async () => ({
              members: [
                { username: "admin", displayName: "管理员", projectAdmin: true },
                { username: "alice", displayName: "爱丽丝", projectAdmin: false },
              ],
            }),
          };
        }
        if (target.endsWith("/grants") && !init?.method) {
          return {
            ok: true,
            json: async () => ({
              access: {
                menus: [{ code: "qing-jia-dan", name: "请假单", parent_code: null }],
                roles: [{ name: "审批人", members: ["alice"] }],
                grants: [
                  { principal_type: "role", principal_name: "审批人", menu_code: "qing-jia-dan", action: "访问" },
                  { principal_type: "user", principal_name: "alice", menu_code: "qing-jia-dan", action: "访问" },
                ],
              },
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    expect(screen.getByTestId("platform/project/code-hint")).toHaveTextContent("^[a-z][a-z0-9-]{0,62}$");
    expect(screen.getByTestId("platform/project/code")).toHaveAttribute("placeholder", "例如 qing-jia-shen-pi");
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    fireEvent.click(await screen.findByTestId("platform/project/access"));
    expect(await screen.findByTestId("platform/access/page")).toHaveTextContent("授权管理");
    expect(screen.getByTestId("platform/access/member-row-alice")).toHaveTextContent("爱丽丝（alice）");
    expect(screen.getByTestId("platform/access/role-row-审批人")).toHaveTextContent("alice");
    expect(screen.getByTestId("platform/access/grant-row-user-alice-qing-jia-dan-访问")).toHaveTextContent("用户 alice");

    fireEvent.click(screen.getByTestId("platform/access/grant-remove-user-alice-qing-jia-dan-访问"));
    await vi.waitFor(() => {
      expect(
        requests.some((item) => item.url.endsWith("/grants") && item.method === "DELETE" && item.body?.includes('"principalName":"alice"')),
      ).toBe(true);
    });
    fireEvent.click(screen.getByTestId("platform/access/member-remove-alice"));
    await vi.waitFor(() => {
      expect(requests.some((item) => item.url.endsWith("/members/alice") && item.method === "DELETE")).toBe(true);
    });
    fireEvent.click(screen.getByTestId("platform/access/role-unassign-审批人-alice"));
    await vi.waitFor(() => {
      expect(
        requests.some((item) => item.url.endsWith("/roles/assign") && item.method === "DELETE" && item.body?.includes('"role":"审批人"')),
      ).toBe(true);
    });
    fireEvent.click(screen.getByTestId("platform/access/back"));
    expect(await screen.findByTestId("platform/project/draft")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("lists nodes and lets an administrator register, pool, rotate and remove nodes", async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const target = String(url);
        requests.push({ url: target, method: init?.method, body: init?.body });
        if (target === "/api/nodes" && !init?.method) {
          return {
            ok: true,
            json: async () => ({
              nodes: [
                { name: "prod-1", zone: "正式区", pool: "prod", reportedAt: "2026-11-20T06:00:00.000Z", projectCount: 2, gateway: "http://172.18.0.9:8081" },
                { name: "test-1", zone: "测试区", pool: "test", reportedAt: null, projectCount: 0, gateway: "" },
              ],
            }),
          };
        }
        if (target === "/api/nodes" && init?.method === "POST") {
          return { ok: true, json: async () => ({ node: { name: "test-2", zone: "测试区", pool: "" }, token: "new-token" }) };
        }
        if (target.endsWith("/rotate-token")) {
          return { ok: true, json: async () => ({ name: "test-1", token: "rotated-token" }) };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    expect(screen.getByTestId("platform/shell/nav-nodes")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("platform/shell/nav-nodes"));
    expect(await screen.findByTestId("platform/nodes/page")).toHaveTextContent("共 2 个节点");
    expect(screen.getByTestId("platform/nodes/pool-prod-1")).toHaveTextContent("正式池");
    expect(screen.getByTestId("platform/nodes/health-prod-1")).toHaveTextContent("2 个项目");
    expect(screen.getByTestId("platform/nodes/zone-test-1")).toHaveTextContent("测试区");
    expect(screen.getByTestId("platform/nodes/health-test-1")).toHaveTextContent("尚未上报心跳");
    expect(screen.getByTestId("platform/nodes/install-test-1")).toHaveAttribute("href", "/api/nodes/test-1/install");

    fireEvent.change(screen.getByTestId("platform/nodes/name"), { target: { value: "test-2" } });
    fireEvent.click(screen.getByTestId("platform/nodes/create"));
    expect(await screen.findByTestId("platform/nodes/token")).toHaveTextContent("new-token");
    await vi.waitFor(() => {
      expect(
        requests.some((item) => item.url === "/api/nodes" && item.method === "POST" && item.body === '{"name":"test-2","zone":"测试区"}'),
      ).toBe(true);
    });

    fireEvent.click(screen.getByTestId("platform/nodes/pool-test-test-1"));
    await vi.waitFor(() => {
      expect(requests.some((item) => item.url === "/api/nodes/test-1/pool" && item.method === "PUT" && item.body === '{"pool":""}')).toBe(true);
    });

    fireEvent.click(screen.getByTestId("platform/nodes/rotate-test-1"));
    expect(await screen.findByTestId("platform/nodes/token")).toHaveTextContent("rotated-token");

    fireEvent.click(screen.getByTestId("platform/nodes/remove-test-1"));
    await vi.waitFor(() => {
      expect(requests.some((item) => item.url === "/api/nodes/test-1" && item.method === "DELETE")).toBe(true);
    });
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
